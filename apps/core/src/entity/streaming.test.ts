// The streaming service read as a catalogue (streaming.ts): Spotify's answers
// stand in as a fetch — nothing here reaches the network.

import { describe, expect, it } from 'vitest';
import type { CatalogClaim } from '@curator/protocol';
import { createSpotifyStreaming, parseStreamObjectId, provisionalRelease, streamObjectId } from '@curator/catalog-work';
import { normalizeEntityRef } from './service.js';

type Answer = { status?: number; body?: unknown };

// A URL fragment → what Spotify answers; the first fragment the URL holds wins.
function spotify(answers: [string, Answer | ((url: string) => Answer)][]) {
	const asked: string[] = [];
	const fetchFn = async (url: string): Promise<Response> => {
		asked.push(url.replace('https://api.spotify.com/v1', ''));
		const hit = answers.find(([k]) => url.includes(k));
		const a = hit ? (typeof hit[1] === 'function' ? hit[1](url) : hit[1]) : { status: 404 };
		const status = a.status ?? 200;
		return { status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => a.body } as Response;
	};
	return { asked, stream: createSpotifyStreaming({ token: async () => 'token', fetch: fetchFn }) };
}

const albumRef = (id: string, date: string, name = `Release ${id}`) => ({ id, name, album_type: 'single', release_date: date, total_tracks: 2, images: [{ url: `https://img.test/${id}.jpg` }], artists: [{ id: 'spA', name: 'Northfold' }] });
const albumFull = (id: string, date: string) => ({
	...albumRef(id, date),
	label: 'Glasshouse',
	external_ids: { upc: `upc-${id}` },
	tracks: { items: [{ id: `${id}-t1`, name: 'One', duration_ms: 300_000, track_number: 1, artists: [{ id: 'spA', name: 'Northfold' }] }, { id: `${id}-t2`, name: 'Two', duration_ms: 200_000, track_number: 2 }] },
});

describe('spotify as a streaming catalogue', () => {
	it('lists an artist newest first, across pages, and reads the artist once', async () => {
		const { stream, asked } = spotify([
			['/artists/spA/albums', (url) => (url.includes('offset=0') ? { body: { items: [albumRef('a', '2020-01-01'), albumRef('b', '2026-05-01')], total: 3, next: 'more' } } : { body: { items: [albumRef('c', '2023-03-03'), albumRef('a', '2020-01-01')], total: 3, next: null } })],
			['/artists/spA', { body: { id: 'spA', name: 'Northfold', images: [{ url: 'https://img.test/n.jpg' }], genres: ['melodic house'] } }],
		]);
		const listing = await stream.listing('spA');
		expect(listing.total).toBe(3);
		expect(listing.releases.map((c) => c.providerId)).toEqual(['b', 'c', 'a']);
		expect(listing.releases[0]).toMatchObject({ provider: 'spotify', kind: 'release', name: 'Release b', facts: { releaseDate: '2026-05-01', coverUrl: 'https://img.test/b.jpg' }, artists: [{ providerId: 'spA', name: 'Northfold' }] });
		expect(await stream.artist('spA')).toEqual({ id: 'spA', name: 'Northfold', imageUrl: 'https://img.test/n.jpg', genres: ['melodic house'], url: 'https://open.spotify.com/artist/spA' });
		// Asked again: answered from what is held.
		await stream.listing('spA');
		await stream.artist('spA');
		expect(asked.filter((u) => u.includes('/albums?')).length).toBe(2);
		expect(asked.filter((u) => u === '/artists/spA').length).toBe(1);
		expect(await stream.artist('gone')).toBeNull();
	});

	it('falls back to pages of twenty where fifty is refused', async () => {
		const { stream, asked } = spotify([['/artists/spA/albums', (url) => (url.includes('limit=50') ? { status: 400 } : { body: { items: [albumRef('a', '2024-01-01')], total: 1, next: null } })]]);
		expect((await stream.listing('spA')).releases).toHaveLength(1);
		expect(asked.map((u) => /limit=(\d+)/.exec(u)![1])).toEqual(['50', '20']);
	});

	it('reads releases in full, each id once however many ask', async () => {
		const { stream, asked } = spotify([['/albums?ids=', (url) => ({ body: { albums: decodeURIComponent(url.split('ids=')[1]!).split(',').map((id) => (id === 'gone' ? null : albumFull(id, '2026-01-01'))) } })]]);
		const [first, second] = await Promise.all([stream.releases(['a', 'b', 'gone']), stream.releases(['b', 'c'])]);
		expect([...first.keys()]).toEqual(['a', 'b']);
		expect([...second.keys()]).toEqual(['b', 'c']);
		expect(first.get('a')).toMatchObject({ facts: { labelText: 'Glasshouse' }, identifiers: [{ namespace: 'upc', value: 'upc-a' }], recordings: [{ providerId: 'a-t1', name: 'One' }, { providerId: 'a-t2' }] });
		await stream.releases(['a', 'c']);
		expect(asked).toEqual(['/albums?ids=a,b,gone', '/albums?ids=c']);
	});

	it('searches artists, albums and tracks in one call, a track with the release it is on', async () => {
		const { stream, asked } = spotify([
			['/search', {
				body: {
					artists: { items: [{ id: 'spA', name: 'Northfold', genres: ['melodic house', 'organic house', 'downtempo'] }, { id: 'spB', name: 'Northfold', followers: { total: 1200 } }, null] },
					albums: { items: [{ ...albumRef('al1', '2026-02-02', 'Glass Rivers') }] },
					tracks: { items: [{ id: 't9', name: 'Elsewhere', duration_ms: 240_000, track_number: 3, artists: [{ id: 'spA', name: 'Northfold' }], external_ids: { isrc: 'QM0000000009' }, album: albumRef('al1', '2026-02-02', 'Glass Rivers') }] },
				},
			}],
		]);
		const hits = await stream.search('  Northfold ');
		expect(hits.map((h) => [h.kind, h.id, h.detail])).toEqual([['artist', 'spA', 'melodic house, organic house'], ['artist', 'spB', '1,200 followers'], ['album', 'al1', null], ['track', 't9', null]]);
		expect(hits[3]).toMatchObject({ album: { id: 'al1', name: 'Glass Rivers' }, release: { providerId: 'al1', recordings: [{ providerId: 't9', identifiers: [{ namespace: 'isrc', value: 'QM0000000009' }] }] } });
		await stream.search('northfold');
		expect(asked).toEqual(['/search?type=artist,album,track&q=Northfold&limit=10']);
	});
});

