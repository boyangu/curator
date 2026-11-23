// 'replica_storage': the master publishes the library it built from one of
// its snapshots (src/sync/publish-replica.ts), retention keeps the newest
// replica and the snapshot it stands on, and bootstrap offers it to a client
// that names a replica format it can open.

import { createHash, randomUUID } from 'node:crypto';
import { REPLICA_STORAGE_ENCODING, snapshotPartPath, type ReplicaManifest, type SnapshotManifest } from '@curator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorReason, masterOp, sampleLibrary, storageManifest, uploadBlob, type TestApp } from '../test/harness.js';

let app: TestApp;
beforeAll(async () => {
	app = await createTestApp();
});
afterAll(() => app.db.close());

type Signed = Awaited<ReturnType<TestApp['signIn']>>;
type Api = Signed['api'];

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function replicaManifest(userId: string, sizes: number[], schema = 1): ReplicaManifest {
	const seed = randomUUID();
	const parts = sizes.map((bytes, i) => {
		const h = sha(`replica:${seed}:${i}`);
		return { path: snapshotPartPath(userId, h), bytes, sha256: h };
	});
	return { encoding: REPLICA_STORAGE_ENCODING, schema, parts, totalBytes: parts.reduce((n, p) => n + p.bytes, 0), rawBytes: 4 * parts.reduce((n, p) => n + p.bytes, 0), rawSha256: sha(`raw:${seed}`) };
}

async function upload(userId: string, m: { parts: Array<{ path: string; bytes: number }> }): Promise<void> {
	for (const p of m.parts) await uploadBlob(app.pg, userId, p.path, p.bytes, 'snapshots');
}

// A master that has published a snapshot of its library at the head.
async function masterWithSnapshot(): Promise<Signed & { head: number; snapshot: SnapshotManifest }> {
	const s = await app.signIn();
	const head = (await s.api.sync.push.mutate({ deviceId: s.deviceId, ops: [...sampleLibrary(s.deviceId, 1), masterOp(s.deviceId, s.deviceId)] })).maxSeq;
	const snapshot = storageManifest(s.userId, [5000]);
	await upload(s.userId, snapshot);
	await s.api.sync.publishSnapshot.mutate({ deviceId: s.deviceId, snapshotSeq: head, manifest: snapshot });
	return { ...s, head, snapshot };
}

// Another snapshot later on: one more op, published.
async function nextSnapshot(m: Signed): Promise<{ head: number; snapshot: SnapshotManifest }> {
	const head = (await m.api.sync.push.mutate({ deviceId: m.deviceId, ops: sampleLibrary(m.deviceId, 1) })).maxSeq;
	const snapshot = storageManifest(m.userId, [4000]);
	await upload(m.userId, snapshot);
	await m.api.sync.publishSnapshot.mutate({ deviceId: m.deviceId, snapshotSeq: head, manifest: snapshot });
	return { head, snapshot };
}

const publish = (s: { deviceId: string; api: Api }, snapshotSeq: number, manifest: ReplicaManifest) =>
	s.api.sync.publishReplica.mutate({ deviceId: s.deviceId, snapshotSeq, manifest });

const snapshotSeqs = async (userId: string): Promise<number[]> =>
	(await app.pg.query<{ seq: number }>(`select snapshot_seq::float8 as seq from curator.library_snapshot where user_id = $1 order by snapshot_seq`, [userId])).rows.map((r) => r.seq);
const replicaSeqs = async (userId: string): Promise<number[]> =>
	(await app.pg.query<{ seq: number }>(`select snapshot_seq::float8 as seq from curator.library_replica where user_id = $1 order by snapshot_seq`, [userId])).rows.map((r) => r.seq);

