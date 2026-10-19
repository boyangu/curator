// Rekordbox create phase (Convert to WAV) — runs the REAL exporter against a
// migrated temp DB with a stub sidecar. Pins:
//   - only a derived ("[WAV]") playlist triggers creation; members without a
//     rekordbox_link but with a local file become content_create ops, a WAV
//     copy carrying its original's rb id as the analysis source;
//   - a still-local playlist gets playlist_create, then is re-keyed to the
//     importer's `rb_<ID>` shape with its members;
//   - created rows are linked "never pushed" and the update push that follows
//     adds every member in Curator order (empty baseline);
//   - rekordbox running → refused before any backup or write.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { memberOrder } from '../test-support/playlist-track.js';
import { createDb, type Db } from '../db/client.js';
import { normalizePath } from '../local/scanner.js';
import { RekordboxExporter } from './exporter.js';
import type { CreateOp, RekordboxSidecar, WriteOp, WriteOpResult } from './sidecar.js';

let dir: string;
let dbPath: string;
let db: Db;
let sqlite: Database.Database;

function stubSidecar(opts: { running?: boolean } = {}) {
	const batches: Array<Array<WriteOp | CreateOp>> = [];
	const verified: unknown[][] = [];
	let backups = 0;
	let nextId = 9000;
	const sidecar = {
		detect: async () => ({ dbPath, running: opts.running ?? false }),
		backup: async () => { backups++; return { path: `backup-${backups}.db`, sizeBytes: 1, takenAtMs: 1 }; },
		openForWrite: async () => ({ ok: true, path: dbPath }),
		applyWriteBatch: async (ops: Array<WriteOp | CreateOp>) => {
			batches.push(ops);
			return {
				results: ops.map((op): WriteOpResult => {
					if (op.kind === 'content_create') {
						return { kind: op.kind, curator_track_id: op.curator_track_id, rb_content_id: String(nextId++), created: true, anlz_copied: op.source_rb_content_id != null, folder_path: op.path.replace(/^c:/, 'C:') };
					}
					if (op.kind === 'playlist_create') return { kind: op.kind, curator_playlist_id: op.curator_playlist_id, rb_playlist_id: '777', created: true };
					return { kind: op.kind, changed: true };
				}),
			};
		},
		commitAndClose: async (ids: string[]) => ({ baselines: Object.fromEntries(ids.map((id) => [id, 1_700_000_000_000])) }),
		verify: async (_p: string, _k: unknown, ops: unknown[]) => { verified.push(ops); return { ok: true, pragma_error: null, failures: [] }; },
		listStaleRelations: async () => ({ stale: [] }),
	} as unknown as RekordboxSidecar;
	return { sidecar, batches, verified, backups: () => backups };
}

