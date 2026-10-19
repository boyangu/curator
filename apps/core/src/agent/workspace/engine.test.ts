// Engine tests — doubles as the design spike: the whole workspace rests on
// better-sqlite3 supporting a read-only main connection with attaches
// inheriting READONLY while the TEMP schema stays writable. If this suite
// fails, the fallbacks are snapshot-copy attaches or node:sqlite.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../db/migrate.js';
import { SqliteFeedStore } from '../../feed/store.js';
import { SqliteKnowledgeStore } from '../../knowledge/store.js';
import { WorkspaceEngine, validTableName, type WorkspaceDbPaths } from './engine.js';
import { guardSql } from './sql-guard.js';

function seedFixtures(dir: string): WorkspaceDbPaths {
	const paths = {
		curatorDb: join(dir, 'curator.db'),
		feedDb: join(dir, 'feed.db'),
		knowledgeDb: join(dir, 'knowledge.db'),
	};
	migrate(paths.curatorDb);
	// Create feed.db/knowledge.db through their real stores so the view SQL
	// is validated against the actual DDL, then seed rows directly (test
	// fixture files, not live data).
	new SqliteFeedStore(paths.feedDb).close();
	new SqliteKnowledgeStore(paths.knowledgeDb).close();

	const lib = new Database(paths.curatorDb);
	lib.prepare(`
		INSERT INTO track (id, title, artists, album_title, genre, label, bpm, key_camelot, isrc, release_date, rating, state, overrides, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run('t1', 'Canonical Title', JSON.stringify([{ name: 'Artist A' }, { name: 'Artist B' }]), 'Album', 'House', 'Anjunadeep', 122, '8A', 'ISRC1', '2026-07-01', 5, 'backlog', JSON.stringify({ title: 'Overridden Title', genre: 'Melodic House', releaseDate: '2020-01-31' }), 1, 1);
	lib.prepare(`
		INSERT INTO track (id, title, artists, genre, isrc, state, deleted_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run('t2', 'Deleted Track', JSON.stringify([{ name: 'X' }]), 'House', 'ISRC2', 'unsorted', 123, 1, 1);
	lib.close();

	const feed = new Database(paths.feedDb);
	feed.prepare(`
		INSERT INTO feed_item (id, type, source, source_id, dedupe_key, payload_json, published_at, fetched_at, order_ts, score, state)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run('f1', 'album', 'spotify', 'sp-album-1', 'dk1', JSON.stringify({
		title: 'Fresh Album',
		artists: ['Artist C'],
		genre: 'Techno',
		label: 'Afterlife',
		releaseDate: '2026-08-01',
		tracks: [
			{ sourceTrackId: 'sp-t1', title: 'Cut One', artists: ['Artist C'], bpm: 124, isrc: 'ISRC9' },
			{ sourceTrackId: 'sp-t2', title: 'Cut Two', artists: ['Artist C', 'Guest D'] },
		],
	}), 100, 100, 100, 0, 'fresh');
	feed.close();

	const kb = new Database(paths.knowledgeDb);
	kb.prepare(`
		INSERT INTO kb_entity (id, kind, name, name_ascii, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run('kb1', 'artist', 'Max Cooper', 'max cooper', 1, 1);
	kb.close();

	return paths;
}

describe('WorkspaceEngine', () => {
	let dir: string;
	let engine: WorkspaceEngine;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'curator-workspace-'));
		engine = new WorkspaceEngine(seedFixtures(dir));
	});

	afterEach(() => {
		engine.close();
		rmSync(dir, { recursive: true, force: true });
	});

	// ── The spike: read-only wall + writable TEMP ─────────────────────────

	it('opens WAL DBs read-only and rejects every write to real schemas', () => {
		engine.ensure('s1');
		for (const sql of [
			`UPDATE track SET rating = 1`,
			`INSERT INTO feed.feed_item (id, type, source, source_id, dedupe_key, payload_json, fetched_at, order_ts, score, state) VALUES ('x','track','spotify','x','x','{}',1,1,0,'fresh')`,
			`DELETE FROM kb.kb_entity`,
			`CREATE TABLE main.evil (x)`,
		]) {
			expect(() => engine.query('s1', sql, 10), sql).toThrow(/read-only|readonly/i);
		}
	});

	it('keeps TEMP writable: scratch tables joining across all three schemas', () => {
		engine.ensure('s1');
		const create = engine.query('s1', `
			CREATE TEMP TABLE picks AS
			SELECT v.id, v.title, k.name AS kb_artist
			FROM v_track v
			LEFT JOIN kb.kb_entity k ON k.kind = 'artist'
			WHERE v.genre LIKE '%House%'
		`, 10);
		// CTAS doesn't bump sqlite's changes counter — the SELECT below is the
		// real assertion that the scratch table exists and joined all schemas.
		expect(create.rows).toEqual([]);
		const rows = engine.query('s1', `SELECT title, kb_artist FROM picks ORDER BY title`, 10);
		expect(rows.rows).toEqual([['Overridden Title', 'Max Cooper']]);
	});

	it('applies user overrides and hides soft-deleted tracks in v_track', () => {
		engine.ensure('s1');
		const res = engine.query('s1', `SELECT id, title, artists, genre, label, release_date FROM v_track ORDER BY id`, 10);
		// t2 is soft-deleted — only t1 visible, with override title + genre +
		// release date (canonical says 2026-07-01; the override wins).
		expect(res.rows).toEqual([['t1', 'Overridden Title', 'Artist A | Artist B', 'Melodic House', 'Anjunadeep', '2020-01-31']]);
	});

	it('explodes artists in v_track_artist and v_feed_artist', () => {
		engine.ensure('s1');
		const lib = engine.query('s1', `SELECT track_id, artist FROM v_track_artist ORDER BY artist`, 10);
		// t2 is soft-deleted — only t1's two artists appear.
		expect(lib.rows).toEqual([['t1', 'Artist A'], ['t1', 'Artist B']]);
		const feed = engine.query('s1', `SELECT item_id, artist FROM v_feed_artist`, 10);
		expect(feed.rows).toEqual([['f1', 'Artist C']]);
	});

	it('flattens feed payloads in v_feed_item and v_feed_track', () => {
		engine.ensure('s1');
		const item = engine.query('s1', `SELECT id, title, artists, genre, label FROM v_feed_item`, 10);
		expect(item.rows).toEqual([['f1', 'Fresh Album', 'Artist C', 'Techno', 'Afterlife']]);
		const tracks = engine.query('s1', `SELECT item_id, spotify_track_id, title, artists, bpm FROM v_feed_track ORDER BY spotify_track_id`, 10);
		expect(tracks.rows).toEqual([
			['f1', 'sp-t1', 'Cut One', 'Artist C', 124],
			['f1', 'sp-t2', 'Cut Two', 'Artist C | Guest D', null],
		]);
	});

	it('isolates TEMP between sessions', () => {
		engine.ensure('s1');
		engine.ensure('s2');
		engine.query('s1', `CREATE TEMP TABLE mine (x)`, 10);
		expect(() => engine.query('s2', `SELECT * FROM mine`, 10)).toThrow(/no such table/i);
	});

	// ── Loads ─────────────────────────────────────────────────────────────

	it('load round-trip with replace-on-conflict and row counting', () => {
		engine.ensure('s1');
		const cols = [{ name: 'id', type: 'text' as const }, { name: 'n', type: 'integer' as const }];
		engine.loadBegin('s1', 'stuff', cols);
		engine.loadRows('s1', 'stuff', [['a', 1], ['b', 2]]);
		engine.loadRows('s1', 'stuff', [['c', 3]]);
		expect(engine.loadEnd('s1', 'stuff')).toEqual({ rowCount: 3 });
		// Reload replaces.
		engine.loadBegin('s1', 'stuff', cols);
		engine.loadRows('s1', 'stuff', [['z', 9]]);
		expect(engine.loadEnd('s1', 'stuff')).toEqual({ rowCount: 1 });
		expect(engine.query('s1', `SELECT id FROM stuff`, 10).rows).toEqual([['z']]);
	});

	it('rejects bad table and column names', () => {
		engine.ensure('s1');
		for (const bad of ['v_sneaky', 'sqlite_master', '_hidden', 'Caps', 'has space', 'x'.repeat(60)]) {
			expect(validTableName(bad), bad).toBe(false);
			expect(() => engine.loadBegin('s1', bad, [{ name: 'a', type: 'text' }])).toThrow(/invalid table name/);
		}
		expect(() => engine.loadBegin('s1', 'ok', [{ name: 'bad-col', type: 'text' }])).toThrow(/invalid column name/);
	});

	// ── Query shaping ─────────────────────────────────────────────────────

	it('truncates at maxRows via iterate (never materializing the full result)', () => {
		engine.ensure('s1');
		const res = engine.query('s1', `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n LIMIT 10000) SELECT x FROM n`, 5);
		expect(res.rows).toHaveLength(5);
		expect(res.truncated).toBe(true);
	});

	it('errors before ensure and cleans up on dropSession', () => {
		expect(() => engine.query('nope', 'SELECT 1', 1)).toThrow(/no workspace/);
		engine.ensure('s1');
		engine.query('s1', `CREATE TEMP TABLE x (a)`, 1);
		engine.dropSession('s1');
		expect(() => engine.query('s1', 'SELECT 1', 1)).toThrow(/no workspace/);
		// A fresh ensure starts clean.
		engine.ensure('s1');
		expect(() => engine.query('s1', `SELECT * FROM x`, 1)).toThrow(/no such table/);
	});
});

describe('guardSql', () => {
	it('blocks escape hatches, case/whitespace-insensitively', () => {
		for (const sql of [
			`ATTACH DATABASE 'x' AS y`,
			`attach database 'x' as y`,
			`SELECT 1; DETACH feed`,
			`PRAGMA hard_heap_limit = 1`,
			`select load_extension('evil')`,
			`VACUUM`,
			`REINDEX`,
			`ANALYZE`,
			`SELECT 1; DROP TABLE x`,
			``,
		]) {
			expect(guardSql(sql).ok, sql).toBe(false);
		}
	});

	it('allows the working set', () => {
		for (const sql of [
			`SELECT * FROM v_track LIMIT 5`,
			`WITH a AS (SELECT 1) SELECT * FROM a`,
			`CREATE TEMP TABLE x AS SELECT 1 AS n;`,
			`INSERT INTO x VALUES (2)`,
			`DROP TABLE x`,
			`CREATE INDEX idx ON x (n)`,
		]) {
			expect(guardSql(sql).ok, sql).toBe(true);
		}
	});
});
