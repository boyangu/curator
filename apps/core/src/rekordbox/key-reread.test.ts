// The one-time rekordbox key re-read (importer.ts rereadRbKeys): the rb slot's
// key unit on a library linked before the slot existed held a seed from
// track.key_camelot or nothing, and the USN-gated pull never re-read it. The
// first whole-library pull that reads tracks re-reads every linked row once,
// regardless of USN, and states each key that differs as the 'key' unit.
// Real importer, migrated temp DB, stub sidecar — never real data.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { KEY_REREAD_SETTING, RekordboxImporter, type RunImportOptions } from './importer.js';
import type { RekordboxSidecar, ScanParams } from './sidecar.js';
import { recordingIdForTrack } from '../sync-log/recording-id.js';

let dir: string;
let db: Db;
let sqlite: Database.Database;

type Row = Record<string, unknown>;

// Every scan's arguments, and what it streams: the incremental pull streams
// `changed` (USN-gated: usually nothing), a targeted read streams every
// requested row from `rekordbox`. Only open/scan/cancel exist — a write call
// would throw.
function stubSidecar(rekordbox: Row[], changed: Row[] = [], opts: { cancelTargeted?: boolean } = {}): { sidecar: RekordboxSidecar; scans: ScanParams[] } {
	const emitter = new EventEmitter();
	const scans: ScanParams[] = [];
	const sidecar = Object.assign(emitter, {
		open: async () => ({ ok: true }),
		scan: async (args: ScanParams) => {
			scans.push(args);
			const ids = args.targetContentIds ? new Set(args.targetContentIds) : null;
			const rows = ids ? rekordbox.filter((r) => ids.has(String(r['rb_content_id']))) : changed;
			for (const row of rows) emitter.emit('event', { event: 'track', frame: { row } });
			// A targeted read must never move the library-wide cursor.
			return { watermarks: ids ? { DjmdContent: 999 } : { DjmdContent: 50 }, cancelled: !!ids && !!opts.cancelTargeted };
		},
		cancel: async () => { /* */ },
	}) as unknown as RekordboxSidecar;
	return { sidecar, scans };
}

async function pull(sidecar: RekordboxSidecar, over: Partial<RunImportOptions> = {}): Promise<void> {
	await new RekordboxImporter(db, sidecar).runImport({
		mode: 'incremental',
		flags: { syncTracks: true, syncPlaylists: false, syncMyTags: false, syncCuesGridsPhrases: false, syncWaveformPeaks: false, syncHistory: false },
		dbPath: join(dir, 'master.db'), // never opened — stub sidecar
		peaksDir: join(dir, 'peaks'),
		...over,
	});
}

const file = (n: number): string => `c:/music/${n}.flac`;
const rbRow = (n: number, key: string | null, over: Row = {}): Row => ({
	rb_content_id: `C${n}`, rb_local_usn: 10, rb_local_deleted: false,
	rb_updated_at_ms: 1_000, rb_added_at_ms: null, file_path: file(n),
	title: `Song ${n}`, artist: 'A', album: null, genre: null, label: null,
	bpm: 124, key_camelot: key, key_musical: null, color_label: null,
	rating: null, comment: null, play_count: null, last_played_at_ms: null, duration_sec: 300,
	...over,
});

