import { describe, expect, it } from 'vitest';
import { createProgressTracker, overallFraction, SYNC_FROM_REKORDBOX_PLAN, SYNC_TO_REKORDBOX_PLAN } from './rekordboxSyncProgress.js';

describe('rekordbox sync progress', () => {
	it('splits the bar equally across root steps, then across each root\'s sub-steps', () => {
		// Five roots: 20% each.
		expect(overallFraction(SYNC_TO_REKORDBOX_PLAN, 'backup', 0, 1)).toBeCloseTo(0.4);
		// The write root splits between staging the batch and the commit.
		expect(overallFraction(SYNC_TO_REKORDBOX_PLAN, 'write', 50, 100)).toBeCloseTo(0.6 + 0.05);
		expect(overallFraction(SYNC_TO_REKORDBOX_PLAN, 'write', 100, 100)).toBeCloseTo(0.7);
		expect(overallFraction(SYNC_TO_REKORDBOX_PLAN, 'commit', 0, 1)).toBeCloseTo(0.7);
		expect(overallFraction(SYNC_TO_REKORDBOX_PLAN, 'commit', 1, 1)).toBeCloseTo(0.8);
		expect(overallFraction(SYNC_TO_REKORDBOX_PLAN, 'verify', 0, 1)).toBeCloseTo(0.8);
		expect(overallFraction(SYNC_TO_REKORDBOX_PLAN, 'verify', 1, 1)).toBeCloseTo(1);
		// Pull has nine sub-steps sharing its 20%.
		expect(overallFraction(SYNC_TO_REKORDBOX_PLAN, 'pull:tracks', 0, 10)).toBeCloseTo(0.2 / 9);
		expect(overallFraction(SYNC_TO_REKORDBOX_PLAN, 'pull:tracks', 10, 10)).toBeCloseTo((0.2 / 9) * 2);
	});

	it('a full sync only ever moves forward and ends at 100%', () => {
		const t = createProgressTracker(SYNC_TO_REKORDBOX_PLAN);
		const events: Array<[string, number, number]> = [
			['pull:open', 0, 1],
			['pull:tracks', 0, 320], ['pull:tracks', 320, 320],
			['pull:cues', 6964, 6964],
			['pull:waveforms', 5159, 5159],
			['pull:playlists', 7, 7],
			['pull:history', 1199, 1199],
			['pull:cue-merge', 1, 1],
			['resolve', 0, 1], ['resolve', 40, 40],
			['backup', 0, 1], ['backup', 1, 1],
			// The sidecar's throttled in-batch frames, then the exporter's final one.
			['write', 0, 4412], ['write', 200, 4412], ['write', 2600, 4412], ['write', 4412, 4412], ['write', 4412, 4412],
			['commit', 0, 1], ['commit', 1, 1],
			['verify', 0, 1], ['verify', 1, 1],
		];
		let prev = -1;
		for (const [p, d, n] of events) {
			const pct = t.update(p, d, n);
			expect(pct).toBeGreaterThanOrEqual(prev);
			prev = pct;
		}
		expect(prev).toBe(100);
	});

	it('jumps over steps that do not run and holds on unknown or late phases', () => {
		const t = createProgressTracker(SYNC_TO_REKORDBOX_PLAN);
		// Resume with resolutions: no pull, straight to resolve.
		expect(t.update('resolve', 0, 1)).toBe(Math.round((0.2 + (0.2 / 4) * 3) * 100));
		const atWrite = t.update('write', 5, 10);
		expect(t.update('pull:tracks', 0, 10)).toBe(atWrite);
		expect(t.update('some-new-phase', 1, 1)).toBe(atWrite);
		t.reset();
		expect(t.update('pull:open', 0, 1)).toBe(0);
	});

	it('the pull-only modal fills the whole bar with the reader passes', () => {
		const t = createProgressTracker(SYNC_FROM_REKORDBOX_PLAN);
		expect(t.update('open', 0, 1)).toBe(0);
		expect(t.update('cue-merge', 1, 1)).toBe(100);
	});

	it('in-batch write frames move the bar inside the write slice, and commit continues from there', () => {
		const t = createProgressTracker(SYNC_TO_REKORDBOX_PLAN);
		const start = t.update('write', 0, 1000);
		const mid = t.update('write', 500, 1000);
		const written = t.update('write', 1000, 1000);
		expect(mid).toBeGreaterThan(start);
		expect(written).toBeGreaterThan(mid);
		// Commit start sits exactly where the write ended; its end hands over to verify.
		expect(t.update('commit', 0, 1)).toBe(written);
		expect(t.update('commit', 1, 1)).toBe(80);
		// A late write frame (out of order) never pulls the bar back.
		expect(t.update('write', 600, 1000)).toBe(80);
	});

	it('a zero total counts as not started rather than dividing by zero', () => {
		expect(overallFraction(SYNC_TO_REKORDBOX_PLAN, 'write', 0, 0)).toBeCloseTo(0.6);
	});
});
