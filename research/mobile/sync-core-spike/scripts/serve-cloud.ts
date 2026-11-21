// The real server code (apps/cloud: migrations, RLS, the tRPC router, the
// snapshot checks) on an in-process PGlite, listening on this machine, with
// one account holding the dataset's snapshot as its master published it.
// What the driver's `sync` run talks to — from Node directly, from a phone
// through `adb reverse tcp:<port> tcp:<port>`.
//
//   cd apps/cloud && npx tsx ../../research/mobile/sync-core-spike/scripts/serve-cloud.ts
//       [--port 8799] [--name main] [--work c:/tmp/curator-mobile-spike] [--ops <ops.json>]
//
// (Run from apps/cloud so tsx and the server's dependencies resolve there.)
//
// It writes <work>/<name>/server.json (the URL, the user and a token) and
// answers until `POST /control/exit`. Beside the API:
//   GET  /storage/<path>   a snapshot part's bytes (the bucket holds only
//                          the object rows in this harness; the bytes are here)
//   POST /control/tail     pushes --ops into the account's log as the master
//   POST /control/exit     stops the server
// One account per process, so a fresh process gives every run the same log
// positions. Nothing real is reached: no Supabase, no network beyond loopback.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createTestApp, masterOp, uploadBlob } from '../../../../apps/cloud/src/test/harness.js';
import { MAX_PUSH_BYTES, MAX_PUSH_OPS, snapshotPartPath, type Op, type SnapshotManifest } from '../../../../packages/protocol/src/index.js';

const args = process.argv.slice(2);
const arg = (name: string, fallback?: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(arg('port', '8799'));
const dir = join(resolve(arg('work', 'c:/tmp/curator-mobile-spike')!), arg('name', 'main')!);
const opsFile = arg('ops');

const app = await createTestApp({ catalogue: null });
const userId = await app.createUser();
const token = await app.sign(userId, { exp: '24h' });
const api = app.client(token);

// The master and its snapshot, as a desktop leaves an account.
const given = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { masterDevice: string | null; manifest: SnapshotManifest };
const master = given.masterDevice ?? 'desktop';
await api.account.registerDevice.mutate({ deviceId: master, name: 'Desktop', platform: 'win32' });
await api.sync.push.mutate({ deviceId: master, ops: [masterOp(master, master)] });
const blobs = new Map<string, Buffer>();
const parts: SnapshotManifest['parts'] = [];
for (const p of given.manifest.parts) {
	const bytes = readFileSync(join(dir, 'parts', `${p.sha256}.cgz`));
	if (createHash('sha256').update(bytes).digest('hex') !== p.sha256) throw new Error(`part ${p.sha256} does not match its name`);
	// The bucket's rule: a user's parts live under their own prefix.
	const path = snapshotPartPath(userId, p.sha256);
	await uploadBlob(app.pg, userId, path, bytes.length, 'snapshots');
	blobs.set(path, bytes);
	parts.push({ path, bytes: bytes.length, sha256: p.sha256 });
}
const head = async (): Promise<number> => (await app.pg.query<{ n: number | null }>(`select max(seq)::float8 as n from curator.library_op where user_id = $1`, [userId])).rows[0]?.n ?? 0;
const snapshotSeq = await head();
const published = await api.sync.publishSnapshot.mutate({ deviceId: master, snapshotSeq, manifest: { ...given.manifest, parts } });
if (published.status !== 'stored') throw new Error(`the snapshot was not stored: ${published.status}`);

// The later ops, pushed as the master in calls the server takes.
async function pushTail(): Promise<{ pushed: number; accepted: number; rejected: number; head: number }> {
	if (!opsFile) throw new Error('started without --ops');
	const ops = JSON.parse(readFileSync(resolve(opsFile), 'utf8')) as Op[];
	let accepted = 0;
	let rejected = 0;
	for (let i = 0; i < ops.length;) {
		const batch: Op[] = [];
		let bytes = 0;
		while (i < ops.length && batch.length < MAX_PUSH_OPS) {
			const size = Buffer.byteLength(JSON.stringify(ops[i]));
			if (batch.length > 0 && bytes + size > MAX_PUSH_BYTES * 0.8) break;
			batch.push(ops[i++]!);
			bytes += size;
		}
		const r = await api.sync.push.mutate({ deviceId: master, ops: batch });
		accepted += r.accepted;
		rejected += r.rejected.length;
	}
	return { pushed: ops.length, accepted, rejected, head: await head() };
}

const server = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on('data', (c: Buffer) => chunks.push(c));
	req.on('end', () => {
		void (async () => {
			const url = req.url ?? '/';
			const send = (status: number, body: Buffer | string, type = 'application/json'): void => {
				const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
				res.writeHead(status, { 'content-type': type, 'content-length': buf.length });
				res.end(buf);
			};
			try {
				if (url.startsWith('/storage/')) {
					if (req.headers.authorization !== `Bearer ${token}`) return send(401, '{"error":"unauthorized"}');
					const blob = blobs.get(decodeURIComponent(url.slice('/storage/'.length)));
					return blob ? send(200, blob, 'application/octet-stream') : send(404, '{"error":"not_found"}');
				}
				if (url === '/control/tail' && req.method === 'POST') return send(200, JSON.stringify(await pushTail()));
				if (url === '/control/exit' && req.method === 'POST') {
					send(200, '{"ok":true}');
					setTimeout(() => process.exit(0), 100);
					return;
				}
				const headers = new Headers();
				for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'content-length' && k !== 'connection') headers.set(k, v);
				const body = Buffer.concat(chunks);
				const answer = await app.handler(new Request(`http://127.0.0.1:${port}${url}`, { method: req.method, headers, ...(req.method === 'POST' ? { body } : {}) }));
				send(answer.status, Buffer.from(await answer.arrayBuffer()), answer.headers.get('content-type') ?? 'application/json');
			} catch (err) {
				send(500, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
		})();
	});
});
server.listen(port, '127.0.0.1', () => {
	writeFileSync(join(dir, 'server.json'), JSON.stringify({ apiUrl: `http://127.0.0.1:${port}`, userId, token, snapshotSeq }, null, 1));
	console.log(`ready: http://127.0.0.1:${port}, snapshot at seq ${snapshotSeq} (${parts.length} parts)${opsFile ? ', later ops on request' : ''}`);
});
