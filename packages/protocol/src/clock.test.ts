import { describe, it, expect } from 'vitest';
import { clampClientTs, MAX_CLOCK_SKEW_MS, nextClientTs } from './clock.js';

describe('nextClientTs', () => {
	it('uses the wall clock when it is ahead of everything seen', () => {
		expect(nextClientTs(1_000, 500, 400)).toBe(1_000);
	});

	it('never stamps at or below the last server time seen', () => {
		// Wall clock behind the server (device clock slow): one past the server.
		expect(nextClientTs(1_000, 5_000, 0)).toBe(5_001);
	});

	it('never stamps at or below its own last issued ts', () => {
		// Two ops in the same millisecond stay ordered.
		expect(nextClientTs(1_000, 0, 1_000)).toBe(1_001);
		expect(nextClientTs(1_000, 0, 1_001)).toBe(1_002);
	});

	it('is monotonic across a sequence of issues with a frozen wall clock', () => {
		let last = 0;
		for (let i = 0; i < 100; i++) {
			const next = nextClientTs(1_000, 0, last);
			expect(next).toBeGreaterThan(last);
			last = next;
		}
	});
});

describe('clampClientTs', () => {
	const received = 10_000_000;

	it('keeps a client_ts at or before received_at', () => {
		expect(clampClientTs(received - 60_000, received)).toEqual({ clientTs: received - 60_000, clamped: false });
		expect(clampClientTs(received, received)).toEqual({ clientTs: received, clamped: false });
	});

	it('tolerates ordinary skew inside the window', () => {
		expect(clampClientTs(received + MAX_CLOCK_SKEW_MS, received)).toEqual({ clientTs: received + MAX_CLOCK_SKEW_MS, clamped: false });
	});

	it('clamps a clock an hour fast to received_at (scenario 9)', () => {
		expect(clampClientTs(received + 3_600_000, received)).toEqual({ clientTs: received, clamped: true });
	});

	it('honours a custom window', () => {
		expect(clampClientTs(received + 2_000, received, 1_000)).toEqual({ clientTs: received, clamped: true });
		expect(clampClientTs(received + 500, received, 1_000)).toEqual({ clientTs: received + 500, clamped: false });
	});

	it('clamps malformed stamps', () => {
		expect(clampClientTs(Number.NaN, received)).toEqual({ clientTs: received, clamped: true });
		expect(clampClientTs(-1, received)).toEqual({ clientTs: received, clamped: true });
		expect(clampClientTs(Number.POSITIVE_INFINITY, received)).toEqual({ clientTs: received, clamped: true });
	});
});
