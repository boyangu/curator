import { z } from 'zod';
import { SOURCES, TRACK_STATES, PLAYLIST_SOURCES } from './enums.js';
import type { Track } from './schema.js';

// ─── Wire-format zod schemas for IPC / HTTP boundaries ──────────────────────
// These mirror the Drizzle row shapes but are validated at the boundary.

export const ZTrackArtist = z.object({
	name: z.string(),
	role: z.enum(['main', 'featured', 'remixer']).optional(),
});
export type ZTrackArtistT = z.infer<typeof ZTrackArtist>;

export const ZTrack = z.object({
	id: z.string(),
	isrc: z.string().nullable(),
	mbid: z.string().nullable(),
	title: z.string(),
	artists: z.array(ZTrackArtist),
	albumTitle: z.string().nullable(),
	releaseDate: z.string().nullable(),
	duration: z.number().nullable(),
	bpm: z.number().nullable(),
	keyCamelot: z.string().nullable(),
	genre: z.string().nullable(),
	label: z.string().nullable(),
	copyright: z.string().nullable(),
	explicit: z.boolean().nullable(),
	state: z.enum(TRACK_STATES),
	stateChangedAt: z.date().nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
});
export type ZTrackT = z.infer<typeof ZTrack>;

export const ZTrackFilter = z.object({
	state: z.enum(TRACK_STATES).optional(),
	// Fetch specific tracks by id — the renderer's single-row patch path
	// (e.g. repainting one row after its analysis completes) uses this so a
	// bursty backend event doesn't have to refetch the whole page.
	ids: z.array(z.string()).optional(),
	playlistId: z.string().optional(),
	// Union of multiple playlists — used to aggregate tracks across a
	// Rekordbox folder's descendant playlists. Server dedupes via GROUP BY
	// track.id so a track appearing in N selected playlists still shows once.
	playlistIds: z.array(z.string()).optional(),
	source: z.enum(SOURCES).optional(),
	// Restrict to tracks whose `source='local'` source_link lives under this
	// library folder's path. The per-folder "Analyze…" scope in Settings →
	// Library is its caller; the tracklist has no folder view.
	libraryFolderId: z.string().optional(),
	// Restrict to tracks carrying a specific tag (e.g. system tags
	// "interested" / "basket", or user-created tags later).
	tagId: z.string().optional(),
	// AND-intersection of `#name` MUSTs from the omnibar / filterbox query
	// grammar. Each clause is satisfied (OR) if a track carries any of its
	// tag ids OR sits in any playlist whose ascii-folded name matches. AND
	// across clauses. Playlist names are pre-folded (searchFold) so SQL can
	// hit `playlist.name_ascii` directly. The sidebar Interested/Basket
	// views keep using `tagId` (singular) — a separate path.
	nameClauses: z.array(z.object({
		tagIds: z.array(z.string()),
		playlistNamesAscii: z.array(z.string()),
	})).optional(),
	bpmMin: z.number().optional(),
	bpmMax: z.number().optional(),
	// Numeric range bounds on indexed track scalars (rating, duration, the
	// analyzer metrics). Pushed down from the query grammar's `cmp` terms
	// (rating>=4, diss<0.3, …) so the SQL candidate set is already narrow —
	// without this, a scalar comparison only filters the fetched page and
	// recall silently degrades past the fetch limit. Bounds are INCLUSIVE;
	// the in-memory matchTrack pass enforces exclusivity when the user typed
	// a strict bound (extractSqlPrefilter marks those queries incomplete).
	// NULL column values never satisfy a bound — same semantics as the
	// in-memory pass, where missing analyzer data fails every comparison.
	scalarBounds: z.array(z.object({
		field: z.enum([
			'rating', 'duration', 'playCount', 'dropCount', 'breakdownCount',
			'loudnessRangeLu', 'dissonance', 'density',
			'brightness', 'power', 'dynamicComplexity',
			'introLengthSec', 'outroLengthSec', 'firstDropSec',
		]),
		min: z.number().optional(),
		max: z.number().optional(),
	})).optional(),
	keyCamelot: z.string().optional(),
	genre: z.string().optional(),
	label: z.string().optional(),
	search: z.string().optional(),
	// Source membership — the SQL side of a track's `sources` set. Restrict to
	// tracks that HAVE at least one of the given sources (a string, or an
	// any-of array) or LACK a given one. 'rekordbox' resolves to rekordbox_link
	// (rekordbox tracks are matched to a local file on import and carry no
	// source='rekordbox' source_link); every other value to source_link.
	// Drives the Rekordbox tab root (hasSource ['rekordbox', 'local']), the
	// grammar's `source:` terms, and the SRC column-header menu ("Show Local
	// Files", "Show Unmatched Tidal/Beatport"). Compiles to EXISTS / NOT EXISTS,
	// so it works windowed. String, not enum(SOURCES): source_link carries
	// enrichment sources (e.g. 'beatport') that aren't tab sources.
	hasSource: z.union([z.string(), z.array(z.string())]).optional(),
	lacksSource: z.string().optional(),
	// Hide the account's tracks this device holds no source of (remote rows,
	// track.remoteOnly: "not on this device"). Off by default — every device
	// shows the account's whole library, the rows marked.
	hideRemote: z.boolean().optional(),
	// Artist scope by Curator artist id — OR within the array. Compiles to
	// EXISTS on track_artist (indexed), so the "Artist: X" JIT scope is a
	// complete SQL pushdown rather than an in-memory name match over the
	// fetched page.
	artistIds: z.array(z.string()).optional(),
	// Album scope by Curator album id — OR within the array, merge aliases
	// followed. Indexed `track.album_id IN (…)`, so "Album: X" is a complete
	// SQL pushdown like the artist scope.
	albumIds: z.array(z.string()).optional(),
	// AI-engine similarity scope (apps/mir): the k tracks that sound most like
	// the seed tracks and/or match a text description, ranked by the engine's
	// embedding model. Resolved async in CoreService before the SQL builders
	// run (they only ever see the resulting `ids`); every other filter field
	// restricts the CANDIDATES, so "similar within this playlist" ranks inside
	// the playlist rather than filtering a global top-k down to a few rows.
	similarTo: z.object({
		seeds: z.array(z.string()).max(50).optional(),
		text: z.string().max(500).optional(),
		model: z.string().optional(),
		k: z.number().int().min(1).max(500).optional(),
	}).optional(),
});
export type ZTrackFilterT = z.infer<typeof ZTrackFilter>;
export type ScalarBoundField = NonNullable<ZTrackFilterT['scalarBounds']>[number]['field'];

