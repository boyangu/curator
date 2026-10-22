// Revoking a device cuts off its reads too ('device_reads', device-gate.ts):
// sync.pull and sync.bootstrap refuse a revoked device by the id they name
// and by the session they come from, the session is bound by every call
// that names a device, and Storage reads the same verdict. Plus the
// transition: reads without a device id stay served unless the server
// requires one.

import { randomUUID } from 'node:crypto';
import { catalogueBlobPath, SYNC_FEATURES } from '@curator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha } from '../test/catalogue-fixtures.js';
import { createTestApp, entitle, errorReason, opsFor, uploadBlob, type TestApp } from '../test/harness.js';

let app: TestApp;
beforeAll(async () => {
	app = await createTestApp();
});
afterAll(() => app.db.close());

type AuditRow = { kind: string; device_id: string | null; detail: Record<string, unknown> };

async function events(userId: string, kind: string): Promise<AuditRow[]> {
	await app.audit.flush();
	const r = await app.pg.query<AuditRow>(`select kind, device_id, detail from curator.audit_event where user_id = $1 and kind = $2 order by id`, [userId, kind]);
	return r.rows;
}

// One install of the account: its own Supabase session and device id.
async function install(userId: string, label: string, register = true) {
	const deviceId = `device-${label}-${randomUUID()}`;
	const api = app.client(await app.sign(userId, { sessionId: `session-${label}-${randomUUID()}` }));
	if (register) await api.account.registerDevice.mutate({ deviceId, name: label, platform: 'win32' });
	return { deviceId, api };
}

const REVOKED = { code: 'FORBIDDEN', reason: 'device_revoked' };

