// The local cloud: the real server (apps/cloud: migrations, RLS, the tRPC
// router, the batch commit, the snapshot checks) on an in-process PGlite via
// its test harness, and the core CloudTransport a CoreService syncs through.
// The transport mirrors the desktop's HTTP one (apps/desktop/src/main/cloud/
// transport.ts) minus Electron: the same procedures, the same error mapping
// onto CloudTransportError kinds from the server's `data.reason` / status,
// and the same bootstrap (manifest → Storage parts → checked body → gunzip →
// records). Nothing here opens a socket.
//
// Storage: the harness models the `snapshots` bucket only as storage.objects
// metadata, which is what publishSnapshot checks. The blob store keeps the
// bytes in memory and writes that row as the user (uploadBlob runs the
// bucket's insert policy), so the server sees exactly what a real upload
// leaves behind.

import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { createTestApp, uploadBlob, type TestApp } from '@curator/cloud/testing';
import { CloudTransportError, decodeLibraryStateSnapshot, readStorageSnapshotBody, type CloudTransport, type SnapshotBlobStore } from '@curator/core';
import {
	CALL_ERROR_REASONS,
	type BatchAbortInput,
	type BatchBeginInput,
	type BatchCommitInput,
	type BatchPushInput,
	type BootstrapInput,
	type CallErrorReason,
	type PublishSnapshotInput,
	type PullInput,
	type PushInput,
	type RegisterDeviceInput,
} from '@curator/protocol';

const gunzipAsync = promisify(gunzip);
const MAX_INFLATED_BYTES = 1024 * 1024 * 1024;

type ErrorData = { httpStatus?: number; reason?: string | null; retryAfterSec?: number | null };

function asReason(v: unknown): CallErrorReason | 'update_required' | null {
	if (typeof v !== 'string') return null;
	if (v === 'update_required') return v;
	return (CALL_ERROR_REASONS as readonly string[]).includes(v) ? (v as CallErrorReason) : null;
}

// The desktop transport's mapError, keyed on the error's name rather than
// `instanceof TRPCClientError`: the client class lives in apps/cloud's
// dependencies, and this package does not need its own copy to read it.
export function mapError(err: unknown): CloudTransportError {
	if (err instanceof CloudTransportError) return err;
	if (err instanceof Error && err.name === 'TRPCClientError') {
		const e = err as Error & { data?: ErrorData; meta?: { response?: { status?: number } } };
		const data = e.data ?? {};
		const status = data.httpStatus ?? e.meta?.response?.status ?? 0;
		const reason = asReason(data.reason) ?? asReason(e.message);
		const retryMs = data.retryAfterSec != null ? data.retryAfterSec * 1000 : undefined;
		if (reason === 'update_required') return new CloudTransportError('update_required', reason);
		if (reason === 'device_revoked') return new CloudTransportError('device_revoked', reason);
		if (reason === 'device_not_registered') return new CloudTransportError('device_not_registered', reason);
		if (reason === 'rate_limited' || status === 429) return new CloudTransportError('rate_limited', reason ?? 'rate limited', retryMs);
		if (reason === 'server_outdated') return new CloudTransportError('server', reason, retryMs);
		if (reason === 'batch_gone') return new CloudTransportError('batch_gone', reason);
		if (reason === 'batch_committing') return new CloudTransportError('batch_committing', reason);
		if (reason === 'not_master' || reason === 'snapshot_ahead' || reason === 'snapshot_part_missing' || reason === 'snapshot_part_invalid') return new CloudTransportError(reason, reason);
		if (status === 401 || reason === 'missing_token' || reason === 'token_expired' || reason === 'invalid_token') return new CloudTransportError('auth', reason ?? 'unauthorized');
		if (status >= 500) return new CloudTransportError('server', `HTTP ${status}: ${e.message}`);
		if (status >= 400) return new CloudTransportError('bad_request', reason ?? `HTTP ${status}: ${e.message}`);
		return new CloudTransportError('network', e.message);
	}
	return new CloudTransportError('network', err instanceof Error ? err.message : String(err));
}

// The `snapshots` bucket for one user: bytes in memory, the object row in
// storage.objects. Content-addressed and insert-only like the real bucket:
// uploading a path that exists is success.
export type HarnessSnapshotStore = SnapshotBlobStore & { readonly objects: Map<string, Uint8Array> };

export function harnessSnapshotStore(app: TestApp, userId: string): HarnessSnapshotStore {
	const objects = new Map<string, Uint8Array>();
	return {
		objects,
		async upload(path, bytes) {
			if (objects.has(path)) return;
			await uploadBlob(app.pg, userId, path, bytes.byteLength, 'snapshots');
			objects.set(path, Uint8Array.from(bytes));
		},
		async download(path) {
			const o = objects.get(path);
			if (!o) throw new CloudTransportError('server', `snapshot part not in storage: ${path}`);
			return Uint8Array.from(o);
		},
		async remove(paths) {
			for (const p of paths) objects.delete(p);
			if (paths.length > 0) await app.pg.query(`delete from storage.objects where bucket_id = 'snapshots' and name = any($1::text[])`, [paths]);
		},
	};
}

export type HarnessTransport = CloudTransport & { signedIn: boolean; calls: Record<string, number> };

