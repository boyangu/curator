// Entity pages: what an artist's, a label's or an album's page shows — its
// header, and the World side of its track list.
//
// A page has two sides. "Owned" is the library's local files: the header
// carries the track filter for it and the renderer reads the rows through
// the ordinary `tracks:list` path (the read sidecar), so this module never
// loads library rows. "World" is the Global Catalog: `tracks` answers a page
// of the catalogue's releases with their tracklists, each recording marked
// with the library track it is, when the library has it.
//
// What an artist or a label IS — its picture, genres, labels, artists —
// comes from the catalogue alone, whichever side the list shows: the page
// describes the artist, not the slice of them the library happens to hold.
// The library contributes what only it knows: which entity of its own this
// is, its local files, and the store ids on its own rows.
//
// An artist or an album the catalogue does not know (nobody followed it), or
// cannot be asked about (signed out), is shown from the user's streaming
// service instead (entity/streaming.ts): its header and its releases, read
// in a call or two and laid out as the catalogue's would be. `world.via`
// says so. Where the catalogue can be reached the page work registers what
// was read (entity/work.ts) and the page becomes the catalogue's.
//
// Runs in-process (the catalogue client is not in the read sidecar): the
// local reads are point lookups, the rest is network. The catalogue is
// optional — signed out, an older server, slow — and the page is then the
// name, the library's files, and what the streaming service lists.

import type Database from 'better-sqlite3';
import { getTableColumns } from 'drizzle-orm';
import type { CatalogBrowseResult, CatalogHandle, CatalogTracksResult } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import { searchFold, track, type Track, type AlbumSummary, type ArtistLink, type EntityChip, type EntityHeader, type EntityRef, type EntityRowPatch, type EntityTracksPage, type EntityWorldReason, type ZTrackFilterT } from '@curator/shared';
import { isDistributor } from '../catalog-client/library-claims.js';
import { keyToCamelot } from '../enrich/keys.js';
import { findSpotifyAlbum, findSpotifyTrack, type SpotifyMatchClient } from '../feed/spotify-match.js';
import { log } from '../log.js';
import { matchLibraryTracks, type OwnershipProbe } from './ownership.js';
import { findArtistPicture, type ArtistPicture, type FetchLike } from './artist-picture.js';
import { artistBadges } from './badges.js';
import { identifyLocal, identifyRemote, libraryForObject, rememberObject, type EntityCatalog, type EntityIds } from './resolve.js';
import { normalizeEntityRef, provisionalRelease, streamObjectId, type StreamingCatalog } from './streaming.js';

const elog = log.for('entity');

// "Owned" is a file on disk: the Rekordbox tab's membership (rekordbox ∪
// local), not everything the library knows of.
export const OWNED_SOURCES = ['rekordbox', 'local'];

// How long a header is kept, by how much it can be trusted to still be true:
//   whole   the catalogue answered in full.
//   partial the catalogue answered but something is still to come (a picture
//           lookup in flight) or may soon change (an entity it does not know).
//   none    the catalogue was not asked or did not answer (signed out, the
//           server busy or off, an error). Never kept: the page asks again
//           and has the catalogue the moment it is back — a kept "not
//           reachable" used to stand for ten minutes after a blip that
//           lasted seconds (2026-11-18).
type Keep = 'whole' | 'partial' | 'none';
const KEEP_MS: Record<Keep, number> = { whole: 10 * 60_000, partial: 60_000, none: 0 };
const PAGE_TTL_MS = 10 * 60_000;
const PAGE_CACHE_MAX = 60;
const CHIPS_MAX = 12;
// An artist's labels: every one the header can name (it shows the first few
// and lists the rest behind "+n more").
const LABELS_MAX = 50;
const GENRES_MAX = 6;
// How long a header waits for an artist's picture lookup at a store. Past it
// the page opens without one; the lookup finishes for the next ask.
const PICTURE_WAIT_MS = 2500;
// A page of the streaming service's releases: one call for their tracklists.
const STREAM_PAGE = 20;
// What a page cursor of the streaming service's listing starts with (the
// catalogue's own are opaque, and never this).
const STREAM_CURSOR = 's:';
// Library tracks tried, to find the Spotify id of a library artist that has none.
const EVIDENCE_TRACKS = 2;
const CANDIDATES_MAX = 5;

