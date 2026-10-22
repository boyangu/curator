// The account's base (sql/0009_library_base.sql): the seq at or below which
// the log no longer holds the account's ops, because a published snapshot
// covers them and compaction deleted them (src/sync/compact.ts). Every head
// the API answers is greatest(max(seq), base): a log emptied by compaction
// (the rebase deletes every op below the base) must still report the
// account's head, or a push's maxSeq and a batch's fence would fall back to
// the few ops pushed since. A cursor below the base cannot replay and is
// sent to bootstrap (pull.ts); a bootstrap answers the base so the device
// knows where replay starts (bootstrap.ts).
//
// Read under RLS like everything else; the explicit user predicate is for
// the primary key, not for safety.

import { num, type Queryable } from '../db/db.js';
import { VISIBLE_THROUGH } from './visibility.js';

// The calling user's base as a scalar subquery: 0 for an account that was
// never compacted (no row).
export const BASE_SEQ = `(select coalesce(min(b.base_seq), 0) from curator.library_base b where b.user_id = (select auth.uid()))`;

export async function readBase(tx: Queryable): Promise<number> {
	const [row] = await tx.query<{ base: unknown }>(`select ${BASE_SEQ}::float8 as base`);
	return num(row!.base);
}

// The account's head: the highest seq the log holds, never below the base.
// 'visible' clamps the log to a committing batch's fence (visibility.ts);
// the base is never above a fence (it is at or below the oldest snapshot,
// and no snapshot is stored above a fence), so the clamp and the floor
// compose.
export async function headSeq(tx: Queryable, bound: 'all' | 'visible'): Promise<number> {
	const [row] = await tx.query<{ head: unknown }>(
		`select greatest(coalesce(max(seq), 0), ${BASE_SEQ})::float8 as head from curator.library_op
		where user_id = (select auth.uid())${bound === 'visible' ? ` and seq <= ${VISIBLE_THROUGH}` : ''}`,
	);
	return num(row!.head);
}

// The newest snapshot: what a bootstrap serves, what the far-behind hint
// names, and the master's state digest a device at that seq compares with.
export type NewestSnapshot = { seq: number; stateSha256: string; storage: string };

export async function newestSnapshot(tx: Queryable): Promise<NewestSnapshot | null> {
	const [row] = await tx.query<{ seq: unknown; state_sha256: string; storage: string }>(
		`select snapshot_seq::float8 as seq, state_sha256, storage::text as storage from curator.library_snapshot
		where user_id = (select auth.uid())
		order by snapshot_seq desc
		limit 1`,
	);
	return row ? { seq: num(row.seq), stateSha256: row.state_sha256, storage: row.storage } : null;
}

// An account with a base above 0 and no snapshot at all: nothing a device
// below the base could bootstrap from. set_base_seq refuses to create this
// and retention never deletes the last snapshot, so it is a server invariant
// violation, answered as an internal error and audited (router.ts), never
// papered over with the empty state (which would hand a device a library
// missing everything below the base).
export class BaseInvariantError extends Error {
	override readonly name = 'BaseInvariantError';
	constructor(
		readonly userId: string,
		readonly baseSeq: number,
	) {
		super(`account ${userId} has base ${baseSeq} and no snapshot`);
	}
}
