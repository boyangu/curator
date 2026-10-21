import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, blob, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import type { CueUnit, DjSyncProvider, FieldsSeen } from './sync.js';
import {
	TRACK_STATES,
	MEMBERSHIP_TIERS,
	SOURCES,
	PLAYLIST_SOURCES,
	TAG_KINDS,
	CUE_KINDS,
	CUE_ORIGINS,
	ANALYSIS_STATES,
	METRIC_NAMES,
	PLAY_SESSION_ORIGINS,
	PLAY_SESSION_KINDS,
	PLAY_SOURCES,
	PLAY_ENDED_REASONS,
	SYNC_OUTBOX_STATES,
	type MembershipTier,
	type PlaySource,
	type PlayEndedReason,
} from './enums.js';

// Re-exported so the many '@curator/shared/schema' importers of these enums
// keep working; the definitions live in the import-free enums.ts.
export * from './enums.js';

export type TrackArtist = { name: string; role?: 'main' | 'featured' | 'remixer' };

// track.artists_base — see the column.
export type ArtistsBase = { list: TrackArtist[]; of: string };

// User-applied overrides. A field present here shadows the canonical value
// on read; sync/enrichment writers keep updating the canonical columns
// underneath. Field omitted (or `undefined` in JSON) means "no override —
// use the canonical value". To revert a previously-set override, set the
// field to undefined / remove it from the JSON.
export type TrackOverrides = {
	title?: string;
	artists?: TrackArtist[];
	albumTitle?: string;
	label?: string;
	genre?: string;
	bpm?: number;
	keyCamelot?: string;
	// ISO date string ("2021" / "2021-03" / "2021-03-15") — same shape as the
	// canonical column. An override survives the Beatport enricher rewriting
	// the canonical value underneath, which is exactly why it's an override.
	releaseDate?: string;
};

// ─── TRACK ───────────────────────────────────────────────────────────────────
// Canonical recording. Cross-source identity resolved by ISRC first, then by
// (deaccented title + primary artist + duration ±5s) clustering.
export const track = sqliteTable(
	'track',
	{
		id: text('id').primaryKey(),
		// Catalogue identity (cloud design: "Identifiers"). `id` stays per
		// device — eleven tables and the peaks files hang off it — while sync
		// ops and catalogue claims address the recording. Minted by the device
		// that creates the row (recordingIdForTrack in apps/core/src/sync-log);
		// rewritten only when the catalogue aliases two recordings into one.
		// Nullable in SQLite (an ADD COLUMN), but every migrate fills any null
		// and every writer sets it, so it is typed notNull here: tsc then
		// flags a new insert site that forgets it.
		recordingId: text('recording_id').notNull(),
		isrc: text('isrc'),
		mbid: text('mbid'),
		title: text('title').notNull(),
		artists: text('artists', { mode: 'json' }).$type<TrackArtist[]>().notNull(),
		// The credits as their source spelled them, before any artist alias
		// rule (a rename / merge, local or pulled) mapped them; NULL when no
		// rule changed them. `artists` is then a function of this list and the
		// converged rules (library/artist-alias.ts), so two devices that
		// applied concurrent renames in different orders still land on the
		// same credits. `of` is the credits key of the `artists` it produced:
		// a writer that replaces `artists` without knowing about this column
		// leaves a cell whose `of` no longer matches, and a stale cell reads
		// as NULL (artists.ts `artistsBaseOf`) instead of resurrecting old
		// credits. Device-local catalogue data, like `artists`: no op carries it.
		artistsBase: text('artists_base', { mode: 'json' }).$type<ArtistsBase>(),
		albumTitle: text('album_title'),
		// Track release date (ISO string, e.g. "2021-03-15" or "2021"). Seeded
		// from Spotify's album.release_date at sync; the Beatport enricher
		// overrides it with the track/release-level date (more accurate for
		// electronic releases — compilations/remasters skew the album value).
		releaseDate: text('release_date'),
		// Remote URL for the album cover image. Populated by sync from
		// Spotify's track.album.images[0].url (or the equivalent from other
		// providers). The Electron main process handles caching to disk and
		// serves them via the `curator-cover://` protocol to the renderer.
		coverUrl: text('cover_url'),
		duration: integer('duration'),
		// Real, not integer: Rekordbox/analyzer BPM carries up to 2 decimals
		// (91.13). Aligns with track_analysis.bpm / source_link.rb_bpm (both real).
		bpm: real('bpm'),
		// Canonical key — the ONE stored key representation. Musical notation
		// (Am, F#…) is a display-only projection derived in the UI via the
		// Camelot↔musical map; it is never persisted. Every ingestion path
		// converts its source notation to Camelot at the boundary.
		keyCamelot: text('key_camelot'),
		genre: text('genre'),
		label: text('label'),
		copyright: text('copyright'),
		explicit: integer('explicit', { mode: 'boolean' }),
		// Diacritic-folded shadow columns for user-facing search. Mirror the
		// matching canonical text fields through `searchFold()` (lowercase +
		// NFD strip + ß/ø/æ/œ/ł folding). `artistsAscii` is a single TEXT
		// blob of all artist names joined by ' | ' so the LIKE pre-filter
		// hits one column instead of walking the JSON array. Maintained by
		// `asciify()` at every write site — see apps/core/src/service.ts.
		// Nullable so unpatched fields don't get clobbered; migration
		// backfills existing rows on first boot.
		titleAscii: text('title_ascii'),
		albumTitleAscii: text('album_title_ascii'),
		labelAscii: text('label_ascii'),
		genreAscii: text('genre_ascii'),
		artistsAscii: text('artists_ascii'),
		// Folded name of the EFFECTIVE primary artist (overrides.artists ??
		// artists)[0], materialized so the Artist column sort hits an index
		// instead of a json_extract over every row. Maintained by the
		// track_artist seam (apps/core/src/library/artists.ts) at every
		// write that touches artists or overrides.
		artistSort: text('artist_sort'),
		// Analyzer-only scalars mirrored from track_analysis so the virtualized
		// track list can sort/filter without joining. None of these have
		// streaming-provider equivalents — the analyzer is the sole writer.
		// Populated by queue.persistResult on every (re-)analysis; Path A
		// backfill repopulates them whenever ANALYZER_VERSION bumps.
		loudnessRangeLu: real('loudness_range_lu'),
		dissonance: real('dissonance'),
		density: real('density'),
		// `brightness` is the curator-aligned learned score (analyzer 2.3.0+),
		// not the old raw spectral centroid. `power` is the energy/density score.
		brightness: real('brightness'),
		power: real('power'),
		dynamicComplexity: real('dynamic_complexity'),
		// Phase 2A — segment-derived scalars mirrored from track_analysis.
		// Null on unanalyzed tracks; on analyzed tracks the *count* columns
		// are 0 (not null) when the analyzer ran but found no labelled
		// drops/breakdowns, whereas the *length/position* columns stay null
		// when the corresponding label was absent. See apps/analyzer/src/
		// curator_analyzer/worker.py `_derive_segment_scalars`.
		introLengthSec: real('intro_length_sec'),
		outroLengthSec: real('outro_length_sec'),
		firstDropSec: real('first_drop_sec'),
		dropCount: integer('drop_count'),
		breakdownCount: integer('breakdown_count'),
		state: text('state', { enum: TRACK_STATES }).notNull().default('unsorted'),
		stateChangedAt: integer('state_changed_at', { mode: 'timestamp_ms' }),
		overrides: text('overrides', { mode: 'json' }).$type<TrackOverrides | null>(),
		// Rekordbox-imported extras (also user-editable in our UI later). Nullable
		// so analyzer-only / fresh tracks don't carry empty defaults. play_count
		// + last_played_at trickle in from Rekordbox's DjmdContent on incremental
		// sync; user-driven plays from Curator's player will land here too.
		colorLabel: text('color_label'),  // 'red'|'orange'|'yellow'|'green'|'aqua'|'blue'|'purple'|'pink'
		rating: integer('rating'),         // 0..5 (rekordbox uses 0/1/2/3/4/5)
		comment: text('comment'),
		playCount: integer('play_count').notNull().default(0),
		lastPlayedAt: integer('last_played_at', { mode: 'timestamp_ms' }),
		// User-visible "added to library" date. Distinct from createdAt
		// (which is when Curator first ingested the row): for tracks pulled
		// from Rekordbox this is `DjmdContent.StockDate` — when the user
		// actually added the track to their DJ library. Falls back to
		// createdAt at render time when null.
		addedAt: integer('added_at', { mode: 'timestamp_ms' }),
		// Set the first time the user mutates a cue for this track via the
		// in-app pad grid (upsert / update / delete). The rekordbox exporter
		// reads this as the "user has authoritatively edited cues in
		// Curator" signal: when set, an empty Curator cue list is pushed as
		// a real clear (wipe rb's cues); when null, the footgun guard skips
		// the cues op to avoid blowing away rb-side cues we just never
		// loaded. Stays set forever once flipped — re-importing from rb
		// doesn't clear it because that import is what the user explicitly
		// just chose to accept.
		cuesEditedAt: integer('cues_edited_at', { mode: 'timestamp_ms' }),
		// Soft-delete tombstone. When set, the track is "deleted from the
		// library": its local file is trashed and it's removed from the user's
		// own playlists, but the row survives so it can still show — flagged
		// with a "deleted" chip — where another party references it (a FOLLOWED
		// playlist you don't own, an album tracklist in the Discover feed).
		// getTracksImpl filters `deletedAt IS NOT NULL` out of every scope
		// except a single-playlist read (that's what surfaces the chip in a
		// followed playlist). The hard "burn the row" path still exists for
		// feed un-promotion (deleteTracks { hard: true }).
		deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
		// Set by "Delete permanently" in Settings → Deleted Tracks: the
		// tombstone's tags and cues are gone and it leaves that list, but the
		// row stays — its links, analysis and recording keep the track deleted
		// (streaming read-sync, the scanner and the feed all bind a re-seen
		// track to it). Meaningful only while deletedAt is set; every undelete
		// and fresh delete clears it. Device-local, never an op.
		purgedAt: integer('purged_at', { mode: 'timestamp_ms' }),
		// A track the account holds but THIS device has no source for: no
		// file, no streaming link, no rekordbox entry — "not on this device".
		// Materialised from another device's `library_track.set-meta`
		// (apps/core/src/sync-log/remote-rows.ts) so every device shows the
		// account's whole library; its columns are that meta, its tags, cues,
		// playlist rows and rating come through the op log like any row's.
		// It is a projection: every device-local writer (scanner and import
		// matching, the ISRC dedupe, rekordbox export, analysis, downloads,
		// meta emission) skips it, and it is dropped and re-derived freely.
		// A source arriving here (a scanned file, an import's link) turns it
		// into an ordinary row (the source_link trigger in migrate.ts).
		remoteOnly: integer('remote_only', { mode: 'boolean' }).notNull().default(false),
		// Where the winning meta's device holds the track (its set-meta
		// `source`: local | spotify | tidal | other), set only on remote rows.
		// Source scopes read it in place of the links this row lacks, so a
		// track that is a local file on the master shows in this device's
		// library root, marked "not on this device" (service.ts
		// sourceMembership).
		remoteSource: text('remote_source'),
		// Materialized library-membership tier — see MembershipTier above.
		// NULL = none. Written by the MembershipClassifier on every event that
		// can change local-file presence or playlist membership (sync, scan,
		// playlist add/remove, promote, delete, re-auth).
		membership: text('membership', { enum: MEMBERSHIP_TIERS }).$type<MembershipTier>(),
		// Set on a track Curator minted as a format copy of another track
		// (today: the lossless WAV copy made by "Convert to WAV" for decks that
		// can't play FLAC). Points at the original. Load-bearing for identity:
		// the copy shares title/artists/duration with its original, so every
		// matcher that clusters by those (startup ISRC dedup, the scanner's
		// match-or-create, streaming match-existing) must skip derived rows or
		// it would fold the copy back into the original.
		derivedFromTrackId: text('derived_from_track_id'),
		// The release this recording belongs to — DERIVED by the album seam
		// (apps/core/src/library/albums.ts) from album_title + the source
		// links' album ids, like artist_sort is from artists. `album_title`
		// stays the canonical, denormalised text (the rekordbox push, the
		// three-way merge and the download filename template all read it).
		albumId: text('album_id'),
		// Position on the release. Filled from provider payloads (Spotify's
		// full track / album objects); null when no source has said.
		trackNumber: integer('track_number'),
		discNumber: integer('disc_number'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		isrcIdx: index('track_isrc_idx').on(t.isrc),
		recordingIdx: index('track_recording_idx').on(t.recordingId),
		stateIdx: index('track_state_idx').on(t.state),
		bpmIdx: index('track_bpm_idx').on(t.bpm),
		keyIdx: index('track_key_idx').on(t.keyCamelot),
		ratingIdx: index('track_rating_idx').on(t.rating),
		durationIdx: index('track_duration_idx').on(t.duration),
		createdAtIdx: index('track_created_at_idx').on(t.createdAt),
		loudnessRangeLuIdx: index('track_loudness_range_lu_idx').on(t.loudnessRangeLu),
		dissonanceIdx: index('track_dissonance_idx').on(t.dissonance),
		densityIdx: index('track_density_idx').on(t.density),
		brightnessIdx: index('track_brightness_idx').on(t.brightness),
		powerIdx: index('track_power_idx').on(t.power),
		dynamicComplexityIdx: index('track_dynamic_complexity_idx').on(t.dynamicComplexity),
		introLengthSecIdx: index('track_intro_length_sec_idx').on(t.introLengthSec),
		outroLengthSecIdx: index('track_outro_length_sec_idx').on(t.outroLengthSec),
		firstDropSecIdx: index('track_first_drop_sec_idx').on(t.firstDropSec),
		deletedAtIdx: index('track_deleted_at_idx').on(t.deletedAt),
		membershipIdx: index('track_membership_idx').on(t.membership),
		// Folded genre/label — the Organize recommender's categorical matching
		// compares these (case/diacritic-insensitive), so give it index hits
		// instead of two full-table scans per run.
		genreAsciiIdx: index('track_genre_ascii_idx').on(t.genreAscii),
		labelAsciiIdx: index('track_label_ascii_idx').on(t.labelAscii),
		artistSortIdx: index('track_artist_sort_idx').on(t.artistSort),
		derivedFromIdx: index('track_derived_from_idx').on(t.derivedFromTrackId),
		albumIdx: index('track_album_idx').on(t.albumId),
		// Partial (migrate.ts: WHERE remote_only = 1): the remote rows are the
		// few-to-many minority on a source-holding desktop and the count,
		// sweep and filter read only them.
		remoteOnlyIdx: index('track_remote_only_idx').on(t.remoteOnly),
	})
);

