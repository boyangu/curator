import { describe, it, expect, vi, afterEach } from 'vitest';
import { FeedScheduler } from './scheduler.js';
import type { FeedProducer } from './types.js';
import type { FeedStore } from './store.js';

// Minimal store — the scheduler's poll path only touches these four methods.
const STORE = {
	getCursor: async () => null,
	setCursor: async () => {},
	upsertItems: async () => ({ inserted: 0 }),
	prune: async () => 0,
} as unknown as FeedStore;

function recordingProducer(id: string, log: string[]): FeedProducer {
	return {
		id,
		source: 'spotify',
		displayName: id,
		poll: async () => {
			log.push(id);
			return { drafts: [], nextCursor: null };
		},
	};
}

const FIRST_RUN_MS = 15 * 1000;

afterEach(() => {
	vi.useRealTimers();
});

describe('FeedScheduler per-producer cadence', () => {
	it('polls every producer once shortly after start, then on each producer interval', async () => {
		vi.useFakeTimers();
		const log: string[] = [];
		const s = new FeedScheduler(STORE);
		s.register(recordingProducer('fast', log), 60_000);
		s.register(recordingProducer('slow', log), 3_600_000);
		s.start();

		await vi.advanceTimersByTimeAsync(FIRST_RUN_MS + 10); // first-run fires for both
		expect(log.filter((x) => x === 'fast')).toHaveLength(1);
		expect(log.filter((x) => x === 'slow')).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(60_000); // crosses one fast interval, no slow
		expect(log.filter((x) => x === 'fast')).toHaveLength(2);
		expect(log.filter((x) => x === 'slow')).toHaveLength(1);

		s.stop();
	});

	it('runAll() forces every producer regardless of cadence', async () => {
		const log: string[] = [];
		const s = new FeedScheduler(STORE);
		s.register(recordingProducer('fast', log), 60_000);
		s.register(recordingProducer('slow', log), 3_600_000);
		await s.runAll();
		expect(log.sort()).toEqual(['fast', 'slow']);
	});

	it('serializes overlapping passes — producers never poll concurrently', async () => {
		let active = 0;
		let maxActive = 0;
		const producer: FeedProducer = {
			id: 'p',
			source: 'spotify',
			displayName: 'p',
			poll: async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				await Promise.resolve();
				active--;
				return { drafts: [], nextCursor: null };
			},
		};
		const s = new FeedScheduler(STORE);
		s.register(producer);
		await Promise.all([s.runAll(), s.runAll(), s.runAll()]);
		expect(maxActive).toBe(1);
	});
});
