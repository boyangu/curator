// `pnpm --filter @curator/cloud snapshot <command> [options]` (or
// `node dist/snapshot.js` in the image, from `fly ssh console` or a one-off
// machine). Runs as the API role (DATABASE_URL): the compaction functions
// are SECURITY DEFINER and granted to it (sql/roles.sql); the reads run as
// the user under RLS like a request.
//
//   (no command)        the batch sweep the server runs every 15 min
//                       (expire idle batches, finish stalled commits).
//   base --user <uuid>  the account's base, its newest and oldest snapshot
//                       seqs, and how many ops the log holds.
//   compact --user <uuid> --through <seq> [--limit 5000]
//                       raises the account's base to <seq> (refused above
//                       its oldest kept snapshot) and deletes the log below
//                       it in chunks, printing progress. This is the rebase:
//                       after the master has published at <seq>, the ops it
//                       covers leave the log (README "Snapshots").
//   --prune-logs [--older-than '90 days']
//                       the access-log retention the server runs daily
//                       (curator.prune_request_log; audit_event is never
//                       pruned).
//   --db-size [--user <uuid>]
//                       the size of every curator table and, with a user,
//                       what that user holds in each Storage bucket.

import { parseArgs } from 'node:util';
import { AuditWriter, pruneRequestLog, REQUEST_LOG_RETENTION } from '../audit.js';
import { createPostgresDb, num, numOrNull, type Db } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { createLogger } from '../log.js';
import { BASE_SEQ } from '../sync/base.js';
import { DEFAULT_BATCH_OPTIONS, tendBatches } from '../sync/batch.js';
import { compactUser, DEFAULT_COMPACT_OPTIONS } from '../sync/compact.js';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		user: { type: 'string' },
		through: { type: 'string' },
		limit: { type: 'string', default: String(DEFAULT_COMPACT_OPTIONS.limit) },
		'prune-logs': { type: 'boolean' },
		'older-than': { type: 'string', default: REQUEST_LOG_RETENTION },
		'db-size': { type: 'boolean' },
	},
});

const url = process.env.DATABASE_URL?.trim();
if (!url) {
	console.error('DATABASE_URL is not set (see apps/cloud/.env.example)');
	process.exit(2);
}
const command = positionals[0];
if (command !== undefined && command !== 'base' && command !== 'compact') {
	console.error(`unknown command ${command} (expected: base, compact)`);
	process.exit(2);
}
if (command !== undefined && !values.user) {
	console.error(`${command} needs --user <uuid>`);
	process.exit(2);
}
const through = values.through === undefined ? undefined : Number(values.through);
if (command === 'compact' && (through === undefined || !Number.isInteger(through) || through < 0)) {
	console.error('compact needs --through <seq> (a non-negative integer)');
	process.exit(2);
}
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1) {
	console.error(`--limit must be a positive integer, not ${values.limit}`);
	process.exit(2);
}

// pg_total_relation_size needs no privilege on the table, so the API role
// can size tables it cannot read. Storage sums run as the user, under the
// buckets' own RLS.
async function dbSize(db: Db, userId: string | undefined): Promise<Record<string, unknown>> {
	const tables = await db.query<{ table: string; bytes: unknown }>(
		`select c.relname as table, pg_total_relation_size(c.oid)::float8 as bytes
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where n.nspname = 'curator' and c.relkind = 'r'
		order by pg_total_relation_size(c.oid) desc`,
	);
	const out: Record<string, unknown> = { tables: Object.fromEntries(tables.map((t) => [t.table, num(t.bytes)])) };
	if (userId) {
		const buckets = await withUserTx(db, userId, (tx) =>
			tx.query<{ bucket: string; objects: unknown; bytes: unknown }>(
				`select bucket_id as bucket, count(*)::float8 as objects, coalesce(sum((metadata ->> 'size')::bigint), 0)::float8 as bytes
				from storage.objects group by bucket_id order by bucket_id`,
			),
		);
		out.storage = Object.fromEntries(buckets.map((b) => [b.bucket, { objects: num(b.objects), bytes: num(b.bytes) }]));
	}
	return out;
}

// The account as the base model sees it. The op count is exact (one index
// walk of the user's log), which is what the rebase wants to see before and
// after; it is not something a request does.
async function baseReport(db: Db, userId: string): Promise<Record<string, unknown>> {
	return withUserTx(db, userId, async (tx) => {
		const [b] = await tx.query<{ base: unknown; compacted_at: string | null }>(
			`select coalesce(min(base_seq), 0)::float8 as base, min(compacted_at)::text as compacted_at from curator.library_base where user_id = (select auth.uid())`,
		);
		const [s] = await tx.query<{ newest: unknown; oldest: unknown; n: unknown }>(
			`select max(snapshot_seq)::float8 as newest, min(snapshot_seq)::float8 as oldest, count(*)::float8 as n
			from curator.library_snapshot where user_id = (select auth.uid())`,
		);
		const [o] = await tx.query<{ n: unknown; head: unknown; below: unknown; master_ops: unknown }>(
			`select count(*)::float8 as n, coalesce(max(seq), 0)::float8 as head,
				count(*) filter (where seq <= ${BASE_SEQ} and not (entity = 'setting' and entity_id = 'library.master_device'))::float8 as below,
				count(*) filter (where entity = 'setting' and entity_id = 'library.master_device')::float8 as master_ops
			from curator.library_op where user_id = (select auth.uid())`,
		);
		return {
			userId,
			baseSeq: num(b!.base),
			compactedAt: b!.compacted_at,
			snapshots: num(s!.n),
			newestSnapshotSeq: numOrNull(s!.newest),
			oldestSnapshotSeq: numOrNull(s!.oldest),
			ops: num(o!.n),
			// What compact would still delete (master-device setting ops excluded).
			opsBelowBase: num(o!.below),
			masterOps: num(o!.master_ops),
			head: Math.max(num(o!.head), num(b!.base)),
		};
	});
}

const log = createLogger();
const db = createPostgresDb(url, { max: 1 });
try {
	if (command === 'base') log.info('base', await baseReport(db, values.user!));
	else if (command === 'compact') {
		log.info('compact_start', { ...(await baseReport(db, values.user!)), through, limit });
		const r = await compactUser(db, values.user!, through!, { limit }, (deleted) => log.info('compact_progress', { userId: values.user, deleted }));
		log.info('compact_done', { ...r });
		log.info('base', await baseReport(db, values.user!));
	} else if (values['db-size']) log.info('db_size', await dbSize(db, values.user));
	else if (values['prune-logs']) log.info('request_log_pruned', { olderThan: values['older-than'], deleted: await pruneRequestLog(db, values['older-than']) });
	else {
		// Expiry and commit events land in audit_event as the server's do.
		const audit = new AuditWriter({ db, log });
		try {
			log.info('batch_sweep', { ...(await tendBatches({ db, log, audit, options: DEFAULT_BATCH_OPTIONS })) });
		} finally {
			await audit.close();
		}
	}
} catch (e) {
	log.error('snapshot_cli_failed', { error: e });
	process.exitCode = 1;
} finally {
	await db.close();
}
