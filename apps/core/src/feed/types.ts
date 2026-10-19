// Discover feed — shared types. See planning/tech/discover-core.md.
//
// The feed lives IN FRONT of the library: items are lightweight metadata
// rows in their own feed.db, referencing remote content by source ids only.
// Nothing here points into curator.db except `promotedTrackId`, a soft
// reference written at promotion time (interested → ingest as backlog).

import type { StreamingSource } from '@curator/shared';
import type { SourceLinkDraft } from '../enrich/contract.js';

export type FeedItemType = 'track' | 'album' | 'playlist' | 'set';

// RAW library-membership tier, mirroring curator.db track.membership
// (precedence local > streaming > followed). The feed keeps its OWN copy of the
// union so feed/ never imports curator.db schema. This is the SOURCE signal: it
// only ever reflects how a track entered the library (local file / own playlist
// / followed playlist), NOT curation. The pipeline's LibraryFilter drops `local`
// track items off it; the LibraryPort resolves it (plus the pinned tag + the
// owning streaming source) into the display tier below.
export type LibraryTier = 'local' | 'streaming' | 'followed';

// DISPLAY membership tier the feed chips render — resolved by the LibraryPort
// from the raw LibraryTier, the `interested` ("Pinned") tag, and the owning
// streaming source. Distinct from LibraryTier on purpose:
//   • `library` — the user OWNS it: has a local file (raw `local`) OR has it
//     pinned (the `interested` tag). Pinned wins over a streaming/followed tier.
//   • `spotify` / `tidal` — in one of the user's OWN playlists on that source
//     (raw `streaming`, named by which source holds it).
//   • `followed` — only in a playlist the user follows (weakest signal).
// Drives the "In Library" / "In {Spotify|Tidal} Library" / "In Followed
// Playlist" chips. Absent = the library doesn't hold the track.
export type FeedMembershipTier = 'library' | StreamingSource | 'followed';

// Resolve the DISPLAY chip tier from the raw library tier, the pinned flag, and
// the owning streaming source. Pinned (or a local file) → owned "library"; an
// own-playlist track → its source; a followed-only track → "followed"; nothing
// held → undefined. Shared by the per-page decorator and the album-detail probe
// so both surfaces resolve membership identically.
export function resolveFeedMembership(
	raw: LibraryTier | undefined,
	pinned: boolean,
	source: StreamingSource | undefined,
): FeedMembershipTier | undefined {
	if (pinned || raw === 'local') return 'library';
	if (raw === 'streaming') return source ?? 'spotify';
	if (raw === 'followed') return 'followed';
	return undefined;
}

// `dismissed` is a soft remove (the "Delete" action): the row + its signals
// are retained as negative-preference tuning data, but the item is filtered
// from pages. `archived` is an explicit user set-aside — also filtered from
// the main feed, but surfaced on its own Archived page and restorable.
export type FeedItemState = 'fresh' | 'seen' | 'expanded' | 'promoted' | 'dismissed' | 'archived';

export type FeedSuppressionScope = 'artist' | 'label' | 'playlist' | 'source';

// Outcome of the Beatport/enricher pass for one lookup (a track item, or one
// album track ref). `ok` — metadata landed. `na` — the providers ran cleanly
// but had no match (genuinely not on Beatport); terminal, the drain won't
// retry. `err` — a lookup threw (WAF / network); RETRYABLE, the drain re-runs
// it on the next pass. The UI shows `N/A` / `ERR` so an empty row reads as a
// known outcome rather than "still loading". Absent/null = not yet attempted.
export type EnrichStatus = 'ok' | 'na' | 'err';

// Attribution — which follow produced this item. Drives the origin chip on
// the card and the scoped-dismiss menu ("don't show from this playlist").
export interface FeedOrigin {
	kind: 'playlist' | 'artist' | 'browse';
	id: string;
	name: string;
}

// A track reference inside an album/playlist item's payload. Resolved at
// production time by the album-expander stage (pipeline.ts) so albums enter
// the bus complete; the guarded lazy fallback in getFeedItemDetail covers the
// rare case expansion couldn't run.
export interface FeedTrackRef {
	sourceTrackId: string;
	title: string;
	artists: string[];
	// Stable per-source artist ids aligned with `artists` where known. Powers the
	// per-row "Muted" chip: a track whose artist is muted (feed_suppression scope
	// 'artist') is flagged in place rather than hiding the whole album. Refs
	// resolved before this field existed lack it — getItemDetail falls back to
	// album-level artist-name matching for those (see service.getItemDetail).
	artistIds?: string[];
	durationSec: number | null;
	trackNumber?: number | null;
	// Kept whenever the source exposes it — ISRC is the cross-source
	// identity, so dedupe and library matching survive multi-source feeds.
	isrc?: string | null;
	// Per-track DJ metadata, filled by the background enricher (Beatport) for
	// each album track — same fields as the item-level payload below, but
	// per track. Streaming sources don't expose these.
	bpm?: number | null;
	keyCamelot?: string | null;
	genre?: string | null;
	label?: string | null;
	releaseDate?: string | null;
	// The catalog identity the enricher matched (Beatport/Traxsource track id +
	// url + raw payload), same shape the LibrarySink persists as a source_link.
	// Carried so promotion produces a library row identical to a direct enrich —
	// see feedPromote. Feed display ignores it.
	sourceLinks?: SourceLinkDraft[];
	// Per-track enrichment outcome (drives the row's N/A / ERR marker). Set by
	// the album drain after this ref's Beatport lookup; absent until attempted.
	enrichStatus?: EnrichStatus;
}

