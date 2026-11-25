// The plain-HTTP transport against a hand-written server: the requests it
// sends are the API's wire format, and each answer — a result, a refusal
// with its reason, a status with no usable body, no answer at all — comes
// back as what the sync client branches on. (e2e/src/cloud.test.ts runs it
// against the real server.)

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SNAPSHOT_STORAGE_ENCODING, snapshotPartPath, type SnapshotManifest } from '@curator/protocol';
import { CloudTransportError } from './client.js';
import { createFetchCloudTransport, type FetchTransportDeps, type HttpRequest, type HttpResponse } from './fetch-transport.js';
import { inflateSnapshotText } from './snapshot-storage.js';

const ok = (data: unknown): HttpResponse => ({ status: 200, body: JSON.stringify({ result: { data } }) });
const refused = (status: number, reason: string | null, extra: Record<string, unknown> = {}): HttpResponse =>
	({ status, body: JSON.stringify({ error: { message: reason ?? 'no', code: -32000, data: { httpStatus: status, reason, ...extra } } }) });

function rig(answer: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>, over: Partial<FetchTransportDeps> = {}) {
	const sent: HttpRequest[] = [];
	const transport = createFetchCloudTransport({
		apiUrl: 'https://api.test',
		request: async (req) => { sent.push(req); return answer(req); },
		session: () => ({ userId: 'u1', email: null }),
		accessToken: async () => 'tok',
		signOut: async () => {},
		snapshots: { upload: async () => {}, download: async () => { throw new Error('no parts here'); }, remove: async () => {} },
		inflate: (body, opts) => inflateSnapshotText(body, opts),
		client: 'test/1.0',
		...over,
	});
	return { transport, sent };
}

const kindOf = async (p: Promise<unknown>): Promise<string> => {
	try { await p; } catch (e) { if (e instanceof CloudTransportError) return e.kind; throw e; }
	throw new Error('expected the call to fail');
};

