// `pnpm --filter @curator/cloud snapshot [--user <uuid>] [--prune-logs [--older-than '90 days']]`
// (or `node dist/snapshot.js` in the image). Without --user it runs the same
// due-sweep the server runs every 15 min; with it, builds one user's
// snapshot now regardless of the thresholds. Runs as the API role
// (DATABASE_URL), so each fold is under that user's RLS like a request.
//
// `--prune-logs` instead runs the access-log retention the server runs
// daily (curator.prune_request_log; audit_event is never pruned).

import { parseArgs } from 'node:util';
import { pruneRequestLog, REQUEST_LOG_RETENTION } from '../audit.js';
import { createPostgresDb } from '../db/db.js';
import { createLogger } from '../log.js';
import { buildSnapshot, runDueSnapshots } from '../snapshot/job.js';

const { values } = parseArgs({
	options: {
		user: { type: 'string' },
		'prune-logs': { type: 'boolean' },
		'older-than': { type: 'string', default: REQUEST_LOG_RETENTION },
	},
});

const url = process.env.DATABASE_URL?.trim();
if (!url) {
	console.error('DATABASE_URL is not set (see apps/cloud/.env.example)');
	process.exit(2);
}

const log = createLogger();
const db = createPostgresDb(url, { max: 1 });
try {
	if (values['prune-logs']) log.info('request_log_pruned', { olderThan: values['older-than'], deleted: await pruneRequestLog(db, values['older-than']) });
	else if (values.user) log.info('snapshot', { ...(await buildSnapshot(db, values.user)) });
	else log.info('snapshot_sweep', { users: (await runDueSnapshots(db, log)).length });
} catch (e) {
	log.error('snapshot_cli_failed', { error: e });
	process.exitCode = 1;
} finally {
	await db.close();
}
