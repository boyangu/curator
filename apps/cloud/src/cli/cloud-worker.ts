// The catalogue's upkeep, run from the operator's machine against the cloud's
// database (`pnpm cloud:worker`). Dev only, like cli/local.ts: never bundled
// (scripts/build.mjs has no entry for it). The cloud runs no worker of its own:
// its sources are read by the desktops and from here.
//
//   pnpm cloud:worker                    a pass a minute until Ctrl+C, with the
//                                        back office on http://127.0.0.1:8787/backoffice
//   pnpm cloud:worker --once             one pass, then exit (1 when a step failed)
//   pnpm cloud:worker --once --only "trackers,store links"
//
// It connects as `curator_worker` (sql/roles.sql: the catalogue's tables and
// nothing of anyone's library) with CURATOR_WORKER_DATABASE_URL from the
// git-ignored root .env. Readers: worker/pass.ts. Spotify playlists are not
// read here: that takes a person's login, which the desktops have.
//
// The same port and `/admin` path as the local catalogue, so `catalog` (the
// back-office CLI) works against it unchanged.

import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { createBackofficeHandler, type WorkerStatus } from '../backoffice/handler.js';
import { adminOps, type AdminOps } from '../catalog/admin-ops.js';
import { agentReasonerConfig, describeReasoner, reasonerModel } from '../catalog/agent/config.js';
import { TIDAL_BORROWED_NOTE, tidalCredentials } from '../config.js';
import { assertConnectionString, createPostgresDb } from '../db/db.js';
import { migrationGate } from '../db/migration-gate.js';
import { createLogger } from '../log.js';
import { PASS_STEPS, readersFromEnv, runPass } from '../worker/pass.js';
import { fromThisMachinesPages } from './loopback.js';

const PORT = Number(process.env.CURATOR_LOCAL_CLOUD_PORT ?? 8787);
const PASS_EVERY_MS = 60_000;

