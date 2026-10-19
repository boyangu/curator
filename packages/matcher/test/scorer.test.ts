import { describe, it, expect } from 'vitest';
import { Scorer } from '../src/scorer.js';

const s = new Scorer();

describe('normalize', () => {
	it('strips slashes', () => {
		expect(s.normalize('Hunter/Game')).toBe('hunter game');
	});
	it('strips dashes', () => {
		expect(s.normalize('Mika - Steve Bicknell Remix')).toBe('mika steve bicknell remix');
	});
	it('deaccents', () => {
		expect(s.normalize('Gefällt Mir Nicht')).toBe('gefallt mir nicht');
		expect(s.normalize('Błażej Malinowski')).toBe('blazej malinowski');
	});
	it('collapses whitespace', () => {
		expect(s.normalize('Adana   Twins  +  Upercent')).toBe('adana twins upercent');
	});
	it('handles null/undefined', () => {
		expect(s.normalize(null)).toBe('');
		expect(s.normalize(undefined)).toBe('');
	});
});

describe('baseTitle (ONLY strips Original Mix)', () => {
	it('strips (Original Mix)', () => {
		expect(s.baseTitle('Mika (Original Mix)')).toBe('Mika');
	});
	it('strips - Original Mix', () => {
		expect(s.baseTitle('Mika - Original Mix')).toBe('Mika');
	});
	it('strips [Original Mix]', () => {
		expect(s.baseTitle('Track [Original Mix]')).toBe('Track');
	});
	it('strips a bare (unbracketed) Original Mix suffix', () => {
		expect(s.baseTitle('Mika Original Mix')).toBe('Mika');
	});
	it('preserves other remixes', () => {
		expect(s.baseTitle('Mika - Steve Bicknell Remix')).toBe('Mika - Steve Bicknell Remix');
		expect(s.baseTitle('CHNKY MNKY (Stereo Underground Remix)')).toBe(
			'CHNKY MNKY (Stereo Underground Remix)'
		);
		expect(s.baseTitle('Track (Extended Mix)')).toBe('Track (Extended Mix)');
	});
	it('leaves plain titles', () => {
		expect(s.baseTitle('Plain Title')).toBe('Plain Title');
	});
});

describe('score acceptance — strict (ISRC OR title+artist+dur≤5)', () => {
	it('accepts on ISRC match alone', () => {
		const r = s.score(
			{ title: 'X', artists: ['A'], duration: 100, isrc: 'AB1234567890' },
			{ id: 1, title: 'Z', artists: ['B'], duration: 300, isrc: 'AB1234567890' }
		);
		expect(r.acceptable).toBe(true);
		expect(r.score).toBeGreaterThanOrEqual(1000);
	});

	it('accepts on title + artist + dur≤2', () => {
		const r = s.score(
			{ title: 'Ancient Ways', artists: ['Re:Axis'], duration: 415, isrc: null },
			{ id: 1, title: 'Ancient Ways', artists: ['Re:Axis'], duration: 415, isrc: 'OTHER' }
		);
		expect(r.acceptable).toBe(true);
		expect(r.signals.titleExact).toBe(true);
		expect(r.signals.artistMatch).toBe(true);
	});

	it('rejects title-only (no artist match) — was the bug we fixed', () => {
		const r = s.score(
			{ title: 'No Fear', artists: ['ele'], duration: 519, isrc: 'US83Z2624633' },
			{ id: 1, title: 'No Fear', artists: ['DeJ Loaf'], duration: 170, isrc: 'USSM11702275' }
		);
		expect(r.acceptable).toBe(false);
	});

	it('rejects artist-only (no title)', () => {
		const r = s.score(
			{ title: 'NXTBND', artists: ['Nihil Young'], duration: 405, isrc: null },
			{ id: 1, title: 'Amethyst (Extended Mix)', artists: ['Dosem', 'Nihil Young'], duration: 403, isrc: null }
		);
		expect(r.acceptable).toBe(false);
	});

	it('rejects when duration off by more than 5s', () => {
		const r = s.score(
			{ title: 'Viola', artists: ['Kellerkind'], duration: 502, isrc: null },
			{ id: 1, title: 'Viola (Mixed)', artists: ['Kellerkind'], duration: 515, isrc: 'X' }
		);
		expect(r.acceptable).toBe(false);
	});

	it('handles full title vs title+version split (Tidal style)', () => {
		// Tidal returns title="Ancient Ways" + version="Blazej Malinowski Remix"
		// Spotify provides "Ancient Ways - Blazej Malinowski Remix"
		const r = s.score(
			{
				title: 'Ancient Ways - Blazej Malinowski Remix',
				artists: ['Re:Axis'],
				duration: 415,
				isrc: null,
			},
			{
				id: 509635660,
				title: 'Ancient Ways',
				version: 'Blazej Malinowski Remix',
				artists: ['Re:Axis'],
				duration: 415,
				isrc: 'NLCK42520995',
			}
		);
		expect(r.acceptable).toBe(true);
		expect(r.signals.titleExact || r.signals.titlePartial).toBe(true);
	});

	it('matches across diacritics (Spotify accented vs Tidal not)', () => {
		const r = s.score(
			{ title: 'Gefällt Mir Nicht', artists: ['Acid Pauli'], duration: 530, isrc: null },
			{ id: 510324199, title: 'Gefallt Mir Nicht', artists: ['Acid Pauli'], duration: 530, isrc: null }
		);
		expect(r.acceptable).toBe(true);
	});

	it('matches any-of-spotify-artist against any-of-candidate-artist (collabs)', () => {
		// Spotify: I Know by Adana Twins + Upercent
		// Tidal credits primary differently — Upercent in candidate list
		const r = s.score(
			{ title: 'I Know', artists: ['Adana Twins', 'Upercent'], duration: 206, isrc: null },
			{ id: 514144642, title: 'I Know', artists: ['Upercent', 'Adana Twins'], duration: 206, isrc: null }
		);
		expect(r.acceptable).toBe(true);
	});
});

describe('pick — highest acceptable candidate wins', () => {
	it('picks the best-scoring candidate', () => {
		const target = { title: 'Track', artists: ['Artist'], duration: 200, isrc: null };
		const candidates = [
			{ id: 1, title: 'Wrong', artists: ['Artist'], duration: 200, isrc: null }, // reject: no title
			{ id: 2, title: 'Track', artists: ['Artist'], duration: 199, isrc: null }, // accept, score = 50+30+100=180
			{ id: 3, title: 'Track', artists: ['Artist'], duration: 198, isrc: null }, // accept, score = 50+30+100=180
		];
		const picked = s.pick(candidates, target);
		expect(picked).not.toBeNull();
		expect([2, 3]).toContain(picked!.id);
	});

	it('returns null when no candidate is acceptable', () => {
		const target = { title: 'Track', artists: ['Artist'], duration: 200, isrc: null };
		const candidates = [
			{ id: 1, title: 'Wrong', artists: ['Other'], duration: 200, isrc: null },
		];
		expect(s.pick(candidates, target)).toBeNull();
	});

	it('fills trace when provided', () => {
		const trace: any = {};
		const target = { title: 'Track', artists: ['Artist'], duration: 200, isrc: null };
		const candidates = [{ id: 1, title: 'Track', artists: ['Artist'], duration: 200, isrc: null }];
		s.pick(candidates, target, trace);
		expect(trace.candidates).toHaveLength(1);
		expect(trace.bestScore).toBeGreaterThan(0);
		expect(trace.picked).not.toBeNull();
	});
});