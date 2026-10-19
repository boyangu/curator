import { describe, it, expect, vi } from 'vitest';
import { FeedEnrichmentQueue } from './enrichment.js';
import type { EnrichStatus, FeedItem, FeedItemPayload } from './types.js';
import type { FeedStore } from './store.js';
import type { DjMetadataPatch, Enricher, EnricherOutput, EnrichmentTarget } from '../enrich/contract.js';

// A complete Beatport-style patch — all core fields, so a single enricher
// short-circuits the chain exactly as the real one does.
const FULL: DjMetadataPatch = { bpm: 120, keyCamelot: '8A', genre: 'House', label: 'L' };

// Enricher driven by a function of the query title, so one album can mix
// outcomes per track: return a patch (hit), null (clean miss), or the sentinel
// 'throw' (a simulated WAF/network failure — what makes enrichOne report
// errored).
function enricher(id: string, fn: (title: string) => DjMetadataPatch | null | 'throw'): Enricher {
	return {
		id,
		produces: 'metadata',
		applicableTo: (t: EnrichmentTarget) => !!t.query.title && !!t.query.artists?.[0],
		async enrich(t: EnrichmentTarget): Promise<EnricherOutput | null> {
			const out = fn(t.query.title);
			if (out === 'throw') throw new Error('WAF 403');
			return out ? { kind: 'metadata', patch: out, sourceLink: { source: id, sourceTrackId: id } } : null;
		},
	};
}

// In-memory FeedStore double — only the methods the queue touches, mirroring
// the real listUnenriched gate (NULL/err eligible; ok/na terminal). getItem
// returns the live object, so the queue's in-place ref mutations persist.
class FakeStore {
	readonly items = new Map<string, FeedItem>();
	add(...items: FeedItem[]): void { for (const i of items) this.items.set(i.id, i); }
	async getItem(id: string): Promise<FeedItem | null> { return this.items.get(id) ?? null; }
	async listUnenriched(limit: number): Promise<FeedItem[]> {
		return [...this.items.values()].filter((i) =>
			(i.enrichStatus == null || i.enrichStatus === 'err')
			&& ['fresh', 'seen', 'expanded'].includes(i.state)
			&& (i.type === 'track' || (i.type === 'album' && (i.payload.tracks?.length ?? 0) > 0)),
		).slice(0, limit);
	}
	async markEnriched(id: string, status: EnrichStatus, payload?: FeedItemPayload): Promise<void> {
		const it = this.items.get(id);
		if (!it) return;
		it.enrichStatus = status;
		it.enrichedAt = 1;
		if (payload) it.payload = payload;
	}
	async setPayload(id: string, payload: FeedItemPayload): Promise<void> {
		const it = this.items.get(id);
		if (it) it.payload = payload;
	}
}

function trackItem(id: string, title: string, extra?: Partial<FeedItem>): FeedItem {
	return {
		id, type: 'track', source: 'spotify', sourceId: id,
		payload: { title, artists: ['A'] },
		origin: null, publishedAt: null, fetchedAt: 0, score: 0,
		state: 'fresh', playedAt: null, archivedAt: null, enrichedAt: null, enrichStatus: null,
		promotedTrackId: null, ...extra,
	};
}

function albumItem(id: string, refs: { sourceTrackId: string; title: string }[]): FeedItem {
	return {
		id, type: 'album', source: 'spotify', sourceId: id,
		payload: { title: id, artists: ['A'], tracks: refs.map((r) => ({ ...r, artists: ['A'], durationSec: 100 })) },
		origin: null, publishedAt: null, fetchedAt: 0, score: 0,
		state: 'fresh', playedAt: null, archivedAt: null, enrichedAt: null, enrichStatus: null,
		promotedTrackId: null,
	};
}

// pacingMs 0 — no 1.5s WAF delay between lookups in tests.
function queue(store: FakeStore, enr: Enricher): FeedEnrichmentQueue {
	return new FeedEnrichmentQueue(store as unknown as FeedStore, [enr], 0);
}

