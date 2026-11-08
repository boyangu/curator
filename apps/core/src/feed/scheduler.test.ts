import { describe, it, expect, vi, afterEach } from 'vitest';
import { FeedScheduler } from './scheduler.js';
import type { FeedProducer, FeedRefreshStatus } from './types.js';
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

// The status the Discover toolbar, its toast and the tab pulse read.
describe('FeedScheduler refresh status', () => {
	const states = (seen: FeedRefreshStatus[]): string[] => seen.map((st) => st.pass?.steps.map((x) => x.state).join(',') ?? 'idle');

	it('walks each step pending → running → done and ends idle', async () => {
		const seen: FeedRefreshStatus[] = [];
		const s = new FeedScheduler({ ...STORE, upsertItems: async () => ({ inserted: 2 }) } as unknown as FeedStore);
		s.register(recordingProducer('a', []));
		s.register(recordingProducer('b', []));
		s.subscribeStatus((st) => seen.push(st));

		const res = await s.runAll();

		expect(states(seen)).toEqual(['pending,pending', 'running,pending', 'done,pending', 'done,running', 'done,done', 'idle']);
		expect(seen[0]!.pass).toMatchObject({ mode: 'poll', manual: true });
		expect(seen[4]!.pass!.steps[0]).toMatchObject({ producerId: 'a', name: 'a', inserted: 2, detail: null, error: null });
		expect(res.producers).toEqual([
			{ producerId: 'a', name: 'a', inserted: 2, error: null, skipped: null, note: null },
			{ producerId: 'b', name: 'b', inserted: 2, error: null, skipped: null, note: null },
		]);
		expect(s.status()).toEqual({ pass: null, waiting: 0 });
	});

	it('carries a producer’s progress line, coalesced to the latest', async () => {
		vi.useFakeTimers();
		const seen: FeedRefreshStatus[] = [];
		const s = new FeedScheduler(STORE);
		s.register({
			id: 'walk',
			source: 'spotify',
			displayName: 'Walk',
			poll: async (_cursor, ctx) => {
				ctx?.report('Playlist 1 of 2');
				ctx?.report('Playlist 2 of 2');
				await new Promise((r) => setTimeout(r, 1_000));
				return { drafts: [], nextCursor: null };
			},
		});
		s.subscribeStatus((st) => seen.push(st));

		const run = s.runAll();
		await vi.advanceTimersByTimeAsync(500);
		const details = seen.map((st) => st.pass?.steps[0]?.detail).filter(Boolean);
		expect(details).toEqual(['Playlist 2 of 2']);

		await vi.advanceTimersByTimeAsync(600);
		await run;
		expect(seen.at(-1)).toEqual({ pass: null, waiting: 0 });
	});

	it('says why a producer was skipped, and what a failed one threw', async () => {
		const seen: FeedRefreshStatus[] = [];
		const s = new FeedScheduler(STORE);
		s.register({ id: 'off', source: 'spotify', displayName: 'Off', poll: async (cursor) => ({ drafts: [], nextCursor: cursor, skipped: 'Spotify is not connected' }) });
		s.register({ id: 'bad', source: 'spotify', displayName: 'Bad', poll: async () => { throw new Error('boom'); } });
		s.subscribeStatus((st) => seen.push(st));

		const res = await s.runAll();

		expect(res.producers).toEqual([
			{ producerId: 'off', name: 'Off', inserted: 0, error: null, skipped: 'Spotify is not connected', note: null },
			{ producerId: 'bad', name: 'Bad', inserted: 0, error: 'boom', skipped: null, note: null },
		]);
		const last = seen.at(-2)!.pass!.steps;
		expect(last[0]).toMatchObject({ state: 'skipped', detail: 'Spotify is not connected' });
		expect(last[1]).toMatchObject({ state: 'error', detail: null, error: 'boom' });
	});

	it('leaves a stood-down producer out of the pass and its result', async () => {
		const log: string[] = [];
		const seen: FeedRefreshStatus[] = [];
		const s = new FeedScheduler(STORE);
		s.register({ ...recordingProducer('retired', log), active: () => false });
		s.register(recordingProducer('live', log));
		s.subscribeStatus((st) => seen.push(st));

		const res = await s.runAll();

		expect(log).toEqual(['live']);
		expect(res.producers.map((p) => p.producerId)).toEqual(['live']);
		expect(seen[0]!.pass!.steps.map((x) => x.producerId)).toEqual(['live']);
	});

	it('counts the passes waiting behind the one in flight', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const s = new FeedScheduler(STORE);
		s.register({ id: 'slow', source: 'spotify', displayName: 'Slow', poll: async () => { await gate; return { drafts: [], nextCursor: null }; } });

		const first = s.runAll();
		await Promise.resolve();
		const second = s.runAll();
		expect(s.status()).toMatchObject({ pass: { manual: true }, waiting: 1 });

		release();
		await Promise.all([first, second]);
		expect(s.status()).toEqual({ pass: null, waiting: 0 });
	});

	it('marks a timer’s pass as not manual', async () => {
		vi.useFakeTimers();
		const seen: FeedRefreshStatus[] = [];
		const s = new FeedScheduler(STORE);
		s.register(recordingProducer('p', []), 60_000);
		s.subscribeStatus((st) => seen.push(st));
		s.start();
		await vi.advanceTimersByTimeAsync(FIRST_RUN_MS + 10);
		s.stop();

		expect(seen[0]!.pass).toMatchObject({ mode: 'poll', manual: false });
	});
});
