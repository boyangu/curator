// sync.pull (design: "Server API", "Far-behind devices"). Ops after the
// cursor in seq order. By default the caller's own are included (the device
// skips them by `op_id` and learns their seq); with 'pull_skip_own' it names
// itself and the seq through which it holds its own ops, and those stay
// here. Read under RLS like everything else; the explicit
// `user_id = auth.uid()` is there for the (user_id, seq) index, not for
// safety.

import { MAX_PULL_OPS, SYNC_FEATURES, type PullInput, type PullResult, type StoredOp } from '@curator/protocol';
import { num, type Db, type Queryable } from '../db/db.js';
import { withUserTx, type UserTx } from '../db/user-tx.js';

export type PullCall = PullInput;

// The result plus what only the access log wants: the own ops the skip left
// out. Never sent to the client.
export type PullOutcome = { result: PullResult; skippedOwn: number };

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

// The skip, as the page query and the far-behind count both apply it.
type SkipOwn = { deviceId: string; throughSeq: number };

// The extra predicate that leaves out the caller's own ops at or below the
// seq it vouches for; `$n` / `$m` are the skip's parameters.
function skipPredicate(skip: SkipOwn | null, n: number, m: number): string {
	return skip ? `and not (device_id = $${n} and seq <= $${m}::bigint)` : '';
}

// Whether a device at `afterSeq` should bootstrap from the snapshot at
// `snapshotSeq` rather than replay. Only meaningful when that snapshot is
// ahead of the cursor; with no snapshot there is nothing better to offer.
// The gap counts only what the device would replay: a first sign-in's own
// 128k ops, skipped, are no reason to download the whole library again.
async function farBehind(tx: UserTx, afterSeq: number, snapshotSeq: number, skip: SkipOwn | null, opts: PullOptions): Promise<boolean> {
	// Bounded count: stop at the threshold rather than count a 200k-op log.
	const [gap] = await tx.query<{ n: unknown }>(
		`select count(*)::float8 as n from (
			select 1 from curator.library_op
			where user_id = (select auth.uid()) and seq > $1::bigint and seq <= $2::bigint ${skipPredicate(skip, 4, 5)}
			limit $3::bigint
		) x`,
		[String(afterSeq), String(snapshotSeq), String(opts.farBehindOps + 1), ...(skip ? [skip.deviceId, String(skip.throughSeq)] : [])],
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

type SkipPageRow = { [K in keyof OpRow]: OpRow[K] | null } & { next_seq: unknown; in_range: unknown };

// One page with the caller's vouched-for own ops left out, and how far its
// cursor may move.
//
// Seq visibility — why `next_seq` may run past the last op returned without
// ever stepping over an op the caller has not seen:
//   - push.ts takes seqs only inside its INSERT, after the per-user advisory
//     lock, and Postgres releases that lock after the commit is visible. The
//     seq identity has the default CACHE 1, so nextval rises across sessions.
//     So for one user, seq order is commit order: every seq an open push
//     holds or will take is above every seq already committed, and any
//     snapshot sees a seq-prefix of the user's log (its gaps are other users'
//     rows or rolled-back pushes, never filled later).
//   - A full page stops at its last returned op, as before; the own ops it
//     stepped over lie below that op.
//   - A short page means the scan reached the end of what this snapshot sees,
//     so the cursor may move to the user's head, the highest committed seq:
//     by the prefix property nothing can commit at or below it later. That
//     needs the head read in the SAME snapshot as the page. Under READ
//     COMMITTED each statement takes its own, and a head read by a second
//     statement could include a push that committed in between, whose ops
//     this page never saw. Hence one statement.
//   - Never the sequence's position or a push's `maxSeq` / `batchMaxSeq`:
//     those can name seqs that are not committed, or not yet visible here.
// `in_range` counts the rows the cursor moves over (the index answers it);
// minus the ops returned, that is the own ops skipped, for the access log.
async function selectPageSkippingOwn(tx: Queryable, afterSeq: number, limit: number, skip: SkipOwn): Promise<{ ops: StoredOp[]; nextSeq: number; skippedOwn: number }> {
	const rows = await tx.query<SkipPageRow>(
		`with page as (
			select ${OP_COLUMNS} from curator.library_op
			where user_id = (select auth.uid()) and seq > $1::bigint ${skipPredicate(skip, 3, 4)}
			order by seq
			limit $2::int
		), bound as (
			select case
				when (select count(*) from page) >= $2::int then (select max(seq) from page)::bigint
				else greatest($1::bigint, (select coalesce(max(seq), 0) from curator.library_op where user_id = (select auth.uid())))
			end as next_seq
		), moved as (
			select count(*)::float8 as n from curator.library_op
			where user_id = (select auth.uid()) and seq > $1::bigint and seq <= (select next_seq from bound)
		)
		select page.*, bound.next_seq::float8 as next_seq, moved.n as in_range
		from bound cross join moved left join page on true
		order by page.seq`,
		[String(afterSeq), String(limit), skip.deviceId, String(skip.throughSeq)],
	);
	const first = rows[0]!;
	const ops = rows.filter((r) => r.op_id !== null).map((r) => toStoredOp(r as OpRow));
	return { ops, nextSeq: num(first.next_seq), skippedOwn: num(first.in_range) - ops.length };
}

export async function pull(db: Db, userId: string, call: PullCall, opts: PullOptions = DEFAULT_PULL_OPTIONS): Promise<PullOutcome> {
	const limit = Math.min(call.limit ?? MAX_PULL_OPS, MAX_PULL_OPS);
	// Security: the device id only narrows what the caller receives from its
	// own rows. Every statement here is already confined to this user by RLS,
	// so a wrong or forged id can at most hide some of the caller's own ops
	// from the caller. No authorization depends on it, which is also why it
	// need not name a registered device.
	const skip: SkipOwn | null =
		call.deviceId !== undefined && call.ownThroughSeq !== undefined ? { deviceId: call.deviceId, throughSeq: call.ownThroughSeq } : null;
	return withUserTx(db, userId, async (tx) => {
		let result: PullResult;
		let skippedOwn = 0;
		if (skip) {
			const page = await selectPageSkippingOwn(tx, call.afterSeq, limit, skip);
			result = { ops: page.ops, nextSeq: page.nextSeq };
			skippedOwn = page.skippedOwn;
		} else {
			const ops = await selectOpsAfter(tx, call.afterSeq, limit);
			result = { ops, nextSeq: ops.length > 0 ? ops[ops.length - 1]!.seq : call.afterSeq };
		}
		const snapshotSeq = await latestSnapshotSeq(tx);
		if (snapshotSeq !== null && call.afterSeq < snapshotSeq && (await farBehind(tx, call.afterSeq, snapshotSeq, skip, opts))) {
			result.snapshotSeq = snapshotSeq;
		}
		result.features = [...SYNC_FEATURES];
		return { result, skippedOwn };
	});
}
