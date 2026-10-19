// Branch matrix for the per-track last-modified-wins decision. This is the
// arbitration point between Curator edits and Rekordbox edits — a wrong
// branch here either rolls back user work or resurrects stale Rekordbox
// state on every import, so every decision-table row is pinned.

import { describe, expect, it } from 'vitest';
import { decideRbWins } from './importer.js';

const at = (ms: number): Date => new Date(ms);

describe('decideRbWins', () => {
	it('first import (no baseline): Rekordbox wins, regardless of timestamps', () => {
		expect(decideRbWins(at(1_000), at(2_000), null)).toBe(true);
		expect(decideRbWins(null, at(2_000), null)).toBe(true);
	});

	it('rb reported no timestamp: Curator keeps its row', () => {
		expect(decideRbWins(null, at(2_000), at(1_000))).toBe(false);
	});

	it('only Rekordbox changed since baseline: Rekordbox wins', () => {
		expect(decideRbWins(at(3_000), at(1_000), at(2_000))).toBe(true);
	});

	it('only Curator changed since baseline: Curator keeps', () => {
		expect(decideRbWins(at(1_000), at(3_000), at(2_000))).toBe(false);
	});

	it('neither changed since baseline: Curator keeps (no-op import)', () => {
		expect(decideRbWins(at(1_000), at(1_500), at(2_000))).toBe(false);
	});

	it('both changed: higher wall-clock wins', () => {
		expect(decideRbWins(at(5_000), at(4_000), at(2_000))).toBe(true);
		expect(decideRbWins(at(4_000), at(5_000), at(2_000))).toBe(false);
	});

	it('both changed with identical timestamps: Curator keeps (tie ≠ rb-newer)', () => {
		expect(decideRbWins(at(4_000), at(4_000), at(2_000))).toBe(false);
	});

	it('timestamps equal to the baseline count as unchanged', () => {
		// rb == seen → rb unchanged; curator > seen → only Curator changed.
		expect(decideRbWins(at(2_000), at(3_000), at(2_000))).toBe(false);
		// curator == seen, rb > seen → only rb changed.
		expect(decideRbWins(at(3_000), at(2_000), at(2_000))).toBe(true);
	});
});
