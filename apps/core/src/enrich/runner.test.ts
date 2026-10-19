import { describe, it, expect } from 'vitest';
import { enrichOne } from './runner.js';
import type { Enricher, EnricherOutput, EnrichmentTarget, DjMetadataPatch } from './contract.js';

// A metadata enricher that records whether it ran and returns a fixed patch
// (or null to mean "no match"). Mirrors how Beatport/Traxsource plug in.
function stub(id: string, patch: DjMetadataPatch | null, ran: { ids: string[] }): Enricher {
	return {
		id,
		produces: 'metadata',
		applicableTo: () => true,
		async enrich(): Promise<EnricherOutput | null> {
			ran.ids.push(id);
			return patch ? { kind: 'metadata', patch, sourceLink: { source: id, sourceTrackId: id } } : null;
		},
	};
}

const target: EnrichmentTarget = { query: { title: 'T', artists: ['A'] } };
const FULL: DjMetadataPatch = { bpm: 120, keyCamelot: '8A', genre: 'House', label: 'L' };

describe('enrichOne — primary + fallback chain', () => {
	it('skips the fallback when the primary fills every core field', async () => {
		const ran = { ids: [] as string[] };
		const res = await enrichOne(target, [stub('primary', FULL, ran), stub('fallback', { genre: 'X' }, ran)]);
		expect(ran.ids).toEqual(['primary']); // fallback never ran
		expect(res.patch).toMatchObject(FULL);
		expect(res.sourceLinks.map((s) => s.source)).toEqual(['primary']);
	});

	it('runs the fallback and fills everything when the primary returns null', async () => {
		const ran = { ids: [] as string[] };
		const res = await enrichOne(target, [stub('primary', null, ran), stub('fallback', FULL, ran)]);
		expect(ran.ids).toEqual(['primary', 'fallback']);
		expect(res.patch).toMatchObject(FULL);
		expect(res.sourceLinks.map((s) => s.source)).toEqual(['fallback']);
	});

	it('fills only the gap the primary left, without overwriting its values', async () => {
		const ran = { ids: [] as string[] };
		const primary: DjMetadataPatch = { bpm: 120, keyCamelot: '8A', genre: null, label: 'PrimaryLabel' };
		const fallback: DjMetadataPatch = { bpm: 999, keyCamelot: '1A', genre: 'FilledGenre', label: 'FallbackLabel' };
		const res = await enrichOne(target, [stub('primary', primary, ran), stub('fallback', fallback, ran)]);
		expect(ran.ids).toEqual(['primary', 'fallback']); // genre missing → fallback runs
		expect(res.patch).toEqual({ bpm: 120, keyCamelot: '8A', genre: 'FilledGenre', label: 'PrimaryLabel' });
	});

	it('never overwrites a filled field with a later null', async () => {
		const ran = { ids: [] as string[] };
		const primary: DjMetadataPatch = { bpm: 120, keyCamelot: '8A', genre: null, label: null };
		const fallback: DjMetadataPatch = { bpm: null, keyCamelot: null, genre: null, label: null };
		const res = await enrichOne(target, [stub('primary', primary, ran), stub('fallback', fallback, ran)]);
		expect(res.patch).toMatchObject({ bpm: 120, keyCamelot: '8A' });
	});

	it('flags errored when an applicable enricher throws, distinct from a clean miss', async () => {
		const ran = { ids: [] as string[] };
		const thrower: Enricher = {
			id: 'thrower',
			produces: 'metadata',
			applicableTo: () => true,
			async enrich(): Promise<EnricherOutput | null> { ran.ids.push('thrower'); throw new Error('WAF 403'); },
		};
		// Throw + no fallback match → null patch, errored true (retry, not 'na').
		const errd = await enrichOne(target, [thrower]);
		expect(errd.patch).toBeNull();
		expect(errd.errored).toBe(true);

		// Clean miss (enricher returns null, no throw) → null patch, errored false.
		const miss = await enrichOne(target, [stub('miss', null, ran)]);
		expect(miss.patch).toBeNull();
		expect(miss.errored).toBe(false);

		// A thrower followed by a hitting fallback → patch filled AND errored true.
		const partial = await enrichOne(target, [thrower, stub('fallback', FULL, ran)]);
		expect(partial.patch).toMatchObject(FULL);
		expect(partial.errored).toBe(true);
	});
});