export type EntityPagesDeps = {
	raw: Database.Database;
	catalog(): EntityCatalog | null;
	// Live tracks matching a filter (service.ts countTracksImpl).
	countTracks(filter: ZTrackFilterT): number;
	albumSummary(id: string): AlbumSummary | null;
	// A live library artist of this name (library/artists.ts lookupArtistRaw).
	artistByName(name: string): { id: string; name: string } | null;
	// The page work's side (entity/work.ts): told of every World page read,
	// and asked what its lookups found for a recording — laid over a page the
	// catalogue answered before it had those findings.
	onPage?(catalogId: string, result: CatalogTracksResult): void;
	patchOf?(recordingId: string): EntityRowPatch | undefined;
	// The user's streaming service read as a catalogue (entity/streaming.ts);
	// null while none is connected, or while it is resting.
	streaming?(): StreamingCatalog | null;
	// The feed's Spotify match client: by a track the library holds, it finds
	// the Spotify id of a library artist or album that carries none.
	spotifyMatch?(): Promise<SpotifyMatchClient | null>;
	fetch?: FetchLike;
	now?: () => number;
	pictureWaitMs?: number;
};

export interface EntityPages {
	// `localOnly`: what the library alone says, at once (world.reason
	// 'pending' where the catalogue would be asked). Without it the answer
	// waits for the catalogue.
	page(ref: EntityRef, opts?: { localOnly?: boolean }): Promise<EntityHeader>;
	tracks(ref: EntityRef, opts?: { cursor?: string }): Promise<EntityTracksPage>;
	// Drops what the catalogue said (a follow changed, a page was connected).
	forget(): void;
	// The World pages of a catalogue object read so far and still held.
	loaded(catalogId: string): Promise<CatalogTracksResult[]>;
	// The catalogue's answer for one object changed (this desktop registered
	// releases or tracklists for it): its pages and every header are read
	// again when next asked. Null: the headers alone (an entity the
	// catalogue did not know).
	drop(catalogId: string | null): void;
	// Releases in the catalogue's page shape as World rows, each recording
	// marked with the library track it is (the omnibar's World search).
	rows(result: CatalogTracksResult): EntityTracksPage;
}

// A track row with nothing in it — every column present, null where the
// schema allows, the type's zero where it does not. The renderer lays a
// catalogue recording over it so World rows are whole `Track`s to the list.
let blank: Track | null = null;
function blankTrack(): Track {
	if (blank) return blank;
	const out: Record<string, unknown> = {};
	for (const [key, col] of Object.entries(getTableColumns(track))) {
		out[key] = !col.notNull ? null : col.dataType === 'boolean' ? false : col.dataType === 'number' ? 0 : col.dataType === 'json' ? [] : col.dataType === 'date' ? new Date(0) : '';
	}
	blank = { ...out, state: 'unsorted' } as Track;
	return blank;
}

// A handle a person can open: a store's own page, not a reader's name key.
const openable = (h: CatalogHandle): boolean => !!h.url && h.provider !== 'user' && !h.id.includes('/');
const linksOf = (handles: readonly CatalogHandle[]): ArtistLink[] => handles.filter(openable).map((h) => ({ source: h.provider, sourceId: h.id, url: h.url }));

function mergeLinks(local: ArtistLink[], remote: ArtistLink[]): ArtistLink[] {
	const out = new Map<string, ArtistLink>();
	for (const l of [...local, ...remote]) if (!out.has(l.source)) out.set(l.source, l);
	return [...out.values()].sort((a, b) => a.source.localeCompare(b.source));
}

// The library's id first: it is what a lookup cannot change (a catalogue id
// is learned along the way, and would move the key under the cache).
const keyOf = (ids: Pick<EntityIds, 'kind' | 'name' | 'libraryId' | 'catalogId' | 'spotifyId'>): string =>
	`${ids.kind}:${ids.libraryId ? `l:${ids.libraryId}` : ids.catalogId ? `c:${ids.catalogId}` : ids.spotifyId ? `s:${ids.spotifyId}` : `n:${searchFold(ids.name)}`}`;

