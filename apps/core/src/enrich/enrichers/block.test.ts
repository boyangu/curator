import { describe, it, expect } from 'vitest';
import { ProviderBlockedError, ProviderUnavailableError } from '@curator/matcher';
import type { FetchLike } from '@curator/beatport';
import { BeatportEnricher } from './beatport.js';
import { enrichOne } from '../runner.js';
import type { DjMetadataPatch, Enricher, EnricherOutput, EnrichmentTarget } from '@curator/sync-core/enrich/contract';

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

describe('BeatportEnricher — our route down is not a block', () => {
	it('passes the unavailable reason up, pauses, and the skipped calls keep that reason', async () => {
		let calls = 0;
		const down: FetchLike = async () => { calls++; throw new ProviderUnavailableError('beatport', 'FlareSolverr at http://localhost:8191: connection refused'); };
		const enricher = new BeatportEnricher(down);
		const err = await enricher.enrich(target).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ProviderUnavailableError);
		expect((err as Error).message).toContain('connection refused');
		expect(enricher.applicableTo(target)).toBe(false);
		expect(enricher.blockedUntil()).toBeGreaterThan(Date.now());
		// A direct lookup during the pause reports the route, not Cloudflare.
		const again = await enricher.enrich(target).catch((e: unknown) => e);
		expect(again).toBeInstanceOf(ProviderUnavailableError);
		expect(calls).toBe(1);
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
		// Every fact, but Traxsource's: Beatport is asked once it reopens.
		expect(res.provisional).toBe(true);
		expect(res.deferredUntil).toBe(blocked.blockedUntil());
	});

	it('a fallback miss behind the block is deferred until Beatport reopens, not a clean miss', async () => {
		const blocked = new BeatportEnricher(challengeFetch);
		const miss: Enricher = { ...traxStub, enrich: async () => null };
		const first = await enrichOne(target, [blocked, miss]);
		expect(first.patch).toBeNull();
		expect(first.deferredUntil).toBe(blocked.blockedUntil());
		expect(first.asked).toEqual(['traxsource']);
		// Skipped (cooling down) on the next track: still deferred, never 'na'.
		const second = await enrichOne(target, [blocked, miss]);
		expect(second.errored).toBe(false);
		expect(second.deferredUntil).toBeGreaterThan(Date.now());
	});
});
