// An in-memory Curator cloud for the sync client's tests (client.test.ts,
// the two-desktop scenario suites). It keeps the real server's rules
// (design: "Server API"; apps/cloud/src/sync/*): one seq per user, duplicate
// op ids accepted and ignored, per-op rejection without failing the batch,
// a client_ts clamp far in the future, materialisation with the protocol
// reducer, a `snapshotSeq` hint for a far-behind cursor, the 'pull_skip_own'
// feature (or, with `legacy`, a server from before it, strict about its pull
// input), device revocation as the real server has it since 'device_reads'
// (a revoked device's pushes come back `device_revoked` op by op, its pulls
// and bootstraps are refused, and it cannot re-register; each transport is
// one session, judged by the device it last acted as, so leaving the device
// id out does not help), injectable transport failures, globally or per
// device (`online`), and 'batches' as apps/cloud sync/batch.ts has them:
// staged ops are invisible to every pull until the commit, which moves them
// under fresh seqs (skipping op ids the log holds), takes a snapshot and
// answers `committed`; `holdCommits` keeps a commit running (it answers
// `committing`) until a test lets it go, and `farBehindOps` is the server's
// far-behind rule against that snapshot. And 'snapshot_storage' as the
// contract states it (protocol cloud-service.ts): an in-memory `snapshots`
// bucket each session may write only under its own prefix, and
// publishSnapshot with the server's checks (master by the log's LWW, seq at
// or below the head, parts present at their sizes, keep-3 prune naming the
// superseded paths). Each publish is also compared with the fake's own fold
// at its seq (`publishes[].stateMatches`), as the real server's verifier does.
//
// Nothing here leaves the process.

import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
	applyOp,
	clampClientTs,
	cloneLibraryState,
	createLibraryState,
	masterDeviceOf,
	MAX_PULL_OPS,
	MAX_PUSH_OPS,
	snapshotPartPath,
	safeParseOp,
	schemaVersionStatus,
	serializeLibraryState,
	type BatchAbortInput,
	type BatchBeginInput,
	type BatchBeginResult,
	type BatchCommitInput,
	type BatchCommitResult,
	type BatchPushInput,
	type BatchPushResult,
	type BatchStatus,
	type BootstrapInput,
	type DeviceInfo,
	type Op,
	type PublishSnapshotInput,
	type PublishSnapshotResult,
	type PullInput,
	type PullResult,
	type SnapshotManifest,
	type PushInput,
	type PushResult,
	type RejectReason,
	type StoredOp,
	type SyncFeature,
	SYNC_FEATURES,
} from '@curator/protocol';
import { CloudTransportError, type CloudTransport } from '../sync-log/client.js';
import { decodeLibraryStateSnapshot } from '../sync-log/snapshot.js';
import { readStorageSnapshotBody, type SnapshotBlobStore } from '../sync-log/snapshot-storage.js';

export type FakePublished = { seq: number; deviceId: string; manifest: SnapshotManifest };

export type FakeTransport = CloudTransport & { signedIn: boolean; online: boolean };

type FakeBatch = { id: string; deviceId: string; label: string; status: BatchStatus; staged: Map<string, Op>; total: number; result: BatchCommitResult | null };

