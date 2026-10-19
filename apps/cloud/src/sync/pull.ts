// sync.pull (design: "Server API", "Far-behind devices"). Ops after the
// cursor in seq order, the caller's own included (the device skips them by
// `op_id` and learns their seq). Read under RLS like everything else; the
// explicit `user_id = auth.uid()` is there for the (user_id, seq) index, not
// for safety.

import { MAX_PULL_OPS, type PullResult, type StoredOp } from '@curator/protocol';
import { num, type Db, type Queryable } from '../db/db.js';
import { withUserTx, type UserTx } from '../db/user-tx.js';

export type PullCall = { afterSeq: number; limit?: number };

export type PullOptions = {
	// A cursor more than this many ops behind the latest snapshot is told to
	// bootstrap instead of replaying (design: 50k).
	farBehindOps: number;
	// ...or one whose op is older than this. 90 days is the client's
	// tombstone compaction window: past it, a replay could resurrect what a
	// compacted tombstone used to suppress.
	farBehindMs: number;
};

export const DEFAULT_PULL_OPTIONS: PullOptions = { farBehindOps: 50_000, farBehindMs: 90 * 24 * 3600 * 1000 };

type OpRow = {
	seq: unknown;
	user_id: string;
	op_id: string;
	device_id: string;
	client_ts: unknown;
	schema_version: unknown;
	entity: string;
	entity_id: string;
	kind: string;
	payload: string;
	received_at: unknown;
};

// Shared with the snapshot fold. jsonb is read as text and parsed here so
// both drivers hand back the same thing.
export const OP_COLUMNS = `seq::float8 as seq, user_id::text as user_id, op_id::text as op_id, device_id,
	client_ts::float8 as client_ts, schema_version, entity, entity_id, kind, payload::text as payload,
	floor(extract(epoch from received_at) * 1000)::float8 as received_at`;

export function toStoredOp(r: OpRow): StoredOp {
	return {
		seq: num(r.seq),
		user_id: r.user_id,
		op_id: r.op_id,
		device_id: r.device_id,
		client_ts: num(r.client_ts),
		schema_version: num(r.schema_version),
		entity: r.entity,
		entity_id: r.entity_id,
		kind: r.kind,
		payload: JSON.parse(r.payload) as unknown,
		received_at: num(r.received_at),
		// Validated by `parseOp` on the way in; the union cannot be re-proven
		// from a row without re-parsing every op on every pull.
	} as StoredOp;
}

export async function selectOpsAfter(tx: Queryable, afterSeq: number, limit: number): Promise<StoredOp[]> {
	const rows = await tx.query<OpRow>(
		`select ${OP_COLUMNS} from curator.library_op
		where user_id = (select auth.uid()) and seq > $1::bigint
		order by seq
		limit $2::int`,
		[String(afterSeq), String(limit)],
	);
	return rows.map(toStoredOp);
}

export async function latestSnapshotSeq(tx: Queryable): Promise<number | null> {
	const [row] = await tx.query<{ seq: unknown }>(
		`select snapshot_seq::float8 as seq from curator.library_snapshot
		where user_id = (select auth.uid())
		order by snapshot_seq desc
		limit 1`,
	);
	return row ? num(row.seq) : null;
}

// Whether a device at `afterSeq` should bootstrap from the snapshot at
// `snapshotSeq` rather than replay. Only meaningful when that snapshot is
// ahead of the cursor; with no snapshot there is nothing better to offer.
async function farBehind(tx: UserTx, afterSeq: number, snapshotSeq: number, opts: PullOptions): Promise<boolean> {
	// Bounded count: stop at the threshold rather than count a 200k-op log.
	const [gap] = await tx.query<{ n: unknown }>(
		`select count(*)::float8 as n from (
			select 1 from curator.library_op
			where user_id = (select auth.uid()) and seq > $1::bigint and seq <= $2::bigint
			limit $3::bigint
		) x`,
		[String(afterSeq), String(snapshotSeq), String(opts.farBehindOps + 1)],
	);
	if (num(gap!.n) > opts.farBehindOps) return true;
	const [cursor] = await tx.query<{ at: unknown }>(
		`select floor(extract(epoch from received_at) * 1000)::float8 as at from curator.library_op
		where user_id = (select auth.uid()) and seq <= $1::bigint
		order by seq desc
		limit 1`,
		[String(afterSeq)],
	);
	return cursor !== undefined && tx.nowMs - num(cursor.at) > opts.farBehindMs;
}

export async function pull(db: Db, userId: string, call: PullCall, opts: PullOptions = DEFAULT_PULL_OPTIONS): Promise<PullResult> {
	const limit = Math.min(call.limit ?? MAX_PULL_OPS, MAX_PULL_OPS);
	return withUserTx(db, userId, async (tx) => {
		const ops = await selectOpsAfter(tx, call.afterSeq, limit);
		const result: PullResult = { ops, nextSeq: ops.length > 0 ? ops[ops.length - 1]!.seq : call.afterSeq };
		const snapshotSeq = await latestSnapshotSeq(tx);
		if (snapshotSeq !== null && call.afterSeq < snapshotSeq && (await farBehind(tx, call.afterSeq, snapshotSeq, opts))) {
			result.snapshotSeq = snapshotSeq;
		}
		return result;
	});
}
