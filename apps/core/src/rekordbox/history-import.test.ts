// Rekordbox play-history import: session upsert keyed by rbHistoryId, play
// upsert keyed by rbSongHistoryId, USB bulk-insert classification (set vs
// prep), the permanence of a user kind-override, and the unlinked-play heal
// pass. Runs the REAL importer against a migrated temp DB with a stub
// sidecar that replays synthetic 'history' frames — never real data.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { RekordboxImporter, type RunImportOptions } from './importer.js';
import type { RekordboxSidecar } from './sidecar.js';

let dir: string;
let dbPath: string;
let db: Db;
let sqlite: Database.Database;

interface HistFrame {
	rb_history_id: string;
	name: string;
	date_created_ms: number | null;
	plays: { rb_song_history_id: string; rb_content_id: string; track_no: number; created_at_ms: number | null }[];
}

// Stub sidecar: open() succeeds, scan() replays the history frames ONLY when
// the importer actually asked for the 'history' scope (mirrors the reader
// gate), then resolves. Records the scopes it was handed so tests can assert
// the importer's scope decision — including that a scoped/targeted pull still
// requests history.
function stubSidecar(sessions: HistFrame[], seenScopes: string[][]): RekordboxSidecar {
	const emitter = new EventEmitter();
	const sidecar = Object.assign(emitter, {
		open: async () => ({ ok: true }),
		scan: async (params: { scopes: string[] }) => {
			seenScopes.push(params.scopes);
			if (params.scopes.includes('history')) {
				for (const s of sessions) {
					emitter.emit('event', { event: 'history', frame: { row: s } });
				}
			}
			return { watermarks: {}, cancelled: false };
		},
		cancel: async () => { /* */ },
	});
	return sidecar as unknown as RekordboxSidecar;
}

function runHistoryImport(
	sessions: HistFrame[],
	extra: { target?: RunImportOptions['target']; seenScopes?: string[][] } = {},
): Promise<unknown> {
	const importer = new RekordboxImporter(db, stubSidecar(sessions, extra.seenScopes ?? []));
	const opts: RunImportOptions = {
		mode: 'full',
		flags: {
			syncTracks: false,
			syncPlaylists: false,
			syncMyTags: false,
			syncCuesGridsPhrases: false,
			syncWaveformPeaks: false,
			syncHistory: true,
		},
		dbPath: join(dir, 'master.db'), // never opened — stub sidecar
		peaksDir: join(dir, 'peaks'),
		...(extra.target ? { target: extra.target } : {}),
	};
	return importer.runImport(opts);
}

