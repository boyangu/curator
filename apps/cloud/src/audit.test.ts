// The access log (curator.request_log) and audit trail (curator.audit_event):
// one row per HTTP request whatever its outcome, the request id round trip,
// the audit event per kind, nothing secret in any row, the writer's stdout
// fallback and buffer cap, retention, and who may touch the tables.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditWriter, pruneRequestLog, type RequestRow } from './audit.js';
import type { Queryable } from './db/db.js';
import { findSqlDir } from './db/migrate.js';
import { MAX_BODY_BYTES, toNodeListener, type BridgeResponse } from './http.js';
import { createLogger } from './log.js';
import { TokenBucketLimiter } from './rate-limit.js';
import { createKeys, createTestApp, createTestDb, errorReason, opsFor, type TestApp, type TestDb } from './test/harness.js';

const BASE = 'http://cloud.test';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type LogRow = RequestRow & { id: unknown };
type EventRow = { request_id: string | null; user_id: string | null; device_id: string | null; kind: string; detail: Record<string, unknown> };

async function requestRows(app: TestApp, requestId: string): Promise<LogRow[]> {
	await app.audit.flush();
	return app.db.query<LogRow>(
		`select id, request_id::text as request_id, user_id::text as user_id, device_id, session_id, procedure, http_status, reason,
			duration_ms, ops_in, ops_out, bytes_in, bytes_out, client_ip, client
		from curator.request_log where request_id = $1::uuid`,
		[requestId],
	);
}

async function events(app: TestApp, where: { userId?: string; kind?: string; requestId?: string }): Promise<EventRow[]> {
	await app.audit.flush();
	return app.db.query<EventRow>(
		`select request_id::text as request_id, user_id::text as user_id, device_id, kind, detail
		from curator.audit_event
		where ($1::uuid is null or user_id = $1::uuid) and ($2::text is null or kind = $2) and ($3::uuid is null or request_id = $3::uuid)
		order by id`,
		[where.userId ?? null, where.kind ?? null, where.requestId ?? null],
	);
}

const rid = (res: Response): string => {
	const id = res.headers.get('x-request-id');
	expect(id).toMatch(UUID_RE);
	return id!;
};

const post = (app: TestApp, path: string, body: unknown, headers: Record<string, string> = {}) =>
	app.handler(new Request(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));

