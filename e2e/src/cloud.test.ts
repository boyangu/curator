// The e2e's CloudTransport against the real server on PGlite: every
// procedure the sync client uses goes through it and comes back in the
// shapes core expects — push, pull, a batch, a master publish of a real
// gzip body through the snapshots bucket, the storage bootstrap — and the
// server's refusals arrive as the CloudTransportError kinds the client
// branches on.

import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { masterOp, sampleLibrary } from '@curator/cloud/testing';
import { CloudTransportError } from '@curator/core';
import { applyOp, createLibraryState, serializeLibraryState, SNAPSHOT_STORAGE_ENCODING, snapshotPartPath, type SnapshotManifest } from '@curator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalCloud, type LocalCloud } from './cloud.js';

let cloud: LocalCloud;
beforeAll(async () => { cloud = await startLocalCloud(); });
afterAll(async () => { await cloud.close(); });

const kindOf = async (p: Promise<unknown>): Promise<string> => {
	try { await p; } catch (e) { if (e instanceof CloudTransportError) return e.kind; throw e; }
	throw new Error('expected the call to fail');
};

describe('harness transport', () => {
	it('pushes, pulls, batches, publishes and bootstraps', async () => {
		const userId = randomUUID();
		const { transport, snapshots } = await cloud.session(userId);
		const deviceId = `dev-${randomUUID()}`;
		await transport.account.registerDevice({ deviceId, name: 'e2e', platform: 'win32' });
		expect((await transport.account.devices()).map((d) => d.deviceId)).toEqual([deviceId]);

		const [first, ...rest] = sampleLibrary(deviceId);
		const pushed = await transport.sync.push({ deviceId, ops: [first!, masterOp(deviceId, deviceId)] });
		expect(pushed).toMatchObject({ accepted: 2, rejected: [] });
		expect(pushed.features).toContain('snapshot_storage');

		const begun = await transport.sync.batchBegin!({ deviceId, label: 'initial-push', expectedOps: rest.length });
		const staged = await transport.sync.batchPush!({ deviceId, batchId: begun.batchId, ops: rest });
		expect(staged).toMatchObject({ accepted: rest.length, rejected: [] });
		const committed = await transport.sync.batchCommit!({ deviceId, batchId: begun.batchId });
		expect(committed).toMatchObject({ status: 'committed', movedOps: rest.length });
		const head = await cloud.head(userId);
		expect(head).toBe(2 + rest.length);

		const page = await transport.sync.pull({ afterSeq: 0, deviceId });
		expect(page.ops.map((o) => o.op_id)).toEqual(expect.arrayContaining([first!.op_id, ...rest.map((o) => o.op_id)]));

		// A real body: the reducer's state after every op, gzip'd, one part.
		const state = createLibraryState();
		for (const o of page.ops) applyOp(state, o);
		const json = Buffer.from(serializeLibraryState(state), 'utf8');
		const body = gzipSync(json);
		const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
		const path = snapshotPartPath(userId, sha(body));
		const manifest: SnapshotManifest = { encoding: SNAPSHOT_STORAGE_ENCODING, parts: [{ path, bytes: body.length, sha256: sha(body) }], totalBytes: body.length, sha256: sha(body), stateSha256: sha(json) };
		// Not uploaded yet: the server's part check refuses.
		expect(await kindOf(transport.sync.publishSnapshot!({ deviceId, snapshotSeq: head, manifest }))).toBe('snapshot_part_missing');
		await snapshots.upload(path, body);
		await snapshots.upload(path, body); // content-addressed: a second upload is a no-op
		expect(await transport.sync.publishSnapshot!({ deviceId, snapshotSeq: head, manifest })).toMatchObject({ status: 'stored', latestSeq: head });
		expect(await cloud.latestSnapshot(userId)).toEqual({ seq: head, publishedBy: deviceId });

		const boot = await transport.bootstrap({ deviceId });
		expect(boot.snapshotSeq).toBe(head);
		expect(boot.records!.length).toBeGreaterThan(10);
		const ops = await cloud.opCounts(userId);
		expect(ops.reduce((n, r) => n + r.n, 0)).toBe(head);
	});

	it('an account with no snapshot bootstraps to nothing', async () => {
		const { transport } = await cloud.session(randomUUID());
		const deviceId = `dev-${randomUUID()}`;
		await transport.account.registerDevice({ deviceId, name: 'e2e', platform: 'win32' });
		expect(await transport.bootstrap({ deviceId })).toEqual({ snapshotSeq: 0, baseSeq: 0, records: null });
	});

	it('maps the server refusals onto the client error kinds', async () => {
		const userId = randomUUID();
		const { transport } = await cloud.session(userId);
		expect(await kindOf(transport.sync.push({ deviceId: 'never-registered', ops: [] }))).toBe('device_not_registered');
		const a = `dev-${randomUUID()}`;
		const b = `dev-${randomUUID()}`;
		await transport.account.registerDevice({ deviceId: a, name: 'a', platform: 'win32' });
		await transport.account.registerDevice({ deviceId: b, name: 'b', platform: 'win32' });
		await transport.sync.push({ deviceId: a, ops: [masterOp(a, a)] });
		const m: SnapshotManifest = { encoding: SNAPSHOT_STORAGE_ENCODING, parts: [{ path: snapshotPartPath(userId, 'a'.repeat(64)), bytes: 1, sha256: 'a'.repeat(64) }], totalBytes: 1, sha256: 'b'.repeat(64), stateSha256: 'c'.repeat(64) };
		expect(await kindOf(transport.sync.publishSnapshot!({ deviceId: b, snapshotSeq: 1, manifest: m }))).toBe('not_master');
		await transport.account.revokeDevice({ deviceId: b });
		expect(await kindOf(transport.sync.pull({ afterSeq: 0, deviceId: b }))).toBe('device_revoked');
		const anon = cloud.app.client('not-a-token');
		await expect(anon.sync.pull.query({ afterSeq: 0 })).rejects.toThrow();
		await transport.signOut();
		expect(await kindOf(transport.sync.pull({ afterSeq: 0 }))).toBe('auth');
	});
});