// ─── ARTIST / TRACK_ARTIST ───────────────────────────────────────────────────
// The library's artist entities. `track.artists` (JSON TrackArtist[]) stays
// the canonical write-input and the read/IPC shape; these two tables are
// DERIVED from the effective list (overrides.artists ?? artists) by one seam
// (apps/core/src/library/artists.ts) and exist so an artist can be scoped
// by id, filtered/sorted with an index, counted, renamed across the library
// and merged with a duplicate spelling. Same shape as knowledge.db's
// kb_entity(kind='artist') + kb_edge(kind='track-artist').
//
// Identity is the searchFold of the name (`name_ascii`, UNIQUE): "KIDSØ" and
// "Kidsø" are one artist. `name` is the display spelling — first-seen until
// the user renames it, after which `name_curated_at` is set and the seam
// rewrites incoming variants to the curated spelling (a Spotify re-sync
// can't silently undo the fix). `merged_into` turns a row into an alias:
// lookups follow it, so an incoming "Ben Bohmer" lands on "Ben Böhmer" once
// the two were merged.
export const artist = sqliteTable(
	'artist',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		nameAscii: text('name_ascii').notNull(),
		mergedInto: text('merged_into'),
		nameCuratedAt: integer('name_curated_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		nameAsciiUniq: uniqueIndex('artist_name_ascii_uniq').on(t.nameAscii),
	})
);

// Provider identities per artist. Filled from the synced track payloads
// (Spotify's track.artists[].id, Tidal's artists[].id) at sync and in the
// backfill, so "Open in Spotify" on an artist is a direct link, not a
// search. (source, source_id) is unique; an artist may have several.
export const artistLink = sqliteTable(
	'artist_link',
	{
		artistId: text('artist_id')
			.notNull()
			.references(() => artist.id, { onDelete: 'cascade' }),
		source: text('source').notNull(),
		sourceId: text('source_id').notNull(),
		url: text('url'),
		fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.source, t.sourceId] }),
		artistIdx: index('artist_link_artist_idx').on(t.artistId),
	})
);

export const trackArtist = sqliteTable(
	'track_artist',
	{
		trackId: text('track_id')
			.notNull()
			.references(() => track.id, { onDelete: 'cascade' }),
		artistId: text('artist_id')
			.notNull()
			.references(() => artist.id, { onDelete: 'cascade' }),
		role: text('role').$type<TrackArtist['role'] | null>(),
		// Index into the effective TrackArtist[] — keeps `Track.artistIds`
		// aligned with `Track.artists` on read.
		position: integer('position').notNull(),
	},
	(t) => ({
		// (track, artist) not (track, position): a credit that names the
		// same artist twice collapses to one row instead of failing.
		pk: primaryKey({ columns: [t.trackId, t.artistId] }),
		artistIdx: index('track_artist_artist_idx').on(t.artistId),
	})
);

// ─── ALBUM / ALBUM_ARTIST / ALBUM_LINK ───────────────────────────────────────
// The library's releases, artist-shaped: DERIVED by one seam
// (apps/core/src/library/albums.ts) from each track's album title, its main
// artist and the album ids its Spotify / Tidal links carry, so a release can
// be grouped, scoped by id and shown with real metadata. `track.album_title`
// stays the canonical text; `track.album_id` points here.
//
// Identity is `album_key` = folded title + the sorted album-artist ids
// (`|*` for Various Artists). The same release from Spotify, Tidal and a
// local rip is one album when title and album artists agree; a deluxe
// edition or a remix pack has a different title and stays separate.
// A provider album id (album_link) wins over the key, so every track
// Spotify files under one album lands on one row even before its artists
// are known. `artists_source`: 'source' — album artists came from the
// provider's album object (authoritative); 'derived' — the main artist all
// members share (a guess, upgraded when a provider answers); 'various' —
// members disagree, a compilation (no album_artist rows).
export const album = sqliteTable(
	'album',
	{
		id: text('id').primaryKey(),
		title: text('title').notNull(),
		titleKey: text('title_key').notNull(),
		albumKey: text('album_key').notNull(),
		artistsSource: text('artists_source').$type<'source' | 'derived' | 'various'>().notNull().default('derived'),
		releaseDate: text('release_date'),
		label: text('label'),
		upc: text('upc'),
		coverUrl: text('cover_url'),
		// Provider release type — Spotify's 'album' | 'single' | 'compilation'.
		albumType: text('album_type'),
		totalTracks: integer('total_tracks'),
		mergedInto: text('merged_into'),
		// Set once the provider album object has been fetched (artists, type,
		// track numbers) — the background fill's resume marker.
		enrichedAt: integer('enriched_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		albumKeyIdx: index('album_key_idx').on(t.albumKey),
		titleKeyIdx: index('album_title_key_idx').on(t.titleKey),
	})
);

export const albumArtist = sqliteTable(
	'album_artist',
	{
		albumId: text('album_id')
			.notNull()
			.references(() => album.id, { onDelete: 'cascade' }),
		artistId: text('artist_id')
			.notNull()
			.references(() => artist.id, { onDelete: 'cascade' }),
		position: integer('position').notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.albumId, t.artistId] }),
		artistIdx: index('album_artist_artist_idx').on(t.artistId),
	})
);

// Provider album ids per release (Spotify album id, Tidal album id).
// (source, source_id) is unique; a release may carry several.
export const albumLink = sqliteTable(
	'album_link',
	{
		albumId: text('album_id')
			.notNull()
			.references(() => album.id, { onDelete: 'cascade' }),
		source: text('source').notNull(),
		sourceId: text('source_id').notNull(),
		url: text('url'),
		fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.source, t.sourceId] }),
		albumIdx: index('album_link_album_idx').on(t.albumId),
	})
);

