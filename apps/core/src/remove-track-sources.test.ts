// Coverage for the Delete dialog's per-source removal (removeTrackSources)
// and the deleteTracks refactor onto the same body. The rule under test:
// a track is tombstoned only when every removable source it has
// (local / spotify / tidal / rekordbox) was requested; otherwise only the
// requested sources are stripped and the row survives.
// Runs the REAL CoreService against a generated DB with a fake Spotify
// adapter. No remote-write policy is injected (tests never carry one —
// CLAUDE.md), so any upstream push hits the default-deny gate; that's
// asserted, not avoided.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getSourceCapabilities } from '@curator/shared';
import { migrate } from './db/migrate.js';
import { memberOrder } from './test-support/playlist-track.js';
import { createCoreService, type CoreService } from './service.js';
import type { StreamingSourceAdapter } from './sources/adapter.js';

let dir: string;
let peaksDir: string;
let sqlite: Database.Database;
let svc: CoreService;
let trashFile: ReturnType<typeof vi.fn>;

function fakeSpotify(): StreamingSourceAdapter {
	return {
		source: 'spotify',
		displayName: 'Fake Spotify',
		capabilities: getSourceCapabilities('spotify'),
		listRemotePlaylists: async () => [],
		fetchPlaylistTracks: async () => [],
		createPlaylist: async () => { throw new Error('unused'); },
		deletePlaylist: async () => {},
		renamePlaylist: async () => {},
		addTracks: async () => ({ snapshotId: null }),
		removeTracks: async () => ({ snapshotId: null }),
		replaceTracks: async () => ({ snapshotId: null }),
	};
}

function seedTrack(id: string): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES (?, ?, '[{"name":"Artist"}]', 'unsorted')`).run(id, `Title ${id}`);
}
function seedLink(trackId: string, source: string, sourceTrackId: string, filePath: string | null = null): void {
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path) VALUES (?, ?, ?, ?, ?)`)
		.run(`sl-${trackId}-${source}-${sourceTrackId}`, trackId, source, sourceTrackId, filePath);
}
function seedRb(trackId: string, rbContentId: string): void {
	sqlite.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at) VALUES (?, ?, 1, 0)`).run(trackId, rbContentId);
}
function seedPlaylist(id: string, source: string, ownerId: string | null = null): void {
	sqlite.prepare(`INSERT INTO playlist (id, source, source_id, name, owner_id) VALUES (?, ?, ?, ?, ?)`)
		.run(id, source, `remote-${id}`, `Playlist ${id}`, ownerId);
}
function seedRow(playlistId: string, trackId: string, position: number, sourceTrackId: string): void {
	sqlite.prepare(`INSERT INTO playlist_track (id, order_key, playlist_id, track_id, position, source_track_id) VALUES (?, ?, ?, ?, ?, ?)`)
		.run(...memberOrder(position), playlistId, trackId, position, sourceTrackId);
}
function seedPeaks(name: string): void {
	for (const tier of ['lo', 'hi']) writeFileSync(join(peaksDir, tier, `${name}.cpk`), 'x');
}
const links = (trackId: string): string[] =>
	(sqlite.prepare(`SELECT source FROM source_link WHERE track_id = ? ORDER BY source`).all(trackId) as Array<{ source: string }>).map((r) => r.source);
const members = (playlistId: string): string[] =>
	(sqlite.prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = ? ORDER BY position`).all(playlistId) as Array<{ track_id: string }>).map((r) => r.track_id);
const deletedAt = (trackId: string): number | null =>
	(sqlite.prepare(`SELECT deleted_at FROM track WHERE id = ?`).get(trackId) as { deleted_at: number | null } | undefined)?.deleted_at ?? null;
const hasRbLink = (trackId: string): boolean => !!sqlite.prepare(`SELECT 1 FROM rekordbox_link WHERE track_id = ?`).get(trackId);
const rbTombstones = (): string[] =>
	(sqlite.prepare(`SELECT rb_content_id FROM rekordbox_deleted_content ORDER BY rb_content_id`).all() as Array<{ rb_content_id: string }>).map((r) => r.rb_content_id);
