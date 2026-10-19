import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DriveApiError, DriveClient, GoogleAuthError, refreshGoogleToken, type DriveFile } from './index.js';

const MiB = 1024 * 1024;
const BASE = { api: 'https://api.test/drive/v3', upload: 'https://api.test/upload/drive/v3' };

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: Buffer | null;
}

type Handler = (call: Call, index: number) => Response | Promise<Response>;

function bodyToBuffer(body: unknown): Buffer | null {
	if (body === undefined || body === null) return null;
	if (typeof body === 'string') return Buffer.from(body, 'utf8');
	if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
	if (body instanceof Uint8Array) return Buffer.from(body);
	throw new Error('fake fetch: unsupported body type');
}

function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((v, k) => {
			headers[k.toLowerCase()] = v;
		});
		const call: Call = { url, method: init?.method ?? 'GET', headers, body: bodyToBuffer(init?.body) };
		calls.push(call);
		if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
		return handler(call, calls.length - 1);
	};
	return { fetch: impl as typeof fetch, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function empty(status: number, headers: Record<string, string> = {}): Response {
	return new Response(null, { status, headers });
}

// TS 5.9 types Buffer over ArrayBufferLike, which BodyInit rejects; a copy
// into a plain Uint8Array is what a real server body looks like anyway.
function octets(status: number, buf: Buffer): Response {
	return new Response(new Uint8Array(buf), { status });
}

function networkError(): never {
	throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
}

function makeClient(fetchImpl: typeof fetch) {
	const sleeps: number[] = [];
	let tokenCalls = 0;
	const client = new DriveClient({
		accessToken: async () => {
			tokenCalls++;
			return `tok${tokenCalls}`;
		},
		fetch: fetchImpl,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		random: () => 0.5, // jitter factor exactly 1.0
		now: () => 1_700_000_000_000,
		baseUrls: BASE,
	});
	return { client, sleeps, tokenCalls: () => tokenCalls };
}

function parseRange(call: Call): { start: number; end: number; total: number } | null {
	const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(call.headers['content-range'] ?? '');
	return m ? { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) } : null;
}

// Position-dependent content so a chunk re-sent from the wrong offset can't
// pass the byte comparison by accident.
function patternBuffer(size: number): Buffer {
	const buf = Buffer.alloc(size);
	for (let i = 0; i + 4 <= size; i += 4) buf.writeUInt32LE((i / 4) >>> 0, i);
	return buf;
}

// A Drive-like resumable session: records chunk PUTs, answers 308 with the
// cumulative Range until the last byte lands. `sessions` are handed out by
// POST in order; `expired` URIs answer every request with 404.
function resumableHandler(o: {
	total: number;
	sessions: string[];
	fileId: string;
	preloaded?: number;
	expired?: string[];
}): { handler: Handler; chunks: Array<{ start: number; end: number; body: Buffer; session: string }>; probes: Call[] } {
	const chunks: Array<{ start: number; end: number; body: Buffer; session: string }> = [];
	const probes: Call[] = [];
	let sessionNo = 0;
	let received = o.preloaded ?? 0;
	const handler: Handler = (c) => {
		if (c.method === 'POST' && c.url.startsWith(`${BASE.upload}/files?uploadType=resumable`)) {
			const uri = o.sessions[sessionNo++];
			if (!uri) throw new Error('fake: no more sessions');
			received = 0;
			return empty(200, { Location: uri });
		}
		if (c.method === 'PUT' && o.expired?.includes(c.url)) {
			if ((c.headers['content-range'] ?? '').startsWith('bytes */')) probes.push(c);
			return json(404, { error: { errors: [{ reason: 'notFound' }], message: 'gone' } });
		}
		if (c.method === 'PUT' && o.sessions.includes(c.url)) {
			const cr = c.headers['content-range'] ?? '';
			if (cr.startsWith('bytes */')) {
				probes.push(c);
				return received > 0 ? empty(308, { Range: `bytes=0-${received - 1}` }) : empty(308);
			}
			const r = parseRange(c);
			if (!r || !c.body) return json(400, { error: { message: 'bad range' } });
			chunks.push({ start: r.start, end: r.end, body: c.body, session: c.url });
			received = r.end + 1;
			if (received < o.total) return empty(308, { Range: `bytes=0-${r.end}` });
			return json(200, { id: o.fileId });
		}
		throw new Error(`fake: unexpected ${c.method} ${c.url}`);
	};
	return { handler, chunks, probes };
}

