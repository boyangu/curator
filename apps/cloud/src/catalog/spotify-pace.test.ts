import { describe, expect, it } from 'vitest';
import { TrackerRateLimitedError } from '@curator/catalog-readers';
import { createSpotifyPace } from './spotify-pace.js';

const response = (status: number, retryAfter?: number): Response =>
	new Response(null, { status, headers: retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) } });

// A clock the pace reads and a sleep that advances it, so the gaps are
// asserted without waiting them out.
function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; set: (t: number) => void } {
	let t = 1_000_000;
	return { now: () => t, sleep: async (ms) => { t += ms; }, set: (n) => { t = n; } };
}

describe('the master\'s Spotify pace', () => {
	it('spaces calls by the gap and lets a burst queue through one at a time', async () => {
		const c = clock();
		const starts: number[] = [];
		const pace = createSpotifyPace({ minGapMs: 2000, now: c.now, sleep: c.sleep, fetchFn: async () => { starts.push(c.now()); return response(200); } });
		await Promise.all([pace.fetch('a'), pace.fetch('b'), pace.fetch('c')]);
		expect(starts).toEqual([1_000_000, 1_002_000, 1_004_000]);
	});

	it('a 429 pauses every later call for the wait Spotify named, without a request', async () => {
		const c = clock();
		let calls = 0;
		const pace = createSpotifyPace({ minGapMs: 0, now: c.now, sleep: c.sleep, fetchFn: async () => { calls++; return calls === 1 ? response(429, 3600) : response(200); } });
		expect((await pace.fetch('a')).status).toBe(429);
		expect(pace.pausedUntil()).toBe(1_000_000 + 3600_000);
		await expect(pace.fetch('b')).rejects.toBeInstanceOf(TrackerRateLimitedError);
		await expect(pace.fetch('b')).rejects.toMatchObject({ retryAfterSec: 3600 });
		expect(calls).toBe(1);
		c.set(1_000_000 + 3600_000 + 1);
		expect((await pace.fetch('c')).status).toBe(200);
		expect(calls).toBe(2);
	});

	it('honours the pause the cursors hold, a device\'s Spotify poll included', async () => {
		const c = clock();
		let calls = 0;
		const until = c.now() + 600_000;
		const db = {
			query: async () => [{ provider: 'spotify', last_error: 'rate limited (600s)', until_ms: until }],
		};
		const pace = createSpotifyPace({ minGapMs: 0, now: c.now, sleep: c.sleep, db: () => db as never, fetchFn: async () => { calls++; return response(200); } });
		await expect(pace.fetch('a')).rejects.toMatchObject({ retryAfterSec: 600 });
		expect(calls).toBe(0);
	});
});
