// One-time statements of what protocol v4 can carry and older ops never did
// (the 2026-10-21 zero-loss audit), run by the sync client once the server
// first reads v4 (features.ts). Each has its own gate key, so an interrupted
// run resumes and a later build adding one runs only that one. Every one
// states this device's OWN data only — never a remote row's, never what it
// took from the account — and skips what the records already hold, so a
// caught-up device emits nothing.
//
//   cue origins       a rekordbox-origin cue whose record has no origin
//                     (every cue stated before v4) is restated as upsert2.
//   play references   a play whose row holds its rekordbox content id or
//                     source track id that the record lacks: append2.
//   rb tempo / key    the rb slot's bpm and key strength (set-rb-analysis
//   strength          v4 units), at the link's last import like the rest of
//                     the rekordbox backfill.
//
// The first two restate a record that exists, so they need a fresh clock (a
// historical stamp would lose to the record's own); they restate the
// RECORD's body (not the row's) plus the missing field, so a newer value
// another device stated is never undone by a stale local row. The rb units
// have no cell yet and keep the historical stamp.

import type Database from 'better-sqlite3';
import { cueEntityId, type Cell, type CueBody, type NewOp, type PlayEventBody } from '@curator/protocol';
import { emitOps, type EmitOp } from './outbox.js';
import { rbUnitOp, rbUnitValue, recordingResolver, RB_UNITS_V4 } from './rows.js';
import type { RbSlotRow } from '../rekordbox/rb-slot.js';

type Raw = Database.Database;

export const CUE_ORIGIN_BACKFILL_KEY = 'sync.backfill.cue_origin_v4_at';
export const PLAY_REFS_BACKFILL_KEY = 'sync.backfill.play_refs_v4_at';
export const RB_UNITS_V4_BACKFILL_KEY = 'sync.backfill.rb_units_v4_at';

const pending = (raw: Raw, key: string): boolean => raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(key) === undefined;
const done = (raw: Raw, key: string): void => {
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(key, JSON.stringify(Date.now()), Date.now());
};

