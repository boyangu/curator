import { describe, expect, it } from 'vitest';
import type { ArtistActivity } from '@curator/shared';
import { artistBadges } from './badges.js';

const NOW = Date.parse('2026-11-19');
const activity = (over: Partial<ArtistActivity> = {}): ArtistActivity => ({ firstRelease: '2020-01-01', lastRelease: '2026-10-01', recentDays: 730, recentReleases: 0, recentTracks: 0, ...over });

describe('artist badges', () => {
	it('veteran: over 15 years from the first release to the latest', () => {
		expect(artistBadges(activity({ firstRelease: '2009-01-01', lastRelease: '2026-01-01' }), 10, NOW)).toEqual(['veteran']);
		expect(artistBadges(activity({ firstRelease: '2011-06-01', lastRelease: '2026-01-01' }), 10, NOW)).toEqual([]);
		expect(artistBadges(activity({ firstRelease: null }), 10, NOW)).toEqual([]);
	});

	it('workhorse: a release every 6 weeks or 15 new tracks a year over the recent window', () => {
		// Two years: 18 releases is one every ~6 weeks, 17 is not.
		expect(artistBadges(activity({ recentReleases: 18 }), 30, NOW)).toEqual(['workhorse']);
		expect(artistBadges(activity({ recentReleases: 17 }), 30, NOW)).toEqual([]);
		expect(artistBadges(activity({ recentTracks: 30 }), 30, NOW)).toEqual(['workhorse']);
		expect(artistBadges(activity({ recentTracks: 29 }), 30, NOW)).toEqual([]);
	});

	it('measures an artist newer than the window over its own time, but a year at least', () => {
		// Fourteen months in, 12 releases: 10 a year.
		expect(artistBadges(activity({ firstRelease: '2025-09-19', recentReleases: 12 }), 12, NOW)).toEqual(['workhorse']);
		// Two months in, 8 releases: still counted over a full year.
		expect(artistBadges(activity({ firstRelease: '2026-09-19', recentReleases: 8 }), 8, NOW)).toEqual([]);
	});

	it('prolific: over 75 releases in the catalogue', () => {
		expect(artistBadges(null, 76, NOW)).toEqual(['prolific']);
		expect(artistBadges(null, 75, NOW)).toEqual([]);
		expect(artistBadges(activity({ firstRelease: '2001-01-01', recentReleases: 40 }), 300, NOW)).toEqual(['veteran', 'workhorse', 'prolific']);
	});
});