export const ZTrackSort = z.object({
	// 'match' orders a similarTo scope by similarity score (best first on desc).
	column: z.enum(['match', 'index', 'title', 'artist', 'album', 'releaseDate', 'label', 'genre', 'bpm', 'keyCamelot', 'duration', 'createdAt', 'rating', 'loudnessRangeLu', 'dissonance', 'density', 'brightness', 'power', 'dynamicComplexity', 'introLengthSec', 'outroLengthSec', 'firstDropSec']),
	dir: z.enum(['asc', 'desc']),
});
export type ZTrackSortT = z.infer<typeof ZTrackSort>;

// ─── Windowed track listing (server-paged, lazy) ────────────────────────────
// Every track-list surface (playlist, folder, tag view, omnibox/pinned search,
// all-items) is served as a 1000-row window, fetched on demand. Mirrors the
// feed pager (FeedPage) so the contract is identical in-process, in the
// core-sidecar, and over cloud HTTP — only the transport adapter changes.
export const ZTrackPageReq = z.object({
	// Page size. Defaults to 1000 server-side; clamped to a sane max.
	limit: z.number().optional(),
	// Phase 1 paging: page index × limit. The renderer maps the virtualizer's
	// visible range to page offsets and fetches only the missing pages.
	offset: z.number().optional(),
	// Reserved for Phase 2 keyset paging over the remote catalog. Ignored while
	// `offset` is used; kept on the contract so adopting it needs no reshape.
	cursor: z.string().nullable().optional(),
});
export type ZTrackPageReqT = z.infer<typeof ZTrackPageReq>;

export interface TrackPage {
	items: Track[];
	// Total rows matching (filter) — drives the virtualizer's scroll height.
	// Computed with the same WHERE as the page so a page and its total agree.
	total: number;
	// Keyset cursor for the next page; null under Phase 1 offset paging.
	nextCursor: string | null;
}