function seed(): void {
	const file = (name: string): string => {
		const p = join(dir, name);
		writeFileSync(p, 'x');
		return normalizePath(p);
	};
	sqlite.prepare(`INSERT INTO track (id, title, artists, state, rating, color_label) VALUES ('flac', 'Song', '[{"name":"A"}]', 'unsorted', 5, 'red')`).run();
	sqlite.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at) VALUES ('flac', '555', 1, 1, 1)`).run();
	sqlite.prepare(`INSERT INTO track (id, title, artists, state, derived_from_track_id, rating, cues_edited_at) VALUES ('wav', 'Song [WAV]', '[{"name":"A"}]', 'unsorted', 'flac', 5, 1)`).run();
	sqlite.prepare(`INSERT INTO cue (id, track_id, slot, position_sec, kind, origin) VALUES ('c1', 'wav', 0, 12.5, 'hot', 'curator')`).run();
	const wav = file('Song.wav');
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, file_format) VALUES ('l1', 'wav', 'local', ?, ?, 'wave')`).run(wav, wav);
	// An already-deck-playable original kept as-is, not in rekordbox yet.
	sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES ('mp3', 'Other', '[{"name":"B"}]', 'unsorted')`).run();
	const mp3 = file('Other.mp3');
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, file_format) VALUES ('l2', 'mp3', 'local', ?, ?, 'mpeg')`).run(mp3, mp3);
	// Streaming-only member — can't be created.
	sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES ('stream', 'Stream', '[]', 'unsorted')`).run();
	sqlite.prepare(`INSERT INTO playlist (id, source, source_id, name, sync_status, derived_from_playlist_id) VALUES ('pl', 'local', 'pl', 'Set [WAV]', 'synced', 'src')`).run();
	['wav', 'mp3', 'stream'].forEach((t, i) => sqlite.prepare(`INSERT INTO playlist_track (id, order_key, playlist_id, track_id, position, source_track_id) VALUES (?, ?, 'pl', ?, ?, ?)`).run(...memberOrder(i), t, i, t));
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-rbcreate-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
	seed();
});
afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const FLAGS = { syncMetadata: true, syncCues: true, syncTags: true, syncPlaylist: true };

describe('rekordbox create phase', () => {
	it('creates unlinked members + the playlist, links them, re-keys, then pushes', async () => {
		const stub = stubSidecar();
		const result = await new RekordboxExporter(db, stub.sidecar).runExport({ targetKind: 'playlist', targetIds: ['pl'], flags: FLAGS, dbPath });

		// Phase 1: one content_create per creatable member + playlist_create.
		const create = stub.batches[0]!;
		expect(create.map((o) => o.kind)).toEqual(['content_create', 'content_create', 'playlist_create']);
		const [cWav, cMp3] = create as Array<Extract<CreateOp, { kind: 'content_create' }>>;
		expect(cWav).toMatchObject({ curator_track_id: 'wav', source_rb_content_id: '555', meta: { Title: 'Song [WAV]', Rating: 5 } });
		expect(cMp3).toMatchObject({ curator_track_id: 'mp3', source_rb_content_id: null });

		// Curator side: links (never pushed until phase 2 verifies) + re-key.
		expect(result.created).toMatchObject({ tracksCreated: 2, playlistCreated: true, anlzCopied: 1, anlzMissing: 1, rekeyedPlaylistId: 'rb_777' });
		const pl = sqlite.prepare(`SELECT id, source, source_id, name, derived_from_playlist_id FROM playlist WHERE derived_from_playlist_id = 'src'`).all();
		expect(pl).toEqual([{ id: 'rb_777', source: 'rekordbox', source_id: '777', name: 'Set [WAV]', derived_from_playlist_id: 'src' }]);
		const members = sqlite.prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = 'rb_777' ORDER BY position`).all();
		expect(members).toEqual([{ track_id: 'wav' }, { track_id: 'mp3' }, { track_id: 'stream' }]);

		// Phase 2: the normal push against the re-keyed playlist — metadata,
		// the copy's cues, and every linked member added in Curator order.
		const update = stub.batches[1]!;
		expect(update.filter((o) => o.kind === 'cues')).toEqual([{ kind: 'cues', rb_content_id: '9000', cues: [{ slot: 0, kind: 'hot', position_sec: 12.5, length_sec: null, color: null, name: null }] }]);
		const merge = update.find((o) => o.kind === 'playlist_merge') as Extract<WriteOp, { kind: 'playlist_merge' }>;
		expect(merge).toMatchObject({ rb_playlist_id: '777', remove: [], add: [{ rb_content_id: '9000', position: 1 }, { rb_content_id: '9001', position: 2 }] });
		expect(stub.backups()).toBe(1);
		expect(result.verifyOk).toBe(true);

		// Baselines advanced by the verified push.
		const link = sqlite.prepare(`SELECT rb_content_id, pushed_at, cues_seen FROM rekordbox_link WHERE track_id = 'wav'`).get() as Record<string, unknown>;
		expect(link.rb_content_id).toBe('9000');
		expect(link.pushed_at).not.toBeNull();
		expect(link.cues_seen).not.toBeNull();
	});

	it('verifies created rows with their new ids', async () => {
		const stub = stubSidecar();
		await new RekordboxExporter(db, stub.sidecar).runExport({ targetKind: 'playlist', targetIds: ['pl'], flags: FLAGS, dbPath });
		expect(stub.verified[0]).toEqual([
			{ kind: 'content_create', rb_content_id: '9000', path: expect.stringMatching(/Song\.wav$/), anlz_copied: true },
			{ kind: 'content_create', rb_content_id: '9001', path: expect.stringMatching(/Other\.mp3$/), anlz_copied: false },
			{ kind: 'playlist_create', rb_playlist_id: '777', name: 'Set [WAV]' },
		]);
	});

	it('does nothing extra for an ordinary playlist', async () => {
		sqlite.prepare(`UPDATE playlist SET derived_from_playlist_id = NULL WHERE id = 'pl'`).run();
		const stub = stubSidecar();
		const result = await new RekordboxExporter(db, stub.sidecar).runExport({ targetKind: 'playlist', targetIds: ['pl'], flags: FLAGS, dbPath });
		expect(result.created).toBeNull();
		expect(stub.batches.flat().some((o) => o.kind === 'content_create' || o.kind === 'playlist_create')).toBe(false);
	});

	it('refuses while rekordbox is running, before any backup or write', async () => {
		const stub = stubSidecar({ running: true });
		await expect(new RekordboxExporter(db, stub.sidecar).runExport({ targetKind: 'playlist', targetIds: ['pl'], flags: FLAGS, dbPath })).rejects.toThrow(/Close rekordbox/);
		expect(stub.backups()).toBe(0);
		expect(stub.batches).toEqual([]);
		expect(sqlite.prepare(`SELECT COUNT(*) n FROM rekordbox_link`).get()).toEqual({ n: 1 });
	});
});

