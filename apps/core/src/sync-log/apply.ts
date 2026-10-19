// applyOps: ops from elsewhere (another device's push, a replay) onto the
// local tables (cloud design: "Inbox apply"). One transaction per batch:
// validate, skip this device's own ops, fold each op into the reducer
// records by the protocol's merge rules (store.ts — the same `applyOp` the
// server materialises with, merges first as in its batch entry point), then
// project the touched records into the visible tables (project.ts).
//
// Nothing here emits: the ops already exist, and re-emitting would echo them
// back to the server as new edits. The local writes this performs are the
// `origin: 'remote'` side of the mutators — the same visible-table shapes,
// without the outbox.
//
// Apply is idempotent (every record write is a max over clocks) and
// order-independent (the reducer's guarantee, which replay.test.ts checks
// holds for the SQLite projection too).

import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { applyOp, parseCueEntityId, parseOp, parseTrackTagEntityId, type EntityRef, type Op } from '@curator/protocol';
import * as schema from '@curator/shared/schema';
import { artistCreditRewritePending, drainArtistCreditRewrites } from '../library/artist-alias.js';
import { applyTrackMerge } from '../library/merge-tracks.js';
import { project, type ProjectSummary } from './project.js';
import { SyncStateStore } from './store.js';

type Raw = Database.Database;

// Set by the initial push (initial-push.ts) once every pre-existing row has a
// record. Before that the records are partial: a container the op log never
// saw a create for counts as invisible to the reducer, so applying a remote
// edit to it would hide the user's own playlist. applyOps refuses until then
// unless the library holds nothing the records could be missing.
export const INITIAL_PUSH_KEY = 'sync.initial_push_at';

export class SyncRecordsIncompleteError extends Error {
	override readonly name = 'SyncRecordsIncompleteError';
	constructor() {
		super('this library has rows the op log has not recorded yet; run the initial push before applying remote ops');
	}
}

export function recordsComplete(raw: Raw): boolean {
	if (raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(INITIAL_PUSH_KEY)) return true;
	const any = (sql: string): boolean => raw.prepare(sql).get() !== undefined;
	return !any(`SELECT 1 FROM playlist LIMIT 1`)
		&& !any(`SELECT 1 FROM playlist_folder LIMIT 1`)
		&& !any(`SELECT 1 FROM track_tag LIMIT 1`)
		&& !any(`SELECT 1 FROM cue LIMIT 1`)
		&& !any(`SELECT 1 FROM pinned_search LIMIT 1`)
		&& !any(`SELECT 1 FROM tag WHERE kind != 'system' LIMIT 1`);
}