// ─── SOURCE_LINK ─────────────────────────────────────────────────────────────
// Per-provider view of a track. Preserves what each source actually says
// (ISRC, title, duration may differ) so we can re-run the matcher later
// without re-fetching.
export const sourceLink = sqliteTable(
	'source_link',
	{
		id: text('id').primaryKey(),
		trackId: text('track_id')
			.notNull()
			.references(() => track.id, { onDelete: 'cascade' }),
		source: text('source', { enum: SOURCES }).notNull(),
		sourceTrackId: text('source_track_id').notNull(),
		url: text('url'),
		isrcLocal: text('isrc_local'),
		titleLocal: text('title_local'),
		artistsLocal: text('artists_local', { mode: 'json' }).$type<TrackArtist[]>(),
		albumLocal: text('album_local'),
		durationLocal: integer('duration_local'),
		bpmLocal: real('bpm_local'),
		keyLocal: text('key_local'),
		payload: text('payload', { mode: 'json' }).$type<unknown>(),
		// Local-file columns — populated only when source='local'. Streaming
		// providers leave these null and use the *_Local snapshot columns above
		// (which mean "what the remote source reported", not "an on-disk file").
		// Yes, the naming is collision-prone; the *_Local → *_Reported rename
		// is intentionally deferred until the AI tool surface lands.
		filePath: text('file_path'),
		fileFormat: text('file_format'),
		fileSize: integer('file_size'),
		fileMtime: integer('file_mtime', { mode: 'timestamp_ms' }),
		// Identity of the audio stream, independent of tags: a scheme-prefixed
		// key ("pcm-md5:" for FLAC/WAV/AIFF, the FLAC header's own MD5 of the
		// raw PCM; "mp3-sha256:" / "mp4-sha256:" over the frame region). Tag
		// rewrites (rekordbox, ID3 edits) change the file's bytes and mtime but
		// not this, so it is the key that survives the 2026-06 re-bind class of
		// incidents and the per-file tier of the shared catalogue.
		audioHash: text('audio_hash'),
		// Chromaprint of the first 120 s (the AcoustID window), written by the
		// analyzer's fingerprint stage for the file at file_path. Base64 string
		// plus the integer duration AcoustID lookups require alongside it.
		fingerprint: text('fingerprint'),
		fingerprintDurationSec: integer('fingerprint_duration_sec'),
		// Set when the watcher saw the file vanish. The row is kept (not deleted)
		// so a move or rename can re-bind the new path to this track by
		// audio_hash instead of minting a bare row; swept after 30 days.
		missingAt: integer('missing_at', { mode: 'timestamp_ms' }),
		fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		uniq: uniqueIndex('source_link_uniq').on(t.source, t.sourceTrackId),
		audioHashIdx: index('source_link_audio_hash_idx').on(t.audioHash),
		// Compound (trackId, source): covers the plain trackId lookups via the
		// leftmost prefix AND the (trackId IN (…) AND source = ?) shape used by
		// playlist add/remove + sync paths, which previously filtered source
		// in-memory after an index scan on trackId alone.
		trackSourceIdx: index('source_link_track_source_idx').on(t.trackId, t.source),
		sourceIdx: index('source_link_source_idx').on(t.source),
		filePathIdx: uniqueIndex('source_link_file_path_idx').on(t.filePath),
	})
);

// ─── PLAYLIST ────────────────────────────────────────────────────────────────
export const playlist = sqliteTable(
	'playlist',
	{
		id: text('id').primaryKey(),
		source: text('source', { enum: PLAYLIST_SOURCES }).notNull(),
		sourceId: text('source_id').notNull(),
		url: text('url'),
		name: text('name').notNull(),
		// Diacritic-folded shadow of `name`, mirrored at every write site via
		// `searchFold()`. Powers the omnibar's `#name` token: a playlist whose
		// ascii-folded name matches the typed name contributes to the union
		// semantics of `#name` (track satisfies `#name` if it has a tag named
		// `name` OR is in a playlist by that name). Nullable so unpatched rows
		// don't get clobbered; migration backfills existing rows on first boot.
		nameAscii: text('name_ascii'),
		description: text('description'),
		ownerName: text('owner_name'),
		ownerId: text('owner_id'),
		coverUrl: text('cover_url'),
		trackCount: integer('track_count'),
		followers: integer('followers'),
		isCollaborative: integer('is_collaborative', { mode: 'boolean' }),
		isPublic: integer('is_public', { mode: 'boolean' }),
		lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
		// When the source last reported a change. We update this whenever sync
		// detects a snapshot_id / cursor delta — it's the best signal Spotify
		// gives us (they don't expose a playlist-level modified timestamp).
		remoteUpdatedAt: integer('remote_updated_at', { mode: 'timestamp_ms' }),
		syncStatus: text('sync_status', {
			enum: ['pending', 'syncing', 'synced', 'error'] as const,
		})
			.notNull()
			.default('pending'),
		syncError: text('sync_error'),
		syncCursor: text('sync_cursor'),
		mark: text('mark'),
		isFavorite: integer('is_favorite', { mode: 'boolean' }).notNull().default(false),
		isHidden: integer('is_hidden', { mode: 'boolean' }).notNull().default(false),
		// "Hybrid" Spotify playlists also matched against Tidal. When true, the
		// matcher runs Tidal lookups for each track on sync (and on demand from
		// the context menu) and attaches tidal source_link rows. The Spotify
		// playlist remains the primary; Tidal is a per-track linkage layer.
		hybridTidal: integer('hybrid_tidal', { mode: 'boolean' }).notNull().default(false),
		// Parent folder in the provider's native folder tree (e.g. Spotify
		// rootlist, Tidal folders). Null = root. Populated by sync; treated as
		// advisory metadata — playlist sync must never block on a folder fetch
		// failure.
		parentFolderId: text('parent_folder_id'),
		// User's manual ordering within their parent folder (matches Rekordbox's
		// DjmdPlaylist.Seq). 0 default keeps streaming-provider rows working —
		// when missing we fall back to name-sort at read time.
		position: integer('position').notNull().default(0),
		// True for Rekordbox smart playlists (DjmdPlaylist.Attribute == 4).
		// We persist the definition row so the sidebar can surface it (greyed
		// out + "coming soon" watermark when clicked), but never populate
		// playlist_track for these — Rekordbox evaluates membership at
		// runtime from the SmartList criteria, which we don't reimplement.
		isSmart: integer('is_smart', { mode: 'boolean' }).notNull().default(false),
		// Set on the "<name> [WAV]" playlist that "Convert to WAV" builds from
		// another playlist. Re-running the conversion finds its target through
		// this, not by name — the derived playlist is re-keyed to `rb_<ID>`
		// (source='rekordbox') once it's created in rekordbox, and the user may
		// rename either side.
		derivedFromPlaylistId: text('derived_from_playlist_id'),
		// Rekordbox playlists only: the DjmdPlaylist.Name rekordbox last
		// reported (pull) or verified (push) — the name analogue of
		// rekordbox_link.fields_seen. `name != rbNameSeen` is how "Sync
		// updates" knows a Curator-side rename still has to reach rekordbox,
		// which lets it skip the ~110 no-op playlist_merge ops it used to send
		// every run. NULL = unknown → treated as changed (pushed once, then set).
		rbNameSeen: text('rb_name_seen'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		uniq: uniqueIndex('playlist_uniq').on(t.source, t.sourceId),
		sourceIdx: index('playlist_source_idx').on(t.source),
		parentIdx: index('playlist_parent_idx').on(t.parentFolderId),
		nameAsciiIdx: index('playlist_name_ascii_idx').on(t.nameAscii),
	})
);

// ─── PLAYLIST_FOLDER ─────────────────────────────────────────────────────────
// Provider-native folder hierarchy. Mirrors what each streaming service
// exposes (Spotify rootlist, Tidal folders, future rekordbox). Self-referential
// — `parentFolderId` null = root. Same `source` enum as playlist so the tree
// stays per-provider; cross-provider folder unions are out of scope.
export const playlistFolder = sqliteTable(
	'playlist_folder',
	{
		id: text('id').primaryKey(),
		source: text('source', { enum: PLAYLIST_SOURCES }).notNull(),
		sourceId: text('source_id').notNull(),
		parentFolderId: text('parent_folder_id'),
		name: text('name').notNull(),
		// Diacritic-folded shadow of `name` — same role as playlist.nameAscii;
		// reserved for the v2 `#foldername` search path. Maintained at every
		// write site so the column is consistent ahead of read-side support.
		nameAscii: text('name_ascii'),
		position: integer('position').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		uniq: uniqueIndex('playlist_folder_uniq').on(t.source, t.sourceId),
		parentIdx: index('playlist_folder_parent_idx').on(t.parentFolderId),
	})
);

// ─── LIBRARY_FOLDER ──────────────────────────────────────────────────────────
// On-disk folders watched for FLAC/M4A/WAV files. The scanner walks these,
// extracts metadata, and matches into the canonical track table.
export const libraryFolder = sqliteTable(
	'library_folder',
	{
		id: text('id').primaryKey(),
		path: text('path').notNull(),
		// User-supplied glob exclusions (e.g. **/.git/**, **/node_modules/**).
		excludeGlobs: text('exclude_globs', { mode: 'json' }).$type<string[] | null>(),
		watching: integer('watching', { mode: 'boolean' }).notNull().default(true),
		scanState: text('scan_state', {
			enum: ['idle', 'scanning', 'error'] as const,
		}).notNull().default('idle'),
		scanError: text('scan_error'),
		isFavorite: integer('is_favorite', { mode: 'boolean' }).notNull().default(false),
		addedAt: integer('added_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		lastScannedAt: integer('last_scanned_at', { mode: 'timestamp_ms' }),
	},
	(t) => ({
		pathIdx: uniqueIndex('library_folder_path_idx').on(t.path),
	})
);

// ─── TAG ─────────────────────────────────────────────────────────────────────
// User-applied labels on tracks. Two seeded system tags drive the
// "Interested" and "Basket" workflow tabs; user-created tags share the
// same surface and are exposed via the generic tagging UI (future).

export const tag = sqliteTable('tag', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	kind: text('kind', { enum: TAG_KINDS }).notNull(),
	color: text('color'),
	sortOrder: integer('sort_order').notNull().default(0),
	createdAt: integer('created_at', { mode: 'timestamp_ms' })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
});

