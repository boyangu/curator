// The real server code (apps/cloud: migrations, RLS, the tRPC router, the
// snapshot checks) on an in-process PGlite, listening on this machine, with
// one account holding the dataset's snapshot as its master published it,
// and its ready-made replica when scripts/build-replica.mjs built one.
// What the driver's `sync` run talks to — from Node directly, from a phone
// through `adb reverse tcp:<port> tcp:<port>`.
//
//   cd apps/cloud && npx tsx ../../research/mobile/sync-core-spike/scripts/serve-cloud.ts
//       [--port 8799] [--name main] [--work c:/tmp/curator-mobile-spike] [--ops <ops.json>] [--feed <feed.json>]
//
// (Run from apps/cloud so tsx and the server's dependencies resolve there.)
//
// It writes <work>/<name>/server.json (the URL, the user and a token) and
// answers until `POST /control/exit`. Beside the API:
//   GET  /storage/<path>   a snapshot or replica part's bytes (the bucket holds only
//                          the object rows in this harness; the bytes are here)
//   POST /control/tail     pushes --ops into the account's log as the master
//   POST /control/feed     raises the next of --feed's `later` events
//   GET  /control/ops      the log's newest ops, as JSON (what a device pushed)
//   POST /control/exit     stops the server
// One account per process, so a fresh process gives every run the same log
// positions. Nothing real is reached: no Supabase, no network beyond loopback.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createTestApp, entitle, masterOp, uploadBlob } from '../../../../apps/cloud/src/test/harness.js';
import { CATALOGUE_UNIT_SCHEMA, catalogueBlobPath, MAX_CATALOGUE_PUT_ITEMS, MAX_PUSH_BYTES, MAX_PUSH_OPS, snapshotPartPath, type CatalogueItem, type Op, type ReplicaManifest, type SnapshotManifest } from '../../../../packages/protocol/src/index.js';

