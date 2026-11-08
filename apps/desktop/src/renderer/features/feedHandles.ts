// Where a Discover item can be played or bought — the renderer's mirror of
// core feed/handles.ts (the renderer cannot import core at runtime).
//
// Players this build can drive: Spotify (the sidecar). A catalogue item
// carries every provider handle the catalogue knows; the first one on a
// connected player plays it, and an item with none shows its store pages
// instead of the play disc until the catalogue finds it on Spotify (the row
// is then upgraded in place). Add a provider here when its player lands.

import type { FeedItem, FeedTrackRef } from '@curator/core';

type Handle = NonNullable<FeedItem['payload']['handles']>[number];

export const CONNECTED_PLAYERS = ['spotify'] as const;

const spotifyHandle = (hs: readonly Handle[] | undefined): string | null => hs?.find((h) => h.provider === 'spotify')?.id ?? null;

// The Spotify id to hand the player, or null when nothing here can play it.
// Album items: the album's own (cards), else per track.
export function playableId(item: FeedItem, track?: FeedTrackRef): string | null {
	if (track) return spotifyHandle(track.handles) ?? (item.source === 'spotify' && track.sourceTrackId !== track.catalogId ? track.sourceTrackId : null);
	return spotifyHandle(item.payload.handles) ?? (item.source === 'spotify' ? item.sourceId : null);
}

// A card can start playback: a track it can play, or an album with at least
// one such track (or a legacy Spotify album whose tracklist loads lazily).
export function cardPlayable(item: FeedItem): boolean {
	if (item.type === 'track') return playableId(item) !== null;
	const tracks = item.payload.tracks;
	if (!tracks || tracks.length === 0) return item.source === 'spotify' && !item.payload.catalogId;
	return tracks.some((t) => playableId(item, t) !== null);
}

const PROVIDER_LABEL: Record<string, string> = {
	spotify: 'Spotify',
	deezer: 'Deezer',
	youtube: 'YouTube',
	beatport: 'Beatport',
	beatsource: 'Beatsource',
	soundcloud: 'SoundCloud',
	tidal: 'Tidal',
	bandcamp: 'Bandcamp',
	traxsource: 'Traxsource',
	apple: 'Apple Music',
	musicbrainz: 'MusicBrainz',
	discogs: 'Discogs',
	instagram: 'Instagram',
	website: 'Website',
	user: 'by name',
};

export const providerLabel = (p: string): string => PROVIDER_LABEL[p] ?? p;

// Store pages to open when nothing here can play it, in the order a DJ shops.
const STORE_ORDER = ['beatport', 'bandcamp', 'traxsource', 'soundcloud', 'youtube', 'deezer', 'tidal', 'apple', 'beatsource'];

// Every page the item has (the context menu's "Open in …"): the catalogue's
// handles with a URL, stores first in shopping order, then the rest; and the
// store matches the desktop's enrichment made (sourceLinks — where the bpm
// and key came from), when the handles do not already name that store. One
// entry per provider.
export function allLinks(
	hs: readonly Handle[] | undefined,
	sourceLinks?: readonly { source: string; url?: string | null }[] | null,
): { provider: string; label: string; url: string }[] {
	const out: { provider: string; label: string; url: string }[] = [];
	const seen = new Set<string>();
	const add = (provider: string, url: string | null | undefined): void => {
		if (!url || seen.has(provider)) return;
		seen.add(provider);
		out.push({ provider, label: providerLabel(provider), url });
	};
	for (const p of STORE_ORDER) add(p, hs?.find((x) => x.provider === p && x.url)?.url);
	for (const h of hs ?? []) add(h.provider, h.url);
	for (const l of sourceLinks ?? []) add(l.source, l.url);
	return out;
}

export function storeLinks(hs: readonly Handle[] | undefined): { provider: string; label: string; url: string }[] {
	const out: { provider: string; label: string; url: string }[] = [];
	for (const p of STORE_ORDER) {
		const h = hs?.find((x) => x.provider === p && x.url);
		if (h?.url) out.push({ provider: p, label: providerLabel(p), url: h.url });
	}
	return out;
}

// Artist ids on feed payloads: a Spotify id, or `catalog:<objectId>` for an
// artist the catalogue knows without one (core cloud-producer.ts).
export const isSpotifyArtistId = (id: string | null | undefined): id is string => !!id && !id.startsWith('catalog:');