describe('a revoked device reads nothing', () => {
	it('refuses pull and bootstrap that name the revoked device, from any session, and audits each', async () => {
		const userId = await app.createUser();
		const laptop = await install(userId, 'laptop');
		const studio = await install(userId, 'studio');
		await studio.api.sync.push.mutate({ deviceId: studio.deviceId, ops: [opsFor(studio.deviceId)('tag', 'create', randomUUID(), { name: 'x', kind: 'user' })] });
		// Before the revoke the laptop reads like any device.
		expect((await laptop.api.sync.pull.query({ afterSeq: 0, deviceId: laptop.deviceId })).ops).toHaveLength(1);
		await laptop.api.sync.bootstrap.query({ deviceId: laptop.deviceId, storage: true });

		await studio.api.account.revokeDevice.mutate({ deviceId: laptop.deviceId });

		expect(await errorReason(laptop.api.sync.pull.query({ afterSeq: 0, deviceId: laptop.deviceId }))).toMatchObject(REVOKED);
		expect(await errorReason(laptop.api.sync.bootstrap.query({ deviceId: laptop.deviceId }))).toMatchObject(REVOKED);
		// Its id named from another (even the owner's) session is refused too.
		expect(await errorReason(studio.api.sync.pull.query({ afterSeq: 0, deviceId: laptop.deviceId }))).toMatchObject(REVOKED);
		// The studio itself carries on.
		expect((await studio.api.sync.pull.query({ afterSeq: 0, deviceId: studio.deviceId })).ops).toHaveLength(1);

		const reads = await events(userId, 'read_from_revoked_device');
		expect(reads.map((e) => [e.device_id, e.detail])).toEqual([
			[laptop.deviceId, { procedure: 'sync.pull', via: 'session' }],
			[laptop.deviceId, { procedure: 'sync.bootstrap', via: 'session' }],
			[laptop.deviceId, { procedure: 'sync.pull', via: 'device' }],
		]);
	});

	it('refuses the revoked device’s session whatever it names, or when it names nothing (an older desktop)', async () => {
		const userId = await app.createUser();
		const laptop = await install(userId, 'laptop');
		const studio = await install(userId, 'studio');
		await studio.api.account.revokeDevice.mutate({ deviceId: laptop.deviceId });

		// An older desktop: no device id on pull, no input on bootstrap.
		expect(await errorReason(laptop.api.sync.pull.query({ afterSeq: 0 }))).toMatchObject(REVOKED);
		expect(await errorReason(laptop.api.sync.bootstrap.query())).toMatchObject(REVOKED);
		// A modified one naming the studio's id.
		expect(await errorReason(laptop.api.sync.pull.query({ afterSeq: 0, deviceId: studio.deviceId }))).toMatchObject(REVOKED);
		const op = opsFor(studio.deviceId)('tag', 'create', randomUUID(), { name: 'forged', kind: 'user' });
		const pushed = await laptop.api.sync.push.mutate({ deviceId: studio.deviceId, ops: [op] });
		expect(pushed).toMatchObject({ accepted: 0, rejected: [{ opId: op.op_id, reason: 'device_revoked' }] });
		// Minting itself a fresh identity, or turning on the account's devices.
		expect(await errorReason(laptop.api.account.registerDevice.mutate({ deviceId: `fresh-${randomUUID()}`, name: 'x', platform: 'win32' }))).toMatchObject(REVOKED);
		expect(await errorReason(laptop.api.account.revokeDevice.mutate({ deviceId: studio.deviceId }))).toMatchObject(REVOKED);
		expect(await errorReason(laptop.api.account.devices.query())).toMatchObject(REVOKED);
		expect(await errorReason(laptop.api.catalogue.inventory.query({ deviceId: studio.deviceId, afterRev: 0 }))).toMatchObject(REVOKED);

		// None of it touched the studio: not revoked, "last seen" not moved by the forgery.
		const devices = await studio.api.account.devices.query();
		expect(devices.find((d) => d.deviceId === studio.deviceId)!.revokedAt).toBeNull();

		expect((await events(userId, 'read_from_revoked_device')).map((e) => e.detail)).toEqual([
			{ procedure: 'sync.pull', via: 'session' },
			{ procedure: 'sync.bootstrap', via: 'session' },
			{ procedure: 'sync.pull', via: 'session' },
		]);
		expect((await events(userId, 'push_from_revoked_device')).map((e) => e.detail)).toEqual([{ ops: 1, via: 'session' }]);
		expect((await events(userId, 'device_reregister_refused')).map((e) => e.detail)).toEqual([{ via: 'session' }]);
		expect((await events(userId, 'catalogue_rejected')).map((e) => e.detail)).toEqual([{ procedure: 'inventory', reason: 'device_revoked', via: 'session' }]);
	});

	it('binds a session on a read that names its device, so a later nameless read is judged by it', async () => {
		const userId = await app.createUser();
		const studio = await install(userId, 'studio');
		const laptop = await install(userId, 'laptop');
		// Another sign-in on the laptop that only ever pulled.
		const reader = app.client(await app.sign(userId, { sessionId: `reader-${randomUUID()}` }));
		await reader.sync.pull.query({ afterSeq: 0, deviceId: laptop.deviceId });
		await studio.api.account.revokeDevice.mutate({ deviceId: laptop.deviceId });
		expect(await errorReason(reader.sync.pull.query({ afterSeq: 0 }))).toMatchObject(REVOKED);
	});

	it('follows a session to the device it acts as now: revoking a re-minted install’s old id leaves it working', async () => {
		const userId = await app.createUser();
		const install1 = await install(userId, 'desk');
		// A restored backup re-mints the device id under the same session
		// (core sync-log/remint.ts) and registers the new one.
		const newId = `device-reminted-${randomUUID()}`;
		await install1.api.account.registerDevice.mutate({ deviceId: newId, name: 'desk', platform: 'win32' });
		const studio = await install(userId, 'studio');
		await studio.api.account.revokeDevice.mutate({ deviceId: install1.deviceId });
		await expect(install1.api.sync.pull.query({ afterSeq: 0, deviceId: newId })).resolves.toMatchObject({ ops: [] });
		await expect(install1.api.sync.pull.query({ afterSeq: 0 })).resolves.toMatchObject({ ops: [] });
	});

	it('lets a device revoke itself (Unlink), after which its session is refused', async () => {
		const userId = await app.createUser();
		const desk = await install(userId, 'desk');
		await desk.api.account.revokeDevice.mutate({ deviceId: desk.deviceId });
		expect(await errorReason(desk.api.sync.pull.query({ afterSeq: 0, deviceId: desk.deviceId }))).toMatchObject(REVOKED);
		// A new sign-in under a new device id is how it comes back.
		const back = await install(userId, 'desk again');
		await expect(back.api.sync.pull.query({ afterSeq: 0, deviceId: back.deviceId })).resolves.toMatchObject({ ops: [] });
	});

	it('answers device_not_registered for a read naming an unknown device', async () => {
		const userId = await app.createUser();
		const desk = await install(userId, 'desk');
		expect(await errorReason(desk.api.sync.pull.query({ afterSeq: 0, deviceId: 'never-registered' }))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'device_not_registered' });
		expect(await errorReason(desk.api.sync.bootstrap.query({ deviceId: 'never-registered' }))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'device_not_registered' });
	});
});