describe('plain-HTTP transport', () => {
	it('sends a query as GET with its input in the URL and a mutation as a JSON POST, both signed', async () => {
		const { transport, sent } = rig((req) => ok(req.method === 'GET' ? { ops: [], nextSeq: 7 } : { accepted: 0, rejected: [], maxSeq: 7 }));
		expect(await transport.sync.pull({ afterSeq: 7, deviceId: 'd & e' })).toEqual({ ops: [], nextSeq: 7 });
		await transport.sync.push({ deviceId: 'd1', ops: [] });
		await transport.account.devices();
		expect(sent[0]).toMatchObject({ method: 'GET', url: `https://api.test/trpc/sync.pull?input=${encodeURIComponent(JSON.stringify({ afterSeq: 7, deviceId: 'd & e' }))}` });
		expect(sent[0]!.body).toBeUndefined();
		expect(sent[1]).toMatchObject({ method: 'POST', url: 'https://api.test/trpc/sync.push', body: JSON.stringify({ deviceId: 'd1', ops: [] }) });
		expect(sent[1]!.headers).toMatchObject({ authorization: 'Bearer tok', 'x-curator-client': 'test/1.0', 'content-type': 'application/json' });
		// No input: no query string.
		expect(sent[2]!.url).toBe('https://api.test/trpc/account.devices');
		// A request id of its own each time.
		expect(new Set(sent.map((r) => r.headers['x-request-id'])).size).toBe(3);
	});

	it('asks the catalogue and its event stream as the router declares each procedure', async () => {
		const { transport, sent } = rig(() => ok({ events: [], nextSeq: 0 }));
		const id = '00000000-0000-4000-8000-000000000001';
		await transport.feed!.events({ deviceId: 'd1', afterSeq: 4 });
		await transport.feed!.recent({ deviceId: 'd1', days: 30 });
		await transport.catalog!.listWatches({ deviceId: 'd1' });
		await transport.catalog!.get({ deviceId: 'd1', id });
		await transport.catalog!.resolve({ deviceId: 'd1', refs: [{ provider: 'spotify', kind: 'artist', providerId: 'a1' }] });
		expect(sent.map((r) => `${r.method} ${r.url.replace('https://api.test/trpc/', '').split('?')[0]}`))
			.toEqual(['GET feed.events', 'GET feed.recent', 'GET catalog.listWatches', 'GET catalog.get', 'POST catalog.resolve']);
	});

	it('turns the server\'s refusals into the kinds the client branches on', async () => {
		const cases: Array<[HttpResponse, string]> = [
			[refused(403, 'device_revoked'), 'device_revoked'],
			[refused(412, 'device_not_registered'), 'device_not_registered'],
			[refused(426, 'update_required'), 'update_required'],
			[refused(429, 'rate_limited', { retryAfterSec: 30 }), 'rate_limited'],
			[refused(503, 'server_outdated'), 'server'],
			[refused(409, 'batch_gone'), 'batch_gone'],
			[refused(403, 'not_master'), 'not_master'],
			[refused(401, 'token_expired'), 'auth'],
			[refused(400, null), 'bad_request'],
			[{ status: 502, body: '<html>bad gateway</html>' }, 'server'],
			[{ status: 200, body: 'not json' }, 'server'],
		];
		for (const [answer, kind] of cases) {
			const { transport } = rig(() => answer);
			expect(await kindOf(transport.sync.pull({ afterSeq: 0 })), JSON.stringify(answer).slice(0, 60)).toBe(kind);
		}
		const { transport } = rig(() => refused(429, 'rate_limited', { retryAfterSec: 30 }));
		await expect(transport.sync.pull({ afterSeq: 0 })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
	});

	it('reports no answer as network, and no session as auth without asking', async () => {
		const offline = rig(() => { throw new Error('connection reset'); });
		expect(await kindOf(offline.transport.sync.pull({ afterSeq: 0 }))).toBe('network');
		const out = rig(() => ok({}), { session: () => null });
		expect(await kindOf(out.transport.sync.pull({ afterSeq: 0 }))).toBe('auth');
		expect(out.sent).toHaveLength(0);
	});

	it('bootstraps from the bucket: parts checked, text handed over in pieces, a replaced part read again', async () => {
		const json = JSON.stringify({ format: 'curator.library-state', version: 1, maps: { tags: [['t1', { id: 't1', created: null, fields: {} }]] } });
		const body = gzipSync(Buffer.from(json, 'utf8'));
		const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
		const path = snapshotPartPath('u1', sha(body));
		const manifest: SnapshotManifest = { encoding: SNAPSHOT_STORAGE_ENCODING, parts: [{ path, bytes: body.length, sha256: sha(body) }], totalBytes: body.length, sha256: sha(body), stateSha256: sha(Buffer.from(json, 'utf8')) };
		class Gone extends Error {}
		let downloads = 0;
		const { transport, sent } = rig(() => ok({ snapshotSeq: 9, baseSeq: 4, storage: manifest }), {
			snapshots: {
				upload: async () => {},
				remove: async () => {},
				// Pruned the first time: the transport asks for the manifest again.
				download: async (p) => { if (downloads++ === 0) throw new Gone(); expect(p).toBe(path); return Uint8Array.from(body); },
			},
			partGone: (err) => err instanceof Gone,
		});
		const boot = await transport.bootstrap({ deviceId: 'd1' });
		expect(boot).toMatchObject({ snapshotSeq: 9, baseSeq: 4 });
		let text = '';
		for await (const piece of boot.snapshot!) text += piece;
		expect(text).toBe(json);
		expect(sent).toHaveLength(2);
		expect(sent[0]!.url).toBe(`https://api.test/trpc/sync.bootstrap?input=${encodeURIComponent(JSON.stringify({ deviceId: 'd1', storage: true }))}`);

		// A part that does not match its manifest never reaches the inflater.
		const bad = rig(() => ok({ snapshotSeq: 9, baseSeq: 4, storage: manifest }), { snapshots: { upload: async () => {}, remove: async () => {}, download: async () => Uint8Array.from(body.subarray(1)) } });
		await expect(bad.transport.bootstrap()).rejects.toThrow(/does not match its manifest/);

		// No snapshot yet.
		const none = rig(() => ok({ snapshotSeq: 0, baseSeq: 0 }));
		expect(await none.transport.bootstrap()).toEqual({ snapshotSeq: 0, baseSeq: 0, snapshot: null });
	});
});
