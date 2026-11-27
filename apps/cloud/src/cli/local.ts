// A local Global Catalog for trying it from a dev desktop without deploying
// (`pnpm --filter @curator/cloud local`). Dev only: never bundled into the
// image (scripts/build.mjs has no entry for it).
//
// One process runs what production splits in two: the API (only the
// catalog.* and feed.* procedures matter; the desktop's library sync keeps
// talking to the real cloud, see apps/desktop CURATOR_CATALOG_API_URL) and the
// upkeep pass (worker/pass.ts) every minute.
//
// Its catalogue was moved to the cloud once (scripts/cloud-catalog-push.mjs).
// The data folder then holds a MIGRATED file, and this refuses to open it: a
// second copy that keeps growing is one nothing reads any more. Trying things
// locally takes a folder of its own (CURATOR_LOCAL_CLOUD_DIR).
//
// The database is PGlite with the Supabase shim, persisted on disk
// (CURATOR_LOCAL_CLOUD_DIR, default ~/.curator-local-cloud): follows and the
// catalogue survive restarts; delete the folder to start over. Sign-in is the
// real one: tokens are verified against the Supabase project's public keys
// (CURATOR_SUPABASE_URL from the repo .env), and the user's id gets its
// auth.users row here on first sight, which the shim's foreign keys need.
//
// Providers: worker/pass.ts.
// Spotify playlists need a person's login. The local catalogue keeps one of
// its own, signed in from the back office (local-spotify.ts), so it reads them
// with nothing else running. Without it, a dev desktop's current access token
// stands in while it runs (apps/desktop main/cloud/local-catalog-login.ts; in
// memory only). Either way the reader only ever GETs.
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
import { createBackofficeHandler, type WorkerStatus } from '../backoffice/handler.js';
import { stamped } from '../backoffice/operator.js';
import { AuditWriter } from '../audit.js';
import { createTokenVerifier, remoteKeys } from '../auth/jwt.js';
import { adminOps, type AdminOps } from '../catalog/admin-ops.js';
import { agentReasonerConfig, describeReasoner, reasonerModel } from '../catalog/agent/config.js';
import { loadLocalLibrary, type LocalLibrary } from '../catalog/local-library.js';
import { TIDAL_BORROWED_NOTE, tidalCredentials } from '../config.js';
import { SpotifyUserPlaylistTracker } from '@curator/catalog-readers';
import { createLocalSpotifyLogin } from './local-spotify.js';
import type { TrackerAdapter } from '@curator/catalog-readers';
import { findSqlDir, migrate } from '../db/migrate.js';
import { toNodeListener } from '../http.js';
import { createLogger } from '../log.js';
import { defaultRateLimits } from '../rate-limit.js';
import { DEFAULT_BATCH_OPTIONS } from '../sync/batch.js';
import { DEFAULT_PULL_OPTIONS } from '../sync/pull.js';
import { pgliteDb, STORAGE_SQL } from '../test/harness.js';
import { SUPABASE_SHIM_SQL } from '../test/supabase-shim.js';

import { watcherPlaylistToken } from '../catalog/spotify-app-token.js';
import { readersFromEnv, runPass } from '../worker/pass.js';
import { rebuildCards } from '../catalog/card-rebuild.js';
import { fromThisMachinesPages } from './loopback.js';
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

if (existsSync(join(dir, 'MIGRATED'))) {
	console.error(`The catalogue in ${dir} was moved to the cloud: run \`pnpm cloud:worker\` for its upkeep, or set CURATOR_LOCAL_CLOUD_DIR to a new folder.`);
	process.exit(1);
}

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

const readers = readersFromEnv(process.env, db);
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
	connectSoundcloud: readers.soundcloud,
});

