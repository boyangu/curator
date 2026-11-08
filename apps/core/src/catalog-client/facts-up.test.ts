// Findings up: which store matches become claims, what they carry, and the
// sweep that sends each once.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogClaim } from '@curator/protocol';
import type { FeedItem } from '../feed/types.js';
import { claimsFor, createFactsUp, factsKey } from './facts-up.js';

afterEach(() => {
	vi.useRealTimers();
});

const base = { id: 'i', source: 'spotify', sourceId: 's', dedupeKey: 'd', state: 'fresh', fetchedAt: 0, publishedAt: 0, orderTs: 0, enrichedAt: 1, enrichStatus: 'ok', origin: { kind: 'artist', id: 'a', name: 'A' } } as unknown as FeedItem;

const track = (over: Partial<FeedItem['payload']> = {}): FeedItem => ({
	...base,
	type: 'track',
	payload: {
		title: 'Glass Rivers',
		artists: ['Northfold'],
		artistIds: [],
		durationSec: 400,
		isrc: 'GBAAA2600001',
		bpm: 124,
		keyCamelot: '8A',
		genre: 'Melodic House & Techno',
		label: 'Northfold Records',
		sourceLinks: [{ source: 'beatport', sourceTrackId: 'bp1', url: 'https://www.beatport.com/track/x/bp1', key: 'A Minor', bpm: 124, duration: 401 }],
		...over,
	} as FeedItem['payload'],
});

describe('claimsFor', () => {
	it('turns a Beatport match with an ISRC into a fill-only recording claim with the raw key and the genre', () => {
		const [c] = claimsFor(track());
		expect(c!.key).toBe('beatport:bp1');
		expect(c!.claim).toEqual({
			provider: 'beatport',
			kind: 'recording',
			providerId: 'bp1',
			name: 'Glass Rivers',
			url: 'https://www.beatport.com/track/x/bp1',
			identifiers: [{ namespace: 'isrc', value: 'GBAAA2600001' }],
			artists: [{ provider: 'user', kind: 'artist', providerId: 'name:northfold', name: 'Northfold' }],
			facts: { bpm: 124, key: 'A Minor', durationSec: 401, labelText: 'Northfold Records' },
			genres: ['Melodic House & Techno'],
		} satisfies CatalogClaim);
	});

	it('skips a match the catalogue could not place: no ISRC and no catalogue recording, or no store link', () => {
		expect(claimsFor(track({ isrc: null }))).toEqual([]);
		expect(claimsFor(track({ isrc: null, catalogId: 'rec-1' }))).toHaveLength(1);
		expect(claimsFor(track({ sourceLinks: [] }))).toEqual([]);
		expect(claimsFor(track({ sourceLinks: [{ source: 'spotify', sourceTrackId: 'sp1' }] }))).toEqual([]);
	});

	it('sends the Spotify handles the lazy match found: the release by UPC or by name and date, each paired track by ISRC', () => {
		const matched: FeedItem = {
			...base,
			type: 'album',
			source: 'spotify',
			sourceId: 'al1',
			matchStatus: 'ok',
			payload: {
				title: 'EP',
				artists: ['Northfold'],
				artistIds: [],
				catalogId: 'rel-1',
				upc: '0123456789012',
				releaseDate: '2026-11-06',
				albumType: 'single',
				url: 'https://open.spotify.com/album/al1',
				tracks: [
					{ sourceTrackId: 's1', catalogId: 'rec-1', title: 'One', artists: ['Northfold'], durationSec: 300, isrc: 'GBAAA2600001', handles: [{ provider: 'spotify', id: 's1', url: null }] },
					{ sourceTrackId: 'rec-2', catalogId: 'rec-2', title: 'Two', artists: ['Northfold'], durationSec: 300, isrc: null },
				],
			} as FeedItem['payload'],
		};
		const claims = claimsFor(matched);
		expect(claims.map((c) => c.key)).toEqual(['spotify:album:al1', 'spotify:track:s1']);
		expect(claims[0]!.claim).toMatchObject({ provider: 'spotify', kind: 'release', providerId: 'al1', identifiers: [{ namespace: 'upc', value: '0123456789012' }], facts: { releaseDate: '2026-11-06', releaseType: 'single' } });
		expect(claims[1]!.claim).toMatchObject({ provider: 'spotify', kind: 'recording', providerId: 's1', identifiers: [{ namespace: 'isrc', value: 'GBAAA2600001' }], facts: { durationSec: 300 } });
		// A card the cloud already sent with its Spotify id, or one the match
		// did not place, sends nothing of the kind.
		expect(claimsFor({ ...matched, matchStatus: null })).toEqual([]);
		expect(claimsFor({ ...matched, source: 'catalog' })).toEqual([]);
	});

	it('reads an album’s tracks one by one', () => {
		const album: FeedItem = {
			...base,
			type: 'album',
			payload: {
				title: 'EP',
				artists: ['Northfold'],
				artistIds: [],
				tracks: [
					{ sourceTrackId: 't1', title: 'One', artists: ['Northfold'], durationSec: 300, isrc: 'GBAAA2600001', bpm: 120, sourceLinks: [{ source: 'traxsource', sourceTrackId: 'tx1' }] },
					{ sourceTrackId: 't2', title: 'Two', artists: ['Northfold'], durationSec: 300, isrc: null },
				],
			} as FeedItem['payload'],
		};
		expect(claimsFor(album).map((c) => c.key)).toEqual(['traxsource:tx1']);
	});
});

