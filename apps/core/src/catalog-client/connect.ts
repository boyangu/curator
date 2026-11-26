// "Help us connect the dots" on the desktop ('catalog_connect_auto'): which
// store page is an artist's, a label's or an album's, for the stores the
// Global Catalog has not mapped. The cloud decides what an answer does
// (apps/cloud catalog/connect.ts); this module is the part only a device can
// do — searching the stores for candidates — and connect-finder.ts runs it
// for the user's follows without being asked, keeping the queue of what it
// could not settle:
//
//   Beatport    its search pages, over the fetch the desktop gives Beatport
//               (Electron's: the cloud's own is mostly behind the challenge)
//   Deezer      the open API
//   Spotify     the user's own connection, when there is one
//   Tidal       the same
//   Bandcamp    its public search
//   SoundCloud  through the cloud, which holds the app's credentials
//
// Every store is searched without the user asking: the modal opens on pages
// to pick from, each with its picture and how many follow it where the store
// says (Spotify, Deezer, SoundCloud). The pasted link stays for the page no
// search found.
//
// A search runs once per object and store, one search call and
// at most COMPARED release-list calls, and its answer is kept for the session.
// What a candidate lists goes to the cloud as evidence with the answer; the
// cloud reads the page itself before it trusts anything.

import { beatportPageReleases, searchBeatport, TrackerRateLimitedError, type FetchLike } from '@curator/catalog-readers';
import { nameFold } from '@curator/library-logic';
import {
	CATALOG_CONNECT_ANSWERS_MAX,
	type CatalogConnectAnswer,
	type CatalogConnectAnswerResult,
	type CatalogConnectCandidate,
	type CatalogConnectItem,
	type CatalogProvider,
	type CloudService,
	type PageKind,
} from '@curator/protocol';
import { SpotifyClient } from '@curator/spotify';
import type { TidalApiClient } from '@curator/tidal';
import { log } from '@curator/sync-core/log';
import { CatalogUnavailableError, type CatalogClientStatus } from './service.js';

const clog = log.for('catalog');

// Candidates offered per store, and how many of them have their releases read.
const OFFERED = 5;
const COMPARED = 3;
const SEARCH_TIMEOUT_MS = 12_000;

// What the modal knows of the object it asks about.
export type ConnectSubject = { kind: PageKind; name: string; titles: string[]; detail: string | null };
// `note`: why there is nothing to pick — the store has no search here
// ('no_search'), it needs a connection ('not_connected'), it turned the
// desktop away ('blocked'), or the search failed ('failed').
export type ConnectSearch = { provider: CatalogProvider; candidates: CatalogConnectCandidate[]; searchUrl: string | null; note: 'no_search' | 'not_connected' | 'blocked' | 'failed' | null };

// What the modal walks: a page of objects, and how many there are in all.
export type ConnectQueue = { items: CatalogConnectItem[]; total: number };

export interface CatalogConnect {
	status(): CatalogClientStatus;
	// These objects, as the cloud holds them: the stores each lacks, its titles
	// (`compare`: all an answer is checked against), the candidates left open.
	queue(opts: { objectIds: string[]; compare?: boolean }): Promise<ConnectQueue>;
	search(subject: ConnectSubject, provider: CatalogProvider): Promise<ConnectSearch>;
	answer(answers: CatalogConnectAnswer[]): Promise<CatalogConnectAnswerResult>;
}

export type ConnectDeps = {
	catalog: Pick<CloudService['catalog'], 'connectQueue' | 'connectAnswer' | 'connectSearch'>;
	// The catalogue itself (signed in, server on), then whether that server
	// offers this feature.
	status: () => CatalogClientStatus;
	offered: () => boolean;
	deviceId: () => string;
	spotifyToken: () => Promise<string | null>;
	// The user's Tidal connection as a search, or null when not connected.
	tidal?: () => Promise<Pick<TidalApiClient, 'searchCatalog'> | null>;
	beatportFetch?: FetchLike;
	fetch?: FetchLike;
	// A page was attached: whoever cached the object's pages should ask again.
	onAttached?: () => void;
};

