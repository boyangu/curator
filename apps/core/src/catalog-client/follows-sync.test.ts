import type { CatalogClaim, CatalogWatch } from '@curator/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncSpotifyFollows, type FollowsSyncState } from './follows-sync.js';
import type { CatalogClient } from './service.js';

// Spotify as the follows sync sees it: the user, the artists they follow,
// their playlist index (own + followed).
function fakeSpotify(artists: { id: string; name: string }[]) {
	vi.stubGlobal('fetch', async (input: string) => {
		const u = new URL(input);
		const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
		if (u.pathname === '/v1/me') return json({ id: 'me', display_name: 'Me', images: [], external_urls: { spotify: '' } });
		if (u.pathname === '/v1/me/following') return json({ artists: { items: artists, cursors: { after: null } } });
		if (u.pathname === '/v1/me/playlists')
			return json({
				items: [
					{ id: 'own', name: 'My Set', owner: { id: 'me' }, snapshot_id: 's', tracks: { total: 1 } },
					{ id: 'pl-x', name: 'Deep Picks', owner: { id: 'curator-x' }, snapshot_id: 's', tracks: { total: 9 } },
				],
				next: null,
			});
		return new Response('{}', { status: 404 });
	});
}

function fakeClient(watches: CatalogWatch[] = []) {
	const imported: { claims: CatalogClaim[]; source: string }[] = [];
	const muted: string[] = [];
	const client = {
		status: () => ({ available: true, reason: 'ok' as const }),
		importClaims: async (claims: CatalogClaim[], source: string) => {
			imported.push({ claims, source });
			return { found: claims.length, created: claims.length, watched: claims.length, existing: 0 };
		},
		watches: async () => watches,
		mute: async (id: string) => {
			muted.push(id);
		},
	} as unknown as CatalogClient;
	return { client, imported, muted };
}

const artistWatch = (id: string, spotifyId: string): CatalogWatch => ({
	object: { id, kind: 'artist', name: id, handles: [{ provider: 'spotify', id: spotifyId, url: null }], coverUrl: null, watchCount: 1 },
	source: 'imported',
	muted: false,
	createdAt: 0,
	tracking: [],
});

let state: FollowsSyncState | null;
const base = () => ({ spotifyToken: async () => 'tok', load: () => state, save: (s: FollowsSyncState) => void (state = s) });

beforeEach(() => {
	state = null;
	process.env['SPOTIFY_LOG'] = 'off';
});
afterEach(() => vi.unstubAllGlobals());

describe('Spotify follows sync', () => {
	it('first run: followed artists and followed (not own) playlists become watches, mutes carried', async () => {
		fakeSpotify([
			{ id: 'sa1', name: 'Northfold' },
			{ id: 'sa2', name: 'Kaske' },
		]);
		const { client, imported, muted } = fakeClient([artistWatch('cat-1', 'sa1'), artistWatch('cat-2', 'sa2')]);
		const r = await syncSpotifyFollows({ ...base(), client, mutedSpotifyArtistIds: async () => new Set(['sa2']) });
		expect(r).toEqual({ artists: 2, playlists: 1, muted: 1 });
		expect(imported.map((i) => [i.source, i.claims.map((c) => `${c.kind}:${c.providerId}`)])).toEqual([
			['imported', ['artist:sa1', 'artist:sa2']],
			['imported', ['playlist:pl-x']],
		]);
		expect(muted).toEqual(['cat-2']);
		expect(state).toMatchObject({ artists: ['sa1', 'sa2'], playlists: ['pl-x'], mutesCarried: true });
	});

	it('later runs bring only new Spotify follows, never one unfollowed in Curator, and wait their interval', async () => {
		state = { at: Date.now() - 7 * 3600_000, artists: ['sa1', 'sa2'], playlists: ['pl-x'], mutesCarried: true };
		fakeSpotify([
			{ id: 'sa1', name: 'Northfold' },
			{ id: 'sa2', name: 'Kaske' },
			{ id: 'sa3', name: 'Elsewhere' },
		]);
		const { client, imported, muted } = fakeClient();
		const r = await syncSpotifyFollows({ ...base(), client, mutedSpotifyArtistIds: async () => new Set(['sa1']) });
		expect(r).toEqual({ artists: 1, playlists: 0, muted: 0 });
		expect(imported.flatMap((i) => i.claims.map((c) => c.providerId))).toEqual(['sa3']);
		expect(muted).toEqual([]);
		// Within the interval: nothing at all.
		expect(await syncSpotifyFollows({ ...base(), client, mutedSpotifyArtistIds: async () => new Set() })).toBeNull();
	});
});
