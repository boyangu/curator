// Phase-preserving beat-jump math — the renderer twin of the sidecar's
// beatjump.rs, kept in provable agreement by mirrored test suites
// (beatmath.test.ts ↔ `cargo test` in apps/audio). The sidecar owns the
// authoritative jump for local playback (engine.rs::jump_beats computes
// against the live cursor); this walk serves the fallback paths — the
// sidecar-disabled/dead case and any future streaming backend that grows
// a beatgrid — and the optimistic UI math.
//
// The model: map time ↔ continuous beat index (piecewise-linear between
// grid entries), so a jump is just `index + delta` — the fractional part
// IS the sub-beat phase, preserved for free, and variable tempo falls
// out of the piecewise mapping. Outside the grid both mappings
// extrapolate with the edge interval: analyzer grids often start after
// the intro / stop before the outro, and the old clamp-to-grid walk
// could turn "jump back 4" from an intro into a FORWARD move to beat 0.

function secToIndex(grid: ArrayLike<number>, posSec: number): number {
	const n = grid.length;
	if (posSec <= grid[0]!) {
		return (posSec - grid[0]!) / (grid[1]! - grid[0]!);
	}
	if (posSec >= grid[n - 1]!) {
		return (n - 1) + (posSec - grid[n - 1]!) / (grid[n - 1]! - grid[n - 2]!);
	}
	// Largest i with grid[i] <= posSec; the range checks above pin
	// 0 <= i < n-1.
	let lo = 0, hi = n - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (grid[mid]! <= posSec) lo = mid; else hi = mid - 1;
	}
	return lo + (posSec - grid[lo]!) / (grid[lo + 1]! - grid[lo]!);
}

function indexToSec(grid: ArrayLike<number>, idx: number): number {
	const n = grid.length;
	if (idx <= 0) {
		return grid[0]! + idx * (grid[1]! - grid[0]!);
	}
	if (idx >= n - 1) {
		return grid[n - 1]! + (idx - (n - 1)) * (grid[n - 1]! - grid[n - 2]!);
	}
	const i = Math.floor(idx);
	return grid[i]! + (idx - i) * (grid[i + 1]! - grid[i]!);
}

// Translate posSec by exactly deltaBeats grid-beats (fractional allowed,
// negative = backward), clamped to [0, durationSec]. A clamped landing
// loses grid phase — every DJ app accepts that at the track edges.
// Caller guarantees grid.length >= 2 and ascending (analyzer output is).
export function computeBeatJumpTarget(
	grid: ArrayLike<number>,
	posSec: number,
	deltaBeats: number,
	durationSec: number,
): number {
	const raw = indexToSec(grid, secToIndex(grid, posSec) + deltaBeats);
	return Math.min(Math.max(raw, 0), durationSec);
}
