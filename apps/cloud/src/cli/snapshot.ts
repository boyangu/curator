// `pnpm --filter @curator/cloud snapshot [--user <uuid>] [--prune-logs [--older-than '90 days']]`
// (or `node dist/snapshot.js` in the image). Without --user it runs the same
// sweep the server runs every 15 min (batch upkeep, then the due
// snapshots); with it, builds one user's snapshot now regardless of the
// thresholds (still not past an open batch: its commit builds that one). Runs as the API role
// (DATABASE_URL), so each fold is under that user's RLS like a request.
//
// `--prune-logs` instead runs the access-log retention the server runs
// daily (curator.prune_request_log; audit_event is never pruned).
//
// `verify --user <uuid>` folds the log up to the user's newest
// master-published snapshot and compares its hash with the one the master
// stated (src/snapshot/verify.ts); the verdict is printed and lands in
// audit_event (`snapshot_verified` / `snapshot_mismatch`). It holds the whole
// library in memory, which is why only a person runs it, never the timer.
//
// `--db-size [--user <uuid>]` prints the size of every curator table and,
// with a user, what that user holds in each Storage bucket.

import { parseArgs } from 'node:util';
import { AuditWriter, pruneRequestLog, REQUEST_LOG_RETENTION } from '../audit.js';
import { createPostgresDb, num, type Db } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { createLogger } from '../log.js';
import { buildSnapshot, runDueSnapshots } from '../snapshot/job.js';
import { verifyPublishedSnapshot } from '../snapshot/verify.js';
import { DEFAULT_BATCH_OPTIONS, tendBatches } from '../sync/batch.js';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		user: { type: 'string' },
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
if (command !== undefined && command !== 'verify') {
	console.error(`unknown command ${command} (expected: verify)`);
	process.exit(2);
}
if (command === 'verify' && !values.user) {
	console.error('verify needs --user <uuid>');
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

const log = createLogger();
const db = createPostgresDb(url, { max: 1 });
try {
	if (command === 'verify') {
		const r = await verifyPublishedSnapshot(db, values.user!);
		log.info('snapshot_verify', { ...r });
		if (r.status !== 'no_published_snapshot') {
			const audit = new AuditWriter({ db, log });
			try {
				const { userId, status, publishedBy, ...detail } = r;
				audit.event({ at: new Date().toISOString(), request_id: null, user_id: userId, device_id: publishedBy, kind: status === 'match' ? 'snapshot_verified' : 'snapshot_mismatch', detail });
			} finally {
				await audit.close();
			}
			if (r.status === 'mismatch') process.exitCode = 1;
		}
	} else if (values['db-size']) log.info('db_size', await dbSize(db, values.user));
	else if (values['prune-logs']) log.info('request_log_pruned', { olderThan: values['older-than'], deleted: await pruneRequestLog(db, values['older-than']) });
	else if (values.user) log.info('snapshot', { ...(await buildSnapshot(db, values.user)) });
	else {
		// Expiry and commit events land in audit_event as the server's do.
		const audit = new AuditWriter({ db, log });
		try {
			log.info('batch_sweep', { ...(await tendBatches({ db, log, audit, options: DEFAULT_BATCH_OPTIONS })) });
		} finally {
			await audit.close();
		}
		log.info('snapshot_sweep', { users: (await runDueSnapshots(db, log)).length });
	}
} catch (e) {
	log.error('snapshot_cli_failed', { error: e });
	process.exitCode = 1;
} finally {
	await db.close();
}