export function createEntityPages(deps: EntityPagesDeps): EntityPages {
	const { raw } = deps;
	const now = deps.now ?? Date.now;
	const fetchFn: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
	const headers = new Map<string, { at: number; keep: Keep; header: Promise<EntityHeader> }>();
	const pages = new Map<string, { at: number; page: Promise<CatalogTracksResult> }>();
	// Store lookups for artist pictures, by the ids asked with (found or not:
	// neither is asked twice in a session).
	const pictures = new Map<string, Promise<ArtistPicture | null>>();

	// ── the library's side ────────────────────────────────────────────────
	const ownedFilter = (ids: EntityIds, extraLabelFolds: string[] = []): ZTrackFilterT | null => {
		if (ids.kind === 'label') {
			const folds = [...new Set([searchFold(ids.name), ...extraLabelFolds].filter(Boolean))];
			return folds.length ? { labelFolds: folds, hasSource: OWNED_SOURCES } : null;
		}
		if (!ids.libraryId) return null;
		return ids.kind === 'artist' ? { artistIds: [ids.libraryId], hasSource: OWNED_SOURCES } : { albumIds: [ids.libraryId], hasSource: OWNED_SOURCES };
	};

	const localLinks = (ids: EntityIds): ArtistLink[] => {
		if (!ids.libraryId || ids.kind === 'label') return [];
		const rows = (
			ids.kind === 'artist'
				? raw.prepare(`select source, source_id as sourceId, url from artist_link where artist_id = ? order by source`).all(ids.libraryId)
				: raw.prepare(`select source, source_id as sourceId, url from album_link where album_id = ? order by source`).all(ids.libraryId)
		) as ArtistLink[];
		const path = ids.kind === 'artist' ? 'artist' : 'album';
		return rows.map((l) => (l.url || l.source !== 'spotify' ? l : { ...l, url: `https://open.spotify.com/${path}/${l.sourceId}` }));
	};

	const refOf = (ids: EntityIds): EntityRef => ({ kind: ids.kind, name: ids.name, libraryId: ids.libraryId, catalogId: ids.catalogId, spotifyId: ids.spotifyId });

	function localHeader(ids: EntityIds, world: EntityHeader['world']): EntityHeader {
		const filter = ownedFilter(ids);
		const header: EntityHeader = {
			ref: refOf(ids),
			imageUrl: null,
			coverTrackId: null,
			facts: {},
			genres: [],
			labels: [],
			artists: [],
			similar: [],
			collabs: [],
			activity: null,
			badges: [],
			reach: null,
			links: localLinks(ids),
			follow: null,
			owned: { count: filter ? deps.countTracks(filter) : 0, filter },
			world,
		};
		if (ids.kind === 'artist') {
			// A catalogue artist the library holds no id of: the library's
			// artist of that name is offered, not joined.
			if (!ids.libraryId) {
				const hint = deps.artistByName(ids.name);
				if (hint) header.owned.nameHint = { kind: 'artist', name: hint.name, libraryId: hint.id };
			}
		} else if (ids.kind === 'album' && ids.libraryId) {
			// An album the library holds is a release it has the facts of
			// (its own tags, the provider's album object): shown until — and
			// where — the catalogue does not say otherwise.
			const album = deps.albumSummary(ids.libraryId);
			if (album) {
				header.facts = { releaseDate: album.releaseDate, albumType: album.albumType };
				header.genres = album.genres.map((name) => ({ name }));
				header.artists = album.artists.map((a) => ({ ref: { kind: 'artist', name: a.name, libraryId: a.id } }));
				header.labels = album.label ? [{ ref: { kind: 'label', name: album.label } }] : [];
				header.coverTrackId = album.coverTrackId;
			}
			header.imageUrl = (raw.prepare(`select cover_url from album where id = ?`).get(ids.libraryId) as { cover_url: string | null } | undefined)?.cover_url ?? null;
		}
		return header;
	}

	// ── the catalogue's side ──────────────────────────────────────────────
	const catalogReason = (): EntityWorldReason | null => {
		const client = deps.catalog();
		if (!client) return 'signed_out';
		const s = client.status();
		if (!s.available) return s.reason === 'ok' ? 'server_off' : s.reason;
		return client.offersPages() ? null : 'old_server';
	};

	const off = (reason: EntityWorldReason, candidates?: EntityChip[]): EntityHeader['world'] => ({ available: false, reason, releaseCount: null, trackCount: null, ...(candidates ? { candidates } : {}) });

	const chip = (kind: EntityChip['ref']['kind'], c: { id: string; name: string; releases?: number }): EntityChip => ({ ref: { kind, name: c.name, catalogId: c.id }, ...(c.releases !== undefined ? { count: c.releases } : {}) });

	// The catalogue's account of the entity, beside what only the library
	// knows (which of its own entities this is, the files, its own store ids).
	function withCatalog(ids: EntityIds, b: CatalogBrowseResult, pagesOffered: boolean): EntityHeader {
		const full: EntityIds = { ...ids, catalogId: b.object.id };
		// A catalogue entity the library holds under a Spotify id it did not
		// name: found now that the object's handles are known.
		// The name shown is the library's where the library has the entity
		// (a label keeps the spelling the surface used: it is what Owned
		// matches), else the catalogue's.
		if (!full.libraryId && full.kind !== 'label') {
			const lib = libraryForObject(raw, full.kind, b.object);
			if (lib) Object.assign(full, { libraryId: lib.id, name: lib.name });
			else full.name = b.object.name;
		}
		if (!full.name) full.name = b.object.name;
		full.spotifyId ??= b.object.handles.find((h) => h.provider === 'spotify' && !h.id.includes('/'))?.id ?? null;
		rememberObject(raw, full, b.object.id, now());

		const header = localHeader(full, { available: pagesOffered, reason: pagesOffered ? 'ok' : 'old_server', releaseCount: b.releaseCount ?? (full.kind === 'album' ? 1 : null), trackCount: b.trackCount ?? null });
		if (full.kind === 'label') {
			// The catalogue's spelling may fold differently from the library's.
			const filter = ownedFilter(full, [searchFold(b.object.name)]);
			header.owned = { ...header.owned, filter, count: filter ? deps.countTracks(filter) : 0 };
		}
		header.imageUrl = b.object.coverUrl ?? header.imageUrl;
		if (b.genres?.length) header.genres = b.genres.slice(0, GENRES_MAX).map((g) => ({ name: g.name, ...(g.count !== undefined ? { count: g.count } : {}) }));
		header.links = mergeLinks(header.links, linksOf(b.object.handles));
		if (full.kind === 'artist') {
			// The labels it releases on, most releases first: the catalogue's
			// label objects, and the ones its releases only name (a store with
			// no label pages) — by name alone; that label's own page finds the
			// catalogue's object. A distributor's name is not a label.
			const named = (b.labelTexts ?? []).filter((l) => !isDistributor(l.name)).map((l): EntityChip => ({ ref: { kind: 'label', name: l.name }, count: l.releases }));
			header.labels = [...(b.labels ?? []).map((l) => chip('label', l)), ...named].sort((x, y) => (y.count ?? 0) - (x.count ?? 0)).slice(0, LABELS_MAX);
			header.similar = (b.similar ?? []).slice(0, CHIPS_MAX).map((a) => chip('artist', a));
			header.collabs = (b.collabs ?? []).map((a): EntityChip => ({ ref: { kind: 'artist', name: a.name, catalogId: a.id }, count: a.tracks }));
			header.activity = b.activity ?? null;
			header.badges = artistBadges(header.activity, b.releaseCount ?? null, now());
			header.reach = b.reach ?? null;
		} else if (full.kind === 'label') {
			if (b.artists?.length) header.artists = b.artists.slice(0, CHIPS_MAX).map((a) => chip('artist', a));
		} else {
			if (b.artists?.length) header.artists = b.artists.map((a) => chip('artist', { id: a.id, name: a.name }));
			if (b.labels?.length) header.labels = b.labels.map((l) => chip('label', { id: l.id, name: l.name }));
			else if (b.release?.labelText && !header.labels.length) header.labels = [{ ref: { kind: 'label', name: b.release.labelText } }];
			header.facts = { releaseDate: b.release?.date ?? header.facts.releaseDate ?? null, albumType: b.release?.type ?? header.facts.albumType ?? null };
		}
		// `watch` absent: a server from before it answered one — no follow state to show.
		if (full.kind !== 'album' && b.watch !== undefined) header.follow = { following: b.watch !== null, muted: b.watch?.muted ?? false };
		return header;
	}

	// An artist the catalogue holds no picture of: look one up at a store it
	// (or the library) knows the artist by, show it, and tell the catalogue —
	// so the next page, on any device, has it from there. False when the
	// lookup outlasted the wait: the header is cached briefly, and the next
	// ask finds the answer.
	async function withPicture(header: EntityHeader, b: CatalogBrowseResult | null, client: EntityCatalog): Promise<boolean> {
		if (header.imageUrl) return true;
		const held = (provider: string, id: string): boolean => !!b?.object.handles.some((h) => h.provider === provider && h.id === id);
		// The Spotify page the library knows the artist by, before any the
		// catalogue holds: its object can carry a namesake's page too.
		const ask = { spotify: header.ref.spotifyId ?? null };
		if (!ask.spotify) return true;
		const key = ask.spotify;
		let lookup = pictures.get(key);
		if (!lookup) {
			lookup = findArtistPicture(ask, fetchFn);
			pictures.set(key, lookup);
			// Up to the catalogue, once, when it is the catalogue's own store id
			// the picture was found by (it attaches to nothing else).
			void lookup.then((p) => {
				if (!p || !b || !held(p.provider, p.providerId)) return;
				return client.reportEnrichment(
					[{ provider: p.provider, kind: 'artist', providerId: p.providerId, name: b.object.name, facts: { coverUrl: p.url } }],
					`artist-picture:${p.provider}:${p.providerId}`,
				);
			}).catch((e: unknown) => elog.warn('artist picture not sent to the catalogue', undefined, e));
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const waited = await Promise.race([
			lookup.then((p) => ({ p })),
			new Promise<null>((res) => { timer = setTimeout(() => res(null), deps.pictureWaitMs ?? PICTURE_WAIT_MS); }),
		]);
		clearTimeout(timer);
		if (waited?.p) header.imageUrl = waited.p.url;
		return waited !== null;
	}

	async function fullHeader(ref: EntityRef, ids: EntityIds): Promise<{ header: EntityHeader; keep: Keep }> {
		const down = catalogReason();
		const client = deps.catalog();
		// Signed out or the server off: the library's side alone. An older
		// server still names the object (links, follow) — only World is off.
		if (!client || (down && down !== 'old_server')) {
			const reason = down ?? 'signed_out';
			// No catalogue to ask at all: the streaming service is the World
			// side. A catalogue that is only out of reach is asked again
			// instead (the page re-asks by itself).
			const streamed = reason === 'signed_out' ? await streamingHeader(ids, reason) : null;
			return streamed ?? { header: localHeader(ids, off(reason)), keep: 'none' };
		}
		try {
			let found = await identifyRemote(client, ids, ref);
			let b: CatalogBrowseResult | null = null;
			if (!('reason' in found)) {
				try {
					b = await client.browse(found.catalogId, { brief: true });
				} catch (e) {
					// The object a catalog_ref row remembered is gone (the id was
					// the library's memory, not the surface's): ask again by the
					// ids the library holds, instead of failing on a stale row.
					if (ref.catalogId || !ids.catalogId) throw e;
					ids = { ...ids, catalogId: null };
					found = await identifyRemote(client, ids, ref);
					if (!('reason' in found)) b = await client.browse(found.catalogId, { brief: true });
				}
			}
			if ('reason' in found || !b) {
				const miss = 'reason' in found ? found : { reason: 'unknown' as const };
				// Nobody followed it: shown from the streaming service meanwhile.
				const streamed = miss.reason === 'unknown' ? await streamingHeader(ids, 'unknown') : null;
				if (streamed) {
					if (ids.kind !== 'album') streamed.header.follow = { following: false, muted: false };
					return streamed;
				}
				const header = localHeader(ids, off(miss.reason, miss.candidates));
				// Followable by what the library holds, though the catalogue has no object yet.
				if (ids.kind !== 'album') header.follow = { following: false, muted: false };
				// An artist the catalogue does not know still has a face at the
				// store the library knows it by.
				if (ids.kind === 'artist') await withPicture(header, null, client);
				return { header, keep: 'partial' };
			}
			const header = withCatalog(ids, b, down === null);
			const settled = header.ref.kind === 'artist' ? await withPicture(header, b, client) : true;
			// An artist with no Reach score yet: opening it queued the reads for
			// one, which the catalogue scores within minutes — asked again soon.
			const unscored = header.ref.kind === 'artist' && !header.reach;
			return { header, keep: settled && !unscored ? 'whole' : 'partial' };
		} catch (e) {
			elog.warn('catalogue lookup for a page failed', { kind: ids.kind }, e);
			return { header: localHeader(ids, off('server_off')), keep: 'none' };
		}
	}

	// ── the streaming service's side ──────────────────────────────────────
	// The Spotify id of a library artist or album that carries none, found by
	// what the library holds of it: a track of the artist's (its ISRC, or its
	// title, credit and length) is found on Spotify and names the artist among
	// its credits; an album's own tracklist confirms the album. Never by the
	// name alone. Asked once a session, found or not.
	const evidence = new Map<string, Promise<string | null>>();
	function idByEvidence(ids: EntityIds): Promise<string | null> {
		if (!ids.libraryId || ids.kind === 'label' || !deps.spotifyMatch) return Promise.resolve(null);
		const key = `${ids.kind}:${ids.libraryId}`;
		const hit = evidence.get(key);
		if (hit) return hit;
		const read = (async (): Promise<string | null> => {
			const client = await deps.spotifyMatch!();
			// Not connected, or resting: not an answer — asked again next time.
			if (!client) throw new Error('spotify unavailable');
			if (ids.kind === 'album') {
				const album = deps.albumSummary(ids.libraryId!);
				if (!album) return null;
				const tracks = raw.prepare(`select title, duration as durationSec, isrc from track where album_id = ? and deleted_at is null order by disc_number, track_number limit 60`).all(ids.libraryId) as { title: string; durationSec: number | null; isrc: string | null }[];
				if (!tracks.length) return null;
				return (await findSpotifyAlbum(client, { title: album.title, artists: album.artists.map((a) => a.name), tracks }))?.album.id ?? null;
			}
			const fold = nameFold(ids.name);
			const rows = raw
				.prepare(
					`select t.title, t.artists, t.duration, t.isrc from track_artist ta join track t on t.id = ta.track_id
					where ta.artist_id = ? and ta.role is null and t.deleted_at is null
					order by (t.isrc is null), t.id limit ?`,
				)
				.all(ids.libraryId, EVIDENCE_TRACKS) as { title: string; artists: string; duration: number | null; isrc: string | null }[];
			for (const row of rows) {
				let credits: string[] = [];
				try {
					credits = (JSON.parse(row.artists) as { name?: string }[]).map((a) => a.name ?? '').filter(Boolean);
				} catch { /* a row whose credits do not parse is searched by the artist alone */ }
				const found = await findSpotifyTrack(client, { title: row.title, artists: credits.length ? credits : [ids.name], durationSec: row.duration, isrc: row.isrc });
				const artist = found?.artists.find((a) => nameFold(a.name) === fold);
				if (artist) return artist.id;
			}
			return null;
		})();
		evidence.set(key, read);
		return read.catch((e: unknown) => {
			evidence.delete(key);
			elog.debug('no streaming id found for a library entity', { kind: ids.kind, error: e instanceof Error ? e.message : String(e) });
			return null;
		});
	}

	// The streaming catalogue an entity of this kind can be read from, and
	// its id there. Labels have no page on a streaming service.
	async function onStream(ids: EntityIds): Promise<{ stream: StreamingCatalog; id: string } | null> {
		const stream = deps.streaming?.() ?? null;
		if (!stream || stream.service !== 'spotify' || ids.kind === 'label') return null;
		const id = ids.spotifyId ?? (await idByEvidence(ids));
		return id ? { stream, id } : null;
	}

	// The header of an entity the catalogue does not know (`reason`
	// 'unknown') or cannot be asked about, from the streaming service. Null
	// when the service has nothing to show for it either. An artist the
	// library names without any id comes back with the service's artists of
	// that name as candidates — offered, never assumed (namesakes).
	async function streamingHeader(ids: EntityIds, reason: EntityWorldReason): Promise<{ header: EntityHeader; keep: Keep } | null> {
		try {
			const on = await onStream(ids);
			if (!on) {
				const stream = deps.streaming?.() ?? null;
				const fold = nameFold(ids.name);
				if (!stream || ids.kind !== 'artist' || !fold) return null;
				const same = (await stream.search(ids.name)).filter((h) => h.kind === 'artist' && nameFold(h.name) === fold).slice(0, CANDIDATES_MAX);
				if (!same.length) return null;
				const candidates: EntityChip[] = same.map((h) => ({ ref: { kind: 'artist', name: h.name, ...(stream.service === 'spotify' ? { spotifyId: h.id } : {}) }, ...(h.detail ? { detail: h.detail } : {}) }));
				return { header: localHeader(ids, off(reason, candidates)), keep: 'partial' };
			}
			const { stream, id } = on;
			const full: EntityIds = { ...ids, spotifyId: id };
			const world = (releaseCount: number | null, trackCount: number | null): EntityHeader['world'] => ({ available: true, reason: 'ok', releaseCount, trackCount, via: stream.service });
			if (full.kind === 'artist') {
				const [artist, listing] = await Promise.all([stream.artist(id), stream.listing(id)]);
				if (!artist) return null;
				// The library's spelling where the library has the artist.
				if (!full.libraryId) full.name = artist.name;
				const header = localHeader(full, world(listing.total, null));
				header.imageUrl = artist.imageUrl;
				header.genres = artist.genres.slice(0, GENRES_MAX).map((name) => ({ name }));
				header.links = mergeLinks(header.links, [{ source: stream.service, sourceId: id, url: artist.url }]);
				// The first page's tracklists, on their way before the list asks.
				void stream.releases(listing.releases.slice(0, STREAM_PAGE).map((c) => c.providerId)).catch(() => {});
				return { header, keep: 'partial' };
			}
			const claim = (await stream.releases([id])).get(id);
			if (!claim) return null;
			if (!full.libraryId) full.name = claim.name;
			const header = localHeader(full, world(1, claim.recordings?.length ?? claim.facts?.trackCount ?? null));
			header.imageUrl = claim.facts?.coverUrl ?? header.imageUrl;
			header.facts = { releaseDate: claim.facts?.releaseDate ?? header.facts.releaseDate ?? null, albumType: claim.facts?.releaseType ?? header.facts.albumType ?? null };
			if (claim.artists?.length) header.artists = claim.artists.map((a) => ({ ref: { kind: 'artist', name: a.name, spotifyId: a.providerId } }));
			if (claim.facts?.labelText && !header.labels.length) header.labels = [{ ref: { kind: 'label', name: claim.facts.labelText } }];
			header.links = mergeLinks(header.links, [{ source: stream.service, sourceId: id, url: claim.url ?? `https://open.spotify.com/album/${id}` }]);
			return { header, keep: 'partial' };
		} catch (e) {
			elog.info('the streaming service did not answer for a page', { kind: ids.kind, error: e instanceof Error ? e.message : String(e) });
			return null;
		}
	}

	// A page of the entity's releases as the streaming service lists them,
	// in the catalogue's page shape. Null: nothing to read it from.
	async function streamPage(ids: EntityIds, cursor: string | undefined): Promise<CatalogTracksResult | null> {
		const on = await onStream(ids);
		if (!on) return null;
		const { stream, id } = on;
		if (ids.kind === 'album') {
			const claim = (await stream.releases([id])).get(id);
			return claim ? { object: { id: streamObjectId(stream.service, id), kind: 'release', name: claim.name }, redirectedFrom: null, releases: [provisionalRelease(claim)], nextCursor: null } : null;
		}
		const listing = await stream.listing(id);
		const offset = cursor?.startsWith(STREAM_CURSOR) ? Number(cursor.slice(STREAM_CURSOR.length)) || 0 : 0;
		const slice = listing.releases.slice(offset, offset + STREAM_PAGE);
		const full = await stream.releases(slice.map((c) => c.providerId));
		const next = offset + STREAM_PAGE;
		return {
			object: { id: streamObjectId(stream.service, id), kind: 'artist', name: ids.name },
			redirectedFrom: null,
			// A release the service no longer hands out in full keeps its place, without rows.
			releases: slice.map((c) => provisionalRelease(full.get(c.providerId) ?? c)),
			nextCursor: next < listing.releases.length ? `${STREAM_CURSOR}${next}` : null,
		};
	}

	// ── World tracks ──────────────────────────────────────────────────────
	const cloudPage = (catalogId: string, cursor: string | undefined): Promise<CatalogTracksResult> => {
		const key = `${catalogId}|${cursor ?? ''}`;
		const hit = pages.get(key);
		if (hit && now() - hit.at < PAGE_TTL_MS) return hit.page;
		const page = deps.catalog()!.tracks(catalogId, cursor);
		pages.set(key, { at: now(), page });
		page.catch(() => { if (pages.get(key)?.page === page) pages.delete(key); });
		// Oldest out: a Map iterates in insertion order.
		while (pages.size > PAGE_CACHE_MAX) pages.delete(pages.keys().next().value!);
		return page;
	};

	const streamId = (handles: readonly CatalogHandle[], provider: 'spotify' | 'tidal'): string | null => handles.find((h) => h.provider === provider && !h.id.includes('/'))?.id ?? null;

	function toPage(result: CatalogTracksResult): EntityTracksPage {
		const probes: OwnershipProbe[] = [];
		for (const r of result.releases) {
			for (const t of r.tracks) {
				probes.push({ recordingId: t.id, releaseId: r.id, releaseTitle: r.title, releaseDate: r.date, isrc: t.isrc, spotifyId: streamId(t.handles, 'spotify'), tidalId: streamId(t.handles, 'tidal') });
			}
		}
		// Ownership is read every time: the library changes under a cached page.
		const matches = matchLibraryTracks(raw, probes);
		let i = 0;
		return {
			albums: result.releases.map((r) => ({
				id: r.id,
				title: r.title,
				date: r.date,
				type: r.type,
				coverUrl: r.coverUrl,
				label: r.labels[0] ? { id: r.labels[0].id, name: r.labels[0].name } : r.labelText ? { id: null, name: r.labelText } : null,
				artists: r.artists,
				genres: r.genres,
				trackCount: r.trackCount,
				appearance: r.appearance,
				links: linksOf(r.handles),
			})),
			tracks: result.releases.flatMap((r) =>
				r.tracks.map((t) => {
					const probe = probes[i]!;
					const match = matches[i++] ?? null;
					const patch = deps.patchOf?.(t.id);
					return {
						recordingId: t.id,
						releaseId: r.id,
						title: t.title,
						artists: t.artists.length ? t.artists : r.artists,
						position: t.position,
						disc: t.disc,
						durationSec: t.durationSec,
						isrc: t.isrc,
						bpm: t.bpm ?? patch?.bpm ?? null,
						keyCamelot: (t.key ? keyToCamelot(t.key) : null) ?? patch?.keyCamelot ?? null,
						genre: t.genres[0] ?? patch?.genre ?? r.genres[0] ?? null,
						label: patch?.label ?? null,
						links: linksOf(t.handles),
						streamIds: { ...patch?.streamIds, ...(probe.spotifyId ? { spotify: probe.spotifyId } : {}), ...(probe.tidalId ? { tidal: probe.tidalId } : {}) },
						libraryTrackId: match?.libraryTrackId ?? null,
						libraryPrimary: match?.primary ?? false,
					};
				}),
			),
			nextCursor: result.nextCursor,
			template: blankTrack(),
		};
	}

	return {
		async page(asked, opts) {
			const ref = normalizeEntityRef(asked);
			const ids = identifyLocal(raw, ref);
			if (opts?.localOnly) {
				const down = catalogReason();
				// Signed out, the streaming service is who gets asked.
				const elsewhere = down === 'signed_out' && ids.kind !== 'label' && !!deps.streaming?.();
				return localHeader(ids, off(down && down !== 'old_server' && !elsewhere ? down : 'pending'));
			}
			// Keyed by what the library made of the ref, so two surfaces naming
			// one artist differently share the answer. `within` and the name
			// matter only while nothing else names the entity.
			const named = ids.libraryId || ids.catalogId || ids.spotifyId;
			const key = named ? keyOf(ids) : `${keyOf(ids)}|${ref.within?.catalogId ?? ''}`;
			const hit = headers.get(key);
			if (hit && now() - hit.at < KEEP_MS[hit.keep]) {
				// The cached answer's catalogue facts with the library's counts as they are now.
				const cached = await hit.header;
				return { ...cached, owned: { ...cached.owned, count: cached.owned.filter ? deps.countTracks(cached.owned.filter) : 0 } };
			}
			const read = fullHeader(ref, ids);
			// `whole` while it is being read: a second ask joins the first.
			const entry: { at: number; keep: Keep; header: Promise<EntityHeader> } = { at: now(), keep: 'whole', header: read.then((r) => r.header) };
			void read.then((r) => {
				entry.keep = r.keep;
				// Also under what the lookup found it to be (a catalogue artist
				// that turned out to be a library one): the ref the page hands
				// back finds this answer.
				const found = keyOf({ kind: r.header.ref.kind, name: r.header.ref.name, libraryId: r.header.ref.libraryId ?? null, catalogId: r.header.ref.catalogId ?? null, spotifyId: r.header.ref.spotifyId ?? null });
				if (r.keep === 'whole' && !headers.has(found)) headers.set(found, entry);
			});
			headers.set(key, entry);
			return entry.header;
		},

		async tracks(asked, opts) {
			const ref = normalizeEntityRef(asked);
			const client = deps.catalog();
			const down = catalogReason();
			const ids = identifyLocal(raw, ref);
			// A later page of a list that began at the streaming service stays
			// there, whatever the catalogue has learned since.
			const streamed = opts?.cursor?.startsWith(STREAM_CURSOR) ?? false;
			let unknown = false;
			if (client && !down && !streamed) {
				const found = await identifyRemote(client, ids, ref);
				if (!('reason' in found)) {
					const result = await cloudPage(found.catalogId, opts?.cursor);
					deps.onPage?.(found.catalogId, result);
					return toPage(result);
				}
				unknown = found.reason === 'unknown';
			}
			// Unknown to the catalogue, or no catalogue to ask: the streaming service's.
			if (streamed || unknown || !client || down === 'signed_out') {
				const result = await streamPage(ids, opts?.cursor);
				if (result) return toPage(result);
			}
			throw new Error(
				down === 'old_server' ? 'Curator Cloud needs an update before it can list the catalogue here.'
					: down === 'server_off' ? 'The catalogue is not reachable right now.'
						: !client || down ? 'Sign in to Curator Cloud to browse the catalogue.'
							: 'The catalogue does not know this one yet.',
			);
		},

		forget() {
			headers.clear();
			pages.clear();
		},

		async loaded(catalogId) {
			const held = [...pages].filter(([key, p]) => key.startsWith(`${catalogId}|`) && now() - p.at < PAGE_TTL_MS).map(([, p]) => p.page);
			return (await Promise.allSettled(held)).flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
		},

		drop(catalogId) {
			headers.clear();
			if (catalogId) for (const key of [...pages.keys()]) if (key.startsWith(`${catalogId}|`)) pages.delete(key);
		},

		rows: toPage,
	};
}
