// The snapshot job (design: "Bootstrap, snapshots and history retention").
// Folds the ops after a user's latest snapshot onto it with the protocol's
// own reducer and stores the result, so a new device downloads one body and
// pulls only what came after it. Ops are never deleted; a snapshot is only a
// cache of the log and can always be rebuilt from it.
//
// `buildSnapshot` is the unit (one user, run as that user under RLS like a
// request); `runDueSnapshots` is the sweep the server runs on a timer and
// the CLI runs on demand.
//
// A build is several short transactions, not one: read the base snapshot and
// the head, fold the ops in pages, gzip with no transaction open, store. The
// main library's body is 37 MB gzipped (227 MB of JSON, 2026-10-21); held in
// one transaction, the encode alone left it idle long enough to risk the
// 60 s idle-in-transaction timeout and held back vacuum on the busiest table
// the whole time. A lease row (curator.library_snapshot_lease, 0007) keeps
// two runners (two machines, or the sweep and the CLI) from building the
// same user at once; the (user, seq) primary key makes a duplicate insert a
// no-op anyway.
//
// Bodies go in and out as bytea (db.ts): no base64 inside Postgres.
//
// Since 'snapshot_storage' (sql/0008) this is the fallback. The account's
// master publishes its own snapshot to Storage (src/sync/publish-snapshot.ts)
// and the sweep leaves an account alone while its newest snapshot is such a
// one younger than a week (users_due_for_snapshot_v3). A fold still runs for
// an account whose master never published or went quiet, and it always
// starts from the newest BODIED snapshot: this process cannot read a Storage
// one (no Storage key) and must never try to. The bodied snapshots it writes
// are also the only kind an older desktop can bootstrap from.

import { randomUUID } from 'node:crypto';
import { applyOps, createLibraryState, type LibraryState, type Op } from '@curator/protocol';
import { bytes, num, type Db } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import type { Logger } from '../log.js';
import { OP_COLUMNS, toStoredOp } from '../sync/pull.js';
import { SNAPSHOT_LOCK } from '../sync/publish-snapshot.js';
import { VISIBLE_THROUGH } from '../sync/visibility.js';
import { decodeSnapshot, encodeSnapshot } from './codec.js';

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
	// Another runner holds the user's snapshot lease.
	| { userId: string; status: 'locked' }
	// The user has an open or committing batch: it is about to add to the
	// log, so the build waits for the sweep after its commit.
	| { userId: string; status: 'batch_pending' };

// Longer than the slowest build measured (a 227 MB state, decode + fold +
// encode, well under a minute), so a live holder never loses it, short
// enough that a crashed one does not hold the user back for long.
const LEASE_SECONDS = 600;

async function claimLease(db: Db, userId: string, holder: string): Promise<boolean> {
	return withUserTx(db, userId, async (tx) => {
		const rows = await tx.query(
			`insert into curator.library_snapshot_lease (holder, until) values ($1, now() + make_interval(secs => $2::float8))
			on conflict (user_id) do update set holder = excluded.holder, until = excluded.until
			where curator.library_snapshot_lease.until < now() or curator.library_snapshot_lease.holder = excluded.holder
			returning 1 as ok`,
			[holder, String(LEASE_SECONDS)],
		);
		return rows.length > 0;
	});
}

async function releaseLease(db: Db, userId: string, holder: string): Promise<void> {
	await withUserTx(db, userId, (tx) => tx.query(`delete from curator.library_snapshot_lease where user_id = (select auth.uid()) and holder = $1`, [holder]));
}

// Folds the user's ops in (fromSeq, toSeq] onto `state` in pages, each its
// own short transaction. Every op at or below `toSeq` must already be
// committed (the caller read it as a head), so the pages see exactly those.
export async function foldRange(db: Db, userId: string, state: LibraryState, fromSeq: number, toSeq: number, pageSize: number): Promise<number> {
	let seq = fromSeq;
	let folded = 0;
	while (seq < toSeq) {
		const page = await withUserTx(db, userId, (tx) =>
			tx.query(
				`select ${OP_COLUMNS} from curator.library_op
				where user_id = (select auth.uid()) and seq > $1::bigint and seq <= $2::bigint
				order by seq
				limit $3::int`,
				[String(seq), String(toSeq), String(pageSize)],
			),
		);
		if (page.length === 0) break;
		const ops = page.map((r) => toStoredOp(r as Parameters<typeof toStoredOp>[0]));
		applyOps(state, ops as Op[]);
		folded += ops.length;
		seq = ops[ops.length - 1]!.seq;
	}
	return folded;
}