// A store's namesake tag ("Elif (tr)") is not part of the name.
export const connectFold = (name: string): string => nameFold(name.replace(/\s*\([A-Za-z]{2,3}\)\s*$/, ''));
const fold = connectFold;

// Where a person searches the store by hand.
export function storeSearchUrl(provider: CatalogProvider, kind: PageKind, q: string): string | null {
	const e = encodeURIComponent(q);
	switch (provider) {
		case 'beatport':
			return `https://www.beatport.com/search/${kind}s?q=${e}`;
		case 'soundcloud':
			return `https://soundcloud.com/search/${kind === 'release' ? 'albums' : 'people'}?q=${e}`;
		case 'bandcamp':
			return `https://bandcamp.com/search?q=${e}&item_type=${kind === 'release' ? 'a' : 'b'}`;
		case 'spotify':
			return `https://open.spotify.com/search/${e}/${kind === 'release' ? 'albums' : 'artists'}`;
		case 'deezer':
			return `https://www.deezer.com/search/${e}/${kind === 'release' ? 'album' : 'artist'}`;
		case 'tidal':
			return `https://listen.tidal.com/search/${kind === 'release' ? 'albums' : 'artists'}?q=${e}`;
		default:
			return null;
	}
}

type Hit = { id: string; name: string; url: string; imageUrl: string | null; detail: string | null; followers?: number | null };

type BandcampRow = { type?: string; id?: number; name?: string; item_url_root?: string; img?: string | null; location?: string | null; is_label?: boolean; band_name?: string | null };