export class FakeCloud {
	readonly log: StoredOp[] = [];
	private readonly byId = new Map<string, StoredOp>();
	// A server from before 'pull_skip_own': no features, no clamp report,
	// and a pull input with the skip fields is refused (zod `.strict()`).
	legacy = false;
	readonly pullInputs: PullInput[] = [];
	// Ops sent back on pulls, all callers together.
	opsSent = 0;
	readonly state = createLibraryState();
	readonly devices = new Map<string, DeviceInfo>();
	// Ops the server refuses (as a malformed/unauthorised op would be).
	readonly rejectIds = new Map<string, RejectReason>();
	// Failures thrown by the next calls, in order, per procedure.
	readonly fail: { push: CloudTransportError[]; pull: CloudTransportError[]; publish: CloudTransportError[]; upload: Error[] } = { push: [], pull: [], publish: [], upload: [] };
	readonly calls = { push: 0, pull: 0, bootstrap: 0, register: 0, chunkedBootstraps: 0, storageBootstraps: 0, batchBegin: 0, batchPush: 0, batchCommit: 0, batchAbort: 0, publish: 0, upload: 0, download: 0 };
	// The `snapshots` bucket: path → bytes; and the paths clients removed.
	readonly storage = new Map<string, Uint8Array>();
	readonly removed: string[] = [];
	// The kept master-published snapshots, oldest first (at most `keepSnapshots`).
	readonly published: FakePublished[] = [];
	keepSnapshots = 3;
	// Every publishSnapshot call that passed the checks: who, at what seq,
	// the outcome, and whether its JSON is the fake's own fold at that seq.
	readonly publishes: Array<{ deviceId: string; seq: number; status: PublishSnapshotResult['status']; stateMatches: boolean }> = [];
	readonly batches = new Map<string, FakeBatch>();
	// A commit the server is still running: batchCommit answers `committing`
	// and moves nothing while this is set.
	holdCommits = false;
	// The real server's far-behind rule (cloud sync/pull.ts) against the
	// latest snapshot: more ops than this between the cursor and it, and the
	// pull answers with the snapshot hint. Null: only `hintBelow`.
	farBehindOps: number | null = null;
	readonly pushSizes: number[] = [];
	// Every push call's device and outcome, for "a revoked device stops pushing".
	readonly pushLog: Array<{ deviceId: string; sent: number; accepted: number }> = [];
	pageLimit = MAX_PULL_OPS;
	// What push and pull results advertise (not `legacy`). A suite that pins
	// the v2 mechanics takes 'track_meta' out, so no base-metadata or master
	// op joins its outbox counts (client.test.ts v2Cloud).
	features: SyncFeature[] = [...SYNC_FEATURES];
	private snapshot: { seq: number; json: string } | null = null;
	// A pull with afterSeq below this gets the snapshot hint.
	hintBelow = 0;

	get maxSeq(): number { return this.log.length === 0 ? 0 : this.log[this.log.length - 1]!.seq; }

	revoke(deviceId: string): void {
		const d = this.devices.get(deviceId);
		if (d && d.revokedAt === null) this.devices.set(deviceId, { ...d, revokedAt: Date.now() });
	}

	isRevoked(deviceId: string): boolean {
		return (this.devices.get(deviceId)?.revokedAt ?? null) !== null;
	}

