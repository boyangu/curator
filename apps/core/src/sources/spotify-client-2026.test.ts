// The Spotify client against both API versions (SPOTIFY_2026 in
// packages/providers/spotify): the older one our app still gets, and the
// February 2026 Development Mode one it will be moved onto. Each test loads a
// fresh module so the remembered request forms don't leak between tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Route = (url: URL, init: RequestInit | undefined) => { status: number; body?: unknown } | null;

let calls: Array<{ method: string; path: string; body: unknown }>;

function fakeSpotify(route: Route): void {
	vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
		const url = new URL(input);
		const method = init?.method ?? 'GET';
		calls.push({ method, path: url.pathname.replace(/^\/v1/, '') + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		const r = route(url, init) ?? { status: 404, body: { error: { status: 404, message: 'Service not found' } } };
		return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
			status: r.status,
			headers: { 'content-type': 'application/json' },
		});
	});
}

async function client() {
	vi.resetModules();
	const mod = await import('@curator/spotify');
	return { mod, c: new mod.SpotifyClient('token', 'test') };
}

const track = (id: string) => ({
	id, name: `Song ${id}`, duration_ms: 200_000, explicit: false,
	artists: [{ id: 'a1', name: 'Artist' }], album: { id: 'al1', name: 'EP', release_date: '2026-01-01', images: [] },
});

beforeEach(() => {
	calls = [];
	process.env['SPOTIFY_LOG'] = 'off';
});
afterEach(() => vi.unstubAllGlobals());

describe('playlist items', () => {
	it('reads the 2026 /items form, mapping item → track', async () => {
		fakeSpotify((u) => (u.pathname.endsWith('/items')
			? { status: 200, body: { items: [{ added_at: '2026-10-01T00:00:00Z', added_by: null, is_local: false, item: track('t1') }], total: 1, next: null } }
			: null));
		const { c } = await client();
		const items = await c.getPlaylistTracks('pl1');
		expect(items.map((i) => i.track?.id)).toEqual(['t1']);
	});

	it('falls back to /tracks where /items is not served, and remembers it', async () => {
		fakeSpotify((u) => (u.pathname.endsWith('/tracks')
			? { status: 200, body: { items: [{ added_at: '2026-10-01T00:00:00Z', added_by: null, is_local: false, track: track('t1') }], total: 1, next: null } }
			: null));
		const { c } = await client();
		expect((await c.getPlaylistTracks('pl1')).map((i) => i.track?.id)).toEqual(['t1']);
		calls = [];
		await c.getPlaylistTracks('pl2');
		expect(calls.map((x) => x.path.split('?')[0])).toEqual(['/playlists/pl2/tracks']);
	});

	it('a 403 on /items for a playlist we do not own is "withheld", never an empty list', async () => {
		fakeSpotify((u) => (u.pathname.endsWith('/items') ? { status: 403, body: { error: { status: 403 } } } : null));
		const { c, mod } = await client();
		await expect(c.getPlaylistTracks('pl1')).rejects.toBeInstanceOf(mod.SpotifyPlaylistItemsWithheldError);
	});

	it('an answer without items is withheld', async () => {
		fakeSpotify((u) => (u.pathname.endsWith('/items') ? { status: 200, body: { total: 12, next: null } } : null));
		const { c, mod } = await client();
		await expect(c.getPlaylistTracks('pl1')).rejects.toBeInstanceOf(mod.SpotifyPlaylistItemsWithheldError);
	});

	it('refuses an empty page that claims more items', async () => {
		fakeSpotify((u) => (u.pathname.endsWith('/items') ? { status: 200, body: { items: [], total: 40, next: null } } : null));
		const { c } = await client();
		await expect(c.getPlaylistTracks('pl1')).rejects.toThrow(/not trusting a short list/);
	});

	it('a missing playlist stays a plain error', async () => {
		fakeSpotify(() => null);
		const { c, mod } = await client();
		const err = await c.getPlaylistTracks('gone').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(mod.SpotifyHttpError);
		expect(err).not.toBeInstanceOf(mod.SpotifyPlaylistItemsWithheldError);
	});
});