export function markRecordsComplete(raw: Raw): void {
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`)
		.run(INITIAL_PUSH_KEY, JSON.stringify(Date.now()), Date.now());
}

// Up to this many track rows, an artist alias rule's credit rewrite runs
// inside the apply transaction; a larger library's runs in the sync
// client's yielding drain (library/artist-alias.ts). One drain chunk's
// worth: measured 2026-10-18 at ~35-95 ms per 1,000 rows (idle vs a loaded
// test run).
export const INLINE_ARTIST_REWRITE_ROWS = 1_000;

export type ApplyOutcome = ProjectSummary & {
	applied: number;
	skippedOwn: number;
	// Own ops the server stored with a different client_ts (it clamps a stamp
	// far in the future to its receive time, design scenario 9). Their local
	// records were re-stamped to the server's clock; see below.
	restamped: number;
	changed: EntityRef[];
};

// The refs an op addresses, under the current alias map — what projection
// must look at after a re-stamp, which can flip a set row's visibility
// (a removal's tombstone moving below an add) without the reducer reporting
// a change.
function refsOf(state: SyncStateStore['state'], op: Op): EntityRef[] {
	const R = (id: string): string => state.recordingAlias.get(id) ?? id;
	switch (op.entity) {
		case 'track_tag': {
			const p = parseTrackTagEntityId(op.entity_id);
			return p ? [{ entity: 'track_tag', id: `${R(p.recordingId)}:${p.tagId}` }] : [];
		}
		case 'cue': {
			const p = parseCueEntityId(op.entity_id);
			return p ? [{ entity: 'cue', id: `${R(p.recordingId)}:${p.slot}:${p.kind}` }] : [];
		}
		case 'library_track':
			return [{ entity: 'library_track', id: R(op.entity_id) }];
		case 'playlist_track':
			if (op.kind === 'rekey') return Object.keys(op.payload.keys).map((id) => ({ entity: 'playlist_track' as const, id }));
			return [{ entity: 'playlist_track', id: op.entity_id }];
		default:
			return [{ entity: op.entity, id: op.entity_id }];
	}
}

export function applyOps(raw: Raw, input: readonly unknown[]): ApplyOutcome {
	// Validate before the transaction: a malformed op from the wire is the
	// sender's bug and must not leave a half-applied batch.
	const ops: Op[] = input.map((o) => parseOp(o));
	return raw.transaction((): ApplyOutcome => {
		if (!recordsComplete(raw)) throw new SyncRecordsIncompleteError();
		// Own ops come back on a pull unless the server left them out (the
		// own-op skip); they are already applied, so skip them — unless the
		// server stored a different client_ts. Then this device holds the
		// op's effect under a clock no other device has, and would keep
		// beating (or losing to) the wrong writes: re-stamp its records to the
		// server's clock, then apply it like any remote op. The push path
		// feeds a clamped op through here too, with the stamp the push result
		// named (client.ts pushOnce).
		const ownStmt = raw.prepare(`SELECT client_ts FROM sync_outbox WHERE op_id = ?`);
		const restampStmt = raw.prepare(`UPDATE sync_outbox SET client_ts = ? WHERE op_id = ?`);
		const incoming: Op[] = [];
		const restamped: Op[] = [];
		for (const o of ops) {
			const own = ownStmt.get(o.op_id) as { client_ts: number } | undefined;
			if (!own) incoming.push(o);
			else if (own.client_ts !== o.client_ts) restamped.push(o);
		}
		const store = new SyncStateStore(raw);
		const ordered = [...incoming.filter((o) => o.entity === 'recording'), ...incoming.filter((o) => o.entity !== 'recording')];
		const changed: EntityRef[] = [];
		const seen = new Set<string>();
		store.prefetch([...restamped, ...ordered]);
		for (const op of restamped) {
			store.touch(op);
			store.restampClock(op.op_id, op.device_id, op.client_ts);
			applyOp(store.state, op);
			for (const r of refsOf(store.state, op)) {
				const k = `${r.entity}:${r.id}`;
				if (seen.has(k)) continue;
				seen.add(k);
				changed.push(r);
			}
			restampStmt.run(op.client_ts, op.op_id);
		}
		for (const op of ordered) {
			store.touch(op);
			for (const r of applyOp(store.state, op).changed) {
				const k = `${r.entity}:${r.id}`;
				if (seen.has(k)) continue;
				seen.add(k);
				changed.push(r);
			}
		}
		const flushed = store.flush();
		const db = drizzle(raw, { schema });
		const summary = project(raw, store, changed, flushed, {
			// Both recordings have a row here: the desktop's own merge moves
			// links, analysis and history onto the winner, with emission off —
			// the merge op being applied is the record of it.
			mergeRows: (loser, winner) => { applyTrackMerge(db, raw, winner, loser, { emit: false }); },
			containersCreated: new Set(incoming.filter((o) => o.kind === 'create' || o.kind === 'delete').map((o) => `${o.entity}:${o.entity_id}`)),
		});
		// Everything visible here now came through the op log, so the
		// records are complete from here on (a fresh replica's first batch).
		markRecordsComplete(raw);
		// A small library's alias rewrite completes with the batch. A larger
		// one is left whole to the caller's yielding drain, so rules arriving
		// over several pages coalesce into one scan.
		if (artistCreditRewritePending(raw) && (raw.prepare(`SELECT count(*) FROM track`).pluck().get() as number) <= INLINE_ARTIST_REWRITE_ROWS) {
			const drained = drainArtistCreditRewrites(raw);
			if (drained.tracks.length > 0) summary.tracksTouched = [...new Set([...summary.tracksTouched, ...drained.tracks])];
		}
		return { ...summary, applied: incoming.length, skippedOwn: ops.length - incoming.length - restamped.length, restamped: restamped.length, changed };
	})();
}