	push(userId: string, input: PushInput): PushResult {
		this.calls.push++;
		const f = this.fail.push.shift();
		if (f) throw f;
		this.pushSizes.push(input.ops.length);
		if (input.ops.length > MAX_PUSH_OPS) throw new CloudTransportError('bad_request', 'batch too large');
		// apps/cloud sync/push.ts: a revoked device's whole batch comes back
		// rejected op by op, and nothing is stored.
		if (this.isRevoked(input.deviceId)) {
			this.pushLog.push({ deviceId: input.deviceId, sent: input.ops.length, accepted: 0 });
			return {
				accepted: 0,
				maxSeq: this.maxSeq,
				rejected: input.ops.map((o) => ({ opId: (o as { op_id?: string }).op_id ?? '?', reason: 'device_revoked' as const })),
				clamped: [],
				batchMaxSeq: 0,
				features: [...this.features],
			};
		}
		// apps/cloud sync/push.ts: an op from a newer protocol than this server
		// reads fails the whole call (`server_outdated`, a 'server' error on the
		// desktop transport). A fake that does not advertise 'zero_loss_v4'
		// stands for a v3 server.
		const reads = this.features.includes('zero_loss_v4') ? 4 : 3;
		if (input.ops.some((o) => typeof (o as { schema_version?: unknown }).schema_version === 'number' && (o as { schema_version: number }).schema_version > reads)) {
			throw new CloudTransportError('server', 'server_outdated');
		}
		const rejected: PushResult['rejected'] = [];
		const clamped: NonNullable<PushResult['clamped']> = [];
		const batchIds = new Set<string>();
		let batchMaxSeq = 0;
		let accepted = 0;
		for (const raw of input.ops) {
			const v = safeParseOp(raw);
			const opId = (raw as { op_id?: string }).op_id ?? '?';
			if (!v.ok) { rejected.push({ opId, reason: v.error.reason }); continue; }
			if (schemaVersionStatus(v.op.schema_version) === 'update_required') { rejected.push({ opId, reason: 'update_required' }); continue; }
			// apps/cloud sync/push.ts: an op stamped with another device's id is
			// refused, so a cloned identity (a restored backup that was not
			// re-minted) shows up in tests exactly as it would in production.
			if (v.op.device_id !== input.deviceId) { rejected.push({ opId, reason: 'not_owner' }); continue; }
			const refused = this.rejectIds.get(opId);
			if (refused) { rejected.push({ opId, reason: refused }); continue; }
			accepted++;
			batchIds.add(opId);
			let stored = this.byId.get(opId); // a re-push: accepted and ignored
			if (!stored) {
				const now = Date.now();
				const op = { ...v.op, client_ts: clampClientTs(v.op.client_ts, now).clientTs } as Op;
				stored = { ...op, seq: this.maxSeq + 1, user_id: userId, received_at: now } as StoredOp;
				this.byId.set(opId, stored);
				this.log.push(stored);
				applyOp(this.state, op);
			}
			batchMaxSeq = Math.max(batchMaxSeq, stored.seq);
			if (stored.client_ts !== v.op.client_ts && !clamped.some((c) => c.opId === opId)) clamped.push({ opId, clientTs: stored.client_ts });
		}
		this.pushLog.push({ deviceId: input.deviceId, sent: input.ops.length, accepted });
		if (this.legacy) return { accepted, maxSeq: this.maxSeq, rejected };
		const prior = this.log.filter((o) => o.device_id === input.deviceId && !batchIds.has(o.op_id)).reduce((m, o) => Math.max(m, o.seq), 0);
		return {
			accepted, maxSeq: this.maxSeq, rejected, clamped, batchMaxSeq,
			...(accepted > 0 ? { priorOwnMaxSeq: prior } : {}),
			features: [...this.features],
		};
	}

	pull(input: PullInput): PullResult {
		this.calls.pull++;
		this.pullInputs.push({ ...input });
		const f = this.fail.pull.shift();
		if (f) throw f;
		if ((input.deviceId !== undefined || input.ownThroughSeq !== undefined) && this.legacy) throw new CloudTransportError('bad_request', 'unrecognized keys in pull input');
		const skip = input.ownThroughSeq !== undefined;
		const features = this.legacy ? {} : { features: [...this.features] };
		// As the real server's: the hint names only a snapshot with a body in
		// the database (takeSnapshot). A client that then bootstraps with
		// `storage: true` may land at or past it.
		if (this.snapshot && input.afterSeq < this.hintBelow) return { ops: [], nextSeq: input.afterSeq, snapshotSeq: this.snapshot.seq, ...features };
		if (this.snapshot && this.farBehindOps !== null && input.afterSeq < this.snapshot.seq) {
			const snap = this.snapshot.seq;
			const gap = this.log.filter((o) => o.seq > input.afterSeq && o.seq <= snap && !(skip && o.device_id === input.deviceId && o.seq <= input.ownThroughSeq!)).length;
			if (gap > this.farBehindOps) return { ops: [], nextSeq: input.afterSeq, snapshotSeq: snap, ...features };
		}
		const limit = Math.min(input.limit ?? MAX_PULL_OPS, this.pageLimit);
		const ops = this.log
			.filter((o) => o.seq > input.afterSeq && !(skip && o.device_id === input.deviceId && o.seq <= input.ownThroughSeq!))
			.slice(0, limit);
		// The real server's cursor rule (cloud sync/pull.ts): a full page stops
		// at its last op; a short one reached the head.
		const nextSeq = !skip ? (ops.length ? ops[ops.length - 1]!.seq : input.afterSeq)
			: ops.length === limit ? ops[ops.length - 1]!.seq : Math.max(input.afterSeq, this.maxSeq);
		this.opsSent += ops.length;
		return { ops, nextSeq, ...features };
	}

