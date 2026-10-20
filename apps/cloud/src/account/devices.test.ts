import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorReason, type TestApp } from '../test/harness.js';

let app: TestApp;
beforeAll(async () => {
	app = await createTestApp();
});
afterAll(() => app.db.close());

describe('account devices', () => {
	it('registers, lists, refreshes and revokes devices', async () => {
		const { deviceId, api } = await app.signIn('desk');
		await api.account.registerDevice.mutate({ deviceId: 'phone', name: 'Phone', platform: 'ios' });
		await api.account.registerDevice.mutate({ deviceId, name: 'Studio desktop', platform: 'win32' });

		let devices = await api.account.devices.query();
		expect(devices.map((d) => [d.deviceId, d.name, d.platform, d.revokedAt])).toEqual([
			['desk', 'Studio desktop', 'win32', null],
			['phone', 'Phone', 'ios', null],
		]);
		expect(devices.every((d) => d.registeredAt > 0 && d.lastSeenAt !== null)).toBe(true);

		await expect(api.account.revokeDevice.mutate({ deviceId: 'phone' })).resolves.toEqual({ ok: true });
		const revokedAt = (await api.account.devices.query()).find((d) => d.deviceId === 'phone')!.revokedAt;
		expect(revokedAt).not.toBeNull();
		// Idempotent, keeps the first stamp.
		await api.account.revokeDevice.mutate({ deviceId: 'phone' });
		devices = await api.account.devices.query();
		expect(devices.find((d) => d.deviceId === 'phone')!.revokedAt).toBe(revokedAt);
	});

	it('does not let a revoked device re-register its way back, even from a new sign-in', async () => {
		const { userId, deviceId, api } = await app.signIn();
		await api.account.revokeDevice.mutate({ deviceId });
		expect(await errorReason(api.account.registerDevice.mutate({ deviceId, name: 'again', platform: 'win32' }))).toMatchObject({
			code: 'FORBIDDEN',
			reason: 'device_revoked',
		});
		const fresh = app.client(await app.sign(userId, { sessionId: 'a later sign-in' }));
		expect(await errorReason(fresh.account.registerDevice.mutate({ deviceId, name: 'again', platform: 'win32' }))).toMatchObject({
			code: 'FORBIDDEN',
			reason: 'device_revoked',
		});
		expect((await fresh.account.devices.query())[0]!.revokedAt).not.toBeNull();
	});

	it('answers NOT_FOUND for an unknown device and BAD_REQUEST for bad input', async () => {
		const { api } = await app.signIn();
		expect(await errorReason(api.account.revokeDevice.mutate({ deviceId: 'nope' }))).toMatchObject({ code: 'NOT_FOUND', reason: 'device_not_found' });
		expect(await errorReason(api.account.registerDevice.mutate({ deviceId: 'x', name: 'x', platform: 'beos' as 'linux' }))).toMatchObject({ code: 'BAD_REQUEST' });
		expect(await errorReason(api.account.registerDevice.mutate({ deviceId: '', name: 'x', platform: 'linux' }))).toMatchObject({ code: 'BAD_REQUEST' });
		expect(await errorReason(api.account.registerDevice.mutate({ deviceId: 'x', name: '   ', platform: 'linux' }))).toMatchObject({ code: 'BAD_REQUEST' });
	});
});
