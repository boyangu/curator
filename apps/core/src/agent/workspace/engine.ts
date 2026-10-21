// WorkspaceEngine — the agent's deterministic data runtime. One SQLite
// connection per agent session:
//
//   main   = curator.db, opened { readonly: true }  (file-level SQLITE_OPEN_READONLY)
//   feed.* = feed.db      (ATTACHed — inherits the connection's READONLY)
//   kb.*   = knowledge.db (ATTACHed — inherits the connection's READONLY)
//   temp.* = the scratch schema — SQLite keeps TEMP writable even on
//            read-only connections, it's per-connection (free per-session
//            isolation), and TEMP objects are the only kind allowed to
//            reference across attached schemas.
//
// Why not ATTACH 'file:…?mode=ro': our better-sqlite3 build compiles SQLite
// with SQLITE_USE_URI=0 and opens without SQLITE_OPEN_URI, so URI filenames
// don't parse — and a read-write connection would attach the live DBs
// read-write (live-data guardrail violation). Read-only-main inverts that:
// model-issued writes to real data fail at the SQLite level.
//
// Synchronous and Electron-free by design: the desktop main wraps this in a
// utilityProcess worker (kill-able mid-query — better-sqlite3 has no
// interrupt); tests and headless callers use it inline.

import Database from 'better-sqlite3';
import { guardSql } from './sql-guard.js';

export interface WorkspaceDbPaths {
	curatorDb: string;
	feedDb: string;
	knowledgeDb: string;
}

export interface WorkspaceColumn {
	name: string;
	type: 'text' | 'integer' | 'real';
}

export interface WorkspaceQueryResult {
	columns: string[];
	// Array-of-arrays — token-cheap on the model side.
	rows: unknown[][];
	truncated: boolean;
	elapsedMs: number;
	// Set for non-SELECT statements (CREATE TEMP TABLE AS, INSERT, …).
	changes?: number;
}

// Loaded-table and scratch-table naming: model/tool-supplied, so strict.
// Leading `_`, `v_` and `sqlite_` are reserved (provenance columns, views,
// SQLite internals).
const TABLE_NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;
export function validTableName(name: string): boolean {
	return TABLE_NAME_RE.test(name) && !name.startsWith('sqlite_') && !name.startsWith('v_');
}

const COLUMN_NAME_RE = /^[a-z_][a-z0-9_]{0,40}$/;

// Overridable track fields (TrackOverrides in packages/shared/src/schema.ts)
// — v_track resolves canonical-vs-override in SQL so the model always reads
// the user's corrected values.
const OVERRIDE = (json: string, col: string): string =>
	`COALESCE(json_extract(t.overrides, '$.${json}'), t.${col})`;

