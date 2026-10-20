// A revoked device stops pulling as well as pushing, and `unlink` detaches an
// install without touching its library: the client against the in-memory
// server (test-support/fake-cloud.ts), which refuses a revoked device's reads
// the way apps/cloud does since 'device_reads'.
//
// Generated DBs only (CLAUDE.md): mkdtempSync + migrate(); no transport here
// leaves the process.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@curator/shared/schema';
import { migrate } from '../db/migrate.js';
import { createDb } from '../db/client.js';
import * as mut from '../library/mutators.js';
import { FakeCloud, type FakeTransport } from '../test-support/fake-cloud.js';
import { createSyncClient, readCursor, type SyncClient } from './client.js';
import { getDeviceId } from './device.js';

let dir: string;
const handles: Database.Database[] = [];
const clients: SyncClient[] = [];

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-revoke-unlink-')); });
afterEach(() => {
	for (const c of clients.splice(0)) c.stop();
	for (const h of handles.splice(0)) h.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

function freshDb(name: string): Database.Database {
	const p = join(dir, `${name}.db`);
	migrate(p);
	const { sqlite } = createDb(p);
	handles.push(sqlite);
	return sqlite;
}

function client(raw: Database.Database, transport: FakeTransport): SyncClient {
	const c = createSyncClient({ db: raw, transport, backoffBaseMs: 5, backoffCapMs: 40, debounceMs: 1 });
	clients.push(c);
	return c;
}

function makeTags(raw: Database.Database, prefix: string, n: number): void {
	const db = drizzle(raw, { schema });
	for (let i = 0; i < n; i++) mut.createTag(db, { id: `${prefix}-${i}`, name: `${prefix} ${i}` });
}

const outbox = (raw: Database.Database) =>
	raw.prepare(`SELECT state, device_id AS deviceId, count(*) AS n FROM sync_outbox GROUP BY state, device_id ORDER BY state`).all() as Array<{ state: string; deviceId: string; n: number }>;

const tagCount = (raw: Database.Database): number => raw.prepare(`SELECT count(*) FROM tag WHERE kind != 'system'`).pluck().get() as number;

// Two desktops of one account, both synced.
async function pair(cloud: FakeCloud) {
	const aRaw = freshDb('a');
	const bRaw = freshDb('b');
	const aT = cloud.transport('user-1');
	const bT = cloud.transport('user-1');
	const a = client(aRaw, aT);
	const b = client(bRaw, bT);
	makeTags(aRaw, 'a', 2);
	await a.syncNow();
	await b.syncNow();
	expect(tagCount(bRaw)).toBe(2);
	return { a, b, aRaw, bRaw, aT, bT };
}

describe('device_reads', () => {
	it('names the device on every pull and bootstrap once the server offers it, and never to an older server', async () => {
		const cloud = new FakeCloud();
		const { b } = await pair(cloud);
		const bId = b.deviceId();
		cloud.pullInputs.length = 0;
		await b.syncNow();
		expect(cloud.pullInputs.length).toBeGreaterThan(0);
		expect(cloud.pullInputs.every((p) => p.deviceId === bId)).toBe(true);

		const legacy = new FakeCloud();
		legacy.legacy = true;
		const raw = freshDb('legacy');
		const c = client(raw, legacy.transport('user-1'));
		await c.syncNow();
		await c.syncNow();
		expect(legacy.pullInputs.length).toBeGreaterThan(0);
		expect(legacy.pullInputs.every((p) => p.deviceId === undefined)).toBe(true);
	});
});

describe('a revoked device', () => {
	it('stops pulling as well as pushing: one refused call, then none, also after a restart', async () => {
		const cloud = new FakeCloud();
		const { a, b, bRaw, aRaw, aT } = await pair(cloud);
		await aT.account.revokeDevice({ deviceId: b.deviceId() });
		// Nothing pending on B: the cycle goes straight to the pull, which the
		// server now refuses.
		makeTags(aRaw, 'later', 1);
		await a.syncNow();
		const pullsBefore = cloud.calls.pull;
		await b.syncNow();
		expect(cloud.calls.pull).toBe(pullsBefore + 1);
		expect(tagCount(bRaw)).toBe(2);
		expect(b.status()).toMatchObject({ revoked: true, lastError: expect.stringMatching(/removed from your Curator account/) });
		expect(b.serverFeatures()).toBeNull();

		// Local edits keep landing in the outbox, held; no call goes out.
		makeTags(bRaw, 'b', 2);
		const calls = { ...cloud.calls };
		await b.syncNow();
		b.wake('realtime');
		await b.syncNow();
		expect(cloud.calls).toEqual(calls);
		expect(b.status()).toMatchObject({ revoked: true, pending: 2, rejected: 0 });

		// The mark lives in the database: a restart does not ask again.
		b.stop();
		const b2 = client(bRaw, cloud.transport('user-1'));
		await b2.syncNow();
		expect(cloud.calls).toEqual(calls);
		expect(b2.status().revoked).toBe(true);
	});

	it('with ops pending, ends the cycle at the held push without pulling', async () => {
		const cloud = new FakeCloud();
		const { b, bRaw, aT } = await pair(cloud);
		await aT.account.revokeDevice({ deviceId: b.deviceId() });
		makeTags(bRaw, 'b', 1);
		const pulls = cloud.calls.pull;
		await b.syncNow();
		expect(cloud.calls.pull).toBe(pulls);
		expect(b.status()).toMatchObject({ revoked: true, pending: 1 });
	});
});

describe('unlink', () => {
	it('revokes this device, signs out and re-mints its id, keeping every row, op and the cursor', async () => {
		const cloud = new FakeCloud();
		const { b, bRaw, bT } = await pair(cloud);
		const oldId = b.deviceId();
		// Not synced yet (the client is not started, so nothing wakes it).
		makeTags(bRaw, 'b', 3);
		const cursor = readCursor(bRaw);
		const tagsBefore = tagCount(bRaw);
		const acked = outbox(bRaw).filter((r) => r.state === 'acked');

		const out = await b.unlink();
		expect(out).toMatchObject({ revokedOnServer: true, signedOut: true, oldDeviceId: oldId, restamped: 3 });
		expect(out.newDeviceId).not.toBe(oldId);
		expect(b.deviceId()).toBe(out.newDeviceId);
		expect(getDeviceId(bRaw)).toBe(out.newDeviceId);
		expect(cloud.isRevoked(oldId)).toBe(true);
		expect(bT.signedIn).toBe(false);
		// Local data and history untouched; pending ops now carry the new id.
		expect(tagCount(bRaw)).toBe(tagsBefore);
		expect(readCursor(bRaw)).toEqual(cursor);
		expect(outbox(bRaw).filter((r) => r.state === 'acked')).toEqual(acked);
		expect(outbox(bRaw).filter((r) => r.state === 'pending')).toEqual([{ state: 'pending', deviceId: out.newDeviceId, n: 3 }]);
		expect(b.status()).toMatchObject({ signedIn: false, revoked: false, boundUserId: 'user-1', lastError: null });

		// Signed in again with the same account: a new device that delivers
		// what it never pushed.
		bT.signedIn = true;
		await b.syncNow();
		expect(cloud.devices.get(out.newDeviceId)?.revokedAt).toBeNull();
		expect(cloud.log.filter((o) => o.device_id === out.newDeviceId)).toHaveLength(3);
		expect(b.status()).toMatchObject({ pending: 0, revoked: false, lastError: null });
	});

	it('is the way back from revoked: nothing to revoke, the next sign-in syncs again', async () => {
		const cloud = new FakeCloud();
		const { b, bRaw, aT, bT } = await pair(cloud);
		await aT.account.revokeDevice({ deviceId: b.deviceId() });
		makeTags(bRaw, 'b', 1);
		await b.syncNow();
		expect(b.status().revoked).toBe(true);

		const out = await b.unlink();
		expect(out).toMatchObject({ revokedOnServer: false, signedOut: true, restamped: 1 });
		expect(b.status()).toMatchObject({ revoked: false, signedIn: false });

		bT.signedIn = true;
		await b.syncNow();
		expect(b.status()).toMatchObject({ revoked: false, pending: 0, lastError: null });
		expect(cloud.log.filter((o) => o.device_id === out.newDeviceId)).toHaveLength(1);
	});

	it('keeps the library bound to its account: another account is refused, nothing of this library reaches it', async () => {
		const cloud = new FakeCloud();
		const { b, bRaw } = await pair(cloud);
		makeTags(bRaw, 'b', 2);
		await b.unlink();
		b.stop();
		const other = client(bRaw, cloud.transport('user-2'));
		const pushes = cloud.calls.push;
		await other.syncNow();
		expect(cloud.calls.push).toBe(pushes);
		expect(cloud.log.some((o) => o.user_id === 'user-2')).toBe(false);
		expect(other.status()).toMatchObject({ boundUserId: 'user-1', lastError: expect.stringMatching(/another Curator account/) });
	});

	it('works signed out and offline: no server call needed to detach', async () => {
		const cloud = new FakeCloud();
		const { b, bT } = await pair(cloud);
		const oldId = b.deviceId();
		bT.online = false;
		const out = await b.unlink();
		expect(out).toMatchObject({ revokedOnServer: false, signedOut: true, oldDeviceId: oldId });
		expect(cloud.isRevoked(oldId)).toBe(false);
		expect(b.deviceId()).not.toBe(oldId);
	});
});