describe('Add to Rekordbox (tracks target, createMissing)', () => {
	it('creates only the selected tracks rekordbox lacks, links them, then pushes', async () => {
		const stub = stubSidecar();
		// 'flac' is already linked; 'wav' and 'mp3' have local files; 'stream' has none.
		const result = await new RekordboxExporter(db, stub.sidecar).runExport({
			targetKind: 'tracks', targetIds: ['flac', 'wav', 'mp3', 'stream'], flags: { ...FLAGS, syncPlaylist: false, createMissing: true }, dbPath,
		});
		const create = stub.batches[0]!;
		expect(create.map((o) => (o as Extract<CreateOp, { kind: 'content_create' }>).curator_track_id)).toEqual(['wav', 'mp3']);
		expect(create.some((o) => o.kind === 'playlist_create')).toBe(false);
		expect(result.created).toMatchObject({ tracksCreated: 2, playlistCreated: false, rekeyedPlaylistId: null });
		// The playlist is untouched — this path never re-keys or creates one.
		expect(sqlite.prepare(`SELECT id, source FROM playlist WHERE id = 'pl'`).get()).toEqual({ id: 'pl', source: 'local' });
		// Phase 2 pushes the linked selection (cues for the WAV copy included).
		const update = stub.batches[1]!;
		expect(update.some((o) => o.kind === 'cues' && o.rb_content_id === '9000')).toBe(true);
		expect(update.filter((o) => o.kind === 'track').map((o) => (o as Extract<WriteOp, { kind: 'track' }>).rb_content_id).sort()).toEqual(['555', '9000', '9001']);
		expect(result.tracksSkippedNotLinked).toBe(1); // 'stream'
	});

	it('stays update-only without the flag', async () => {
		const stub = stubSidecar();
		const result = await new RekordboxExporter(db, stub.sidecar).runExport({
			targetKind: 'tracks', targetIds: ['wav', 'mp3'], flags: { ...FLAGS, syncPlaylist: false }, dbPath,
		});
		expect(result.created).toBeNull();
		expect(stub.batches.flat().some((o) => o.kind === 'content_create')).toBe(false);
	});
});