const get = (app: TestApp, path: string, input: unknown, headers: Record<string, string> = {}) =>
	app.handler(new Request(`${BASE}${path}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, { headers }));

// ── request_log ─────────────────────────────────────────────────────────────

describe('request_log', () => {
	let app: TestApp;
	beforeAll(async () => {
		app = await createTestApp();
	});
	afterAll(() => app.db.close());

	it('writes one row per successful push with the verified ids, counts and sizes, and echoes the client request id', async () => {
		const { userId, token, deviceId } = await app.signIn();
		const op = opsFor(deviceId);
		const ops = [op('tag', 'create', randomUUID(), { name: 'a', kind: 'user' }), op('tag', 'create', randomUUID(), { name: 'b', kind: 'user' })];
		const sent = randomUUID();
		const res = await post(app, '/trpc/sync.push', { deviceId, ops }, {
			authorization: `Bearer ${token}`,
			'x-request-id': sent.toUpperCase(),
			'x-curator-client': `desktop/0.1.0 win32\u0007${'x'.repeat(200)}`,
			'fly-client-ip': '203.0.113.7',
			'x-forwarded-for': '198.51.100.1',
		});
		expect(res.status).toBe(200);
		expect(rid(res)).toBe(sent);
		const rows = await requestRows(app, sent);
		expect(rows).toHaveLength(1);
		const r = rows[0]!;
		expect(r).toMatchObject({
			user_id: userId,
			device_id: deviceId,
			session_id: `session-${userId}`,
			procedure: 'sync.push',
			http_status: 200,
			reason: null,
			ops_in: 2,
			ops_out: null,
			// Fly's header, never X-Forwarded-For.
			client_ip: '203.0.113.7',
		});
		// Control characters stripped, capped at 100.
		expect(r.client).toHaveLength(100);
		expect(r.client!.startsWith('desktop/0.1.0 win32x')).toBe(true);
		expect(r.bytes_in).toBeGreaterThan(100);
		expect(r.bytes_out).toBeGreaterThan(10);
		expect(r.duration_ms).toBeGreaterThanOrEqual(0);
	});

	it('counts pulled ops and mints an id when the client sends none or a non-UUID', async () => {
		const { token, deviceId, api } = await app.signIn();
		const op = opsFor(deviceId);
		await api.sync.push.mutate({ deviceId, ops: [op('tag', 'create', randomUUID(), { name: 'a', kind: 'user' }), op('tag', 'create', randomUUID(), { name: 'b', kind: 'user' })] });
		const res = await get(app, '/trpc/sync.pull', { afterSeq: 0 }, { authorization: `Bearer ${token}`, 'x-request-id': 'not-a-uuid' });
		expect(res.status).toBe(200);
		const id = rid(res);
		expect(id).not.toBe('not-a-uuid');
		const [r] = await requestRows(app, id);
		// Pull carries no device id: the column stays null, never guessed.
		expect(r).toMatchObject({ procedure: 'sync.pull', http_status: 200, ops_out: 2, device_id: null, ops_in: null });
		// The input travels in the query string; its size counts, the text does not.
		expect(r!.bytes_in).toBeGreaterThan(0);

		const minted = await get(app, '/trpc/health', undefined);
		const [h] = await requestRows(app, rid(minted));
		expect(h).toMatchObject({ procedure: 'health', http_status: 200, user_id: null });
	});

	it('logs an unauthenticated call with no user, even when the token names one', async () => {
		const res = await post(app, '/trpc/sync.push', { deviceId: 'd', ops: [] });
		expect(res.status).toBe(401);
		const [r] = await requestRows(app, rid(res));
		expect(r).toMatchObject({ procedure: 'sync.push', http_status: 401, reason: 'missing_token', user_id: null, device_id: null, ops_in: null });

		// Signed by a key the server does not trust: the `sub` is a claim, not
		// an identity, and must not reach the log.
		const victim = await app.createUser();
		const forged = await (await createKeys('attacker')).sign(victim);
		const res2 = await post(app, '/trpc/sync.push', { deviceId: 'd', ops: [] }, { authorization: `Bearer ${forged}` });
		expect(res2.status).toBe(401);
		const [r2] = await requestRows(app, rid(res2));
		expect(r2).toMatchObject({ reason: 'invalid_token', user_id: null, session_id: null });
		expect(await events(app, { requestId: rid(res2) })).toEqual([
			{ request_id: rid(res2), user_id: null, device_id: null, kind: 'auth_failed', detail: { reason: 'invalid_token' } },
		]);
	});

	it('logs an unknown path as http:404 and an unknown procedure by its path', async () => {
		const res = await app.handler(new Request(`${BASE}/admin?token=secret`));
		expect(res.status).toBe(404);
		const [r] = await requestRows(app, rid(res));
		expect(r).toMatchObject({ procedure: 'http:404', http_status: 404, reason: 'not_found', bytes_in: 0 });

		const res2 = await get(app, '/trpc/nope.nothing', undefined);
		expect(res2.status).toBe(404);
		const rows = await requestRows(app, rid(res2));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ procedure: 'nope.nothing', http_status: 404, reason: 'not_found' });
	});

	it('logs a procedure that fails inside as 500 with no internal detail, and a handler-level failure as http:500', async () => {
		const { token } = await app.signIn();
		const real = app.deps.db;
		app.deps.db = { ...real, begin: () => Promise.reject(new Error('relation "curator.secret_table" does not exist')) };
		try {
			const res = await get(app, '/trpc/sync.pull', { afterSeq: 0 }, { authorization: `Bearer ${token}` });
			expect(res.status).toBe(500);
			expect(await res.text()).not.toContain('secret_table');
			const rows = await requestRows(app, rid(res));
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ procedure: 'sync.pull', http_status: 500, reason: 'internal_server_error' });
		} finally {
			app.deps.db = real;
		}

		// A body that errors mid-read: tRPC never runs.
		const broken = new ReadableStream({
			pull(c) {
				c.error(new Error('socket reset'));
			},
		});
		const res = await app.handler(new Request(`${BASE}/trpc/sync.push`, { method: 'POST', body: broken, duplex: 'half' } as RequestInit));
		expect(res.status).toBe(500);
		const rows = await requestRows(app, rid(res));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ procedure: 'http:500', http_status: 500, reason: 'internal' });
	});

	it('logs a 413 from the node bridge, by declared length and by an oversized stream, with a request id', async () => {
		const listener = toNodeListener(app.handler, app.deps);
		const drive = async (headers: Record<string, string>, chunks: Buffer[]) => {
			const req = Object.assign(Readable.from(chunks), { headers, method: 'POST', url: '/trpc/sync.push' });
			const res = { status: 0, headers: {} as Record<string, string>, headersSent: false, done: null as null | (() => void) };
			const finished = new Promise<void>((resolve) => (res.done = resolve));
			const fake = {
				get headersSent() {
					return res.headersSent;
				},
				writeHead(status: number, h: Record<string, string>) {
					res.status = status;
					res.headers = h;
					res.headersSent = true;
					return this;
				},
				end() {
					res.done!();
					return this;
				},
			} as unknown as BridgeResponse;
			listener(req as never, fake);
			await finished;
			return res;
		};

		const declared = await drive({ 'content-length': String(MAX_BODY_BYTES + 1) }, []);
		expect(declared.status).toBe(413);
		const id1 = declared.headers['x-request-id']!;
		expect(id1).toMatch(UUID_RE);
		expect(await requestRows(app, id1)).toMatchObject([{ procedure: 'http:413', http_status: 413, reason: 'body_too_large' }]);

		const sent = randomUUID();
		const chunk = Buffer.alloc(256 * 1024);
		const streamed = await drive({ 'x-request-id': sent }, Array.from({ length: Math.ceil(MAX_BODY_BYTES / chunk.length) + 1 }, () => chunk));
		expect(streamed.status).toBe(413);
		expect(streamed.headers['x-request-id']).toBe(sent);
		expect(await requestRows(app, sent)).toHaveLength(1);

		// And a normal call through the bridge is logged once, by the handler.
		const ok = await drive({ 'content-type': 'application/json' }, [Buffer.from('{"deviceId":"d","ops":[]}')]);
		expect(ok.status).toBe(401);
		expect(await requestRows(app, ok.headers['x-request-id']!)).toHaveLength(1);
	});

	it('logs a rate-limited call with its reason and raises rate_limited', async () => {
		const limited = await createTestApp({ limits: { push: new TokenBucketLimiter(1, 0.001), pull: new TokenBucketLimiter(1, 0.001) } });
		try {
			const { userId, token, deviceId } = await limited.signIn();
			const auth = { authorization: `Bearer ${token}` };
			expect((await post(limited, '/trpc/sync.push', { deviceId, ops: [] }, auth)).status).toBe(200);
			const res = await post(limited, '/trpc/sync.push', { deviceId, ops: [] }, auth);
			expect(res.status).toBe(429);
			expect(await requestRows(limited, rid(res))).toMatchObject([{ http_status: 429, reason: 'rate_limited', user_id: userId, device_id: deviceId, ops_in: 0 }]);
			expect(await events(limited, { requestId: rid(res) })).toMatchObject([{ kind: 'rate_limited', user_id: userId, device_id: deviceId, detail: { bucket: 'push' } }]);

			await get(limited, '/trpc/sync.pull', { afterSeq: 0 }, auth);
			const pulled = await get(limited, '/trpc/sync.pull', { afterSeq: 0 }, auth);
			expect(pulled.status).toBe(429);
			expect(await events(limited, { requestId: rid(pulled) })).toMatchObject([{ kind: 'rate_limited', detail: { bucket: 'pull' } }]);
		} finally {
			await limited.db.close();
		}
	});
});

// ── audit_event ─────────────────────────────────────────────────────────────

describe('audit_event', () => {
	let app: TestApp;
	beforeAll(async () => {
		app = await createTestApp();
	});
	afterAll(() => app.db.close());

	it('records the device lifecycle, rejections, clamps, revoked pushes and bootstraps', async () => {
		const { userId, deviceId, api } = await app.signIn();
		await api.account.registerDevice.mutate({ deviceId, name: 'Renamed', platform: 'win32' });
		await api.account.registerDevice.mutate({ deviceId: 'phone', name: 'Phone', platform: 'ios' });

		const op = opsFor(deviceId);
		const good = op('tag', 'create', randomUUID(), { name: 'ok', kind: 'user' });
		const future = op('library_track', 'set-rating', randomUUID(), { rating: 2 }, Date.now() + 3600_000);
		const foreign = opsFor('someone-else')('tag', 'create', randomUUID(), { name: 'x', kind: 'user' });
		await api.sync.push.mutate({ deviceId, ops: [good, future, foreign, { op_id: 'junk' }] });
		await api.sync.bootstrap.query();

		await api.account.revokeDevice.mutate({ deviceId: 'phone' });
		expect(await errorReason(api.account.registerDevice.mutate({ deviceId: 'phone', name: 'Phone', platform: 'ios' }))).toMatchObject({ reason: 'device_revoked' });
		await api.sync.push.mutate({ deviceId: 'phone', ops: [opsFor('phone')('tag', 'create', randomUUID(), { name: 'late', kind: 'user' })] });

		const evs = await events(app, { userId });
		const byKind = (k: string) => evs.filter((e) => e.kind === k);
		expect(byKind('device_registered').map((e) => [e.device_id, e.detail])).toEqual([
			[deviceId, { platform: 'win32', created: true }],
			[deviceId, { platform: 'win32', created: false }],
			['phone', { platform: 'ios', created: true }],
		]);
		expect(byKind('client_ts_clamped')).toMatchObject([{ device_id: deviceId, detail: { count: 1 } }]);
		expect(byKind('client_ts_clamped')[0]!.detail.maxSkewMs).toBeGreaterThan(3500_000);
		expect(byKind('ops_rejected')).toMatchObject([{ device_id: deviceId, detail: { byReason: { not_owner: 1 } } }]);
		const byReason = byKind('ops_rejected')[0]!.detail.byReason as Record<string, number>;
		expect(Object.values(byReason).reduce((a, b) => a + b, 0)).toBe(2);
		expect(byKind('bootstrap_served')).toMatchObject([{ device_id: null, detail: { snapshotSeq: 0 } }]);
		expect(byKind('bootstrap_served')[0]!.detail.bytes).toBeGreaterThan(0);
		expect(byKind('device_revoked')).toMatchObject([{ device_id: 'phone', detail: {} }]);
		expect(byKind('device_reregister_refused')).toMatchObject([{ device_id: 'phone' }]);
		expect(byKind('push_from_revoked_device')).toMatchObject([{ device_id: 'phone', detail: { ops: 1 } }]);

		// Every event joins to the request that raised it.
		for (const e of evs) {
			expect(e.request_id).toMatch(UUID_RE);
			expect(await requestRows(app, e.request_id!)).toHaveLength(1);
		}
		// And each is on stdout too.
		expect(app.logs.some((l) => l.msg === 'push_from_revoked_device' && l.deviceId === 'phone' && l.userId === userId)).toBe(true);
	});

	it('keeps tokens, payloads, emails and query strings out of every logged row', async () => {
		const email = 'private.person@example.test';
		const marker = `payload-marker-${randomUUID()}`;
		const userId = await app.createUser();
		const token = await app.sign(userId, { claims: { email } });
		const deviceId = `device-${randomUUID()}`;
		const auth = { authorization: `Bearer ${token}` };
		await post(app, '/trpc/account.registerDevice', { deviceId, name: 'Desk', platform: 'win32' }, auth);
		const op = opsFor(deviceId);
		const ops = [op('tag', 'create', randomUUID(), { name: marker, kind: 'user' }), opsFor('other')('tag', 'create', randomUUID(), { name: marker, kind: 'user' })];
		await post(app, '/trpc/sync.push', { deviceId, ops }, auth);
		await get(app, '/trpc/sync.pull', { afterSeq: 0 }, auth);
		await get(app, '/trpc/sync.bootstrap', undefined, auth);
		await post(app, '/trpc/sync.push', { deviceId, ops }, { authorization: `Bearer ${token}x` });
		await app.handler(new Request(`${BASE}/elsewhere?q=${marker}`, { headers: auth }));

		await app.audit.flush();
		const dump = [
			...(await app.db.query<{ t: string }>('select row_to_json(r)::text as t from curator.request_log r')),
			...(await app.db.query<{ t: string }>('select row_to_json(e)::text as t from curator.audit_event e')),
		]
			.map((r) => r.t)
			.join('\n');
		expect(dump).toContain(userId);
		for (const secret of [token, token.split('.')[1]!, email, marker, 'Bearer', 'input=', 'afterSeq', '?q=']) expect(dump).not.toContain(secret);
		const stdout = JSON.stringify(app.logs);
		for (const secret of [token, email, marker]) expect(stdout).not.toContain(secret);
	});
});

// ── writer ──────────────────────────────────────────────────────────────────

function row(i: number, at = new Date().toISOString()): RequestRow {
	return {
		at,
		request_id: randomUUID(),
		user_id: null,
		device_id: null,
		session_id: null,
		procedure: `test.${i}`,
		http_status: 200,
		reason: null,
		duration_ms: 1,
		ops_in: null,
		ops_out: null,
		bytes_in: 0,
		bytes_out: 0,
		client_ip: null,
		client: null,
	};
}

describe('AuditWriter', () => {
	let t: TestDb;
	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(() => t.db.close());

	it('falls back to stdout when the database refuses, without failing or delaying the request', async () => {
		const failing: Queryable = {
			query: () => Promise.reject(new Error('connection refused')),
			exec: () => Promise.reject(new Error('connection refused')),
		};
		const app = await createTestApp({ auditDb: failing });
		try {
			const { api, userId } = await app.signIn();
			await expect(api.sync.pull.query({ afterSeq: 0 })).resolves.toMatchObject({ ops: [] });
			const res = await get(app, '/trpc/health', undefined);
			expect(res.status).toBe(200);
			await app.audit.flush();
			expect(app.logs.some((l) => l.msg === 'log_flush_failed' && l.level === 'error')).toBe(true);
			expect(app.logs.some((l) => l.msg === 'request_log_unsaved' && l.request_id === rid(res) && l.procedure === 'health')).toBe(true);
			expect(app.logs.some((l) => l.msg === 'audit_event_unsaved' && l.kind === 'device_registered' && l.user_id === userId)).toBe(true);
			expect(app.audit.buffered).toEqual({ request: 0, audit: 0 });
		} finally {
			await app.db.close();
		}
	});

	it('caps the buffer, spilling the oldest rows to stdout with a count, and keeps one query in flight', async () => {
		const logs: { msg: string; [k: string]: unknown }[] = [];
		const log = createLogger((line) => logs.push(JSON.parse(line) as (typeof logs)[number]));
		const w = new AuditWriter({ db: t.db, log, maxBuffered: 5, flushAt: 1000 });
		const rows = Array.from({ length: 12 }, (_, i) => row(i));
		for (const r of rows) w.request(r);
		expect(w.buffered.request).toBe(5);
		expect(logs.filter((l) => l.msg === 'request_log_unsaved').map((l) => l.procedure)).toEqual(rows.slice(0, 7).map((r) => r.procedure));
		await w.flush();
		expect(logs).toContainEqual(expect.objectContaining({ msg: 'log_buffer_overflow', kind: 'request', spilled: 7, maxBuffered: 5 }));
		const stored = await t.db.query<{ procedure: string }>(`select procedure from curator.request_log where procedure like 'test.%' order by id`);
		expect(stored.map((r) => r.procedure)).toEqual(rows.slice(7).map((r) => r.procedure));

		// A stalled database: flushes requested meanwhile coalesce onto the one
		// pending query instead of piling up.
		let calls = 0;
		let release!: () => void;
		const stalled: Queryable = {
			query: () => {
				calls++;
				return new Promise((resolve) => (release = () => resolve([])));
			},
			exec: async () => {},
		};
		const w2 = new AuditWriter({ db: stalled, log, flushAt: 1 });
		for (let i = 0; i < 50; i++) w2.request(row(i));
		expect(calls).toBe(1);
		release();
		await new Promise((r) => setTimeout(r, 0));
		release();
		await w2.flush();
		expect(w2.buffered.request).toBe(0);
		expect(calls).toBeLessThanOrEqual(3);
	});

	it('prunes request_log rows past the retention and leaves audit events alone', async () => {
		const day = 24 * 3600 * 1000;
		const keep = row(1, new Date(Date.now() - 89 * day).toISOString());
		const drop = row(2, new Date(Date.now() - 91 * day).toISOString());
		await t.db.query('select curator.log_requests($1::jsonb)', [JSON.stringify([keep, drop])]);
		await t.db.query('select curator.log_audit_events($1::jsonb)', [
			JSON.stringify([{ at: new Date(Date.now() - 400 * day).toISOString(), request_id: null, user_id: null, device_id: null, kind: 'auth_failed', detail: { reason: 'old' } }]),
		]);
		expect(await pruneRequestLog(t.db)).toBe(1);
		const left = await t.db.query<{ request_id: string }>('select request_id::text as request_id from curator.request_log where request_id in ($1::uuid, $2::uuid)', [
			keep.request_id,
			drop.request_id,
		]);
		expect(left).toEqual([{ request_id: keep.request_id }]);
		expect(await t.db.query(`select 1 from curator.audit_event where detail ->> 'reason' = 'old'`)).toHaveLength(1);
	});
});

// ── permissions ─────────────────────────────────────────────────────────────

describe('log table permissions (sql/0002_audit.sql + sql/roles.sql)', () => {
	let t: TestDb;
	let userId: string;
	beforeAll(async () => {
		t = await createTestDb();
		await t.db.exec(readFileSync(join(findSqlDir(), 'roles.sql'), 'utf8'));
		userId = await t.createUser();
		await t.db.query('select curator.log_requests($1::jsonb)', [JSON.stringify([{ ...row(0), user_id: userId }])]);
		await t.db.query('select curator.log_audit_events($1::jsonb)', [
			JSON.stringify([{ request_id: null, user_id: userId, device_id: null, kind: 'auth_failed', detail: {} }]),
		]);
	});
	afterAll(() => t.db.close());

	const asRole = (role: string, sql: string) =>
		t.db.begin(async (tx) => {
			await tx.query(`select set_config('role', $1, true), set_config('request.jwt.claims', $2, true)`, [role, JSON.stringify({ sub: userId, role })]);
			return tx.query(sql);
		});
	// The login role as the session user, the way production connects.
	// PGlite keeps a `set local session authorization` past the transaction
	// and cannot reset it (real Postgres reverts it at commit), so once this
	// runs the whole database is curator_api's: it is used by the last test
	// of this suite only, on this suite's own database.
	const asApi = (sql: string, role?: string) =>
		t.db.begin(async (tx) => {
			await tx.exec('set local session authorization curator_api');
			if (role) await tx.query(`select set_config('role', $1, true)`, [role]);
			return tx.query(sql);
		});

	const insertLog = `insert into curator.request_log (request_id, procedure, http_status, duration_ms) values (gen_random_uuid(), 'x', 200, 1)`;
	const insertEvent = `insert into curator.audit_event (kind) values ('x')`;

	it('gives authenticated and anon no read or write on either table, even for their own rows', async () => {
		for (const role of ['authenticated', 'anon']) {
			await expect(asRole(role, 'select * from curator.request_log')).rejects.toThrow(/permission denied/);
			await expect(asRole(role, 'select * from curator.audit_event')).rejects.toThrow(/permission denied/);
			await expect(asRole(role, insertLog)).rejects.toThrow(/permission denied/);
			await expect(asRole(role, insertEvent)).rejects.toThrow(/permission denied/);
			await expect(asRole(role, `select curator.log_requests('[]')`)).rejects.toThrow(/permission denied/);
			await expect(asRole(role, `select curator.log_audit_events('[]')`)).rejects.toThrow(/permission denied/);
			await expect(asRole(role, `select curator.prune_request_log('1 day')`)).rejects.toThrow(/permission denied/);
		}
	});

	it('lets the API role write only through the functions, never update, delete or read', async () => {
		await expect(asApi(`select curator.log_requests('[{"request_id":"${randomUUID()}","procedure":"p","http_status":200,"duration_ms":1}]')`)).resolves.toHaveLength(1);
		await expect(asApi(`select curator.log_audit_events('[{"kind":"auth_failed","detail":{"reason":"x"}}]')`)).resolves.toHaveLength(1);
		await expect(asApi(`select curator.prune_request_log('90 days') as n`)).resolves.toEqual([{ n: 0 }]);
		for (const role of [undefined, 'authenticated']) {
			for (const table of ['request_log', 'audit_event']) {
				await expect(asApi(`update curator.${table} set device_id = 'x'`, role)).rejects.toThrow(/permission denied/);
				await expect(asApi(`delete from curator.${table}`, role)).rejects.toThrow(/permission denied/);
				await expect(asApi(`select * from curator.${table}`, role)).rejects.toThrow(/permission denied/);
			}
			await expect(asApi(insertLog, role)).rejects.toThrow(/permission denied/);
		}
	});
});
