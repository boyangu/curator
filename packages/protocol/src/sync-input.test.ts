import { describe, expect, it } from 'vitest';
import { SYNC_FEATURES, type PullInput, type PullResult, type PushResult } from './cloud-service.js';
import { ZBootstrapInput, ZPullInput } from './sync-input.js';

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
