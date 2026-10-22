// Compaction (sql/0009_library_base.sql): once an account's oldest kept
// snapshot is a week old, the ops it covers leave the log. The base moves
// up to that snapshot's seq (set_base_seq refuses anything above the oldest
// snapshot, so a device below the base can always bootstrap) and the rows
// at or below it are deleted in chunks of `limit`, each its own statement,
// far inside the API role's 30 s statement_timeout; the master-device
// setting ops stay (master.ts reads them from the log). All of it runs as
// the API's login role through SECURITY DEFINER functions, outside any user
// transaction, like the batch sweep.
//
// `compactUser` is the unit (the sweep, and the operator's `compact` CLI,
// which is how the existing account is rebased onto its master's published
// snapshot); `compactDueUsers` is the sweep server.ts runs daily.

import type { AuditWriter } from '../audit.js';
import { num, type Queryable } from '../db/db.js';
import type { Logger } from '../log.js';

export type CompactOptions = {
	// Rows deleted per compact_ops call.
	limit: number;
	// An account is due once its oldest kept snapshot is this old.
	minAgeMs: number;
};

export const DEFAULT_COMPACT_OPTIONS: CompactOptions = { limit: 5000, minAgeMs: 7 * 24 * 3600 * 1000 };

export type CompactResult = { userId: string; through: number; baseSeq: number; deleted: number; calls: number };

export async function setBaseSeq(db: Queryable, userId: string, through: number): Promise<number> {
	const [row] = await db.query<{ base: unknown }>('select curator.set_base_seq($1::uuid, $2::bigint)::float8 as base', [userId, String(through)]);
	return num(row!.base);
}

// One compact_ops call: rows deleted (0 when nothing is left below the base).
export async function compactOnce(db: Queryable, userId: string, limit: number): Promise<number> {
	const [row] = await db.query<{ n: unknown }>('select curator.compact_ops($1::uuid, $2::int)::float8 as n', [userId, String(limit)]);
	return num(row!.n);
}

// Raises the base to `through`, then deletes below it until nothing is left.
// `onProgress` is for the CLI's running count.
export async function compactUser(db: Queryable, userId: string, through: number, opts: Pick<CompactOptions, 'limit'> = DEFAULT_COMPACT_OPTIONS, onProgress?: (deleted: number) => void): Promise<CompactResult> {
	const baseSeq = await setBaseSeq(db, userId, through);
	let deleted = 0;
	let calls = 0;
	for (;;) {
		const n = await compactOnce(db, userId, opts.limit);
		calls++;
		if (n === 0) break;
		deleted += n;
		onProgress?.(deleted);
	}
	return { userId, through, baseSeq, deleted, calls };
}

export type CompactDeps = { db: Queryable; log: Logger; audit: AuditWriter | null; options?: CompactOptions };

// The sweep: every account users_due_for_compaction names, one at a time;
// one account's failure never stops the rest. Each compaction is logged and
// audited (`ops_compacted`), with no request id: nothing asked for it.
export async function compactDueUsers(deps: CompactDeps): Promise<CompactResult[]> {
	const opts = deps.options ?? DEFAULT_COMPACT_OPTIONS;
	const due = await deps.db.query<{ user_id: string; through: unknown }>(
		'select user_id::text as user_id, through::float8 as through from curator.users_due_for_compaction(make_interval(secs => $1::float8))',
		[String(opts.minAgeMs / 1000)],
	);
	const out: CompactResult[] = [];
	for (const { user_id, through } of due) {
		const started = Date.now();
		try {
			const r = await compactUser(deps.db, user_id, num(through), opts);
			out.push(r);
			deps.log.info('ops_compacted', { ...r, ms: Date.now() - started });
			deps.audit?.event({
				at: new Date().toISOString(),
				request_id: null,
				user_id,
				device_id: null,
				kind: 'ops_compacted',
				detail: { through: r.through, baseSeq: r.baseSeq, deleted: r.deleted },
			});
		} catch (e) {
			deps.log.error('compact_failed', { userId: user_id, through: num(through), error: e });
		}
	}
	return out;
}
