// An artist's store pages: the library's links for an artist asked by id,
// the catalogue's handles through a Spotify or catalogue id, never the
// library's namesake for a name. Made-up names.

import { describe, expect, it } from 'vitest';
import type { CatalogHandle } from '@curator/protocol';
import { createArtistPages, type ArtistPagesDeps } from './artist-pages.js';

const handles: CatalogHandle[] = [
	{ provider: 'spotify', id: 'sp-other', url: 'https://open.spotify.com/artist/sp-other' },
	{ provider: 'beatport', id: '560627', url: 'https://www.beatport.com/artist/ivo-lark/560627' },
	{ provider: 'soundcloud', id: '9001', url: 'https://soundcloud.com/ivo-lark' },
	// A reader's name key and a page without a link: nothing to open.
	{ provider: 'beatport', id: 'edbee67a/ivo lark', url: 'https://www.beatport.com/label/x/1' },
	{ provider: 'user', id: 'name:ivo lark', url: null },
];

function setup(over: Partial<ArtistPagesDeps> = {}) {
	const calls: string[] = [];
	const catalog = {
		status: () => ({ available: true, reason: 'ok' as const }),
		resolve: async (refs: { providerId: string }[]) => {
			calls.push(`resolve:${refs[0]!.providerId}`);
			return [{ id: 'obj-1', kind: 'artist' as const, name: 'Ivo Lark', handles, coverUrl: null, watchCount: 0 }];
		},
		browse: async (id: string) => {
			calls.push(`browse:${id}`);
			return { object: { id, kind: 'artist' as const, name: 'Ivo Lark', handles, coverUrl: null, watchCount: 0 }, redirectedFrom: null };
		},
	};
	const pages = createArtistPages({
		artistById: (id) => (id === 'a1' ? { id: 'a1' } : null),
		artistByName: (name) => (name === 'Ivo Lark' ? { id: 'a1' } : null),
		links: () => [
			{ source: 'spotify', sourceId: 'sp-lib', url: 'https://open.spotify.com/artist/sp-lib' },
			{ source: 'tidal', sourceId: '77', url: 'https://tidal.com/browse/artist/77' },
		],
		catalog: () => catalog as never,
		...over,
	});
	return { pages, calls };
}

const bySource = (p: { pages: { source: string; sourceId: string }[] }) => Object.fromEntries(p.pages.map((l) => [l.source, l.sourceId]));

describe('artist pages', () => {
	it('joins a library artist’s own links with the catalogue’s pages, through its Spotify link, and asks once', async () => {
		const { pages, calls } = setup();
		const r = await pages({ name: 'Ivo Lark', artistId: 'a1' });
		expect(r.libraryArtistId).toBe('a1');
		// The library's Spotify link wins over the catalogue's; the name key and the linkless page are left out.
		expect(bySource(r)).toEqual({ spotify: 'sp-lib', tidal: '77', beatport: '560627', soundcloud: '9001' });
		await pages({ name: 'Ivo Lark', artistId: 'a1' });
		expect(calls).toEqual(['resolve:sp-lib']);
	});

	it('names a feed artist by the ids the feed carries, never by the library’s namesake links', async () => {
		const { pages, calls } = setup();
		const bySpotify = await pages({ name: 'Ivo Lark', spotifyId: 'sp-feed' });
		expect(bySpotify.libraryArtistId).toBe('a1');
		expect(bySource(bySpotify)).toEqual({ spotify: 'sp-feed', beatport: '560627', soundcloud: '9001' });
		const byCatalogue = await pages({ name: 'Ivo Lark', catalogId: 'obj-9' });
		expect(bySource(byCatalogue)).toEqual({ spotify: 'sp-other', beatport: '560627', soundcloud: '9001' });
		expect(calls).toEqual(['resolve:sp-feed', 'browse:obj-9']);
		// A name alone: no page, only whether the library holds it.
		expect(await pages({ name: 'Someone Else' })).toEqual({ catalogId: null, libraryArtistId: null, pages: [] });
		// The catalogue's own artist comes back with its pages; forgetting asks again.
		expect(byCatalogue.catalogId).toBe('obj-9');
		expect(bySpotify.catalogId).toBe('obj-1');
		pages.forget();
		await pages({ name: 'Ivo Lark', catalogId: 'obj-9' });
		expect(calls).toEqual(['resolve:sp-feed', 'browse:obj-9', 'browse:obj-9']);
	});

	it('answers with the local links when the catalogue is off, failing, or slow', async () => {
		const local = { spotify: 'sp-lib', tidal: '77' };
		expect(bySource(await setup({ catalog: () => null }).pages({ name: 'Ivo Lark', artistId: 'a1' }))).toEqual(local);
		const failing = { status: () => ({ available: true, reason: 'ok' as const }), resolve: async () => { throw new Error('down'); }, browse: async () => { throw new Error('down'); } };
		expect(bySource(await setup({ catalog: () => failing as never }).pages({ name: 'Ivo Lark', artistId: 'a1' }))).toEqual(local);
		const slow = { status: () => ({ available: true, reason: 'ok' as const }), resolve: () => new Promise<never>(() => {}), browse: () => new Promise<never>(() => {}) };
		expect(bySource(await setup({ catalog: () => slow as never, waitMs: 10 }).pages({ name: 'Ivo Lark', artistId: 'a1' }))).toEqual(local);
	});
});
