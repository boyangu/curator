// Decision-table tests for the three-way merge engine. Every cell of the
// per-field matrix is pinned — a wrong branch here silently overwrites
// user edits in one app or the other, which is exactly the bug class this
// engine exists to kill.

import { describe, expect, it } from 'vitest';
import type { CueUnit, FieldsSeen } from '@curator/shared/sync';
import { mergeCues, mergeTrackFields } from './merge.js';

describe('mergeTrackFields', () => {
	const base: FieldsSeen = { title: 'Old Title', genre: 'House', rating: 3 };

	it('neither changed: no-op, baseline restated', () => {
		const r = mergeTrackFields(base, { title: 'Old Title' }, { title: 'Old Title' });
		expect(r.pull).toEqual({});
		expect(r.conflicts).toEqual([]);
		expect(r.seenAdvance).toEqual({ title: 'Old Title' });
	});

	it('theirs changed, ours stable: pull', () => {
		const r = mergeTrackFields(base, { title: 'New RB Title' }, { title: 'Old Title' });
		expect(r.pull).toEqual({ title: 'New RB Title' });
		expect(r.conflicts).toEqual([]);
		expect(r.seenAdvance).toEqual({ title: 'New RB Title' });
	});

	it('ours changed, theirs stable: no pull, baseline restated (push handles it)', () => {
		const r = mergeTrackFields(base, { title: 'Old Title' }, { title: 'My Edit' });
		expect(r.pull).toEqual({});
		expect(r.conflicts).toEqual([]);
		expect(r.seenAdvance).toEqual({ title: 'Old Title' });
	});

	it('both changed to the same value: converged, no conflict', () => {
		const r = mergeTrackFields(base, { title: 'Same Edit' }, { title: 'Same Edit' });
		expect(r.pull).toEqual({});
		expect(r.conflicts).toEqual([]);
		expect(r.seenAdvance).toEqual({ title: 'Same Edit' });
	});

	it('both changed differently: conflict, baseline NOT advanced for that field', () => {
		const r = mergeTrackFields(base, { title: 'RB Edit' }, { title: 'Curator Edit' });
		expect(r.pull).toEqual({});
		expect(r.conflicts).toEqual([
			{ field: 'title', base: 'Old Title', theirs: 'RB Edit', ours: 'Curator Edit' },
		]);
		expect(r.seenAdvance).toEqual({});
	});

	it('mixed fields resolve independently', () => {
		const r = mergeTrackFields(
			base,
			{ title: 'RB Edit', genre: 'Techno', rating: 3 },
			{ title: 'Curator Edit', genre: 'House', rating: 5 }
		);
		expect(r.pull).toEqual({ genre: 'Techno' }); // theirs-only change
		expect(r.conflicts.map((c) => c.field)).toEqual(['title']); // both changed
		// genre advanced, rating restated (theirs stable), title held back.
		expect(r.seenAdvance).toEqual({ genre: 'Techno', rating: 3 });
	});

	it('fields absent from theirs are ignored entirely', () => {
		const r = mergeTrackFields(base, { genre: 'Techno' }, { title: 'My Edit', genre: 'House' });
		expect(r.pull).toEqual({ genre: 'Techno' });
		expect(r.conflicts).toEqual([]);
		expect('title' in r.seenAdvance).toBe(false);
	});

	it('null base: every present field reported unseeded, nothing merged', () => {
		const r = mergeTrackFields(null, { title: 'X', rating: 4 }, { title: 'Y', rating: 2 });
		expect(r.pull).toEqual({});
		expect(r.conflicts).toEqual([]);
		expect(r.unseeded.sort()).toEqual(['rating', 'title']);
	});

	it('field missing from a partial base is unseeded; seeded fields still merge', () => {
		const r = mergeTrackFields({ title: 'Old Title' }, { title: 'RB Edit', comment: 'hi' }, { title: 'Old Title', comment: '' });
		expect(r.pull).toEqual({ title: 'RB Edit' });
		expect(r.unseeded).toEqual(['comment']);
	});

	describe('normalization (mirrors writer.py _set_if_changed)', () => {
		it('null ≡ empty string for text fields', () => {
			const r = mergeTrackFields({ comment: null }, { comment: '' }, { comment: null });
			expect(r.pull).toEqual({});
			expect(r.conflicts).toEqual([]);
		});

		it('"" → null change on one side is a no-op, not a pull', () => {
			const r = mergeTrackFields({ label: '' }, { label: null }, { label: 'Anjuna' });
			expect(r.pull).toEqual({});
			expect(r.conflicts).toEqual([]);
		});

		it('rating null ≡ 0', () => {
			const r = mergeTrackFields({ rating: 0 }, { rating: null }, { rating: 4 });
			expect(r.pull).toEqual({});
			expect(r.conflicts).toEqual([]);
			// ours changed (0→4): push side handles; baseline restates theirs.
			expect(r.seenAdvance).toEqual({ rating: 0 });
		});

		it('genuine rating divergence still conflicts', () => {
			const r = mergeTrackFields({ rating: 3 }, { rating: 5 }, { rating: 1 });
			expect(r.conflicts).toEqual([{ field: 'rating', base: 3, theirs: 5, ours: 1 }]);
		});
	});
});

