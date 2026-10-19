// The snapshot job (design: "Bootstrap, snapshots and history retention").
// Folds the ops after a user's latest snapshot onto it with the protocol's
// own reducer and stores the result, so a new device downloads one body and
// pulls only what came after it. Ops are never deleted; a snapshot is only a
// cache of the log and can always be rebuilt from it.
//
// `buildSnapshot` is the unit (one user, run as that user under RLS like a
// request); `runDueSnapshots` is the sweep the server runs on a timer and
// the CLI runs on demand. Both are safe to run concurrently on several
// machines: a per-user try-lock makes the second runner skip, and the
// (user, seq) primary key makes a duplicate insert a no-op.

import { applyOps, createLibraryState, type Op } from '@curator/protocol';
import { num, type Db } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import type { Logger } from '../log.js';
import { selectOpsAfter } from '../sync/pull.js';
import { decodeSnapshotBase64, encodeSnapshot } from './codec.js';

export type SnapshotOptions = {
	// Ops folded per query; bounds memory per round trip, not in total (the
	// whole state is in memory while it is built).
	pageSize: number;
	// Snapshots kept per user after a build; older ones are pruned.
	keep: number;
};

export const DEFAULT_SNAPSHOT_OPTIONS: SnapshotOptions = { pageSize: 5000, keep: 3 };

export type SnapshotBuild =
	| { userId: string; status: 'built'; snapshotSeq: number; fromSeq: number; opsFolded: number; bytes: number }
	| { userId: string; status: 'up_to_date'; snapshotSeq: number }
	| { userId: string; status: 'locked' };

// Base64 without the line breaks Postgres' encoder inserts every 76 chars.
export const BODY_BASE64 = `translate(encode(body, 'base64'), chr(10), '')`;

export async function buildSnapshot(db: Db, userId: string, opts: SnapshotOptions = DEFAULT_SNAPSHOT_OPTIONS): Promise<SnapshotBuild> {
	return withUserTx(db, userId, async (tx) => {
		const [lock] = await tx.query<{ ok: boolean }>(
			`select pg_try_advisory_xact_lock(hashtextextended('library_snapshot:' || (select auth.uid())::text, 0)) as ok`,
		);
		if (!lock?.ok) return { userId, status: 'locked' };

		const [latest] = await tx.query<{ seq: unknown; body: string }>(
			`select snapshot_seq::float8 as seq, ${BODY_BASE64} as body from curator.library_snapshot
			where user_id = (select auth.uid())
			order by snapshot_seq desc
			limit 1`,
		);
		const fromSeq = latest ? num(latest.seq) : 0;
		const state = latest ? await decodeSnapshotBase64(latest.body) : createLibraryState();

		// Seq order equals commit order per user (the push lock), so paging by
		// seq under READ COMMITTED never skips an op that commits mid-fold: a
		// later commit can only carry a higher seq.
		let seq = fromSeq;
		let folded = 0;
		for (;;) {
			const page = await selectOpsAfter(tx, seq, opts.pageSize);
			if (page.length === 0) break;
			applyOps(state, page as Op[]);
			folded += page.length;
			seq = page[page.length - 1]!.seq;
			if (page.length < opts.pageSize) break;
		}
		if (folded === 0) return { userId, status: 'up_to_date', snapshotSeq: fromSeq };

		const body = await encodeSnapshot(state);
		await tx.query(
			`insert into curator.library_snapshot (snapshot_seq, body) values ($1::bigint, decode($2, 'base64'))
			on conflict (user_id, snapshot_seq) do nothing`,
			[String(seq), body.toString('base64')],
		);
		await tx.query(
			`delete from curator.library_snapshot
			where user_id = (select auth.uid())
				and snapshot_seq < (
					select snapshot_seq from curator.library_snapshot
					where user_id = (select auth.uid())
					order by snapshot_seq desc
					offset $1::int limit 1
				)`,
			[String(Math.max(0, opts.keep - 1))],
		);
		return { userId, status: 'built', snapshotSeq: seq, fromSeq, opsFolded: folded, bytes: body.length };
	});
}

export type DueOptions = SnapshotOptions & {
	// Design: a snapshot every 10k ops or 24 h, whichever comes first.
	minOps: number;
	maxAgeMs: number;
};

export const DEFAULT_DUE_OPTIONS: DueOptions = { ...DEFAULT_SNAPSHOT_OPTIONS, minOps: 10_000, maxAgeMs: 24 * 3600 * 1000 };

// The user list comes from a SECURITY DEFINER function the login role may
// call (sql/0001_init.sql, sql/roles.sql): the one cross-user read, ids only.
// Each fold then runs as its user. Users run one at a time so a sweep never
// holds more than one library in memory.
export async function runDueSnapshots(db: Db, log: Logger, opts: DueOptions = DEFAULT_DUE_OPTIONS): Promise<SnapshotBuild[]> {
	const due = await db.query<{ user_id: string }>(
		`select user_id::text as user_id from curator.users_due_for_snapshot($1::bigint, make_interval(secs => $2::float8))`,
		[String(opts.minOps), String(opts.maxAgeMs / 1000)],
	);
	const out: SnapshotBuild[] = [];
	for (const { user_id } of due) {
		const started = Date.now();
		try {
			const r = await buildSnapshot(db, user_id, opts);
			out.push(r);
			log.info('snapshot', { ...r, ms: Date.now() - started });
		} catch (e) {
			// One user's failure must not stop the sweep for the rest.
			log.error('snapshot_failed', { userId: user_id, error: e });
		}
	}
	return out;
}