export const ZPlaylist = z.object({
	id: z.string(),
	source: z.enum(PLAYLIST_SOURCES),
	sourceId: z.string(),
	url: z.string().nullable(),
	name: z.string(),
	description: z.string().nullable(),
	ownerName: z.string().nullable(),
	ownerId: z.string().nullable(),
	coverUrl: z.string().nullable(),
	trackCount: z.number().nullable(),
	followers: z.number().nullable(),
	isCollaborative: z.boolean().nullable(),
	isPublic: z.boolean().nullable(),
	lastSyncedAt: z.date().nullable(),
	syncStatus: z.enum(['pending', 'syncing', 'synced', 'error']),
	syncError: z.string().nullable(),
	syncCursor: z.string().nullable(),
	mark: z.string().nullable(),
	isFavorite: z.boolean(),
	isHidden: z.boolean(),
	createdAt: z.date(),
	updatedAt: z.date(),
});
export type ZPlaylistT = z.infer<typeof ZPlaylist>;

export const ZSyncStatus = z.object({
	spotify: z.object({
		connected: z.boolean(),
		lastSync: z.date().nullable(),
		status: z.enum(['idle', 'syncing', 'error']),
		message: z.string().nullable(),
	}),
	tidal: z.object({
		connected: z.boolean(),
		lastSync: z.date().nullable(),
		status: z.enum(['idle', 'syncing', 'error']),
		message: z.string().nullable(),
	}),
});
export type ZSyncStatusT = z.infer<typeof ZSyncStatus>;

export const ZStateCounts = z.object({
	feed: z.number(),
	backlog: z.number(),
	progress: z.number(),
	purchased: z.number(),
	unsorted: z.number(),
});
export type ZStateCountsT = z.infer<typeof ZStateCounts>;
// ─── Artists (library artist entities) ──────────────────────────────────────
// Read shape for the Artists browser, the edit-modal autocomplete and the
// chip → scope path. `trackCount` counts live (non-deleted) tracks only.
export interface ArtistSummary {
	id: string;
	name: string;
	nameAscii: string;
	trackCount: number;
	mergedInto: string | null;
	nameCuratedAt: Date | null;
}
export interface ArtistLink {
	source: string;
	sourceId: string;
	url: string | null;
}
// ─── Albums (library release entities) ──────────────────────────────────────
// Read shape for the track list's album group headers. Member-derived
// fields (label fallback, genres, trackCount, coverTrackId) are computed
// over live tracks at read time, so they never drift from the library.
export interface AlbumSummary {
	id: string;
	title: string;
	// Album artists in credit order; empty when `various`.
	artists: Array<{ id: string; name: string }>;
	various: boolean;
	releaseDate: string | null;
	// The provider's release label, else the most common member label.
	label: string | null;
	// Distinct member genres, most common first (≤ 3).
	genres: string[];
	albumType: string | null;
	totalTracks: number | null;
	// Live library tracks on this release.
	trackCount: number;
	// A member whose cover the `curator-cover://<trackId>` protocol can serve
	// (one with a cover URL first) — the album thumb.
	coverTrackId: string | null;
}
// A pair identity can't decide: a bare name and the same name with a
// bracketed disambiguator ("Maz" / "Maz (EG)"). The user merges or
// dismisses each one in the Artists folder's Suggested merges review.
export interface ArtistMergeSuggestion {
	a: ArtistSummary;
	b: ArtistSummary;
	signal: 'suffix';
	suggestedKeepId: string;
}
// Which tracks an artist's count is over: everything, or the tracks carrying
// at least one of these sources — the same membership vocabulary as
// TrackFilter.hasSource ('rekordbox' = rekordbox_link). Mirrors how the
// tracklist tabs scope their rows: a provider's source_link for Spotify /
// Tidal, rekordbox ∪ local for the Rekordbox tab.
export type ArtistScope = { sources: ('spotify' | 'tidal' | 'local' | 'rekordbox')[] };
export interface ArtistListOpts {
	search?: string;
	limit?: number;
	sort?: 'count' | 'name';
	scope?: ArtistScope;
}
