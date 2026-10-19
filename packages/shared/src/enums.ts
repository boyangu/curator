// Enum consts and their union types for the library schema, with no imports.
//
// They used to live in schema.ts, which imports drizzle-orm/sqlite-core. types.ts
// value-imports several of them (for its zod schemas), so anything that loaded
// the shared types — the cloud service, the phone — pulled in the SQLite
// dialect at runtime. Keeping this module import-free is the point: schema.ts
// builds its column enums from here and re-exports them, so consumers of
// '@curator/shared' and '@curator/shared/schema' see no change.

// Stage in the curation workflow. Schema-only for now; the Feed→Backlog→Progress→Purchased
// UI is deferred. Default 'unsorted' keeps tracks parked until that lands.
export type TrackState = 'unsorted' | 'feed' | 'backlog' | 'progress' | 'purchased';
export const TRACK_STATES = ['unsorted', 'feed', 'backlog', 'progress', 'purchased'] as const;

// Materialized library-membership tier (track.membership). Precedence
// local > streaming > followed; NULL = none. A track is `local` when it has a
// local-file source_link; `streaming` when it (not local) sits in one of the
// user's OWN streaming playlists (incl. Spotify Liked Songs); `followed` when
// it (neither) is in a playlist the user merely follows. Kept current by the
// MembershipClassifier (apps/core/src/library/membership.ts); readers gate on
// deletedAt the same way the in-library probes do. See planning/ for the model.
export type MembershipTier = 'local' | 'streaming' | 'followed';
export const MEMBERSHIP_TIERS = ['local', 'streaming', 'followed'] as const;

// Provider enum — extend here; source_link.source (schema.ts) builds its column enum from it.
// `local` is the on-disk file source (FLAC/M4A/WAV from watched library folders).
export type Source = 'spotify' | 'tidal' | 'beatport' | 'traxsource' | 'musicbrainz' | 'discogs' | 'local' | 'rekordbox';
export const SOURCES = ['spotify', 'tidal', 'beatport', 'traxsource', 'musicbrainz', 'discogs', 'local', 'rekordbox'] as const;
// Playlist sources: streaming providers, rekordbox (a local DJ library), and
// `local` — Curator's own user-created playlists (e.g. materialized from a
// pinned search). The `playlist` table reuses one row shape for all of them;
// Rekordbox playlists land with source='rekordbox' and sourceId =
// DjmdPlaylist.ID, while `local` rows carry a generated uuid as sourceId and
// are inert to every sync path (membership + scheduler filter on the explicit
// streaming sources, never `local`).
export type PlaylistSource = Extract<Source, 'spotify' | 'tidal' | 'rekordbox' | 'local'>;
export const PLAYLIST_SOURCES = ['spotify', 'tidal', 'rekordbox', 'local'] as const;
// Folder-bearing sources — streaming providers + rekordbox; all three expose
// nested playlist hierarchies that we mirror via the playlist_folder table.
export const FOLDER_SOURCES = ['spotify', 'tidal', 'rekordbox'] as const;
export type FolderSource = (typeof FOLDER_SOURCES)[number];

export const TAG_KINDS = ['system', 'user'] as const;
export type TagKind = (typeof TAG_KINDS)[number];

// Well-known system tag IDs — used by Interested/Basket tabs.
export const SYSTEM_TAG_INTERESTED = 'interested' as const;
export const SYSTEM_TAG_BASKET = 'basket' as const;

export const CUE_KINDS = ['hot', 'memory'] as const;
export type CueKind = (typeof CUE_KINDS)[number];

// Who authored the cue row. 'rekordbox' = written by the importer from a
// Rekordbox scan; 'curator' = created/edited in Curator's cue editor. The
// importer's pre-scan wipe deletes ONLY rekordbox-origin rows — without
// the distinction it would eat user-authored cues that haven't been pushed
// to Rekordbox yet. Default is 'curator' (fail-safe: a write-site that
// forgets to set origin produces cues the wipe protects, not destroys);
// the importer sets 'rekordbox' explicitly.
export const CUE_ORIGINS = ['rekordbox', 'curator'] as const;
export type CueOrigin = (typeof CUE_ORIGINS)[number];

export const ANALYSIS_STATES = ['queued', 'running', 'done', 'error', 'skipped'] as const;
export type AnalysisState = (typeof ANALYSIS_STATES)[number];

export const METRIC_NAMES = [
	'brightness',
	'power',
	'dissonance',
	'density',
	'loudness_range_lu',
	'dynamic_complexity',
	// Phase 2A — segment-derived scalars. drop_count / breakdown_count are NOT
	// bucketed (low-cardinality integer counts; studio queries on them are
	// exact-value, not percentile).
	'intro_length_sec',
	'outro_length_sec',
	'first_drop_sec',
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export const PLAY_SESSION_ORIGINS = ['curator', 'rekordbox'] as const;
export type PlaySessionOrigin = (typeof PLAY_SESSION_ORIGINS)[number];
// 'set' = a real DJ set (USB/CDJ history import — detected by the bulk-insert
// signature, all djmdSongHistory rows landing in the same instant); 'prep' =
// auditioning/preparation (live rekordbox session, or any curator play).
export const PLAY_SESSION_KINDS = ['set', 'prep', 'unknown'] as const;
export type PlaySessionKind = (typeof PLAY_SESSION_KINDS)[number];
export const PLAY_SOURCES = ['local', 'spotify', 'rekordbox'] as const;
export type PlaySource = (typeof PLAY_SOURCES)[number];
export const PLAY_ENDED_REASONS = ['ended', 'replaced', 'stopped', 'queue_end', 'interrupted'] as const;
export type PlayEndedReason = (typeof PLAY_ENDED_REASONS)[number];

// sync_outbox.state: 'pending' until the server accepts the op ('acked') or
// refuses it ('rejected').
export const SYNC_OUTBOX_STATES = ['pending', 'acked', 'rejected'] as const;
export type SyncOutboxState = (typeof SYNC_OUTBOX_STATES)[number];
