// Coverage for the streaming-playlist write-side contract that failed
// silently on 2026-09-09 (a month of Spotify adds never pushed because the
// write-sync toggle lived in per-origin localStorage):
//   1. per-source sync settings persist in core (app_setting) across
//      service instances — the origin-independent store;
//   2. addTracksToPlaylist reports WHY a streaming push didn't happen
//      instead of returning a bare count;
//   3. getPlaylistUpstreamDrift finds the local-only rows (honouring a
//      track's alternate provider ids) — the replay set;
//   4. pushPlaylistLocalOnly stays behind the default-deny remote-write gate
//      when no policy is injected (tests never carry one — CLAUDE.md).
// Runs the REAL CoreService against a generated DB with a fake Spotify
// adapter injected through CoreServiceOptions.sourceAdapters.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getSourceCapabilities } from '@curator/shared';
import { migrate } from './db/migrate.js';
import { memberOrder } from './test-support/playlist-track.js';
import { createCoreService, type CoreService } from './service.js';
import type { StreamingSourceAdapter, RemoteTrackRef } from './sources/adapter.js';

let dir: string;
let dbPath: string;
let sqlite: Database.Database;
let svc: CoreService;
let remote: string[];
let fake: StreamingSourceAdapter & { addTracks: ReturnType<typeof vi.fn> };

function makeFake(): typeof fake {
	const ref = (id: string): RemoteTrackRef => ({ remoteId: id, title: id, artistNames: [], albumTitle: null, durationSec: null, isrc: null });
	return {
		source: 'spotify',
		displayName: 'Fake Spotify',
		capabilities: getSourceCapabilities('spotify'),
		listRemotePlaylists: async () => [],
		fetchPlaylistTracks: async () => remote.map(ref),
		createPlaylist: async () => { throw new Error('unused'); },
		deletePlaylist: async () => {},
		renamePlaylist: async () => {},
		addTracks: vi.fn(async () => ({ snapshotId: 'snap-1' })),
		removeTracks: async () => ({ snapshotId: null }),
		replaceTracks: async () => ({ snapshotId: null }),
	};
}

function seedTrack(id: string, spotifyIds: string[]): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES (?, ?, '[{"name":"Artist"}]', 'unsorted')`).run(id, `Title ${id}`);
	for (const sp of spotifyIds) {
		sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id) VALUES (?, ?, 'spotify', ?)`).run(`sl-${id}-${sp}`, id, sp);
	}
}
function seedPlaylist(id: string, opts: { ownerId?: string | null; collaborative?: boolean; sourceId?: string } = {}): void {
	sqlite.prepare(
		`INSERT INTO playlist (id, source, source_id, name, owner_id, is_collaborative) VALUES (?, 'spotify', ?, ?, ?, ?)`,
	).run(id, opts.sourceId ?? `remote-${id}`, `Playlist ${id}`, opts.ownerId ?? null, opts.collaborative ? 1 : 0);
}
function seedRow(playlistId: string, trackId: string, position: number, sourceTrackId: string): void {
	sqlite.prepare(
		`INSERT INTO playlist_track (id, order_key, playlist_id, track_id, position, source_track_id) VALUES (?, ?, ?, ?, ?, ?)`,
	).run(...memberOrder(position), playlistId, trackId, position, sourceTrackId);
}
function rows(playlistId: string): Array<{ track_id: string; position: number }> {
	return sqlite.prepare(`SELECT track_id, position FROM playlist_track WHERE playlist_id = ? ORDER BY position`).all(playlistId) as Array<{ track_id: string; position: number }>;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-upstream-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	sqlite = new Database(dbPath);
	remote = [];
	fake = makeFake();
	svc = createCoreService(dbPath, { peaksDir: join(dir, 'peaks'), sourceAdapters: { spotify: fake } });
});

afterEach(() => {
	sqlite.close();
	// Sibling DBs (agent.db, workspace) have no dispose hook; on Windows their
	// handles keep the temp dir busy — swallow the EBUSY, the OS reaps it.
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* handle still open */ }
});

