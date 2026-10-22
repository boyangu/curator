// Production entry: config from env, Postgres pool, JWKS-backed verifier,
// HTTP server, the access-log writer, and the maintenance sweep on a timer:
// batch upkeep (expire idle batches, finish stalled commits), snapshots, and
// the access log's daily prune. Nothing starts until the
// migration gate has confirmed the database holds every migration this
// image ships (src/db/migration-gate.ts).

import { createServer } from 'node:http';
import { createFetchHandler } from './app.js';
import { AuditWriter, PRUNE_EVERY_MS, pruneRequestLog } from './audit.js';
import { createTokenVerifier, remoteKeys } from './auth/jwt.js';
import { loadConfig } from './config.js';
import { createPostgresDb } from './db/db.js';
import { migrationGate } from './db/migration-gate.js';
import { toNodeListener } from './http.js';
import { createLogger } from './log.js';
import { defaultRateLimits } from './rate-limit.js';
import { runDueSnapshots } from './snapshot/job.js';
import { DEFAULT_BATCH_OPTIONS, tendBatches } from './sync/batch.js';
import { DEFAULT_PULL_OPTIONS } from './sync/pull.js';

// Often enough that "24 h" is met within the hour and an idle batch expires
// within 15 min of its day; cheap when nothing is due (one query over the
// device table, one over the live batches).
const SNAPSHOT_SWEEP_MS = 15 * 60 * 1000;

const log = createLogger();
const config = loadConfig();
const db = createPostgresDb(config.databaseUrl);

// Exit non-zero rather than serve against an old schema: the new machine
// never passes Fly's health check, so the deploy fails and the previous
// release keeps serving. An unreachable database fails the same way.
const schemaOk = await migrationGate(db, log).catch((e: unknown) => {
	log.error('schema_check_failed', { error: e });
	return false;
});
if (!schemaOk) {
	await db.close().catch(() => {});
	process.exit(1);
}

// On the shared pool: a flush is one short statement a second at most.
const audit = new AuditWriter({ db, log });
audit.start();
const handler = createFetchHandler({
	db,
	log,
	audit,
	auth: createTokenVerifier({ supabaseUrl: config.supabaseUrl, keys: remoteKeys(config.supabaseUrl) }),
	limits: defaultRateLimits(),
	pull: DEFAULT_PULL_OPTIONS,
	catalogue: config.catalogue,
	requireDeviceId: config.requireDeviceId,
	batch: DEFAULT_BATCH_OPTIONS,
});
log.info('device_reads', { requireDeviceId: config.requireDeviceId });
log.info('catalogue_policy', { allow: config.catalogue?.allow.map((a) => (a.variants ? `${a.unit}:${a.variants.join('|')}` : a.unit)) ?? 'off' });

const server = createServer(toNodeListener(handler, { log, audit }));
// Longer than Fly's proxy idle timeout (60 s) so the proxy, not Node, closes
// idle keep-alive connections; otherwise a reused socket can be cut mid-request.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 60_000;

// 0: the first sweep after boot prunes, then every 24 h. Several machines
// pruning the same day is harmless (the second deletes nothing).
let lastPruneAt = 0;

async function maintenance(): Promise<void> {
	// Batches first: a commit finished here builds its own snapshot, and a
	// user with an open batch is skipped by the snapshot rule below.
	await tendBatches({ db, log, audit, options: DEFAULT_BATCH_OPTIONS }).catch((e: unknown) => log.error('batch_tend_sweep_failed', { error: e }));
	await runDueSnapshots(db, log).catch((e: unknown) => log.error('snapshot_sweep_failed', { error: e }));
	if (Date.now() - lastPruneAt >= PRUNE_EVERY_MS) {
		lastPruneAt = Date.now();
		await pruneRequestLog(db)
			.then((deleted) => log.info('request_log_pruned', { deleted }))
			.catch((e: unknown) => log.error('request_log_prune_failed', { error: e }));
	}
}

let sweeping = false;
const sweep = setInterval(() => {
	if (sweeping) return;
	sweeping = true;
	void maintenance().finally(() => {
		sweeping = false;
	});
}, SNAPSHOT_SWEEP_MS);
sweep.unref();

server.listen(config.port, () => log.info('listening', { port: config.port }));

function shutdown(signal: string): void {
	log.info('shutdown', { signal });
	clearInterval(sweep);
	// Write what is buffered now, in case the close below outlasts the
	// deadline (a slow request still in flight).
	void audit.flush();
	// Rows buffered for the access log and audit trail are written after
	// the last request finishes and before the pool closes.
	server.close(() => {
		void audit
			.close()
			.then(() => db.close())
			.finally(() => process.exit(0));
	});
	// Fly sends SIGKILL after its kill_timeout; leave before that, with any
	// rows still unwritten on stdout rather than lost.
	setTimeout(() => {
		audit.spillBuffered();
		process.exit(1);
	}, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