const args = process.argv.slice(2);
const arg = (name: string, fallback?: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(arg('port', '8799'));
const dir = join(resolve(arg('work', 'c:/tmp/curator-mobile-spike')!), arg('name', 'main')!);
const opsFile = arg('ops');

// The account's id is fixed (--user, default the dev account) so a replica
// built ahead by scripts/build-replica.mjs is the account's own, as a master
// builds it: a device installs it with no rebinding.
const DEV_USER = '00000000-0000-4000-8000-00000000c0de';
// --peaks <dir> (scripts/prepare-peaks.mjs): the analysis catalogue on, as
// production runs it, holding those waveforms; else off.
const peaksDir = arg('peaks');
const app = await createTestApp(peaksDir ? {} : { catalogue: null });
const userId = await app.createUser(arg('user', DEV_USER));
// Long enough for a phone left installed between dev sessions.
const token = await app.sign(userId, { exp: '30d' });
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

// The replica, published as the master would (sync.publishReplica), its
// parts re-filed under this account's prefix by their hashes.
let replicaSeq: number | null = null;
if (existsSync(join(dir, 'replica', 'manifest.json'))) {
	const built = JSON.parse(readFileSync(join(dir, 'replica', 'manifest.json'), 'utf8')) as { snapshotSeq: number; manifest: ReplicaManifest };
	if (built.snapshotSeq !== snapshotSeq) throw new Error(`the replica was built at seq ${built.snapshotSeq}; this account's snapshot is at ${snapshotSeq} (build-replica.mjs --seq)`);
	const rparts: ReplicaManifest['parts'] = [];
	for (const p of built.manifest.parts) {
		const bytes = readFileSync(join(dir, 'replica', `${p.sha256}.cgz`));
		const path = snapshotPartPath(userId, p.sha256);
		await uploadBlob(app.pg, userId, path, bytes.length, 'snapshots');
		blobs.set(path, bytes);
		rparts.push({ ...p, path });
	}
	const r = await api.sync.publishReplica.mutate({ deviceId: master, snapshotSeq, manifest: { ...built.manifest, parts: rparts } });
	if (r.status !== 'stored') throw new Error(`the replica was not stored: ${r.status}`);
	replicaSeq = snapshotSeq;
}

// The waveforms, as the master's catalogue uploader leaves them: each .cpk in
// the `catalogue` bucket under the account's prefix by its sha256, then one
// peaks item per tier naming it. The account is entitled, as a member is.
let peaksCount = 0;
if (peaksDir) {
	await entitle(app.pg, userId);
	const index = JSON.parse(readFileSync(join(peaksDir, 'index.json'), 'utf8')) as Array<{ hash: string; durationSec: number; tiers: Array<'hi' | 'lo'> }>;
	const items: CatalogueItem[] = [];
	for (const e of index) {
		if (!(e.durationSec > 0)) continue;
		// The lo tier only: production runs stage D-a, whose policy takes
		// `peaks:lo` (apps/cloud catalogue/policy.ts); hi comes with D-b.
		for (const tier of e.tiers.filter((t) => t === 'lo')) {
			const bytes = readFileSync(join(peaksDir, tier, `${e.hash.replace(':', '_')}.cpk`));
			const sha256 = createHash('sha256').update(bytes).digest('hex');
			const path = catalogueBlobPath(userId, 'peaks', sha256);
			await uploadBlob(app.pg, userId, path, bytes.length, 'catalogue').catch((err: unknown) => {
				// Content-addressed: two tracks with one waveform share the blob.
				if (!String(err).includes('duplicate key')) throw err;
			});
			blobs.set(path, bytes);
			items.push({
				audioHash: e.hash, version: [2, 5, 0], unitSchema: CATALOGUE_UNIT_SCHEMA.peaks, durationSec: e.durationSec, licence: null,
				unit: 'peaks', variant: tier, data: { blob: { path, sha256, bytes: bytes.length }, cpkVersion: bytes[8]! },
			});
		}
	}
	for (let i = 0; i < items.length; i += MAX_CATALOGUE_PUT_ITEMS) {
		const r = await api.catalogue.put.mutate({ deviceId: master, items: items.slice(i, i + MAX_CATALOGUE_PUT_ITEMS) });
		if (r.rejected.length > 0) throw new Error(`the catalogue refused ${r.rejected.length} waveforms: ${JSON.stringify(r.rejected[0])}`);
	}
	peaksCount = index.length;
}

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

// The Global Catalog's events for the account (--feed, scripts/make-feed.mjs):
// { watches: [{ id, kind, name, providerId, imageUrl? }], events, later },
// an event being { kind, subjectId, subjects, ago (ms), card }. Written as the
// catalogue's own rows, settled: what the trackers would have raised.
type FeedEvent = { kind: string; subjectId: string; subjects: string[]; ago: number; card: { title: string; kind: string; addedAt?: number; releaseDate?: string | null } };
const feed = arg('feed') ? (JSON.parse(readFileSync(resolve(arg('feed')!), 'utf8')) as { watches: Array<{ id: string; kind: string; name: string; providerId: string; imageUrl?: string | null }>; events: FeedEvent[]; later: FeedEvent[] }) : null;
async function catalogObject(id: string, kind: string, name: string, attrs: Record<string, unknown> = {}): Promise<void> {
	await app.pg.query(`insert into curator.catalog_object (id, kind, name, name_fold, attrs, discovered_via) values ($1, $2, $3, lower($3), $4::jsonb, 'tracker') on conflict (id) do nothing`, [id, kind, name, JSON.stringify(attrs)]);
}
async function raise(e: FeedEvent): Promise<void> {
	const at = Date.now() - e.ago;
	await catalogObject(e.subjectId, e.card.kind === 'track' ? 'recording' : 'release', e.card.title);
	for (const s of e.subjects) await catalogObject(s, 'artist', 'Feed test');
	const card = { ...e.card, ...(e.card.kind === 'track' ? { addedAt: at } : { releaseDate: new Date(at).toISOString().slice(0, 10) }) };
	const r = await app.pg.query<{ seq: string }>(
		`insert into curator.catalog_event (kind, subject_id, dedupe_key, release_at, first_seen_at, recordings_new, confidence, card)
		values ($1, $2, $3, to_timestamp($4::float8 / 1000), now() - interval '5 minutes', 1, 1, $5::jsonb) returning seq`,
		[e.kind, e.subjectId, `feed-test:${e.subjectId}`, at, JSON.stringify(card)],
	);
	for (const s of new Set(e.subjects)) await app.pg.query(`insert into curator.catalog_event_subject (seq, object_id) values ($1, $2)`, [r.rows[0]!.seq, s]);
}
if (feed) {
	for (const w of feed.watches) {
		await catalogObject(w.id, w.kind, w.name, w.imageUrl ? { image: w.imageUrl, imageUrl: w.imageUrl, coverUrl: w.imageUrl } : {});
		await app.pg.query(`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url) values ($1, 'spotify', $2, $3, null) on conflict do nothing`, [w.id, w.kind, w.providerId]);
		await app.pg.query(`insert into curator.catalog_watch (user_id, object_id, source) values ($1, $2, 'manual') on conflict do nothing`, [userId, w.id]);
	}
	// Oldest first, as a stream raises them.
	for (const e of [...feed.events].sort((a, b) => b.ago - a.ago)) await raise(e);
}
async function raiseLater(): Promise<{ raised: string | null; left: number }> {
	const e = feed?.later.shift();
	if (e) await raise(e);
	return { raised: e?.card.title ?? null, left: feed?.later.length ?? 0 };
}

const server = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on('data', (c: Buffer) => chunks.push(c));
	req.on('end', () => {
		void (async () => {
			const url = req.url ?? '/';
			// `encoding`: the API's own Content-Encoding, passed on with its body
			// (it gzips large answers for a client that asks, as Android's HTTP does).
			const send = (status: number, body: Buffer | string, type = 'application/json', encoding?: string | null): void => {
				const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
				res.writeHead(status, { 'content-type': type, 'content-length': buf.length, ...(encoding ? { 'content-encoding': encoding } : {}) });
				res.end(buf);
			};
			try {
				if (url.startsWith('/storage/')) {
					if (req.headers.authorization !== `Bearer ${token}`) return send(401, '{"error":"unauthorized"}');
					const blob = blobs.get(decodeURIComponent(url.slice('/storage/'.length)));
					return blob ? send(200, blob, 'application/octet-stream') : send(404, '{"error":"not_found"}');
				}
				if (url === '/control/tail' && req.method === 'POST') return send(200, JSON.stringify(await pushTail()));
				if (url === '/control/feed' && req.method === 'POST') return send(200, JSON.stringify(await raiseLater()));
				if (url === '/control/ops') {
					const r = await app.pg.query(`select seq::float8 as seq, device_id, entity, entity_id, kind, payload from curator.library_op where user_id = $1 order by seq desc limit 40`, [userId]);
					return send(200, JSON.stringify(r.rows));
				}
				if (url === '/control/exit' && req.method === 'POST') {
					send(200, '{"ok":true}');
					setTimeout(() => process.exit(0), 100);
					return;
				}
				const headers = new Headers();
				for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'content-length' && k !== 'connection') headers.set(k, v);
				const body = Buffer.concat(chunks);
				const answer = await app.handler(new Request(`http://127.0.0.1:${port}${url}`, { method: req.method, headers, ...(req.method === 'POST' ? { body } : {}) }));
				send(answer.status, Buffer.from(await answer.arrayBuffer()), answer.headers.get('content-type') ?? 'application/json', answer.headers.get('content-encoding'));
			} catch (err) {
				send(500, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
		})();
	});
});
server.listen(port, '127.0.0.1', () => {
	writeFileSync(join(dir, 'server.json'), JSON.stringify({ apiUrl: `http://127.0.0.1:${port}`, userId, token, snapshotSeq }, null, 1));
	console.log(`ready: http://127.0.0.1:${port}, snapshot at seq ${snapshotSeq} (${parts.length} parts)${replicaSeq !== null ? `, replica at seq ${replicaSeq}` : ''}${opsFile ? ', later ops on request' : ''}${peaksCount ? `, waveforms for ${peaksCount} recordings` : ''}${feed ? `, ${feed.events.length} feed events` : ''}`);
});