function seedLinkedTrack(id: string, rbContentId: string): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES (?, ?, '[]', 'unsorted')`).run(id, id);
	sqlite.prepare(
		`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at) VALUES (?, ?, 0, 0, 0)`,
	).run(id, rbContentId);
}

const T0 = Date.parse('2026-08-14T10:00:00Z');

// A live rekordbox session: plays spread over ~40 minutes.
function liveSession(id = 'H1'): HistFrame {
	return {
		rb_history_id: id,
		name: 'HISTORY 2026-08-14',
		date_created_ms: T0,
		plays: [
			{ rb_song_history_id: `${id}-s1`, rb_content_id: 'C1', track_no: 1, created_at_ms: T0 },
			{ rb_song_history_id: `${id}-s2`, rb_content_id: 'C2', track_no: 2, created_at_ms: T0 + 20 * 60_000 },
			{ rb_song_history_id: `${id}-s3`, rb_content_id: 'C3', track_no: 3, created_at_ms: T0 + 40 * 60_000 },
		],
	};
}

// A USB device-pane import: every row bulk-inserted in the same instant.
function bulkSession(id = 'H2'): HistFrame {
	return {
		rb_history_id: id,
		name: 'HISTORY 2026-08-09 (1)',
		date_created_ms: T0,
		plays: [1, 2, 3, 4].map((n) => ({
			rb_song_history_id: `${id}-s${n}`,
			rb_content_id: `C${n}`,
			track_no: n,
			created_at_ms: T0 + (n === 1 ? 0 : 5), // ≈0 span
		})),
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-hist-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('history import: classification + timestamps', () => {
	it('spread session → prep with real playedAt; bulk session → set with null playedAt', async () => {
		seedLinkedTrack('t1', 'C1');
		await runHistoryImport([liveSession(), bulkSession()]);

		const live = sqlite.prepare(`SELECT kind, kind_source, ended_at FROM play_session WHERE rb_history_id = 'H1'`).get() as Record<string, unknown>;
		expect(live).toMatchObject({ kind: 'prep', kind_source: 'auto', ended_at: T0 + 40 * 60_000 });

		const usb = sqlite.prepare(`SELECT kind, ended_at FROM play_session WHERE rb_history_id = 'H2'`).get() as Record<string, unknown>;
		expect(usb).toMatchObject({ kind: 'set', ended_at: null });

		const livePlay = sqlite.prepare(`SELECT played_at, track_no, track_id, source FROM play_event WHERE rb_song_history_id = 'H1-s2'`).get() as Record<string, unknown>;
		expect(livePlay).toMatchObject({ played_at: T0 + 20 * 60_000, track_no: 2, source: 'rekordbox' });

		const usbPlay = sqlite.prepare(`SELECT played_at, track_no, track_id FROM play_event WHERE rb_song_history_id = 'H2-s1'`).get() as Record<string, unknown>;
		expect(usbPlay).toMatchObject({ played_at: null, track_no: 1, track_id: 't1' });

		// Session date parsed from the NAME, at local midnight of that day.
		const started = (sqlite.prepare(`SELECT started_at AS s FROM play_session WHERE rb_history_id = 'H2'`).get() as { s: number }).s;
		expect(new Date(started).getFullYear()).toBe(2026);
		expect(new Date(started).getMonth()).toBe(7); // August (local)
		expect(new Date(started).getDate()).toBe(9);
	});

	it('is idempotent — re-importing the same sessions adds no rows', async () => {
		await runHistoryImport([liveSession(), bulkSession()]);
		await runHistoryImport([liveSession(), bulkSession()]);
		expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM play_session`).get()).toMatchObject({ n: 2 });
		expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM play_event`).get()).toMatchObject({ n: 7 });
	});

	it('runs on a scoped/targeted pull too — history is independent of content-id targeting', async () => {
		seedLinkedTrack('t1', 'C1');
		const seenScopes: string[][] = [];
		// A scoped sync-from (targetContentIds present) — the flow behind the
		// per-track / per-playlist "Sync from Rekordbox" and the push pull phase.
		await runHistoryImport([liveSession()], {
			target: { rbContentIds: ['C1'], rbPlaylistIds: [] },
			seenScopes,
		});
		expect(seenScopes[0]).toContain('history');
		expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM play_session`).get()).toMatchObject({ n: 1 });
		expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM play_event`).get()).toMatchObject({ n: 3 });
	});

	it('a growing live session gains plays in the SAME session on re-import', async () => {
		await runHistoryImport([liveSession()]);
		const grown = liveSession();
		grown.plays.push({ rb_song_history_id: 'H1-s4', rb_content_id: 'C4', track_no: 4, created_at_ms: T0 + 60 * 60_000 });
		await runHistoryImport([grown]);

		expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM play_session`).get()).toMatchObject({ n: 1 });
		const rows = sqlite.prepare(`SELECT COUNT(DISTINCT session_id) AS s, COUNT(*) AS n FROM play_event`).get() as Record<string, unknown>;
		expect(rows).toMatchObject({ s: 1, n: 4 });
		const ended = sqlite.prepare(`SELECT ended_at AS e FROM play_session`).get() as { e: number };
		expect(ended.e).toBe(T0 + 60 * 60_000);
	});
});

describe('history import: user override + re-linking', () => {
	it('a user kind-override survives re-import (classifier would flip it back)', async () => {
		await runHistoryImport([bulkSession()]);
		sqlite.prepare(`UPDATE play_session SET kind = 'prep', kind_source = 'user' WHERE rb_history_id = 'H2'`).run();
		await runHistoryImport([bulkSession()]);
		const row = sqlite.prepare(`SELECT kind, kind_source FROM play_session WHERE rb_history_id = 'H2'`).get() as Record<string, unknown>;
		expect(row).toMatchObject({ kind: 'prep', kind_source: 'user' });
	});

	it('unmatched plays keep rbContentId and heal once the link appears', async () => {
		await runHistoryImport([liveSession()]);
		const before = sqlite.prepare(`SELECT track_id, rb_content_id FROM play_event WHERE rb_song_history_id = 'H1-s1'`).get() as Record<string, unknown>;
		expect(before).toMatchObject({ track_id: null, rb_content_id: 'C1' });

		// Track + link land later (e.g. the tracks pass of a subsequent sync).
		seedLinkedTrack('t1', 'C1');
		await runHistoryImport([liveSession()]);
		const after = sqlite.prepare(`SELECT track_id FROM play_event WHERE rb_song_history_id = 'H1-s1'`).get() as Record<string, unknown>;
		expect(after).toMatchObject({ track_id: 't1' });
	});
});