export const trackTag = sqliteTable(
	'track_tag',
	{
		trackId: text('track_id')
			.notNull()
			.references(() => track.id, { onDelete: 'cascade' }),
		tagId: text('tag_id')
			.notNull()
			.references(() => tag.id, { onDelete: 'cascade' }),
		addedAt: integer('added_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.trackId, t.tagId] }),
		tagIdx: index('track_tag_tag_idx').on(t.tagId),
	})
);

// ─── PLAYLIST_TRACK ──────────────────────────────────────────────────────────
// One row per membership, so duplicates within a playlist are allowed (rare
// but real for DJ promo playlists). Source order preserved exactly.
//
// Order lives in `order_key`, a base-62 fractional index (@curator/protocol
// order-key.ts): the row's place is (order_key, id), so a drag rewrites one
// row's key and concurrent edits from two devices merge without renumbering.
// `position` is derived — 0..n-1 in (order_key, id) order, restamped by
// recomputePositions (apps/core/src/library/playlist-order.ts) after every
// membership change — and stays because every reader (the "#" column, the
// rekordbox exporter, Spotify's positional moves) speaks it. `id` is the
// row's identity on the wire; (playlist_id, position) stays unique.
export const playlistTrack = sqliteTable(
	'playlist_track',
	{
		id: text('id').primaryKey(),
		playlistId: text('playlist_id')
			.notNull()
			.references(() => playlist.id, { onDelete: 'cascade' }),
		trackId: text('track_id')
			.notNull()
			.references(() => track.id, { onDelete: 'cascade' }),
		orderKey: text('order_key').notNull(),
		position: integer('position').notNull(),
		addedAt: integer('added_at', { mode: 'timestamp_ms' }),
		addedBy: text('added_by'),
		sourceTrackId: text('source_track_id').notNull(),
	},
	(t) => ({
		positionUniq: uniqueIndex('playlist_track_position_uniq').on(t.playlistId, t.position),
		orderIdx: index('playlist_track_order_idx').on(t.playlistId, t.orderKey),
		trackIdx: index('playlist_track_track_idx').on(t.trackId),
	})
);

// ─── PINNED_SEARCH ─────────────────────────────────────────────────────────────
// A saved omnibar/drill query the user pins for quick re-access — Rekordbox's
// "smart playlist" minus the criteria-builder ceremony. We persist the QUERY,
// not its tracks: activation re-runs the grammar string through the same JIT
// scope path the omnibar uses (renderer/query.ts → enterJitScope), so results
// always reflect the live library. `sortColumn`/`sortDir` capture the ordering
// at pin time and restore it on activation; null falls back to the view's
// default sort. A pinned search can be "materialized" into a real, editable
// local playlist — that's a one-shot copy, not a live link.
export const pinnedSearch = sqliteTable(
	'pinned_search',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		query: text('query').notNull(),
		sortColumn: text('sort_column'),
		sortDir: text('sort_dir', { enum: ['asc', 'desc'] as const }),
		// Manual ordering within the Pinned folder. New pins land at the tail.
		position: integer('position').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		positionIdx: index('pinned_search_position_idx').on(t.position),
	})
);

// ─── TOKEN ───────────────────────────────────────────────────────────────────
// Auth credentials. Single-tenant for now → stored plaintext. Encryption
// at rest deferred until we deploy server-remote.
export const token = sqliteTable(
	'token',
	{
		source: text('source', { enum: PLAYLIST_SOURCES }).notNull(),
		kind: text('kind', {
			enum: ['access', 'refresh', 'session', 'app_credentials'] as const,
		}).notNull(),
		scope: text('scope', { enum: ['user', 'app'] as const }).notNull(),
		value: text('value').notNull(),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
		fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.source, t.kind, t.scope] }),
	})
);

// ─── APP_SETTING ─────────────────────────────────────────────────────────────
// Small JSON key/value store for settings that gate CORE behaviour (per-source
// sync preferences today). These used to live in renderer localStorage, which
// is keyed by browser origin — the dev renderer (http://localhost:517x) and the
// packaged one (file://) each had their own copy, so a toggle flipped in dev
// was silently OFF in the built app (2026-09-09: a month of Spotify playlist
// adds never pushed). Anything core reads to decide whether to write upstream
// belongs here, beside the DB it applies to, not in a per-origin browser store.
export const appSetting = sqliteTable('app_setting', {
	key: text('key').primaryKey(),
	value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
});

// ─── SYNC_JOB ────────────────────────────────────────────────────────────────
// Observability for the sync workers — what ran, when, what changed.
export const syncJob = sqliteTable('sync_job', {
	id: text('id').primaryKey(),
	source: text('source').notNull(),
	kind: text('kind').notNull(),
	targetId: text('target_id'),
	state: text('state', {
		enum: ['queued', 'running', 'done', 'failed'] as const,
	}).notNull(),
	startedAt: integer('started_at', { mode: 'timestamp_ms' }),
	finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
	stats: text('stats', { mode: 'json' }).$type<{
		added?: number;
		updated?: number;
		removed?: number;
		matched?: number;
	}>(),
	error: text('error'),
});

// ─── TRACK_ANALYSIS ──────────────────────────────────────────────────────────
// Output of the Essentia-based offline analyzer (apps/analyzer). One row per
// canonical track, separate table so a re-analysis can blow it away without
// touching the canonical `track` row.
//
// `beatgrid` / `downbeats` are Float32 LE blobs of beat-time seconds —
// reading is `new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength/4)`.
// Per-band peak data lives in a sidecar `.cpk` file at
// <userData>/peaks/<track-id>.cpk; this row only carries scalar features and
// the beatgrid (small enough to keep inline; useful for sort/filter).
//
// `features_json` is the full MusicExtractor blob — kept verbatim for forward
// compatibility (future UIs may want sub-features we haven't surfaced yet).
export const trackAnalysis = sqliteTable('track_analysis', {
	trackId: text('track_id')
		.primaryKey()
		.references(() => track.id, { onDelete: 'cascade' }),
	bpm: real('bpm'),
	// Packed Float32 little-endian arrays of beat-time seconds. Parse with
	// `new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)`.
	beatgrid: blob('beatgrid', { mode: 'buffer' }),
	downbeats: blob('downbeats', { mode: 'buffer' }),
	keyCamelot: text('key_camelot'),
	keyStrength: real('key_strength'),
	// Curator-aligned learned scores (analyzer 2.3.0+). `brightness` replaced the
	// raw spectral centroid; `power` is new. Both from scoring.py.
	brightness: real('brightness'),
	power: real('power'),
	dynamicComplexity: real('dynamic_complexity'),
	// EBU R128 loudness range (LU). The integrated LUFS sibling and the
	// true-peak column were dropped in analyzer 2.1.0 — see the matching
	// DROP COLUMN entries in apps/core/src/db/migrate.ts.
	loudnessRangeLu: real('loudness_range_lu'),
	dissonance: real('dissonance'),
	// Stored under a product name — Essentia's source value is
	// `lowlevel.spectral_complexity.mean`, but the column reflects what it means
	// in the curator surface (how layered the arrangement is).
	density: real('density'),
	// Phase 2A — structural segmentation. `segments_json` carries the full
	// labelled segment array; the five scalars are derived shortcuts the
	// renderer can sort/filter on without parsing JSON per-row. Mirrored
	// onto `track` (above) for the virtualized list. Confidence-gated: any
	// segment whose detection confidence is < 0.5 is labelled 'unknown' and
	// excluded from drop_count / breakdown_count. See _segment + _derive_segment_scalars
	// in apps/analyzer/src/curator_analyzer/worker.py.
	segmentsJson: text('segments_json', { mode: 'json' }).$type<SegmentRecord[] | null>(),
	introLengthSec: real('intro_length_sec'),
	outroLengthSec: real('outro_length_sec'),
	firstDropSec: real('first_drop_sec'),
	dropCount: integer('drop_count'),
	breakdownCount: integer('breakdown_count'),
	featuresJson: text('features_json', { mode: 'json' }).$type<Record<string, unknown> | null>(),
	duration: real('duration'),
	analyzerVersion: text('analyzer_version').notNull(),
	analyzedAt: integer('analyzed_at', { mode: 'timestamp_ms' }).notNull(),
	// The audio the Curator slot above was computed from: the analysed file's
	// `source_link.audio_hash`. It is the key the shared catalogue files this
	// row under (apps/core/src/catalogue/), so it is set only when the row is
	// known to describe that audio — a fresh analysis of the file, a row
	// already stamped with the same hash, or units pulled from the catalogue
	// under it — and cleared by the scanner when a known path's audio
	// changes. NULL = provenance unknown: never uploaded, never filled in from
	// the catalogue. The rb_* slot below is not covered by it.
	audioHash: text('audio_hash'),

	// ── Rekordbox slot ───────────────────────────────────────────────────────
	// Dual-source analysis: the columns above are Curator's own (the analyzer
	// writes them); these `rb_*` columns hold the Rekordbox-imported beatgrid,
	// segments, and key, written ONLY by the importer and never touched by the
	// analyzer. Both are kept so neither overwrites the other; a player setting
	// (`analysisSource`) chooses which the UI displays, and a future feature can
	// surface inconsistencies between them. Provenance is implicit by slot — no
	// origin enum needed (cf. `cue.origin`, which needs one because cues share a
	// table). NULL = that source has no value for this track.
	rbBeatgrid: blob('rb_beatgrid', { mode: 'buffer' }),
	rbDownbeats: blob('rb_downbeats', { mode: 'buffer' }),
	rbBpm: real('rb_bpm'),
	rbKeyCamelot: text('rb_key_camelot'),
	rbKeyStrength: real('rb_key_strength'),
	rbSegmentsJson: text('rb_segments_json', { mode: 'json' }).$type<SegmentRecord[] | null>(),
}, (t) => ({
	// The uploader and the hydrator find rows by the audio they describe.
	audioHashIdx: index('track_analysis_audio_hash_idx').on(t.audioHash),
}));