export function v4BackfillsPending(raw: Raw): boolean {
	return [CUE_ORIGIN_BACKFILL_KEY, PLAY_REFS_BACKFILL_KEY, RB_UNITS_V4_BACKFILL_KEY].some((k) => pending(raw, k));
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export type BackfillRun = { rows: number; emitted: number; chunks: number; maxSliceMs: number };

// Pages of `page` source rows by rowid, one transaction each (reads + the
// ops), a yield between; the key is set by a run that finished. Every op is
// labelled 'backfill': the sync client uploads the lot as one server batch
// (outbox.ts BATCH_LABELS).
async function paged<R extends { rid: number }>(raw: Raw, key: string, select: Database.Statement, page: number, build: (rows: R[]) => EmitOp[]): Promise<BackfillRun> {
	const out: BackfillRun = { rows: 0, emitted: 0, chunks: 0, maxSliceMs: 0 };
	if (!pending(raw, key)) return out;
	for (let after = 0; ;) {
		const t0 = performance.now();
		const rows = select.all(after, page) as R[];
		if (rows.length === 0) break;
		after = rows[rows.length - 1]!.rid;
		raw.transaction(() => {
			const ops = build(rows);
			if (ops.length > 0) out.emitted += emitOps(raw, ops, { batchLabel: 'backfill' }).length;
		})();
		out.rows += rows.length;
		out.chunks++;
		out.maxSliceMs = Math.max(out.maxSliceMs, performance.now() - t0);
		await yieldToLoop();
	}
	done(raw, key);
	return out;
}

function recordValue<T>(raw: Raw, map: string, key: string): T | null {
	const json = raw.prepare(`SELECT value FROM sync_state WHERE map = ? AND key = ?`).pluck().get(map, key) as string | undefined;
	if (!json) return null;
	try { return JSON.parse(json) as T; } catch { return null; }
}

export async function backfillCueOriginsAsync(raw: Raw, opts: { page?: number } = {}): Promise<BackfillRun> {
	// Own catalogue rows only (a remote row's cues came from the log).
	// `+t.…`: cue-driven (its rowid range, then each cue's track by key);
	// SQLite otherwise walks every catalogue row through the derived-copy
	// index on each page.
	const select = raw.prepare(`SELECT c.rowid AS rid, c.track_id, c.slot, c.kind, c.position_sec, c.length_sec, c.color, c.name FROM cue c
		JOIN track t ON t.id = c.track_id
		WHERE c.rowid > ? AND c.origin = 'rekordbox' AND c.slot >= 0 AND +t.remote_only = 0 AND +t.derived_from_track_id IS NULL
		ORDER BY c.rowid LIMIT ?`);
	const aliased = raw.prepare(`SELECT 1 FROM recording_alias WHERE loser = ?`).pluck();
	return paged<{ rid: number; track_id: string; slot: number; kind: 'hot' | 'memory'; position_sec: number; length_sec: number | null; color: string | null; name: string | null }>(raw, CUE_ORIGIN_BACKFILL_KEY, select, opts.page ?? 400, (rows) => {
		const rec = recordingResolver(raw, rows.map((r) => r.track_id));
		const ops: EmitOp[] = [];
		for (const c of rows) {
			const r = rec(c.track_id);
			if (!r || aliased.get(r) !== undefined) continue;
			const key = `${r}:${c.slot}:${c.kind}`;
			const record = recordValue<{ cell: Cell<CueBody> }>(raw, 'cues', key);
			if (!record || record.cell.value.origin !== undefined) continue;
			const b = record.cell.value;
			// The record is the account's cue; this device's row only says where
			// it came from. A row that differs is not this cue any more.
			if (b.position_sec !== c.position_sec || (b.length_sec ?? null) !== (c.length_sec ?? null) || (b.color ?? null) !== (c.color ?? null) || (b.name ?? null) !== (c.name ?? null)) continue;
			ops.push({ entity: 'cue', entity_id: cueEntityId(r, c.slot, c.kind), kind: 'upsert2', payload: { slot: c.slot, kind: c.kind, position_sec: b.position_sec, length_sec: b.length_sec, color: b.color, name: b.name, origin: 'rekordbox' } });
		}
		return ops;
	});
}

export async function backfillPlayRefsAsync(raw: Raw, opts: { page?: number } = {}): Promise<BackfillRun> {
	const select = raw.prepare(`SELECT rowid AS rid, id, rb_content_id, source_track_id FROM play_event
		WHERE rowid > ? AND (rb_content_id IS NOT NULL OR source_track_id IS NOT NULL) ORDER BY rowid LIMIT ?`);
	return paged<{ rid: number; id: string; rb_content_id: string | null; source_track_id: string | null }>(raw, PLAY_REFS_BACKFILL_KEY, select, opts.page ?? 500, (rows) => {
		const ops: EmitOp[] = [];
		for (const e of rows) {
			const record = recordValue<Cell<PlayEventBody>>(raw, 'playEvents', e.id);
			if (!record) continue;
			const v = record.value;
			if (v.rb_content_id !== undefined || v.source_track_id !== undefined) continue;
			const rbContent = e.rb_content_id ? String(e.rb_content_id).slice(0, 64) : null;
			const sourceTrack = e.source_track_id ? String(e.source_track_id).slice(0, 2048) : null;
			const { rb_content_id: _a, source_track_id: _b, ...body } = v;
			ops.push({ entity: 'play_event', entity_id: e.id, kind: 'append2', payload: { ...body, rb_content_id: rbContent, source_track_id: sourceTrack } } as NewOp);
		}
		return ops;
	});
}

export async function backfillRbUnitsV4Async(raw: Raw, opts: { page?: number } = {}): Promise<BackfillRun> {
	const select = raw.prepare(`SELECT ta.rowid AS rid, ta.track_id, ta.rb_bpm, ta.rb_key_strength, COALESCE(rl.last_synced_at, ta.analyzed_at) AS at
		FROM track_analysis ta JOIN track t ON t.id = ta.track_id LEFT JOIN rekordbox_link rl ON rl.track_id = ta.track_id
		WHERE ta.rowid > ? AND +t.derived_from_track_id IS NULL AND +t.remote_only = 0 AND (ta.rb_bpm IS NOT NULL OR ta.rb_key_strength IS NOT NULL)
		ORDER BY ta.rowid LIMIT ?`);
	const aliased = raw.prepare(`SELECT 1 FROM recording_alias WHERE loser = ?`).pluck();
	// 100 a page: the two columns sit behind the row's grid blobs, so each
	// read walks overflow pages (~0.3 ms a row on the real library).
	return paged<{ rid: number; track_id: string; rb_bpm: number | null; rb_key_strength: number | null; at: number | null }>(raw, RB_UNITS_V4_BACKFILL_KEY, select, opts.page ?? 100, (rows) => {
		const rec = recordingResolver(raw, rows.map((r) => r.track_id));
		const ops: EmitOp[] = [];
		for (const r of rows) {
			const recording = rec(r.track_id);
			if (!recording || aliased.get(recording) !== undefined) continue;
			const record = recordValue<{ fields?: Record<string, unknown> }>(raw, 'libraryTracks', recording);
			const slot = { rb_bpm: r.rb_bpm, rb_key_strength: r.rb_key_strength } as RbSlotRow;
			for (const unit of RB_UNITS_V4) {
				if (record?.fields?.[`rb.${unit}`] !== undefined) continue;
				const value = rbUnitValue(slot, unit);
				if (value === null) continue;
				const op = rbUnitOp(recording, unit, value);
				if (op) ops.push({ ...op, client_ts: Math.max(0, Math.round(r.at ?? 0)) });
			}
		}
		return ops;
	});
}
