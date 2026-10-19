// Post-scan existence prune for rekordbox playlists/folders. rekordbox
// hard-deletes DjmdPlaylist rows no sync peer has seen (no tombstone delta
// ever arrives), so the reader emits a `playlist_index` after a COMPLETE
// playlists pass and the importer removes rb-sourced rows absent from it.
// Real importer + migrated temp DB, stub sidecar replaying frames — same
// harness shape as mytag-tombstones.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { memberOrder } from '../test-support/playlist-track.js';
import { createDb, type Db } from '../db/client.js';
import { RekordboxImporter, type RunImportOptions, type ImportTotals } from './importer.js';
import type { RekordboxSidecar } from './sidecar.js';

let dir: string;
let db: Db;
let sqlite: Database.Database;

type Frame = { event: string; row: Record<string, unknown> };

function stubSidecar(frames: Frame[], cancelled: boolean): RekordboxSidecar {
	const emitter = new EventEmitter();
	return Object.assign(emitter, {
		open: async () => ({ ok: true }),
		scan: async () => {
			for (const f of frames) emitter.emit('event', { event: f.event, frame: { row: f.row } });
			return { watermarks: {}, cancelled };
		},
		cancel: async () => { /* */ },
	}) as unknown as RekordboxSidecar;
}

interface RunExtra {
	cancelled?: boolean;
	overwriteCurator?: boolean;
	syncPlaylists?: boolean;
	target?: RunImportOptions['target'];
}

async function runImport(frames: Frame[], extra: RunExtra = {}): Promise<ImportTotals> {
	const importer = new RekordboxImporter(db, stubSidecar(frames, extra.cancelled ?? false));
	const opts: RunImportOptions = {
		mode: 'full',
		flags: { syncTracks: false, syncPlaylists: extra.syncPlaylists ?? true, syncMyTags: false, syncCuesGridsPhrases: false, syncWaveformPeaks: false, syncHistory: false },
		dbPath: join(dir, 'master.db'), // never opened — stub sidecar
		peaksDir: join(dir, 'peaks'),
		...(extra.overwriteCurator ? { overwriteCurator: true } : {}),
		...(extra.target ? { target: extra.target } : {}),
	};
	return importer.runImport(opts);
}

const index = (live: string[] | null, missing: string[] | null = null): Frame =>
	({ event: 'playlist_index', row: { live_ids: live, missing_ids: missing } });

