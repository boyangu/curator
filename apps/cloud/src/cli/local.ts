// A local Global Catalog for trying it from a dev desktop without deploying
// (`pnpm --filter @curator/cloud local`). Dev only: never bundled into the
// image (scripts/build.mjs has no entry for it).
//
// One process runs what production splits in two: the API (only the
// catalog.* and feed.* procedures matter; the desktop's library sync keeps
// talking to the real cloud, see apps/desktop CURATOR_CATALOG_API_URL) and the
// worker's tracking pass + identity planner every minute.
//
// The database is PGlite with the Supabase shim, persisted on disk
// (CURATOR_LOCAL_CLOUD_DIR, default ~/.curator-local-cloud): follows and the
// catalogue survive restarts; delete the folder to start over. Sign-in is the
// real one: tokens are verified against the Supabase project's public keys
// (CURATOR_SUPABASE_URL from the repo .env), and the user's id gets its
// auth.users row here on first sight, which the shim's foreign keys need.
//
// Providers: Deezer (key-less) always; Spotify app credentials only when
// CURATOR_SPOTIFY_APP_CLIENT_SECRET is in the environment (the id is
// CURATOR_SPOTIFY_APP_CLIENT_ID, else the desktop's CURATOR_SPOTIFY_CLIENT_ID).
//
// Stop it with Ctrl+C, or from anywhere with `pnpm --filter @curator/cloud
// local --stop` (on Windows a signal from another process is a hard kill,
// and PGlite killed mid-write can leave the folder unreadable).

import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { createFetchHandler } from '../app.js';
import { createBackofficeHandler } from '../backoffice/handler.js';
import { AuditWriter } from '../audit.js';
import { createTokenVerifier, remoteKeys } from '../auth/jwt.js';
import { DeezerFinder, runPlanner, runRecordingResolver, SpotifyFinder, type IdentityFinder } from '../catalog/planner.js';
import { adminOps, type AdminOps } from '../catalog/admin-ops.js';
import { runLabelProfiler } from '../catalog/profile/label-profiler.js';
import { runCataloguePlaylists } from '../catalog/profile/catalogue-playlists.js';
import { runBackfill } from '../catalog/trackers/backfill.js';
import { BandcampTracker } from '../catalog/trackers/bandcamp.js';
import { BeatportTracker } from '../catalog/trackers/beatport.js';
import { DeezerTracker } from '../catalog/trackers/deezer.js';
import { SoundCloudTracker } from '../catalog/trackers/soundcloud.js';
import { YouTubeTracker } from '../catalog/trackers/youtube.js';
import { soundcloudCredentials, tidalCredentials } from '../config.js';
import { runInboxDetectors } from '../catalog/inbox-detectors.js';
import { agentReasonerConfig, describeReasoner, reasonerModel } from '../catalog/agent/config.js';
import { runAgentReasoner } from '../catalog/agent/reasoner.js';
import { loadLocalLibrary, type LocalLibrary } from '../catalog/local-library.js';
import { runLabelDedupe } from '../catalog/label-related.js';
import { runReleaseFiller } from '../catalog/release-fill.js';
import { runStoreLinker } from '../catalog/store-links.js';
import { AppleLookup } from '../catalog/trackers/apple.js';
import { TidalApp } from '../catalog/trackers/tidal-app.js';
import { SpotifyAppTracker } from '../catalog/trackers/spotify-app.js';
import { runTrackers } from '../catalog/trackers/sweep.js';
import type { TrackerAdapter } from '../catalog/trackers/types.js';
import { findSqlDir, migrate } from '../db/migrate.js';
import { toNodeListener } from '../http.js';
import { createLogger } from '../log.js';
import { defaultRateLimits } from '../rate-limit.js';
import { DEFAULT_BATCH_OPTIONS } from '../sync/batch.js';
import { DEFAULT_PULL_OPTIONS } from '../sync/pull.js';
import { pgliteDb, STORAGE_SQL } from '../test/harness.js';
import { SUPABASE_SHIM_SQL } from '../test/supabase-shim.js';

const PORT = Number(process.env.CURATOR_LOCAL_CLOUD_PORT ?? 8787);
const PASS_EVERY_MS = 60_000;

