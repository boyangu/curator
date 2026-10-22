// Per-user isolation, at the API and underneath it. The API derives the user
// from the token only; RLS is the second wall, so the direct-SQL checks run
// as `authenticated` with forged claims exactly as a request would.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createTestApp, insertSnapshot, opsFor, sampleLibrary, wakeups, type TestApp } from '../test/harness.js';

let app: TestApp;
beforeAll(async () => {
	app = await createTestApp();
});
afterAll(() => app.db.close());

describe('per-user isolation', () => {
	it('never shows one user another user’s ops, even when the payload claims their user id', async () => {
		const a = await app.signIn();
		const b = await app.signIn();
		const aOps = sampleLibrary(a.deviceId);
		await a.api.sync.push.mutate({ deviceId: a.deviceId, ops: aOps });

		// B tries to write into A's account by naming A in the op itself.
		const op = opsFor(b.deviceId);
		const forgedEnvelope = { ...op('tag', 'create', randomUUID(), { name: 'mine now', kind: 'user' }), user_id: a.userId };
		const forgedPayload = { ...op('tag', 'create', randomUUID(), { name: 'x', kind: 'user' }), payload: { name: 'x', kind: 'user', user_id: a.userId } };
		const honest = op('tag', 'create', randomUUID(), { name: 'b tag', kind: 'user' });
		const res = await b.api.sync.push.mutate({ deviceId: b.deviceId, ops: [forgedEnvelope, forgedPayload, honest] });
		expect(res.rejected).toEqual([
			{ opId: forgedEnvelope.op_id, reason: 'invalid_payload' },
			{ opId: forgedPayload.op_id, reason: 'invalid_payload' },
		]);

		const bPull = await b.api.sync.pull.query({ afterSeq: 0 });
		expect(bPull.ops.map((o) => o.op_id)).toEqual([honest.op_id]);
		expect(bPull.ops.every((o) => o.user_id === b.userId)).toBe(true);

		const aPull = await a.api.sync.pull.query({ afterSeq: 0 });
		expect(aPull.ops.map((o) => o.op_id)).toEqual(aOps.map((o) => o.op_id));
		// B's honest op landed in B's account, stamped by the server.
		const [row] = (await app.pg.query<{ user_id: string }>('select user_id::text as user_id from curator.library_op where op_id = $1', [honest.op_id])).rows;
		expect(row!.user_id).toBe(b.userId);
	});

	it('rejects a re-push of another user’s op id as not_owner and leaves the original alone', async () => {
		const a = await app.signIn();
		const b = await app.signIn();
		const [aOp] = sampleLibrary(a.deviceId);
		await a.api.sync.push.mutate({ deviceId: a.deviceId, ops: [aOp!] });

		const stolen = { ...aOp!, device_id: b.deviceId };
		const res = await b.api.sync.push.mutate({ deviceId: b.deviceId, ops: [stolen] });
		expect(res).toMatchObject({ accepted: 0, rejected: [{ opId: aOp!.op_id, reason: 'not_owner' }] });
		expect((await b.api.sync.pull.query({ afterSeq: 0 })).ops).toEqual([]);
		const aSide = (await a.api.sync.pull.query({ afterSeq: 0 })).ops;
		expect(aSide).toHaveLength(1);
		expect(aSide[0]!.device_id).toBe(a.deviceId);
	});

	it('blocks a direct select and a forged insert under RLS', async () => {
		const a = await app.signIn();
		const b = await app.signIn();
		await a.api.sync.push.mutate({ deviceId: a.deviceId, ops: sampleLibrary(a.deviceId) });

		const seenByB = await asUser(app.pg, b.userId, async (tx) => (await tx.query('select * from curator.library_op where user_id = $1', [a.userId])).rows);
		expect(seenByB).toEqual([]);
		const devicesSeenByB = await asUser(app.pg, b.userId, async (tx) => (await tx.query('select * from curator.device where user_id = $1', [a.userId])).rows);
		expect(devicesSeenByB).toEqual([]);

		await expect(
			asUser(app.pg, b.userId, (tx) =>
				tx.query(
					`insert into curator.library_op (user_id, op_id, device_id, client_ts, schema_version, entity, entity_id, kind, payload)
					values ($1, $2, 'x', 1, 1, 'tag', 't', 'delete', '{}')`,
					[a.userId, randomUUID()],
				),
			),
		).rejects.toThrow(/row-level security/);

		// No grant at all for rewriting history, even one's own.
		await expect(asUser(app.pg, a.userId, (tx) => tx.query(`update curator.library_op set kind = 'x'`))).rejects.toThrow(/permission denied/);
		await expect(asUser(app.pg, a.userId, (tx) => tx.query('delete from curator.library_op'))).rejects.toThrow(/permission denied/);

		// Without claims, `auth.uid()` is null and nothing matches.
		const anonymous = await app.pg.transaction(async (tx) => {
			await tx.query(`select set_config('role', 'authenticated', true)`);
			return (await tx.query('select count(*)::int as n from curator.library_op')).rows;
		});
		expect(anonymous).toEqual([{ n: 0 }]);
	});

	it('wakes only the owner’s channel and keeps snapshots per user', async () => {
		const a = await app.signIn();
		const b = await app.signIn();
		await a.api.sync.push.mutate({ deviceId: a.deviceId, ops: sampleLibrary(a.deviceId) });
		expect(await wakeups(app.pg, b.userId)).toEqual([]);
		expect((await wakeups(app.pg, a.userId)).length).toBe(1);

		const head = (await a.api.sync.pull.query({ afterSeq: 0 })).nextSeq;
		await insertSnapshot(app.pg, a.userId, head);
		const bBoot = await b.api.sync.bootstrap.query({ storage: true });
		expect(bBoot).toEqual({ snapshotSeq: 0, baseSeq: 0 });
		const aBoot = await a.api.sync.bootstrap.query({ storage: true });
		expect(aBoot.snapshotSeq).toBe(head);
		const snapshotsSeenByB = await asUser(app.pg, b.userId, async (tx) => (await tx.query('select * from curator.library_snapshot')).rows);
		expect(snapshotsSeenByB).toEqual([]);
	});

	it('cannot revoke or list another user’s device', async () => {
		const a = await app.signIn();
		const b = await app.signIn();
		await expect(b.api.account.revokeDevice.mutate({ deviceId: a.deviceId })).rejects.toThrow(/device_not_found/);
		expect((await b.api.account.devices.query()).map((d) => d.deviceId)).toEqual([b.deviceId]);
		expect((await a.api.account.devices.query())[0]!.revokedAt).toBeNull();
	});
});