let dir: string;
let bigPath: string;
let big: Buffer;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-gdrive-'));
	big = patternBuffer(20 * MiB);
	bigPath = join(dir, 'big.bin');
	writeFileSync(bigPath, big);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('uploadResumable', () => {
	it('sends 4 MiB chunks with correct Content-Range headers and opens the session before any byte', async () => {
		const session = 'https://api.test/upload/session/one';
		const { handler, chunks } = resumableHandler({ total: big.length, sessions: [session], fileId: 'file-1' });
		const { fetch, calls } = fakeFetch(handler);
		const { client } = makeClient(fetch);
		const progress: number[] = [];
		let sessionSeenAtCall = -1;
		const res = await client.uploadResumable('parent', 'big.bin', { path: bigPath, size: big.length }, {
			signal: new AbortController().signal,
			chunkBytes: 4 * MiB,
			appProperties: { sha256: 'abc' },
			onProgress: (n) => progress.push(n),
			onSession: (uri) => {
				expect(uri).toBe(session);
				sessionSeenAtCall = calls.length;
			},
		});
		expect(res).toEqual({ id: 'file-1' });
		// onSession fired right after the POST, before the first PUT.
		expect(sessionSeenAtCall).toBe(1);
		expect(calls[0]?.method).toBe('POST');
		expect(JSON.parse(calls[0]!.body!.toString('utf8'))).toEqual({ name: 'big.bin', parents: ['parent'], appProperties: { sha256: 'abc' } });
		expect(calls[0]?.headers['x-upload-content-length']).toBe(String(big.length));
		expect(chunks.map((c) => [c.start, c.end])).toEqual([
			[0, 4 * MiB - 1],
			[4 * MiB, 8 * MiB - 1],
			[8 * MiB, 12 * MiB - 1],
			[12 * MiB, 16 * MiB - 1],
			[16 * MiB, 20 * MiB - 1],
		]);
		expect(calls.slice(1).every((c) => c.headers['content-range']?.endsWith(`/${big.length}`))).toBe(true);
		expect(Buffer.concat(chunks.map((c) => c.body)).equals(big)).toBe(true);
		expect(progress.at(-1)).toBe(big.length);
		expect(progress).toEqual([...progress].sort((a, b) => a - b));
	});

	it('resumes a session from the server-reported offset without re-sending earlier bytes', async () => {
		const session = 'https://api.test/upload/session/resume';
		const { handler, chunks, probes } = resumableHandler({ total: big.length, sessions: [session], fileId: 'file-2', preloaded: 8 * MiB });
		const { fetch, calls } = fakeFetch(handler);
		const { client } = makeClient(fetch);
		let sessionCalls = 0;
		const res = await client.uploadResumable('parent', 'big.bin', { path: bigPath, size: big.length }, {
			signal: new AbortController().signal,
			chunkBytes: 4 * MiB,
			resume: { sessionUri: session, bytesSent: 8 * MiB },
			onProgress: () => {},
			onSession: () => {
				sessionCalls++;
			},
		});
		expect(res).toEqual({ id: 'file-2' });
		expect(sessionCalls).toBe(0);
		expect(calls.some((c) => c.method === 'POST')).toBe(false);
		// First request is the status probe: PUT, no body, `bytes */total`.
		expect(probes).toHaveLength(1);
		expect(calls[0]).toBe(probes[0]);
		expect(probes[0]?.body).toBeNull();
		expect(probes[0]?.headers['content-range']).toBe(`bytes */${big.length}`);
		expect(chunks.map((c) => [c.start, c.end])).toEqual([
			[8 * MiB, 12 * MiB - 1],
			[12 * MiB, 16 * MiB - 1],
			[16 * MiB, 20 * MiB - 1],
		]);
		expect(Math.min(...chunks.map((c) => c.start))).toBe(8 * MiB);
		expect(Buffer.concat(chunks.map((c) => c.body)).equals(big.subarray(8 * MiB))).toBe(true);
	});

	it('starts a new session when the resumed one has expired (404 on probe)', async () => {
		const dead = 'https://api.test/upload/session/dead';
		const fresh = 'https://api.test/upload/session/fresh';
		const { handler, chunks } = resumableHandler({ total: big.length, sessions: [fresh], expired: [dead], fileId: 'file-3' });
		const { fetch, calls } = fakeFetch(handler);
		const { client } = makeClient(fetch);
		const sessions: string[] = [];
		const res = await client.uploadResumable('parent', 'big.bin', { path: bigPath, size: big.length }, {
			signal: new AbortController().signal,
			chunkBytes: 4 * MiB,
			resume: { sessionUri: dead, bytesSent: 12 * MiB },
			onProgress: () => {},
			onSession: (uri) => sessions.push(uri),
		});
		expect(res).toEqual({ id: 'file-3' });
		expect(calls[0]?.url).toBe(dead);
		expect(calls[0]?.headers['content-range']).toBe(`bytes */${big.length}`);
		expect(calls[1]?.method).toBe('POST');
		expect(sessions).toEqual([fresh]);
		expect(chunks.every((c) => c.session === fresh)).toBe(true);
		expect(chunks[0]?.start).toBe(0);
		expect(Buffer.concat(chunks.map((c) => c.body)).equals(big)).toBe(true);
	});

	it('rejects with an AbortError when the signal fires mid-upload', async () => {
		const session = 'https://api.test/upload/session/abort';
		const ac = new AbortController();
		const { handler } = resumableHandler({ total: big.length, sessions: [session], fileId: 'x' });
		const { fetch } = fakeFetch((c, i) => {
			if (i === 1) ac.abort();
			return handler(c, i);
		});
		const { client } = makeClient(fetch);
		await expect(client.uploadResumable('parent', 'big.bin', { path: bigPath, size: big.length }, {
			signal: ac.signal,
			chunkBytes: 4 * MiB,
			onProgress: () => {},
		})).rejects.toMatchObject({ name: 'AbortError' });
	});
});