// Structural segments — stored as a JSON array on `track_analysis.segments_json`.
// Two sources can write here, distinguished by the per-record `source` field:
//
//   • 'analyzer' — produced by the analyzer's Stage 6 with the energy-arc
//     vocabulary (intro/build/drop/breakdown/main/outro, plus 'unknown' for
//     low-confidence segments). `confidence` is in [0,1]; segments below
//     0.5 already had their label set to 'unknown' before persistence.
//
//   • 'rekordbox' — extracted from PSSI tags in rb's ANLZ EXT files,
//     using rb's native song-form vocabulary (Intro 1/Up 1-3/Down/
//     Chorus 1/Outro 1 for "high" mood; Intro/Verse 1-6/Bridge/Chorus/
//     Outro for "mid"; Intro/Verse 1/Verse 2/Bridge/Chorus/Outro for "low").
//     `fillSec` is present on phrases carrying rb's end-of-phrase fill
//     marker; `rbKind` preserves the raw PSSI kind code (1..10) for
//     round-trip.
//
// Reader fallback: records written before this widening have no `source`
// field. Treat undefined as 'analyzer' — that's the only writer that
// existed prior to PSSI ingestion.
export type SegmentLabel =
	// analyzer-source labels (energy-arc — lowercase to distinguish from rb's)
	| 'intro' | 'build' | 'drop' | 'breakdown' | 'main' | 'outro' | 'unknown'
	// rekordbox high-mood phrase labels (with k-flag variants)
	| 'Intro 1' | 'Intro 2'
	| 'Up 1' | 'Up 2' | 'Up 3'
	| 'Down'
	| 'Chorus 1' | 'Chorus 2'
	| 'Outro 1' | 'Outro 2'
	// rekordbox mid/low-mood phrase labels (TitleCase to distinguish from analyzer's)
	| 'Intro' | 'Outro'
	| 'Verse 1' | 'Verse 2' | 'Verse 3' | 'Verse 4' | 'Verse 5' | 'Verse 6'
	| 'Bridge' | 'Chorus';

export type SegmentSource = 'analyzer' | 'rekordbox';

export type SegmentRecord = {
	startSec: number;
	endSec: number;
	label: SegmentLabel;
	// Writer discriminator. Records missing this field were written before
	// the rb-ingestion path landed; readers must default them to 'analyzer'.
	source?: SegmentSource;
	// Analyzer-only fields.
	confidence?: number;  // 0..1 — novelty z-score strength at the boundary
	energy?: number;      // 0..1 — mean per-beat loudness within the segment
	// Rekordbox-only fields.
	fillSec?: number;     // end-of-phrase fill-in marker (track-time seconds)
	rbKind?: number;      // raw PSSI kind code (1..10), mood-dependent meaning
};

// ─── CUE ─────────────────────────────────────────────────────────────────────
// Hot cues + memory cues. A row with `lengthSec` null/0 is a point cue;
// `lengthSec` > 0 makes it a loop region. `slot` is 0–7 (8 hot + 8 memory
// matches rekordbox-export limits cleanly; later we'll lift the cap if the
// rekordbox round-trip needs more).

export const cue = sqliteTable(
	'cue',
	{
		id: text('id').primaryKey(),
		trackId: text('track_id')
			.notNull()
			.references(() => track.id, { onDelete: 'cascade' }),
		slot: integer('slot').notNull(),
		positionSec: real('position_sec').notNull(),
		lengthSec: real('length_sec'), // null/0 = point cue, >0 = loop
		color: text('color'),
		name: text('name'),
		kind: text('kind', { enum: CUE_KINDS }).notNull(),
		origin: text('origin', { enum: CUE_ORIGINS }).notNull().default('curator'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		uniq: uniqueIndex('cue_track_slot_kind_uniq').on(t.trackId, t.slot, t.kind),
		trackIdx: index('cue_track_idx').on(t.trackId),
	})
);

// ─── ANALYSIS_JOB ────────────────────────────────────────────────────────────
// Persisted analyzer queue. Mirrors the download_job model — in-memory queue
// hydrates from here on boot and writes back on every state transition.
// `running` is reset to `queued` at boot so a mid-flight job picks up cleanly
// after a crash/restart. Priority is a plain integer (higher = sooner), with
// dispatch ordering = (priority DESC, enqueuedAt ASC). Per-user explicit
// reanalysis bumps priority to 100; scanner-driven eager analysis sits at 0.

export const analysisJob = sqliteTable(
	'analysis_job',
	{
		trackId: text('track_id')
			.primaryKey()
			.references(() => track.id, { onDelete: 'cascade' }),
		state: text('state', { enum: ANALYSIS_STATES }).notNull(),
		priority: integer('priority').notNull().default(0),
		error: text('error'),
		errorKind: text('error_kind'),
		enqueuedAt: integer('enqueued_at', { mode: 'timestamp_ms' }).notNull(),
		startedAt: integer('started_at', { mode: 'timestamp_ms' }),
		finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
	},
	(t) => ({
		dispatchIdx: index('analysis_job_dispatch_idx').on(t.state, t.priority, t.enqueuedAt),
	})
);

// ─── DOWNLOAD_JOB ────────────────────────────────────────────────────────────
// Persisted Tidal-download queue — one row per track. The in-memory
// DownloadQueue hydrates from this table on service init and writes back on
// every state transition. `downloading` is reset to `pending` at boot so the
// drain loop picks up where it left off without leaving stuck rows.
export const downloadJob = sqliteTable('download_job', {
	trackId: text('track_id').primaryKey(),
	trackTitle: text('track_title').notNull(),
	artistName: text('artist_name').notNull().default(''),
	state: text('state', {
		enum: ['pending', 'downloading', 'done', 'error', 'skipped'] as const,
	}).notNull(),
	pct: integer('pct').notNull().default(0),
	bytes: integer('bytes'),
	outputPath: text('output_path'),
	error: text('error'),
	errorKind: text('error_kind'),
	enqueuedAt: integer('enqueued_at', { mode: 'timestamp_ms' }).notNull(),
	startedAt: integer('started_at', { mode: 'timestamp_ms' }),
	finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
});

// ─── REKORDBOX_LINK ──────────────────────────────────────────────────────────
// Per-track Rekordbox provenance. One row per canonical track we've imported
// from a Rekordbox master.db. Lets us answer "was this synced from Rekordbox,
// and at what USN?" without scanning every other table. The write-back phase
// (deferred) bumps rb_local_usn whenever it pushes a change back so Rekordbox
// Cloud Sync notices.
export const rekordboxLink = sqliteTable(
	'rekordbox_link',
	{
		trackId: text('track_id')
			.primaryKey()
			.references(() => track.id, { onDelete: 'cascade' }),
		rbContentId: text('rb_content_id').notNull(),         // DjmdContent.ID
		rbLocalUsn: integer('rb_local_usn').notNull(),
		rbFilePath: text('rb_file_path'),                     // normalized; used for re-match if files move
		importedAt: integer('imported_at', { mode: 'timestamp_ms' }).notNull(),
		// Bumped by applyTrackDelta on every tracks-scope pass — distinct from
		// imported_at (first-seen). Use this to answer "is this link fresh?"
		// (i.e. confirmed by a recent sync, vs. a stale row whose RB source
		// may have been deleted but our recent sync didn't run the tracks
		// scope to notice). Non-tracks scopes (cues, playlists, mytags,
		// waveforms) do NOT bump this — they trust the tracks scope as the
		// freshness signal.
		lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }).notNull(),
		// Last VERIFIED push of this link (set by the exporter's baseline
		// advance, never by the importer). Null = Curator has never written
		// this track to rekordbox. The "Sync updates" scope includes every
		// null row: a track curated in Curator BEFORE its file was imported
		// into rekordbox has track.updatedAt older than the rb row's
		// updated_at, so the LMW-based `updatedAt > rbUpdatedAtSeen` sweep
		// alone would never push its rating/tags (2026-09-15).
		pushedAt: integer('pushed_at', { mode: 'timestamp_ms' }),
		// Rekordbox's `djmdContent.updated_at` value as seen at the last
		// import. The merge policy uses it as a baseline for the "last
		// modified wins" decision: rbChanged iff rb.updated_at > seen;
		// curatorChanged iff track.updatedAt > seen. When both changed in
		// the same window, the higher wall-clock timestamp wins.
		// Nullable for rows that predate this migration; the migration
		// backfills them to the matching track.updatedAt so old links treat
		// "now" as the in-sync baseline.
		rbUpdatedAtSeen: integer('rb_updated_at_seen', { mode: 'timestamp_ms' }),
		// Three-way-merge baselines: rb's field values / cue set as last
		// seen (pulled) or written (pushed). Null = no snapshot yet — the
		// importer falls back to the whole-row decideRbWins decision for
		// that track and seeds the snapshot. Once present, the merge engine
		// in packages/library-logic/src/merge.ts compares per field / per cue unit
		// and only true both-sides-changed divergence becomes a conflict.
		fieldsSeen: text('fields_seen', { mode: 'json' }).$type<FieldsSeen | null>(),
		cuesSeen: text('cues_seen', { mode: 'json' }).$type<CueUnit[] | null>(),
	},
	(t) => ({
		uniqContent: uniqueIndex('rekordbox_link_content_uniq').on(t.rbContentId),
		pathIdx: index('rekordbox_link_path_idx').on(t.rbFilePath),
	})
);

// ─── SYNC_CONFLICT ───────────────────────────────────────────────────────────
// Pending both-sides-changed conflicts from DJ-app sync (provider-keyed —
// shared across Rekordbox and future Traktor/Serato providers). Rows are
// persisted, not held in memory, for two reasons:
//   1. The conflict pause in the sync pipeline survives renderer reload /
//      app restart — the user can walk away and resolve later.
//   2. The importer's USN watermark advances past a delta the moment it's
//      read; capturing the external value here (theirsJson) means a
//      deferred conflict can still be resolved after the watermark moved.
// Resolution deletes the row (see resolveSyncConflicts in service.ts);
// while open, the exporter shields the field/cue from the push.
export const syncConflict = sqliteTable(
	'sync_conflict',
	{
		id: text('id').primaryKey(),
		provider: text('provider').$type<DjSyncProvider>().notNull(),
		trackId: text('track_id')
			.notNull()
			.references(() => track.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: ['field', 'cue'] }).notNull(),
		// SyncFieldKey for kind='field'; cueUnitKey() ('hot:3' /
		// 'memory:<posMs>') for kind='cue'.
		fieldKey: text('field_key').notNull(),
		// Snapshot values at detection time. theirsJson is the external
		// app's value (CueUnit | scalar | null = deleted on that side);
		// baseJson is the last-sync baseline shown as "was: X". Curator's
		// own value is intentionally NOT stored — it's read live at listing
		// time so the modal always shows the current state.
		baseJson: text('base_json', { mode: 'json' }).$type<unknown>(),
		theirsJson: text('theirs_json', { mode: 'json' }).$type<unknown>(),
		detectedAt: integer('detected_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(t) => ({
		uniq: uniqueIndex('sync_conflict_uniq').on(t.provider, t.trackId, t.kind, t.fieldKey),
		trackIdx: index('sync_conflict_track_idx').on(t.trackId),
	})
);

