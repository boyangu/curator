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
			'prodLufs', 'prodPlr', 'prodCutoffHz', 'prodSubCorr', 'prodClipPct', 'prodScore', 'audioboxPq',
		]),
		min: z.number().optional(),
		max: z.number().optional(),
	})).optional(),
	keyCamelot: z.string().optional(),
	genre: z.string().optional(),
	label: z.string().optional(),
	// Label scope by folded name (searchFold values, OR within the array) —
	// the indexed `label_ascii` column, so a label page lists every spelling
	// that folds alike and a big label is one index range, not a LIKE scan.
	labelFolds: z.array(z.string()).optional(),
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
	column: z.enum(['match', 'index', 'title', 'artist', 'album', 'releaseDate', 'label', 'genre', 'bpm', 'keyCamelot', 'duration', 'createdAt', 'rating', 'loudnessRangeLu', 'dissonance', 'density', 'brightness', 'power', 'dynamicComplexity', 'introLengthSec', 'outroLengthSec', 'firstDropSec', 'prodLufs', 'prodPlr', 'prodCutoffHz', 'prodScore', 'audioboxPq']),
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
// Who "Open Artist in ▸" is about, by what the surface knows: a library
// artist id (track rows, the Artists folder), or a name with the ids the feed
// carries (a Spotify artist id, a catalogue object id).
export interface ArtistPagesTarget {
	name: string;
	artistId?: string | null;
	spotifyId?: string | null;
	catalogId?: string | null;
}
// The artist's store pages (one per store, direct URLs) and the library
// artist of that id or name, when the library holds one.
export interface ArtistPages {
	// The Global Catalog's object for the artist, when it answered: what
	// "Help connect…" opens on.
	catalogId: string | null;
	libraryArtistId: string | null;
	pages: ArtistLink[];
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
	// A remote cover, for a release the library holds no track of (a catalogue
	// album on an entity page): shown in place of the protocol's.
	coverUrl?: string | null;
}
// ─── Entity pages (artist / label / album) ──────────────────────────────────
// One page per entity: a header and the track list, over the library's local
// files ("owned") or the Global Catalog ("world"). An entity is named by
// whatever ids the surface that opened it holds; core fills in the rest.
export type EntityKind = 'artist' | 'label' | 'album';
export interface EntityRef {
	kind: EntityKind;
	// Display name. Identity only for a label's library side (labels are text
	// there): a name alone never joins an artist or an album across the
	// library and the catalogue (namesakes).
	name: string;
	// artist.id / album.id.
	libraryId?: string | null;
	// The Global Catalog's artist / label / release object.
	catalogId?: string | null;
	// Spotify artist / album id.
	spotifyId?: string | null;
	// A credit on a catalogue object the surface does hold (a feed card's
	// release or recording): the entity is resolved among THAT object's
	// credits by name — the one place a name is safe.
	within?: { catalogId: string } | null;
}
export type EntityScopeKind = 'owned' | 'world';
export type StreamingService = 'spotify' | 'tidal';
export interface EntityChip {
	ref: EntityRef;
	// How many releases / tracks back the relation, where known.
	count?: number;
	// What tells it from a namesake, where the source says (a streaming
	// candidate's genres or following).
	detail?: string;
}
export type EntityWorldReason = 'ok' | 'signed_out' | 'server_off' | 'old_server' | 'unknown' | 'ambiguous' | 'pending';
// What an artist's output earns it (entity/badges.ts holds the rules).
export type ArtistBadge = 'veteran' | 'workhorse' | 'prolific';
export interface ArtistActivity {
	firstRelease: string | null;
	lastRelease: string | null;
	// What it released in the last `recentDays`; a track counts at its first release.
	recentDays: number;
	recentReleases: number;
	recentTracks: number;
}
// An artist's audience as one open-ended number (the catalogue's Reach:
// 10 · log10 of its audience in Spotify-listener equivalents). `change` over
// about three months; `parts` what each store said (`outlier`: left out, the
// other stores disagree). Times in ms.
export interface ArtistReach {
	score: number;
	change: number | null;
	at: number;
	parts: { provider: string; metric: string; n: number; at: number; outlier?: boolean }[];
}
export interface EntityHeader {
	// The entity with every id the lookups found: what later calls pass back.
	ref: EntityRef;
	imageUrl: string | null;
	// An owned track whose cover `curator-cover://` serves (an album's thumb).
	coverTrackId: string | null;
	// album only.
	facts: { releaseDate?: string | null; albumType?: string | null };
	genres: { name: string; count?: number }[];
	// artist: the labels it releases on, most recently active first; album: its label.
	labels: EntityChip[];
	// label: who releases on it, by count; album: its artists.
	artists: EntityChip[];
	// artist: what the catalogue holds (research claims are read apart).
	similar: EntityChip[];
	// artist: who shares its tracks' credits, `count` the shared tracks, most first.
	collabs: EntityChip[];
	// artist: the catalogue's account of its releases over time; null where
	// it gave none (an older server, a page read from a streaming service).
	activity: ArtistActivity | null;
	badges: ArtistBadge[];
	// artist: null until the catalogue has scored it.
	reach: ArtistReach | null;
	links: ArtistLink[];
	// null: nothing to follow (an album), or the catalogue did not answer.
	follow: { following: boolean; muted: boolean } | null;
	owned: {
		// Local files only (a file on disk, or on another device of the account).
		count: number;
		// What `tracks:list` is asked for; null when the library holds no such entity.
		filter: ZTrackFilterT | null;
		// A library artist of the same name the catalogue's was NOT joined to:
		// offered, never assumed.
		nameHint?: EntityRef;
	};
	world: {
		available: boolean;
		reason: EntityWorldReason;
		releaseCount: number | null;
		trackCount: number | null;
		// `ambiguous`: the catalogue objects the name could be. `unknown`: the
		// streaming service's artists of that name — offered, never assumed.
		candidates?: EntityChip[];
		// Set when the World side is read from the user's streaming service
		// and not from the catalogue: the catalogue does not know the entity
		// (yet), or cannot be asked. The page is what the service lists, shown
		// at once; where the catalogue can be reached the desktop registers it
		// there (entity/work.ts) and the page becomes the catalogue's.
		via?: StreamingService;
	};
}
export interface EntityWorldAlbum {
	id: string;
	title: string;
	date: string | null;
	type: string | null;
	coverUrl: string | null;
	label: { id: string | null; name: string } | null;
	artists: { id: string; name: string }[];
	genres: string[];
	trackCount: number;
	// Someone else's release the page's artist has tracks on.
	appearance: boolean;
	links: ArtistLink[];
}
export interface EntityWorldTrack {
	recordingId: string;
	releaseId: string;
	title: string;
	artists: { id: string; name: string; role?: string | null }[];
	position: number | null;
	disc: number | null;
	durationSec: number | null;
	isrc: string | null;
	bpm: number | null;
	keyCamelot: string | null;
	genre: string | null;
	// The row's own label, where a lookup found one its release does not name.
	label?: string | null;
	links: ArtistLink[];
	// The track's id on each streaming service the catalogue has its page on.
	streamIds: Partial<Record<StreamingService, string>>;
	// The library track this recording is (any source), and whether this row
	// is the one that stands for it when several releases carry the recording.
	libraryTrackId: string | null;
	libraryPrimary: boolean;
}
export interface EntityTracksPage {
	albums: EntityWorldAlbum[];
	tracks: EntityWorldTrack[];
	nextCursor: string | null;
	// A library row with every column empty: what a catalogue recording is
	// laid over to stand in the track list beside real rows. Built from the
	// schema, so a new track column needs nothing here.
	template: Track;
}
// What this desktop is doing for the entity page in front (entity/work.ts):
// reading the stores for an entity the catalogue does not know ('discover')
// or for releases it lacks ('updates'), reading the tracklists of releases
// the catalogue lists without one ('tracklists'), and filling in what the
// page's rows lack — BPM, key, genre, a page on the user's streaming service
// ('details').
export type EntityWorkPhase = 'discover' | 'updates' | 'tracklists' | 'details';
export interface EntityWorkStatus {
	// null: nothing running (`added` then says what the last check found).
	phase: EntityWorkPhase | null;
	// The store being read right now, when one is.
	source: string | null;
	// discover / updates: releases the stores listed, and how many of them
	// were new to the catalogue.
	found: number;
	added: number;
	// tracklists / details: how far through.
	done: number;
	total: number;
}
// What a lookup found for one World row; only the fields it found.
export interface EntityRowPatch {
	recordingId: string;
	bpm?: number;
	keyCamelot?: string;
	genre?: string;
	label?: string;
	streamIds?: Partial<Record<StreamingService, string>>;
}
export interface EntityWorkEvent {
	// The number the renderer watched the page with: a late event of a page
	// since left is told apart by it.
	watch: number;
	status: EntityWorkStatus;
	// The catalogue's answer changed under the page (the entity is known
	// now; releases or tracklists were added; row findings went up that its
	// header counts — genres): read it again.
	changed?: 'header' | 'tracks';
	rows?: EntityRowPatch[];
}
// ─── World search (the omnibar's World scope) ───────────────────────────────
// One query, asked of three places that answer at their own speed: the user's
// streaming service (its own search: fastest), the Global Catalog (what it
// holds by that name, labels included), and the stores (labels, which a
// streaming service does not file). The renderer asks each part by itself and
// merges what comes back, so the first answer shows without the last.
export type WorldSearchPart = 'streaming' | 'catalog' | 'stores';
export interface WorldHit {
	kind: 'artist' | 'album' | 'label' | 'track';
	name: string;
	// One line under the name: the credit, a date, the album.
	detail: string | null;
	imageUrl: string | null;
	// The page it opens (a track's: its album's).
	ref: EntityRef;
	// What the thing is known by, across the parts ("spotify:artist:<id>",
	// "catalog:<id>", "beatport:label:<id>"): two hits sharing one are one thing.
	keys: string[];
	// Where it was found: a streaming service, 'catalog', a store.
	sources: string[];
	// track only: its row in the result's `rows`.
	recordingId?: string;
}
export interface WorldSearchResult {
	part: WorldSearchPart;
	hits: WorldHit[];
	// The track hits as list rows (catalogRows.ts toRows), so a pick plays.
	rows?: EntityTracksPage;
	// Why the part has nothing to say, when that is not "no matches".
	note?: 'not_connected' | 'signed_out' | 'unavailable' | 'failed';
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