const TEMP_VIEWS = `
CREATE TEMP VIEW v_track AS SELECT
	t.id,
	${OVERRIDE('title', 'title')} AS title,
	(SELECT group_concat(json_extract(a.value, '$.name'), ' | ')
		FROM json_each(COALESCE(json_extract(t.overrides, '$.artists'), t.artists)) a) AS artists,
	${OVERRIDE('albumTitle', 'album_title')} AS album_title,
	${OVERRIDE('label', 'label')} AS label,
	${OVERRIDE('genre', 'genre')} AS genre,
	${OVERRIDE('bpm', 'bpm')} AS bpm,
	${OVERRIDE('keyCamelot', 'key_camelot')} AS key_camelot,
	t.isrc, ${OVERRIDE('releaseDate', 'release_date')} AS release_date, t.duration AS duration_sec, t.cover_url,
	t.rating, t.state, t.membership, t.play_count,
	t.brightness, t.power, t.dissonance, t.density, t.loudness_range_lu,
	COALESCE(t.added_at, t.created_at) AS added_at, t.created_at
FROM track t WHERE t.deleted_at IS NULL;

CREATE TEMP VIEW v_feed_item AS SELECT
	id, type, source, source_id, state, published_at, fetched_at,
	json_extract(payload_json, '$.title') AS title,
	(SELECT group_concat(a.value, ' | ') FROM json_each(payload_json, '$.artists') a) AS artists,
	json_extract(payload_json, '$.genre') AS genre,
	json_extract(payload_json, '$.label') AS label,
	json_extract(payload_json, '$.bpm') AS bpm,
	json_extract(payload_json, '$.keyCamelot') AS key_camelot,
	json_extract(payload_json, '$.isrc') AS isrc,
	json_extract(payload_json, '$.releaseDate') AS release_date,
	json_extract(payload_json, '$.albumType') AS album_type,
	promoted_track_id,
	covered_by
FROM feed.feed_item;

-- Exploded artist rows — per-artist analytics ("my top artists") are a
-- GROUP BY here instead of string surgery on the joined artists text. The
-- JSON stays the driver (always present, override-aware); the artist
-- table joins in by position to supply the curated display name and the
-- Curator artist id, so GROUP BY artist collapses spelling variants.
CREATE TEMP VIEW v_track_artist AS SELECT
	t.id AS track_id,
	COALESCE(ar.name, json_extract(a.value, '$.name')) AS artist,
	ar.id AS artist_id,
	json_extract(a.value, '$.role') AS role
FROM track t, json_each(COALESCE(json_extract(t.overrides, '$.artists'), t.artists)) a
LEFT JOIN track_artist ta ON ta.track_id = t.id AND ta.position = a.key
LEFT JOIN artist ar ON ar.id = ta.artist_id
WHERE t.deleted_at IS NULL;

-- The junction tables, live tracks only: a deleted track keeps its links,
-- tags and followed-playlist rows (they are what keeps it deleted), so a
-- count or join over the raw tables would see tracks the user deleted.
CREATE TEMP VIEW v_source_link AS SELECT l.track_id, l.source, l.source_track_id, l.url
FROM source_link l JOIN track t ON t.id = l.track_id WHERE t.deleted_at IS NULL;

CREATE TEMP VIEW v_playlist_track AS SELECT pt.playlist_id, pt.track_id, pt.position
FROM playlist_track pt JOIN track t ON t.id = pt.track_id WHERE t.deleted_at IS NULL;

CREATE TEMP VIEW v_track_tag AS SELECT tt.track_id, tt.tag_id
FROM track_tag tt JOIN track t ON t.id = tt.track_id WHERE t.deleted_at IS NULL;

CREATE TEMP VIEW v_feed_artist AS SELECT
	i.id AS item_id,
	a.value AS artist
FROM feed.feed_item i, json_each(i.payload_json, '$.artists') a;

CREATE TEMP VIEW v_feed_track AS SELECT
	i.id AS item_id,
	json_extract(i.payload_json, '$.title') AS album_title,
	json_extract(tr.value, '$.sourceTrackId') AS spotify_track_id,
	json_extract(tr.value, '$.title') AS title,
	(SELECT group_concat(a.value, ' | ') FROM json_each(tr.value, '$.artists') a) AS artists,
	json_extract(tr.value, '$.bpm') AS bpm,
	json_extract(tr.value, '$.keyCamelot') AS key_camelot,
	json_extract(tr.value, '$.genre') AS genre,
	json_extract(tr.value, '$.label') AS label,
	json_extract(tr.value, '$.isrc') AS isrc,
	json_extract(tr.value, '$.durationSec') AS duration_sec
FROM feed.feed_item i, json_each(i.payload_json, '$.tracks') tr;
`;

interface SessionState {
	db: Database.Database;
	tables: Set<string>;
	insertStmts: Map<string, Database.Statement>;
}

export class WorkspaceEngine {
	private sessions = new Map<string, SessionState>();

	constructor(private readonly paths: WorkspaceDbPaths) {}

	ensure(sessionId: string): { tables: string[] } {
		const existing = this.sessions.get(sessionId);
		if (existing) return { tables: [...existing.tables] };
		const db = new Database(this.paths.curatorDb, { readonly: true, fileMustExist: true });
		try {
			// Attached DBs inherit the connection's READONLY open flags — this
			// is what makes model-issued writes to real data impossible.
			db.prepare(`ATTACH DATABASE ? AS feed`).run(this.paths.feedDb);
			db.prepare(`ATTACH DATABASE ? AS kb`).run(this.paths.knowledgeDb);
			// Bound runaway aggregate memory (per-connection soft + hard limit).
			db.pragma('hard_heap_limit = 536870912');
			db.exec(TEMP_VIEWS);
		} catch (err) {
			db.close();
			throw err;
		}
		this.sessions.set(sessionId, { db, tables: new Set(), insertStmts: new Map() });
		return { tables: [] };
	}

