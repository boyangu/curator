// The desktop's side of "Help us connect the dots": searching a store for an
// artist's page, ranking what it finds by what it shares with the catalogue,
// and saying plainly when a store cannot be searched. Made-up names.

import { describe, expect, it } from 'vitest';
import type { CatalogConnectAnswerInput, CatalogConnectQueueInput } from '@curator/protocol';
import { createCatalogConnect, storeSearchUrl, type ConnectDeps, type ConnectSubject } from './connect.js';

const IVO: ConnectSubject = { kind: 'artist', name: 'Ivo Lark', titles: ['Glass Rivers', 'Drift', 'Northern Line'], detail: null };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const nextData = (queries: { queryKey: unknown[]; state: { data: unknown } }[]) =>
	new Response(`<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { dehydratedState: { queries } } } })}</script></html>`, { status: 200 });

function setup(over: Partial<ConnectDeps> = {}) {
	const calls: string[] = [];
	const sent: { queue: CatalogConnectQueueInput[]; answers: CatalogConnectAnswerInput[] } = { queue: [], answers: [] };
	let attached = 0;
	const fetchFn: ConnectDeps['fetch'] = async (url) => {
		const u = new URL(String(url));
		calls.push(`${u.hostname}${u.pathname}`);
		if (u.hostname === 'api.deezer.com' && u.pathname === '/search/artist') return json({ data: [{ id: 222, name: 'Ivo Lark', nb_album: 40, nb_fan: 66_000, picture_medium: 'https://img.example/222.jpg' }, { id: 111, name: 'Ivo Lark (uk)' }, { id: 333, name: 'Ivo Larkin' }] });
		if (u.hostname === 'api.deezer.com' && u.pathname === '/artist/111/albums') return json({ data: [{ title: 'Glass Rivers' }, { title: 'Drift' }, { title: 'B-Sides' }] });
		if (u.hostname === 'api.deezer.com' && u.pathname === '/artist/222/albums') return json({ data: [{ title: 'Schlager Hits' }] });
		if (u.hostname === 'www.beatport.com' && u.pathname === '/search/artists') return nextData([{ queryKey: ['search-artists', {}], state: { data: { data: [{ artist_id: 900, artist_name: 'Ivo Lark', artist_image_uri: 'https://img.example/900.jpg' }, { artist_id: 901, artist_name: 'Lark' }] } } }]);
		if (u.hostname === 'www.beatport.com' && u.pathname === '/artist/artist/900/releases') return nextData([{ queryKey: ['releases-artist_id=900'], state: { data: { results: [{ id: 1, name: 'Northern Line' }] } } }]);
		if (u.hostname === 'bandcamp.com' && u.pathname.endsWith('/autocomplete_elastic')) {
			return json({ auto: { results: [
				{ type: 'b', id: 51, name: 'Ivo Lark', item_url_root: 'https://ivolark.bandcamp.com', img: 'https://img.example/bc51.jpg', location: 'Leeds, UK', is_label: false },
				{ type: 'b', id: 52, name: 'Ivo Lark', item_url_root: 'https://ivolark.example', location: 'Oslo' },
			] } });
		}
		if (u.hostname === 'bandcamp.com' && u.pathname.endsWith('/band_details')) return json({ discography: [{ title: 'Drift' }, { title: 'Glass Rivers' }] });
		return new Response('nope', { status: 404 });
	};
	const connect = createCatalogConnect({
		catalog: {
			connectQueue: async (input) => { sent.queue.push(input); return { items: [], total: 0 }; },
			connectSearch: async (input) => {
				calls.push(`cloud:${input.provider}:${input.kind}:${input.name}`);
				return { searched: true, candidates: [{ provider: 'soundcloud', providerId: '9001', name: 'Ivo Lark', url: 'https://soundcloud.com/ivo-lark', imageUrl: 'https://img.example/sc.jpg', followers: 12_400, detail: 'Leeds', source: 'search' }] };
			},
			connectAnswer: async (input) => { sent.answers.push(input); return { results: input.answers.map((a) => ({ outcome: a.verdict === 'is' ? ('attached' as const) : ('noted' as const) })) }; },
		},
		status: () => ({ available: true, reason: 'ok' }),
		offered: () => true,
		deviceId: () => 'dev-1',
		spotifyToken: async () => null,
		fetch: fetchFn,
		onAttached: () => { attached++; },
		...over,
	});
	return { connect, calls, sent, attached: () => attached };
}

