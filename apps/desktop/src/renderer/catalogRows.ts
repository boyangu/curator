// Catalogue rows — Global Catalog recordings standing in the track list on an
// entity page's World side, beside the library's own rows.
//
// The list renders `Track`s, so a recording the library does not hold is laid
// over an empty track (core's template) and marked `catalog.synthetic`. It
// looks like a row and plays through the user's streaming service, but it is
// not in the library: nothing that tags, rates, edits, drags, deletes or
// analyses may touch it. `isCatalogRow` is the one test for that, read by the
// row factory, the command table, the player and the selection plumbing —
// the same shape as remoteRows.ts for the other kind of row that is not
// quite a local track.
//
// A recording the library DOES hold shows as the library's own row (tags,
// rating, sources), carrying the same decoration with `synthetic` false so
// it files under the catalogue's release beside its siblings.
//
// Pure (types-only imports besides the fold): tested without a DOM.

import { searchFold, type AlbumSummary, type EntityRef, type EntityRowPatch, type EntityTracksPage, type EntityWorldAlbum, type EntityWorldTrack, type StreamingService, type Track } from '@curator/shared';

export const CATALOG_ROW_PREFIX = 'catalog:';
// Artist chips on a catalogue row carry the catalogue's artist id under this
// prefix in `artistIds` (a library row's are library artist ids).
export const CATALOG_ARTIST_PREFIX = 'catalog:';

export const CATALOG_ROW_REASON = 'In the catalogue, not in your library';

export const isCatalogRow = (t: Pick<Track, 'catalog'>): boolean => !!t.catalog?.synthetic;
export const anyCatalogRow = (tracks: readonly Pick<Track, 'catalog'>[]): boolean => tracks.some(isCatalogRow);
// An id as a library track id: never a synthetic row's.
export const isLibraryTrackId = (id: string): boolean => !id.startsWith(CATALOG_ROW_PREFIX);

export const catalogArtistId = (artistId: string | null | undefined): string | null =>
	artistId?.startsWith(CATALOG_ARTIST_PREFIX) ? artistId.slice(CATALOG_ARTIST_PREFIX.length) : null;

// A row read from the streaming service, before the catalogue has an object
// for it (core entity/streaming.ts), carries the service's own ids where a
// catalogue row carries the catalogue's, as "spotify_<id>". A ref built off
// such a row names the entity by Spotify, not by a catalogue object.
const STREAM_REF = /^spotify_(.+)$/;
export function normalizeCatalogRef(ref: EntityRef): EntityRef {
	const m = ref.catalogId ? STREAM_REF.exec(ref.catalogId) : null;
	return m ? { ...ref, catalogId: null, spotifyId: ref.spotifyId ?? m[1]! } : ref;
}

// Where a catalogue row plays: its id on the user's primary streaming
// service. Null: the catalogue has no page for it there.
export function catalogStreamId(t: Pick<Track, 'catalog'>, primary: StreamingService | null): string | null {
	return primary ? t.catalog?.streamIds[primary] ?? null : null;
}

// Thrown by the player for a catalogue row with nowhere to play.
export class CatalogRowPlayError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CatalogRowPlayError';
	}
}

const STREAM_SOURCES = ['spotify', 'tidal'] as const;

// `held`: the library track this recording is, when the row repeats it.
function syntheticRow(template: Track, t: EntityWorldTrack, album: EntityWorldAlbum, held?: Track): Track {
	return {
		...template,
		// One recording sits on several releases: the release is part of the row's identity.
		id: `${CATALOG_ROW_PREFIX}${t.releaseId}:${t.recordingId}`,
		recordingId: t.recordingId,
		title: t.title,
		artists: t.artists.map((a) => ({ name: a.name, ...(a.role === 'remixer' || a.role === 'featured' ? { role: a.role } : {}) })),
		artistIds: t.artists.map((a) => `${CATALOG_ARTIST_PREFIX}${a.id}`),
		albumTitle: album.title,
		releaseDate: album.date,
		label: album.label?.name ?? t.label ?? null,
		genre: t.genre,
		coverUrl: album.coverUrl,
		// Whole seconds, like a library track's (a store's length can carry a fraction).
		duration: t.durationSec == null ? null : Math.round(t.durationSec),
		isrc: t.isrc,
		bpm: t.bpm,
		keyCamelot: t.keyCamelot,
		trackNumber: t.position,
		discNumber: t.disc,
		// No sources of its own: the catalogue's streaming pages show as hollow
		// pips. A repeat of a library track shows that track's (the file is
		// owned whichever release the row sits on).
		sources: held?.sources ?? [],
		claimSources: STREAM_SOURCES.filter((s) => t.streamIds[s]),
		catalog: decoration(t, album, held?.id ?? null),
	};
}

// `repeats`: the library track a synthetic row repeats (null: owned by
// nobody); undefined for the library's own row.
function decoration(t: EntityWorldTrack, album: EntityWorldAlbum, repeats?: string | null): NonNullable<Track['catalog']> {
	return {
		recordingId: t.recordingId,
		releaseId: t.releaseId,
		synthetic: repeats !== undefined,
		libraryTrackId: repeats ?? null,
		streamIds: t.streamIds,
		links: t.links,
		albumArtistId: album.artists[0]?.id ?? null,
		labelId: album.label?.id ?? null,
	};
}

