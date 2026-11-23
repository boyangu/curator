import { describe, it, expect } from 'vitest';
import { cloudflareChallengeReason, Cooldown, ProviderBlockedError, retryAfterMs } from './block.js';

// Minimal case-insensitive Headers stand-in.
const H = (obj: Record<string, string>) => ({
	get: (n: string) => obj[n.toLowerCase()] ?? null,
});

describe('cloudflareChallengeReason', () => {
	it('flags cf-mitigated: challenge from the header alone (no body read)', () => {
		expect(cloudflareChallengeReason(403, H({ 'cf-mitigated': 'challenge' }), null)).toBe('cf-mitigated:challenge');
	});

	it('flags the "Just a moment…" interstitial body on a challenge status', () => {
		expect(cloudflareChallengeReason(403, H({}), '<title>Just a moment...</title>')).toBe('interstitial');
		expect(cloudflareChallengeReason(503, H({}), 'window.__cf_chl_opt = {}')).toBe('interstitial');
	});

	it('does NOT flag a normal 200 results page that happens to contain "challenge"', () => {
		expect(cloudflareChallengeReason(200, H({}), 'Nu Groove — The Challenge (Original Mix)')).toBeNull();
	});

	it('does NOT flag a plain 404 with no challenge markers', () => {
		expect(cloudflareChallengeReason(404, H({}), 'not found')).toBeNull();
	});

	it('ignores the body on non-challenge statuses', () => {
		// A 500 whose body coincidentally says "just a moment" is not a challenge.
		expect(cloudflareChallengeReason(500, H({}), 'just a moment please')).toBeNull();
	});
});

describe('Cooldown', () => {
	it('is inactive until tripped, active across the window, inactive after it elapses', () => {
		let now = 1000;
		const cd = new Cooldown(5000, () => now);
		expect(cd.active).toBe(false);
		cd.trip();
		expect(cd.active).toBe(true);
		now = 1000 + 4999; // still inside
		expect(cd.active).toBe(true);
		now = 1000 + 5000; // window elapsed (exclusive)
		expect(cd.active).toBe(false);
	});

	it('doubles the window per consecutive block up to the max, and clear() resets it', () => {
		let now = 0;
		const cd = new Cooldown(1000, () => now, 3000);
		expect(cd.trip()).toBe(1000);
		expect(cd.releaseAt).toBe(1000);
		expect(cd.trip()).toBe(2000);
		expect(cd.trip()).toBe(3000);
		expect(cd.trip()).toBe(3000);
		cd.clear();
		expect(cd.active).toBe(false);
		expect(cd.releaseAt).toBeNull();
		expect(cd.trip()).toBe(1000);
	});

	it('a Retry-After replaces the guess', () => {
		const now = 0;
		const cd = new Cooldown(1000, () => now, 3000);
		expect(cd.trip(90_000)).toBe(90_000);
		expect(cd.releaseAt).toBe(90_000);
	});
});

describe('retryAfterMs', () => {
	it('reads delta-seconds and HTTP dates; null when absent', () => {
		expect(retryAfterMs(H({ 'retry-after': '120' }))).toBe(120_000);
		const now = Date.parse('2026-11-23T10:00:00Z');
		expect(retryAfterMs(H({ 'retry-after': 'Mon, 23 Nov 2026 10:05:00 GMT' }), now)).toBe(300_000);
		expect(retryAfterMs(H({}))).toBeNull();
		expect(retryAfterMs(H({ 'retry-after': 'soon' }))).toBeNull();
	});
});

describe('ProviderBlockedError', () => {
	it('carries provider + status + reason in a readable message', () => {
		const e = new ProviderBlockedError('beatport', 403, 'cf-mitigated:challenge');
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe('ProviderBlockedError');
		expect(e.provider).toBe('beatport');
		expect(e.status).toBe(403);
		expect(e.message).toContain('beatport');
		expect(e.message).toContain('403');
	});

	it('omits the HTTP suffix when status is 0 (cooldown short-circuit)', () => {
		expect(new ProviderBlockedError('traxsource', 0, 'cooldown').message).not.toContain('HTTP');
	});
});
