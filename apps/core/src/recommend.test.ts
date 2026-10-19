import { describe, expect, it } from 'vitest';
import { scoreCandidates, DEFAULT_RECOMMEND_WEIGHTS, type CandidateCounts } from './recommend.js';

const cand = (id: string, kind: 'tag' | 'playlist', c: Partial<CandidateCounts['columns']>): CandidateCounts => ({
	id, kind,
	columns: { cooccur: 0, artist: 0, genre: 0, label: 0, model: 0, ...c },
});

describe('scoreCandidates', () => {
	it('sums weighted column counts into the score', () => {
		const r = scoreCandidates([cand('t1', 'tag', { artist: 3, genre: 2 })])[0]!;
		// artist 2*3 + genre 1*2 = 8
		expect(r.score).toBe(2 * 3 + 1 * 2);
	});

	it('drops candidates already on the selection', () => {
		const out = scoreCandidates(
			[cand('t1', 'tag', { label: 5 }), cand('t2', 'tag', { label: 5 })],
			{ excludeIds: new Set(['t1']) },
		);
		expect(out.map((r) => r.id)).toEqual(['t2']);
	});

	it('drops zero-score candidates', () => {
		expect(scoreCandidates([cand('t1', 'tag', {})])).toEqual([]);
	});

	it('reason is the dominant weighted column, specific reasons break ties', () => {
		// label 2*4=8 beats genre 1*4=4 → "same label"
		expect(scoreCandidates([cand('t1', 'tag', { label: 4, genre: 4 })])[0]!.reason).toBe('same label');
		// genre dominates by count: 1*20=20 > label 2*1=2 → "same genre"
		expect(scoreCandidates([cand('t2', 'tag', { genre: 20, label: 1 })])[0]!.reason).toBe('same genre');
		// artist and label tie in weighted contribution (2*2 each) → label wins (more specific)
		expect(scoreCandidates([cand('t3', 'tag', { artist: 2, label: 2 })])[0]!.reason).toBe('same label');
		// cooccur only → "often together"
		expect(scoreCandidates([cand('t4', 'tag', { cooccur: 3 })])[0]!.reason).toBe('often together');
		// model only → folded-in audio nudge
		expect(scoreCandidates([cand('t5', 'tag', { model: 1 })])[0]!.reason).toBe('matches the sound');
	});

	it('source-balances: keeps up to perKind of EACH kind so both surface', () => {
		// 3 high-scoring playlists + 1 low-scoring tag; perKind=2 must still keep the tag.
		const out = scoreCandidates(
			[
				cand('p1', 'playlist', { genre: 100 }),
				cand('p2', 'playlist', { genre: 90 }),
				cand('p3', 'playlist', { genre: 80 }),
				cand('t1', 'tag', { label: 1 }),
			],
			{ perKind: 2 },
		);
		const kinds = out.map((r) => r.kind);
		expect(kinds).toContain('tag');       // the tag survived the balance
		expect(out.filter((r) => r.kind === 'playlist').length).toBe(2); // capped per kind
		// merged result is sorted by score desc
		expect(out).toEqual([...out].sort((a, b) => b.score - a.score));
	});

	it('uses the default weights when none supplied', () => {
		const r = scoreCandidates([cand('t1', 'tag', { cooccur: 1 })])[0]!;
		expect(r.score).toBe(DEFAULT_RECOMMEND_WEIGHTS.cooccur);
	});
});