describe('sync.publishReplica', () => {
	it('indexes the master’s replica of a stored snapshot, lists the feature and audits it', async () => {
		const m = await masterWithSnapshot();
		const manifest = replicaManifest(m.userId, [6000, 2000]);
		await upload(m.userId, manifest);
		const r = await publish(m, m.head, manifest);
		expect(r).toMatchObject({ status: 'stored', latestSeq: m.head, superseded: [] });
		expect(r.features).toContain('replica_storage');
		const [row] = (await app.pg.query<{ storage: ReplicaManifest; schema_version: number; published_by: string }>(
			`select storage, schema_version, published_by from curator.library_replica where user_id = $1`, [m.userId])).rows;
		expect(row).toEqual({ storage: manifest, schema_version: 1, published_by: m.deviceId });
		await app.audit.flush();
		const audited = (await app.pg.query<{ detail: Record<string, unknown> }>(`select detail from curator.audit_event where user_id = $1 and kind = 'replica_published'`, [m.userId])).rows;
		expect(audited).toEqual([{ detail: { snapshotSeq: m.head, schema: 1, bytes: 8000, rawBytes: 32000, parts: 2, pruned: 0, superseded: 0 } }]);
	});

	it('refuses a replica of a snapshot the account does not hold, a part not uploaded, and any device but the master', async () => {
		const m = await masterWithSnapshot();
		const manifest = replicaManifest(m.userId, [100]);
		await upload(m.userId, manifest);
		expect(await errorReason(publish(m, m.head - 1, manifest))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'replica_without_snapshot' });
		const missing = replicaManifest(m.userId, [100]);
		expect(await errorReason(publish(m, m.head, missing))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'snapshot_part_missing' });
		const other = await app.signIn();
		expect(await errorReason(publish(m, m.head, replicaManifest(other.userId, [100])))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'snapshot_part_invalid' });
		const api = app.client(await app.sign(m.userId, { sessionId: `session-${randomUUID()}` }));
		const deviceId = `device-${randomUUID()}`;
		await api.account.registerDevice.mutate({ deviceId, name: 'Phone', platform: 'android' });
		expect(await errorReason(publish({ deviceId, api }, m.head, manifest))).toMatchObject({ code: 'FORBIDDEN', reason: 'not_master' });
		expect(await replicaSeqs(m.userId)).toEqual([]);
	});

	it('answers a repeat as exists and an older one as stale, naming only parts nothing keeps', async () => {
		const m = await masterWithSnapshot();
		const first = replicaManifest(m.userId, [300]);
		await upload(m.userId, first);
		await publish(m, m.head, first);
		const again = await publish(m, m.head, first);
		expect(again).toMatchObject({ status: 'exists', superseded: [] });
		const later = await nextSnapshot(m);
		const newer = replicaManifest(m.userId, [400]);
		await upload(m.userId, newer);
		await publish(m, later.head, newer);
		const old = replicaManifest(m.userId, [500]);
		await upload(m.userId, old);
		const stale = await publish(m, m.head, old);
		expect(stale).toMatchObject({ status: 'stale', latestSeq: later.head, superseded: old.parts.map((p) => p.path) });
	});

	it('keeps the newest replica and pins its snapshot through snapshot retention, freeing both once a newer replica stands', async () => {
		const m = await masterWithSnapshot();
		const replica = replicaManifest(m.userId, [700]);
		await upload(m.userId, replica);
		await publish(m, m.head, replica);
		// Three more snapshots: retention keeps the newest three and the pinned one.
		const later = [await nextSnapshot(m), await nextSnapshot(m), await nextSnapshot(m)];
		expect(await snapshotSeqs(m.userId)).toEqual([m.head, ...later.map((s) => s.head)]);
		// A replica of the newest snapshot unpins the first: it goes, with the
		// first replica, and their parts come back to delete.
		const next = replicaManifest(m.userId, [800]);
		await upload(m.userId, next);
		const r = await publish(m, later[2]!.head, next);
		expect(r.status).toBe('stored');
		expect(await replicaSeqs(m.userId)).toEqual([later[2]!.head]);
		expect(await snapshotSeqs(m.userId)).toEqual(later.map((s) => s.head));
		expect([...r.superseded].sort()).toEqual([...replica.parts.map((p) => p.path), ...m.snapshot.parts.map((p) => p.path)].sort());
	});
});

describe('sync.bootstrap with replicaSchema', () => {
	it('offers the newest replica of the asked format or older, beside the snapshot, only when asked', async () => {
		const m = await masterWithSnapshot();
		const v1 = replicaManifest(m.userId, [900], 1);
		await upload(m.userId, v1);
		await publish(m, m.head, v1);
		const plain = await m.api.sync.bootstrap.query({ deviceId: m.deviceId, storage: true });
		expect(plain.replica).toBeUndefined();
		const asked = await m.api.sync.bootstrap.query({ deviceId: m.deviceId, storage: true, replicaSchema: 1 });
		expect(asked).toMatchObject({ snapshotSeq: m.head, replica: { snapshotSeq: m.head, manifest: v1 } });
		// A replica of a newer format than the device can open is not offered.
		const later = await nextSnapshot(m);
		const v2 = replicaManifest(m.userId, [950], 2);
		await upload(m.userId, v2);
		await publish(m, later.head, v2);
		expect((await m.api.sync.bootstrap.query({ deviceId: m.deviceId, storage: true, replicaSchema: 1 })).replica).toBeUndefined();
		expect((await m.api.sync.bootstrap.query({ deviceId: m.deviceId, storage: true, replicaSchema: 2 })).replica).toMatchObject({ snapshotSeq: later.head, manifest: v2 });
	});
});