describe('per-source sync settings persist in core', () => {
	it('defaults to write-sync OFF when nothing is stored', async () => {
		const all = await svc.getSourceSyncSettings();
		expect(all.spotify.writeSyncAuto).toBe(false);
		expect(all.spotify.readSyncAuto).toBe(true);
	});

	it('survives a new service instance on the same DB (the origin-independent store)', async () => {
		await svc.setSourceSyncSettings('spotify', { readSyncAuto: false, readIntervalMin: 15, writeSyncAuto: true });
		const again = createCoreService(dbPath, { peaksDir: join(dir, 'peaks'), sourceAdapters: { spotify: makeFake() } });
		const all = await again.getSourceSyncSettings();
		expect(all.spotify).toEqual({ readSyncAuto: false, readIntervalMin: 15, writeSyncAuto: true });
		expect(all.tidal.writeSyncAuto).toBe(false);
		// Only the sourceSync.* keys — app_setting also carries core's own
		// one-shot markers (the artist backfill version).
		const stored = (sqlite.prepare(`SELECT key, value FROM app_setting`).all() as Array<{ key: string; value: string }>)
			.filter((r) => r.key.startsWith('sourceSync.'));
		expect(stored.map((r) => r.key)).toEqual(['sourceSync.spotify']);
		expect(JSON.parse(stored[0]!.value).writeSyncAuto).toBe(true);
	});
});