export async function buildSnapshot(db: Db, userId: string, opts: SnapshotOptions = DEFAULT_SNAPSHOT_OPTIONS): Promise<SnapshotBuild> {
	const holder = `job:${randomUUID()}`;
	if (!(await claimLease(db, userId, holder))) return { userId, status: 'locked' };
	try {
		// The base and the bound, in one transaction. The bound is the head the
		// fold stops at: seq order is commit order per user (the push lock),
		// so every op at or below it is already committed and the paged reads
		// below, each in its own transaction, see exactly those.
		//
		// The bound is clamped to a batch's fence in the same statement that
		// reads it. The batch check above it would mostly make that moot, but
		// under READ COMMITTED each statement has its own snapshot, so a commit
		// could fence and move a chunk between the two. With the clamp, every
		// snapshot is stored at or below whatever fence stands, and a fence
		// raised later sits at or above it (it goes up at the head): that is
		// why no reader has to bound snapshot seqs (visibility.ts).
		const start = await withUserTx(db, userId, async (tx) => {
			const [open] = await tx.query(`select 1 as x from curator.library_op_batch where user_id = (select auth.uid()) and status in ('open', 'committing') limit 1`);
			if (open) return null;
			// The base is the newest bodied snapshot; "up to date" is against
			// the newest of either kind (a published one at the head needs no
			// fold, and its seq could not hold a second row anyway).
			const [latest] = await tx.query<{ seq: unknown; body: unknown }>(
				`select snapshot_seq::float8 as seq, body from curator.library_snapshot
				where user_id = (select auth.uid()) and body is not null
				order by snapshot_seq desc
				limit 1`,
			);
			const [newest] = await tx.query<{ seq: unknown }>(
				`select coalesce(max(snapshot_seq), 0)::float8 as seq from curator.library_snapshot where user_id = (select auth.uid())`,
			);
			const [head] = await tx.query<{ head: unknown }>(
				`select coalesce(max(seq), 0)::float8 as head from curator.library_op
				where user_id = (select auth.uid()) and seq <= ${VISIBLE_THROUGH}`,
			);
			return { fromSeq: latest ? num(latest.seq) : 0, body: latest ? bytes(latest.body) : null, newestSeq: num(newest!.seq), head: num(head!.head) };
		});
		if (start === null) return { userId, status: 'batch_pending' };
		const { fromSeq, head } = start;
		if (head <= start.newestSeq) return { userId, status: 'up_to_date', snapshotSeq: start.newestSeq };
		const state = start.body ? await decodeSnapshot(start.body) : createLibraryState();
		const folded = await foldRange(db, userId, state, fromSeq, head, opts.pageSize);
		// `head` itself, not the last op folded: the seqs between belong to
		// other users or rolled-back pushes and are never filled later.
		const body = await encodeSnapshot(state);
		await withUserTx(db, userId, async (tx) => {
			await tx.query(SNAPSHOT_LOCK);
			await tx.query(
				`insert into curator.library_snapshot (snapshot_seq, body) values ($1::bigint, $2::bytea)
				on conflict (user_id, snapshot_seq) do nothing`,
				[String(head), body],
			);
			// publishSnapshot's retention (the newest `keep`, plus the newest
			// bodied one), applied to bodied rows only: a Storage row's parts
			// can be deleted only by a device, so only publishSnapshot, which
			// answers it with the paths it freed, prunes those.
			await tx.query(
				`with ranked as (
					select snapshot_seq, body is not null as bodied,
						row_number() over (order by snapshot_seq desc) as rn,
						row_number() over (partition by body is not null order by snapshot_seq desc) as kind_rn
					from curator.library_snapshot
					where user_id = (select auth.uid())
				)
				delete from curator.library_snapshot s
				using ranked r
				where s.user_id = (select auth.uid()) and s.snapshot_seq = r.snapshot_seq
					and r.bodied and r.rn > $1::int and r.kind_rn > 1`,
				[String(opts.keep)],
			);
		});
		return { userId, status: 'built', snapshotSeq: head, fromSeq, opsFolded: folded, bytes: body.length };
	} finally {
		await releaseLease(db, userId, holder).catch(() => {
			// Expires on its own; a failed release only delays the next build.
		});
	}
}

export type DueOptions = SnapshotOptions & {
	// Worth a new snapshot (design): 10k new ops, or a day-old one.
	minOps: number;
	maxAgeMs: number;
	// ...and due only once the log has been quiet this long, or the last
	// snapshot is older than `busyEveryMs` (a steady stream still gets one).
	// A backfill pushed plainly (a desktop from before 'batches') used to
	// trigger a full 37 MB rebuild every 15-minute sweep while it lasted.
	quietMs: number;
	busyEveryMs: number;
	// An account whose newest snapshot is master-published and younger than
	// this is not folded: its master keeps it current, and the fold is the
	// one step that holds a whole library in this process.
	masterFreshMs: number;
};

export const DEFAULT_DUE_OPTIONS: DueOptions = {
	...DEFAULT_SNAPSHOT_OPTIONS,
	minOps: 10_000,
	maxAgeMs: 24 * 3600 * 1000,
	quietMs: 5 * 60 * 1000,
	busyEveryMs: 3600 * 1000,
	masterFreshMs: 7 * 24 * 3600 * 1000,
};

// The user list comes from a SECURITY DEFINER function the login role may
// call (sql/0008's v3, sql/roles.sql): a cross-user read, ids only. Users with an
// open or committing batch are left out (a sweep after the commit builds
// theirs, once the moved ops have gone quiet), and so are users whose master
// published within `masterFreshMs`. Each fold then runs as its
// user. Users run one at a time so a sweep never holds more than one library
// in memory.
export async function runDueSnapshots(db: Db, log: Logger, opts: DueOptions = DEFAULT_DUE_OPTIONS): Promise<SnapshotBuild[]> {
	const due = await db.query<{ user_id: string }>(
		`select user_id::text as user_id from curator.users_due_for_snapshot_v3($1::bigint, make_interval(secs => $2::float8),
			make_interval(secs => $3::float8), make_interval(secs => $4::float8), make_interval(secs => $5::float8))`,
		[String(opts.minOps), String(opts.maxAgeMs / 1000), String(opts.quietMs / 1000), String(opts.busyEveryMs / 1000), String(opts.masterFreshMs / 1000)],
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