describe('retry policy', () => {
	it('backs off per Retry-After on a 403 rate limit, then succeeds', async () => {
		const { fetch, calls } = fakeFetch((_c, i) =>
			i === 0
				? json(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }], message: 'Rate Limit Exceeded' } }, { 'Retry-After': '7' })
				: json(200, { storageQuota: { limit: '100', usage: '40' }, user: { emailAddress: 'dj@example.com' } }),
		);
		const { client, sleeps } = makeClient(fetch);
		await expect(client.about()).resolves.toEqual({ email: 'dj@example.com', quotaBytes: 100, usedBytes: 40 });
		expect(calls).toHaveLength(2);
		expect(sleeps).toEqual([7000]);
	});

	it('retries a 503 with exponential backoff', async () => {
		const { fetch, calls } = fakeFetch((_c, i) => (i === 0 ? json(503, { error: { errors: [{ reason: 'backendError' }], message: 'Backend Error' } }) : json(200, { user: { emailAddress: 'a@b' } })));
		const { client, sleeps } = makeClient(fetch);
		await expect(client.about()).resolves.toEqual({ email: 'a@b', quotaBytes: null, usedBytes: null });
		expect(calls).toHaveLength(2);
		expect(sleeps).toEqual([1000]);
	});

	it('retries a network error', async () => {
		const { fetch, calls } = fakeFetch((_c, i) => (i === 0 ? networkError() : json(200, { user: { emailAddress: 'a@b' } })));
		const { client, sleeps } = makeClient(fetch);
		await expect(client.about()).resolves.toMatchObject({ email: 'a@b' });
		expect(calls).toHaveLength(2);
		expect(sleeps).toEqual([1000]);
	});

	it('re-asks for the access token once on 401', async () => {
		const { fetch, calls } = fakeFetch((_c, i) => (i === 0 ? json(401, { error: { errors: [{ reason: 'authError' }], message: 'Invalid Credentials' } }) : json(200, { user: { emailAddress: 'a@b' } })));
		const { client, sleeps, tokenCalls } = makeClient(fetch);
		await client.about();
		expect(tokenCalls()).toBe(2);
		expect(calls[0]?.headers['authorization']).toBe('Bearer tok1');
		expect(calls[1]?.headers['authorization']).toBe('Bearer tok2');
		expect(sleeps).toEqual([]);
	});

	it('gives up after 8 attempts with a retryable DriveApiError', async () => {
		const { fetch, calls } = fakeFetch(() => json(503, { error: { message: 'Backend Error' } }));
		const { client, sleeps } = makeClient(fetch);
		const err = await client.about().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DriveApiError);
		expect((err as DriveApiError).retryable).toBe(true);
		expect((err as DriveApiError).status).toBe(503);
		expect(calls).toHaveLength(8);
		expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 32000]);
	});

	it('fails fast on a non-retryable 4xx', async () => {
		const { fetch, calls } = fakeFetch(() => json(403, { error: { errors: [{ reason: 'storageQuotaExceeded' }], message: 'quota full' } }));
		const { client } = makeClient(fetch);
		const err = await client.about().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DriveApiError);
		expect((err as DriveApiError).retryable).toBe(false);
		expect((err as DriveApiError).reason).toBe('storageQuotaExceeded');
		expect(calls).toHaveLength(1);
	});
});

