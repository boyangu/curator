// The release date as Curator's lists and cards show it. Shared by the
// desktop's track list and the phone's player (which mirrors it in Kotlin,
// model/CoverBands.kt).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Release date for the track list. Stored as ISO "2021-03-15", "2021-03" or
// year-only "2021". A full date in the last 30 days (local calendar) reads
// as an age — "today", "1 day", "12 days" — because a fresh release is what
// a digging DJ scans for; anything older (or with no day) is "Mar, 2021" /
// "2021". The string components are parsed directly: `new Date(iso)` would
// shift a bare date by the timezone and can roll the day back.
export function fmtReleaseLabel(d: string | null | undefined, now: Date = new Date()): string {
	if (!d) return '—';
	const [ys, ms, ds] = d.split('-');
	const y = Number(ys);
	if (!ys || !Number.isFinite(y)) return '—';
	const m = ms ? Number(ms) - 1 : NaN;
	const day = ds ? Number(ds) : NaN;
	if (Number.isFinite(m) && Number.isFinite(day)) {
		const rel = new Date(y, m, day).getTime();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const days = Math.round((today - rel) / 86400000);
		if (days >= 0 && days <= 30) return days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
	}
	return MONTHS[m] ? `${MONTHS[m]}, ${ys}` : ys;
}
