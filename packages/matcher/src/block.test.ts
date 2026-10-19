import { describe, it, expect } from 'vitest';
import { cloudflareChallengeReason, Cooldown, ProviderBlockedError } from './block.js';

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