describe('the device_reads transition', () => {
	it('advertises device_reads and still serves reads that name no device from a live session', async () => {
		const h = await app.client().health.query();
		expect(h.features).toContain('device_reads');
		expect(SYNC_FEATURES).toContain('device_reads');
		const userId = await app.createUser();
		const desk = await install(userId, 'desk');
		await expect(desk.api.sync.pull.query({ afterSeq: 0 })).resolves.toMatchObject({ ops: [], features: expect.arrayContaining(['device_reads']) });
		await expect(desk.api.sync.bootstrap.query({ storage: true })).resolves.toMatchObject({ snapshotSeq: 0 });
	});

	it('cannot judge a session the server never saw: that gap is what requiring the device id closes', async () => {
		const userId = await app.createUser();
		const laptop = await install(userId, 'laptop');
		const studio = await install(userId, 'studio');
		await studio.api.account.revokeDevice.mutate({ deviceId: laptop.deviceId });
		// The laptop's older desktop signed in before the server bound
		// sessions and has not called since: nothing ties this session to it.
		const unseen = app.client(await app.sign(userId, { sessionId: `unseen-${randomUUID()}` }));
		await expect(unseen.sync.pull.query({ afterSeq: 0 })).resolves.toMatchObject({ ops: [] });

		const strict = await createTestApp({ requireDeviceId: true });
		try {
			const s = await strict.signIn();
			const UPDATE = { code: 'PRECONDITION_FAILED', reason: 'update_required' };
			expect(await errorReason(s.api.sync.pull.query({ afterSeq: 0 }))).toMatchObject(UPDATE);
			expect(await errorReason(s.api.sync.bootstrap.query({ storage: true }))).toMatchObject(UPDATE);
			await expect(s.api.sync.pull.query({ afterSeq: 0, deviceId: s.deviceId })).resolves.toMatchObject({ ops: [] });
			await expect(s.api.sync.bootstrap.query({ deviceId: s.deviceId, storage: true })).resolves.toMatchObject({ snapshotSeq: 0 });
		} finally {
			await strict.db.close();
		}
	});
});

describe('Storage for a revoked session (sql/storage.sql + curator.session_revoked())', () => {
	// As Storage runs a request: `authenticated`, with the device's own claims,
	// session id included.
	async function asSession<T>(userId: string, sessionId: string, sql: string, params: unknown[] = []): Promise<T[]> {
		return app.pg.transaction(async (tx) => {
			await tx.query(`select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true)`, [
				JSON.stringify({ sub: userId, role: 'authenticated', session_id: sessionId }),
			]);
			return (await tx.query<T>(sql, params as never[])).rows;
		});
	}

	it('hides the account’s objects from the revoked device’s session and refuses its uploads, not from the others', async () => {
		const userId = await app.createUser();
		await entitle(app.pg, userId);
		const laptopSession = `laptop-${randomUUID()}`;
		const laptopId = `laptop-${randomUUID()}`;
		const laptop = app.client(await app.sign(userId, { sessionId: laptopSession }));
		await laptop.account.registerDevice.mutate({ deviceId: laptopId, name: 'laptop', platform: 'win32' });
		const studio = await install(userId, 'studio');
		const path = catalogueBlobPath(userId, 'peaks', sha('revoked storage'));
		await uploadBlob(app.pg, userId, path, 100);
		const list = (session: string) => asSession<{ name: string }>(userId, session, `select name from storage.objects where bucket_id = 'catalogue'`);
		expect(await list(laptopSession)).toEqual([{ name: path }]);

		await studio.api.account.revokeDevice.mutate({ deviceId: laptopId });

		expect(await list(laptopSession)).toEqual([]);
		expect(await list(`other-${randomUUID()}`)).toEqual([{ name: path }]);
		await expect(
			asSession(userId, laptopSession, `insert into storage.objects (bucket_id, name, owner_id, metadata) values ('catalogue', $1, $2, '{"size": 1}')`, [
				catalogueBlobPath(userId, 'peaks', sha('late upload')),
				userId,
			]),
		).rejects.toThrow(/row-level security/);
		const deleted = await asSession<{ name: string }>(userId, laptopSession, `delete from storage.objects where name = $1 returning name`, [path]);
		expect(deleted).toEqual([]);
	});
});