const peaks = (name: string): boolean => existsSync(join(peaksDir, 'lo', `${name}.cpk`));

// A track that has every removable source: a local file, a Spotify link and
// a rekordbox link; member of an owned Spotify playlist, a followed one,
// and a rekordbox playlist; with analyzer and rekordbox peaks on disk.
function seedFull(id: string, rbId: string): void {
	seedTrack(id);
	seedLink(id, 'local', `c:/music/${id}.flac`, `c:/music/${id}.flac`);
	seedLink(id, 'spotify', `sp-${id}`);
	seedLink(id, 'beatport', `bp-${id}`);
	seedRb(id, rbId);
	seedRow('owned', id, 0, `sp-${id}`);
	seedRow('followed', id, 0, `sp-${id}`);
	seedRow('rb_1', id, 0, rbId);
	seedPeaks(id);
	seedPeaks(`rb_${rbId}`);
}

function makeService(dbPath: string): CoreService {
	return createCoreService(dbPath, { peaksDir, sourceAdapters: { spotify: fakeSpotify() }, trashFile: trashFile as unknown as (p: string) => Promise<void> });
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-remove-sources-'));
	const dbPath = join(dir, 'curator.db');
	peaksDir = join(dir, 'peaks');
	mkdirSync(join(peaksDir, 'lo'), { recursive: true });
	mkdirSync(join(peaksDir, 'hi'), { recursive: true });
	migrate(dbPath);
	sqlite = new Database(dbPath);
	trashFile = vi.fn(async () => {});
	seedPlaylist('owned', 'spotify', null);          // ownerId unknown → treated as modifiable
	seedPlaylist('followed', 'spotify', 'someone-else');
	seedPlaylist('rb_1', 'rekordbox');
	svc = makeService(dbPath);
});

afterEach(() => {
	sqlite.close();
	// Sibling DBs (agent.db, workspace) have no dispose hook; on Windows their
	// handles keep the temp dir busy — swallow the EBUSY, the OS reaps it.
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* handle still open */ }
});

