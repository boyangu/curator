import { describe, expect, it } from 'vitest';
import {
	CALL_ERROR_REASONS,
	SYNC_FEATURES,
	type BatchBeginInput,
	type BatchBeginResult,
	type BatchCommitResult,
	type BatchPushResult,
	type PullInput,
	type PullResult,
	type PushResult,
} from './cloud-service.js';
import { ZBatchAbortInput, ZBatchBeginInput, ZBatchCommitInput, ZBatchPushInput, ZBootstrapInput, ZPullInput } from './sync-input.js';

const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('sync.pull input', () => {
	it('accepts what an older client sends, unchanged', () => {
		for (const input of [{ afterSeq: 0 }, { afterSeq: 42, limit: 1000 }] satisfies PullInput[]) {
			expect(ZPullInput.parse(roundTrip(input))).toEqual(input);
		}
	});

	it('accepts the own-op skip and round-trips it', () => {
		const input: PullInput = { afterSeq: 7, limit: 500, deviceId: 'desktop-1', ownThroughSeq: 9 };
		expect(ZPullInput.parse(roundTrip(input))).toEqual(input);
		expect(ZPullInput.parse({ afterSeq: 0, deviceId: 'd', ownThroughSeq: 0 })).toEqual({ afterSeq: 0, deviceId: 'd', ownThroughSeq: 0 });
	});

	it('takes a device id alone (device_reads), never the bound without it', () => {
		expect(ZPullInput.parse({ afterSeq: 0, deviceId: 'd' })).toEqual({ afterSeq: 0, deviceId: 'd' });
		expect(ZPullInput.safeParse({ afterSeq: 0, ownThroughSeq: 3 }).success).toBe(false);
	});

	it('stays strict: unknown keys and bad values are refused', () => {
		expect(ZPullInput.safeParse({ afterSeq: 0, device: 'd' }).success).toBe(false);
		expect(ZPullInput.safeParse({ afterSeq: -1 }).success).toBe(false);
		expect(ZPullInput.safeParse({ afterSeq: 0, deviceId: '', ownThroughSeq: 0 }).success).toBe(false);
		expect(ZPullInput.safeParse({ afterSeq: 0, deviceId: 'd', ownThroughSeq: 1.5 }).success).toBe(false);
		expect(ZPullInput.safeParse({ afterSeq: 0, deviceId: 'x'.repeat(129), ownThroughSeq: 0 }).success).toBe(false);
	});
});

describe('sync.bootstrap input', () => {
	it('accepts no input (an older client) and a device id, nothing else', () => {
		expect(ZBootstrapInput.parse(undefined)).toBeUndefined();
		expect(ZBootstrapInput.parse({})).toEqual({});
		expect(ZBootstrapInput.parse(roundTrip({ deviceId: 'desktop-1' }))).toEqual({ deviceId: 'desktop-1' });
		expect(ZBootstrapInput.safeParse({ deviceId: '' }).success).toBe(false);
		expect(ZBootstrapInput.safeParse({ deviceId: 'd', afterSeq: 0 }).success).toBe(false);
	});
});

describe('sync results', () => {
	it('carry the feature list and the push extras through JSON, and stay readable without them', () => {
		const push: PushResult = {
			accepted: 2,
			maxSeq: 12,
			rejected: [],
			clamped: [{ opId: '00000000-0000-4000-8000-000000000001', clientTs: 1_700_000_000_000 }],
			batchMaxSeq: 12,
			priorOwnMaxSeq: 3,
			features: [...SYNC_FEATURES],
		};
		expect(roundTrip(push)).toEqual(push);
		const pull: PullResult = { ops: [], nextSeq: 12, features: [...SYNC_FEATURES] };
		expect(roundTrip(pull)).toEqual(pull);
		// An older server's answers are still valid results.
		const oldPush: PushResult = { accepted: 0, maxSeq: 0, rejected: [] };
		const oldPull: PullResult = { ops: [], nextSeq: 0 };
		expect(roundTrip(oldPush).features).toBeUndefined();
		expect(roundTrip(oldPull).features).toBeUndefined();
		expect(SYNC_FEATURES).toContain('pull_skip_own');
		expect(SYNC_FEATURES).toContain('device_reads');
	});
});

describe("'batches' shapes", () => {
	const batchId = '0b7c2f8e-3a51-4c61-9a3e-2d1f00c0ffee';

	it('is an advertised feature with its own call reasons', () => {
		expect(SYNC_FEATURES).toContain('batches');
		expect(CALL_ERROR_REASONS).toEqual(expect.arrayContaining(['batch_gone', 'batch_committing']));
	});

	it('takes a device, a label and an optional estimate on begin, strictly', () => {
		const input: BatchBeginInput = { deviceId: 'desktop-1', label: 'backfill', expectedOps: 116_000 };
		expect(ZBatchBeginInput.parse(roundTrip(input))).toEqual(input);
		expect(ZBatchBeginInput.parse({ deviceId: 'd', label: 'initial-push' })).toEqual({ deviceId: 'd', label: 'initial-push' });
		for (const label of ['', 'Backfill', 'has space', '-lead', 'x'.repeat(65), 'ünï']) {
			expect(ZBatchBeginInput.safeParse({ deviceId: 'd', label }).success).toBe(false);
		}
		expect(ZBatchBeginInput.safeParse({ deviceId: 'd', label: 'b', expectedOps: -1 }).success).toBe(false);
		expect(ZBatchBeginInput.safeParse({ deviceId: 'd', label: 'b', extra: 1 }).success).toBe(false);
	});

	it('names a batch by UUID only on push, commit and abort', () => {
		expect(ZBatchPushInput.parse({ deviceId: 'd', batchId, ops: [{ anything: true }] })).toEqual({ deviceId: 'd', batchId, ops: [{ anything: true }] });
		expect(ZBatchCommitInput.parse({ deviceId: 'd', batchId })).toEqual({ deviceId: 'd', batchId });
		expect(ZBatchAbortInput.parse({ deviceId: 'd', batchId })).toEqual({ deviceId: 'd', batchId });
		for (const z of [ZBatchCommitInput, ZBatchAbortInput]) {
			expect(z.safeParse({ deviceId: 'd', batchId: 'not-a-uuid' }).success).toBe(false);
			expect(z.safeParse({ deviceId: 'd', batchId, label: 'x' }).success).toBe(false);
		}
		expect(ZBatchPushInput.safeParse({ deviceId: 'd', batchId }).success).toBe(false);
	});

	it('carries its results through JSON', () => {
		const begin: BatchBeginResult = { batchId, status: 'open', resumed: true, stagedOps: 500, features: [...SYNC_FEATURES] };
		const push: BatchPushResult = { accepted: 2, rejected: [{ opId: batchId, reason: 'invalid_payload' }], clamped: [], stagedOps: 502, features: [...SYNC_FEATURES] };
		const committing: BatchCommitResult = { status: 'committing', movedOps: 2000, totalOps: 116_000, committedSeq: 0, rejected: [] };
		const committed: BatchCommitResult = { status: 'committed', movedOps: 116_000, totalOps: 116_000, committedSeq: 240_000, priorOwnMaxSeq: 120_000, rejected: [] };
		for (const r of [begin, push, committing, committed]) expect(roundTrip(r)).toEqual(r);
	});
});
