// What the engine asks of the stores, as a handful of primitives: a page's
// listing, one release page in full, the release carrying a code, the
// releases a title and an artist find, and one track's facts. Each store does
// what it can and answers null for the rest (Beatport looks nothing up by
// code; Bandcamp only lists). The defaults are the catalogue's own readers
// (@curator/catalog-readers, the provider packages) over the lanes' fetches;
// tests and hosts hand in their own.
//
// A release page read once is kept a while (RELEASE_CACHE): the ISRC, UPC and
// name rungs of one lookup often land on the same album, and a page's own
// Spotify releases are read twenty to a call up front (prefetch).

import { BeatportClient } from '@curator/beatport';
import {
	BandcampTracker,
	BeatportTracker,
	DeezerTracker,
	DZ_NOT_FOUND,
	fetchAlbums,
	getJson,
	ProviderHttpError,
	searchBeatport,
	SpotifyTracker,
	TrackerRateLimitedError,
	type FetchLike,
	type TrackerPoll,
	type TrackerTarget,
} from '@curator/catalog-readers';
import type { CatalogClaim, CatalogFactsStore, CatalogHandle, CatalogWorkStore } from '@curator/protocol';
import { TraxsourceClient } from '@curator/traxsource';
import { WorkDeviceNotReadyError } from './lanes.js';

// One track as a store's search found it, with the facts it states.
export type FactHit = {
	id: string;
	url: string;
	title: string;
	mix: string | null;
	isrc: string | null;
	durationSec: number | null;
	bpm: number | null;
	// The store's own notation ("A Minor", "D#min").
	key: string | null;
	genre: string | null;
	label: string | null;
	artists: string[];
};

export type FactQuery = { title: string; artists: string[]; durationSec: number | null; isrc: string | null };

// A candidate a name search offered, read in full only when asked for: the
// first that confirms ends the search. Null: the store no longer has it.
export type Candidate = () => Promise<CatalogClaim | null>;