describe('removeTrackSources', () => {
	it('local only: trashes the file and drops the local link; the row and everything else survive', async () => {
		seedFull('t1', '101');
		const r = await svc.removeTrackSources(['t1'], ['local']);
		expect(trashFile).toHaveBeenCalledWith('c:/music/t1.flac');
		expect(r.filesTrashed).toBe(1);
		expect(r.tombstonedTrackIds).toEqual([]);
		expect(deletedAt('t1')).toBeNull();
		expect(links('t1')).toEqual(['beatport', 'spotify']);
		expect(hasRbLink('t1')).toBe(true);
		expect(members('owned')).toEqual(['t1']);
		expect(members('rb_1')).toEqual(['t1']);
		expect(peaks('t1')).toBe(true);
		expect(r.updated.map((t) => t.id)).toEqual(['t1']);
		expect(r.updated[0]!.sources).not.toContain('local');
	});

	it('spotify only: leaves owned playlists (upstream push hits the default-deny gate), keeps followed, drops the link', async () => {
		seedFull('t1', '101');
		const r = await svc.removeTrackSources(['t1'], ['spotify']);
		expect(members('owned')).toEqual([]);
		expect(members('followed')).toEqual(['t1']);
		expect(r.followedKept).toBe(1);
		expect(links('t1')).toEqual(['beatport', 'local']);
		expect(deletedAt('t1')).toBeNull();
		expect(trashFile).not.toHaveBeenCalled();
		// No remote-write policy in tests: the forced push is denied and
		// reported — the local removal above still happened.
		expect(r.errors.some((e) => e.kind === 'playlist' && e.source === 'spotify')).toBe(true);
	});

	it('rekordbox only: tombstones rb content, leaves rb playlists, drops the link and rb peaks; analyzer peaks stay', async () => {
		seedFull('t1', '101');
		const r = await svc.removeTrackSources(['t1'], ['rekordbox']);
		expect(rbTombstones()).toEqual(['101']);
		expect(r.rekordboxTombstoned).toBe(1);
		expect(hasRbLink('t1')).toBe(false);
		expect(members('rb_1')).toEqual([]);
		expect(members('owned')).toEqual(['t1']);
		expect(peaks('rb_101')).toBe(false);
		expect(peaks('t1')).toBe(true);
		expect(deletedAt('t1')).toBeNull();
		expect(r.updated[0]!.sources).not.toContain('rekordbox');
	});

	it('every source checked: tombstoned exactly like the old soft delete', async () => {
		seedFull('t1', '101');
		const r = await svc.removeTrackSources(['t1'], ['local', 'spotify', 'rekordbox']);
		expect(r.tombstonedTrackIds).toEqual(['t1']);
		expect(deletedAt('t1')).not.toBeNull();
		// Tombstoned rows keep streaming + metadata links (deleted chip identity).
		expect(links('t1')).toEqual(['beatport', 'spotify']);
		expect(members('followed')).toEqual(['t1']);
		expect(members('owned')).toEqual([]);
		expect(members('rb_1')).toEqual([]);
		expect(rbTombstones()).toEqual(['101']);
		expect(peaks('t1')).toBe(false);
		expect(peaks('rb_101')).toBe(false);
		expect(r.updated).toEqual([]);
	});

	it('metadata links are not sources: beatport + spotify with spotify checked tombstones the row', async () => {
		seedTrack('t2');
		seedLink('t2', 'spotify', 'sp-t2');
		seedLink('t2', 'beatport', 'bp-t2');
		const r = await svc.removeTrackSources(['t2'], ['spotify']);
		expect(r.tombstonedTrackIds).toEqual(['t2']);
		expect(links('t2')).toEqual(['beatport', 'spotify']);
	});

	it('is idempotent: a second identical call changes nothing', async () => {
		seedFull('t1', '101');
		await svc.removeTrackSources(['t1'], ['local', 'rekordbox']);
		trashFile.mockClear();
		const r = await svc.removeTrackSources(['t1'], ['local', 'rekordbox']);
		expect(trashFile).not.toHaveBeenCalled();
		expect(r.filesTrashed + r.peaksRemoved + r.rekordboxTombstoned).toBe(0);
		expect(r.linksDropped).toEqual({ local: 0, spotify: 0, tidal: 0, rekordbox: 0 });
		expect(r.errors).toEqual([]);
	});

	it('rejects an empty source list', async () => {
		seedFull('t1', '101');
		await expect(svc.removeTrackSources(['t1'], [])).rejects.toThrow('No sources selected');
	});
});

describe('deleteTracks delegates to the same body', () => {
	it('soft: same end state as removeTrackSources(all), original result shape', async () => {
		seedFull('t1', '101');
		const r = await svc.deleteTracks(['t1']);
		expect(r.deletedTracks).toBe(1);
		expect(r.filesTrashed).toBe(1);
		expect(r.peaksRemoved).toBe(4);
		expect(deletedAt('t1')).not.toBeNull();
		expect(links('t1')).toEqual(['beatport', 'spotify']);
		expect(hasRbLink('t1')).toBe(false);
		expect(rbTombstones()).toEqual(['101']);
		expect(members('followed')).toEqual(['t1']);
	});

	it('hard: DELETEs the row (feed un-promotion path)', async () => {
		seedFull('t1', '101');
		const r = await svc.deleteTracks(['t1'], { hard: true });
		expect(r.deletedTracks).toBe(1);
		expect(sqlite.prepare(`SELECT 1 FROM track WHERE id = 't1'`).get()).toBeUndefined();
		expect(rbTombstones()).toEqual(['101']);
	});
});