export function createCatalogConnect(deps: ConnectDeps): CatalogConnect {
	const fetchFn: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
	const bpFetch: FetchLike = deps.beatportFetch ?? fetchFn;
	const cache = new Map<string, Promise<ConnectSearch>>();

	const status = (): CatalogClientStatus => {
		const s = deps.status();
		return s.available && !deps.offered() ? { available: false, reason: 'server_off' } : s;
	};
	const ready = () => {
		const s = status();
		if (!s.available) throw new CatalogUnavailableError(s.reason === 'signed_out' ? 'Sign in to Curator Cloud to help connect the dots.' : 'The catalogue server does not offer this yet.');
	};

	async function deezer<T>(path: string, signal: AbortSignal): Promise<T[]> {
		const res = await fetchFn(`https://api.deezer.com${path}`, { signal });
		if (!res.ok) throw new Error(`deezer ${res.status}`);
		const body = (await res.json()) as { data?: T[]; error?: unknown };
		if (body.error) throw new Error('deezer error');
		return body.data ?? [];
	}

	// What an album is searched by: its title and its first credited artist.
	const albumQuery = (s: ConnectSubject): string => [s.name, s.detail?.split(' · ')[0]?.split(',')[0]].filter(Boolean).join(' ');

	async function hits(s: ConnectSubject, provider: CatalogProvider, signal: AbortSignal): Promise<Hit[] | ConnectSearch['note']> {
		if (provider === 'beatport') return searchBeatport(bpFetch, s.kind, s.kind === 'release' ? albumQuery(s) : s.name, signal);
		if (provider === 'deezer') {
			if (s.kind === 'label') return 'no_search';
			if (s.kind === 'artist') {
				const rows = await deezer<{ id: number; name: string; link?: string; picture_medium?: string; nb_album?: number; nb_fan?: number }>(`/search/artist?q=${encodeURIComponent(s.name)}&limit=10`, signal);
				return rows.map((a) => ({ id: String(a.id), name: a.name, url: a.link ?? `https://www.deezer.com/artist/${a.id}`, imageUrl: a.picture_medium ?? null, detail: a.nb_album ? `${a.nb_album} releases` : null, followers: a.nb_fan ?? null }));
			}
			const rows = await deezer<{ id: number; title: string; link?: string; cover_medium?: string; nb_tracks?: number; artist?: { name?: string } }>(`/search/album?q=${encodeURIComponent(albumQuery(s))}&limit=10`, signal);
			return rows.map((a) => ({ id: String(a.id), name: a.title, url: a.link ?? `https://www.deezer.com/album/${a.id}`, imageUrl: a.cover_medium ?? null, detail: [a.artist?.name, a.nb_tracks ? `${a.nb_tracks} tracks` : null].filter(Boolean).join(' · ') || null }));
		}
		if (provider === 'spotify') {
			if (s.kind === 'label') return 'no_search';
			const token = await deps.spotifyToken().catch(() => null);
			if (!token) return 'not_connected';
			const client = new SpotifyClient(token, 'catalog:connect');
			if (s.kind === 'artist') {
				return (await client.searchArtists(s.name, 10)).map((a) => ({ id: a.id, name: a.name, url: a.external_urls?.spotify ?? `https://open.spotify.com/artist/${a.id}`, imageUrl: a.images?.[0]?.url ?? null, detail: null, followers: a.followers?.total ?? null }));
			}
			return (await client.searchAlbums(albumQuery(s), 10)).map((a) => ({
				id: a.id,
				name: a.name,
				url: a.external_urls?.spotify ?? `https://open.spotify.com/album/${a.id}`,
				imageUrl: a.images?.[0]?.url ?? null,
				detail: [a.artists?.map((x) => x.name).join(', '), a.release_date].filter(Boolean).join(' · ') || null,
			}));
		}
		if (provider === 'tidal') {
			if (s.kind === 'label') return 'no_search';
			const tidal = await deps.tidal?.().catch(() => null);
			if (!tidal) return 'not_connected';
			const word = s.kind === 'artist' ? 'artist' : 'album';
			return (await tidal.searchCatalog(`${word}s`, s.kind === 'artist' ? s.name : albumQuery(s), 10)).map((h) => ({ id: h.id, name: h.name, url: `https://tidal.com/browse/${word}/${h.id}`, imageUrl: h.imageUrl, detail: h.releaseDate }));
		}
		if (provider === 'bandcamp') {
			// Profiles only: an album's Bandcamp id is not in its link (page-ref.ts).
			if (s.kind === 'release') return 'no_search';
			const res = await fetchFn('https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ search_text: s.name, search_filter: 'b', full_page: false, fan_id: null }),
				signal,
			});
			if (!res.ok) throw new Error(`bandcamp ${res.status}`);
			const rows = ((await res.json()) as { auto?: { results?: BandcampRow[] } }).auto?.results ?? [];
			return rows
				// A band on its own domain has no link the catalogue can key.
				.filter((r) => r.type === 'b' && r.id && r.name && /^https:\/\/[a-z0-9-]+\.bandcamp\.com\/?$/i.test(r.item_url_root ?? ''))
				.map((r) => ({ id: String(r.id), name: r.name!, url: r.item_url_root!.replace(/\/$/, ''), imageUrl: r.img ?? null, detail: [r.is_label ? 'Label' : null, r.location].filter(Boolean).join(' · ') || null }));
		}
		if (provider === 'soundcloud') {
			if (s.kind === 'release') return 'no_search';
			const r = await deps.catalog.connectSearch({ deviceId: deps.deviceId(), provider: 'soundcloud', kind: s.kind, name: s.name });
			if (!r.searched) return 'no_search';
			return r.candidates.map((c) => ({ id: c.providerId, name: c.name, url: c.url, imageUrl: c.imageUrl ?? null, detail: c.detail ?? null, followers: c.followers ?? null }));
		}
		return 'no_search';
	}

	// The titles a candidate lists, for the stores that say (an artist's or a
	// label's page; an album candidate is compared by its own title and credit).
	async function releasesOf(s: ConnectSubject, provider: CatalogProvider, id: string, signal: AbortSignal): Promise<string[]> {
		if (s.kind === 'release') return [];
		if (provider === 'beatport') return beatportPageReleases(bpFetch, s.kind, id, signal);
		if (provider === 'deezer') return (await deezer<{ title: string }>(`/artist/${id}/albums?limit=50`, signal)).map((a) => a.title);
		if (provider === 'spotify') {
			const token = await deps.spotifyToken().catch(() => null);
			return token ? (await new SpotifyClient(token, 'catalog:connect').getArtistAlbums(id, { limit: 50 })).map((a) => a.name) : [];
		}
		if (provider === 'bandcamp') {
			const res = await fetchFn(`https://bandcamp.com/api/mobile/24/band_details?band_id=${encodeURIComponent(id)}`, { signal });
			return res.ok ? (((await res.json()) as { discography?: { title: string }[] }).discography ?? []).map((d) => d.title) : [];
		}
		return [];
	}

	async function run(s: ConnectSubject, provider: CatalogProvider): Promise<ConnectSearch> {
		const out: ConnectSearch = { provider, candidates: [], searchUrl: storeSearchUrl(provider, s.kind, s.kind === 'release' ? albumQuery(s) : s.name), note: null };
		const signal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
		let found: Hit[];
		try {
			const r = await hits(s, provider, signal);
			if (!Array.isArray(r)) return { ...out, note: r };
			found = r;
		} catch (e) {
			clog.warn('connect: store search failed', { provider, kind: s.kind }, e);
			return { ...out, note: e instanceof TrackerRateLimitedError ? 'blocked' : 'failed' };
		}
		// The store's namesakes first, in its own order; then the rest of its
		// answer, for a name the store writes differently.
		const want = fold(s.name);
		const same = found.filter((h) => fold(h.name) === want);
		const ordered = [...same, ...found.filter((h) => !same.includes(h))].slice(0, OFFERED);
		const known = new Set(s.titles.map((t) => nameFold(t)));
		const candidates: CatalogConnectCandidate[] = [];
		for (const [i, h] of ordered.entries()) {
			let releases: string[] = [];
			if (i < COMPARED && same.includes(h)) releases = await releasesOf(s, provider, h.id, signal).catch(() => []);
			candidates.push({ provider, providerId: h.id, name: h.name, url: h.url, imageUrl: h.imageUrl, followers: h.followers ?? null, detail: h.detail, releases: releases.slice(0, 15), shared: releases.filter((t) => known.has(nameFold(t))).slice(0, 15), source: 'search' });
		}
		// The page sharing most with what the catalogue holds leads; the store's
		// own order (its best match first) settles the rest.
		candidates.sort((a, b) => (b.shared?.length ?? 0) - (a.shared?.length ?? 0));
		return { ...out, candidates };
	}

	return {
		status,

		async queue(opts) {
			ready();
			const { items } = await deps.catalog.connectQueue({ deviceId: deps.deviceId(), objectIds: opts.objectIds, ...(opts.compare ? { compare: true } : {}) });
			return { items, total: items.length };
		},

		search(subject, provider) {
			ready();
			const key = `${provider}|${subject.kind}|${fold(subject.name)}|${subject.detail ?? ''}`;
			let p = cache.get(key);
			if (!p) {
				p = run(subject, provider);
				cache.set(key, p);
				// A search that did not answer is asked again next time.
				void p.then((r) => { if (r.note === 'failed' || r.note === 'blocked' || r.note === 'not_connected') cache.delete(key); });
			}
			return p;
		},

		async answer(answers) {
			ready();
			const results: CatalogConnectAnswerResult['results'] = [];
			for (let i = 0; i < answers.length; i += CATALOG_CONNECT_ANSWERS_MAX) {
				results.push(...(await deps.catalog.connectAnswer({ deviceId: deps.deviceId(), answers: answers.slice(i, i + CATALOG_CONNECT_ANSWERS_MAX) })).results);
			}
			if (results.some((r) => r.outcome === 'attached')) deps.onAttached?.();
			clog.info('connect answers sent', { answers: results.length, attached: results.filter((r) => r.outcome === 'attached').length, waiting: results.filter((r) => r.outcome === 'waiting').length });
			return { results };
		},
	};
}