describe('addTracksToPlaylist reports the upstream outcome', () => {
	it("'write-sync-off': rows land locally, nothing is sent, and the caller is told", async () => {
		seedPlaylist('p1', { collaborative: true });
		seedTrack('t1', ['sp1']);
		const res = await svc.addTracksToPlaylist('p1', ['t1']);
		expect(res).toEqual({ added: 1, skipped: 0, noUpstreamTrackIds: [], upstream: 'write-sync-off' });
		expect(rows('p1').map((r) => r.track_id)).toEqual(['t1']);
		expect(fake.addTracks).not.toHaveBeenCalled();
	});

	it("'not-owner' beats the toggle: an other-owned playlist is never pushed", async () => {
		await svc.setSourceSyncSettings('spotify', { readSyncAuto: false, readIntervalMin: 5, writeSyncAuto: true });
		seedPlaylist('p1', { ownerId: 'someone-else' });
		seedTrack('t1', ['sp1']);
		const res = await svc.addTracksToPlaylist('p1', ['t1']);
		expect(res.upstream).toBe('not-owner');
		expect(fake.addTracks).not.toHaveBeenCalled();
	});

	it("'failed' when the gate denies (no policy injected) — local rows still exist", async () => {
		await svc.setSourceSyncSettings('spotify', { readSyncAuto: false, readIntervalMin: 5, writeSyncAuto: true });
		seedPlaylist('p1', { collaborative: true });
		seedTrack('t1', ['sp1']);
		const res = await svc.addTracksToPlaylist('p1', ['t1']);
		expect(res.upstream).toBe('failed');
		expect(rows('p1')).toHaveLength(1);
		// Default-deny fires BEFORE the adapter — the fake must never see it.
		expect(fake.addTracks).not.toHaveBeenCalled();
	});

	it('names the tracks it refused (no provider id) and does not insert them', async () => {
		seedPlaylist('p1', { collaborative: true });
		seedTrack('t1', ['sp1']);
		seedTrack('t2', []);
		const res = await svc.addTracksToPlaylist('p1', ['t1', 't2']);
		expect(res.added).toBe(1);
		expect(res.noUpstreamTrackIds).toEqual(['t2']);
		expect(rows('p1').map((r) => r.track_id)).toEqual(['t1']);
	});

	it("'none' for a local playlist", async () => {
		sqlite.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES ('lp', 'local', 'lp', 'Local')`).run();
		seedTrack('t1', []);
		const res = await svc.addTracksToPlaylist('lp', ['t1']);
		expect(res.upstream).toBe('none');
		expect(res.added).toBe(1);
	});
});

describe('getPlaylistUpstreamDrift', () => {
	it('returns local rows the provider lacks, treating any linked provider id as present', async () => {
		seedPlaylist('p1', { collaborative: true });
		seedTrack('t1', ['sp1']);
		seedTrack('t2', ['sp2']);
		// Two Spotify ids for one track: the row carries sp3a, the provider
		// has sp3b — must NOT be reported (it would be re-added as a dupe).
		seedTrack('t3', ['sp3a', 'sp3b']);
		seedTrack('t4', ['sp4']);
		seedRow('p1', 't1', 0, 'sp1');
		seedRow('p1', 't2', 1, 'sp2');
		seedRow('p1', 't3', 2, 'sp3a');
		seedRow('p1', 't4', 3, 'sp4');
		remote = ['sp1', 'sp3b', 'sp9'];
		const d = await svc.getPlaylistUpstreamDrift('p1');
		expect(d.canModify).toBe(true);
		expect(d.localCount).toBe(4);
		expect(d.remoteCount).toBe(3);
		expect(d.remoteOnlyCount).toBe(1);
		expect(d.localOnly.map((r) => [r.trackId, r.sourceTrackId, r.position])).toEqual([
			['t2', 'sp2', 1],
			['t4', 'sp4', 3],
		]);
		expect(d.localOnly[0]!.title).toBe('Title t2');
		expect(d.localOnly[0]!.artists).toBe('Artist');
	});

	it('falls back to a linked provider id for rows stamped with the Curator uuid, and skips rows with none', async () => {
		seedPlaylist('p1', { collaborative: true });
		seedTrack('t1', ['sp1']);
		seedTrack('t2', []);
		seedRow('p1', 't1', 0, 't1');
		seedRow('p1', 't2', 1, 't2');
		const d = await svc.getPlaylistUpstreamDrift('p1');
		expect(d.localOnly.map((r) => [r.trackId, r.sourceTrackId])).toEqual([['t1', 'sp1']]);
	});

	it('reports canModify=false for other-owned playlists', async () => {
		seedPlaylist('p1', { ownerId: 'someone-else' });
		const d = await svc.getPlaylistUpstreamDrift('p1');
		expect(d.canModify).toBe(false);
	});

	it('rejects local playlists and Liked Songs', async () => {
		sqlite.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES ('lp', 'local', 'lp', 'Local')`).run();
		seedPlaylist('liked', { sourceId: 'liked-songs', ownerId: 'me' });
		await expect(svc.getPlaylistUpstreamDrift('lp')).rejects.toThrow(/streaming/);
		await expect(svc.getPlaylistUpstreamDrift('liked')).rejects.toThrow(/Liked Songs/);
	});
});

describe('pushPlaylistLocalOnly', () => {
	it('is default-deny without a remote-write policy — the fake adapter never runs', async () => {
		seedPlaylist('p1', { collaborative: true });
		seedTrack('t1', ['sp1']);
		seedRow('p1', 't1', 0, 'sp1');
		await expect(svc.pushPlaylistLocalOnly('p1')).rejects.toThrow(/Remote write denied/);
		expect(fake.addTracks).not.toHaveBeenCalled();
	});

	it('refuses other-owned playlists before reaching the gate', async () => {
		seedPlaylist('p1', { ownerId: 'someone-else' });
		seedTrack('t1', ['sp1']);
		seedRow('p1', 't1', 0, 'sp1');
		await expect(svc.pushPlaylistLocalOnly('p1')).rejects.toThrow(/owner/);
	});

	it('is a no-op when nothing is local-only', async () => {
		seedPlaylist('p1', { collaborative: true });
		seedTrack('t1', ['sp1']);
		seedRow('p1', 't1', 0, 'sp1');
		remote = ['sp1'];
		await expect(svc.pushPlaylistLocalOnly('p1')).resolves.toEqual({ pushed: 0, snapshotId: null });
	});
});
