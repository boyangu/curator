// The user's streaming service read as a catalogue: who an artist is there,
// what they released, a release in full, and the service's own search.
//
// The Global Catalog knows what its trackers have read. An artist or an album
// nobody followed is not in it, and getting it there (read the store, register
// it, read the catalogue's answer back) takes a while. The streaming service
// the user plays through answers in a call or two — so an entity the catalogue
// does not know is shown from there at once, on the desktop (apps/core
// entity/service.ts, whose page work registers the same read: nothing is
// asked of the service twice) and on the phone (apps/mobile js/entity.ts,
// whose page work the cloud names: catalog.resolve's find job). The
// desktop's omnibar World scope searches through here too.
//
// What it hands out is the catalogue's own vocabulary: a release is the claim
// a reader would send up (`CatalogClaim`, with its tracklist), so a page built
// from it and a registration built from it are the same data. Shown before
// the catalogue has an object for them, the releases stand in the catalogue's
// page shape under the service's own ids (`streamObjectId`).
//
// Reads are few, cached for the session and never tied to the caller's
// lifetime: a page left midway leaves its answer for the next ask.
//
// Spotify only for now. Tidal's search exists (packages/providers/tidal) but
// its artist and album reads are not built, so with Tidal as the primary
// service there is no streaming catalogue and pages behave as before.

import type { CatalogClaim, CatalogHandle, CatalogPageRelease, CatalogPageTrack, CatalogTracksResult } from '@curator/protocol';
import { fetchAlbums, ProviderHttpError, releaseClaimFromTrack, spotifyReleaseClaim, SpotifyTracker, type FetchLike, type SpPlaylistTrack } from '@curator/catalog-readers';

export type StreamingService = 'spotify' | 'tidal';

export type StreamingArtist = { id: string; name: string; imageUrl: string | null; genres: string[]; url: string };

export type StreamingHit = {
	kind: 'artist' | 'album' | 'track';
	id: string;
	name: string;
	url: string;
	imageUrl: string | null;
	artists: { id: string; name: string }[];
	// artist: what tells it from a namesake, where the service says (its
	// genres, else its following).
	detail: string | null;
	// album: its own date; track: its album's.
	date: string | null;
	// track: the album it is on, and that album as a release carrying the
	// track — what a row is built from.
	album: { id: string; name: string } | null;
	release: CatalogClaim | null;
};

export interface StreamingCatalog {
	readonly service: StreamingService;
	// Null: the service has no such artist.
	artist(id: string): Promise<StreamingArtist | null>;
	// The artist's own releases (albums and singles) as the service lists
	// them, newest first: title, date, credits — no tracklists. `total` is the
	// service's count, which can exceed what is listed here.
	listing(artistId: string): Promise<{ total: number; releases: CatalogClaim[] }>;
	// Releases in full (tracklist, label, UPC) by the service's own ids. One
	// the service no longer has is left out.
	releases(ids: readonly string[]): Promise<Map<string, CatalogClaim>>;
	search(q: string): Promise<StreamingHit[]>;
}

// ── a streaming release in the catalogue's page shape ───────────────────────

const STREAM_ID = /^(spotify|tidal)_(.+)$/;

// The id a streaming object stands under where a catalogue object's would
// be: on a World row, in a group header, in a ref. Never a catalogue id (a
// uuid), so the two cannot be mistaken for each other.
export const streamObjectId = (service: string, id: string): string => `${service}_${id}`;

export function parseStreamObjectId(id: string | null | undefined): { service: StreamingService; id: string } | null {
	const m = id ? STREAM_ID.exec(id) : null;
	return m ? { service: m[1] as StreamingService, id: m[2]! } : null;
}

const sid = (c: Pick<CatalogClaim, 'provider' | 'providerId'>): string => streamObjectId(c.provider, c.providerId);
const refsOf = (artists: readonly CatalogClaim[] | undefined): { id: string; name: string }[] => (artists ?? []).map((a) => ({ id: sid(a), name: a.name }));
const handleOf = (c: CatalogClaim): CatalogHandle => ({ provider: c.provider, id: c.providerId, url: c.url ?? null });