describe('FeedEnrichmentQueue — outcome status (ok / na / err)', () => {
	it('track hit → ok, payload filled, terminal (not re-listed)', async () => {
		const store = new FakeStore();
		store.add(trackItem('t1', 'hit'));
		const out = await queue(store, enricher('bp', () => FULL)).enrichItem('t1');
		expect(out?.enrichStatus).toBe('ok');
		expect(out?.payload.bpm).toBe(120);
		expect(await store.listUnenriched(10)).toEqual([]);
	});

	it('track clean miss → na, terminal (no metadata, not re-listed)', async () => {
		const store = new FakeStore();
		store.add(trackItem('t1', 'x'));
		const out = await queue(store, enricher('bp', () => null)).enrichItem('t1');
		expect(out?.enrichStatus).toBe('na');
		expect(out?.payload.bpm).toBeUndefined();
		expect(await store.listUnenriched(10)).toEqual([]);
	});

	it('track lookup error → err, stays retryable, and succeeds on the retry', async () => {
		const store = new FakeStore();
		store.add(trackItem('t1', 'x'));
		let mode: 'throw' | 'hit' = 'throw';
		const q = queue(store, enricher('bp', () => (mode === 'throw' ? 'throw' : FULL)));

		let out = await q.enrichItem('t1');
		expect(out?.enrichStatus).toBe('err');
		// Unlike a clean miss, an error leaves the row on the worklist.
		expect((await store.listUnenriched(10)).map((i) => i.id)).toEqual(['t1']);

		// Re-attempt (enrichItem re-runs 'err', unlike terminal ok/na) → now hits.
		mode = 'hit';
		out = await q.enrichItem('t1');
		expect(out?.enrichStatus).toBe('ok');
		expect(out?.payload.bpm).toBe(120);
		expect(await store.listUnenriched(10)).toEqual([]);
	});

	it('album stamps each ref and aggregates to err while any ref still needs work', async () => {
		const store = new FakeStore();
		store.add(albumItem('al', [
			{ sourceTrackId: 'a', title: 'hit one' },
			{ sourceTrackId: 'b', title: 'miss two' },
			{ sourceTrackId: 'c', title: 'err three' },
		]));
		let failErr = true;
		const q = queue(store, enricher('bp', (title) =>
			title.startsWith('hit') ? FULL : title.startsWith('err') ? (failErr ? 'throw' : FULL) : null,
		));

		const out = await q.enrichItem('al');
		const ref = (id: string) => out!.payload.tracks!.find((r) => r.sourceTrackId === id)!;
		expect(ref('a').enrichStatus).toBe('ok');
		expect(ref('a').bpm).toBe(120);
		expect(ref('b').enrichStatus).toBe('na');
		expect(ref('c').enrichStatus).toBe('err');
		// One ref errored → album is retryable, not stamped done.
		expect(out?.enrichStatus).toBe('err');
		expect((await store.listUnenriched(10)).map((i) => i.id)).toEqual(['al']);

		// Retry: only the err ref is re-attempted (ok/na refs are skipped), and
		// the album settles to ok.
		failErr = false;
		const out2 = await q.enrichItem('al');
		const ref2 = (id: string) => out2!.payload.tracks!.find((r) => r.sourceTrackId === id)!;
		expect(ref2('c').enrichStatus).toBe('ok');
		expect(ref2('c').bpm).toBe(120);
		expect(out2?.enrichStatus).toBe('ok');
		expect(await store.listUnenriched(10)).toEqual([]);
	});

	it('album rollup — marks the album payload with the modal genre/label from its tracks', async () => {
		const store = new FakeStore();
		store.add(albumItem('al', [
			{ sourceTrackId: 'a', title: 'hit one' },
			{ sourceTrackId: 'b', title: 'hit two' },
		]));
		// Both tracks hit with the same genre/label — the album should adopt them.
		const out = await queue(store, enricher('bp', () => FULL)).enrichItem('al');
		expect(out?.enrichStatus).toBe('ok');
		// Per-track values still assigned to each ref.
		expect(out?.payload.tracks?.every((t) => t.genre === 'House' && t.label === 'L')).toBe(true);
		// AND the album itself is marked, so the card chip + feed genre/label
		// filter have a value to match on.
		expect(out?.payload.genre).toBe('House');
		expect(out?.payload.label).toBe('L');
	});

	it('album rollup fires the enriched callback with the marked album', async () => {
		const store = new FakeStore();
		store.add(albumItem('al', [{ sourceTrackId: 'a', title: 'hit one' }]));
		const seen: string[] = [];
		const q = new FeedEnrichmentQueue(store as unknown as FeedStore, [enricher('bp', () => FULL)], 0,
			(item) => { if (item.payload.genre) seen.push(item.payload.genre); });
		await q.enrichItem('al');
		expect(seen).toContain('House');
	});

	it('carries the matched source_links onto the payload (track) and refs (album)', async () => {
		const store = new FakeStore();
		store.add(trackItem('t1', 'hit'));
		store.add(albumItem('al', [
			{ sourceTrackId: 'a', title: 'hit one' },
			{ sourceTrackId: 'b', title: 'miss two' },
		]));
		const q = queue(store, enricher('bp', (title) => (title.startsWith('hit') ? FULL : null)));

		// The catalog identity the enricher matched rides on the payload, so
		// promotion persists a source_link identical to a direct library enrich.
		const t = await q.enrichItem('t1');
		expect(t?.payload.sourceLinks).toEqual([{ source: 'bp', sourceTrackId: 'bp' }]);

		const al = await q.enrichItem('al');
		const ref = (id: string) => al!.payload.tracks!.find((r) => r.sourceTrackId === id)!;
		expect(ref('a').sourceLinks).toEqual([{ source: 'bp', sourceTrackId: 'bp' }]);
		// A clean miss carries no source link.
		expect(ref('b').sourceLinks).toBeUndefined();
	});

	it('enrichItem is idempotent for terminal items — no enricher calls', async () => {
		const store = new FakeStore();
		store.add(trackItem('done', 'x', { enrichStatus: 'na' }));
		store.add(trackItem('hit', 'x', { enrichStatus: 'ok', payload: { title: 'x', artists: ['A'], bpm: 100 } }));
		let calls = 0;
		const q = queue(store, enricher('bp', () => { calls++; return FULL; }));

		expect((await q.enrichItem('done'))?.enrichStatus).toBe('na');
		expect((await q.enrichItem('hit'))?.enrichStatus).toBe('ok');
		expect(calls).toBe(0);
	});

	it('the background drain converges, classifying every visible item', async () => {
		const store = new FakeStore();
		store.add(
			trackItem('t1', 'hit a'),
			trackItem('t2', 'miss b'),
			albumItem('al', [{ sourceTrackId: 'x', title: 'hit c' }]),
		);
		const q = queue(store, enricher('bp', (title) => (title.startsWith('hit') ? FULL : null)));

		q.kick();
		await vi.waitFor(async () => { expect(await store.listUnenriched(10)).toEqual([]); });

		expect(store.items.get('t1')!.enrichStatus).toBe('ok');
		expect(store.items.get('t2')!.enrichStatus).toBe('na');
		const al = store.items.get('al')!;
		expect(al.enrichStatus).toBe('ok');
		expect(al.payload.tracks?.[0]?.enrichStatus).toBe('ok');
	});
});
