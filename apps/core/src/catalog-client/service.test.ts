import type { CatalogClaim, CatalogObjectSummary, CatalogWatch, CloudService } from '@curator/protocol';
import { describe, expect, it, vi } from 'vitest';
import { CatalogInputError, CatalogUnavailableError, createCatalogClient, parseProviderLink } from './service.js';

function watchOf(name: string, id = `obj-${name}`): CatalogWatch {
	return { object: { id, kind: 'artist', name, handles: [], coverUrl: null, watchCount: 1 }, source: 'manual', muted: false, createdAt: 0, tracking: [] };
}

function fakeCatalog(over: Partial<CloudService['catalog']> = {}) {
	const calls: { method: string; input: unknown }[] = [];
	const rec =
		<T,>(method: string, answer: (input: never) => T) =>
		async (input: unknown) => {
			calls.push({ method, input });
			return answer(input as never);
		};
	const catalog = {
		ingest: rec('ingest', () => ({ results: [], created: 0, attached: 0, duplicate: false })),
		resolve: rec('resolve', () => ({ objects: [] })),
		search: rec('search', () => ({ objects: [] as CatalogObjectSummary[] })),
		get: rec('get', () => {
			throw new Error('unused');
		}),
		watch: rec('watch', (input: { claim?: CatalogClaim; objectId?: string }) => ({ watch: watchOf(input.claim?.name ?? 'X', input.objectId), recent: [] })),
		unwatch: rec('unwatch', () => ({ ok: true as const })),
		mute: rec('mute', () => ({ ok: true as const })),
		listWatches: rec('listWatches', () => [] as CatalogWatch[]),
		import: rec('import', (input: { claims: unknown[] }) => ({ created: input.claims.length, existing: 0, watched: input.claims.length, rejected: 0, duplicate: false })),
		refreshNow: rec('refreshNow', () => ({ dueAt: 1 })),
		...over,
	} as CloudService['catalog'];
	return { catalog, calls };
}

function jsonFetch(routes: Record<string, unknown>) {
	return vi.fn(async (url: string) => {
		const key = Object.keys(routes).find((k) => url.includes(k));
		return key ? new Response(JSON.stringify(routes[key]), { status: 200 }) : new Response('{}', { status: 404 });
	}) as unknown as typeof fetch;
}

const base = { signedIn: () => true, serverOffers: () => true, deviceId: () => 'dev-1', spotifyToken: async () => null };

describe('parseProviderLink', () => {
	it('reads Spotify and Deezer artist links and Spotify URIs', () => {
		expect(parseProviderLink('https://open.spotify.com/intl-de/artist/4tZwfgrHOc3mvqYlEYSvVi?si=abc')).toMatchObject({ provider: 'spotify', kind: 'artist', id: '4tZwfgrHOc3mvqYlEYSvVi' });
		expect(parseProviderLink('spotify:artist:4tZwfgrHOc3mvqYlEYSvVi')).toMatchObject({ provider: 'spotify', kind: 'artist' });
		expect(parseProviderLink('https://www.deezer.com/en/artist/27')).toMatchObject({ provider: 'deezer', kind: 'artist', id: '27' });
		// A label's Beatport or Bandcamp page: followed as a label, named off the slug until the catalogue profiles it.
		expect(parseProviderLink('https://www.beatport.com/label/northfold-records/804')).toEqual({ provider: 'beatport', kind: 'label', id: '804', url: 'https://www.beatport.com/label/northfold-records/804', slug: 'northfold-records' });
		expect(parseProviderLink('https://northfold.bandcamp.com/music')).toMatchObject({ provider: 'bandcamp', kind: 'label', id: 'northfold' });
		expect(parseProviderLink('https://www.beatport.com/track/stay/1')).toBeNull();
		expect(parseProviderLink('Northfold')).toBeNull();
	});
});

