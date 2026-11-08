// The feed service with catalogue items: promotion needs a Spotify track, and
// a catalogue album's detail comes from its card with no provider call.

import { describe, expect, it } from 'vitest';
import { createFeedService, type LibraryPort } from './service.js';
import { SqliteFeedStore } from './store.js';
import type { FeedItemDraft } from './types.js';

let tokenAsked = 0;
const auth = { getSpotifyAccessToken: async () => { tokenAsked++; return 'tok'; } };
const empty = { bySpotify: {}, byIsrc: {}, tierBySpotify: {}, tierByIsrc: {}, pinnedBySpotify: new Set<string>(), pinnedByIsrc: new Set<string>() };
const library = {
	libraryTrackIds: async () => empty,
	deletedKeys: async () => ({ spotify: new Set<string>(), isrc: new Set<string>() }),
} as unknown as LibraryPort;

const offSpotify = (type: 'track' | 'album'): FeedItemDraft => ({
	type,
	source: 'catalog',
	sourceId: 'rel-1',
	dedupeKey: `catalog:${type === 'album' ? 'release' : 'recording'}:rel-1`,
	payload: {
		title: 'Glass Rivers',
		artists: ['Northfold'],
		catalogId: 'rel-1',
		handles: [{ provider: 'bandcamp', id: '9', url: 'https://northfold.bandcamp.com/album/glass-rivers' }],
		...(type === 'album' ? { tracks: [{ sourceTrackId: 'rec-1', catalogId: 'rec-1', title: 'Glass Rivers', artists: ['Northfold'], durationSec: 300, handles: [] }] } : {}),
	},
	origin: null,
	publishedAt: null,
	suppressKeys: [],
});

describe('feed service with catalogue items', () => {
	it('promotion of an item not on Spotify yet is refused with the reason', async () => {
		const store = new SqliteFeedStore(':memory:');
		const t = offSpotify('track');
		await store.upsertItems([{ ...t, payload: { ...t.payload, title: 'Low Tide' } }, offSpotify('album')]);
		const svc = createFeedService({ store, auth, library });
		const [album, track] = (await store.getPage()).items.sort((a) => (a.type === 'album' ? -1 : 1));
		const err = { ok: false, error: 'Not on Spotify yet — promotion needs a Spotify track' };
		expect(await svc.action({ kind: 'interested', itemId: track!.id })).toEqual(err);
		expect(await svc.action({ kind: 'interested', itemId: album!.id, sourceTrackId: 'rec-1' })).toEqual(err);
		svc.stop();
	});

	it("a catalogue album's detail is its card: no Spotify call for its tracklist", async () => {
		const store = new SqliteFeedStore(':memory:');
		const d = offSpotify('album');
		await store.upsertItems([{ ...d, source: 'spotify', sourceId: 'al1', payload: { ...d.payload, handles: [{ provider: 'spotify', id: 'al1', url: null }] } }]);
		const svc = createFeedService({ store, auth, library });
		tokenAsked = 0;
		const item = (await store.getPage()).items[0]!;
		const detail = await svc.getItemDetail(item.id);
		expect(detail?.item.payload.tracks).toHaveLength(1);
		expect(detail?.tracksError).toBeUndefined();
		expect(tokenAsked).toBe(0);
		svc.stop();
	});

	it('a catalogue release without a tracklist says so, with no Spotify call', async () => {
		const store = new SqliteFeedStore(':memory:');
		const d = offSpotify('album');
		await store.upsertItems([{ ...d, payload: { ...d.payload, tracks: [] } }]);
		const svc = createFeedService({ store, auth, library });
		tokenAsked = 0;
		const detail = await svc.getItemDetail((await store.getPage()).items[0]!.id);
		expect(detail?.tracksError).toBe('The catalogue has no tracklist for this release yet.');
		expect(tokenAsked).toBe(0);
		svc.stop();
	});
});