// Display metadata for a card. `raw` carries the source's native track
// object (e.g. SpotifyTrack) when the producer had it on hand — promotion
// reuses it to avoid a refetch.
export interface FeedItemPayload {
	title: string;
	artists: string[];
	// Stable per-source artist ids aligned with `artists` where known —
	// used for artist-scoped dismiss keys.
	artistIds?: string[];
	label?: string | null;
	// ISRC for track items (cross-source identity — also feeds dedupeKey).
	isrc?: string | null;
	// Enricher-filled DJ metadata (Beatport first) — streaming sources
	// don't expose these.
	bpm?: number | null;
	keyCamelot?: string | null;
	genre?: string | null;
	coverUrl?: string | null;
	releaseDate?: string | null;
	albumTitle?: string | null;
	albumType?: string | null; // 'album' | 'single' | 'compilation'
	trackCount?: number | null;
	durationSec?: number | null;
	url?: string | null;
	// Catalog identity matched by the enricher for a TRACK item (album items
	// carry it per-ref on FeedTrackRef instead). Same shape the LibrarySink
	// persists as a source_link; carried so promotion mirrors a direct enrich.
	sourceLinks?: SourceLinkDraft[];
	tracks?: FeedTrackRef[];
	// True once on-demand ISRC fill has run for `tracks` (album items). Guards
	// the first-expand fill in getFeedItemDetail so a re-expand doesn't refetch
	// — set even when no ISRC landed, same "don't retry" posture as enrichedAt.
	isrcResolved?: boolean;
	raw?: unknown;
}

// What a producer emits. The engine assigns id/state/fetchedAt and dedupes
// on dedupeKey (UNIQUE — re-polls and cross-playlist repeats collapse).
export interface FeedItemDraft {
	type: FeedItemType;
	source: StreamingSource;
	sourceId: string;
	dedupeKey: string;
	payload: FeedItemPayload;
	origin: FeedOrigin | null;
	publishedAt: number | null; // epoch ms
	// Suppression-match keys, e.g. 'artist:<id>', 'playlist:<id>',
	// 'label:<name>', 'source:spotify'.
	suppressKeys: string[];
}

export interface FeedItem {
	id: string;
	type: FeedItemType;
	source: StreamingSource;
	sourceId: string;
	payload: FeedItemPayload;
	origin: FeedOrigin | null;
	// Every named origin (playlist/artist/browse) that surfaced this item — the
	// primary `origin` first, then each cross-source repeat that collapsed onto
	// the row in the dedupe pass, plus (for an album) the origins of playlist
	// track items folded into it as the same recording. Superset of `origin`;
	// drives the card's "+N sources" badge + tooltip. Hydrated per page by the store from
	// feed_item_origin; absent only on a bare row read that skipped hydration.
	sources?: FeedOrigin[];
	publishedAt: number | null;
	fetchedAt: number;
	score: number;
	state: FeedItemState;
	playedAt: number | null;
	// When the item was set aside (state -> 'archived'); null if never archived.
	// Orders the Archived page and supplies its card date label.
	archivedAt: number | null;
	// Timestamp of the last enrichment attempt (set on every attempt, hit or
	// miss). Informational — the retry decision keys off `enrichStatus`, not
	// this.
	enrichedAt: number | null;
	// Enrichment outcome for this item — for a track item, its own lookup; for
	// an album, the aggregate over its track refs ('err' if ANY ref errored, so
	// the album re-runs and retries just those refs). null until first attempt.
	// 'ok'/'na' are terminal; 'err' is retried by the drain. Per-album-track
	// status lives on each FeedTrackRef.enrichStatus for the row-level marker.
	enrichStatus: EnrichStatus | null;
	promotedTrackId: string | null;
	// DISPLAY membership tier of THIS track item, stamped per page by the
	// LibraryPort probe (resolved from the raw tier + the pinned tag + the owning
	// source). A pinned track reads `library`; an own-playlist track reads its
	// source (`spotify`/`tidal`); a followed-only track reads `followed`. Raw
	// `local`-tier (local-file) track items are filtered out before the page, so
	// a card only shows `library` here via the pinned path. Absent = not held.
	// Album items don't carry a card-level tier — their per-track tiers ride on
	// the detail's membershipBySourceTrackId instead.
	membership?: FeedMembershipTier;
	// Canonical curator track id for a track item the library already OWNS — set
	// by the per-page decorator (LibraryPort.libraryTrackIds) for any owned tier
	// (pinned / local file / own streaming playlist), but NOT for a merely-followed
	// track. Lets the card's curate menu act on the owned track (Tag / Add to
	// playlist) without a second lookup, and flips it off the "Interested" promote
	// face. Distinct from promotedTrackId: that marks a FEED-driven promotion (and
	// drives returning the item to the feed on undo); this only says "the library
	// holds this track". Absent = not owned (followed-only or not in library).
	libraryTrackId?: string;
	// True for a track item whose own source track Spotify refused to play —
	// 403 "Restriction violated" with is_playable:false confirmed at play time
	// (see player.ts). Region-unavailable for this account. Dims the card and
	// makes the feed skip it on auto-advance. Album items carry their per-track
	// unavailability in FeedItemDetail instead.
	unavailable?: boolean;
}

