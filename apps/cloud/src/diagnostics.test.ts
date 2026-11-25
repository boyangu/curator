import { CLIENT_LOG_MAX_RECORDS } from '@curator/protocol';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pruneClientLog, storeClientLog } from './diagnostics.js';
import { TokenBucketLimiter } from './rate-limit.js';
import { asUser, createTestApp, errorReason, roleDb, type TestApp } from './test/harness.js';

// What the phone's uploader sends (apps/mobile diag/UploaderTest.kt builds the
// same bytes from the same file).
const FIXTURE = JSON.parse(readFileSync(new URL('../../mobile/android/app/src/test/resources/diagnostics-upload.json', import.meta.url), 'utf8')) as {
	installId: string;
	appVersion: string;
	device: string;
	records: Record<string, unknown>[];
};

let app: TestApp;
beforeAll(async () => {
	app = await createTestApp();
});
afterAll(() => app.db.close());

const record = (n: number, over: Record<string, unknown> = {}) => ({ n, ts: 1_764_000_000_000 + n, level: 'info', proc: 'phone-ui', area: 'test', msg: `m${n}`, ...over });
const upload = (records: unknown[], over: Record<string, unknown> = {}) => ({ installId: randomUUID(), appVersion: '0.4.0', device: 'Sony XQ', records, ...over });
const rowsOf = (userId: string) =>
	app.db.query<{ n: unknown; level: string; proc: string; area: string; msg: string; data: string | null; err: string | null }>(
		`select n, level, proc, area, msg, data, err from curator.client_log where user_id = $1 order by n`,
		[userId],
	);

describe('diagnostics.upload', () => {
	it("stores the phone's batch, and a batch sent again once", async () => {
		const { api, userId } = await app.signIn();
		expect(await api.diagnostics.upload.mutate(FIXTURE)).toEqual({ stored: FIXTURE.records.length, rejected: 0 });
		expect(await api.diagnostics.upload.mutate(FIXTURE)).toEqual({ stored: 0, rejected: 0 });
		const rows = await rowsOf(userId);
		expect(rows.map((r) => r.msg)).toEqual(FIXTURE.records.map((r) => r.msg));
		expect(JSON.parse(rows[0]!.data!)).toEqual(FIXTURE.records[0]!.data);
		expect(JSON.parse(rows.at(-1)!.err!)).toEqual(FIXTURE.records.at(-1)!.err);
	});

	it('drops a malformed record alone, and keeps what jsonb would refuse', async () => {
		const { api, userId } = await app.signIn();
		const odd = record(2, { msg: 'nul \0 and half \ud83d', data: { a: 'x\0y', '\ud83d': '\ud83d' } });
		expect(await api.diagnostics.upload.mutate(upload([record(1), { n: 'x' }, odd, null]))).toEqual({ stored: 2, rejected: 2 });
		const [, r] = await rowsOf(userId);
		expect(r!.msg).toBe('nul  and half �');
		expect(JSON.parse(r!.data!)).toMatchObject({ a: 'x\0y' });
	});

	it('cuts an outsized record to a note that still reads as JSON', async () => {
		const { api, userId } = await app.signIn();
		await api.diagnostics.upload.mutate(upload([record(1, { data: { big: 'x'.repeat(100_000) } })]));
		const [r] = await rowsOf(userId);
		expect(Object.keys(JSON.parse(r!.data!) as object)).toEqual(['truncated']);
	});

	it('takes no more than one call holds, and a signed-in caller only', async () => {
		const { api } = await app.signIn();
		const many = Array.from({ length: CLIENT_LOG_MAX_RECORDS + 1 }, (_, i) => record(i));
		expect((await errorReason(api.diagnostics.upload.mutate(upload(many)))).code).toBe('BAD_REQUEST');
		expect((await errorReason(app.client().diagnostics.upload.mutate(upload([record(1)])))).code).toBe('UNAUTHORIZED');
	});

	it('still takes the log of a phone that was removed from the account', async () => {
		const { api, deviceId } = await app.signIn();
		await api.account.revokeDevice.mutate({ deviceId });
		expect((await errorReason(api.sync.pull.query({ afterSeq: 0, deviceId }))).reason).toBe('device_revoked');
		expect(await api.diagnostics.upload.mutate(upload([record(1)]))).toEqual({ stored: 1, rejected: 0 });
	});

	it("stops at the account's day, and says when to come back", async () => {
		const userId = await app.createUser();
		const db = roleDb(app.pg, 'curator_api');
		await storeClientLog(db, userId, upload([record(1), record(2)]), 2);
		await expect(storeClientLog(db, userId, upload([record(3)]), 2)).rejects.toMatchObject({ reason: 'client_log_full', retryAfterSec: 3_600 });
		// Another account's day is its own.
		expect(await storeClientLog(db, await app.createUser(), upload([record(1)]), 2)).toEqual({ stored: 1, rejected: 0 });
	});

	it('is rate limited per install', async () => {
		const own = await createTestApp({ limits: { clientLog: new TokenBucketLimiter(1, 0.001) } });
		const { api } = await own.signIn();
		const batch = upload([record(1)]);
		await api.diagnostics.upload.mutate(batch);
		expect((await errorReason(api.diagnostics.upload.mutate(batch))).reason).toBe('rate_limited');
		await api.diagnostics.upload.mutate(upload([record(1)]));
		await own.db.close();
	});
});

describe('client_log', () => {
	it('is nobody’s to read through a token, nor the API role’s', async () => {
		const { userId, api } = await app.signIn();
		await api.diagnostics.upload.mutate(upload([record(1)]));
		await expect(asUser(app.pg, userId, (tx) => tx.query('select * from curator.client_log'))).rejects.toThrow(/permission denied/);
		await expect(asUser(app.pg, userId, (tx) => tx.query(`select curator.prune_client_log('1 day')`))).rejects.toThrow(/permission denied/);
		await expect(roleDb(app.pg, 'curator_api').query('select * from curator.client_log')).rejects.toThrow(/permission denied/);
		await expect(roleDb(app.pg, 'curator_worker').query('select * from curator.client_log')).rejects.toThrow(/permission denied/);
	});

	it('keeps a week', async () => {
		const { userId, api } = await app.signIn();
		await api.diagnostics.upload.mutate(upload([record(1), record(2)]));
		await app.db.query(`update curator.client_log set received_at = now() - interval '7 days 1 hour' where user_id = $1 and n = 1`, [userId]);
		expect(await pruneClientLog(roleDb(app.pg, 'curator_api'))).toBe(1);
		expect((await rowsOf(userId)).map((r) => Number(r.n))).toEqual([2]);
	});
});