// A linked track as an older build left it: rekordbox_link in place, the rb
// slot holding `slot` (a seed from track.key_camelot, or nothing).
function seedLinked(n: number, trackKey: string | null, slot: string | null): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state, key_camelot, updated_at) VALUES (?, ?, '[{"name":"A"}]', 'unsorted', ?, 0)`).run(`t${n}`, `Song ${n}`, trackKey);
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path) VALUES (?, ?, 'local', ?, ?)`).run(`sl${n}`, `t${n}`, file(n), file(n));
	sqlite.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, rb_file_path, imported_at, last_synced_at) VALUES (?, ?, 10, ?, 0, 0)`).run(`t${n}`, `C${n}`, file(n));
	if (slot != null) sqlite.prepare(`INSERT INTO track_analysis (track_id, analyzer_version, analyzed_at, rb_key_camelot) VALUES (?, 'rekordbox', 0, ?)`).run(`t${n}`, slot);
}

const slotKey = (n: number): string | null => (sqlite.prepare(`SELECT rb_key_camelot FROM track_analysis WHERE track_id = ?`).pluck().get(`t${n}`) as string | null | undefined) ?? null;
const trackKey = (n: number): string | null => sqlite.prepare(`SELECT key_camelot FROM track WHERE id = ?`).pluck().get(`t${n}`) as string | null;
const keyOps = (): Array<{ rec: string; value: unknown }> =>
	(sqlite.prepare(`SELECT entity_id, payload FROM sync_outbox WHERE kind = 'set-rb-analysis' ORDER BY seq_local`).all() as Array<{ entity_id: string; payload: string }>)
		.map((o) => ({ rec: o.entity_id, ...(JSON.parse(o.payload) as { unit: string; value: unknown }) }))
		.filter((o) => (o as unknown as { unit: string }).unit === 'key')
		.map(({ rec, value }) => ({ rec, value }));
const done = (): boolean => sqlite.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(KEY_REREAD_SETTING) != null;
const watermark = (): number | undefined => sqlite.prepare(`SELECT last_usn FROM rekordbox_sync_watermark WHERE table_name = 'DjmdContent'`).pluck().get() as number | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-rb-keyreread-'));
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

describe('one-time rekordbox key re-read', () => {
	it('re-reads every linked row past the USN gate and states only the keys that differ', async () => {
		seedLinked(1, '1B', '1B');   // seeded from a tag key; rekordbox says 8A → corrected
		seedLinked(2, '5A', null);   // never read; rekordbox says 5A → filled
		seedLinked(3, '6A', '6A');   // already rekordbox's key → no op
		seedLinked(4, '2A', '2A');   // rekordbox holds no key → left alone
		const rekordbox = [rbRow(1, '8A'), rbRow(2, null, { key_musical: 'A minor' }), rbRow(3, '6A'), rbRow(4, null)];
		const { sidecar, scans } = stubSidecar(rekordbox);
		await pull(sidecar);

		// The pull, then one targeted read of tracks only, at current state.
		expect(scans).toHaveLength(2);
		expect(scans[1]!.scopes).toEqual(['tracks']);
		expect(scans[1]!.watermarks).toEqual({});
		expect([...scans[1]!.targetContentIds!].sort()).toEqual(['C1', 'C2', 'C3', 'C4']);

		expect([slotKey(1), slotKey(2), slotKey(3), slotKey(4)]).toEqual(['8A', '8A', '6A', '2A']);
		// The track row carries rekordbox's key, as a device projecting the op does.
		expect(trackKey(1)).toBe('8A');
		expect(keyOps()).toEqual([
			{ rec: recordingIdForTrack('t1'), value: '8A' },
			{ rec: recordingIdForTrack('t2'), value: '8A' },
		]);
		expect(done()).toBe(true);
		// The incremental cursor is the pull's, never the targeted read's.
		expect(watermark()).toBe(50);
	});

	it('runs once', async () => {
		seedLinked(1, '1B', '1B');
		const first = stubSidecar([rbRow(1, '8A')]);
		await pull(first.sidecar);
		expect(first.scans).toHaveLength(2);

		sqlite.prepare(`UPDATE track_analysis SET rb_key_camelot = '1B' WHERE track_id = 't1'`).run();
		const second = stubSidecar([rbRow(1, '8A')]);
		await pull(second.sidecar);
		expect(second.scans).toHaveLength(1);
		expect(slotKey(1)).toBe('1B');
	});

	it('a scoped pull or a pull without tracks leaves it due', async () => {
		seedLinked(1, '1B', '1B');
		const scoped = stubSidecar([rbRow(1, '8A')]);
		await pull(scoped.sidecar, { target: { rbContentIds: ['C1'], rbPlaylistIds: [] } });
		expect(scoped.scans).toHaveLength(1);
		const noTracks = stubSidecar([rbRow(1, '8A')]);
		await pull(noTracks.sidecar, { flags: { syncTracks: false, syncPlaylists: true, syncMyTags: false, syncCuesGridsPhrases: false, syncWaveformPeaks: false, syncHistory: false } });
		expect(noTracks.scans).toHaveLength(1);
		expect(done()).toBe(false);
	});

	it('a cancelled re-read writes nothing and stays due', async () => {
		seedLinked(1, '1B', '1B');
		const { sidecar } = stubSidecar([rbRow(1, '8A')], [], { cancelTargeted: true });
		await pull(sidecar);
		expect(slotKey(1)).toBe('1B');
		expect(keyOps()).toEqual([]);
		expect(done()).toBe(false);
	});

	it('a device with no links, or a full read, has nothing stale: marked done without a re-read', async () => {
		const none = stubSidecar([]);
		await pull(none.sidecar);
		expect(none.scans).toHaveLength(1);
		expect(done()).toBe(true);

		sqlite.prepare(`DELETE FROM app_setting WHERE key = ?`).run(KEY_REREAD_SETTING);
		seedLinked(1, '1B', '1B');
		const full = stubSidecar([rbRow(1, '8A')], [rbRow(1, '8A')]);
		await pull(full.sidecar, { mode: 'full' });
		expect(full.scans).toHaveLength(1);
		// The full read's own track pass landed rekordbox's key.
		expect(slotKey(1)).toBe('8A');
		expect(done()).toBe(true);
	});
});
