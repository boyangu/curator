// Production entry: config from env, Postgres pool, JWKS-backed verifier,
// the Spotify gateway when its secrets are set, HTTP server, the access-log
// writer, and the maintenance sweeps on timers: batch upkeep (expire idle batches, finish stalled commits) every 15 min,
// the access log's prune and the log compaction (src/sync/compact.ts) daily,
// and, with the Global Catalog on, the event cards kept current every minute
// (src/catalog/card-rebuild.ts).
// Nothing starts until the migration gate has confirmed the database holds
// every migration this image ships (src/db/migration-gate.ts).

import { createServer } from 'node:http';
import { createFetchHandler } from './app.js';
import { AuditWriter, PRUNE_EVERY_MS, pruneRequestLog } from './audit.js';
import { createTokenVerifier, remoteKeys } from './auth/jwt.js';
import { rebuildCards } from './catalog/card-rebuild.js';
import { AppleLookup } from './catalog/trackers/apple.js';
import { TidalApp } from './catalog/trackers/tidal-app.js';
import { drainFollowUps } from './catalog/work/followup.js';
import { pruneWork } from './catalog/work/retention.js';
import { SoundCloudTracker } from '@curator/catalog-readers';
import { loadConfig, soundcloudCredentials, tidalCredentials } from './config.js';
import { createPostgresDb } from './db/db.js';
import { pruneClientLog } from './diagnostics.js';
import { migrationGate } from './db/migration-gate.js';
import { toNodeListener } from './http.js';
import { createLogger } from './log.js';
import { defaultRateLimits } from './rate-limit.js';
import { DEFAULT_BATCH_OPTIONS, tendBatches } from './sync/batch.js';
import { compactDueUsers } from './sync/compact.js';
import { TokenCrypto } from './spotify/crypto.js';
import { SPOTIFY_TIMEOUT_MS } from './spotify/gateway.js';
import { DEFAULT_PULL_OPTIONS } from './sync/pull.js';

// Often enough that an idle batch expires within 15 min of its day; cheap
// when nothing is due (one query over the live batches).
const BATCH_SWEEP_MS = 15 * 60 * 1000;
// Compaction: once a day, and 10 min after boot so a release does not wait a
// day for it (several machines compacting the same day is harmless: the
// second finds nothing below the base).
const COMPACT_EVERY_MS = 24 * 3600 * 1000;
const COMPACT_FIRST_MS = 10 * 60 * 1000;
// Event cards: how long a device waits for a change to a release it holds.
// One query when nothing was written since.
const CARD_REBUILD_MS = 60 * 1000;
// Releases devices just completed, looked up at Tidal and Apple
// (catalog/work/followup.ts): about as soon as the device's page shows them.
const FOLLOW_UP_MS = 30 * 1000;
// What device work stops keeping (catalog/work/retention.ts): once a day, and
// a quarter of an hour after boot. One instance at a time, by its own lock.
const WORK_PRUNE_EVERY_MS = 24 * 3600 * 1000;
const WORK_PRUNE_FIRST_MS = 15 * 60 * 1000;