const once = process.argv.includes('--once');
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt === -1 ? undefined : (process.argv[onlyAt + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const unknown = (only ?? []).filter((n) => !PASS_STEPS.some((s) => s.name === n));
if (only && (only.length === 0 || unknown.length)) {
	console.error(`--only takes ${PASS_STEPS.map((s) => s.name).join(', ')}${unknown.length ? ` (not ${unknown.join(', ')})` : ''}`);
	process.exit(1);
}

const url = process.env.CURATOR_WORKER_DATABASE_URL?.trim();
if (!url) {
	console.error('Set CURATOR_WORKER_DATABASE_URL in the root .env (the curator_worker connection, .env.example).');
	process.exit(1);
}
assertConnectionString(url);
// Never the owner's or the API's: this process listens on a port.
if (!/^curator_worker([.]|$)/.test(decodeURIComponent(new URL(url).username))) {
	console.error('CURATOR_WORKER_DATABASE_URL must be the curator_worker role (sql/roles.sql; value not shown).');
	process.exit(1);
}

const log = createLogger((line) => {
	const j = JSON.parse(line) as { level: string; msg: string; [k: string]: unknown };
	if (j.level !== 'debug') console.log(`[${j.level}] ${j.msg}`, Object.fromEntries(Object.entries(j).filter(([k]) => !['level', 'msg', 'ts', 'time'].includes(k))));
});

// On the session pooler whatever port the URL names: it keeps prepared
// statements, and from here a statement is a trip around half the world (130 ms
// against 280, and several issued together share one; 2026-11-25).
const sessionUrl = new URL(url);
if (sessionUrl.hostname.endsWith('.pooler.supabase.com')) sessionUrl.port = '5432';
const db = createPostgresDb(sessionUrl.toString(), { max: 4, prepare: true });
const schemaOk = await migrationGate(db, log).catch((e: unknown) => {
	log.error('migration_gate_failed', { error: e });
	return false;
});
if (!schemaOk) {
	await db.close().catch(() => {});
	process.exit(1);
}

const readers = readersFromEnv(process.env, db);
const agentCfg = agentReasonerConfig(process.env);
const agent = agentCfg ? { model: reasonerModel(agentCfg), cfg: agentCfg } : null;
console.log(`Trackers: ${readers.adapters.map((a) => a.provider).join(', ')}`);
console.log(`Reasoner: ${describeReasoner(agentCfg)}`);
if (tidalCredentials(process.env)?.borrowed) console.log(TIDAL_BORROWED_NOTE);
const deps = { db, log, holder: `upkeep:${hostname()}:${process.pid}`, readers, agent };

const worker: WorkerStatus = { running: false, step: null, stepStartedAt: null, startedAt: null, finishedAt: null, steps: [], lastPass: null };
// Closes the running step (its time into `steps`) and opens the next.
const stepTo = (next: string | null): void => {
	const now = Date.now();
	if (worker.step && worker.stepStartedAt) worker.steps.push({ step: worker.step, ms: now - worker.stepStartedAt });
	worker.step = next;
	worker.stepStartedAt = next ? now : null;
};
let stopping = false;
// One pass at a time; `catalog pass` waits for the running one and then runs a
// fresh one (its work was queued after that one picked what it would do).
let current: Promise<string[]> | null = null;
function pass(): Promise<string[]> {
	if (current) return current;
	worker.running = true;
	worker.startedAt = Date.now();
	worker.steps = [];
	current = runPass(deps, { ...(only ? { only } : {}), onStep: stepTo, stopped: () => stopping }).finally(() => {
		current = null;
		stepTo(null);
		worker.running = false;
		worker.finishedAt = Date.now();
		worker.lastPass = { startedAt: worker.startedAt!, ms: worker.finishedAt - worker.startedAt!, steps: worker.steps };
	});
	return current;
}

if (once) {
	const failed = await pass();
	for (const s of worker.steps) console.log(`  ${s.step.padEnd(22)} ${String(s.ms).padStart(8)} ms${failed.includes(s.step) ? '   FAILED' : ''}`);
	await db.close();
	process.exit(failed.length ? 1 : 0);
}

const admin = adminOps(db, readers.stores, {
	pass: async () => {
		if (current) await current;
		await pass();
	},
	kick: () => void pass(),
	agent,
});
const backoffice = createBackofficeHandler(db, {
	worker: () => worker,
	readers: () => readers.adapters,
	readerNotes: () => [{ provider: 'spotify', kind: 'playlist', why: 'read by the desktops, with their Spotify login' }],
});
const handler = async (req: Request): Promise<Response> => {
	const path = new URL(req.url).pathname;
	if (path === '/admin' && req.method === 'POST') {
		try {
			const { op, args } = (await req.json()) as { op: keyof AdminOps; args: never };
			if (!Object.hasOwn(admin, op)) return Response.json({ ok: false, error: `unknown op ${String(op)}` }, { status: 400 });
			return Response.json({ ok: true, result: await admin[op](args) });
		} catch (e) {
			return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
		}
	}
	return (await backoffice(req)) ?? (path === '/' ? Response.redirect(new URL('/backoffice', req.url), 302) : new Response('not found', { status: 404 }));
};
const server = createServer((req, res) => {
	void (async () => {
		const method = req.method ?? 'GET';
		const contentType = req.headers['content-type'];
		if (!fromThisMachinesPages({ method, host: req.headers.host, contentType }, PORT)) {
			res.writeHead(403).end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const body = chunks.length && method !== 'GET' ? Buffer.concat(chunks) : null;
		const out = await handler(new Request(`http://127.0.0.1:${PORT}${req.url ?? '/'}`, { method, headers: { 'content-type': contentType ?? 'application/json' }, ...(body ? { body } : {}) })).catch(
			(e: unknown) => new Response(e instanceof Error ? e.message : String(e), { status: 500 }),
		);
		res.writeHead(out.status, Object.fromEntries(out.headers));
		res.end(Buffer.from(await out.arrayBuffer()));
	})();
});
server.once('error', () => {
	console.error(`Port ${PORT} is in use: the local catalogue or another copy is running. Stop it, or set CURATOR_LOCAL_CLOUD_PORT.`);
	process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Catalogue upkeep against the cloud's database. Back office: http://127.0.0.1:${PORT}/backoffice`));

const timer = setInterval(() => void pass(), PASS_EVERY_MS);
void pass();

async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.log('Stopping…');
	clearInterval(timer);
	server.close();
	// The step in flight finishes; what it leased and did not reach lapses on its own.
	const inFlight = current;
	if (inFlight) await Promise.race([inFlight, new Promise((r) => setTimeout(r, 60_000))]);
	await db.close().catch(() => {});
	process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
