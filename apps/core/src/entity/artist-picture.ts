// An artist's picture, looked up at a store when the Global Catalog holds
// none for the artist (its readers bring a picture only from a few stores).
//
// The lookup is public, key-less and costs no API quota: Spotify's oEmbed
// names an artist page's thumbnail without a token. What is found is shown
// on the page and sent up to the catalogue (entity/service.ts), so it is
// looked up once, not once per device.
//
// Spotify only. Deezer's artist endpoint is as open, but a Deezer artist id
// is not one artist: it files every artist of a name together, and the
// picture on such a page is whichever namesake's Deezer chose (2026-11-18).

import { log } from '@curator/sync-core/log';

const plog = log.for('entity');

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ArtistPicture {
	provider: 'spotify';
	providerId: string;
	url: string;
}

const LOOKUP_TIMEOUT_MS = 6_000;

async function getJson<T>(fetchFn: FetchLike, url: string): Promise<T | null> {
	try {
		const res = await fetchFn(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
		return res.ok ? ((await res.json()) as T) : null;
	} catch (e) {
		plog.warn('artist picture lookup failed', { host: new URL(url).hostname }, e);
		return null;
	}
}

// The artist's picture on their Spotify page. Null when the page has none.
export async function findArtistPicture(ids: { spotify?: string | null }, fetchFn: FetchLike): Promise<ArtistPicture | null> {
	if (!ids.spotify) return null;
	const page = `https://open.spotify.com/artist/${ids.spotify}`;
	const o = await getJson<{ thumbnail_url?: string }>(fetchFn, `https://open.spotify.com/oembed?url=${encodeURIComponent(page)}`);
	return o?.thumbnail_url?.startsWith('https://') ? { provider: 'spotify', providerId: ids.spotify, url: o.thumbnail_url } : null;
}