describe('createFactsUp', () => {
	it('sweeps the month’s enriched items, sends each store match once in batches, and marks them sent', async () => {
		vi.useFakeTimers();
		const items = [track(), { ...track({ sourceLinks: [{ source: 'beatport', sourceTrackId: 'bp2' }] }), id: 'j' }];
		const sent = new Set<string>(['beatport:bp2']);
		const batches: { claims: CatalogClaim[]; key: string }[] = [];
		let listeners: ((item: FeedItem) => void)[] = [];
		const up = createFactsUp({
			store: {
				listEnrichedSince: async () => items,
				unsentFactKeys: async (keys) => new Set(keys.filter((k) => !sent.has(k))),
				markFactsSent: async (keys) => { for (const k of keys) sent.add(k); },
			},
			ingest: () => async (claims, key) => {
				batches.push({ claims, key });
				return { results: claims.map((c) => (c.providerId === 'bp1' ? { objectId: 'rec' } : { rejected: 'unknown' })) };
			},
			subscribe: (cb) => { listeners.push(cb); return () => { listeners = listeners.filter((l) => l !== cb); }; },
			debounceMs: 100,
		});
		up.start();
		await vi.advanceTimersByTimeAsync(100);
		expect(batches).toHaveLength(1);
		expect(batches[0]!.claims.map((c) => factsKey({ source: c.provider, sourceTrackId: c.providerId }))).toEqual(['beatport:bp1']);
		expect(batches[0]!.key).toMatch(/^enrich-facts:[0-9a-f]{32}$/);
		expect(sent.has('beatport:bp1')).toBe(true);

		// An enrichment landing schedules another sweep; nothing new to send.
		listeners[0]!(track());
		await vi.advanceTimersByTimeAsync(100);
		expect(batches).toHaveLength(1);
		expect(await up.flush()).toEqual({ sent: 0, attached: 0, unknown: 0 });
		up.stop();
		expect(listeners).toEqual([]);
	});

	it('sends nothing while signed out, and the matches wait for a later sweep', async () => {
		const up = createFactsUp({
			store: { listEnrichedSince: async () => [track()], unsentFactKeys: async (keys) => new Set(keys), markFactsSent: async () => { throw new Error('must not mark'); } },
			ingest: () => null,
			subscribe: () => () => {},
		});
		expect(await up.flush()).toEqual({ sent: 0, attached: 0, unknown: 0 });
	});
});
