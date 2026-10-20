import { describe, expect, it } from 'vitest';
import type { CloudSyncStatusReport } from '@curator/core';
import { accountActions, deviceRows, REVOKED_LINE, revokeConfirm, syncLine, UNLINK_CONFIRM, type AccountDevice, type AccountStatus } from './accountModel.js';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

const account: AccountStatus = { signedIn: true, email: 'dj@example.test', userId: 'u1', persistent: true, configured: true, syncAvailable: true };

function status(patch: Partial<CloudSyncStatusReport> = {}): CloudSyncStatusReport {
	return {
		enabled: true, signedIn: true, userId: 'u1', email: 'dj@example.test', deviceId: 'this', pending: 0, rejected: 0,
		lastPushAt: NOW - 30_000, lastPullAt: NOW - 30_000, lastSeq: 10, lastError: null, needsUpdate: false, revoked: false, boundUserId: 'u1',
		initialPushDone: true, initialPush: null, bootstrap: null, running: false, nextRetryAt: null,
		poll: { policy: { activeSec: 60, idleSec: 600, idleAfterSec: 600 }, active: true, nextPollAt: null },
		...patch,
	};
}

const device = (p: Partial<AccountDevice> & Pick<AccountDevice, 'deviceId' | 'name'>): AccountDevice => ({
	platform: 'win32', registeredAt: NOW - 86_400_000, lastSeenAt: null, revokedAt: null, current: false, ...p,
});

describe('account panel: a revoked computer', () => {
	it('says so first, keeps the library, and offers only the sign-out', () => {
		const s = status({ revoked: true, pending: 3, lastError: 'This computer was removed from your Curator account.' });
		expect(syncLine(account, s, NOW)).toEqual({ text: REVOKED_LINE, tone: 'error' });
		expect(REVOKED_LINE).toMatch(/stay on this computer/);
		expect(accountActions(account, s)).toEqual({ syncNow: false, revoked: true, manageDevices: false, unlink: false });
	});

	it('a live computer can sync, manage devices and unlink', () => {
		expect(accountActions(account, status())).toEqual({ syncNow: true, revoked: false, manageDevices: true, unlink: true });
		expect(accountActions(account, status({ running: true })).syncNow).toBe(false);
		expect(accountActions({ ...account, syncAvailable: false }, status())).toMatchObject({ manageDevices: false, unlink: false });
	});
});

describe('account panel: devices', () => {
	it('lists this computer first, then active ones (latest seen first), then removed ones; only other active devices can be removed', () => {
		const rows = deviceRows([
			device({ deviceId: 'old', name: 'Old laptop', revokedAt: NOW - 3_600_000 * 48, lastSeenAt: NOW - 3_600_000 * 50 }),
			device({ deviceId: 'studio', name: 'Studio', lastSeenAt: NOW - 5 * 60_000 }),
			device({ deviceId: 'this', name: 'Home', current: true, platform: 'darwin', lastSeenAt: NOW - 10_000 }),
			device({ deviceId: 'phone', name: 'Phone', platform: 'ios' }),
		], NOW);
		expect(rows.map((r) => [r.deviceId, r.current, r.revoked, r.canRevoke])).toEqual([
			['this', true, false, false],
			['studio', false, false, true],
			['phone', false, false, true],
			['old', false, true, false],
		]);
		expect(rows[0]!.detail).toBe('macOS · last seen just now');
		expect(rows[1]!.detail).toBe('Windows · last seen 5 min ago');
		expect(rows[2]!.detail).toMatch(/^iPhone \/ iPad · added /);
		expect(rows[3]!.detail).toMatch(/^Windows · last seen .* · removed /);
	});

	it('confirms a removal by name and points at signing out other sessions', () => {
		const c = revokeConfirm('Studio');
		expect(c.title).toContain('Studio');
		expect(c.danger).toBe(true);
		expect(c.note).toMatch(/Sign out all other sessions/);
	});

	it('describes unlink as keeping everything local and staying with this account', () => {
		expect(UNLINK_CONFIRM.message).toMatch(/Nothing here is deleted/);
		expect(UNLINK_CONFIRM.note).toMatch(/same account/);
		expect(UNLINK_CONFIRM.note).toMatch(/can’t sync with a different account/);
	});
});