	private state(sessionId: string): SessionState {
		const s = this.sessions.get(sessionId);
		if (!s) throw new Error(`no workspace for session ${sessionId} — call ensure first`);
		return s;
	}

	loadBegin(sessionId: string, table: string, columns: WorkspaceColumn[]): void {
		const s = this.state(sessionId);
		if (!validTableName(table)) throw new Error(`invalid table name "${table}" (lowercase, [a-z0-9_], no v_/sqlite_ prefix)`);
		if (columns.length === 0) throw new Error('at least one column required');
		for (const c of columns) {
			if (!COLUMN_NAME_RE.test(c.name)) throw new Error(`invalid column name "${c.name}"`);
		}
		// Replace-on-conflict: re-loading a table name drops the old copy.
		s.db.exec(`DROP TABLE IF EXISTS temp."${table}"`);
		const ddl = columns.map((c) => `"${c.name}" ${c.type.toUpperCase()}`).join(', ');
		s.db.exec(`CREATE TEMP TABLE "${table}" (${ddl})`);
		s.insertStmts.set(
			table,
			s.db.prepare(`INSERT INTO temp."${table}" VALUES (${columns.map(() => '?').join(', ')})`),
		);
	}

	loadRows(sessionId: string, table: string, rows: unknown[][]): void {
		const s = this.state(sessionId);
		const stmt = s.insertStmts.get(table);
		if (!stmt) throw new Error(`no load in progress for table "${table}"`);
		const insertAll = s.db.transaction((batch: unknown[][]) => {
			for (const row of batch) stmt.run(...row);
		});
		insertAll(rows);
	}

	loadEnd(sessionId: string, table: string): { rowCount: number } {
		const s = this.state(sessionId);
		if (!s.insertStmts.delete(table)) throw new Error(`no load in progress for table "${table}"`);
		s.tables.add(table);
		const row = s.db.prepare(`SELECT COUNT(*) AS n FROM temp."${table}"`).get() as { n: number };
		return { rowCount: row.n };
	}

	query(sessionId: string, sql: string, maxRows: number): WorkspaceQueryResult {
		const s = this.state(sessionId);
		const guard = guardSql(sql);
		if (!guard.ok) throw new Error(guard.reason);
		const started = Date.now();
		let stmt: Database.Statement;
		try {
			stmt = s.db.prepare(sql);
		} catch (err) {
			throw remapSqliteError(err);
		}
		try {
			if (!stmt.reader) {
				// CREATE TEMP TABLE AS / INSERT INTO temp / DROP — scratch writes.
				const info = stmt.run();
				return { columns: [], rows: [], truncated: false, elapsedMs: Date.now() - started, changes: info.changes };
			}
			const columns = stmt.columns().map((c) => c.name);
			const rows: unknown[][] = [];
			let truncated = false;
			// iterate + early break — never .all(): a huge result must cost at
			// most maxRows of JS memory, whatever the query produces.
			for (const row of stmt.raw(true).iterate()) {
				if (rows.length >= maxRows) { truncated = true; break; }
				rows.push(row as unknown[]);
			}
			return { columns, rows, truncated, elapsedMs: Date.now() - started };
		} catch (err) {
			throw remapSqliteError(err);
		}
	}

	dropSession(sessionId: string): void {
		const s = this.sessions.get(sessionId);
		if (!s) return;
		this.sessions.delete(sessionId);
		try { s.db.close(); } catch { /* already closed */ }
	}

	close(): void {
		for (const id of [...this.sessions.keys()]) this.dropSession(id);
	}
}

// Make the read-only wall self-explanatory to the model: the fix is always
// "put scratch in TEMP".
function remapSqliteError(err: unknown): Error {
	const message = err instanceof Error ? err.message : String(err);
	if (/readonly|attempt to write a readonly database/i.test(message)) {
		return new Error(
			'the library/feed/kb schemas are read-only — scratch tables must be TEMP: CREATE TEMP TABLE name AS SELECT …',
		);
	}
	return err instanceof Error ? err : new Error(message);
}