const supabaseUrl = (process.env.SUPABASE_URL ?? process.env.CURATOR_SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
if (!supabaseUrl) {
	console.error('Set CURATOR_SUPABASE_URL (the repo .env has it) so sign-in tokens can be verified.');
	process.exit(1);
}

const dir = process.env.CURATOR_LOCAL_CLOUD_DIR ?? join(homedir(), '.curator-local-cloud');
mkdirSync(dir, { recursive: true });
const log = createLogger((line) => {
	const j = JSON.parse(line) as { level: string; msg: string; [k: string]: unknown };
	// Requests and passes on one line each; the rest only when they matter.
	if (j.msg === 'request') console.log(`${j.status ?? ''} ${j.procedure ?? ''} ${j.ms ?? ''}ms${j.reason ? ` ${String(j.reason)}` : ''}`);
	else if (j.level !== 'debug') console.log(`[${j.level}] ${j.msg}`, Object.fromEntries(Object.entries(j).filter(([k]) => !['level', 'msg', 'ts', 'time'].includes(k))));
});

// `--stop`: ask the running copy to shut down cleanly, and wait for it.
const stopPath = join(dir, 'stop');
if (process.argv.includes('--stop')) {
	writeFileSync(stopPath, String(Date.now()));
	for (let i = 0; i < 60; i++) {
		try {
			readFileSync(join(dir, 'lock'));
		} catch {
			rmSync(stopPath, { force: true });
			console.log('Stopped.');
			process.exit(0);
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	rmSync(stopPath, { force: true });
	console.error('No running local catalogue answered within 30 s.');
	process.exit(1);
}
rmSync(stopPath, { force: true });

// One process per data folder: PGlite is single-process, and a second copy
// opening the same folder can corrupt it. The lock names the holder's pid;
// a lock whose process is gone is stale and taken over.
const lockPath = join(dir, 'lock');
try {
	const holder = Number(readFileSync(lockPath, 'utf8'));
	if (holder && holder !== process.pid) {
		try {
			process.kill(holder, 0);
			console.error(`Another local catalogue (pid ${holder}) is using ${dir}. Stop it first (Ctrl+C in its window).`);
			process.exit(1);
		} catch {
			// Gone: the lock is stale.
		}
	}
} catch {
	// No lock yet.
}
// The port too, before the database is touched.
await new Promise<void>((resolve) => {
	const probe = createNetServer();
	probe.once('error', () => {
		console.error(`Port ${PORT} is in use: another local catalogue is probably running. Stop it, or set CURATOR_LOCAL_CLOUD_PORT.`);
		process.exit(1);
	});
	probe.listen(PORT, '127.0.0.1', () => probe.close(() => resolve()));
});
writeFileSync(lockPath, String(process.pid));
const releaseLock = () => {
	try {
		if (readFileSync(lockPath, 'utf8') === String(process.pid)) rmSync(lockPath);
	} catch {
		// Already gone.
	}
};
process.on('exit', releaseLock);

const pg = await PGlite.create(join(dir, 'pgdata'));
const db = pgliteDb(pg);
const [fresh] = (await pg.query<{ missing: boolean }>(`select to_regclass('auth.users') is null as missing`)).rows;
if (fresh?.missing) {
	console.log('First run: creating the local database…');
	await pg.exec(SUPABASE_SHIM_SQL);
}
const migrated = await migrate(db, findSqlDir());
if (fresh?.missing) await pg.exec(STORAGE_SQL);
if (migrated.applied.length) console.log('Applied migrations:', migrated.applied.join(', '));

// PGlite runs no autovacuum, so nothing analyzes the tables on its own: with
// no statistics the planner guesses 8 rows for a label's 2,000 edges and
// picks plans that scan the whole source index per release (2026-10-29: the
// inbox detectors held the database 55 s a pass; 3 s once analyzed). At
// startup, then after a pass every ANALYZE_EVERY_MS — imports move the shape.
const ANALYZE_EVERY_MS = 10 * 60_000;
let analyzedAt = 0;
async function analyze(): Promise<void> {
	const t = Date.now();
	await pg.exec('analyze');
	analyzedAt = Date.now();
	log.info('analyzed', { ms: analyzedAt - t });
}
await analyze();

const audit = new AuditWriter({ db, log });
audit.start();
const handler = createFetchHandler({
	db,
	log,
	audit,
	auth: createTokenVerifier({ supabaseUrl, keys: remoteKeys(supabaseUrl) }),
	limits: defaultRateLimits(),
	pull: DEFAULT_PULL_OPTIONS,
	// Off here: those live in the real cloud (and Storage) the desktop syncs with.
	catalogue: null,
	requireDeviceId: false,
	batch: DEFAULT_BATCH_OPTIONS,
	spotify: null,
	catalog: true,
});

// Beatport's pages (labels, genre charts) and Bandcamp too, unless switched off.
const beatport = process.env.CURATOR_FEED_BEATPORT !== '0';
const bandcamp = process.env.CURATOR_FEED_BANDCAMP !== '0';
const adapters: TrackerAdapter[] = [new DeezerTracker(), ...(beatport ? [new BeatportTracker()] : []), ...(bandcamp ? [new BandcampTracker()] : [])];
const finders: IdentityFinder[] = [new DeezerFinder()];
let spotify: SpotifyAppTracker | null = null;
// Spotify allows one app per developer, so the app credentials' id is the
// desktop's PKCE client id unless set apart.
const spotifyId = (process.env.CURATOR_SPOTIFY_APP_CLIENT_ID || process.env.CURATOR_SPOTIFY_CLIENT_ID)?.trim();
const spotifySecret = process.env.CURATOR_SPOTIFY_APP_CLIENT_SECRET?.trim();
if (spotifyId && spotifySecret) {
	spotify = new SpotifyAppTracker({ clientId: spotifyId, clientSecret: spotifySecret });
	adapters.push(spotify);
	finders.push(new SpotifyFinder(spotify));
}

// The back office (cli/catalog.ts) reaches this process's database here:
// PGlite is single-process, so the CLI cannot open it beside the server.
// Loopback only, no auth, dev only — like the rest of this file. The app's
// Spotify lets `label link` name a playlist it attaches.
const tidalCreds = tidalCredentials(process.env);
const tidal = tidalCreds ? new TidalApp(tidalCreds) : null;
const apple = process.env.CURATOR_FEED_APPLE !== '0' ? new AppleLookup() : null;
// A library's releases read in full from their stores (release-fill.ts).
const fillFetchers = {
	spotify,
	tidal,
	apple,
	deezer: (adapters.find((a) => a instanceof DeezerTracker) as DeezerTracker | undefined) ?? null,
	beatport: (adapters.find((a) => a instanceof BeatportTracker) as BeatportTracker | undefined) ?? null,
	bandcamp: (adapters.find((a) => a instanceof BandcampTracker) as BandcampTracker | undefined) ?? null,
};
// The catalogue reasoner (catalog/agent): on with CURATOR_ANTHROPIC_API_KEY in the root .env.
const agentCfg = agentReasonerConfig(process.env);
const agentModel = agentCfg ? reasonerModel(agentCfg) : null;
console.log(`Reasoner: ${describeReasoner(agentCfg)}`);
const admin = adminOps(db, { spotify, tidal, apple }, { pass: () => freshPass(), agent: agentCfg && agentModel ? { model: agentModel, cfg: agentCfg } : null });
const adminHandler = async (req: Request): Promise<Response> => {
	try {
		const { op, args } = (await req.json()) as { op: keyof AdminOps; args: never };
		if (!(op in admin)) return Response.json({ ok: false, error: `unknown op ${String(op)}` }, { status: 400 });
		return Response.json({ ok: true, result: await admin[op](args) });
	} catch (e) {
		return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
	}
};

// The owner's library (curator.db, read-only) as the back office lists'
// filter: a testing aid, local only (local-library.ts). Reloaded every
// LIBRARY_EVERY_MS so an import in the app shows without a restart.
// CURATOR_LIBRARY_DB points elsewhere; a missing file means no filter.
const LIBRARY_EVERY_MS = 10 * 60_000;
const libraryPath = process.env.CURATOR_LIBRARY_DB ?? join(process.env.APPDATA ?? join(homedir(), '.config'), 'Curator', 'curator.db');
let library: LocalLibrary | null = null;
async function reloadLibrary(): Promise<void> {
	if (!existsSync(libraryPath)) return;
	try {
		library = await loadLocalLibrary(db, libraryPath);
		log.info('library_loaded', { tracks: library.tracks, ...library.objects });
	} catch (e) {
		log.warn('library_load_failed', { path: libraryPath, error: e instanceof Error ? e.message : String(e) });
	}
}
await reloadLibrary();
setInterval(() => void reloadLibrary(), LIBRARY_EVERY_MS).unref();

// The back office in a browser (src/backoffice), read-only, same footing as /admin.
const backoffice = createBackofficeHandler(db, { library: () => library });

// The shim's auth.users stands in for Supabase's: the signed-in user's row
// is made on first sight (the token is still verified by the API itself).
const seen = new Set<string>();
const withUser = async (req: Request): Promise<Response> => {
	if (new URL(req.url).pathname === '/admin' && req.method === 'POST') return adminHandler(req);
	const page = await backoffice(req);
	if (page) return page;
	const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
	const payload = token?.split('.')[1];
	if (payload) {
		try {
			const sub = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string }).sub;
			if (sub && /^[0-9a-f-]{36}$/i.test(sub) && !seen.has(sub)) {
				await pg.query('insert into auth.users (id) values ($1) on conflict do nothing', [sub]);
				seen.add(sub);
			}
		} catch {
			// Not a JWT: the API refuses it.
		}
	}
	return handler(req);
};

const server = createServer(toNodeListener(withUser, { log, audit }));
server.listen(PORT, '127.0.0.1', () => {
	console.log(`Local Global Catalog on http://127.0.0.1:${PORT} (data in ${dir})`);
	console.log(`Back office: http://127.0.0.1:${PORT}/backoffice`);
	console.log(`Desktop: set CURATOR_CATALOG_API_URL=http://127.0.0.1:${PORT} and run pnpm dev.`);
});

const youtubeKey = process.env.CURATOR_YOUTUBE_API_KEY?.trim();
if (youtubeKey) adapters.push(new YouTubeTracker(youtubeKey));
const sc = soundcloudCredentials(process.env);
if (sc) adapters.push(new SoundCloudTracker(sc));
console.log(`Trackers: ${adapters.map((a) => a.provider).join(', ')}`);
console.log(`Store links by UPC/ISRC: ${[spotify && 'spotify', tidal && 'tidal', apple && 'apple'].filter(Boolean).join(', ') || 'none'}${tidal ? '' : ' (no CURATOR_TIDAL_CLIENT_ID/SECRET)'}`);
if (!(spotifyId && spotifySecret)) {
	console.log(
		'No Spotify app credentials: artists followed on Spotify are not tracked, and Discover shows Spotify releases only.\n' +
			'  Add CURATOR_SPOTIFY_APP_CLIENT_SECRET (and CURATOR_SPOTIFY_CLIENT_ID, if missing) to the root .env and restart.',
	);
}

// One pass at a time; the timer skips while one runs, and the back office's
// `catalog pass` waits for it and then runs a fresh one (its work was just
// queued, after the running pass picked what it would do).
let current: Promise<void> | null = null;
function pass(): Promise<void> {
	if (current) return current;
	current = (async () => {
		await runTrackers({ db, log, adapters, holder: 'local' }).catch((e: unknown) => log.error('tracker_pass_failed', { error: e }));
		await runPlanner({ db, log, finders }).catch((e: unknown) => log.error('identity_pass_failed', { error: e }));
		if (spotify) await runRecordingResolver({ db, log, spotify }).catch((e: unknown) => log.error('recording_resolve_failed', { error: e }));
		await runStoreLinker({ db, log, readers: { spotify, tidal, apple } }).catch((e: unknown) => log.error('store_link_pass_failed', { error: e }));
		await runReleaseFiller({ db, log, fetchers: fillFetchers, holder: 'local' }).catch((e: unknown) => log.error('release_fill_pass_failed', { error: e }));
		await runLabelProfiler({ db, log, spotify, providers: { beatport, bandcamp }, batch: 10 }).catch((e: unknown) => log.error('label_profile_pass_failed', { error: e }));
		await runBackfill({ db, log, adapters, holder: 'local', batch: 20 }).catch((e: unknown) => log.error('catalog_backfill_failed', { error: e }));
		await runCataloguePlaylists({ db, log, spotify, holder: 'local', batch: 10 }).catch((e: unknown) => log.error('catalogue_playlists_pass_failed', { error: e }));
		if (process.env.CURATOR_DEBUG_PASS === '1') log.info('pass_step', { step: 'label-dedupe' });
		await runLabelDedupe({ db, log }).catch((e: unknown) => log.error('label_dedupe_pass_failed', { error: e }));
		if (process.env.CURATOR_DEBUG_PASS === '1') log.info('pass_step', { step: 'detectors' });
		await runInboxDetectors({ db, log, agent: agentModel !== null }).catch((e: unknown) => log.error('inbox_detectors_failed', { error: e }));
		if (agentCfg && agentModel) await runAgentReasoner({ db, log, model: agentModel, cfg: agentCfg, holder: 'local' }).catch((e: unknown) => log.error('agent_reasoner_failed', { error: e }));
		if (Date.now() - analyzedAt > ANALYZE_EVERY_MS) await analyze().catch((e: unknown) => log.error('analyze_failed', { error: e }));
	})().finally(() => {
		current = null;
	});
	return current;
}
const freshPass = async (): Promise<void> => {
	if (current) await current;
	await pass();
};
const timer = setInterval(() => void pass(), PASS_EVERY_MS);
setTimeout(() => void pass(), 5_000);
// A stop request from `--stop` (see the header).
setInterval(() => {
	try {
		readFileSync(stopPath);
		rmSync(stopPath, { force: true });
		void stop();
	} catch {
		// None.
	}
}, 1_000).unref();

let stopping = false;
async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.log('Stopping…');
	clearInterval(timer);
	server.close();
	// Let a tracker pass in flight finish its statement first.
	for (let i = 0; current && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
	await audit.close().catch(() => {});
	await pg.close();
	process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