export interface FeedPage {
	items: FeedItem[];
	// Keyset cursor for the next page; null when exhausted.
	nextCursor: string | null;
	// Count of currently-visible (non-dismissed/promoted, non-suppressed)
	// items — drives the Discover tab chip.
	total: number;
}

export interface FeedItemDetail {
	item: FeedItem;
	// sourceTrackIds with at least one listen signal — drives per-track
	// played-dimming inside an expanded album card.
	playedSourceTrackIds: string[];
	// sourceTrackIds (this item's own + album-track ids) confirmed unplayable
	// in the account's market. Same shape/role as playedSourceTrackIds: dims
	// the expanded-album rows and lets advance skip them.
	unavailableSourceTrackIds: string[];
	// sourceTrackId → DISPLAY membership tier, for album-track refs the library
	// already holds (by ISRC or spotify source-track id). Resolved at detail time
	// via the LibraryPort probe (see service.getItemDetail) — local-file/pinned →
	// `library`, own playlist → its source, followed-only → `followed`. Album
	// items pass the ingest LibraryFilter untouched, so a release can carry tracks
	// you already own at any tier; this drives the membership chip on those rows.
	// Disjoint from deletedSourceTrackIds.
	membershipBySourceTrackId: Record<string, FeedMembershipTier>;
	// sourceTrackId → canonical curator track id, for the same in-library refs.
	// Lets the renderer act on an owned feed track (tag / add-to-playlist /
	// not-interested) without a second lookup. Keys ⊇ membershipBySourceTrackId
	// (a library track at the null/none tier has an id here but no tier there).
	inLibraryTrackIds: Record<string, string>;
	// sourceTrackIds (album-track refs) that carry the `interested` ("Pinned")
	// tag. Subset of inLibraryTrackIds' keys — drives the row's "Not Interested"
	// (un-pin) action, which is offered ONLY for pinned tracks. A track that's
	// owned merely via a local file or one of the user's own playlists is NOT
	// here, so its menu offers only the non-destructive Tag / Add-to-playlist
	// (removing it would delete the file / push a live playlist removal).
	pinnedSourceTrackIds: string[];
	// sourceTrackIds (album-track refs) that are SOFT-DELETED in the library —
	// the user deleted them but they still appear in this release's tracklist.
	// Disjoint from membershipBySourceTrackId; drives the "deleted" chip on those
	// rows. Standalone deleted track-items are dropped from the page entirely
	// (see service.getPage), so this only ever carries album-nested refs.
	deletedSourceTrackIds: string[];
	// sourceTrackIds (album-track refs) whose artist is muted (feed_suppression
	// scope 'artist'). Muting an artist no longer hides a multi-artist album — the
	// album stays and its offending tracks carry a "Muted" chip and are skipped by
	// autoplay (still manually playable). Computed at detail time from the muted
	// artist-key set ∩ each ref's artistIds, with an album-level name fallback for
	// older refs that predate FeedTrackRef.artistIds. Disjoint in spirit from
	// the membership/deleted sets, though a row could in principle be both.
	mutedSourceTrackIds: string[];
	// Why the tracklist is empty, when the lazy expand-time resolve couldn't
	// fill it (no token, 429, source error). Lets the renderer show the real
	// reason instead of a hardcoded "rate-limiting" guess. Absent on success.
	tracksError?: string;
}

export type FeedSignalKind = 'impression' | 'expand' | 'listen' | 'dismiss' | 'promote' | 'archive';

