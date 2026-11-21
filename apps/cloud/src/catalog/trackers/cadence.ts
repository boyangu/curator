// When a cursor is next due. Releases land on Friday (the industry's release
// day, at midnight local time across the world), so a tracker can poll
// tighter inside a Friday window and loosely the rest of the week; outside
// the window, a due time that would overshoot its start snaps back to it.
//
// That is the tracker's own cadence — the most often its source is read. How
// often a cursor is in fact read is its followers' choice (nextDueFor).

import type { CatalogReadCadence } from '@curator/protocol';

export type Cadence = {
	everyMin: number;
	friday?: { fromUtc: string; toUtc: string; everyMin: number };
};

const MIN = 60_000;
const DAY = 86400_000;
const DAY_MIN = 1440;
const WEEK_MIN = 7 * DAY_MIN;
// A weekly read of a tracker that names no Friday window of its own.
const DEFAULT_FRIDAY = { fromUtc: '00:00', toUtc: '12:00', everyMin: 120 };

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

// `spread` (0 ≤ s < 1, the cursor's own — spreadOf) keeps a tracker's cursors
// from coming due in one instant: outside the window each lands up to one
// Friday interval after its start instead of all at the start (1,842
// followed artists did on 2026-11-06, and the drain that followed took a
// 3-hour quota ban); inside it, each next poll is 1 to 1.5 intervals away, so
// a cluster the first wave left thins with every wave.
export function nextDueAt(now: number, cadence: Cadence, spread = 0): number {
	const base = now + cadence.everyMin * MIN;
	if (!cadence.friday) return base;
	const w = fridayWindow(now, cadence.friday.fromUtc, cadence.friday.toUtc);
	const interval = cadence.friday.everyMin * MIN;
	if (now >= w.start && now < w.end) return Math.min(base, now + Math.round(interval * (1 + 0.5 * spread)));
	return Math.min(base, w.start + Math.round(interval * spread));
}

// When a cursor is next due under its followers' choice (protocol
// CatalogReadCadence; tracking.ts readCadenceOf picks the most frequent among
// them). A choice only ever slows the tracker:
//   'source'  the tracker's own cadence, above;
//   'daily'   a day from now, with no tightening through Friday;
//   'weekly'  once, in the Friday window that opens next — a read inside this
//             week's window is this week's read — each cursor at its own place
//             in the window's first interval, like a wave outside it above.
export function nextDueFor(now: number, cadence: Cadence, choice: CatalogReadCadence, spread = 0): number {
	if (choice === 'source') return nextDueAt(now, cadence, spread);
	if (choice === 'daily') return now + Math.max(cadence.everyMin, DAY_MIN) * MIN;
	if (cadence.everyMin > WEEK_MIN) return now + cadence.everyMin * MIN;
	const f = cadence.friday ?? DEFAULT_FRIDAY;
	const w = fridayWindow(now, f.fromUtc, f.toUtc);
	const start = now >= w.start ? w.start + 7 * DAY : w.start;
	return start + Math.round(Math.min(f.everyMin * MIN, w.end - w.start) * spread);
}

// A cursor's place in a wave, stable per object id (FNV-1a), in [0, 1).
export function spreadOf(objectId: string): number {
	let h = 2166136261;
	for (const ch of objectId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
	return (h % 10_000) / 10_000;
}

// After a failed poll: 15 min, doubling per consecutive failure, capped at a day.
export function backoffAt(now: number, failCount: number): number {
	return now + Math.min(2 ** Math.max(0, failCount - 1) * 15 * MIN, DAY);
}
