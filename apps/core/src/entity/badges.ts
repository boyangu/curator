// An artist's badges: what its output earns it, read off the catalogue's
// account of its releases (browse `activity`, `releaseCount`).
//   veteran    over 15 years from its first release to its latest.
//   workhorse  a release every 6 weeks or 15 new tracks a year, over the
//              recent window (the catalogue's `recentDays`). An artist newer
//              than the window is measured over its own time — but over a
//              year at least, so one launch week is not a habit.
//   prolific   over 75 releases in the catalogue.

import type { ArtistActivity, ArtistBadge } from '@curator/shared';

const YEAR_MS = 365.25 * 86_400_000;
const VETERAN_YEARS = 15;
const WORKHORSE_RELEASES_A_YEAR = 52 / 6;
const WORKHORSE_TRACKS_A_YEAR = 15;
const PROLIFIC_RELEASES = 75;

const at = (date: string | null): number | null => {
	const t = date ? Date.parse(date) : NaN;
	return Number.isFinite(t) ? t : null;
};

export function artistBadges(activity: ArtistActivity | null, releaseCount: number | null, now: number): ArtistBadge[] {
	const out: ArtistBadge[] = [];
	const first = at(activity?.firstRelease ?? null);
	const last = at(activity?.lastRelease ?? null);
	if (first !== null && last !== null && (last - first) / YEAR_MS > VETERAN_YEARS) out.push('veteran');
	if (activity && first !== null) {
		const years = Math.max(1, Math.min(activity.recentDays * 86_400_000, now - first) / YEAR_MS);
		if (activity.recentReleases / years >= WORKHORSE_RELEASES_A_YEAR || activity.recentTracks / years >= WORKHORSE_TRACKS_A_YEAR) out.push('workhorse');
	}
	if ((releaseCount ?? 0) > PROLIFIC_RELEASES) out.push('prolific');
	return out;
}
