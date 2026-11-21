// An artist's pages on the stores — what "Open Artist in ▸" links to.
//
// Two places know them. The library's artist_link rows hold the Spotify and
// Tidal ids read off synced track payloads. The Global Catalog holds every
// store's page for the artist (Beatport, SoundCloud, Bandcamp…), reached
// through an id the caller already has: a catalogue object id, or a Spotify
// artist id (the feed's, or the library link's). The catalogue's answer is
// kept in memory, not written to artist_link: those rows feed identity
// (artist signals, follow candidates), and a catalogue artist can hold a
// namesake's page until it is repaired (2026-11-09, ELIF) — a cache forgets,
// a row would not.
//
// A name alone opens nothing direct: an artist a surface knows by id is never
// swapped for the library's namesake of that name. The catalogue is optional
// (signed out, server off, slow): the local links are the answer then.

import type { ArtistLink, ArtistPages, ArtistPagesTarget } from '@curator/shared';
import type { CatalogHandle } from '@curator/protocol';
import type { CatalogClient } from '../catalog-client/service.js';

const TTL_MS = 6 * 3600_000;
// A miss or a failure is asked again sooner.
const MISS_TTL_MS = 5 * 60_000;
// How long a menu waits for the catalogue before answering with what is local.
const WAIT_MS = 2500;

export type ArtistPagesDeps = {
	// The live library artist for an id (aliases followed), or by name.
	artistById(id: string): { id: string } | null;
	artistByName(name: string): { id: string } | null;
	links(artistId: string): ArtistLink[];
	catalog(): Pick<CatalogClient, 'status' | 'resolve' | 'browse'> | null;
	now?: () => number;
	waitMs?: number;
};

// The catalogue's artist: its object id and its store handles.
type Known = { id: string; handles: CatalogHandle[] };
type Cached = { at: number; known: Known | null; pending?: Promise<Known | null> };

const spotifyUrl = (id: string): string => `https://open.spotify.com/artist/${id}`;

// A catalogue handle a person can open: a store's own page. A reader's name
// key (`<page>/<name>`, or the `user` provider) is no page.
const openable = (h: CatalogHandle): boolean => !!h.url && h.provider !== 'user' && !h.id.includes('/');

// `forget`: drops what the catalogue said (a page was just connected to an
// artist: catalog-client/connect.ts).
export type ArtistPagesReader = ((t: ArtistPagesTarget) => Promise<ArtistPages>) & { forget(): void };

export function createArtistPages(deps: ArtistPagesDeps): ArtistPagesReader {
	const cache = new Map<string, Cached>();
	const now = deps.now ?? Date.now;

	const fetchKnown = async (key: string, read: (c: Pick<CatalogClient, 'resolve' | 'browse'>) => Promise<Known | null>): Promise<Known | null> => {
		const hit = cache.get(key);
		if (hit?.pending) return hit.pending;
		if (hit && now() - hit.at < (hit.known ? TTL_MS : MISS_TTL_MS)) return hit.known;
		const client = deps.catalog();
		if (!client || !client.status().available) return null;
		const pending = read(client)
			.catch(() => null)
			.then((known) => {
				cache.set(key, { at: now(), known });
				return known;
			});
		cache.set(key, { at: hit?.at ?? 0, known: hit?.known ?? null, pending });
		return pending;
	};

	const read = async (t: ArtistPagesTarget): Promise<ArtistPages> => {
		const artist = t.artistId ? deps.artistById(t.artistId) : null;
		const pages = new Map<string, ArtistLink>();
		if (t.spotifyId) pages.set('spotify', { source: 'spotify', sourceId: t.spotifyId, url: spotifyUrl(t.spotifyId) });
		// The library's own links, for the artist asked for by id only.
		if (artist) for (const l of deps.links(artist.id)) if (!pages.has(l.source)) pages.set(l.source, l);

		const spotifyId = pages.get('spotify')?.sourceId ?? null;
		const lookup = t.catalogId
			? fetchKnown(`id:${t.catalogId}`, async (c) => (await c.browse(t.catalogId!, { brief: true })).object)
			: spotifyId
				? fetchKnown(`spotify:${spotifyId}`, async (c) => (await c.resolve([{ provider: 'spotify', kind: 'artist', providerId: spotifyId }]))[0] ?? null)
				: null;
		let catalogId: string | null = null;
		if (lookup) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const known = await Promise.race([lookup, new Promise<null>((res) => { timer = setTimeout(() => res(null), deps.waitMs ?? WAIT_MS); })]);
			clearTimeout(timer);
			catalogId = known?.id ?? null;
			for (const h of known?.handles ?? []) if (openable(h) && !pages.has(h.provider)) pages.set(h.provider, { source: h.provider, sourceId: h.id, url: h.url ?? null });
		}
		return {
			libraryArtistId: artist?.id ?? deps.artistByName(t.name)?.id ?? null,
			catalogId,
			pages: [...pages.values()].sort((a, b) => a.source.localeCompare(b.source)),
		};
	};
	return Object.assign(read, { forget: () => cache.clear() });
}
