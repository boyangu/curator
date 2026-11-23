import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { acceptsGzip, BodyTooLargeError, COMPRESS_MIN_BYTES, inflateBody, MAX_BODY_BYTES, readBody, toNodeListener, type BridgeResponse } from './http.js';
import type { AppDeps } from './trpc.js';

// The bridge alone, in front of a handler that answers what it was sent:
// the body it saw, its content-encoding, and padding to the size asked.
async function drive(headers: Record<string, string>, body: Buffer | null, pad = 0) {
	const seen: { body: string | null; encoding: string | null } = { body: null, encoding: null };
	const handler = async (req: Request) => {
		seen.body = req.body ? Buffer.from(await req.arrayBuffer()).toString() : null;
		seen.encoding = req.headers.get('content-encoding');
		return new Response(JSON.stringify({ ok: true, pad: 'x'.repeat(pad) }), { status: 200, headers: { 'content-type': 'application/json' } });
	};
	const deps = { log: { info() {}, error() {}, warn() {} }, audit: { request() {} } } as unknown as Pick<AppDeps, 'log' | 'audit'>;
	const req = Object.assign(Readable.from(body ? [body] : []), { headers, method: body ? 'POST' : 'GET', url: '/trpc/x' });
	const res = { status: 0, headers: {} as Record<string, string>, body: Buffer.alloc(0) as Buffer, headersSent: false };
	const finished = new Promise<void>((resolve) => {
		const fake = {
			get headersSent() { return res.headersSent; },
			writeHead(status: number, h: Record<string, string>) { res.status = status; res.headers = h; res.headersSent = true; return this; },
			end(out?: Buffer) { if (out) res.body = out; resolve(); return this; },
		} as unknown as BridgeResponse;
		toNodeListener(handler, deps)(req as never, fake);
	});
	await finished;
	return { ...res, seen };
}

describe('compression at the bridge', () => {
	it('reads Accept-Encoding as written: gzip, *, and q=0 refusals', () => {
		expect(acceptsGzip('gzip, deflate, br')).toBe(true);
		expect(acceptsGzip('br;q=1, gzip;q=0.5')).toBe(true);
		expect(acceptsGzip('*')).toBe(true);
		expect(acceptsGzip('gzip;q=0')).toBe(false);
		expect(acceptsGzip('br, zstd')).toBe(false);
		expect(acceptsGzip(null)).toBe(false);
	});

	it('gzips an answer for a client that accepts it, and only one worth compressing', async () => {
		const big = await drive({ 'accept-encoding': 'gzip, br' }, null, 50_000);
		expect(big.headers['content-encoding']).toBe('gzip');
		expect(big.headers['vary']).toBe('accept-encoding');
		expect(big.body.length).toBeLessThan(2_000);
		expect(JSON.parse(gunzipSync(big.body).toString()).pad).toHaveLength(50_000);

		const plain = await drive({}, null, 50_000);
		expect(plain.headers['content-encoding']).toBeUndefined();
		expect(JSON.parse(plain.body.toString()).pad).toHaveLength(50_000);

		const small = await drive({ 'accept-encoding': 'gzip' }, null, COMPRESS_MIN_BYTES / 4);
		expect(small.headers['content-encoding']).toBeUndefined();
	});

	it('says on every answer that it takes gzipped requests', async () => {
		expect((await drive({}, null)).headers['accept-encoding']).toBe('gzip');
	});

	it('inflates a gzipped request body before the handler sees it', async () => {
		const sent = JSON.stringify({ deviceId: 'd', ops: Array.from({ length: 200 }, (_, i) => ({ op_id: `op-${i}` })) });
		const r = await drive({ 'content-encoding': 'gzip', 'content-type': 'application/json' }, gzipSync(sent));
		expect(r.status).toBe(200);
		expect(r.seen.body).toBe(sent);
		expect(r.seen.encoding).toBeNull();
	});

	it('refuses a body that inflates past the cap, one that is not gzip, and an encoding it does not take', async () => {
		const bomb = gzipSync(Buffer.alloc(MAX_BODY_BYTES + 1024));
		expect(bomb.length).toBeLessThan(MAX_BODY_BYTES);
		expect((await drive({ 'content-encoding': 'gzip' }, bomb)).status).toBe(413);
		await expect(inflateBody(bomb)).rejects.toBeInstanceOf(BodyTooLargeError);
		expect((await drive({ 'content-encoding': 'gzip' }, Buffer.from('not gzip at all'))).status).toBe(400);
		const br = await drive({ 'content-encoding': 'br' }, Buffer.from('x'));
		expect(br.status).toBe(415);
		expect(br.headers['accept-encoding']).toBe('gzip');
	});
});

describe('readBody', () => {
	it('concatenates chunks under the cap', async () => {
		const body = await readBody(Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]));
		expect(body.toString()).toBe('{"a":1}');
	});

	it('stops reading once the cap is passed', async () => {
		const chunk = Buffer.alloc(64 * 1024);
		const many = Readable.from(Array.from({ length: Math.ceil(MAX_BODY_BYTES / chunk.length) + 1 }, () => chunk));
		await expect(readBody(many)).rejects.toBeInstanceOf(BodyTooLargeError);
		await expect(readBody(Readable.from([Buffer.alloc(11)]), 10)).rejects.toBeInstanceOf(BodyTooLargeError);
	});
});