// One install's session as `userId`, holding `token`. Every call goes
// through the harness's tRPC client, whose fetch is the server's handler.
export function harnessTransport(app: TestApp, userId: string, token: string, snapshots: SnapshotBlobStore): HarnessTransport {
	const api = app.client(token);
	const calls: Record<string, number> = {};
	const call = async <T>(name: string, fn: () => Promise<unknown>): Promise<T> => {
		if (!t.signedIn) throw new CloudTransportError('auth', 'signed out');
		calls[name] = (calls[name] ?? 0) + 1;
		try {
			return (await fn()) as T;
		} catch (err) {
			throw mapError(err);
		}
	};
	const t: HarnessTransport = {
		signedIn: true,
		calls,
		session: () => (t.signedIn ? { userId, email: null } : null),
		signOut: async () => { t.signedIn = false; },
		snapshots,
		sync: {
			push: (input: PushInput) => call('push', () => api.sync.push.mutate(input)),
			pull: (input: PullInput) => call('pull', () => api.sync.pull.query(input)),
			batchBegin: (input: BatchBeginInput) => call('batchBegin', () => api.sync.batchBegin.mutate(input)),
			batchPush: (input: BatchPushInput) => call('batchPush', () => api.sync.batchPush.mutate(input)),
			batchCommit: (input: BatchCommitInput) => call('batchCommit', () => api.sync.batchCommit.mutate(input)),
			batchAbort: (input: BatchAbortInput) => call('batchAbort', () => api.sync.batchAbort.mutate(input)),
			publishSnapshot: (input: PublishSnapshotInput) => call('publishSnapshot', () => api.sync.publishSnapshot.mutate(input)),
		},
		// As the desktop's: always `storage: true`; the manifest's parts are
		// read from the bucket and checked (core snapshot-storage.ts) before
		// anything is inflated.
		async bootstrap(input?: BootstrapInput) {
			const res = await call<{ snapshotSeq: number; baseSeq: number; storage?: Parameters<typeof readStorageSnapshotBody>[0] | null }>('bootstrap', () => api.sync.bootstrap.query({ ...(input ?? {}), storage: true }));
			if (!res.storage) return { snapshotSeq: res.snapshotSeq, baseSeq: res.baseSeq, records: null };
			const body = await readStorageSnapshotBody(res.storage, (p) => snapshots.download(p), { maxBytes: MAX_INFLATED_BYTES });
			const json = await gunzipAsync(body, { maxOutputLength: MAX_INFLATED_BYTES });
			return { snapshotSeq: res.snapshotSeq, baseSeq: res.baseSeq, records: decodeLibraryStateSnapshot(json.toString('utf8')) };
		},
		account: {
			registerDevice: (input: RegisterDeviceInput) => call('registerDevice', () => api.account.registerDevice.mutate(input)),
			devices: () => call('devices', () => api.account.devices.query()),
			revokeDevice: (input: { deviceId: string }) => call('revokeDevice', () => api.account.revokeDevice.mutate(input)),
		},
	};
	return t;
}

export type LocalCloud = {
	app: TestApp;
	// A session for `userId` (created in auth.users if new): its transport
	// and its bucket. Tokens live long enough for a run on the real library.
	session(userId: string): Promise<{ transport: HarnessTransport; snapshots: HarnessSnapshotStore }>;
	// The account's head seq and newest published snapshot, read as the
	// owner (no RLS), for the run's wait loops and the report.
	head(userId: string): Promise<number>;
	latestSnapshot(userId: string): Promise<{ seq: number; publishedBy: string } | null>;
	opCounts(userId: string): Promise<Array<{ deviceId: string; entity: string; kind: string; n: number }>>;
	close(): Promise<void>;
};

export async function startLocalCloud(): Promise<LocalCloud> {
	// No catalogue policy: the shared analysis catalogue is not under test,
	// and without it neither device builds its catalogue layer.
	const app = await createTestApp({ catalogue: null });
	const buckets = new Map<string, HarnessSnapshotStore>();
	return {
		app,
		async session(userId) {
			await app.createUser(userId);
			const token = await app.sign(userId, { exp: '24h' });
			let snapshots = buckets.get(userId);
			if (!snapshots) buckets.set(userId, (snapshots = harnessSnapshotStore(app, userId)));
			return { transport: harnessTransport(app, userId, token, snapshots), snapshots };
		},
		async head(userId) {
			const r = await app.pg.query<{ n: number | null }>(`select max(seq)::float8 as n from curator.library_op where user_id = $1`, [userId]);
			return r.rows[0]?.n ?? 0;
		},
		async latestSnapshot(userId) {
			const r = await app.pg.query<{ seq: number; published_by: string }>(
				`select snapshot_seq::float8 as seq, published_by from curator.library_snapshot where user_id = $1 order by snapshot_seq desc limit 1`, [userId]);
			const row = r.rows[0];
			return row ? { seq: row.seq, publishedBy: row.published_by } : null;
		},
		async opCounts(userId) {
			const r = await app.pg.query<{ device_id: string; entity: string; kind: string; n: number }>(
				`select device_id, entity, kind, count(*)::float8 as n from curator.library_op where user_id = $1 group by 1, 2, 3 order by 1, 2, 3`, [userId]);
			return r.rows.map((x) => ({ deviceId: x.device_id, entity: x.entity, kind: x.kind, n: x.n }));
		},
		async close() {
			await app.audit.flush().catch(() => { /* the audit log is not under test */ });
			await app.pg.close();
		},
	};
}
