// The sync drains' dirty-mark triggers (migrate.ts *_dirty_change): an UPDATE
// that writes back the values a row already holds marks nothing; a real
// change of a stated column marks it; and a database an older build left
// with the ungated triggers gets them replaced on the next migrate().
//
// Generated DBs only (CLAUDE.md): mkdtempSync + migrate(), synthetic rows.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrate.js';

let dir: string;
let dbPath: string;
let db: Database.Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-dirty-triggers-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	db = new Database(dbPath);
	db.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration, bpm, key_camelot) VALUES ('t1', 'rec-1', 'Title', '[{"name":"A"}]', 'unsorted', 300, 124, '8A')`).run();
	db.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, payload) VALUES ('l1', 't1', 'spotify', 'sp1', '{"album":{"id":"al1"}}')`).run();
	db.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, payload) VALUES ('l2', 't1', 'beatport', 'bp1', '{"x":1}')`).run();
	db.prepare(`INSERT INTO playlist (id, source, source_id, name, description, followers) VALUES ('p1', 'spotify', 'sp-p1', 'P', 'about', 10)`).run();
	db.prepare(`INSERT INTO playlist_folder (id, source, source_id, name, position) VALUES ('f1', 'rekordbox', 'rb-f1', 'F', 3)`).run();
	clearMarks();
});
afterEach(() => {
	db.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

function clearMarks(): void {
	db.exec(`DELETE FROM track_meta_dirty; DELETE FROM track_attrs_dirty; DELETE FROM playlist_attrs_dirty`);
}

const marked = (): { meta: number; attrs: number; playlists: string[] } => ({
	meta: db.prepare(`SELECT count(*) FROM track_meta_dirty`).pluck().get() as number,
	attrs: db.prepare(`SELECT count(*) FROM track_attrs_dirty`).pluck().get() as number,
	playlists: (db.prepare(`SELECT entity || ':' || id FROM playlist_attrs_dirty ORDER BY 1`).pluck().all() as string[]),
});

const triggerNames = (): string[] => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`).pluck().all() as string[];

describe('dirty triggers fire on a value change only', () => {
	it('a write-back of the same values marks nothing', () => {
		db.prepare(`UPDATE track SET title = title, artists = artists, duration = duration, cover_url = cover_url, bpm = bpm, key_camelot = key_camelot,
			comment = comment, overrides = overrides, remote_only = remote_only, attrs_adopted = attrs_adopted WHERE id = 't1'`).run();
		// An upsert that re-states the row as a read-sync does, NULLs included.
		db.prepare(`UPDATE track SET title = 'Title', isrc = NULL, bpm = 124 WHERE id = 't1'`).run();
		db.prepare(`UPDATE source_link SET track_id = 't1', payload = payload WHERE track_id = 't1'`).run();
		db.prepare(`UPDATE playlist SET description = 'about', followers = 10, owner_name = NULL, mark = mark WHERE id = 'p1'`).run();
		db.prepare(`UPDATE playlist_folder SET position = 3 WHERE id = 'f1'`).run();
		expect(marked()).toEqual({ meta: 0, attrs: 0, playlists: [] });
	});

	it('a real change marks the row for the drain that states it', () => {
		db.prepare(`UPDATE track SET title = 'Title (Remix)' WHERE id = 't1'`).run();
		expect(marked()).toMatchObject({ meta: 1, attrs: 0 });
		clearMarks();

		db.prepare(`UPDATE track SET bpm = 125 WHERE id = 't1'`).run();
		expect(marked()).toMatchObject({ meta: 0, attrs: 1 });
		clearMarks();

		// NULL ↔ value is a change (IS NOT, not !=).
		db.prepare(`UPDATE track SET isrc = 'GBAAA0000001', comment = 'warm-up' WHERE id = 't1'`).run();
		expect(marked()).toMatchObject({ meta: 1, attrs: 1 });
		clearMarks();
		db.prepare(`UPDATE track SET isrc = NULL WHERE id = 't1'`).run();
		expect(marked()).toMatchObject({ meta: 1, attrs: 0 });
		clearMarks();

		// The overrides' artists are part of the credits the attrs drain states.
		db.prepare(`UPDATE track SET overrides = '{"artists":[{"name":"B"}]}' WHERE id = 't1'`).run();
		expect(marked()).toMatchObject({ meta: 0, attrs: 1 });
		clearMarks();

		db.prepare(`UPDATE source_link SET payload = '{"album":{"id":"al2"}}' WHERE id = 'l1'`).run();
		expect(marked()).toMatchObject({ meta: 0, attrs: 1 });
		clearMarks();
		// A Beatport payload is not read by the drain (the link counts by being there).
		db.prepare(`UPDATE source_link SET payload = '{"x":2}' WHERE id = 'l2'`).run();
		expect(marked()).toMatchObject({ attrs: 0 });

		db.prepare(`UPDATE playlist SET followers = 11 WHERE id = 'p1'`).run();
		db.prepare(`UPDATE playlist_folder SET position = 4 WHERE id = 'f1'`).run();
		expect(marked().playlists).toEqual(['playlist:p1', 'playlist_folder:f1']);
	});

	it('still skips remote rows and derived copies', () => {
		db.prepare(`UPDATE track SET remote_only = 1 WHERE id = 't1'`).run();
		clearMarks();
		db.prepare(`UPDATE track SET title = 'Other', bpm = 99 WHERE id = 't1'`).run();
		expect(marked()).toMatchObject({ meta: 0, attrs: 0 });
		// Claimed back: the flip itself is the change.
		db.prepare(`UPDATE track SET remote_only = 0 WHERE id = 't1'`).run();
		expect(marked()).toMatchObject({ meta: 1, attrs: 1 });
	});

	it('replaces the ungated triggers an older build left', () => {
		db.exec(`DROP TRIGGER track_meta_dirty_change;
			CREATE TRIGGER track_meta_dirty_update AFTER UPDATE OF title ON track
			BEGIN INSERT OR IGNORE INTO track_meta_dirty (track_id) VALUES (NEW.id); END`);
		db.close();
		migrate(dbPath);
		db = new Database(dbPath);
		const names = triggerNames();
		for (const old of ['track_meta_dirty_update', 'track_meta_dirty_link_move', 'track_attrs_dirty_update', 'track_attrs_dirty_link_update', 'playlist_attrs_dirty_update', 'folder_attrs_dirty_update']) {
			expect(names).not.toContain(old);
		}
		expect(names).toEqual(expect.arrayContaining(['track_meta_dirty_change', 'track_meta_dirty_link_moved', 'track_attrs_dirty_change', 'track_attrs_dirty_link_change', 'playlist_attrs_dirty_change', 'folder_attrs_dirty_change']));
		clearMarks();
		db.prepare(`UPDATE track SET title = title WHERE id = 't1'`).run();
		expect(marked().meta).toBe(0);
	});
});
