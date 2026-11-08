// The catalogue back office in a browser, against the cloud's database
// (`DATABASE_URL=… pnpm --filter @curator/cloud backoffice`). Dev only, like
// cli/local.ts: loopback, no auth, never bundled (scripts/build.mjs has no
// entry for it). Every query runs in a read-only transaction.
//
// Without DATABASE_URL there is nothing to open here: the local catalogue's
// PGlite is single-process, so the running local server serves the same page
// itself at /backoffice.

import { createServer } from 'node:http';
import { createBackofficeHandler } from '../backoffice/handler.js';
import { adminOps, type AdminOps } from '../catalog/admin-ops.js';
import { assertConnectionString, createPostgresDb } from '../db/db.js';

const PORT = Number(process.env.CURATOR_BACKOFFICE_PORT ?? 8790);
const localPort = process.env.CURATOR_LOCAL_CLOUD_PORT ?? '8787';

const url = process.env.DATABASE_URL?.trim();
if (!url) {
	console.error(`No DATABASE_URL. For the local catalogue, open http://127.0.0.1:${localPort}/backoffice (start it with \`pnpm --filter @curator/cloud local\`).`);
	process.exit(1);
}
assertConnectionString(url);
const db = createPostgresDb(url, { max: 4 });
const backoffice = createBackofficeHandler(db);
// The page's one write path: the operator resolving inbox items and asking for
// a check. Only those ops reach the cloud from here; the rest of the back
// office stays the CLI's. A check only makes cursors due: the cloud's worker
// reads them, under its own budgets.
const PAGE_OPS: readonly (keyof AdminOps)[] = ['inboxList', 'inboxCounts', 'inboxGet', 'inboxDecide', 'inboxSnooze', 'trackingCheck'];
const admin = adminOps(db, {});
const handler = async (req: Request): Promise<Response> => {
	const res = await backoffice(req);
	if (res) return res;
	if (new URL(req.url).pathname === '/admin' && req.method === 'POST') {
		try {
			const { op, args } = (await req.json()) as { op: keyof AdminOps; args: never };
			if (!PAGE_OPS.includes(op)) return Response.json({ ok: false, error: `${String(op)} is not served here: use the catalog CLI` }, { status: 403 });
			return Response.json({ ok: true, result: await admin[op](args) });
		} catch (e) {
			return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
		}
	}
	return new URL(req.url).pathname === '/' ? Response.redirect(new URL('/backoffice', req.url), 302) : new Response('not found', { status: 404 });
};

const server = createServer((req, res) => {
	void (async () => {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const body = chunks.length && req.method !== 'GET' ? Buffer.concat(chunks) : null;
		const out = await handler(new Request(`http://127.0.0.1:${PORT}${req.url ?? '/'}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? 'application/json' }, ...(body ? { body } : {}) })).catch(
			(e: unknown) => new Response(e instanceof Error ? e.message : String(e), { status: 500 }),
		);
		res.writeHead(out.status, Object.fromEntries(out.headers));
		res.end(Buffer.from(await out.arrayBuffer()));
	})();
});
server.listen(PORT, '127.0.0.1', () => console.log(`Catalogue back office (cloud database, read-only) on http://127.0.0.1:${PORT}/backoffice`));

const stop = async () => {
	server.close();
	await db.close();
	process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
