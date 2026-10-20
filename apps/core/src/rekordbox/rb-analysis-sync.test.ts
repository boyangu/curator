// Rekordbox grids, keys and phrases across two desktops (set-rb-analysis,
// 2026-10-20): device A imports from rekordbox through the REAL importer (a
// stub sidecar replaying synthetic frames), its outbox replays onto device B,
// and B's rekordbox slot must equal A's byte for byte — the columns and the
// track mirrors the importer writes. Re-imports of the same data emit
// nothing; a changed grid emits exactly that unit; a merge re-asserts the
// kept slot. Generated temp DBs only — never real data (CLAUDE.md).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { applyOps as reduceOps, createLibraryState, materialize } from '@curator/protocol';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { applyOps, INITIAL_PUSH_KEY } from '../sync-log/apply.js';
import { initialPush, rbBackfillAsync, rbBackfillPending } from '../sync-log/initial-push.js';
import { compareDumps, dumpLibrary, dumpView } from '../sync-log/dump.js';
import { readOutbox } from '../sync-log/outbox.js';
import { recordingIdForTrack } from '../sync-log/recording-id.js';
import { applyTrackMerge } from '../library/merge-tracks.js';
import { remintDeviceIdentity } from '../sync-log/remint.js';
import { RekordboxImporter, type RunImportOptions } from './importer.js';
import type { RekordboxSidecar } from './sidecar.js';

let dir: string;
let db: Db;
let a: Database.Database;
const handles: Database.Database[] = [];

type Frame = { event: string; row: Record<string, unknown> };

function stubSidecar(frames: Frame[]): RekordboxSidecar {
	const emitter = new EventEmitter();
	return Object.assign(emitter, {
		open: async () => ({ ok: true }),
		scan: async () => {
			for (const f of frames) emitter.emit('event', { event: f.event, frame: { row: f.row } });
			return { watermarks: {}, cancelled: false };
		},
		cancel: async () => { /* */ },
	}) as unknown as RekordboxSidecar;
}

async function runImport(frames: Frame[], on: Db = db, master = 'master.db'): Promise<void> {
	const opts: RunImportOptions = {
		mode: 'full',
		flags: { syncTracks: true, syncPlaylists: false, syncMyTags: false, syncCuesGridsPhrases: true, syncWaveformPeaks: false, syncHistory: false },
		dbPath: join(dir, master), // never opened — stub sidecar
		peaksDir: join(dir, 'peaks'),
	};
	await new RekordboxImporter(on, stubSidecar(frames)).runImport(opts);
}

const T0 = Date.parse('2026-08-14T10:00:00Z');
const file = (n: number): string => join(dir, `track${n}.mp3`).replace(/\\/g, '/');
const N = [1, 2, 3];

// Rekordbox-shaped beat times: whole ms, a downbeat every fourth beat.
function beats(n: number, bpm: number, count: number): { beatgrid_sec: number[]; downbeats_sec: number[] } {
	const b = Array.from({ length: count }, (_, k) => Math.round(87 + n * 10 + (k * 60_000) / bpm) / 1000);
	return { beatgrid_sec: b, downbeats_sec: b.filter((_, i) => i % 4 === 0) };
}

function frames(opts: { bpm1?: number; key2?: string } = {}): Frame[] {
	const out: Frame[] = [];
	for (const n of N) {
		out.push({
			event: 'track',
			row: {
				rb_content_id: `C${n}`, rb_local_usn: 10 + n, rb_local_deleted: false, rb_updated_at_ms: T0, rb_added_at_ms: T0 - 86_400_000,
				file_path: file(n), title: `Song ${n}`, artist: 'A', album: 'LP', genre: 'House', label: 'Lbl', bpm: 122 + n,
				key_camelot: n === 2 && opts.key2 ? opts.key2 : `${n + 4}A`, key_musical: null, color_label: null,
				rating: null, comment: null, play_count: null, last_played_at_ms: null, duration_sec: 300,
			},
		});
	}
	// Track 3 has a key but rekordbox never analysed a grid for it.
	for (const n of [1, 2]) {
		out.push({
			event: 'waveform',
			row: {
				rb_content_id: `C${n}`, peaks_lo_path: null, peaks_hi_path: null,
				...beats(n, n === 1 && opts.bpm1 ? opts.bpm1 : 124, 700),
				segments: n === 1 ? [
					{ startSec: 0.097, endSec: 31.1, label: 'Intro 1', source: 'rekordbox', rbKind: 1 },
					{ startSec: 31.1, endSec: 280, label: 'Up 1', source: 'rekordbox', rbKind: 2 },
					{ startSec: 280, endSec: 300, label: 'Outro 1', source: 'rekordbox', rbKind: 9, fillSec: 298.5 },
				] : null,
			},
		});
	}
	return out;
}