export function provisionalRelease(c: CatalogClaim): CatalogPageRelease {
	const recordings = c.recordings ?? [];
	const multiDisc = new Set(recordings.map((r) => r.facts?.discNumber ?? 1)).size > 1;
	const tracks: CatalogPageTrack[] = recordings.map((r, i) => ({
		id: sid(r),
		title: r.name,
		position: r.facts?.trackNumber ?? i + 1,
		disc: multiDisc ? (r.facts?.discNumber ?? 1) : null,
		durationSec: r.facts?.durationSec ?? null,
		isrc: r.identifiers?.find((x) => x.namespace === 'isrc')?.value ?? null,
		bpm: null,
		key: null,
		genres: [],
		artists: refsOf(r.artists),
		handles: [handleOf(r)],
	}));
	return {
		id: sid(c),
		title: c.name,
		date: c.facts?.releaseDate ?? null,
		type: c.facts?.releaseType ?? null,
		coverUrl: c.facts?.coverUrl ?? null,
		labelText: c.facts?.labelText ?? null,
		labels: [],
		artists: refsOf(c.artists),
		genres: c.genres ?? [],
		handles: [handleOf(c)],
		trackCount: tracks.length || (c.facts?.trackCount ?? 0),
		appearance: false,
		tracks,
	};
}

// ── Spotify ─────────────────────────────────────────────────────────────────

const READ_TIMEOUT_MS = 20_000;
const ARTIST_TTL_MS = 30 * 60_000;
const RELEASE_TTL_MS = 60 * 60_000;
const SEARCH_TTL_MS = 5 * 60_000;
const RELEASES_HELD = 2000;
const SEARCHES_HELD = 60;
// An artist's listing is read to this many releases: the newest are what a
// page opens on, and a catalogue of four hundred remixes is the trackers' to
// walk once somebody follows the artist.
const LISTING_MAX = 200;
const SEARCH_LIMIT = 10;

type SpArtist = { id: string; name: string; images?: { url: string }[]; genres?: string[]; followers?: { total?: number }; external_urls?: { spotify?: string } };
type SpAlbumRef = { id: string; name: string; album_type?: string; release_date?: string; total_tracks?: number; images?: { url: string }[]; artists?: { id: string; name: string; external_urls?: { spotify?: string } }[]; external_urls?: { spotify?: string } };
type SpPage<T> = { items?: (T | null)[]; total?: number; next?: string | null };
type SpSearch = { artists?: SpPage<SpArtist>; albums?: SpPage<SpAlbumRef>; tracks?: SpPage<SpPlaylistTrack> };

type Held<T> = { at: number; value: Promise<T> };

// A signal that aborts after `ms`: AbortSignal.timeout, which the phone's
// runtime lacks (its shim brings an AbortController, apps/mobile
// js/shim/store-fetch.ts).
function timeout(ms: number): AbortSignal {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), ms);
	(timer as { unref?: () => void }).unref?.();
	return ctl.signal;
}

