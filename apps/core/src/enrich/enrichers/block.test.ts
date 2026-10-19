import { describe, it, expect } from 'vitest';
import { ProviderBlockedError } from '@curator/matcher';
import type { FetchLike } from '@curator/beatport';
import { BeatportEnricher } from './beatport.js';
import { enrichOne } from '../runner.js';
import type { DjMetadataPatch, Enricher, EnricherOutput, EnrichmentTarget } from '../contract.js';

const target: EnrichmentTarget = {
	query: { title: 'Foundation', artists: ['Joey White'], durationSec: 375 },
};
const FULL: DjMetadataPatch = { bpm: 122, keyCamelot: '8A', genre: 'Melodic House & Techno', label: 'Anjunadeep' };

// Beatport behind a Cloudflare "Just a moment…" managed challenge.
const challengeFetch: FetchLike = async () =>
	new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge' } });

// A clean 200 with a valid but empty __NEXT_DATA__ (genuine no-match).
const emptyFetch: FetchLike = async () =>
	new Response('<html><script id="__NEXT_DATA__" type="application/json">{"props":{}}</script></html>', {
		status: 200,
	});

// A Traxsource-shaped fallback that always fills.
const traxStub: Enricher = {
	id: 'traxsource',
	produces: 'metadata',
	applicableTo: () => true,
	async enrich(): Promise<EnricherOutput | null> {
		return { kind: 'metadata', patch: FULL, sourceLink: { source: 'traxsource', sourceTrackId: 'tx1' } };
	},
};

describe('BeatportEnricher — Cloudflare block handling', () => {
	it('throws ProviderBlockedError on a challenge and then reports not-applicable (cooldown)', async () => {
		const enricher = new BeatportEnricher(challengeFetch);
		expect(enricher.applicableTo(target)).toBe(true); // usable before the block
		await expect(enricher.enrich(target)).rejects.toBeInstanceOf(ProviderBlockedError);
		expect(enricher.applicableTo(target)).toBe(false); // cooling down → batch skips it
	});

	it('returns null on a genuine empty result WITHOUT cooling down', async () => {
		const enricher = new BeatportEnricher(emptyFetch);
		await expect(enricher.enrich(target)).resolves.toBeNull();
		expect(enricher.applicableTo(target)).toBe(true); // a clean miss is not a block
	});
});

describe('enrichOne — block falls through to the fallback', () => {
	it('records errored AND lets Traxsource fill when Beatport is challenged', async () => {
		const blocked = new BeatportEnricher(challengeFetch);
		const res = await enrichOne(target, [blocked, traxStub]);
		expect(res.errored).toBe(true); // surfaced, not swallowed as a clean miss
		expect(res.patch).toMatchObject(FULL); // fallback carried it
		expect(res.sourceLinks.map((s) => s.source)).toEqual(['traxsource']);
	});

	it('after the block, a second track in the batch skips Beatport entirely (no throw)', async () => {
		const blocked = new BeatportEnricher(challengeFetch);
		await enrichOne(target, [blocked, traxStub]); // trips the cooldown
		// Second pass: Beatport is skipped via applicableTo → no error recorded.
		const res = await enrichOne(target, [blocked, traxStub]);
		expect(res.errored).toBe(false);
		expect(res.patch).toMatchObject(FULL);
	});
});