// Seeds mirror what applyPlaylistDelta writes: id = `rb_<rbId>`, sourceId = rbId.
function seedFolder(rbId: string, name: string, parentRbId: string | null = null, source = 'rekordbox'): void {
	const prefix = source === 'rekordbox' ? 'rb_' : `${source}_`;
	sqlite.prepare(`INSERT INTO playlist_folder (id, source, source_id, parent_folder_id, name) VALUES (?, ?, ?, ?, ?)`)
		.run(prefix + rbId, source, rbId, parentRbId ? prefix + parentRbId : null, name);
}
function seedPlaylist(rbId: string, name: string, parentRbId: string | null = null, source = 'rekordbox'): void {
	const prefix = source === 'rekordbox' ? 'rb_' : `${source}_`;
	sqlite.prepare(`INSERT INTO playlist (id, source, source_id, name, parent_folder_id) VALUES (?, ?, ?, ?, ?)`)
		.run(prefix + rbId, source, rbId, name, parentRbId ? prefix + parentRbId : null);
}
function seedTrack(id: string): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state, updated_at) VALUES (?, ?, '[]', 'unsorted', 1000)`).run(id, id);
}
function seedMember(rbId: string, trackId: string, position: number): void {
	sqlite.prepare(`INSERT INTO playlist_track (id, order_key, playlist_id, track_id, position, source_track_id) VALUES (?, ?, ?, ?, ?, ?)`).run(...memberOrder(position), `rb_${rbId}`, trackId, position, `C_${trackId}`);
	sqlite.prepare(`INSERT INTO rekordbox_membership_baseline (rb_playlist_id, member_kind, member_id, position) VALUES (?, 'rb', ?, ?)`).run(rbId, `C_${trackId}`, position);
}
function seedConflict(rbId: string): void {
	sqlite.prepare(`INSERT INTO playlist_conflict (id, provider, rb_playlist_id, kind, detected_at) VALUES (?, 'rekordbox', ?, 'order', 1000)`).run(`pc_${rbId}`, rbId);
}

const ids = (table: string): string[] => (sqlite.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
const count = (table: string, col: string, value: string): number =>
	(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(value) as { n: number }).n;
const parentOf = (table: string, id: string): string | null =>
	(sqlite.prepare(`SELECT parent_folder_id AS p FROM ${table} WHERE id = ?`).get(id) as { p: string | null }).p;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-plprune-'));
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
});

describe('importer: playlist existence prune (hard-deleted in rekordbox)', () => {
	it('removes playlists + folders absent from live_ids with their satellites, reparenting survivors', async () => {
		seedFolder('FL', 'live folder');
		seedFolder('FG', 'gone folder');
		seedFolder('FS', 'gone subfolder', 'FG');
		seedPlaylist('PS', 'live child of gone folder', 'FG');
		seedPlaylist('PL', 'live playlist', 'FL');
		seedPlaylist('PG', 'gone playlist', 'FL');
		seedTrack('t1'); seedTrack('t2'); seedTrack('t3');
		seedMember('PG', 't1', 0); seedMember('PG', 't2', 1); seedConflict('PG');
		seedMember('PL', 't3', 0);

		const totals = await runImport([index(['FL', 'PS', 'PL'])]);

		expect(totals.playlistsDeleted).toBe(3);
		expect(totals.playlistsPruneHeld).toBe(0);
		expect(ids('playlist_folder')).toEqual(['rb_FL']);
		expect(ids('playlist')).toEqual(['rb_PL', 'rb_PS']);
		expect(parentOf('playlist', 'rb_PS')).toBeNull();
		expect(parentOf('playlist', 'rb_PL')).toBe('rb_FL');
		expect(count('playlist_track', 'playlist_id', 'rb_PG')).toBe(0);
		expect(count('rekordbox_membership_baseline', 'rb_playlist_id', 'PG')).toBe(0);
		expect(count('playlist_conflict', 'rb_playlist_id', 'PG')).toBe(0);
		expect(count('playlist_track', 'playlist_id', 'rb_PL')).toBe(1);
		expect(count('rekordbox_membership_baseline', 'rb_playlist_id', 'PL')).toBe(1);
	});

	it('is a no-op when every row is still live', async () => {
		seedFolder('F1', 'f'); seedPlaylist('P1', 'p', 'F1');
		const totals = await runImport([index(['F1', 'P1'])]);
		expect(totals.playlistsDeleted).toBe(0);
		expect(ids('playlist_folder')).toEqual(['rb_F1']);
		expect(ids('playlist')).toEqual(['rb_P1']);
	});

	it('holds a mass prune until the user asks to overwrite Curator', async () => {
		for (let i = 0; i < 12; i++) seedPlaylist(`P${i}`, `p${i}`);

		const held = await runImport([index([])]);
		expect(held.playlistsPruneHeld).toBe(12);
		expect(held.playlistsDeleted).toBe(0);
		expect(ids('playlist')).toHaveLength(12);

		const forced = await runImport([index([])], { overwriteCurator: true });
		expect(forced.playlistsPruneHeld).toBe(0);
		expect(forced.playlistsDeleted).toBe(12);
		expect(ids('playlist')).toEqual([]);
	});

	it('lets a diff at or under the breaker through without overwrite', async () => {
		for (let i = 0; i < 12; i++) seedPlaylist(`P${i}`, `p${i}`);
		// 10 of 12 gone: threshold is max(10, ceil(3)) = 10, and 10 is not > 10.
		const totals = await runImport([index(['P0', 'P1'])]);
		expect(totals.playlistsPruneHeld).toBe(0);
		expect(totals.playlistsDeleted).toBe(10);
		expect(ids('playlist')).toEqual(['rb_P0', 'rb_P1']);
	});

	it('never prunes on a cancelled scan, without an index frame, or with the playlists scope off', async () => {
		seedPlaylist('PG', 'gone'); seedFolder('FG', 'gone');

		const cancelled = await runImport([index([])], { cancelled: true });
		expect(cancelled.playlistsDeleted).toBe(0);
		expect(cancelled.playlistsPruneHeld).toBe(0);
		expect((await runImport([])).playlistsDeleted).toBe(0);
		expect((await runImport([index([])], { syncPlaylists: false })).playlistsDeleted).toBe(0);

		expect(ids('playlist')).toEqual(['rb_PG']);
		expect(ids('playlist_folder')).toEqual(['rb_FG']);
	});

	it('targeted pull prunes exactly the reported missing ids, with no breaker', async () => {
		seedFolder('FG', 'gone folder'); seedPlaylist('PG', 'gone', 'FG'); seedPlaylist('PL', 'live');
		seedPlaylist('PX', 'untargeted: gone in rb too, but not judged by this pull');

		const totals = await runImport(
			[index(null, ['FG', 'PG'])],
			{ target: { rbContentIds: [], rbPlaylistIds: ['FG', 'PG', 'PL'] } },
		);

		expect(totals.playlistsDeleted).toBe(2);
		expect(ids('playlist_folder')).toEqual([]);
		expect(ids('playlist')).toEqual(['rb_PL', 'rb_PX']);
	});

	it('leaves other providers alone and keys rb rows on sourceId, not a rebuilt id', async () => {
		seedPlaylist('S1', 'spotify list', null, 'spotify');
		seedFolder('S2', 'spotify folder', null, 'spotify');
		seedPlaylist('PG', 'gone rb');
		// Legacy rb row whose id is not rb_<sourceId>.
		sqlite.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES ('legacy-1', 'rekordbox', 'LG', 'legacy gone')`).run();

		const totals = await runImport([index([])]);

		expect(totals.playlistsDeleted).toBe(2);
		expect(ids('playlist')).toEqual(['spotify_S1']);
		expect(ids('playlist_folder')).toEqual(['spotify_S2']);
	});

	it('tombstone deltas still delete through the shared helper', async () => {
		seedFolder('FG', 'folder'); seedPlaylist('PC', 'child', 'FG'); seedPlaylist('PT', 'tombstoned');
		seedTrack('t1'); seedMember('PT', 't1', 0); seedConflict('PT');
		const dead = (rbId: string, isFolder: boolean): Frame => ({
			event: 'playlist',
			row: { rb_playlist_id: rbId, rb_local_usn: 1, rb_local_deleted: true, parent_folder_id: null, name: 'x', is_folder: isFolder, is_smart: false, position: 0, tracks: [] },
		});

		const totals = await runImport([dead('FG', true), dead('PT', false), index(['PC'])]);

		expect(totals.playlistsDeleted).toBe(2);
		expect(ids('playlist_folder')).toEqual([]);
		expect(ids('playlist')).toEqual(['rb_PC']);
		expect(parentOf('playlist', 'rb_PC')).toBeNull();
		expect(count('playlist_track', 'playlist_id', 'rb_PT')).toBe(0);
		expect(count('rekordbox_membership_baseline', 'rb_playlist_id', 'PT')).toBe(0);
		expect(count('playlist_conflict', 'rb_playlist_id', 'PT')).toBe(0);
	});
});