describe('list', () => {
	it('walks every page via nextPageToken', async () => {
		const pages = [
			{ nextPageToken: 'p2', files: [{ id: 'a', name: 'a', size: '10', createdTime: '2026-01-01T00:00:00Z', modifiedTime: '2026-01-01T00:00:00Z' }] },
			{ nextPageToken: 'p3', files: [{ id: 'b', name: 'b', size: '20', createdTime: '2026-01-02T00:00:00Z', modifiedTime: '2026-01-02T00:00:00Z' }] },
			{ files: [{ id: 'c', name: 'c', createdTime: '2026-01-03T00:00:00Z', modifiedTime: '2026-01-03T00:00:00Z', appProperties: { sha256: 'zz' } }] },
		];
		const { fetch, calls } = fakeFetch((_c, i) => json(200, pages[i]));
		const { client } = makeClient(fetch);
		const got: DriveFile[] = [];
		for await (const f of client.list('folder-1')) got.push(f);
		expect(got.map((f) => f.id)).toEqual(['a', 'b', 'c']);
		expect(got.map((f) => f.size)).toEqual([10, 20, null]);
		expect(got[2]?.appProperties).toEqual({ sha256: 'zz' });
		expect(calls).toHaveLength(3);
		const tokens = calls.map((c) => new URL(c.url).searchParams.get('pageToken'));
		expect(tokens).toEqual([null, 'p2', 'p3']);
		const q = new URL(calls[0]!.url).searchParams.get('q');
		expect(q).toBe("'folder-1' in parents and trashed = false");
		expect(new URL(calls[0]!.url).searchParams.get('pageSize')).toBe('1000');
	});

	it('findChild escapes quotes and backslashes and scopes to folders on request', async () => {
		const { fetch, calls } = fakeFetch(() => json(200, { files: [{ id: 'f1', name: "it's" }] }));
		const { client } = makeClient(fetch);
		await expect(client.findChild('p', "it's \\ back", { folder: true })).resolves.toEqual({ id: 'f1' });
		const q = new URL(calls[0]!.url).searchParams.get('q');
		expect(q).toBe("name = 'it\\'s \\\\ back' and 'p' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'");
	});
});

