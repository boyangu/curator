// Branch matrix for the per-track last-modified-wins decision. This is the
// arbitration point between Curator edits and Rekordbox edits — a wrong
// branch here either rolls back user work or resurrects stale Rekordbox
// state on every import, so every decision-table row is pinned.

import { describe, expect, it } from 'vitest';
import { decideFirstLinkSide, decideRbWins, firstLinkMembershipSide } from './importer.js';

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

// The first-link rule (no rekordbox_link yet): later write wins, per field.
// Args: rbHas, accountHas, rbTs, accountTs.
describe('decideFirstLinkSide', () => {
	it('no account clock: today\'s behaviour, rekordbox wins', () => {
		expect(decideFirstLinkSide(true, true, 1_000, null)).toBe('rb');
		expect(decideFirstLinkSide(false, true, 1_000, null)).toBe('rb');
	});

	it('only one side has a value: that side, whatever the clocks', () => {
		expect(decideFirstLinkSide(true, false, 1_000, 9_000)).toBe('rb');
		expect(decideFirstLinkSide(false, true, 9_000, 1_000)).toBe('account');
	});

	it('both have values: the later write wins', () => {
		expect(decideFirstLinkSide(true, true, 9_000, 1_000)).toBe('rb');
		expect(decideFirstLinkSide(true, true, 1_000, 9_000)).toBe('account');
	});

	it('a tie, or rekordbox without a timestamp, keeps the account', () => {
		expect(decideFirstLinkSide(true, true, 4_000, 4_000)).toBe('account');
		expect(decideFirstLinkSide(true, true, null, 4_000)).toBe('account');
	});
});

describe('firstLinkMembershipSide (an account removal vs rekordbox still holding it)', () => {
	it('the later write wins; a tie or no rb timestamp keeps the removal', () => {
		expect(firstLinkMembershipSide(9_000, 1_000)).toBe('rb');
		expect(firstLinkMembershipSide(1_000, 9_000)).toBe('account');
		expect(firstLinkMembershipSide(4_000, 4_000)).toBe('account');
		expect(firstLinkMembershipSide(null, 4_000)).toBe('account');
	});
});