// ─── PLAYLIST_CONFLICT ───────────────────────────────────────────────────────
// Playlist-scoped both-sides-changed conflicts that can't be keyed on a single
// track (sync_conflict is trackId-keyed). Currently only `order`: both Curator
// and rekordbox reordered the same playlist relative to the membership
// baseline. While open, the exporter shields that playlist's reorder op (the
// member set still merges; only ordering is held). Resolution deletes the row.
export const playlistConflict = sqliteTable(
	'playlist_conflict',
	{
		id: text('id').primaryKey(),
		provider: text('provider').$type<DjSyncProvider>().notNull(),
		// The rekordbox-side playlist id (DjmdPlaylist.ID), matching
		// rekordbox_membership_baseline.rbPlaylistId — NOT the `rb_`-prefixed
		// Curator playlist id.
		rbPlaylistId: text('rb_playlist_id').notNull(),
		kind: text('kind', { enum: ['order'] as const }).notNull(),
		// Member-id order snapshots at detection: baseJson = last-agreed order,
		// theirsJson = rekordbox's current order. Curator's order is read live
		// at listing time (same convention as sync_conflict).
		baseJson: text('base_json', { mode: 'json' }).$type<string[]>(),
		theirsJson: text('theirs_json', { mode: 'json' }).$type<string[]>(),
		detectedAt: integer('detected_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(t) => ({
		uniq: uniqueIndex('playlist_conflict_uniq').on(t.provider, t.rbPlaylistId, t.kind),
	})
);

// ─── REKORDBOX_MEMBERSHIP_BASELINE ───────────────────────────────────────────
// Per-playlist 3-way-merge ancestor for playlist MEMBERSHIP (which tracks are
// in a playlist + their order) — the membership analogue of
// rekordbox_link.fieldsSeen. Records the last membership Curator and rekordbox
// agreed on. Without it, "track absent in Curator" is ambiguous between "Curator
// deleted it" and "rekordbox has it, Curator never imported it"; the baseline
// disambiguates, which is what lets the merge avoid the wholesale wipe.
//
// Member identity is cross-side and survives a Curator entity-delete (it is NOT
// the curator trackId for linked tracks):
//   kind='rb'      → memberId = DjmdContent.ID (rb_content_id)
//   kind='curator' → memberId = curator trackId (Curator-only adds, no rb link yet)
//
// rbPlaylistId is the raw rb-side id (DjmdPlaylist.ID), not `rb_`-prefixed.
export const rekordboxMembershipBaseline = sqliteTable(
	'rekordbox_membership_baseline',
	{
		rbPlaylistId: text('rb_playlist_id').notNull(),
		memberKind: text('member_kind', { enum: ['rb', 'curator'] as const }).notNull(),
		memberId: text('member_id').notNull(),
		position: integer('position').notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.rbPlaylistId, t.memberKind, t.memberId] }),
		playlistIdx: index('rb_membership_baseline_playlist_idx').on(t.rbPlaylistId),
	})
);

// ─── REKORDBOX_DELETED_CONTENT ───────────────────────────────────────────────
// Entity-level tombstones: a track destructively deleted from Curator that had
// a rekordbox_link. Keyed by rb_content_id (the link is cascade-gone). The
// import merge consults this so a rekordbox re-add of deleted content resolves
// to "remove from rekordbox" rather than resurrecting the track into Curator.
// Cleared only when the user deliberately re-imports that content.
export const rekordboxDeletedContent = sqliteTable('rekordbox_deleted_content', {
	rbContentId: text('rb_content_id').primaryKey(),
	deletedAt: integer('deleted_at', { mode: 'timestamp_ms' })
		.notNull()
		.default(sql`(unixepoch() * 1000)`),
	// When the delete was propagated to rekordbox itself (content_delete op
	// verified, or the rb row was already gone). NULL = not yet pushed — the
	// exporter emits a content_delete for it on every push until it lands.
	// Pre-existing tombstones were grandfathered to pushed_at = deleted_at by
	// the migration: they predate collection-delete propagation, and pushing
	// hundreds of months-old deletes on the first sync after upgrade would be
	// a large silent write the user never previewed.
	pushedAt: integer('pushed_at', { mode: 'timestamp_ms' }),
});

// ─── METRIC_CUTOFFS ──────────────────────────────────────────────────────────
// Library-wide percentile boundaries for each analyzer scalar. One row per
// metric (six metrics → six rows). Stores the 20/40/60/80 percentile values
// of the user's *analyzed* tracks; the read path uses these to assign each
// track a 1–5 bucket without recomputing percentiles per query.
//
// Recomputed by apps/core/src/analyzer/cutoffs.ts on two triggers:
//   1. App boot, if the analyzed-row count has drifted >5% from sampleCount.
//   2. Debounced (30s) after every batch of N completed analyses.
//
// Bucket assignment is done in-memory after rows return from getTracks; we
// keep the cutoffs out of the SQL CASE so the read path stays a plain SELECT.

export const metricCutoffs = sqliteTable('metric_cutoffs', {
	metric: text('metric', { enum: METRIC_NAMES }).primaryKey(),
	cutoff20: real('cutoff_20').notNull(),
	cutoff40: real('cutoff_40').notNull(),
	cutoff60: real('cutoff_60').notNull(),
	cutoff80: real('cutoff_80').notNull(),
	// Number of analyzed rows the cutoffs were computed over. Boot-time staleness
	// check compares this to the current analyzed count to decide whether to recompute.
	sampleCount: integer('sample_count').notNull(),
	computedAt: integer('computed_at', { mode: 'timestamp_ms' }).notNull(),
});

// ─── REKORDBOX_SYNC_WATERMARK ────────────────────────────────────────────────
// One row per Rekordbox table we've synced. After each successful incremental
// pass we update last_usn to the maximum rb_local_usn we observed; the next
// pass uses `WHERE rb_local_usn > last_usn` to pull only changed rows.
// Trivially small (≤ ~10 rows total); kept in SQLite for crash-resilience.
export const rekordboxSyncWatermark = sqliteTable('rekordbox_sync_watermark', {
	tableName: text('table_name').primaryKey(),  // 'DjmdContent' | 'DjmdCue' | 'DjmdPlaylist' | …
	lastUsn: integer('last_usn').notNull(),
	lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }).notNull(),
});

// ─── PLAY_SESSION / PLAY_EVENT ───────────────────────────────────────────────
// Per-play audit log. Two producers:
//   - Curator's own player (renderer PlayTracker → plays:record IPC): rich
//     events with audible-ms accumulation, duration snapshot, ended reason.
//   - Rekordbox history import (djmdHistory/djmdSongHistory): order + timestamp
//     only — rekordbox records no per-play duration, so playedMs/played75 are
//     NULL for those rows.
// Sessions group "tracks played together": rekordbox sessions map 1:1 to
// djmdHistory rows; curator plays are grouped gap-based (~30 min idle → new
// session) at insert time in the plays module.

// Wire shape for the renderer PlayTracker → plays:record IPC channel. The
// same id is upserted repeatedly: first flush inserts (final=false), 30s
// checkpoints update playedMs/maxPositionMs while playing (crash resilience —
// an abandoned non-final row reads as an interrupted play), the finalize
// flush sets final=true + endedReason. Session assignment happens core-side.
export type PlayRecordUpsert = {
	id: string;
	trackId: string | null;
	sourceTrackId: string | null;
	source: Extract<PlaySource, 'local' | 'spotify'>;
	startedAt: number;
	playedMs: number;
	durationMs: number | null;
	maxPositionMs: number;
	endedReason: PlayEndedReason | null;
	contextType: string | null;
	contextId: string | null;
	final: boolean;
};

export const playSession = sqliteTable(
	'play_session',
	{
		id: text('id').primaryKey(),
		origin: text('origin', { enum: PLAY_SESSION_ORIGINS }).notNull(),
		kind: text('kind', { enum: PLAY_SESSION_KINDS }).notNull().default('unknown'),
		// 'user' = manual override — the import classifier must never overwrite
		// kind/kindSource once the user has set it.
		kindSource: text('kind_source', { enum: ['auto', 'user'] }).notNull().default('auto'),
		name: text('name'), // rekordbox: "HISTORY yyyy-mm-dd (n)"; curator: null
		startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
		endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
		rbHistoryId: text('rb_history_id'), // djmdHistory.ID; null for curator sessions
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		rbUniq: uniqueIndex('play_session_rb_history_uniq').on(t.rbHistoryId),
		startedIdx: index('play_session_started_idx').on(t.startedAt),
		originStartedIdx: index('play_session_origin_started_idx').on(t.origin, t.startedAt),
	})
);