describe('download', () => {
	const content = patternBuffer(3000);

	it('resumes an existing .part with a Range request and appends', async () => {
		const dest = join(dir, 'dl-resume.bin');
		writeFileSync(`${dest}.part`, content.subarray(0, 1000));
		const { fetch, calls } = fakeFetch((c) => {
			const range = c.headers['range'];
			if (range !== 'bytes=1000-') return json(400, { error: { message: `unexpected range ${range}` } });
			return octets(206, content.subarray(1000));
		});
		const { client } = makeClient(fetch);
		const progress: number[] = [];
		await client.download('fid', dest, { signal: new AbortController().signal, expectedSize: content.length, onProgress: (n) => progress.push(n) });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${BASE.api}/files/fid?alt=media`);
		expect(readFileSync(dest).equals(content)).toBe(true);
		expect(existsSync(`${dest}.part`)).toBe(false);
		expect(progress.at(-1)).toBe(content.length);
	});

	it('restarts from zero when the server answers a ranged request with 200', async () => {
		const dest = join(dir, 'dl-restart.bin');
		writeFileSync(`${dest}.part`, Buffer.from('stale'));
		const { fetch } = fakeFetch(() => octets(200, content));
		const { client } = makeClient(fetch);
		await client.download('fid', dest, { signal: new AbortController().signal, expectedSize: content.length, onProgress: () => {} });
		expect(readFileSync(dest).equals(content)).toBe(true);
	});

	it('refuses a download whose size does not match', async () => {
		const dest = join(dir, 'dl-short.bin');
		const { fetch } = fakeFetch(() => octets(200, content.subarray(0, 100)));
		const { client } = makeClient(fetch);
		await expect(client.download('fid', dest, { signal: new AbortController().signal, expectedSize: content.length, onProgress: () => {} })).rejects.toBeInstanceOf(DriveApiError);
		expect(existsSync(dest)).toBe(false);
	});
});

describe('uploadSmall', () => {
	it('builds a multipart/related body with metadata + media parts', async () => {
		const { fetch, calls } = fakeFetch(() => json(200, { id: 'new-1' }));
		const { client } = makeClient(fetch);
		const bytes = Buffer.from('{"hello":"world"}');
		await expect(client.uploadSmall('parent', 'library.json', bytes, { mimeType: 'application/json', appProperties: { k: 'v' } })).resolves.toEqual({ id: 'new-1' });
		const c = calls[0]!;
		expect(c.method).toBe('POST');
		expect(c.url).toBe(`${BASE.upload}/files?uploadType=multipart&fields=id`);
		const m = /^multipart\/related; boundary=(.+)$/.exec(c.headers['content-type'] ?? '');
		expect(m).not.toBeNull();
		const boundary = m![1]!;
		const text = c.body!.toString('utf8');
		expect(text.startsWith(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`)).toBe(true);
		expect(text.endsWith(`\r\n--${boundary}--`)).toBe(true);
		const parts = text.split(`--${boundary}`);
		expect(parts).toHaveLength(4); // '', meta, media, '--'
		const metaJson = parts[1]!.split('\r\n\r\n')[1]!.replace(/\r\n$/, '');
		expect(JSON.parse(metaJson)).toEqual({ name: 'library.json', parents: ['parent'], appProperties: { k: 'v' } });
		const mediaPart = parts[2]!;
		expect(mediaPart.startsWith('\r\nContent-Type: application/json\r\n\r\n')).toBe(true);
		expect(mediaPart.split('\r\n\r\n')[1]).toBe(`${bytes.toString('utf8')}\r\n`);
	});

	it('overwrites in place via PATCH when replaceId is given (no parents in metadata)', async () => {
		const { fetch, calls } = fakeFetch(() => json(200, { id: 'old-1' }));
		const { client } = makeClient(fetch);
		await client.uploadSmall('parent', 'x.json', Buffer.from('1'), { replaceId: 'old-1' });
		expect(calls[0]?.method).toBe('PATCH');
		expect(calls[0]?.url).toBe(`${BASE.upload}/files/old-1?uploadType=multipart&fields=id`);
		expect(calls[0]!.body!.toString('utf8')).not.toContain('parents');
	});
});

describe('delete', () => {
	it('treats 404 as success', async () => {
		const { fetch } = fakeFetch(() => json(404, { error: { errors: [{ reason: 'notFound' }], message: 'not found' } }));
		const { client } = makeClient(fetch);
		await expect(client.delete('gone')).resolves.toBeUndefined();
	});
});

describe('refreshGoogleToken', () => {
	const cfg = {
		clientId: 'id',
		clientSecret: 'secret',
		redirectUri: 'http://127.0.0.1:0/auth/google/callback',
		scopes: 'https://www.googleapis.com/auth/drive.file',
		authorizeUrl: 'https://accounts.test/auth',
		tokenUrl: 'https://oauth.test/token',
	};

	it('maps invalid_grant to a GoogleAuthError with that code', async () => {
		const { fetch, calls } = fakeFetch(() => json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
		const err = await refreshGoogleToken(cfg, 'rt', fetch).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GoogleAuthError);
		expect((err as GoogleAuthError).code).toBe('invalid_grant');
		const form = new URLSearchParams(calls[0]!.body!.toString('utf8'));
		expect(form.get('grant_type')).toBe('refresh_token');
		expect(form.get('refresh_token')).toBe('rt');
		expect(form.get('client_id')).toBe('id');
		expect(form.get('client_secret')).toBe('secret');
	});

	it('returns the new access token and expiry', async () => {
		const { fetch } = fakeFetch(() => json(200, { access_token: 'at', expires_in: 3600, scope: 'x', token_type: 'Bearer' }));
		const before = Date.now();
		const res = await refreshGoogleToken(cfg, 'rt', fetch);
		expect(res.accessToken).toBe('at');
		expect(res.refreshToken).toBeUndefined();
		expect(res.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
	});
});
