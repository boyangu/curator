// A soft-deleted track doesn't exist anywhere a user counts or browses —
// except a followed streaming playlist (the delete can't take it out; the
// renderer paints a "deleted" chip) and Settings → Deleted Tracks, which
// lists tombstones to restore or delete permanently. "Delete permanently"
// strips tags and cues but keeps the row: its links are what stop a re-sync
// bringing the track back.
// Real CoreService over a generated DB; no remote-write policy (CLAUDE.md).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate.js';
import { memberOrder } from './test-support/playlist-track.js';
import { createCoreService, type CoreService } from './service.js';
import { tmpDir, type TmpDir } from './test-support/tmp.js';

let tmp: TmpDir;
let dir: string;
let sqlite: Database.Database;
let svc: CoreService;

function seedTrack(id: string, opts: { deleted?: boolean; derivedFrom?: string } = {}): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state, deleted_at, derived_from_track_id) VALUES (?, ?, '[{"name":"Artist"}]', 'unsorted', ?, ?)`)
		.run(id, `Title ${id}`, opts.deleted ? Date.now() : null, opts.derivedFrom ?? null);
}
function seedLink(trackId: string, source: string, sourceTrackId: string): void {
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id) VALUES (?, ?, ?, ?)`)
		.run(`sl-${trackId}-${source}`, trackId, source, sourceTrackId);
}
function seedPlaylist(id: string, source: string, ownerId: string | null): void {
	sqlite.prepare(`INSERT INTO playlist (id, source, source_id, name, owner_id) VALUES (?, ?, ?, ?, ?)`)
		.run(id, source, `remote-${id}`, `Playlist ${id}`, ownerId);
}
function seedRow(playlistId: string, trackId: string, position: number): void {
	sqlite.prepare(`INSERT INTO playlist_track (id, order_key, playlist_id, track_id, position, source_track_id) VALUES (?, ?, ?, ?, ?, ?)`)
		.run(...memberOrder(position), playlistId, trackId, position, `sp-${trackId}`);
}
function seedTag(trackId: string, tagId: string): void {
	sqlite.prepare(`INSERT INTO track_tag (track_id, tag_id) VALUES (?, ?)`).run(trackId, tagId);
}
function seedCue(trackId: string, slot: number): void {
	sqlite.prepare(`INSERT INTO cue (id, track_id, slot, position_sec, kind) VALUES (?, ?, ?, 1.5, 'hot')`).run(`cue-${trackId}-${slot}`, trackId, slot);
}
const count = (sql: string, ...args: unknown[]): number => (sqlite.prepare(sql).get(...args) as { n: number }).n;
const purgedAt = (id: string): number | null => (sqlite.prepare(`SELECT purged_at FROM track WHERE id = ?`).get(id) as { purged_at: number | null }).purged_at;

beforeEach(() => {
	tmp = tmpDir('curator-deleted-tracks-');
	dir = tmp.path;
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	sqlite = tmp.track(new Database(dbPath));
	seedPlaylist('own', 'spotify', null);             // ownerId unknown → modifiable
	seedPlaylist('followed', 'spotify', 'someone-else');
	seedPlaylist('local', 'local', null);
	// live: a track with a tag + Spotify link in both playlists.
	seedTrack('live');
	seedLink('live', 'spotify', 'sp-live');
	seedTag('live', 'interested');
	seedRow('own', 'live', 0);
	seedRow('followed', 'live', 0);
	// gone: deleted, but still tagged, linked, and in both playlists (a
	// missing-file cleanup leaves own-playlist rows; followed always keeps).
	seedTrack('gone', { deleted: true });
	seedLink('gone', 'spotify', 'sp-gone');
	seedTag('gone', 'interested');
	seedTag('gone', 'basket');
	seedCue('gone', 0);
	seedCue('gone', 1);
	seedRow('own', 'gone', 1);
	seedRow('followed', 'gone', 1);
	seedRow('local', 'gone', 0);
	// a deleted Convert-to-WAV copy.
	seedTrack('wav', { deleted: true, derivedFrom: 'live' });
	svc = tmp.track(createCoreService(dbPath));
});

afterEach(async () => {
	await tmp.cleanup();
});

describe('deleted tracks are not counted or listed', () => {
	it('tag, state and source counts skip deleted rows', async () => {
		expect((await svc.getTagCounts())['interested']).toBe(1);
		expect((await svc.getTagCounts())['basket']).toBeUndefined();
		expect((await svc.getStateCounts()).unsorted).toBe(1);
		expect((await svc.getSourceCounts()).spotify).toBe(1);
	});

	it('library and own-playlist reads hide them; a followed playlist keeps them', async () => {
		const ids = async (filter: Parameters<CoreService['getTracks']>[0]) => (await svc.getTracks(filter)).map((t) => t.id).sort();
		expect(await ids({})).toEqual(['live']);
		expect(await ids({ tagId: 'interested' })).toEqual(['live']);
		expect(await ids({ playlistId: 'own' })).toEqual(['live']);
		expect(await ids({ playlistId: 'local' })).toEqual([]);
		expect(await ids({ playlistId: 'followed' })).toEqual(['gone', 'live']);
		expect((await svc.getTracksPage({ playlistId: 'own' })).total).toBe(1);
	});
});

describe('Settings → Deleted Tracks', () => {
	it('lists every unpurged tombstone with its cause and what it still holds', async () => {
		const rows = await svc.listDeletedTracks();
		expect(rows.map((r) => r.trackId).sort()).toEqual(['gone', 'wav']);
		const gone = rows.find((r) => r.trackId === 'gone')!;
		expect(gone).toMatchObject({ title: 'Title gone', artist: 'Artist', cause: 'deleted', sources: ['spotify'], tags: 2, playlists: 3 });
		expect(rows.find((r) => r.trackId === 'wav')!.cause).toBe('wav-copy');
	});

	it('purge strips tags and cues, keeps the row and its links, and takes it off the list', async () => {
		const { purged } = await svc.purgeDeletedTracks(['gone', 'live']);
		expect(purged).toEqual(['gone']);
		expect(count(`SELECT count(*) n FROM track_tag WHERE track_id = 'gone'`)).toBe(0);
		expect(count(`SELECT count(*) n FROM cue WHERE track_id = 'gone'`)).toBe(0);
		expect(count(`SELECT count(*) n FROM source_link WHERE track_id = 'gone'`)).toBe(1);
		expect(count(`SELECT count(*) n FROM track WHERE id = 'gone' AND deleted_at IS NOT NULL`)).toBe(1);
		expect((await svc.listDeletedTracks()).map((r) => r.trackId)).toEqual(['wav']);
		// The live track is untouched.
		expect(count(`SELECT count(*) n FROM track_tag WHERE track_id = 'live'`)).toBe(1);
		expect(purgedAt('live')).toBeNull();
		// A second purge is a no-op.
		expect((await svc.purgeDeletedTracks(['gone'])).purged).toEqual([]);
	});

	it('restore clears the purge mark; a fresh delete lists the track again', async () => {
		await svc.purgeDeletedTracks(['gone']);
		expect((await svc.undeleteTracks(['gone'])).restored).toEqual(['gone']);
		expect(purgedAt('gone')).toBeNull();
		await svc.deleteTracks(['gone']);
		expect((await svc.listDeletedTracks()).map((r) => r.trackId).sort()).toEqual(['gone', 'wav']);
	});
});