// What this desktop's lookups found for a recording (core entity/work.ts),
// laid over its row: the facts the row lacked, and where it plays. The same
// row back when nothing changes. A library row is the library's own — its
// facts are not the catalogue's to fill — so it comes back as it is.
export function patchRow(row: Track, patch: EntityRowPatch): Track {
	const c = row.catalog;
	if (!c?.synthetic || c.recordingId !== patch.recordingId) return row;
	const streamIds = { ...patch.streamIds, ...c.streamIds };
	const next: Track = {
		...row,
		bpm: row.bpm ?? patch.bpm ?? null,
		keyCamelot: row.keyCamelot ?? patch.keyCamelot ?? null,
		// A lookup's genre is the track's own; the row's was its release's.
		genre: patch.genre ?? row.genre,
		label: row.label ?? patch.label ?? null,
		claimSources: STREAM_SOURCES.filter((s) => streamIds[s]),
		catalog: { ...c, streamIds },
	};
	const same = next.bpm === row.bpm && next.keyCamelot === row.keyCamelot && next.genre === row.genre && next.label === row.label
		&& STREAM_SOURCES.every((s) => streamIds[s] === c.streamIds[s]);
	return same ? row : next;
}

// A page of the catalogue as list rows, in the catalogue's order (releases
// newest first, each tracklist in order). `library`: the library tracks the
// page's recordings matched (by id). The row that stands for a library track
// (`libraryPrimary`) is the library's own; a repeat of it on another release
// stays a catalogue row (one id per row) that shows the track's sources and
// "In Library" like the row it repeats.
export function toRows(page: EntityTracksPage, library: ReadonlyMap<string, Track>): Track[] {
	const albums = new Map(page.albums.map((a) => [a.id, a]));
	const out: Track[] = [];
	for (const t of page.tracks) {
		const album = albums.get(t.releaseId);
		if (!album) continue;
		const held = t.libraryTrackId ? library.get(t.libraryTrackId) : undefined;
		out.push(
			held && t.libraryPrimary
				// The catalogue's place for it on this release; everything else is the
				// library's — but where the library has no BPM, key, genre or label
				// (a synced row nobody analysed yet), the catalogue's fills it: the
				// library's own value, once it has one, always stands.
				? {
						...held,
						trackNumber: t.position ?? held.trackNumber,
						discNumber: t.disc ?? held.discNumber,
						albumTitle: album.title,
						bpm: held.bpm ?? t.bpm,
						keyCamelot: held.keyCamelot ?? t.keyCamelot,
						genre: held.genre ?? t.genre,
						label: held.label ?? album.label?.name ?? t.label ?? null,
						catalog: decoration(t, album),
					}
				: syntheticRow(page.template, t, album, held),
		);
	}
	return out;
}

// The library tracks a page's rows need read for `toRows`.
export const heldTrackIds = (page: EntityTracksPage): string[] => [...new Set(page.tracks.map((t) => t.libraryTrackId).filter((id): id is string => !!id))];

// A catalogue release as the album group header reads one.
export function albumSummaryOf(a: EntityWorldAlbum): AlbumSummary {
	return {
		id: `${CATALOG_ROW_PREFIX}${a.id}`,
		title: a.title,
		artists: a.artists.map((x) => ({ id: `${CATALOG_ARTIST_PREFIX}${x.id}`, name: x.name })),
		various: false,
		releaseDate: a.date,
		label: a.label?.name ?? null,
		genres: a.genres.slice(0, 3),
		albumType: a.type,
		totalTracks: a.trackCount,
		trackCount: a.trackCount,
		coverTrackId: null,
		coverUrl: a.coverUrl,
	};
}

// ── In-memory sort ─────────────────────────────────────────────────────────
// The library's lists are sorted by the database; a catalogue page is rows in
// memory, sorted here on the same header clicks. Columns the catalogue has no
// value for (analysis metrics, rating, added) keep the catalogue's order.

type Sort = { column: string; dir: 'asc' | 'desc' };

const text = (v: string | null | undefined): string => searchFold(v ?? '');
const mainArtist = (t: Track): string => text((t.artists ?? []).find((a) => a.role !== 'remixer' && a.role !== 'featured')?.name ?? t.artists?.[0]?.name);

const KEYS: Record<string, (t: Track) => string | number | null> = {
	title: (t) => text(t.title),
	artist: mainArtist,
	album: (t) => text(t.albumTitle),
	releaseDate: (t) => t.releaseDate ?? null,
	label: (t) => (t.label ? text(t.label) : null),
	genre: (t) => (t.genre ? text(t.genre) : null),
	bpm: (t) => t.bpm ?? null,
	keyCamelot: (t) => t.keyCamelot ?? null,
	duration: (t) => t.duration ?? null,
};

export const canSortCatalogRows = (column: string): boolean => column in KEYS || column === 'index';

// Stable; rows without a value sort last in either direction (as the
// database sorts NULLs for the library's lists). `index` is the catalogue's
// own order, reversed on desc.
export function sortRows(rows: readonly Track[], sort: Sort): Track[] {
	if (sort.column === 'index') return sort.dir === 'asc' ? [...rows] : [...rows].reverse();
	const key = KEYS[sort.column];
	if (!key) return [...rows];
	const sign = sort.dir === 'asc' ? 1 : -1;
	return rows
		.map((t, i) => ({ t, i, k: key(t) }))
		.sort((a, b) => {
			if (a.k === null || a.k === '') return b.k === null || b.k === '' ? a.i - b.i : 1;
			if (b.k === null || b.k === '') return -1;
			const c = typeof a.k === 'number' && typeof b.k === 'number' ? a.k - b.k : String(a.k).localeCompare(String(b.k));
			return c !== 0 ? c * sign : a.i - b.i;
		})
		.map((x) => x.t);
}
