// The one-shot sync schema migration (cloud plan B3): playlist_track rebuilt
// from the position-keyed table to row ids + order keys, recording_id minted
// for every track, one backup, a gate that makes the next migrate() a no-op,
// and a per-boot fill that heals a writer that skipped recording_id.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrate.js';
import { createDb } from './client.js';
import { recordingIdForTrack } from '../sync-log/recording-id.js';
import { getDeviceId, DEVICE_ID_KEY } from '../sync-log/device.js';

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-sync-schema-'));
	path = join(dir, 'curator.db');
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

// playlist_track exactly as it shipped before the rebuild (migrate.ts DDL up
// to 2026-10-16). Kept here as a fixture so the test exercises the real
// legacy shape, not whatever the current DDL says.
const LEGACY_PLAYLIST_TRACK = `
CREATE TABLE playlist_track (
	playlist_id TEXT NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
	track_id TEXT NOT NULL REFERENCES track(id) ON DELETE CASCADE,
	position INTEGER NOT NULL,
	added_at INTEGER,
	added_by TEXT,
	source_track_id TEXT NOT NULL,
	PRIMARY KEY (playlist_id, position)
);
CREATE INDEX IF NOT EXISTS playlist_track_track_idx ON playlist_track(track_id);
`;

type Row = { id: string; playlist_id: string; track_id: string; order_key: string; position: number; added_at: number | null; added_by: string | null; source_track_id: string };

