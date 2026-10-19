// Artist tokenization coverage. Rekordbox-imported tracks store every
// credited artist as ONE comma-joined string; file tags and streaming APIs
// deliver them individually. Whole-string comparison could never match the
// two shapes, which silently rejected correct matches (the 2026-06-25
// scanner incident minted duplicate rows for ~45 curated tracks this way).

import { describe, it, expect } from 'vitest';
import { sharedScorer } from './scorer.js';

describe('artistTokens', () => {
	it('splits comma-joined artist strings', () => {
		expect(sharedScorer.artistTokens(['Madloch, Subnode, Bookwood']))
			.toEqual(new Set(['madloch', 'subnode', 'bookwood']));
	});
	it('splits on feat./ft./& and keeps both sides comparable', () => {
		expect(sharedScorer.artistTokens(['Frankey & Sandrino feat. Charlotte Riby']))
			.toEqual(new Set(['frankey', 'sandrino', 'charlotte riby']));
		// The same duo delivered as a single tag entry tokenizes identically.
		expect(sharedScorer.artistTokens(['Frankey & Sandrino']))
			.toEqual(new Set(['frankey', 'sandrino']));
	});
});

describe('score with joined vs split artists', () => {
	const rbRow = {
		id: 'rb',
		title: "Lion's Mane - Bookwood Remix",
		artists: ["Madloch, Subnode, Bookwood"],
		duration: 358,
		isrc: null,
	};

	it('accepts a file-tag target with individually split artists', () => {
		const r = sharedScorer.score(
			{ title: "Lion's Mane (Bookwood Remix)", artists: ['Madloch', 'Subnode'], duration: 358, isrc: null },
			rbRow,
		);
		expect(r.acceptable).toBe(true);
		expect(r.signals.artistMatchCount).toBe(2);
		expect(r.signals.titleExact).toBe(true);
	});

	it('still rejects when no artist token overlaps', () => {
		const r = sharedScorer.score(
			{ title: "Lion's Mane (Bookwood Remix)", artists: ['Totally Different'], duration: 358, isrc: null },
			rbRow,
		);
		expect(r.acceptable).toBe(false);
	});

	it('normalize folds commas/semicolons so joined strings compare whole too', () => {
		expect(sharedScorer.normalize('Madloch, Subnode; Bookwood')).toBe('madloch subnode bookwood');
	});
});
