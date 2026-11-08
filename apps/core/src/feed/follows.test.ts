// Follows that live in the Global Catalog: unfollow and mute from a Discover
// card act on the watch and never on Spotify; the items a follow brought go
// with it unless another followed artist also credits them.

import { describe, expect, it } from 'vitest';
import { createFeedService, type CatalogFollowsPort, type LibraryPort } from './service.js';
import { SqliteFeedStore } from './store.js';
import type { FeedItemDraft } from './types.js';

function album(id: string, origin: string, credited: string[]): FeedItemDraft {
	return {
		type: 'album',
		source: 'spotify',
		sourceId: id,
		dedupeKey: `spotify:album:${id}`,
		payload: { title: id, artists: credited, artistIds: credited, tracks: [] },
		origin: { kind: 'artist', id: origin, name: origin, catalogId: `cat-${origin}` },
		publishedAt: Date.now(),
		suppressKeys: credited.map((a) => `artist:${a}`),
	};
}

const library = {} as LibraryPort;
// No Spotify token: the old path answers "Spotify not connected", so an ok
// result proves the catalogue path ran.
const auth = { getSpotifyAccessToken: async () => null };

function follows(reachable = true) {
	const calls: string[] = [];
	const watched = new Map([
		['sa1', 'cat-sa1'],
		['sa2', 'cat-sa2'],
	]);
	const port: CatalogFollowsPort = {
		active: () => reachable,
		reachable: () => reachable,
		watchFor: async (_kind, spotifyId) => watched.get(spotifyId) ?? null,
		watchedSpotifyIds: async () => new Set(watched.keys()),
		watchedCatalogIds: async () => new Set(watched.values()),
		deviceTrackedPlaylists: async () => new Set(),
		unwatch: async (id) => {
			calls.push(`unwatch ${id}`);
			for (const [k, v] of watched) if (v === id) watched.delete(k);
		},
		mute: async (id, muted) => void calls.push(`mute ${id} ${muted}`),
	};
	return { port, calls };
}

describe('feed follows in the catalogue', () => {
	it('unfollow removes the watch and its items, keeping one another followed artist credits', async () => {
		const store = new SqliteFeedStore(':memory:');
		await store.upsertItems([album('only-sa1', 'sa1', ['sa1']), album('shared', 'sa1', ['sa1', 'sa2'])]);
		const { port, calls } = follows();
		const svc = createFeedService({ store, auth, library, catalogFollows: port });
		const r = await svc.unfollowArtist('sa1');
		expect(r).toEqual({ ok: true, removed: 1 });
		expect(calls).toEqual(['unwatch cat-sa1']);
		expect((await store.getPage({ limit: 10 })).items.map((i) => i.sourceId)).toEqual(['shared']);
		svc.stop();
	});

	it('mute also mutes the watch', async () => {
		const store = new SqliteFeedStore(':memory:');
		const { port, calls } = follows();
		const svc = createFeedService({ store, auth, library, catalogFollows: port });
		await svc.action({ kind: 'mute', scopes: [{ scope: 'artist', key: 'artist:sa2' }] });
		expect(calls).toEqual(['mute cat-sa2 true']);
		svc.stop();
	});

	it('unfollowing a label removes its items unless another followed label also brought them', async () => {
		const store = new SqliteFeedStore(':memory:');
		const labelled = (id: string, label: string, also: string[] = []): FeedItemDraft => ({
			...album(id, 'x', []),
			dedupeKey: `catalog:release:${id}`,
			origin: { kind: 'label', id: label, name: label, catalogId: label },
			suppressKeys: [`label:${label}`, ...also.map((l) => `label:${l}`)],
		});
		await store.upsertItems([labelled('r1', 'lbl1'), labelled('r2', 'lbl1', ['lbl2'])]);
		const { port, calls } = follows();
		const svc = createFeedService({ store, auth, library, catalogFollows: { ...port, watchedCatalogIds: async () => new Set(['lbl2']) } });
		expect(await svc.unfollowOrigin('label', 'lbl1')).toEqual({ ok: true, removed: 1 });
		expect(calls).toEqual(['unwatch lbl1']);
		expect((await store.getPage({ limit: 10 })).items.map((i) => i.sourceId)).toEqual(['r2']);
		svc.stop();
	});

	it('an artist the catalogue knows without a Spotify id unfollows and mutes by its object', async () => {
		const store = new SqliteFeedStore(':memory:');
		await store.upsertItems([album('bc1', 'catalog:cat-bc', ['catalog:cat-bc'])]);
		const { port, calls } = follows();
		const svc = createFeedService({ store, auth, library, catalogFollows: port });
		await svc.action({ kind: 'mute', scopes: [{ scope: 'artist', key: 'artist:catalog:cat-bc' }, { scope: 'label', key: 'label:lbl9' }] });
		expect(await svc.unfollowArtist('catalog:cat-bc')).toEqual({ ok: true, removed: 1 });
		expect(calls).toEqual(['mute cat-bc true', 'mute lbl9 true', 'unwatch cat-bc']);
		svc.stop();
	});

	it('without the catalogue, unfollow is the Spotify one', async () => {
		const store = new SqliteFeedStore(':memory:');
		const { port, calls } = follows(false);
		const svc = createFeedService({ store, auth, library, catalogFollows: port, remoteWriteGate: () => {} });
		expect(await svc.unfollowArtist('sa1')).toEqual({ ok: false, error: 'Spotify not connected' });
		expect(calls).toEqual([]);
		svc.stop();
	});
});