	// ── 'batches' (apps/cloud sync/batch.ts) ────────────────────────────────

	private liveBatch(id: string, deviceId: string): FakeBatch {
		const b = this.batches.get(id);
		if (!b || b.deviceId !== deviceId || b.status === 'aborted' || b.status === 'expired' || b.status === 'committed') {
			if (b?.status === 'committed' && b.deviceId === deviceId) return b;
			throw new CloudTransportError('batch_gone', 'batch_gone');
		}
		return b;
	}

	batchBegin(input: BatchBeginInput): BatchBeginResult {
		this.calls.batchBegin++;
		if (this.isRevoked(input.deviceId)) throw new CloudTransportError('device_revoked', 'device_revoked');
		const live = [...this.batches.values()].find((b) => b.deviceId === input.deviceId && b.label === input.label && (b.status === 'open' || b.status === 'committing'));
		if (live) return { batchId: live.id, status: live.status as 'open' | 'committing', resumed: true, stagedOps: live.staged.size, features: [...this.features] };
		const b: FakeBatch = { id: randomUUID(), deviceId: input.deviceId, label: input.label, status: 'open', staged: new Map(), total: 0, result: null };
		this.batches.set(b.id, b);
		return { batchId: b.id, status: 'open', resumed: false, stagedOps: 0, features: [...this.features] };
	}

	batchPush(input: BatchPushInput): BatchPushResult {
		this.calls.batchPush++;
		if (this.isRevoked(input.deviceId)) throw new CloudTransportError('device_revoked', 'device_revoked');
		if (input.ops.length > MAX_PUSH_OPS) throw new CloudTransportError('bad_request', 'batch too large');
		const b = this.liveBatch(input.batchId, input.deviceId);
		if (b.status === 'committing') throw new CloudTransportError('batch_committing', 'batch_committing');
		if (b.status !== 'open') throw new CloudTransportError('batch_gone', 'batch_gone');
		const rejected: BatchPushResult['rejected'] = [];
		const clamped: NonNullable<BatchPushResult['clamped']> = [];
		let accepted = 0;
		for (const raw of input.ops) {
			const v = safeParseOp(raw);
			const opId = (raw as { op_id?: string }).op_id ?? '?';
			if (!v.ok) { rejected.push({ opId, reason: v.error.reason }); continue; }
			if (schemaVersionStatus(v.op.schema_version) === 'update_required') { rejected.push({ opId, reason: 'update_required' }); continue; }
			if (v.op.device_id !== input.deviceId) { rejected.push({ opId, reason: 'not_owner' }); continue; }
			const refused = this.rejectIds.get(opId);
			if (refused) { rejected.push({ opId, reason: refused }); continue; }
			accepted++;
			let stored = b.staged.get(opId);
			if (!stored) {
				stored = { ...v.op, client_ts: clampClientTs(v.op.client_ts, Date.now()).clientTs } as Op;
				b.staged.set(opId, stored);
			}
			if (stored.client_ts !== v.op.client_ts && !clamped.some((c) => c.opId === opId)) clamped.push({ opId, clientTs: stored.client_ts });
		}
		return { accepted, rejected, clamped, stagedOps: b.staged.size, features: [...this.features] };
	}