export const playEvent = sqliteTable(
	'play_event',
	{
		id: text('id').primaryKey(), // uuid; renderer-generated for curator plays
		sessionId: text('session_id')
			.notNull()
			.references(() => playSession.id, { onDelete: 'cascade' }),
		// Nullable + SET NULL: play history is an audit log and must survive hard
		// track deletion. rbContentId / sourceTrackId keep enough identity to
		// re-link later (the history import runs a heal pass on rb_content_id).
		trackId: text('track_id').references(() => track.id, { onDelete: 'set null' }),
		rbContentId: text('rb_content_id'),
		sourceTrackId: text('source_track_id'), // spotify id / file path; feed plays have no trackId
		source: text('source', { enum: PLAY_SOURCES }).notNull(),
		// NULL for bulk-imported USB sessions: their djmdSongHistory timestamps are
		// the import instant, not play time — only trackNo order is real there.
		playedAt: integer('played_at', { mode: 'timestamp_ms' }),
		playedMs: integer('played_ms'), // audible ms accumulated; NULL for rekordbox rows
		durationMs: integer('duration_ms'), // track duration snapshot at play time
		maxPositionMs: integer('max_position_ms'),
		// Computed once at finalize (playedMs >= 0.75 * durationMs). NULL when
		// unknowable (rekordbox rows, or curator plays with no duration snapshot).
		played75: integer('played75', { mode: 'boolean' }),
		endedReason: text('ended_reason', { enum: PLAY_ENDED_REASONS }),
		contextType: text('context_type'), // curator only: 'playlist' | 'tag' | 'search' | 'feed' | 'all' | …
		contextId: text('context_id'),
		trackNo: integer('track_no'), // rekordbox ordering within session
		rbSongHistoryId: text('rb_song_history_id'), // djmdSongHistory.ID
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch() * 1000)`),
	},
	(t) => ({
		rbUniq: uniqueIndex('play_event_rb_song_uniq').on(t.rbSongHistoryId),
		trackPlayedIdx: index('play_event_track_played_idx').on(t.trackId, t.playedAt),
		sessionIdx: index('play_event_session_idx').on(t.sessionId),
		playedAtIdx: index('play_event_played_at_idx').on(t.playedAt),
		rbContentIdx: index('play_event_rb_content_idx').on(t.rbContentId),
	})
);

// ─── SYNC (cloud op log, desktop side) ───────────────────────────────────────
// Local state for the per-user op log (cloud design: "The op", "Client apply
// on the desktop"). Written by apps/core/src/sync-log (emitOps from every
// library mutator, applyOps for incoming ops); the client that drains the
// outbox and pulls lands in cloud plan C.

// Ops this device has made and not yet had accepted. `seq_local` orders the
// push; `payload` is the zod-validated JSON body (@curator/protocol ops.ts).
// `state` (SYNC_OUTBOX_STATES): pending until the server accepts or refuses
// it (with `reason`). The push loop reads pending rows in seq_local order,
// hence the (state, seq_local) index.

export const syncOutbox = sqliteTable(
	'sync_outbox',
	{
		opId: text('op_id').primaryKey(),
		seqLocal: integer('seq_local').notNull(),
		deviceId: text('device_id').notNull(),
		clientTs: integer('client_ts').notNull(),
		schemaVersion: integer('schema_version').notNull(),
		entity: text('entity').notNull(),
		entityId: text('entity_id').notNull(),
		kind: text('kind').notNull(),
		payload: text('payload').notNull(),
		state: text('state', { enum: SYNC_OUTBOX_STATES }).notNull().default('pending'),
		reason: text('reason'),
		createdAt: integer('created_at').notNull(),
	},
	(t) => ({
		stateSeqIdx: index('sync_outbox_state_seq_idx').on(t.state, t.seqLocal),
	})
);

// Pull position per stream (`key`, e.g. the library log): the last server
// `seq` applied, and the snapshot it bootstrapped from, if any.
export const syncCursor = sqliteTable('sync_cursor', {
	key: text('key').primaryKey(),
	lastSeq: integer('last_seq').notNull().default(0),
	snapshotSeq: integer('snapshot_seq'),
});

// Pulled ops from a newer protocol version than this build reads (design:
// `sync_inbox_held`): set aside so everything else keeps applying and the
// cursor keeps moving, and replayed in `seq` order once an update can read
// them. `op` is the stored op's wire JSON, kept verbatim — this build cannot
// parse it.
export const syncInboxHeld = sqliteTable('sync_inbox_held', {
	seq: integer('seq').primaryKey(),
	opId: text('op_id').notNull(),
	schemaVersion: integer('schema_version').notNull(),
	op: text('op').notNull(),
	heldAt: integer('held_at').notNull(),
});

// Catalogue aliases applied locally: ops addressed to `loser` are redirected
// to `winner`. Chains are flattened on write, so a lookup is one hop.
export const recordingAlias = sqliteTable('recording_alias', {
	loser: text('loser').primaryKey(),
	winner: text('winner').notNull(),
});

// Deletes the op log must remember after the row itself is gone, so a late
// op for the entity cannot resurrect it (container deletes win). This IS the
// reducer's `tombstones` map (@curator/protocol state.ts), so it carries the
// delete's whole clock: the cue rule compares (client_ts, device_id, op_id),
// not the timestamp alone. `entity_id` of a track_tag / cue tombstone is the
// composite `${recordingId}:…`; `recording_id` repeats its recording part so a
// recording merge can find the loser's tombstones by index.
export const tombstone = sqliteTable(
	'tombstone',
	{
		entity: text('entity').notNull(),
		entityId: text('entity_id').notNull(),
		clientTs: integer('client_ts').notNull(),
		deviceId: text('device_id'),
		opId: text('op_id'),
		recordingId: text('recording_id'),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.entity, t.entityId] }),
		recordingIdx: index('tombstone_recording_idx').on(t.recordingId),
	})
);

// The rest of the reducer's raw records (sync-log/store.ts): one row per
// record of every LibraryState map except `tombstones` (above) and the
// derived `recordingAlias` (the recording_alias table). `value` is the record
// as JSON, clocks included — the visible tables (tag, playlist_track, …) are
// a projection of these, and per-field LWW needs the clock of the write that
// set each field, including for records the visible tables cannot hold yet
// (an edit that arrived before its create, a move before its add).
// `recording_id` / `parent_id` index the records a recording merge folds and
// the children a container's visibility gates (a tag's track_tags, a
// playlist's rows, a session's events).
export const syncState = sqliteTable(
	'sync_state',
	{
		map: text('map').notNull(),
		key: text('key').notNull(),
		recordingId: text('recording_id'),
		parentId: text('parent_id'),
		value: text('value').notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.map, t.key] }),
		recordingIdx: index('sync_state_recording_idx').on(t.recordingId),
		parentIdx: index('sync_state_parent_idx').on(t.map, t.parentId),
	})
);

// ─── CATALOGUE (device-local) ────────────────────────────────────────────────
// This device's mirror of the account's shared analysis catalogue
// (apps/core/src/catalogue/; protocol packages/protocol/src/catalogue.ts):
// one row per (audio hash, unit, variant) the server holds — the newest
// version it named, from `catalogue.inventory` pages or this device's own
// puts — and what this device did with it. Never synced and never sent
// anywhere: it is a cache of the server, rebuilt from rev 0 when the
// signed-in account changes (`catalogue.account` in app_setting).
//
// `local_state`:
//   remote    the server holds it; not applied here yet (or no live track
//             with this hash existed when it was looked at)
//   hydrated  applied to every live local track with the hash that lacked it
//   uploaded  this device put it (its own analysis)
//   skipped   looked at and refused (duration guard, unreadable blob, a
//             schema or version this build cannot use); retried only when
//             a newer version arrives
//   rejected  this device's put of `version_key` was refused for good
//             (invalid_item, unit_disabled, version_outdated…); not re-sent
//             until the local analysis changes version
// `version_key` is the version as dotted integers ('2.4.0'), `remote_rev`
// the server's rev for it (0 while only known locally), `bytes` what a
// hydrate of it costs (inline data + blob).
export const CATALOGUE_LOCAL_STATES = ['remote', 'hydrated', 'uploaded', 'skipped', 'rejected'] as const;
export type CatalogueLocalState = (typeof CATALOGUE_LOCAL_STATES)[number];
export const catalogueEntry = sqliteTable(
	'catalogue_entry',
	{
		audioHash: text('audio_hash').notNull(),
		unit: text('unit').notNull(),
		variant: text('variant').notNull(),
		versionKey: text('version_key').notNull(),
		remoteRev: integer('remote_rev').notNull().default(0),
		bytes: integer('bytes').notNull().default(0),
		localState: text('local_state', { enum: CATALOGUE_LOCAL_STATES }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.audioHash, t.unit, t.variant] }),
		// The hydrator's "what is still to apply" scan.
		stateIdx: index('catalogue_entry_state_idx').on(t.localState),
	})
);

// Rekordbox's own value of each analysis unit (the rb slot's grid, key and
// phrases) as THIS device's importer last read it — a digest, not the value.
// Device-local by design: it describes this machine's rekordbox library, and
// never rides an op.
//
// Why (cloud plan, Workstream E): the slot also receives other devices'
// rekordbox values through the op log. Two desktops whose rekordbox libraries
// disagree on a unit used to flip it back on every full re-import, because
// the importer emitted whenever rekordbox's value differed from the synced
// one. With the baseline it emits only when rekordbox changed the unit since
// this device last read it; otherwise the synced value stands (the slot is
// put back) — last CHANGE wins, not last import. A unit with no baseline
// yet (first import after upgrade, a new link) is treated as changed once.
export const RB_SEEN_UNITS = ['grid', 'key', 'segments'] as const;
export const rekordboxUnitSeen = sqliteTable(
	'rekordbox_unit_seen',
	{
		trackId: text('track_id').notNull().references(() => track.id, { onDelete: 'cascade' }),
		unit: text('unit', { enum: RB_SEEN_UNITS }).notNull(),
		// Grid and phrases: sha1 of the stored form; key: the Camelot string.
		digest: text('digest').notNull(),
		seenAt: integer('seen_at', { mode: 'timestamp_ms' }).notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.trackId, t.unit] }),
	})
);

// ─── TRACK META SYNC (device-local) ──────────────────────────────────────────
// What lets this device's base metadata reach the others as
// `library_track.set-meta` (apps/core/src/sync-log/track-meta.ts) without
// re-reading 40k rows per sync cycle.
//
// `track_meta_dirty`: rows whose meta may have changed since they were last
// stated. Filled by SQLite triggers on track (insert, and an update of any
// meta column) and on source_link (insert/delete: the row's source may
// flip), so every writer is covered — the rekordbox importer, for one,
// rewrites columns without bumping updated_at. Drained in chunks by the
// sync client once the server reads protocol v3.
//
// `track_meta_seen`: the digest of the meta last emitted per row — the
// baseline that turns a dirty mark into "emit only if it really changed"
// (a re-import restating the same tags costs a read, not an op).
export const trackMetaDirty = sqliteTable('track_meta_dirty', {
	trackId: text('track_id').primaryKey(),
});
export const trackMetaSeen = sqliteTable('track_meta_seen', {
	trackId: text('track_id').primaryKey().references(() => track.id, { onDelete: 'cascade' }),
	recordingId: text('recording_id').notNull(),
	digest: text('digest').notNull(),
	seenAt: integer('seen_at', { mode: 'timestamp_ms' }).notNull(),
});

// Remote rows (track.remoteOnly) whose derived tables — the artist junction,
// the album — are still to be built. A fresh device materialises the whole
// account at once; deriving 40k rows' junctions inside the projection would
// stall the main loop, so materialisation queues them here and the sync
// client drains the queue in chunks (sync-log/remote-rows.ts).
export const trackDerivePending = sqliteTable('track_derive_pending', {
	trackId: text('track_id').primaryKey(),
});

// Recordings whose remote row is still to be made: a batch makes at most a
// handful inline (remote-rows.ts INLINE_CREATE_ROWS) and queues the rest
// here for the same kind of sliced drain, so a fresh device's first pull or
// snapshot never makes 40k rows inside one transaction.
export const trackRemotePending = sqliteTable('track_remote_pending', {
	recordingId: text('recording_id').primaryKey(),
});

// ─── CLAIM LINKS (device-local, derived) ─────────────────────────────────────
// Provider ids this device knows for a row only because the account's
// recording claims say so (`recording_claim` spotify / tidal / beatport —
// another device ingested or matched them), never because this device
// ingested them (apps/core/src/sync-log/claim-links.ts). source_link is
// device-local, so without these a second desktop shows empty Spotify /
// Tidal / Beatport URLs for every track whose link another device made.
//
// A table of their own, deliberately NOT source_link rows with a marker:
// every source_link reader is an "this device holds it" reader — the
// upstream pushes and removals (deleteTracks, removeTrackSources, playlist
// add/remove, pushPlaylistLocalOnly), the remote-row → own-row triggers,
// membership, the identity resolver's own-row counts, the initial push and
// the claims backfill, the UNIQUE(source, source_track_id) ingest guard.
// Kept apart, a derived id can reach none of them by construction; the few
// readers that may use one (display, Open-in, the hybrid matcher's
// "already matched") opt in by reading this table.
//
// One row per (row, provider) at most: the recording's best claim of that
// kind (highest confidence, then latest). Never where the row has its own
// source_link for the provider — an own link always wins (migrate.ts
// trigger deletes the derived one when it lands).
export const claimLink = sqliteTable(
	'claim_link',
	{
		trackId: text('track_id')
			.notNull()
			.references(() => track.id, { onDelete: 'cascade' }),
		source: text('source', { enum: SOURCES }).notNull(),
		sourceTrackId: text('source_track_id').notNull(),
		// The recording the claim was read from — the row's at derivation
		// time; a rebind (merge) re-derives.
		recordingId: text('recording_id').notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.trackId, t.source] }),
		recordingIdx: index('claim_link_recording_idx').on(t.recordingId),
	})
);

// Recordings whose claim links are to be (re)derived: queued by triggers on
// track (a row appears or is rebound) and source_link (an own link goes),
// and by the projection for every recording whose claims a batch changed;
// drained in slices by the sync client (or inline for a handful).
export const claimLinkPending = sqliteTable('claim_link_pending', {
	recordingId: text('recording_id').primaryKey(),
});

// Provider ids this device dropped from a row on purpose (an own link
// deleted or replaced: the Edit screen's ×, Delete-from-Spotify, a merge's
// duplicate): never derived back onto that row. Claims are append-only, so
// without this a link the user removed would return as a derived one.
export const claimLinkVeto = sqliteTable(
	'claim_link_veto',
	{
		trackId: text('track_id').notNull(),
		source: text('source', { enum: SOURCES }).notNull(),
		sourceTrackId: text('source_track_id').notNull(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.trackId, t.source, t.sourceTrackId] }),
	})
);

// Drizzle-inferred row types
// The DB row, plus optional aggregated fields that some read paths attach:
//   - `sources` — filled by getTracks via batched source_link + rekordbox_link
//     queries ('rekordbox' has no source_link row) so the UI can show
//     per-source indicators and the query grammar's `source:` term can match
//     in memory without per-row IPC.
//   - `*Level` (six fields) — filled by getTracks via the in-memory metric-
//     cutoff store. Null when the raw metric is null (track not analyzed).
export type Track = typeof track.$inferSelect & {
	sources?: string[];
	// Providers this row has only a claim-derived id for (claim_link: known
	// from the account, not ingested here) — display only. Never part of
	// `sources`, which means "this device holds it there" to every command
	// that pushes upstream, downloads or filters by source.
	claimSources?: string[];
	// Curator artist ids aligned index-for-index with `artists` (the
	// effective list). Attached by decorateTracks from track_artist; absent
	// on read paths that don't decorate. Drives the artist chips' click →
	// scope and the in-memory `artistid={…}` match.
	artistIds?: string[];
	// Ascii-folded names of every playlist the track is in. Attached by
	// getTracks via a batched playlist_track ↔ playlist join. Drives the
	// in-memory matchTrack pass for `#name` tokens (track satisfies `#name`
	// if any entry here equals `searchFold(name)`). Null/undefined → not yet
	// computed (e.g. read paths that don't decorate).
	playlistNamesAscii?: string[];
	brightnessLevel?: MetricLevel | null;
	powerLevel?: MetricLevel | null;
	dissonanceLevel?: MetricLevel | null;
	densityLevel?: MetricLevel | null;
	loudnessRangeLuLevel?: MetricLevel | null;
	dynamicComplexityLevel?: MetricLevel | null;
	introLengthSecLevel?: MetricLevel | null;
	outroLengthSecLevel?: MetricLevel | null;
	firstDropSecLevel?: MetricLevel | null;
	// Attached only when the read targets a single playlist (filter.playlistId).
	// Mirrors playlist_track.position — the canonical "#" the user sees in the
	// idx column. Stays stable across client-side re-sort/filter because it's
	// the track's identity within the playlist, not its visible-array index.
	playlistPosition?: number | null;
	// Membership-relative "added" timestamp, attached only on tag-view reads
	// (filter.tagId — the Pinned / Basket views). Mirrors track_tag.added_at,
	// i.e. when the track was pinned/basketed, NOT track.createdAt (which is
	// when the recording first entered the library and can predate the pin by
	// weeks for a feed-promoted track that already existed). The "Added"
	// column prefers this over createdAt when present.
	addedAt?: Date | null;
	// Cosine similarity to the query, attached only on similarTo reads.
	matchScore?: number | null;
};
export type NewTrack = typeof track.$inferInsert;
export type Album = typeof album.$inferSelect;
export type SourceLink = typeof sourceLink.$inferSelect;
export type NewSourceLink = typeof sourceLink.$inferInsert;
export type Playlist = typeof playlist.$inferSelect;
export type NewPlaylist = typeof playlist.$inferInsert;
export type PlaylistTrack = typeof playlistTrack.$inferSelect;
export type NewPlaylistTrack = typeof playlistTrack.$inferInsert;
export type PlaylistFolder = typeof playlistFolder.$inferSelect;
export type NewPlaylistFolder = typeof playlistFolder.$inferInsert;
export type PinnedSearch = typeof pinnedSearch.$inferSelect;
export type NewPinnedSearch = typeof pinnedSearch.$inferInsert;
export type LibraryFolder = typeof libraryFolder.$inferSelect;
export type NewLibraryFolder = typeof libraryFolder.$inferInsert;
export type Tag = typeof tag.$inferSelect;
export type NewTag = typeof tag.$inferInsert;
export type TrackTag = typeof trackTag.$inferSelect;
export type NewTrackTag = typeof trackTag.$inferInsert;
export type Artist = typeof artist.$inferSelect;
export type NewArtist = typeof artist.$inferInsert;
export type TrackArtistRow = typeof trackArtist.$inferSelect;
export type ArtistLinkRow = typeof artistLink.$inferSelect;
export type TrackAnalysis = typeof trackAnalysis.$inferSelect;
export type NewTrackAnalysis = typeof trackAnalysis.$inferInsert;
export type Cue = typeof cue.$inferSelect;
export type NewCue = typeof cue.$inferInsert;
export type AnalysisJob = typeof analysisJob.$inferSelect;
export type NewAnalysisJob = typeof analysisJob.$inferInsert;
export type RekordboxLink = typeof rekordboxLink.$inferSelect;
export type NewRekordboxLink = typeof rekordboxLink.$inferInsert;
export type RekordboxSyncWatermark = typeof rekordboxSyncWatermark.$inferSelect;
export type NewRekordboxSyncWatermark = typeof rekordboxSyncWatermark.$inferInsert;
export type MetricCutoffs = typeof metricCutoffs.$inferSelect;
export type NewMetricCutoffs = typeof metricCutoffs.$inferInsert;
export type PlaySession = typeof playSession.$inferSelect;
export type NewPlaySession = typeof playSession.$inferInsert;
export type PlayEvent = typeof playEvent.$inferSelect;
export type NewPlayEvent = typeof playEvent.$inferInsert;
export type SyncOutboxRow = typeof syncOutbox.$inferSelect;
export type NewSyncOutboxRow = typeof syncOutbox.$inferInsert;
export type SyncCursorRow = typeof syncCursor.$inferSelect;
export type RecordingAliasRow = typeof recordingAlias.$inferSelect;
export type TombstoneRow = typeof tombstone.$inferSelect;
export type CatalogueEntryRow = typeof catalogueEntry.$inferSelect;

// Track read-shape with derived bucket levels (1..5 per metric) decorated by
// getTracksImpl using the in-memory cutoff store. Null when the underlying
// raw value is null. Stored separately from `Track` so the DB row type stays
// honest about what's persisted vs. derived.
export type MetricLevel = 1 | 2 | 3 | 4 | 5;
export type TrackLevels = {
	brightnessLevel: MetricLevel | null;
	dissonanceLevel: MetricLevel | null;
	densityLevel: MetricLevel | null;
	loudnessRangeLuLevel: MetricLevel | null;
	dynamicComplexityLevel: MetricLevel | null;
	introLengthSecLevel: MetricLevel | null;
	outroLengthSecLevel: MetricLevel | null;
	firstDropSecLevel: MetricLevel | null;
};