export function createSpotifyStreaming(deps: {
	// The user's Spotify token; null while Spotify is not connected.
	token(): Promise<string | null>;
	// The desktop's process-wide gate the player and the feed share; the
	// phone's store-fetch seam.
	fetch: FetchLike;
	now?: () => number;
}): StreamingCatalog {
	const now = deps.now ?? Date.now;
	const reader = new SpotifyTracker(
		{
			token: async () => {
				const t = await deps.token();
				if (!t) throw new Error('Spotify is not connected');
				return t;
			},
		},
		deps.fetch,
	);
	const get = <T>(path: string): Promise<T> => reader.get<T>(path, timeout(READ_TIMEOUT_MS));

	const artists = new Map<string, Held<StreamingArtist | null>>();
	const listings = new Map<string, Held<{ total: number; releases: CatalogClaim[] }>>();
	const full = new Map<string, Held<CatalogClaim | null>>();
	const searches = new Map<string, Held<StreamingHit[]>>();

	// One read per key while its answer is fresh; a second ask joins the
	// first, and a read that failed is asked again.
	function held<T>(map: Map<string, Held<T>>, key: string, ttlMs: number, max: number, read: () => Promise<T>): Promise<T> {
		const hit = map.get(key);
		if (hit && now() - hit.at < ttlMs) return hit.value;
		const value = read();
		map.delete(key);
		map.set(key, { at: now(), value });
		value.catch(() => { if (map.get(key)?.value === value) map.delete(key); });
		// Oldest out: a Map iterates in insertion order.
		while (map.size > max) map.delete(map.keys().next().value!);
		return value;
	}

	const notFound = (e: unknown): boolean => e instanceof ProviderHttpError && (e.status === 404 || e.status === 400);

	async function readListing(artistId: string): Promise<{ total: number; releases: CatalogClaim[] }> {
		const id = encodeURIComponent(artistId);
		const albums: SpAlbumRef[] = [];
		let total = 0;
		// Fifty a page where the app is served that many; some are held to twenty.
		let limit = 50;
		for (let offset = 0; offset < LISTING_MAX; ) {
			let page: SpPage<SpAlbumRef>;
			try {
				page = await get<SpPage<SpAlbumRef>>(`/artists/${id}/albums?include_groups=album,single&limit=${limit}&offset=${offset}`);
			} catch (e) {
				if (offset === 0 && limit > 20 && e instanceof ProviderHttpError && e.status === 400) {
					limit = 20;
					continue;
				}
				throw e;
			}
			const items = (page.items ?? []).filter((a): a is SpAlbumRef => !!a?.id);
			albums.push(...items);
			total = page.total ?? albums.length;
			offset += limit;
			if (!page.next || !items.length) break;
		}
		const seen = new Set<string>();
		const distinct = albums.filter((a) => !seen.has(a.id) && !!seen.add(a.id));
		// The service groups albums before singles: one list, newest first.
		distinct.sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''));
		return { total: Math.max(total, distinct.length), releases: distinct.map((a) => spotifyReleaseClaim(a)) };
	}

	async function readSearch(q: string): Promise<StreamingHit[]> {
		const body = await get<SpSearch>(`/search?type=artist,album,track&q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`);
		const out: StreamingHit[] = [];
		const credits = (xs: { id: string; name: string }[] | undefined): { id: string; name: string }[] => (xs ?? []).filter((a) => a?.id && a.name).map((a) => ({ id: a.id, name: a.name }));
		for (const a of body.artists?.items ?? []) {
			if (!a?.id || !a.name) continue;
			const detail = a.genres?.length ? a.genres.slice(0, 2).join(', ') : a.followers?.total ? `${a.followers.total.toLocaleString('en-US')} followers` : null;
			out.push({ kind: 'artist', id: a.id, name: a.name, url: a.external_urls?.spotify ?? `https://open.spotify.com/artist/${a.id}`, imageUrl: a.images?.[0]?.url ?? null, artists: [], detail, date: null, album: null, release: null });
		}
		for (const a of body.albums?.items ?? []) {
			if (!a?.id || !a.name) continue;
			out.push({ kind: 'album', id: a.id, name: a.name, url: a.external_urls?.spotify ?? `https://open.spotify.com/album/${a.id}`, imageUrl: a.images?.[0]?.url ?? null, artists: credits(a.artists), detail: null, date: a.release_date ?? null, album: null, release: null });
		}
		for (const t of body.tracks?.items ?? []) {
			if (!t?.id || !t.name) continue;
			const release = releaseClaimFromTrack(t);
			if (!release || !t.album) continue;
			out.push({
				kind: 'track',
				id: t.id,
				name: t.name,
				url: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
				imageUrl: t.album.images?.[0]?.url ?? null,
				artists: credits(t.artists),
				detail: null,
				date: t.album.release_date ?? null,
				album: { id: t.album.id, name: t.album.name },
				release,
			});
		}
		return out;
	}

	return {
		service: 'spotify',

		artist: (id) =>
			held(artists, id, ARTIST_TTL_MS, 500, async () => {
				try {
					const a = await get<SpArtist>(`/artists/${encodeURIComponent(id)}`);
					return a?.id ? { id: a.id, name: a.name, imageUrl: a.images?.[0]?.url ?? null, genres: a.genres ?? [], url: a.external_urls?.spotify ?? `https://open.spotify.com/artist/${a.id}` } : null;
				} catch (e) {
					if (notFound(e)) return null;
					throw e;
				}
			}),

		listing: (artistId) => held(listings, artistId, ARTIST_TTL_MS, 200, () => readListing(artistId)),

		async releases(ids) {
			const reads = new Map<string, Promise<CatalogClaim | null>>();
			const missing: string[] = [];
			for (const id of new Set(ids)) {
				const hit = full.get(id);
				if (hit && now() - hit.at < RELEASE_TTL_MS) reads.set(id, hit.value);
				else missing.push(id);
			}
			if (missing.length) {
				// Twenty a call (the reader's batches): one read shared by every id in it.
				const batch = fetchAlbums(reader, missing, timeout(READ_TIMEOUT_MS)).then((r) => r.claims);
				for (const id of missing) {
					const value = batch.then((m) => m.get(id) ?? null);
					full.delete(id);
					full.set(id, { at: now(), value });
					value.catch(() => { if (full.get(id)?.value === value) full.delete(id); });
					reads.set(id, value);
				}
				while (full.size > RELEASES_HELD) full.delete(full.keys().next().value!);
			}
			const out = new Map<string, CatalogClaim>();
			for (const [id, read] of reads) {
				const claim = await read;
				if (claim) out.set(id, claim);
			}
			return out;
		},

		search: (q) => held(searches, q.trim().toLowerCase(), SEARCH_TTL_MS, SEARCHES_HELD, () => readSearch(q.trim())),
	};
}

