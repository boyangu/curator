// The lanes on their own: pacing callers that arrive together, giving up on
// a call that never answers, and a store's Retry-After read within bounds.

import { TrackerRateLimitedError } from '@curator/catalog-readers';
import { describe, expect, it } from 'vitest';
import { Lanes, STORE_GAP_MS, WorkTimeoutError } from './lanes.js';

const ok = async (): Promise<Response> => new Response('{}');

describe('a lane', () => {
	it('spaces callers that arrive at the same moment, each a gap after the last', async () => {
		let clock = 0;
		const waits: number[] = [];
		const lanes = new Lanes(() => clock, async (ms) => void waits.push(ms), { ...STORE_GAP_MS, beatport: 1500 });
		const f = lanes.fetchFor('beatport', ok);
		await Promise.all([f('a'), f('b'), f('c')]);
		expect(waits).toEqual([1500, 3000]);
		expect(lanes.takeCalls()).toEqual({ beatport: 3 });
	});

	it('gives up on a call that does not answer', async () => {
		const lanes = new Lanes(Date.now, async () => {}, STORE_GAP_MS, { timeoutMs: 20 });
		const f = lanes.fetchFor('deezer', () => new Promise<Response>(() => {}));
		await expect(f('slow')).rejects.toBeInstanceOf(WorkTimeoutError);
	});
});

describe("a store's Retry-After", () => {
	it('is read as a second to a day, whatever the store said', () => {
		expect(new TrackerRateLimitedError(Infinity).retryAfterSec).toBe(86_400);
		expect(new TrackerRateLimitedError(Number.NaN).retryAfterSec).toBe(86_400);
		expect(new TrackerRateLimitedError(-5).retryAfterSec).toBe(1);
		expect(new TrackerRateLimitedError(2.2).retryAfterSec).toBe(3);
		const lanes = new Lanes(() => 0, async () => {}, STORE_GAP_MS);
		lanes.failed('spotify', new TrackerRateLimitedError(Infinity));
		expect(lanes.restingList()).toEqual([{ store: 'spotify', until: 86_400_000 }]);
	});
});