const log = createLogger();
const config = loadConfig();
// The same SoundCloud app the worker reads labels with, here for the profiles
// a user picks from in "Help us connect the dots" (optional).
const soundcloud = soundcloudCredentials(process.env);
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
	spotify: config.spotify
		? { clientId: config.spotify.clientId, crypto: new TokenCrypto(config.spotify.keys), fetch: (url, init) => fetch(url, init), timeoutMs: SPOTIFY_TIMEOUT_MS }
		: null,
	catalog: config.catalog,
	connectSoundcloud: soundcloud ? new SoundCloudTracker(soundcloud) : null,
});
log.info('global_catalog', { enabled: config.catalog });
log.info('device_reads', { requireDeviceId: config.requireDeviceId });
// Key ids only (fingerprints, src/spotify/crypto.ts), never a key.
log.info('spotify_gateway', config.spotify
	? { enabled: true, keyId: config.spotify.keys.current.id, previousKeyId: config.spotify.keys.previous?.id ?? null }
	: { enabled: false, missing: config.spotifyMissing });
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
	await tendBatches({ db, log, audit, options: DEFAULT_BATCH_OPTIONS }).catch((e: unknown) => log.error('batch_tend_sweep_failed', { error: e }));
	if (Date.now() - lastPruneAt >= PRUNE_EVERY_MS) {
		lastPruneAt = Date.now();
		await pruneRequestLog(db)
			.then((deleted) => log.info('request_log_pruned', { deleted }))
			.catch((e: unknown) => log.error('request_log_prune_failed', { error: e }));
		await pruneClientLog(db)
			.then((deleted) => log.info('client_log_pruned', { deleted }))
			.catch((e: unknown) => log.error('client_log_prune_failed', { error: e }));
	}
}

let sweeping = false;
const sweep = setInterval(() => {
	if (sweeping) return;
	sweeping = true;
	void maintenance().finally(() => {
		sweeping = false;
	});
}, BATCH_SWEEP_MS);
sweep.unref();

let compacting = false;
function compact(): void {
	if (compacting) return;
	compacting = true;
	void compactDueUsers({ db, log, audit })
		.then((r) => log.info('compact_sweep', { users: r.length, deleted: r.reduce((n, x) => n + x.deleted, 0) }))
		.catch((e: unknown) => log.error('compact_sweep_failed', { error: e }))
		.finally(() => {
			compacting = false;
		});
}
let compactTimer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> = setTimeout(() => {
	compact();
	compactTimer = setInterval(compact, COMPACT_EVERY_MS);
	compactTimer.unref();
}, COMPACT_FIRST_MS);
compactTimer.unref();

let rebuilding = false;
if (config.catalog) {
	setInterval(() => {
		if (rebuilding) return;
		rebuilding = true;
		void rebuildCards(db)
			.then((r) => {
				if (r.moved) log.info('cards_rebuilt', r);
			})
			.catch((e: unknown) => log.error('card_rebuild_failed', { error: e }))
			.finally(() => {
				rebuilding = false;
			});
	}, CARD_REBUILD_MS).unref();
}

// The stores only Curator's own keys open, for what devices completed:
// Tidal with the app's credentials (unset: not asked), Apple's public lookup
// unless switched off (CURATOR_FEED_APPLE=0, as the upkeep reads it).
const tidalCreds = tidalCredentials(process.env);
const followUpReaders = { tidal: tidalCreds ? new TidalApp(tidalCreds) : null, apple: process.env.CURATOR_FEED_APPLE?.trim() !== '0' ? new AppleLookup() : null };
let following = false;
if (config.catalog && (followUpReaders.tidal || followUpReaders.apple)) {
	setInterval(() => {
		if (following) return;
		following = true;
		void drainFollowUps({ db, log, readers: followUpReaders })
			.then((r) => {
				if (r.linked || r.releases > r.requeued) log.info('work_followed_up', r);
			})
			.catch((e: unknown) => log.error('work_followup_failed', { error: e }))
			.finally(() => {
				following = false;
			});
	}, FOLLOW_UP_MS).unref();
}

if (config.catalog) {
	const prune = (): void => {
		void pruneWork(db)
			.then((r) => {
				if (r.answers || r.state || r.queue || r.leases) log.info('work_pruned', r);
			})
			.catch((e: unknown) => log.error('work_prune_failed', { error: e }));
	};
	setTimeout(() => {
		prune();
		setInterval(prune, WORK_PRUNE_EVERY_MS).unref();
	}, WORK_PRUNE_FIRST_MS).unref();
}

server.listen(config.port, () => log.info('listening', { port: config.port }));

function shutdown(signal: string): void {
	log.info('shutdown', { signal });
	clearInterval(sweep);
	clearTimeout(compactTimer);
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