// ── a page of an entity's releases from the service ─────────────────────────

// Releases a page of the list holds, and the mark of a cursor into a list
// read from the service (never a catalogue cursor: the two are not mixed up).
export const STREAM_PAGE = 20;
export const STREAM_CURSOR = 's:';

// A page of an artist's releases (or the one album) as the service lists
// them, in the catalogue's page shape, under the service's ids. Null: the
// service has no such album.
export async function streamPage(stream: StreamingCatalog, ask: { kind: 'artist' | 'album'; id: string; name: string; cursor?: string | null }): Promise<CatalogTracksResult | null> {
	const { id } = ask;
	if (ask.kind === 'album') {
		const claim = (await stream.releases([id])).get(id);
		return claim ? { object: { id: streamObjectId(stream.service, id), kind: 'release', name: claim.name }, redirectedFrom: null, releases: [provisionalRelease(claim)], nextCursor: null } : null;
	}
	const listing = await stream.listing(id);
	const offset = ask.cursor?.startsWith(STREAM_CURSOR) ? Number(ask.cursor.slice(STREAM_CURSOR.length)) || 0 : 0;
	const slice = listing.releases.slice(offset, offset + STREAM_PAGE);
	const full = await stream.releases(slice.map((c) => c.providerId));
	const next = offset + STREAM_PAGE;
	return {
		object: { id: streamObjectId(stream.service, id), kind: 'artist', name: ask.name },
		redirectedFrom: null,
		// A release the service no longer hands out in full keeps its place, without rows.
		releases: slice.map((c) => provisionalRelease(full.get(c.providerId) ?? c)),
		nextCursor: next < listing.releases.length ? `${STREAM_CURSOR}${next}` : null,
	};
}