// The back office (cli/catalog.ts) reaches this process's database here:
// PGlite is single-process, so the CLI cannot open it beside the server.
// Loopback only, no auth, dev only — like the rest of this file. The app's
// Spotify lets `label link` name a playlist it attaches.
// The catalogue reasoner (catalog/agent): on with CURATOR_ANTHROPIC_API_KEY in the root .env.
const agentCfg = agentReasonerConfig(process.env);
const agent = agentCfg ? { model: reasonerModel(agentCfg), cfg: agentCfg } : null;
console.log(`Reasoner: ${describeReasoner(agentCfg)}`);
const admin = adminOps(db, readers.stores, { pass: () => freshPass(), kick: () => void pass(), agent });
const adminHandler = async (req: Request): Promise<Response> => {
	try {
		const { op, args } = (await req.json()) as { op: keyof AdminOps; args: never };
		if (!Object.hasOwn(admin, op)) return Response.json({ ok: false, error: `unknown op ${String(op)}` }, { status: 400 });
		return Response.json({ ok: true, result: await admin[op](stamped(op, args) as never) });
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
// The dev desktop's Spotify login, re-sent every minute while it runs (see the
// header). A silent desktop takes the playlist reader away before the polls
// could start failing and backing off.
const USER_TOKEN_TTL_MS = 3 * 60_000;
let userToken: { value: string; at: number } | null = null;
const liveUserToken = (): string | null => (userToken && Date.now() - userToken.at < USER_TOKEN_TTL_MS ? userToken.value : null);
// This catalogue's own Spotify login (local-spotify.ts) comes first, so
// playlists are read with nothing else running; the desktop's is the stand-in.
const spotifyLogin = createLocalSpotifyLogin({ db, log, dir, port: PORT, clientId: process.env.CURATOR_SPOTIFY_CLIENT_ID?.trim() || null });
await spotifyLogin.reload();
const playlistReader = new SpotifyUserPlaylistTracker({
	// By the playlist's watcher, as the cloud does; the desktop's token stands
	// in for whoever it is.
	token: watcherPlaylistToken(db, async (userId) => {
		if (spotifyLogin.connected()) {
			try {
				return await spotifyLogin.token(userId);
			} catch {
				// Not this watcher's login, or Spotify refused it: the desktop's, if any.
			}
		}
		const token = liveUserToken();
		if (!token) throw new Error('no Spotify login: connect one in the back office, or run the dev desktop');
		return token;
	}),
}, readers.spotifyFetch);
const trackerAdapters = (): TrackerAdapter[] => (spotifyLogin.connected() || liveUserToken() ? [...readers.adapters, playlistReader] : readers.adapters);

// `worker` is the page's answer to "why has my check not run yet".
const worker: WorkerStatus = { running: false, step: null, stepStartedAt: null, startedAt: null, finishedAt: null, steps: [], lastPass: null };
// Closes the running step (its time into `steps`) and opens the next.
const stepTo = (next: string | null): void => {
	const now = Date.now();
	if (worker.step && worker.stepStartedAt) worker.steps.push({ step: worker.step, ms: now - worker.stepStartedAt });
	worker.step = next;
	worker.stepStartedAt = next ? now : null;
};
const backoffice = createBackofficeHandler(db, {
	library: () => library,
	worker: () => worker,
	readers: trackerAdapters,
	readerNotes: () =>
		spotifyLogin.connected() || liveUserToken()
			? []
			: [{ provider: 'spotify', kind: 'playlist', why: 'no Spotify login: connect one for the local catalogue (Tracking → Connect Spotify), or run the dev desktop with Spotify connected' }],
});

// The shim's auth.users stands in for Supabase's: the signed-in user's row
// is made on first sight (the token is still verified by the API itself).
const seen = new Set<string>();
const withUser = async (req: Request): Promise<Response> => {
	if (new URL(req.url).pathname === '/admin' && req.method === 'POST') {
		if (!fromThisMachinesPages({ method: req.method, host: req.headers.get('host'), contentType: req.headers.get('content-type') }, PORT)) return new Response('not from here', { status: 403 });
		return adminHandler(req);
	}
	if (new URL(req.url).pathname === '/local/spotify-user-token' && req.method === 'POST') {
		// JSON only: a web page cannot send that here without a preflight, which
		// this server does not answer. Nothing reads the token back.
		if (!req.headers.get('content-type')?.startsWith('application/json')) return new Response('json only', { status: 415 });
		const { accessToken } = (await req.json()) as { accessToken?: unknown };
		const first = !liveUserToken();
		userToken = typeof accessToken === 'string' && accessToken ? { value: accessToken, at: Date.now() } : null;
		if (first && userToken && !spotifyLogin.connected()) console.log('Spotify playlists: reading with the desktop’s login.');
		return Response.json({ ok: true });
	}
	const login = await spotifyLogin.handle(req);
	if (login) return login;
	const page = await backoffice(req);
	if (page) return page;
	const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
	const payload = token?.split('.')[1];
	if (payload) {
		try {
			const sub = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string }).sub;
			if (sub && /^[0-9a-f-]{36}$/i.test(sub) && !seen.has(sub)) {
				await pg.query('insert into auth.users (id) values ($1) on conflict do nothing', [sub]);
				// Whoever reaches the local catalogue is its operator: their
				// "connect the dots" answers stand without a second check (connect.ts).
				await pg.query('insert into curator.admin_user (user_id) values ($1) on conflict do nothing', [sub]);
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

console.log(`Trackers: ${readers.adapters.map((a) => a.provider).join(', ')}`);
console.log(`Store links by UPC/ISRC: ${Object.entries(readers.stores).filter(([, r]) => r).map(([name]) => name).join(', ') || 'none'}${readers.stores.tidal ? '' : ' (no CURATOR_TIDAL_APP_CLIENT_ID/SECRET)'}`);
if (tidalCredentials(process.env)?.borrowed) console.log(TIDAL_BORROWED_NOTE);
if (!readers.spotify) {
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
	worker.running = true;
	worker.startedAt = Date.now();
	worker.steps = [];
	current = (async () => {
		await runPass({ db, log, holder: 'local', readers, adapters: trackerAdapters, agent }, { onStep: stepTo });
		if (Date.now() - analyzedAt > ANALYZE_EVERY_MS) await analyze().catch((e: unknown) => log.error('analyze_failed', { error: e }));
	})().finally(() => {
		current = null;
		stepTo(null);
		worker.running = false;
		worker.finishedAt = Date.now();
		worker.lastPass = { startedAt: worker.startedAt!, ms: worker.finishedAt - worker.startedAt!, steps: worker.steps };
	});
	return current;
}
const freshPass = async (): Promise<void> => {
	if (current) await current;
	await pass();
};
const timer = setInterval(() => void pass(), PASS_EVERY_MS);
// The API's own timer in production (server.ts): event cards kept current.
let rebuilding = false;
setInterval(() => {
	if (rebuilding) return;
	rebuilding = true;
	void rebuildCards(db)
		.catch((e: unknown) => log.error('card_rebuild_failed', { error: e }))
		.finally(() => {
			rebuilding = false;
		});
}, 60_000).unref();
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