describe('connect the dots: candidates', () => {
	it('offers a store’s namesakes first and leads with the one sharing releases, reading each list once', async () => {
		const { connect, calls } = setup();
		const r = await connect.search(IVO, 'deezer');
		expect(r.note).toBeNull();
		// The tagged namesake shares two titles and leads; the unrelated near-name is listed, not read.
		expect(r.candidates.map((c) => `${c.providerId}:${c.shared?.length ?? 0}`)).toEqual(['111:2', '222:0', '333:0']);
		expect(r.candidates[0]).toMatchObject({ url: 'https://www.deezer.com/artist/111', shared: ['Glass Rivers', 'Drift'], source: 'search' });
		// Each page comes with its picture and its following, where the store says.
		expect(r.candidates[1]).toMatchObject({ providerId: '222', imageUrl: 'https://img.example/222.jpg', followers: 66_000 });
		expect(calls).toEqual(['api.deezer.com/search/artist', 'api.deezer.com/artist/222/albums', 'api.deezer.com/artist/111/albums']);
		await connect.search(IVO, 'deezer');
		expect(calls).toHaveLength(3);
	});

	it('reads Beatport’s search page for artists, with the picture and the page link', async () => {
		const { connect } = setup();
		const r = await connect.search(IVO, 'beatport');
		expect(r.candidates[0]).toMatchObject({ providerId: '900', url: 'https://www.beatport.com/artist/ivo-lark/900', imageUrl: 'https://img.example/900.jpg', shared: ['Northern Line'] });
		expect(r.candidates.map((c) => c.providerId)).toEqual(['900', '901']);
		expect(r.searchUrl).toBe('https://www.beatport.com/search/artists?q=Ivo%20Lark');
	});

	it('searches SoundCloud through the cloud and Bandcamp by its public search, without being asked twice', async () => {
		const { connect, calls } = setup();
		const sc = await connect.search(IVO, 'soundcloud');
		expect(sc.candidates).toMatchObject([{ providerId: '9001', url: 'https://soundcloud.com/ivo-lark', followers: 12_400, imageUrl: 'https://img.example/sc.jpg' }]);
		// The band on its own domain has no link the catalogue can key: left out.
		const bc = await connect.search(IVO, 'bandcamp');
		expect(bc.candidates).toMatchObject([{ providerId: '51', url: 'https://ivolark.bandcamp.com', imageUrl: 'https://img.example/bc51.jpg', detail: 'Leeds, UK', shared: ['Drift', 'Glass Rivers'] }]);
		await connect.search(IVO, 'soundcloud');
		expect(calls.filter((c) => c.startsWith('cloud:'))).toEqual(['cloud:soundcloud:artist:Ivo Lark']);
	});

	it('says why there is nothing to pick: no search, no connection, the store away', async () => {
		const { connect } = setup();
		// A cloud without SoundCloud's credentials cannot search it; an album has no profile search.
		const bare = setup({ catalog: { connectQueue: async () => ({ items: [], total: 0 }), connectAnswer: async () => ({ results: [] }), connectSearch: async () => ({ candidates: [], searched: false }) } });
		expect(await bare.connect.search(IVO, 'soundcloud')).toMatchObject({ candidates: [], note: 'no_search', searchUrl: 'https://soundcloud.com/search/people?q=Ivo%20Lark' });
		expect((await connect.search(IVO, 'spotify')).note).toBe('not_connected');
		expect((await connect.search(IVO, 'tidal')).note).toBe('not_connected');
		expect((await connect.search({ ...IVO, kind: 'label' }, 'deezer')).note).toBe('no_search');
		const challenged = setup({ beatportFetch: async () => new Response('<html><title>Just a moment...</title></html>', { status: 403, headers: { 'cf-mitigated': 'challenge' } }) });
		expect((await challenged.connect.search(IVO, 'beatport')).note).toBe('blocked');
		expect(storeSearchUrl('bandcamp', 'release', 'Glass Rivers')).toBe('https://bandcamp.com/search?q=Glass%20Rivers&item_type=a');
	});
});

describe('connect the dots: the cloud', () => {
	it('is off without the server’s feature, and sends the queue ask and the answers as they are', async () => {
		const off = setup({ offered: () => false });
		expect(off.connect.status()).toEqual({ available: false, reason: 'server_off' });
		await expect(off.connect.queue()).rejects.toThrow(/does not offer/);

		const { connect, sent, attached } = setup();
		await connect.queue({ objectIds: ['o1'] });
		await connect.queue({ limit: 5 });
		expect(sent.queue).toEqual([{ deviceId: 'dev-1', objectIds: ['o1'] }, { deviceId: 'dev-1', limit: 5 }]);
		const r = await connect.answer([{ objectId: 'o1', provider: 'deezer', verdict: 'is', url: 'https://www.deezer.com/artist/111' }, { objectId: 'o1', provider: 'beatport', verdict: 'none' }]);
		expect(r.results.map((x) => x.outcome)).toEqual(['attached', 'noted']);
		// A page landed: whoever cached the artist's pages is told.
		expect(attached()).toBe(1);
	});
});