describe('a streaming release in the page shape', () => {
	const claim: CatalogClaim = {
		provider: 'spotify', kind: 'release', providerId: 'al1', name: 'Glass Rivers', url: 'https://open.spotify.com/album/al1',
		facts: { releaseDate: '2026-02-02', releaseType: 'album', coverUrl: 'https://img.test/c.jpg', labelText: 'Glasshouse', trackCount: 2 },
		artists: [{ provider: 'spotify', kind: 'artist', providerId: 'spA', name: 'Northfold' }],
		recordings: [
			{ provider: 'spotify', kind: 'recording', providerId: 't1', name: 'One', url: null, identifiers: [{ namespace: 'isrc', value: 'QM1' }], facts: { durationSec: 300, trackNumber: 1, discNumber: 1 } },
			{ provider: 'spotify', kind: 'recording', providerId: 't2', name: 'Two', facts: { durationSec: 200, trackNumber: 1, discNumber: 2 }, artists: [{ provider: 'spotify', kind: 'artist', providerId: 'spB', name: 'Guest' }] },
		],
	};

	it("stands under the service's own ids, with its store page as the handle a row plays from", () => {
		const r = provisionalRelease(claim);
		expect(r).toMatchObject({ id: 'spotify_al1', title: 'Glass Rivers', date: '2026-02-02', type: 'album', labelText: 'Glasshouse', labels: [], trackCount: 2, appearance: false, artists: [{ id: 'spotify_spA', name: 'Northfold' }], handles: [{ provider: 'spotify', id: 'al1' }] });
		expect(r.tracks.map((t) => [t.id, t.position, t.disc, t.isrc, t.handles[0]!.id, t.artists.map((a) => a.id)])).toEqual([
			['spotify_t1', 1, 1, 'QM1', 't1', []],
			['spotify_t2', 1, 2, null, 't2', ['spotify_spB']],
		]);
		// A listing's bare release: its place and its count, no rows.
		const bare = provisionalRelease({ ...claim, recordings: [] });
		expect([bare.trackCount, bare.tracks]).toEqual([2, []]);
		// One disc: the disc number says nothing.
		expect(provisionalRelease({ ...claim, recordings: claim.recordings!.slice(0, 1) }).tracks[0]!.disc).toBeNull();
	});

	it('reads a ref built off such a row as the service id it is', () => {
		expect(parseStreamObjectId(streamObjectId('spotify', 'abc'))).toEqual({ service: 'spotify', id: 'abc' });
		expect(parseStreamObjectId('0b1c2d3e-aaaa-bbbb-cccc-000000000000')).toBeNull();
		expect(normalizeEntityRef({ kind: 'artist', name: 'Northfold', catalogId: 'spotify_spA' })).toEqual({ kind: 'artist', name: 'Northfold', catalogId: null, spotifyId: 'spA' });
		const real = { kind: 'artist' as const, name: 'Northfold', catalogId: '0b1c2d3e-aaaa-bbbb-cccc-000000000000' };
		expect(normalizeEntityRef(real)).toBe(real);
	});
});
