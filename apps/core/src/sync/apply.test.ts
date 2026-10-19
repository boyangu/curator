// buildPullPatch's "empty" rule must match the exporter's omit-if-empty rule
// or the two directions disagree about what a value means. rekordbox stores
// "unrated" as 0 (never NULL), so a 0 arriving under nullPreserve is "rb has
// nothing here", not "clear Curator's stars" — the 2026-09-15 first-link
// pull got that wrong and wiped 21 ratings.

import { describe, expect, it } from 'vitest';
import { buildPullPatch } from './apply.js';

describe('buildPullPatch — nullPreserve empties', () => {
	it('rating 0 is empty under nullPreserve (rb "unrated" sentinel)', () => {
		const patch = buildPullPatch({ rating: 0, title: 'T' }, null, { nullPreserve: true, clearOverrides: false });
		expect('rating' in patch).toBe(false);
		expect(patch['title']).toBe('T');
	});

	it('rating null is empty under nullPreserve', () => {
		const patch = buildPullPatch({ rating: null }, null, { nullPreserve: true, clearOverrides: false });
		expect('rating' in patch).toBe(false);
	});

	it('a real rating still pulls under nullPreserve (guard does not over-suppress)', () => {
		const patch = buildPullPatch({ rating: 4 }, null, { nullPreserve: true, clearOverrides: false });
		expect(patch['rating']).toBe(4);
	});

	it('rating 0 pulls on the merge path — a genuine rb de-rate survives the three-way diff', () => {
		const patch = buildPullPatch({ rating: 0 }, null, { nullPreserve: false, clearOverrides: false });
		expect(patch['rating']).toBe(0);
	});

	it('null / empty text stays preserved; non-empty text pulls', () => {
		const patch = buildPullPatch(
			{ genre: null, label: '', comment: 'hi', colorLabel: null },
			null,
			{ nullPreserve: true, clearOverrides: false },
		);
		expect('genre' in patch).toBe(false);
		expect('label' in patch).toBe(false);
		expect('colorLabel' in patch).toBe(false);
		expect(patch['comment']).toBe('hi');
	});
});