describe('mergeCues', () => {
	const hot = (slot: number, pos: number, extra?: Partial<CueUnit>): CueUnit => ({
		kind: 'hot',
		slot,
		positionSec: pos,
		lengthSec: null,
		color: null,
		name: null,
		...extra,
	});
	const mem = (slot: number, pos: number, extra?: Partial<CueUnit>): CueUnit => ({
		kind: 'memory',
		slot,
		positionSec: pos,
		lengthSec: null,
		color: null,
		name: null,
		...extra,
	});

	it('identical sets: no ops, baseline restated', () => {
		const set = [hot(0, 10), mem(100, 30)];
		const r = mergeCues(set, set, set);
		expect(r.apply).toEqual([]);
		expect(r.conflicts).toEqual([]);
		expect(r.seenAdvance).toHaveLength(2);
	});

	it('added on their side: upsert', () => {
		const r = mergeCues([], [hot(2, 45.5)], []);
		expect(r.apply).toEqual([{ op: 'upsert', unit: hot(2, 45.5) }]);
		expect(r.seenAdvance).toEqual([hot(2, 45.5)]);
	});

	it('added on our side: untouched (push handles), not in baseline', () => {
		const r = mergeCues([], [], [hot(2, 45.5)]);
		expect(r.apply).toEqual([]);
		expect(r.conflicts).toEqual([]);
		expect(r.seenAdvance).toEqual([]);
	});

	it('deleted on their side, untouched on ours: delete ours', () => {
		const unit = hot(1, 20);
		const r = mergeCues([unit], [], [unit]);
		expect(r.apply).toEqual([{ op: 'delete', unit }]);
		expect(r.seenAdvance).toEqual([]);
	});

	it('deleted on both sides: converged no-op', () => {
		const unit = hot(1, 20);
		const r = mergeCues([unit], [], []);
		expect(r.apply).toEqual([]);
		expect(r.conflicts).toEqual([]);
		expect(r.seenAdvance).toEqual([]);
	});

	it('edited on their side only (color change): upsert', () => {
		const before = hot(0, 10);
		const after = hot(0, 10, { color: 'cti:22' });
		const r = mergeCues([before], [after], [before]);
		expect(r.apply).toEqual([{ op: 'upsert', unit: after }]);
	});

	it('edited differently on both sides: conflict, old base kept in baseline', () => {
		const b = hot(0, 10);
		const t = hot(0, 10, { color: 'cti:22' });
		const o = hot(0, 10, { name: 'Drop' });
		const r = mergeCues([b], [t], [o]);
		expect(r.apply).toEqual([]);
		expect(r.conflicts).toEqual([{ key: 'hot:0', base: b, theirs: t, ours: o }]);
		expect(r.seenAdvance).toEqual([b]);
	});

	it('their edit vs our delete: conflict', () => {
		const b = hot(3, 60);
		const t = hot(3, 60, { name: 'Build' });
		const r = mergeCues([b], [t], []);
		expect(r.conflicts).toEqual([{ key: 'hot:3', base: b, theirs: t, ours: null }]);
	});

	it('memory cues are identified by position: earlier insert does NOT shift identity', () => {
		// rb assigns memory slots as ordinals-by-time (100+i). Adding an
		// earlier memory cue in rb shifts every subsequent ordinal — the
		// position key must absorb that without spurious conflicts.
		const a = mem(100, 30);
		const bUnit = mem(101, 60);
		// rb added a new cue at 10s; existing ones renumber to 101/102.
		const theirs = [mem(100, 10), mem(101, 30), mem(102, 60)];
		const r = mergeCues([a, bUnit], theirs, [a, bUnit]);
		expect(r.conflicts).toEqual([]);
		expect(r.apply).toEqual([{ op: 'upsert', unit: mem(100, 10) }]);
	});

	it('point cue lengthSec null ≡ 0', () => {
		const b = hot(0, 10, { lengthSec: null });
		const t = hot(0, 10, { lengthSec: 0 });
		const r = mergeCues([b], [t], [b]);
		expect(r.apply).toEqual([]);
		expect(r.conflicts).toEqual([]);
	});

	it('loop length change is a real edit', () => {
		const b = hot(0, 10, { lengthSec: 4 });
		const t = hot(0, 10, { lengthSec: 8 });
		const r = mergeCues([b], [t], [b]);
		expect(r.apply).toEqual([{ op: 'upsert', unit: t }]);
	});
});