export interface FeedSignalInput {
	itemId: string;
	kind: FeedSignalKind;
	value?: { sourceTrackId?: string; ms?: number; scope?: string } | null;
}

export type FeedAction =
	// Per-item soft remove. Optional scope additionally suppresses the whole
	// artist / label / source-playlist going forward.
	| { kind: 'dismiss'; itemId: string; scope?: { scope: FeedSuppressionScope; key: string } }
	// Register one or more suppressions WITHOUT removing an item. Used for muting
	// an artist credited on an album: the album must survive (only its tracks get
	// chipped), so unlike `dismiss` this never marks a row dismissed — except when
	// `dismissItemId` is given (multi-artist TRACK "Mute all artists", where the
	// track itself should still disappear). `scopes` carries the full set so one
	// round-trip mutes every credited artist.
	| { kind: 'mute'; scopes: { scope: FeedSuppressionScope; key: string }[]; dismissItemId?: string }
	// Promote into the library as state='backlog'. Adds the `interested`
	// ("Pinned") tag when `pin` is true/omitted (the "Interested" action); the
	// deferred plain-"Organize" path passes pin:false so the row is created
	// WITHOUT pinning — owned purely via the tags/playlists the user then picks.
	// For album items, sourceTrackId selects the track; the album item itself
	// stays in the feed (only type='track' items flip to 'promoted').
	| { kind: 'interested'; itemId: string; sourceTrackId?: string; pin?: boolean }
	// Reverse of interested: delete the promoted/owned library track (drops it
	// from the library + its interested/pinned tag), and — for a promoted track
	// item — return the feed item to the visible feed.
	| { kind: 'uninterested'; itemId: string; trackId: string }
	// Set-aside to the Archived page (state='archived'); 'unarchive' returns
	// it to the visible feed (state='seen').
	| { kind: 'archive'; itemId: string }
	| { kind: 'unarchive'; itemId: string }
	| { kind: 'seen'; itemId: string }
	| { kind: 'expanded'; itemId: string }
	// Playback started — sets playedAt on the item; for album items the
	// per-track listen lands in the signal log keyed by sourceTrackId.
	| { kind: 'played'; itemId: string; sourceTrackId?: string; ms?: number }
	// Reactive play-failure flag: a play attempt returned 403 "Restriction
	// violated" AND the market-scoped probe confirmed is_playable:false. Records
	// the source track as unavailable globally (keyed by sourceTrackId) so every
	// feed item carrying it dims and auto-skips. itemId is the item that surfaced
	// it (the action handler requires one).
	| { kind: 'unavailable'; itemId: string; sourceTrackId: string };

export interface FeedActionResult {
	ok: boolean;
	// Set for 'interested' — the canonical library track id the item/track
	// was promoted to.
	promotedTrackId?: string;
	// Set for unfollowPlaylist — how many feed items were removed.
	removed?: number;
	error?: string;
}

export interface FeedRefreshResult {
	producers: { producerId: string; inserted: number; error: string | null }[];
}

// Auth port — the only auth surface the feed service needs (Spotify token
// for producers, album expansion, and promotion). AuthService satisfies it
// structurally; in the cloud it's a server-side OAuth-refresh store. Kept
// here (not service.ts) so producers can depend on it without a cycle.
export interface FeedAuthPort {
	getSpotifyAccessToken(): Promise<string | null>;
}

// ─── Producer contract ─────────────────────────────────────────────────
// Pull-based v1: the scheduler loads the producer's cursor, calls poll(),
// upserts the drafts, stores nextCursor. Push sources later reuse
// FeedStore.upsertItems behind a service endpoint — same storage contract.
// A producer with nothing to offer (e.g. source not connected) returns
// empty drafts and echoes the cursor — disabled is a supported state.
export interface FeedProducer {
	readonly id: string;
	readonly source: StreamingSource;
	readonly displayName: string;
	poll(cursor: unknown): Promise<{ drafts: FeedItemDraft[]; nextCursor: unknown }>;
	// Historical "Load more": extend the producer's horizon (the oldest
	// boundary it has fetched, kept inside its cursor) back by `days` and
	// emit only the newly-uncovered window. Engine-level dedupe makes
	// overlap with prior fetches free. Optional — producers without a
	// meaningful history (e.g. push sources) just don't implement it.
	backfill?(cursor: unknown, days: number): Promise<{ drafts: FeedItemDraft[]; nextCursor: unknown }>;
}

// DJ metadata fields (bpm/key/genre/label) live on FeedItemPayload (track
// items) and FeedTrackRef (album tracks). The enrichment contract — the patch
// shape, the per-track query, the Enricher interface — is now shared with the
// library and future discover via apps/core/src/enrich/. Re-exported here so
// feed consumers keep one import surface.
export type { DjMetadataPatch, EnrichmentResult, SourceLinkDraft } from '../enrich/contract.js';
