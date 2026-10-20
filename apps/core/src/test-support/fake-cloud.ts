// An in-memory Curator cloud for the sync client's tests (client.test.ts,
// the two-desktop scenario suites). It keeps the real server's rules
// (design: "Server API"; apps/cloud/src/sync/*): one seq per user, duplicate
// op ids accepted and ignored, per-op rejection without failing the batch,
// a client_ts clamp far in the future, materialisation with the protocol
// reducer, a `snapshotSeq` hint for a far-behind cursor, the 'pull_skip_own'
// feature (or, with `legacy`, a server from before it, strict about its pull
// input), device revocation (a revoked device's pushes come back
// `device_revoked` op by op and it cannot re-register; pull is not checked,
// as on the real server) and injectable transport failures, globally or per
// device (`online`).
//
// Nothing here leaves the process.

import {
	applyOp,
	clampClientTs,
	cloneLibraryState,
	createLibraryState,
	MAX_PULL_OPS,
	MAX_PUSH_OPS,
	safeParseOp,
	schemaVersionStatus,
	serializeLibraryState,
	type DeviceInfo,
	type Op,
	type PullInput,
	type PullResult,
	type PushInput,
	type PushResult,
	type RejectReason,
	type StoredOp,
	SYNC_FEATURES,
} from '@curator/protocol';
import { CloudTransportError, type CloudTransport } from '../sync-log/client.js';
import { decodeLibraryStateSnapshot } from '../sync-log/snapshot.js';

export type FakeTransport = CloudTransport & { signedIn: boolean; online: boolean };

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
	readonly fail: { push: CloudTransportError[]; pull: CloudTransportError[] } = { push: [], pull: [] };
	readonly calls = { push: 0, pull: 0, bootstrap: 0, register: 0 };
	readonly pushSizes: number[] = [];
	// Every push call's device and outcome, for "a revoked device stops pushing".
	readonly pushLog: Array<{ deviceId: string; sent: number; accepted: number }> = [];
	pageLimit = MAX_PULL_OPS;
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
				features: [...SYNC_FEATURES],
			};
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
			features: [...SYNC_FEATURES],
		};
	}

	pull(input: PullInput): PullResult {
		this.calls.pull++;
		this.pullInputs.push({ ...input });
		const f = this.fail.pull.shift();
		if (f) throw f;
		const skip = input.deviceId !== undefined || input.ownThroughSeq !== undefined;
		if (skip && this.legacy) throw new CloudTransportError('bad_request', 'unrecognized keys in pull input');
		const features = this.legacy ? {} : { features: [...SYNC_FEATURES] };
		if (this.snapshot && input.afterSeq < this.hintBelow) return { ops: [], nextSeq: input.afterSeq, snapshotSeq: this.snapshot.seq, ...features };
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
		const t: FakeTransport = {
			signedIn: true,
			online: true,
			session: () => (t.signedIn ? { userId, email } : null),
			sync: {
				push: async (input: PushInput) => { offline(); return cloud.push(userId, input); },
				pull: async (input: PullInput) => { offline(); return cloud.pull(input); },
			},
			// The protocol's serialised state (gzip + base64 are the HTTP
			// transport's), decoded by the same function that transport uses.
			bootstrap: async () => {
				offline();
				cloud.calls.bootstrap++;
				if (!cloud.snapshot) return { snapshotSeq: 0, records: [] };
				return { snapshotSeq: cloud.snapshot.seq, records: decodeLibraryStateSnapshot(cloud.snapshot.json) };
			},
			account: {
				registerDevice: async (input: { deviceId: string; name: string; platform: DeviceInfo['platform'] }) => {
					offline();
					cloud.calls.register++;
					// Revocation is final (apps/cloud account/devices.ts).
					if (cloud.isRevoked(input.deviceId)) throw new CloudTransportError('device_revoked', 'device_revoked');
					cloud.devices.set(input.deviceId, { ...input, registeredAt: Date.now(), lastSeenAt: null, revokedAt: null });
					return { ok: true as const };
				},
				devices: async () => [...cloud.devices.values()],
				revokeDevice: async (input: { deviceId: string }) => { cloud.revoke(input.deviceId); return { ok: true as const }; },
			},
		};
		return t;
	}
}
