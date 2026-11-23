// The e2e's CloudTransport, and core's plain-HTTP one (the phone's), each
// against the real server on PGlite: every
// procedure the sync client uses goes through it and comes back in the
// shapes core expects — push, pull, a batch, a master publish of a real
// gzip body through the snapshots bucket, the storage bootstrap — and the
// server's refusals arrive as the CloudTransportError kinds the client
// branches on.

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { masterOp, opsFor, sampleLibrary } from '@curator/cloud/testing';
import Database from 'better-sqlite3';
import { buildReplica, CloudTransportError, joinFromReplica, migrate, REPLICA_SCHEMA } from '@curator/core';
import { compareDumps, createSyncClient, dumpLibrary, readCursor } from '@curator/core/e2e';
import { applyOp, createLibraryState, serializeLibraryState, SnapshotEntryScanner, SNAPSHOT_STORAGE_ENCODING, snapshotPartPath, type SnapshotManifest } from '@curator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalCloud, type LocalCloud } from './cloud.js';

const kindOf = async (p: Promise<unknown>): Promise<string> => {
	try { await p; } catch (e) { if (e instanceof CloudTransportError) return e.kind; throw e; }
	throw new Error('expected the call to fail');
};

// Both speak to the same server; the second writes its own HTTP requests.
describe.each(['transport', 'plain'] as const)('%s against the real server', (which) => {
	// A server of its own each: the scenario counts on the log starting empty.
	let cloud: LocalCloud;
	beforeAll(async () => { cloud = await startLocalCloud(); });
	afterAll(async () => { await cloud.close(); });

	it('pushes, pulls, batches, publishes and bootstraps', async () => {
		const userId = randomUUID();
		const s = await cloud.session(userId);
		const transport = s[which];
		const snapshots = s.snapshots;
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
		// The snapshot comes back as text in pieces: its entries, counted.
		const scanner = new SnapshotEntryScanner();
		let entries = 0;
		for await (const piece of boot.snapshot!) entries += scanner.push(piece).length;
		scanner.end();
		expect(entries).toBeGreaterThan(10);
		const ops = await cloud.opCounts(userId);
		expect(ops.reduce((n, r) => n + r.n, 0)).toBe(head);
	});

	it('publishes a ready-made library built from the snapshot, and a new device installs it', async () => {
		const userId = randomUUID();
		const s = await cloud.session(userId);
		const transport = s[which];
		const deviceId = `dev-${randomUUID()}`;
		await transport.account.registerDevice({ deviceId, name: 'e2e', platform: 'win32' });
		// The two system tags every library is created with (core migrate.ts):
		// a desktop master states them with its library, so a real account
		// holds them and a fresh join has nothing of its own to send.
		const op = opsFor(deviceId);
		const systemTags = [op('tag', 'create', 'interested', { name: 'Interested', kind: 'system' }), op('tag', 'create', 'basket', { name: 'Basket', kind: 'system' })];
		const head = (await transport.sync.push({ deviceId, ops: [...systemTags, ...sampleLibrary(deviceId), masterOp(deviceId, deviceId)] })).maxSeq;
		const state = createLibraryState();
		for (const o of (await transport.sync.pull({ afterSeq: 0, deviceId })).ops) applyOp(state, o);
		const json = Buffer.from(serializeLibraryState(state), 'utf8');
		const body = gzipSync(json);
		const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
		const path = snapshotPartPath(userId, sha(body));
		await s.snapshots.upload(path, body);
		await transport.sync.publishSnapshot!({ deviceId, snapshotSeq: head, manifest: { encoding: SNAPSHOT_STORAGE_ENCODING, parts: [{ path, bytes: body.length, sha256: sha(body) }], totalBytes: body.length, sha256: sha(body), stateSha256: sha(json) } });

		// The master's half, with the product's builder: the join of that
		// snapshot into an empty library, cut into parts.
		const work = mkdtempSync(join(tmpdir(), 'curator-e2e-replica-'));
		try {
			const snapshotFile = join(work, 'snapshot.cgz');
			writeFileSync(snapshotFile, body);
			const built = await buildReplica({ userId, masterDeviceId: deviceId, snapshotSeq: head, snapshotFiles: [snapshotFile], outDir: join(work, 'build') });
			for (let i = 0; i < built.files.length; i++) await s.snapshots.upload(built.manifest.parts[i]!.path, readFileSync(built.files[i]!));
			expect(await transport.sync.publishReplica!({ deviceId, snapshotSeq: head, manifest: built.manifest })).toMatchObject({ status: 'stored', latestSeq: head });

			// The new device's half: offered by the bootstrap, read from the bucket.
			expect(await transport.replica!(REPLICA_SCHEMA)).toMatchObject({ snapshotSeq: head, manifest: built.manifest });
			const target = join(work, 'phone.db');
			const installed = await joinFromReplica(transport, target);
			expect(installed).toMatchObject({ snapshotSeq: head, parts: built.manifest.parts.length, rawBytes: built.manifest.rawBytes });
			// The same library a device gets by joining the snapshot itself.
			const joined = join(work, 'joined.db');
			migrate(joined);
			const jdb = new Database(joined);
			jdb.pragma('journal_mode = WAL');
			jdb.pragma('foreign_keys = ON');
			const client = createSyncClient({ db: jdb, transport: (await cloud.session(userId))[which], device: { name: 'joiner', platform: 'android' } });
			try {
				for (let i = 0; i < 6; i++) await client.syncNow();
				expect(client.status().lastError).toBeNull();
			} finally {
				client.stop();
			}
			const db = new Database(target, { readonly: true });
			try {
				expect(readCursor(db)).toMatchObject({ lastSeq: head });
				expect(db.prepare(`SELECT value FROM app_setting WHERE key = 'device.id'`).pluck().get()).not.toBe(JSON.stringify(deviceId));
				expect(compareDumps(dumpLibrary(jdb), dumpLibrary(db)).filter((t) => !t.equal)).toEqual([]);
				expect(db.prepare(`SELECT count(*) FROM sync_state`).pluck().get()).toBeGreaterThan(10);
			} finally {
				db.close();
				jdb.close();
			}
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});

	it('an account with no snapshot bootstraps to nothing', async () => {
		const transport = (await cloud.session(randomUUID()))[which];
		const deviceId = `dev-${randomUUID()}`;
		await transport.account.registerDevice({ deviceId, name: 'e2e', platform: 'win32' });
		expect(await transport.bootstrap({ deviceId })).toEqual({ snapshotSeq: 0, baseSeq: 0, snapshot: null });
	});

	it('maps the server refusals onto the client error kinds', async () => {
		const userId = randomUUID();
		const transport = (await cloud.session(userId))[which];
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