function seedLegacy(): void {
	// A library from before the rebuild: first migrate() builds the current
	// schema; then the table goes back to the legacy shape, recording ids and
	// the gate are cleared, and rows are seeded the way old writers left them.
	migrate(path);
	const db = new Database(path);
	db.exec(`DROP TABLE playlist_track;`);
	db.exec(LEGACY_PLAYLIST_TRACK);
	db.prepare(`DELETE FROM app_setting WHERE key = 'sync_schema_version'`).run();
	const track = db.prepare(`INSERT INTO track (id, title, artists, state) VALUES (?, ?, '[]', 'unsorted')`);
	for (const id of ['t1', 't2', 't3', 't4', 'gone']) track.run(id, id.toUpperCase());
	db.prepare(`UPDATE track SET deleted_at = 1 WHERE id = 'gone'`).run();
	const pl = db.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES (?, 'local', ?, ?)`);
	pl.run('p1', 'p1', 'Reordered');
	pl.run('p2', 'p2', 'Gappy');
	pl.run('p3', 'p3', 'Empty');
	const pt = db.prepare(`INSERT INTO playlist_track (playlist_id, track_id, position, added_at, added_by, source_track_id) VALUES (?, ?, ?, ?, ?, ?)`);
	// p1: 1-based, as the old reorderPlaylistTracks wrote it, with t1 twice;
	// inserted out of position order so the copy must sort, not trust rowid.
	pt.run('p1', 't3', 4, 400, null, 's3');
	pt.run('p1', 't1', 1, 100, 'rekordbox', 's1');
	pt.run('p1', 't2', 2, 200, null, 's2');
	pt.run('p1', 't1', 3, 300, null, 's1b');
	// p2: 0-based with a gap (a hard delete's cascade left it).
	pt.run('p2', 't4', 0, null, null, 's4');
	pt.run('p2', 'gone', 5, null, null, 'sg');
	db.close();
}

const rowsOf = (db: Database.Database, playlistId: string): Row[] =>
	db.prepare(`SELECT * FROM playlist_track WHERE playlist_id = ? ORDER BY order_key, id`).all(playlistId) as Row[];

const backups = (): string[] => readdirSync(dir).filter((f) => f.startsWith('curator.db.pre-sync-schema-') && f.endsWith('.bak'));

describe('sync schema migration', () => {
	it('rebuilds playlist_track with ids and order keys in the old order, positions 0..n-1', () => {
		seedLegacy();
		migrate(path);
		const db = new Database(path);

		const p1 = rowsOf(db, 'p1');
		expect(p1.map((r) => [r.track_id, r.source_track_id])).toEqual([['t1', 's1'], ['t2', 's2'], ['t1', 's1b'], ['t3', 's3']]);
		expect(p1.map((r) => r.position)).toEqual([0, 1, 2, 3]);
		// Every other column survives the copy.
		expect(p1.map((r) => [r.added_at, r.added_by])).toEqual([[100, 'rekordbox'], [200, null], [300, null], [400, null]]);
		const p2 = rowsOf(db, 'p2');
		expect(p2.map((r) => [r.track_id, r.position])).toEqual([['t4', 0], ['gone', 1]]);

		for (const rows of [p1, p2]) {
			for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.order_key < rows[i]!.order_key).toBe(true);
		}
		const all = db.prepare(`SELECT id FROM playlist_track`).all() as Array<{ id: string }>;
		expect(new Set(all.map((r) => r.id)).size).toBe(6);

		expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
		const cols = db.prepare(`SELECT name, pk FROM pragma_table_info('playlist_track')`).all() as Array<{ name: string; pk: number }>;
		expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['id']);
		const indexes = db.prepare(`SELECT name, "unique" AS u FROM pragma_index_list('playlist_track')`).all() as Array<{ name: string; u: number }>;
		expect(indexes).toEqual(expect.arrayContaining([
			{ name: 'playlist_track_position_uniq', u: 1 },
			{ name: 'playlist_track_order_idx', u: 0 },
			{ name: 'playlist_track_track_idx', u: 0 },
		]));
		expect(db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'playlist_track_v2'`).get()).toEqual({ n: 0 });
		db.close();
	});

	it('the unique (playlist_id, position) index still rejects a collision', () => {
		seedLegacy();
		migrate(path);
		const db = new Database(path);
		expect(() => db.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, source_track_id) VALUES ('x', 'p1', 't2', 'a9', 0, 'x')`).run())
			.toThrow(/UNIQUE/);
		db.close();
	});

	it('mints a recording id for every track, soft-deleted ones included, sets the gate and backs up once', () => {
		seedLegacy();
		migrate(path);
		const db = new Database(path);
		const tracks = db.prepare(`SELECT id, recording_id FROM track`).all() as Array<{ id: string; recording_id: string | null }>;
		expect(tracks.length).toBe(5);
		for (const t of tracks) expect(t.recording_id).toBe(recordingIdForTrack(t.id));
		expect(db.prepare(`SELECT value FROM app_setting WHERE key = 'sync_schema_version'`).get()).toEqual({ value: '1' });
		db.close();
		expect(backups()).toHaveLength(1);
	});

	it('a second migrate() is a no-op', () => {
		seedLegacy();
		migrate(path);
		const snapshot = (): unknown => {
			const db = new Database(path);
			const out = {
				rows: db.prepare(`SELECT * FROM playlist_track ORDER BY id`).all(),
				tracks: db.prepare(`SELECT id, recording_id FROM track ORDER BY id`).all(),
			};
			db.close();
			return out;
		};
		const before = snapshot();
		migrate(path);
		expect(snapshot()).toEqual(before);
		expect(backups()).toHaveLength(1);
	});

	it('heals a track a writer inserted without a recording id, on the next migrate', () => {
		migrate(path);
		const db = new Database(path);
		db.prepare(`INSERT INTO track (id, title, artists, state) VALUES ('late', 'Late', '[]', 'unsorted')`).run();
		db.close();
		migrate(path);
		const check = new Database(path);
		expect(check.prepare(`SELECT recording_id FROM track WHERE id = 'late'`).get()).toEqual({ recording_id: recordingIdForTrack('late') });
		check.close();
		expect(backups()).toHaveLength(0);
	});

	it('a fresh install gets the new shape and the gate without a backup', () => {
		migrate(path);
		const db = new Database(path);
		const cols = (db.prepare(`SELECT name FROM pragma_table_info('playlist_track')`).all() as Array<{ name: string }>).map((c) => c.name);
		expect(cols).toEqual(['id', 'playlist_id', 'track_id', 'order_key', 'position', 'added_at', 'added_by', 'source_track_id']);
		expect(db.prepare(`SELECT value FROM app_setting WHERE key = 'sync_schema_version'`).get()).toEqual({ value: '1' });
		for (const t of ['sync_outbox', 'sync_cursor', 'recording_alias', 'tombstone']) {
			expect(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
		}
		db.close();
		expect(backups()).toHaveLength(0);
	});
});

describe('getDeviceId', () => {
	it('mints one id on first use and returns it ever after', () => {
		migrate(path);
		const { sqlite } = createDb(path);
		expect(sqlite.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(DEVICE_ID_KEY)).toBeUndefined();
		const id = getDeviceId(sqlite);
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		expect(getDeviceId(sqlite)).toBe(id);
		sqlite.close();
		const again = createDb(path);
		expect(getDeviceId(again.sqlite)).toBe(id);
		again.sqlite.close();
	});
});
