// Ops from a newer protocol version, held aside (design: `sync_inbox_held`;
// cloud plan: streaming identity §5). A pull used to stop at the first op it
// could not read and wait for an update, so one desktop writing a new kind
// froze every older one: nothing after that seq applied, not even the kinds
// they read. Now the pull sets such an op aside here, applies everything
// else and moves the cursor on; the held ops replay, in seq order, the
// first time a build that reads them pulls.
//
// Applying a held op later than the ops after it is safe because apply is
// order-independent (every reducer rule is a max over clocks; replay.test.ts):
// the outcome is the one the op would have had in its place. What is lost
// meanwhile is only the op's own effect, which this build could not show.

import type Database from 'better-sqlite3';
import { OpValidationError, SCHEMA_VERSION, type Op, type StoredOp } from '@curator/protocol';
import { applyOps, type ApplyOutcome } from './apply.js';

type Raw = Database.Database;

// The stored op minus the server's fields (applyOps parses the wire op).
function wire(o: StoredOp): Op {
	const { seq: _seq, user_id: _user, received_at: _recv, ...op } = o;
	return op as Op;
}

// Inside the caller's (pull page) transaction. A re-pulled page holds the
// same seqs again: ignored.
export function holdOps(raw: Raw, ops: readonly StoredOp[]): number {
	if (ops.length === 0) return 0;
	const ins = raw.prepare(`INSERT INTO sync_inbox_held (seq, op_id, schema_version, op, held_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(seq) DO NOTHING`);
	let n = 0;
	const now = Date.now();
	for (const o of ops) n += ins.run(o.seq, o.op_id, o.schema_version, JSON.stringify(wire(o)), now).changes;
	return n;
}

export function heldCount(raw: Raw): number {
	return raw.prepare(`SELECT count(*) FROM sync_inbox_held`).pluck().get() as number;
}

export type ReplayOutcome = { applied: number; remaining: number; outcome: ApplyOutcome | null; error: string | null };

// Apply every held op this build reads (schema_version ≤ `current`), oldest
// first, in one transaction with their removal from the hold. An op this
// build should read but cannot parse stays held and is reported, never
// dropped. `current` is a seam for tests standing in for an updated build.
export function replayHeldOps(raw: Raw, current = SCHEMA_VERSION): ReplayOutcome {
	const rows = raw.prepare(`SELECT seq, op FROM sync_inbox_held WHERE schema_version <= ? ORDER BY seq`).all(current) as Array<{ seq: number; op: string }>;
	if (rows.length === 0) return { applied: 0, remaining: heldCount(raw), outcome: null, error: null };
	try {
		const outcome = raw.transaction(() => {
			const o = applyOps(raw, rows.map((r) => JSON.parse(r.op) as unknown));
			const del = raw.prepare(`DELETE FROM sync_inbox_held WHERE seq = ?`);
			for (const r of rows) del.run(r.seq);
			return o;
		})();
		return { applied: rows.length, remaining: heldCount(raw), outcome, error: null };
	} catch (err) {
		if (!(err instanceof OpValidationError)) throw err;
		return { applied: 0, remaining: heldCount(raw), outcome: null, error: err.message };
	}
}