function seedA(n: number): void {
	a.prepare(`INSERT INTO track (id, title, artists, state, updated_at) VALUES (?, ?, '[{"name":"A"}]', 'unsorted', 1000)`).run(`t${n}`, `Song ${n}`);
	a.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path) VALUES (?, ?, 'local', ?, ?)`).run(`sl${n}`, `t${n}`, file(n), file(n));
}

// Device B: its own track rows for the same recordings (track ids are per
// device), a different tag-derived key, no rekordbox at all.
function replicaB(): Database.Database {
	const p = join(dir, 'b.db');
	migrate(p);
	const b = new Database(p);
	b.pragma('foreign_keys = ON');
	handles.push(b);
	for (const n of N) {
		b.prepare(`INSERT INTO track (id, recording_id, title, artists, state, key_camelot) VALUES (?, ?, ?, '[{"name":"A"}]', 'unsorted', '1B')`).run(`b${n}`, recordingIdForTrack(`t${n}`), `Song ${n}`);
	}
	return b;
}

type Slot = { rb_beatgrid: Buffer | null; rb_downbeats: Buffer | null; rb_key_camelot: string | null; rb_segments_json: string | null };
const slotOf = (raw: Database.Database, trackId: string): Slot | undefined =>
	raw.prepare(`SELECT rb_beatgrid, rb_downbeats, rb_key_camelot, rb_segments_json FROM track_analysis WHERE track_id = ?`).get(trackId) as Slot | undefined;
const rbOps = (): Array<{ entity_id: string; unit: string }> =>
	(a.prepare(`SELECT entity_id, payload FROM sync_outbox WHERE kind = 'set-rb-analysis' ORDER BY seq_local`).all() as Array<{ entity_id: string; payload: string }>)
		.map((o) => ({ entity_id: o.entity_id, unit: JSON.parse(o.payload).unit as string }));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-rbsync-'));
	const p = join(dir, 'a.db');
	migrate(p);
	({ db, sqlite: a } = createDb(p));
	for (const n of N) seedA(n);
});

afterEach(() => {
	a.close();
	for (const h of handles.splice(0)) h.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

describe('rekordbox analysis units across two desktops', () => {
	it('device B ends with A\'s rekordbox slot, byte for byte, and the importer\'s track mirrors', async () => {
		await runImport(frames());
		// grid + key + phrases for 1, grid + key for 2, key only for 3.
		expect(rbOps().map((o) => o.unit).sort()).toEqual(['grid', 'grid', 'key', 'key', 'key', 'segments']);

		const b = replicaB();
		applyOps(b, readOutbox(a));
		for (const n of N) {
			const sa = slotOf(a, `t${n}`)!;
			const sb = slotOf(b, `b${n}`)!;
			expect(sb.rb_key_camelot).toBe(`${n + 4}A`);
			expect(sb.rb_key_camelot).toBe(sa.rb_key_camelot);
			if (n === 3) { expect(sb.rb_beatgrid).toBeNull(); continue; }
			expect(sb.rb_beatgrid!.equals(sa.rb_beatgrid!)).toBe(true);
			expect(sb.rb_downbeats!.equals(sa.rb_downbeats!)).toBe(true);
			expect(JSON.parse(sb.rb_segments_json ?? 'null')).toEqual(JSON.parse(sa.rb_segments_json ?? 'null'));
		}
		// The importer's mirrors: rb's key onto track.key_camelot, intro/outro.
		const tb = b.prepare(`SELECT id, key_camelot, intro_length_sec, outro_length_sec FROM track ORDER BY id`).all() as Array<{ id: string; key_camelot: string; intro_length_sec: number | null; outro_length_sec: number | null }>;
		const ta = a.prepare(`SELECT key_camelot, intro_length_sec, outro_length_sec FROM track ORDER BY id`).all();
		expect(tb.map(({ id: _id, ...r }) => r)).toEqual(ta);

		// Table by table, and against the reducer's view of the same ops.
		const ops = readOutbox(a);
		expect(compareDumps(dumpLibrary(a), dumpLibrary(b)).filter((r) => !r.equal)).toEqual([]);
		const view = dumpView(materialize(reduceOps(createLibraryState(), ops).state));
		expect(compareDumps(view, dumpLibrary(b)).find((r) => r.table === 'rbAnalysis')!.equal).toBe(true);
		expect(dumpLibrary(b).rbAnalysis).toHaveLength(3);

		// Re-applying the batch (a retried pull) changes nothing.
		const before = JSON.stringify(dumpLibrary(b));
		applyOps(b, ops);
		expect(JSON.stringify(dumpLibrary(b))).toBe(before);
	});

	it('an unchanged re-import emits nothing; a changed grid or key emits exactly that unit', async () => {
		await runImport(frames());
		const first = rbOps().length;
		await runImport(frames());
		expect(rbOps().length).toBe(first);

		await runImport(frames({ bpm1: 126, key2: '12B' }));
		const added = rbOps().slice(first);
		expect(added).toEqual(expect.arrayContaining([
			{ entity_id: recordingIdForTrack('t1'), unit: 'grid' },
			{ entity_id: recordingIdForTrack('t2'), unit: 'key' },
		]));
		expect(added).toHaveLength(2);

		// …and B follows the change.
		const b = replicaB();
		applyOps(b, readOutbox(a));
		expect(slotOf(b, 'b1')!.rb_beatgrid!.equals(slotOf(a, 't1')!.rb_beatgrid!)).toBe(true);
		expect(slotOf(b, 'b2')!.rb_key_camelot).toBe('12B');
	});

	it('the key-only placeholder survives a re-migrate (the legacy rb move must not clear it)', async () => {
		await runImport(frames());
		a.close();
		migrate(join(dir, 'a.db'));
		({ db, sqlite: a } = createDb(join(dir, 'a.db')));
		expect(slotOf(a, 't3')!.rb_key_camelot).toBe('7A');
		expect(JSON.parse(slotOf(a, 't1')!.rb_segments_json!)).toHaveLength(3);
	});

	it('a merge re-asserts the kept slot, so a replica that saw the loser\'s units first agrees', async () => {
		await runImport(frames());
		const b = replicaB();
		applyOps(b, readOutbox(a));
		const seen = readOutbox(a).length;

		// Merge t2 (grid + key) into t3 (key only): the desktop grafts t2's
		// slot onto t3, the op log states t3's final slot at the merge clock.
		// (Two rekordbox-linked rows refuse to merge; unlink the keeper.)
		a.prepare(`DELETE FROM rekordbox_link WHERE track_id = 't3'`).run();
		applyTrackMerge(db, a, 't3', 't2');
		const tail = readOutbox(a).slice(seen);
		expect(tail.filter((o) => o.kind === 'set-rb-analysis').map((o) => (o.payload as { unit: string }).unit).sort()).toEqual(['grid', 'key', 'segments']);
		applyOps(b, tail);
		const sa = slotOf(a, 't3')!;
		const winner = (b.prepare(`SELECT id FROM track WHERE recording_id = ? AND deleted_at IS NULL`).get(recordingIdForTrack('t3')) as { id: string }).id;
		const sb = slotOf(b, winner)!;
		expect(sb.rb_beatgrid!.equals(sa.rb_beatgrid!)).toBe(true);
		expect(sb.rb_key_camelot).toBe(sa.rb_key_camelot);
		expect(compareDumps(dumpLibrary(a), dumpLibrary(b)).find((r) => r.table === 'rbAnalysis')!.equal).toBe(true);
	});

	it('a library pushed before the units existed states them once (backfill); a fresh initial push needs none', async () => {
		// Slot rows written before set-rb-analysis was emitted, and an
		// initial push that already ran without them.
		const f32 = (xs: number[]): Buffer => Buffer.from(new Float32Array(xs).buffer);
		const b1 = beats(1, 124, 500).beatgrid_sec;
		a.prepare(`INSERT INTO track_analysis (track_id, analyzer_version, analyzed_at, rb_beatgrid, rb_downbeats, rb_key_camelot) VALUES ('t1', 'rekordbox', 5, ?, ?, '6A')`).run(f32(b1), f32(b1.filter((_, i) => i % 4 === 0)));
		a.prepare(`INSERT OR IGNORE INTO app_setting (key, value, updated_at) VALUES (?, '1', 1)`).run(INITIAL_PUSH_KEY); // (an empty-born library already has it)
		expect(rbBackfillPending(a)).toBe(true);
		const r = await rbBackfillAsync(a, { chunk: 1 });
		expect(r.byEntity).toEqual({ library_track: 2 });
		expect(rbBackfillPending(a)).toBe(false);
		// Run again by hand: everything is recorded, nothing is restated.
		expect((await rbBackfillAsync(a)).ops).toBe(0);

		const b = replicaB();
		applyOps(b, readOutbox(a));
		expect(slotOf(b, 'b1')!.rb_beatgrid!.equals(slotOf(a, 't1')!.rb_beatgrid!)).toBe(true);

		// A library whose initial push includes the units is not backfilled.
		const p = join(dir, 'fresh.db');
		migrate(p);
		const fresh = new Database(p);
		handles.push(fresh);
		initialPush(fresh);
		expect(rbBackfillPending(fresh)).toBe(false);
	});

	// Workstream E: both desktops have their own rekordbox, and the two
	// libraries disagree on track 1's grid and track 2's key. Each device's
	// importer keeps a baseline of what ITS rekordbox said, so a re-import
	// that finds rekordbox unchanged leaves the synced value alone: the last
	// change wins, not the last import.
	it('two rekordbox libraries that disagree converge instead of flipping on every re-import', async () => {
		// B: a copy of A's library (same tracks, links and recordings) with
		// its own identity, before either has imported.
		const bPath = join(dir, 'b-own.db');
		a.prepare(`VACUUM INTO ?`).run(bPath);
		const { db: bDb, sqlite: b } = createDb(bPath);
		handles.push(b);
		remintDeviceIdentity(b, 'copied-for-test');
		const opsOf = (raw: Database.Database) => readOutbox(raw).filter((o) => o.kind === 'set-rb-analysis');
		const shipped = new Map<Database.Database, number>([[a, 0], [b, 0]]);
		// Everything `from` emitted since the last exchange, applied on `to`.
		const exchange = (from: Database.Database, to: Database.Database): void => {
			const all = readOutbox(from);
			applyOps(to, all.slice(shipped.get(from)));
			shipped.set(from, all.length);
		};
		const gridOf = (raw: Database.Database) => slotOf(raw, 't1')!.rb_beatgrid!;
		const framesB = frames({ bpm1: 126, key2: '12B' });

		await runImport(frames());
		exchange(a, b);
		await runImport(framesB, bDb, 'master-b.db');
		// B's first reading of its rekordbox is a change: it differs from what A stated.
		expect(opsOf(b).map((o) => (o.payload as { unit: string }).unit).sort()).toEqual(['grid', 'key']);
		exchange(b, a);
		expect(gridOf(a).equals(gridOf(b))).toBe(true);
		expect(slotOf(a, 't2')!.rb_key_camelot).toBe('12B');

		// Full re-imports on both: neither rekordbox changed, nothing flips.
		const aOps = opsOf(a).length;
		const bOps = opsOf(b).length;
		for (let round = 0; round < 2; round++) {
			await runImport(frames());
			await runImport(framesB, bDb, 'master-b.db');
			exchange(a, b);
			exchange(b, a);
		}
		expect(opsOf(a)).toHaveLength(aOps);
		expect(opsOf(b)).toHaveLength(bOps);
		expect(gridOf(a).equals(gridOf(b))).toBe(true);
		expect(slotOf(a, 't2')!.rb_key_camelot).toBe('12B');
		expect(a.prepare(`SELECT key_camelot FROM track WHERE id = 't2'`).pluck().get()).toBe('12B');
		expect(compareDumps(dumpLibrary(a), dumpLibrary(b)).find((r) => r.table === 'rbAnalysis')!.equal).toBe(true);

		// A's rekordbox re-analyses track 1: that is a change, and it wins on B
		// too, through B's next re-import of its own (unchanged) grid.
		await runImport(frames({ bpm1: 128 }));
		expect(opsOf(a)).toHaveLength(aOps + 1);
		exchange(a, b);
		await runImport(framesB, bDb, 'master-b.db');
		expect(opsOf(b)).toHaveLength(bOps);
		expect(gridOf(b).equals(gridOf(a))).toBe(true);
		expect(compareDumps(dumpLibrary(a), dumpLibrary(b)).find((r) => r.table === 'rbAnalysis')!.equal).toBe(true);
		expect(b.prepare(`SELECT count(*) FROM rekordbox_unit_seen`).pluck().get()).toBeGreaterThan(0);
	});
});