describe('playlist objects', () => {
	it('maps the 2026 `items` count and flags withheld playlists', async () => {
		fakeSpotify((u) => (u.pathname === '/v1/me/playlists'
			? {
				status: 200,
				body: {
					items: [
						{ id: 'own', name: 'Own', owner: { id: 'me' }, snapshot_id: 's', items: { total: 7 } },
						{ id: 'theirs', name: 'Theirs', owner: { id: 'x' }, snapshot_id: 's' },
					],
					next: null,
				},
			}
			: null));
		const { c } = await client();
		const pls = await c.getUserPlaylists();
		expect(pls.map((p) => [p.id, p.tracks.total, p.itemsWithheld ?? false])).toEqual([['own', 7, false], ['theirs', 0, true]]);
	});
});

describe('batch lookups', () => {
	it('uses the batch while it is served', async () => {
		fakeSpotify((u) => (u.pathname === '/v1/tracks' ? { status: 200, body: { tracks: [track('t1'), null, track('t3')] } } : null));
		const { c } = await client();
		expect((await c.getTracksByIds(['t1', 't2', 't3'])).map((t) => t.id)).toEqual(['t1', 't3']);
		expect(calls).toHaveLength(1);
	});

	it('drops to single lookups once the batch is refused, skipping unknown ids', async () => {
		fakeSpotify((u) => {
			if (u.pathname === '/v1/tracks') return { status: 403, body: {} };
			const id = u.pathname.split('/').pop()!;
			return id === 't2' ? null : { status: 200, body: track(id) };
		});
		const { c } = await client();
		expect((await c.getTracksByIds(['t1', 't2', 't3'])).map((t) => t.id)).toEqual(['t1', 't3']);
		calls = [];
		await c.getTracksByIds(['t4']);
		expect(calls.map((x) => x.path)).toEqual(['/tracks/t4']);
	});

	it('a refusal both forms share is thrown, not swallowed', async () => {
		fakeSpotify(() => ({ status: 403, body: {} }));
		const { c } = await client();
		await expect(c.getTracksByIds(['t1'])).rejects.toThrow(/403/);
	});
});

describe('writes', () => {
	it('removal on /items names its list `items`; the older form names it `tracks`', async () => {
		fakeSpotify((u, init) => (init?.method === 'DELETE' && u.pathname.endsWith('/tracks') ? { status: 200, body: { snapshot_id: 'snap2' } } : null));
		const { c } = await client();
		const res = await c.removePlaylistTracks('pl1', ['t1']);
		expect(res.snapshot_id).toBe('snap2');
		expect(calls.map((x) => [x.path, x.body])).toEqual([
			['/playlists/pl1/items', { items: [{ uri: 'spotify:track:t1' }] }],
			['/playlists/pl1/tracks', { tracks: [{ uri: 'spotify:track:t1' }] }],
		]);
	});

	it('a write is sent once when its first form answers', async () => {
		fakeSpotify((u, init) => (init?.method === 'POST' && u.pathname.endsWith('/items') ? { status: 201, body: { snapshot_id: 'snap' } } : null));
		const { c } = await client();
		await c.addPlaylistTracks('pl1', ['t1', 't2']);
		expect(calls).toHaveLength(1);
	});

	it('a write refused for a reason both forms share is not retried past them', async () => {
		fakeSpotify(() => ({ status: 401, body: {} }));
		const { c } = await client();
		await expect(c.addPlaylistTracks('pl1', ['t1'])).rejects.toThrow(/401/);
		expect(calls).toHaveLength(1);
	});

	it('creates playlists on /me/playlists, falling back to /users/{id}/playlists', async () => {
		fakeSpotify((u) => (u.pathname === '/v1/users/me1/playlists'
			? { status: 201, body: { id: 'new', name: 'N', owner: { id: 'me1' }, snapshot_id: 's', tracks: { total: 0 } } }
			: null));
		const { c } = await client();
		const pl = await c.createPlaylist('me1', 'N');
		expect(pl.id).toBe('new');
		expect(calls.map((x) => x.path)).toEqual(['/me/playlists', '/users/me1/playlists']);
	});
});

describe('search', () => {
	it('re-asks at 10 when a bigger limit is refused', async () => {
		fakeSpotify((u) => {
			if (u.pathname !== '/v1/search') return null;
			return Number(u.searchParams.get('limit')) > 10
				? { status: 400, body: { error: { message: 'Invalid limit' } } }
				: { status: 200, body: { tracks: { items: [track('t1')] } } };
		});
		const { c } = await client();
		expect(await c.searchTracks('q', 50)).toHaveLength(1);
		expect(calls.map((x) => new URL(`https://x${x.path}`).searchParams.get('limit'))).toEqual(['50', '10']);
	});
});