describe('catalog client', () => {
	it('names a pasted Spotify artist through oEmbed, without a Spotify connection', async () => {
		const { catalog, calls } = fakeCatalog();
		const c = createCatalogClient({ ...base, catalog, fetch: jsonFetch({ 'open.spotify.com/oembed': { title: 'Northfold', thumbnail_url: 'https://img.test/a.jpg' } }) });
		const w = await c.follow({ url: 'https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi' });
		expect(w.object.name).toBe('Northfold');
		expect(calls.at(-1)).toEqual({
			method: 'watch',
			input: {
				deviceId: 'dev-1',
				source: 'manual',
				claim: { provider: 'spotify', kind: 'artist', providerId: '4tZwfgrHOc3mvqYlEYSvVi', name: 'Northfold', url: 'https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi', facts: { coverUrl: 'https://img.test/a.jpg' } },
			},
		});
	});

	it('follows a label by name as one shared object per folded name', async () => {
		const { catalog, calls } = fakeCatalog();
		const c = createCatalogClient({ ...base, catalog });
		await c.follow({ labelName: '  Northfold Records. ' });
		expect((calls.at(-1)!.input as { claim: CatalogClaim }).claim).toEqual({ provider: 'user', kind: 'label', providerId: 'name:northfold records', name: 'Northfold Records.' });
	});

	it('refuses playlists and unknown links with a sentence, and everything while signed out', async () => {
		const { catalog } = fakeCatalog();
		const c = createCatalogClient({ ...base, catalog, fetch: jsonFetch({}) });
		await expect(c.follow({ url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' })).rejects.toBeInstanceOf(CatalogInputError);
		await expect(c.follow({ url: 'https://example.com/x' })).rejects.toBeInstanceOf(CatalogInputError);
		const out = createCatalogClient({ ...base, catalog, signedIn: () => false });
		expect(out.status()).toEqual({ available: false, reason: 'signed_out' });
		await expect(out.watches()).rejects.toBeInstanceOf(CatalogUnavailableError);
	});

	it('lists catalogue matches first and hides provider candidates the catalogue already holds', async () => {
		const known: CatalogObjectSummary = { id: 'o1', kind: 'artist', name: 'Northfold', handles: [{ provider: 'deezer', id: '77', url: null }], coverUrl: null, watchCount: 4 };
		const { catalog } = fakeCatalog({
			search: async (input) => ({ objects: input.kind === 'artist' ? [known] : [] }),
			listWatches: async () => [watchOf('Northfold', 'o1')],
		});
		const c = createCatalogClient({
			...base,
			catalog,
			fetch: jsonFetch({ 'api.deezer.com/search/artist': { data: [{ id: 77, name: 'Northfold' }, { id: 78, name: 'Northfold Collective' }] } }),
		});
		const hits = await c.search('northfold');
		expect(hits.map((h) => [h.key, h.watched])).toEqual([
			['catalog:o1', true],
			['deezer:78', false],
		]);
	});

	it('follows many at once: claims and labels batched, genres by exact name, failures reported', async () => {
		const genre: CatalogObjectSummary = { id: 'g1', kind: 'genre', name: 'Melodic House & Techno', handles: [], coverUrl: null, watchCount: 0 };
		const { catalog, calls } = fakeCatalog({
			search: async (input) => ({ objects: input.kind === 'genre' ? [genre] : [] }),
			import: async (input) => {
				calls.push({ method: 'import', input });
				return { created: 1, existing: 1, watched: 1, rejected: 0, duplicate: false };
			},
		});
		const c = createCatalogClient({ ...base, catalog });
		const r = await c.followMany([
			{ claim: { provider: 'spotify', kind: 'artist', providerId: 'sp1', name: 'Northfold' } },
			{ labelName: 'Northfold Records' },
			{ genreName: 'melodic house and techno' },
			{ genreName: 'Zydeco Fusion' },
		]);
		expect(r).toEqual({ followed: 2, already: 1, failed: [{ name: 'Zydeco Fusion', error: expect.stringContaining('not one of') }] });
		const imported = calls.find((x) => x.method === 'import')!.input as { claims: CatalogClaim[]; source: string };
		expect(imported.claims.map((cl) => `${cl.provider}:${cl.kind}:${cl.providerId}`)).toEqual(['spotify:artist:sp1', 'user:label:name:northfold records']);
		expect(imported.source).toBe('manual');
		expect(calls.filter((x) => x.method === 'watch').map((x) => (x.input as { objectId: string }).objectId)).toEqual(['g1']);
	});

	it('imports Spotify follows in content-keyed batches of 200', async () => {
		const { catalog, calls } = fakeCatalog();
		const artists = Array.from({ length: 450 }, (_, i) => ({ id: `a${i}`, name: `Artist ${i}`, images: [] }));
		const fetchFn = vi.fn(async (url: string) => {
			const after = new URL(url).searchParams.get('after');
			const start = after ? Number(after.slice(1)) + 1 : 0;
			const page = artists.slice(start, start + 50);
			return new Response(JSON.stringify({ artists: { items: page, cursors: { after: page.length === 50 ? page.at(-1)!.id : null } } }), { status: 200 });
		});
		vi.stubGlobal('fetch', fetchFn);
		try {
			const c = createCatalogClient({ ...base, catalog, spotifyToken: async () => 'tok' });
			const r = await c.importSpotifyFollows();
			expect(r).toEqual({ found: 450, created: 450, watched: 450, existing: 0 });
			const imports = calls.filter((x) => x.method === 'import').map((x) => x.input as { claims: unknown[]; idempotencyKey: string; source: string });
			expect(imports.map((i) => i.claims.length)).toEqual([200, 200, 50]);
			expect(new Set(imports.map((i) => i.idempotencyKey)).size).toBe(3);
			expect(imports[0]!.source).toBe('imported');
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
