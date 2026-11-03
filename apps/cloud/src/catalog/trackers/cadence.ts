// When a cursor is next due. Releases land on Friday (the industry's release
// day, at midnight local time across the world), so a tracker can poll
// tighter inside a Friday window and loosely the rest of the week; outside
// the window, a due time that would overshoot its start snaps back to it.

export type Cadence = {
	everyMin: number;
	friday?: { fromUtc: string; toUtc: string; everyMin: number };
};

const MIN = 60_000;
const DAY = 86400_000;

function minutesOf(hhmm: string): number {
	const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
	if (!m) throw new Error(`bad time ${hhmm}`);
	return Number(m[1]) * 60 + Number(m[2]);
}

// The Friday window that contains `t` or comes next after it.
function fridayWindow(t: number, from: string, to: string): { start: number; end: number } {
	const d = new Date(t);
	const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	const daysToFriday = (5 - d.getUTCDay() + 7) % 7;
	let start = midnight + daysToFriday * DAY + minutesOf(from) * MIN;
	let end = midnight + daysToFriday * DAY + minutesOf(to) * MIN;
	if (end <= t) {
		start += 7 * DAY;
		end += 7 * DAY;
	}
	return { start, end };
}

export function nextDueAt(now: number, cadence: Cadence): number {
	const base = now + cadence.everyMin * MIN;
	if (!cadence.friday) return base;
	const w = fridayWindow(now, cadence.friday.fromUtc, cadence.friday.toUtc);
	if (now >= w.start && now < w.end) return Math.min(base, now + cadence.friday.everyMin * MIN);
	return Math.min(base, w.start);
}

// After a failed poll: 15 min, doubling per consecutive failure, capped at a day.
export function backoffAt(now: number, failCount: number): number {
	return now + Math.min(2 ** Math.max(0, failCount - 1) * 15 * MIN, DAY);
}
