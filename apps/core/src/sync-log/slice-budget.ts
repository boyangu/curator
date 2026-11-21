// How long one transaction of the sync client's background work may hold its
// thread, relative to the desktop's budgets.
//
// The work in this folder that touches every row — loading a snapshot,
// making the rows of the account's tracks, applying a pulled page — runs in
// slices: a transaction of a few dozen milliseconds, then a yield. Those
// budgets (40 ms a snapshot slice, 100 ms a page's apply) are sized for the
// desktop, where the thread is the app's main loop and a longer hold is a
// stutter the user sees.
//
// A host that syncs on a thread of its own — a phone's sync core — has no
// such neighbour, and every slice costs a fixed part on top of its rows (the
// commit, a fresh record store, the projection's set-up, a status event).
// Measured 2026-11-20 on a phone joining a 39k-track library: 251 s at
// scale 1, 202 s at 6, 191 s at 12, the same rows each time; a pull of
// 5,600 ops went from 10 s to 6 s.
//
// One scale for the process (the sync client sets it from its options), read
// where a budget is used. 1 is the desktop.

let scale = 1;

export function setSliceScale(n: number | undefined): void {
	scale = n !== undefined && Number.isFinite(n) && n >= 1 ? n : 1;
}

// A time budget, scaled.
export function sliceMs(desktopMs: number): number {
	return desktopMs * scale;
}

// A row count that exists to keep a slice short, scaled the same way.
export function sliceRows(desktopRows: number): number {
	return Math.round(desktopRows * scale);
}