	batchCommit(userId: string, input: BatchCommitInput): BatchCommitResult {
		this.calls.batchCommit++;
		if (this.isRevoked(input.deviceId)) throw new CloudTransportError('device_revoked', 'device_revoked');
		const b = this.liveBatch(input.batchId, input.deviceId);
		if (b.result) return b.result;
		if (b.status === 'open') { b.status = 'committing'; b.total = b.staged.size; }
		if (this.holdCommits) return { status: 'committing', movedOps: 0, totalOps: b.total, committedSeq: 0, rejected: [], features: [...this.features] };
		const prior = this.log.filter((o) => o.device_id === b.deviceId && !b.staged.has(o.op_id)).reduce((m, o) => Math.max(m, o.seq), 0);
		let committedSeq = 0;
		const now = Date.now();
		for (const op of b.staged.values()) {
			let stored = this.byId.get(op.op_id);
			if (!stored) {
				stored = { ...op, seq: this.maxSeq + 1, user_id: userId, received_at: now } as StoredOp;
				this.byId.set(op.op_id, stored);
				this.log.push(stored);
				applyOp(this.state, op);
			}
			committedSeq = Math.max(committedSeq, stored.seq);
		}
		const moved = b.staged.size;
		b.staged.clear();
		b.status = 'committed';
		b.result = { status: 'committed', movedOps: moved, totalOps: b.total, committedSeq, priorOwnMaxSeq: prior, rejected: [], features: [...this.features] };
		return b.result;
	}

	batchAbort(input: BatchAbortInput): { status: BatchStatus } {
		this.calls.batchAbort++;
		const b = this.batches.get(input.batchId);
		if (!b || b.deviceId !== input.deviceId) throw new CloudTransportError('batch_gone', 'batch_gone');
		if (b.status === 'committing') throw new CloudTransportError('batch_committing', 'batch_committing');
		if (b.status === 'open') { b.status = 'aborted'; b.staged.clear(); }
		return { status: b.status };
	}

	// The server's sweep, a day later: an open batch expires, its staged ops
	// deleted.
	expireBatch(id: string): void {
		const b = this.batches.get(id);
		if (b && b.status === 'open') { b.status = 'expired'; b.staged.clear(); }
	}

	// The fold of the log through `seq`, as the server's verifier builds it.
	foldAt(seq: number): ReturnType<typeof createLibraryState> {
		const state = createLibraryState();
		for (const o of this.log) {
			if (o.seq > seq) break;
			const { seq: _s, user_id: _u, received_at: _r, ...op } = o;
			applyOp(state, op as Op);
		}
		return state;
	}

	// ── 'snapshot_storage' (protocol cloud-service.ts) ──────────────────────

	publishSnapshot(userId: string, input: PublishSnapshotInput): PublishSnapshotResult {
		this.calls.publish++;
		const f = this.fail.publish.shift();
		if (f) throw f;
		if (this.isRevoked(input.deviceId)) throw new CloudTransportError('device_revoked', 'device_revoked');
		if (masterDeviceOf(this.state.settings) !== input.deviceId) throw new CloudTransportError('not_master', 'not_master');
		if (input.snapshotSeq > this.maxSeq) throw new CloudTransportError('snapshot_ahead', 'snapshot_ahead');
		const m = input.manifest;
		if (m.parts.some((p) => p.path !== snapshotPartPath(userId, p.sha256)) || m.parts.reduce((n, p) => n + p.bytes, 0) !== m.totalBytes) {
			throw new CloudTransportError('snapshot_part_invalid', 'snapshot_part_invalid');
		}
		for (const p of m.parts) {
			if (this.storage.get(p.path)?.byteLength !== p.bytes) throw new CloudTransportError('snapshot_part_missing', 'snapshot_part_missing');
		}
		const stateMatches = createHash('sha256').update(serializeLibraryState(this.foldAt(input.snapshotSeq))).digest('hex') === m.stateSha256;
		let status: PublishSnapshotResult['status'];
		if (this.published.some((s) => s.seq === input.snapshotSeq)) status = 'exists';
		else if ((this.published.at(-1)?.seq ?? 0) > input.snapshotSeq) status = 'stale';
		else {
			this.published.push({ seq: input.snapshotSeq, deviceId: input.deviceId, manifest: m });
			status = 'stored';
		}
		// Pruned snapshots' parts, and on 'exists' / 'stale' the caller's own
		// just-uploaded parts (a publish that lost a race): whatever no kept
		// manifest references. A retry of a stored snapshot names nothing.
		const pruned = this.published.splice(0, Math.max(0, this.published.length - this.keepSnapshots));
		const kept = new Set(this.published.flatMap((s) => s.manifest.parts.map((p) => p.path)));
		const candidates = [...pruned.flatMap((s) => s.manifest.parts.map((p) => p.path)), ...(status === 'stored' ? [] : m.parts.map((p) => p.path))];
		const superseded = [...new Set(candidates)].filter((p) => !kept.has(p));
		this.publishes.push({ deviceId: input.deviceId, seq: input.snapshotSeq, status, stateMatches });
		return { status, latestSeq: this.published.at(-1)!.seq, superseded, features: [...this.features] };
	}