export type WorkReaders = {
	listing(store: CatalogWorkStore, target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll>;
	// Null: the store no longer has it.
	release(handle: CatalogHandle, signal: AbortSignal): Promise<CatalogClaim | null>;
	// The release pages a batch of jobs will read, fetched together where the
	// store allows (Spotify: twenty a call), so release() finds them read.
	prefetch?(handles: readonly CatalogHandle[], signal: AbortSignal): Promise<void>;
	byIsrc(store: CatalogWorkStore, isrc: string, signal: AbortSignal): Promise<CatalogClaim | null>;
	byUpc(store: CatalogWorkStore, upc: string, signal: AbortSignal): Promise<CatalogClaim | null>;
	// A few, best first.
	byName(store: CatalogWorkStore, title: string, artist: string, signal: AbortSignal): Promise<Candidate[]>;
	// Null only when the store answered and has no such track: a call that
	// failed throws, or "not found" would be remembered of a store that was
	// never asked.
	facts(store: CatalogFactsStore, q: FactQuery, signal: AbortSignal): Promise<FactHit | null>;
	// When a store's client rests after a block, until (its own cooldown).
	blockedUntil(store: CatalogWorkStore): number | null;
};

// Releases a name search offers, at most.
const NAME_CANDIDATES = 3;
// Release pages kept, and for how long.
const RELEASE_CACHE = 200;
const RELEASE_CACHE_MS = 30 * 60_000;
const SPOTIFY_BATCH = 20;

export type ReaderIo = {
	fetchFor(store: CatalogWorkStore): FetchLike;
	// Spotify's bearer token, or null while there is none to be had.
	spotifyToken?: () => Promise<string | null>;
	now: () => number;
};

const gone = (e: unknown): boolean => e instanceof ProviderHttpError && e.status === 404;

export function defaultReaders(io: ReaderIo): WorkReaders {
	const token = async (): Promise<string> => {
		const t = await io.spotifyToken?.();
		if (!t) throw new WorkDeviceNotReadyError('Spotify is not connected');
		return t;
	};
	const spotify = new SpotifyTracker({ token }, io.fetchFor('spotify'), io.now);
	const deezer = new DeezerTracker(io.fetchFor('deezer'));
	const beatport = new BeatportTracker(io.fetchFor('beatport'), io.now);
	const bandcamp = new BandcampTracker(io.fetchFor('bandcamp'), io.now);
	const beatportFacts = new BeatportClient({ fetchImpl: io.fetchFor('beatport') });
	const traxsourceFacts = new TraxsourceClient({ fetchImpl: io.fetchFor('traxsource') });

	const cache = new Map<string, { at: number; claim: CatalogClaim | null }>();
	const cached = (key: string): { claim: CatalogClaim | null } | undefined => {
		const hit = cache.get(key);
		if (!hit) return undefined;
		if (io.now() - hit.at > RELEASE_CACHE_MS) {
			cache.delete(key);
			return undefined;
		}
		return hit;
	};
	const keep = (key: string, claim: CatalogClaim | null): CatalogClaim | null => {
		cache.delete(key);
		cache.set(key, { at: io.now(), claim });
		while (cache.size > RELEASE_CACHE) cache.delete(cache.keys().next().value!);
		return claim;
	};
	const albums = async (ids: readonly string[], signal: AbortSignal): Promise<void> => {
		const missing = [...new Set(ids)].filter((id) => !cached(`spotify:${id}`));
		for (let i = 0; i < missing.length; i += SPOTIFY_BATCH) {
			const part = missing.slice(i, i + SPOTIFY_BATCH);
			const full = await fetchAlbums(spotify, part, signal);
			for (const id of part) keep(`spotify:${id}`, full.claims.get(id) ?? null);
		}
	};
	const album = async (id: string, signal: AbortSignal): Promise<CatalogClaim | null> => {
		await albums([id], signal);
		return cached(`spotify:${id}`)?.claim ?? null;
	};
	const deezerRelease = async (id: string, signal: AbortSignal): Promise<CatalogClaim | null> => {
		const hit = cached(`deezer:${id}`);
		if (hit) return hit.claim;
		try {
			return keep(`deezer:${id}`, await deezer.fetchRelease({ id }, signal));
		} catch (e) {
			if (gone(e)) return keep(`deezer:${id}`, null);
			throw e;
		}
	};
	const beatportRelease = async (id: string, url: string | null, signal: AbortSignal): Promise<CatalogClaim | null> => {
		const hit = cached(`beatport:${id}`);
		if (hit) return hit.claim;
		try {
			return keep(`beatport:${id}`, await beatport.fetchRelease(id, url, signal));
		} catch (e) {
			if (gone(e)) return keep(`beatport:${id}`, null);
			throw e;
		}
	};
	// Deezer answers 200 with { error }: 800 is "no such thing", 4 its quota,
	// anything else Deezer failing.
	const deezerAnswer = <T extends { error?: { code: number } }>(j: T): T | null => {
		if (!j.error) return j;
		if (j.error.code === DZ_NOT_FOUND) return null;
		if (j.error.code === 4) throw new TrackerRateLimitedError(10);
		throw new Error(`deezer error ${j.error.code}`);
	};
	const quoted = (s: string): string => s.replace(/"/g, ' ').trim();

	return {
		listing(store, target, signal) {
			if (store === 'spotify') return spotify.poll(target, signal);
			if (store === 'beatport') return beatport.poll(target, signal);
			if (store === 'bandcamp') return bandcamp.poll(target, signal);
			throw new Error(`no listing reader for ${store}`);
		},

		async release(h, signal) {
			try {
				if (h.provider === 'spotify') return await album(h.id, signal);
				if (h.provider === 'deezer') return await deezerRelease(h.id, signal);
				if (h.provider === 'beatport') return await beatportRelease(h.id, h.url, signal);
			} catch (e) {
				if (gone(e)) return null;
				throw e;
			}
			throw new Error(`no release reader for ${h.provider}`);
		},

		async prefetch(handles, signal) {
			await albums(handles.filter((h) => h.provider === 'spotify').map((h) => h.id), signal);
		},

		async byIsrc(store, isrc, signal) {
			if (store === 'spotify') {
				const s = await spotify.get<{ tracks?: { items: { album?: { id: string } }[] } }>(`/search?type=track&limit=3&q=${encodeURIComponent(`isrc:${isrc}`)}`, signal);
				const id = s.tracks?.items?.[0]?.album?.id;
				return id ? album(id, signal) : null;
			}
			if (store === 'deezer') {
				const t = deezerAnswer(await getJson<{ error?: { code: number }; album?: { id?: number } }>(io.fetchFor('deezer'), 'deezer', `https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`, { signal, logPath: '/track/isrc' }));
				return t?.album?.id ? deezerRelease(String(t.album.id), signal) : null;
			}
			return null;
		},

		async byUpc(store, upc, signal) {
			if (store === 'spotify') {
				const s = await spotify.get<{ albums?: { items: { id: string }[] } }>(`/search?type=album&limit=3&q=${encodeURIComponent(`upc:${upc}`)}`, signal);
				const id = s.albums?.items?.[0]?.id;
				return id ? album(id, signal) : null;
			}
			if (store === 'deezer') {
				try {
					return await deezer.fetchRelease({ upc }, signal);
				} catch (e) {
					if (gone(e)) return null;
					throw e;
				}
			}
			return null;
		},

		async byName(store, title, artist, signal) {
			if (store === 'spotify') {
				const s = await spotify.get<{ albums?: { items: { id: string }[] } }>(`/search?type=album&limit=5&q=${encodeURIComponent(`album:"${quoted(title)}" artist:"${quoted(artist)}"`)}`, signal);
				const ids = (s.albums?.items ?? []).slice(0, NAME_CANDIDATES).map((a) => a.id);
				// One call reads them all; the first that confirms is the one.
				return ids.map((id) => async () => {
					await albums(ids, signal);
					return cached(`spotify:${id}`)?.claim ?? null;
				});
			}
			if (store === 'deezer') {
				const hits = (await deezer.searchReleases(title, signal, artist)).slice(0, NAME_CANDIDATES);
				return hits.map((h) => () => deezerRelease(h.id, signal));
			}
			if (store === 'beatport') {
				const hits = (await searchBeatport(io.fetchFor('beatport'), 'release', `${artist} ${title}`, signal)).slice(0, NAME_CANDIDATES);
				return hits.map((h) => async () => {
					try {
						return await beatportRelease(h.id, h.url, signal);
					} catch (e) {
						// A search hit whose page carries no release is not the one.
						if (e instanceof Error && /does not carry it/.test(e.message)) return null;
						throw e;
					}
				});
			}
			return [];
		},

		async facts(store, q) {
			const target = { title: q.title, artists: q.artists, duration: q.durationSec, isrc: q.isrc };
			// A call that failed throws (ProviderFailedError): null is the store's word.
			const hit = store === 'beatport' ? await beatportFacts.lookup(target) : await traxsourceFacts.lookup(target);
			if (!hit) return null;
			return {
				id: String(hit.id),
				url: hit.url,
				title: hit.title,
				mix: hit.mix,
				isrc: hit.isrc,
				durationSec: hit.duration,
				bpm: hit.bpm,
				key: hit.key,
				genre: hit.genre,
				label: hit.label,
				artists: hit.artists,
			};
		},

		blockedUntil(store) {
			if (store === 'beatport') return beatportFacts.blockedUntil();
			if (store === 'traxsource') return traxsourceFacts.blockedUntil();
			return null;
		},
	};
}
