// What a review candidate lists, read live for the reviewer: the releases a
// MusicBrainz or Discogs label, a Beatport label, a Deezer or Spotify
// artist, or a Bandcamp band shows. Titles only, a page each; the reviewer
// compares them with the catalogue's own releases for the object.

import type { ReviewCandidate } from './admin.js';
import { fetchNextData, queryData, type BpPage, type BpReleaseRef } from './trackers/beatport-pages.js';
import { getJson, type FetchLike } from './trackers/http.js';
import type { SpotifyAppTracker } from './trackers/spotify-app.js';
import type { AppleLookup } from './trackers/apple.js';
import type { TidalApp } from './trackers/tidal-app.js';

export type EvidenceDeps = { fetch?: FetchLike; spotify?: SpotifyAppTracker | null; tidal?: TidalApp | null; apple?: AppleLookup | null };

const UA = 'curator-catalog/0.1 (+https://github.com/boyangu/curator)';

export async function candidateReleases(deps: EvidenceDeps, c: ReviewCandidate): Promise<string[]> {
	const fetchFn = deps.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
	const signal = AbortSignal.timeout(20_000);
	const json = <T>(provider: string, url: string) => getJson<T>(fetchFn, provider, url, { headers: { 'user-agent': UA }, signal, logPath: new URL(url).pathname });
	if (!c.provider || !c.providerId) return [];
	switch (c.provider) {
		case 'musicbrainz': {
			const r = await json<{ releases?: { title: string }[] }>('musicbrainz', `https://musicbrainz.org/ws/2/release?label=${c.providerId}&limit=25&fmt=json`);
			return (r.releases ?? []).map((x) => x.title);
		}
		case 'discogs': {
			const r = await json<{ releases?: { title: string }[] }>('discogs', `https://api.discogs.com/labels/${c.providerId}/releases?per_page=25`);
			return (r.releases ?? []).map((x) => x.title);
		}
		case 'beatport': {
			const d = await fetchNextData(fetchFn, `/label/label/${c.providerId}/releases`, signal);
			return queryData<BpPage<BpReleaseRef>>(d, (k) => k.startsWith('releases-label_id='))?.results.map((x) => x.name) ?? [];
		}
		case 'deezer': {
			const r = await json<{ data?: { title: string }[] }>('deezer', `https://api.deezer.com/artist/${c.providerId}/albums?limit=50`);
			return (r.data ?? []).map((x) => x.title);
		}
		case 'spotify': {
			if (!deps.spotify) return [];
			const r = await deps.spotify.get<{ items: { name: string }[] }>(`/artists/${encodeURIComponent(c.providerId)}/albums?include_groups=album,single&limit=50`, signal);
			return r.items.map((x) => x.name);
		}
		case 'bandcamp': {
			const r = await json<{ discography?: { title: string }[] }>('bandcamp', `https://bandcamp.com/api/mobile/24/band_details?band_id=${c.providerId}`);
			return (r.discography ?? []).map((x) => x.title);
		}
		default:
			return [];
	}
}