	takeSnapshot(): number {
		this.snapshot = { seq: this.maxSeq, json: serializeLibraryState(cloneLibraryState(this.state)) };
		return this.snapshot.seq;
	}

	// Test-only: an op stored as a newer client would have sent it.
	appendRaw(op: StoredOp): void { this.log.push(op); }

	// One device's connection. `online = false` fails every sync call with a
	// network error (the device is offline; the others are not).
	transport(userId: string, email = `${userId}@example.test`): FakeTransport {
		const cloud = this;
		const offline = (): void => { if (!t.online) throw new CloudTransportError('network', 'net::ERR_INTERNET_DISCONNECTED'); };
		// The device this session last acted as (apps/cloud device-gate.ts).
		let actsAs: string | null = null;
		const revokedSession = (): boolean => actsAs !== null && cloud.isRevoked(actsAs);
		// A read: refused for a revoked session or a revoked device named.
		const gateRead = (deviceId: string | undefined): void => {
			if (revokedSession() || (deviceId !== undefined && cloud.isRevoked(deviceId))) throw new CloudTransportError('device_revoked', 'device_revoked');
			if (deviceId !== undefined && cloud.devices.has(deviceId)) actsAs = deviceId;
		};
		// The bucket's policies (apps/cloud sql/storage.sql): this session's own
		// `<uid>/` prefix only, insert only (an existing object is success:
		// content-addressed bytes), never an update.
		const own = (path: string): void => { if (!path.startsWith(`${userId.toLowerCase()}/`)) throw new Error('denied: another user prefix'); };
		const snapshots: SnapshotBlobStore = {
			upload: async (path, bytes) => {
				offline();
				own(path);
				cloud.calls.upload++;
				const f = cloud.fail.upload.shift();
				if (f) throw f;
				if (!cloud.storage.has(path)) cloud.storage.set(path, Uint8Array.from(bytes));
			},
			download: async (path) => {
				offline();
				own(path);
				cloud.calls.download++;
				const o = cloud.storage.get(path);
				if (!o) throw new Error('not_found');
				return Uint8Array.from(o);
			},
			remove: async (paths) => {
				offline();
				for (const p of paths) own(p);
				for (const p of paths) { cloud.storage.delete(p); cloud.removed.push(p); }
			},
		};
		const t: FakeTransport = {
			signedIn: true,
			online: true,
			session: () => (t.signedIn ? { userId, email } : null),
			snapshots,
			// The next sign-in is a new session, bound to nothing yet.
			signOut: async () => { t.signedIn = false; actsAs = null; },
			sync: {
				push: async (input: PushInput) => {
					offline();
					if (revokedSession()) return cloud.push(userId, { ...input, deviceId: actsAs! });
					const r = cloud.push(userId, input);
					if (!cloud.isRevoked(input.deviceId) && cloud.devices.has(input.deviceId)) actsAs = input.deviceId;
					return r;
				},
				batchBegin: async (input: BatchBeginInput) => {
					offline();
					if (revokedSession()) throw new CloudTransportError('device_revoked', 'device_revoked');
					return cloud.batchBegin(input);
				},
				batchPush: async (input: BatchPushInput) => {
					offline();
					if (revokedSession()) throw new CloudTransportError('device_revoked', 'device_revoked');
					return cloud.batchPush(input);
				},
				batchCommit: async (input: BatchCommitInput) => {
					offline();
					if (revokedSession()) throw new CloudTransportError('device_revoked', 'device_revoked');
					return cloud.batchCommit(userId, input);
				},
				batchAbort: async (input: BatchAbortInput) => {
					offline();
					if (revokedSession()) throw new CloudTransportError('device_revoked', 'device_revoked');
					return cloud.batchAbort(input);
				},
				publishSnapshot: async (input: PublishSnapshotInput) => {
					offline();
					if (revokedSession()) throw new CloudTransportError('device_revoked', 'device_revoked');
					return cloud.publishSnapshot(userId, input);
				},
				pull: async (input: PullInput) => {
					offline();
					// A refused pull still reached the server: counted.
					if (!cloud.legacy) try { gateRead(input.deviceId); } catch (e) { cloud.calls.pull++; throw e; }
					return cloud.pull(input);
				},
			},
			// The protocol's serialised state (gzip + base64 are the HTTP
			// transport's), decoded by the same function that transport uses.
			bootstrap: async (input?: BootstrapInput) => {
				offline();
				if (!cloud.legacy) gateRead(input?.deviceId);
				cloud.calls.bootstrap++;
				// The pieces are the HTTP transport's to join (desktop
				// transport.ts); here only that the client asked for them.
				if (input?.chunked) cloud.calls.chunkedBootstraps++;
				// The newest snapshot is a published one: the answer is its
				// manifest, and the HTTP transport's job (download, check, join,
				// inflate) runs here through the same reader.
				const pub = cloud.published.at(-1);
				if (input?.storage && pub && pub.seq >= (cloud.snapshot?.seq ?? 0)) {
					cloud.calls.storageBootstraps++;
					const body = await readStorageSnapshotBody(pub.manifest, (p) => snapshots.download(p), { maxBytes: 1 << 30 });
					return { snapshotSeq: pub.seq, records: decodeLibraryStateSnapshot(gunzipSync(body).toString('utf8')) };
				}
				if (!cloud.snapshot) return { snapshotSeq: 0, records: [] };
				return { snapshotSeq: cloud.snapshot.seq, records: decodeLibraryStateSnapshot(cloud.snapshot.json) };
			},
			account: {
				registerDevice: async (input: { deviceId: string; name: string; platform: DeviceInfo['platform'] }) => {
					offline();
					cloud.calls.register++;
					// Revocation is final (apps/cloud account/devices.ts), and a
					// session that acted as a revoked device cannot mint another.
					if (revokedSession() || cloud.isRevoked(input.deviceId)) throw new CloudTransportError('device_revoked', 'device_revoked');
					cloud.devices.set(input.deviceId, { ...input, registeredAt: Date.now(), lastSeenAt: null, revokedAt: null });
					actsAs = input.deviceId;
					return { ok: true as const };
				},
				devices: async () => {
					if (revokedSession()) throw new CloudTransportError('device_revoked', 'device_revoked');
					return [...cloud.devices.values()];
				},
				revokeDevice: async (input: { deviceId: string }) => {
					offline();
					if (revokedSession()) throw new CloudTransportError('device_revoked', 'device_revoked');
					cloud.revoke(input.deviceId);
					return { ok: true as const };
				},
			},
		};
		return t;
	}
}
