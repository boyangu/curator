// Migration applier — for Phase 0 this just creates tables from the schema
// using Drizzle's internal CREATE TABLE statements. When the schema evolves,
// switch to drizzle-kit generate + a proper migrations folder.

import Database from 'better-sqlite3';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { applyRemixers, artistKey, isPackedCredit, normalizeArtistList, searchFold, type TrackArtist, type TrackOverrides } from '@curator/shared';
import { normalizeIsrc } from '@curator/library-logic';
import { upsertArtistLinksRaw } from '../library/artist-links.js';
import { keyToCamelot } from '../enrich/keys.js';
import { syncTrackArtistsRaw } from '../library/artists.js';
import { albumBackfillOrderRaw, repairAlbumTablesRaw, syncTrackAlbumsRaw } from '../library/albums.js';
import type { Logger } from '@curator/shared/log';
import { log, setCoreLogger } from '../log.js';
import { rebalance } from '@curator/protocol';
import { randomUUID } from 'node:crypto';
import { recordingIdForTrack } from '../sync-log/recording-id.js';
import { mergeRecordingRaw } from '../library/mutators.js';
import { markRecordsComplete, recordsComplete } from '../sync-log/apply.js';
import { claimParentId } from '../sync-log/store.js';
import { CLAIMS_BACKFILL_KEY } from '../sync-log/initial-push.js';
import { CLIENT_STATE_KEY } from '../sync-log/client.js';

const mlog = log.for('migrate');

// playlist_track's columns, shared by the fresh-install DDL and the one-shot
// rebuild from the position-keyed shape (migrateSyncSchema). Its indexes are
// NOT in DDL: on an existing library DDL meets the old table, which has no
// order_key to index, so they are created after the rebuild.
const PLAYLIST_TRACK_COLUMNS = `
	id TEXT PRIMARY KEY,
	playlist_id TEXT NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
	track_id TEXT NOT NULL REFERENCES track(id) ON DELETE CASCADE,
	order_key TEXT NOT NULL,
	position INTEGER NOT NULL,
	added_at INTEGER,
	added_by TEXT,
	source_track_id TEXT NOT NULL
`;
const PLAYLIST_TRACK_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS playlist_track_position_uniq ON playlist_track(playlist_id, position);
CREATE INDEX IF NOT EXISTS playlist_track_order_idx ON playlist_track(playlist_id, order_key);
CREATE INDEX IF NOT EXISTS playlist_track_track_idx ON playlist_track(track_id);
`;

const DDL = `
CREATE TABLE IF NOT EXISTS track (
	id TEXT PRIMARY KEY,
	isrc TEXT,
	mbid TEXT,
	title TEXT NOT NULL,
	artists TEXT NOT NULL,
	album_title TEXT,
	release_date TEXT,
	duration INTEGER,
	bpm INTEGER,
	key_camelot TEXT,
	genre TEXT,
	label TEXT,
	copyright TEXT,
	explicit INTEGER,
	title_ascii TEXT,
	album_title_ascii TEXT,
	label_ascii TEXT,
	genre_ascii TEXT,
	artists_ascii TEXT,
	loudness_range_lu REAL,
	dissonance REAL,
	density REAL,
	brightness REAL,
	power REAL,
	dynamic_complexity REAL,
	intro_length_sec REAL,
	outro_length_sec REAL,
	first_drop_sec REAL,
	drop_count INTEGER,
	breakdown_count INTEGER,
	state TEXT NOT NULL DEFAULT 'unsorted',
	state_changed_at INTEGER,
	cues_edited_at INTEGER,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS track_isrc_idx ON track(isrc);
CREATE INDEX IF NOT EXISTS track_state_idx ON track(state);
CREATE INDEX IF NOT EXISTS track_bpm_idx ON track(bpm);
CREATE INDEX IF NOT EXISTS track_key_idx ON track(key_camelot);

CREATE TABLE IF NOT EXISTS source_link (
	id TEXT PRIMARY KEY,
	track_id TEXT NOT NULL REFERENCES track(id) ON DELETE CASCADE,
	source TEXT NOT NULL,
	source_track_id TEXT NOT NULL,
	url TEXT,
	isrc_local TEXT,
	title_local TEXT,
	artists_local TEXT,
	album_local TEXT,
	duration_local INTEGER,
	bpm_local INTEGER,
	key_local TEXT,
	payload TEXT,
	fetched_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS source_link_uniq ON source_link(source, source_track_id);
CREATE INDEX IF NOT EXISTS source_link_track_source_idx ON source_link(track_id, source);
CREATE INDEX IF NOT EXISTS source_link_source_idx ON source_link(source);

CREATE TABLE IF NOT EXISTS playlist (
	id TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	source_id TEXT NOT NULL,
	url TEXT,
	name TEXT NOT NULL,
	description TEXT,
	owner_name TEXT,
	owner_id TEXT,
	cover_url TEXT,
	track_count INTEGER,
	followers INTEGER,
	is_collaborative INTEGER,
	is_public INTEGER,
	last_synced_at INTEGER,
	remote_updated_at INTEGER,
	sync_status TEXT NOT NULL DEFAULT 'pending',
	sync_error TEXT,
	sync_cursor TEXT,
	mark TEXT,
	is_favorite INTEGER NOT NULL DEFAULT 0,
	is_hidden INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS playlist_uniq ON playlist(source, source_id);
CREATE INDEX IF NOT EXISTS playlist_source_idx ON playlist(source);

CREATE TABLE IF NOT EXISTS playlist_track (${PLAYLIST_TRACK_COLUMNS});
CREATE INDEX IF NOT EXISTS playlist_track_track_idx ON playlist_track(track_id);

CREATE TABLE IF NOT EXISTS pinned_search (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	query TEXT NOT NULL,
	sort_column TEXT,
	sort_dir TEXT,
	position INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS pinned_search_position_idx ON pinned_search(position);

CREATE TABLE IF NOT EXISTS token (
	source TEXT NOT NULL,
	kind TEXT NOT NULL,
	scope TEXT NOT NULL,
	value TEXT NOT NULL,
	expires_at INTEGER,
	fetched_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	meta TEXT,
	PRIMARY KEY (source, kind, scope)
);

CREATE TABLE IF NOT EXISTS sync_job (
	id TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	kind TEXT NOT NULL,
	target_id TEXT,
	state TEXT NOT NULL,
	started_at INTEGER,
	finished_at INTEGER,
	stats TEXT,
	error TEXT
);

CREATE TABLE IF NOT EXISTS download_job (
	track_id TEXT PRIMARY KEY,
	track_title TEXT NOT NULL,
	artist_name TEXT NOT NULL DEFAULT '',
	state TEXT NOT NULL,
	pct INTEGER NOT NULL DEFAULT 0,
	bytes INTEGER,
	output_path TEXT,
	error TEXT,
	error_kind TEXT,
	enqueued_at INTEGER NOT NULL,
	started_at INTEGER,
	finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS playlist_folder (
	id TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	source_id TEXT NOT NULL,
	parent_folder_id TEXT,
	name TEXT NOT NULL,
	position INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS playlist_folder_uniq ON playlist_folder(source, source_id);
CREATE INDEX IF NOT EXISTS playlist_folder_parent_idx ON playlist_folder(parent_folder_id);

CREATE TABLE IF NOT EXISTS library_folder (
	id TEXT PRIMARY KEY,
	path TEXT NOT NULL,
	exclude_globs TEXT,
	watching INTEGER NOT NULL DEFAULT 1,
	scan_state TEXT NOT NULL DEFAULT 'idle',
	scan_error TEXT,
	is_favorite INTEGER NOT NULL DEFAULT 0,
	added_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	last_scanned_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS library_folder_path_idx ON library_folder(path);

CREATE TABLE IF NOT EXISTS tag (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	kind TEXT NOT NULL,
	color TEXT,
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS track_tag (
	track_id TEXT NOT NULL REFERENCES track(id) ON DELETE CASCADE,
	tag_id TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
	added_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	PRIMARY KEY (track_id, tag_id)
);
CREATE INDEX IF NOT EXISTS track_tag_tag_idx ON track_tag(tag_id);

CREATE TABLE IF NOT EXISTS artist (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	name_ascii TEXT NOT NULL,
	merged_into TEXT REFERENCES artist(id),
	name_curated_at INTEGER,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS artist_name_ascii_uniq ON artist(name_ascii);

CREATE TABLE IF NOT EXISTS track_artist (
	track_id TEXT NOT NULL REFERENCES track(id) ON DELETE CASCADE,
	artist_id TEXT NOT NULL REFERENCES artist(id) ON DELETE CASCADE,
	role TEXT,
	position INTEGER NOT NULL,
	PRIMARY KEY (track_id, artist_id)
);
CREATE INDEX IF NOT EXISTS track_artist_artist_idx ON track_artist(artist_id);

CREATE TABLE IF NOT EXISTS artist_link (
	artist_id TEXT NOT NULL REFERENCES artist(id) ON DELETE CASCADE,
	source TEXT NOT NULL,
	source_id TEXT NOT NULL,
	url TEXT,
	fetched_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	PRIMARY KEY (source, source_id)
);
CREATE INDEX IF NOT EXISTS artist_link_artist_idx ON artist_link(artist_id);

CREATE TABLE IF NOT EXISTS album (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	title_key TEXT NOT NULL,
	album_key TEXT NOT NULL,
	artists_source TEXT NOT NULL DEFAULT 'derived',
	release_date TEXT,
	label TEXT,
	upc TEXT,
	cover_url TEXT,
	album_type TEXT,
	total_tracks INTEGER,
	merged_into TEXT,
	enriched_at INTEGER,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS album_key_idx ON album(album_key);
CREATE INDEX IF NOT EXISTS album_title_key_idx ON album(title_key);

CREATE TABLE IF NOT EXISTS album_artist (
	album_id TEXT NOT NULL REFERENCES album(id) ON DELETE CASCADE,
	artist_id TEXT NOT NULL REFERENCES artist(id) ON DELETE CASCADE,
	position INTEGER NOT NULL,
	PRIMARY KEY (album_id, artist_id)
);
CREATE INDEX IF NOT EXISTS album_artist_artist_idx ON album_artist(artist_id);

CREATE TABLE IF NOT EXISTS album_link (
	album_id TEXT NOT NULL REFERENCES album(id) ON DELETE CASCADE,
	source TEXT NOT NULL,
	source_id TEXT NOT NULL,
	url TEXT,
	fetched_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	PRIMARY KEY (source, source_id)
);
CREATE INDEX IF NOT EXISTS album_link_album_idx ON album_link(album_id);

CREATE TABLE IF NOT EXISTS track_analysis (
	track_id TEXT PRIMARY KEY REFERENCES track(id) ON DELETE CASCADE,
	bpm REAL,
	beatgrid BLOB,
	downbeats BLOB,
	key_camelot TEXT,
	key_strength REAL,
	brightness REAL,
	power REAL,
	dynamic_complexity REAL,
	loudness_range_lu REAL,
	dissonance REAL,
	density REAL,
	segments_json TEXT,
	intro_length_sec REAL,
	outro_length_sec REAL,
	first_drop_sec REAL,
	drop_count INTEGER,
	breakdown_count INTEGER,
	features_json TEXT,
	duration REAL,
	analyzer_version TEXT NOT NULL,
	analyzed_at INTEGER NOT NULL,
	audio_hash TEXT,
	rb_beatgrid BLOB,
	rb_downbeats BLOB,
	rb_bpm REAL,
	rb_key_camelot TEXT,
	rb_key_strength REAL,
	rb_segments_json TEXT
);

CREATE TABLE IF NOT EXISTS cue (
	id TEXT PRIMARY KEY,
	track_id TEXT NOT NULL REFERENCES track(id) ON DELETE CASCADE,
	slot INTEGER NOT NULL,
	position_sec REAL NOT NULL,
	length_sec REAL,
	color TEXT,
	name TEXT,
	kind TEXT NOT NULL,
	origin TEXT NOT NULL DEFAULT 'curator',
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS cue_track_slot_kind_uniq ON cue(track_id, slot, kind);
CREATE INDEX IF NOT EXISTS cue_track_idx ON cue(track_id);

CREATE TABLE IF NOT EXISTS analysis_job (
	track_id TEXT PRIMARY KEY REFERENCES track(id) ON DELETE CASCADE,
	state TEXT NOT NULL,
	priority INTEGER NOT NULL DEFAULT 0,
	error TEXT,
	error_kind TEXT,
	enqueued_at INTEGER NOT NULL,
	started_at INTEGER,
	finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS analysis_job_dispatch_idx ON analysis_job(state, priority, enqueued_at);

CREATE TABLE IF NOT EXISTS rekordbox_link (
	track_id TEXT PRIMARY KEY REFERENCES track(id) ON DELETE CASCADE,
	rb_content_id TEXT NOT NULL,
	rb_local_usn INTEGER NOT NULL,
	rb_file_path TEXT,
	imported_at INTEGER NOT NULL,
	rb_updated_at_seen INTEGER,
	fields_seen TEXT,
	cues_seen TEXT,
	pushed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS rekordbox_link_content_uniq ON rekordbox_link(rb_content_id);
CREATE INDEX IF NOT EXISTS rekordbox_link_path_idx ON rekordbox_link(rb_file_path);

CREATE TABLE IF NOT EXISTS sync_conflict (
	id TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	track_id TEXT NOT NULL REFERENCES track(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	field_key TEXT NOT NULL,
	base_json TEXT,
	theirs_json TEXT,
	detected_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_conflict_uniq ON sync_conflict(provider, track_id, kind, field_key);
CREATE INDEX IF NOT EXISTS sync_conflict_track_idx ON sync_conflict(track_id);

CREATE TABLE IF NOT EXISTS rekordbox_sync_watermark (
	table_name TEXT PRIMARY KEY,
	last_usn INTEGER NOT NULL,
	last_synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metric_cutoffs (
	metric TEXT PRIMARY KEY,
	cutoff_20 REAL NOT NULL,
	cutoff_40 REAL NOT NULL,
	cutoff_60 REAL NOT NULL,
	cutoff_80 REAL NOT NULL,
	sample_count INTEGER NOT NULL,
	computed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_conflict (
	id TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	rb_playlist_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	base_json TEXT,
	theirs_json TEXT,
	detected_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS playlist_conflict_uniq ON playlist_conflict(provider, rb_playlist_id, kind);

CREATE TABLE IF NOT EXISTS rekordbox_membership_baseline (
	rb_playlist_id TEXT NOT NULL,
	member_kind TEXT NOT NULL,
	member_id TEXT NOT NULL,
	position INTEGER NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	PRIMARY KEY (rb_playlist_id, member_kind, member_id)
);
CREATE INDEX IF NOT EXISTS rb_membership_baseline_playlist_idx ON rekordbox_membership_baseline(rb_playlist_id);

CREATE TABLE IF NOT EXISTS rekordbox_deleted_content (
	rb_content_id TEXT PRIMARY KEY,
	deleted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	pushed_at INTEGER
);

CREATE TABLE IF NOT EXISTS app_setting (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS play_session (
	id TEXT PRIMARY KEY,
	origin TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'unknown',
	kind_source TEXT NOT NULL DEFAULT 'auto',
	name TEXT,
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	rb_history_id TEXT,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS play_session_rb_history_uniq ON play_session(rb_history_id);
CREATE INDEX IF NOT EXISTS play_session_started_idx ON play_session(started_at);
CREATE INDEX IF NOT EXISTS play_session_origin_started_idx ON play_session(origin, started_at);

CREATE TABLE IF NOT EXISTS play_event (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES play_session(id) ON DELETE CASCADE,
	track_id TEXT REFERENCES track(id) ON DELETE SET NULL,
	rb_content_id TEXT,
	source_track_id TEXT,
	source TEXT NOT NULL,
	played_at INTEGER,
	played_ms INTEGER,
	duration_ms INTEGER,
	max_position_ms INTEGER,
	played75 INTEGER,
	ended_reason TEXT,
	context_type TEXT,
	context_id TEXT,
	track_no INTEGER,
	rb_song_history_id TEXT,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS play_event_rb_song_uniq ON play_event(rb_song_history_id);
CREATE INDEX IF NOT EXISTS play_event_track_played_idx ON play_event(track_id, played_at);
CREATE INDEX IF NOT EXISTS play_event_session_idx ON play_event(session_id);
CREATE INDEX IF NOT EXISTS play_event_played_at_idx ON play_event(played_at);
CREATE INDEX IF NOT EXISTS play_event_rb_content_idx ON play_event(rb_content_id);
`;

// Additive migrations for existing DBs — each runs once, errors swallowed
// when the schema already has the change applied. Keep idempotent.
const ALTER_MIGRATIONS: string[] = [
	`ALTER TABLE playlist ADD COLUMN remote_updated_at INTEGER`,
	`ALTER TABLE track ADD COLUMN overrides TEXT`,
	`ALTER TABLE playlist ADD COLUMN hybrid_tidal INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE track ADD COLUMN cover_url TEXT`,
	`ALTER TABLE source_link ADD COLUMN file_path TEXT`,
	`ALTER TABLE source_link ADD COLUMN file_format TEXT`,
	`ALTER TABLE source_link ADD COLUMN file_size INTEGER`,
	`ALTER TABLE source_link ADD COLUMN file_mtime INTEGER`,
	`CREATE UNIQUE INDEX IF NOT EXISTS source_link_file_path_idx ON source_link(file_path)`,
	`ALTER TABLE source_link ADD COLUMN audio_hash TEXT`,
	`ALTER TABLE source_link ADD COLUMN fingerprint TEXT`,
	`ALTER TABLE source_link ADD COLUMN fingerprint_duration_sec INTEGER`,
	`ALTER TABLE source_link ADD COLUMN missing_at INTEGER`,
	`CREATE INDEX IF NOT EXISTS source_link_audio_hash_idx ON source_link(audio_hash)`,
	`ALTER TABLE playlist ADD COLUMN parent_folder_id TEXT`,
	`CREATE INDEX IF NOT EXISTS playlist_parent_idx ON playlist(parent_folder_id)`,
	`ALTER TABLE library_folder ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE playlist ADD COLUMN position INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE playlist ADD COLUMN is_smart INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE track ADD COLUMN added_at INTEGER`,
	// Rekordbox-extras on canonical track. Nullable — analyzer-only tracks
	// won't have these until they're picked up by a rekordbox read.
	`ALTER TABLE track ADD COLUMN color_label TEXT`,
	`ALTER TABLE track ADD COLUMN rating INTEGER`,
	`ALTER TABLE track ADD COLUMN comment TEXT`,
	`ALTER TABLE track ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE track ADD COLUMN last_played_at INTEGER`,
	// Last-modified-wins baseline for Rekordbox<->Curator merges. See
	// rekordboxLink schema comment + apps/core/src/rekordbox/importer.ts
	// applyTrackDelta. The backfill below seeds existing rows to track.updated_at
	// so the first post-migration import treats both sides as in-sync at that
	// point and only carries forward changes from there.
	`ALTER TABLE rekordbox_link ADD COLUMN rb_updated_at_seen INTEGER`,
	`UPDATE rekordbox_link
		SET rb_updated_at_seen = (
			SELECT track.updated_at
			FROM track
			WHERE track.id = rekordbox_link.track_id
		)
		WHERE rb_updated_at_seen IS NULL`,
	// EBUR128 + promoted MusicExtractor scalars (analyzer 2.0.0). All
	// nullable — Path A backfill repopulates existing rows.
	`ALTER TABLE track_analysis ADD COLUMN loudness_range_lu REAL`,
	`ALTER TABLE track_analysis ADD COLUMN true_peak_db REAL`,
	`ALTER TABLE track_analysis ADD COLUMN dissonance REAL`,
	`ALTER TABLE track_analysis ADD COLUMN spectral_complexity REAL`,
	// Analyzer-only scalars mirrored onto `track` for direct sort/filter from
	// the virtualized list (no track_analysis join). Each gets an index since
	// the renderer is expected to use them as sort keys. Nullable — Path A
	// backfill repopulates as it drains.
	`ALTER TABLE track ADD COLUMN loudness_lufs REAL`,
	`ALTER TABLE track ADD COLUMN loudness_range_lu REAL`,
	`ALTER TABLE track ADD COLUMN true_peak_db REAL`,
	`ALTER TABLE track ADD COLUMN dissonance REAL`,
	`ALTER TABLE track ADD COLUMN spectral_complexity REAL`,
	`ALTER TABLE track ADD COLUMN danceability REAL`,
	`ALTER TABLE track ADD COLUMN energy REAL`,
	`ALTER TABLE track ADD COLUMN brightness REAL`,
	`ALTER TABLE track ADD COLUMN dynamic_complexity REAL`,
	`CREATE INDEX IF NOT EXISTS track_loudness_lufs_idx ON track(loudness_lufs)`,
	`CREATE INDEX IF NOT EXISTS track_loudness_range_lu_idx ON track(loudness_range_lu)`,
	`CREATE INDEX IF NOT EXISTS track_true_peak_db_idx ON track(true_peak_db)`,
	`CREATE INDEX IF NOT EXISTS track_dissonance_idx ON track(dissonance)`,
	`CREATE INDEX IF NOT EXISTS track_spectral_complexity_idx ON track(spectral_complexity)`,
	`CREATE INDEX IF NOT EXISTS track_danceability_idx ON track(danceability)`,
	`CREATE INDEX IF NOT EXISTS track_energy_idx ON track(energy)`,
	`CREATE INDEX IF NOT EXISTS track_brightness_idx ON track(brightness)`,
	`CREATE INDEX IF NOT EXISTS track_dynamic_complexity_idx ON track(dynamic_complexity)`,
	// One-time backfill: copy analyzer scalars from track_analysis onto track
	// for rows that already have analysis but whose track columns are null.
	// Idempotent — UPDATE…WHERE is a no-op on rows already filled.
	`UPDATE track SET
		loudness_lufs = (SELECT loudness_lufs FROM track_analysis WHERE track_analysis.track_id = track.id),
		loudness_range_lu = (SELECT loudness_range_lu FROM track_analysis WHERE track_analysis.track_id = track.id),
		true_peak_db = (SELECT true_peak_db FROM track_analysis WHERE track_analysis.track_id = track.id),
		dissonance = (SELECT dissonance FROM track_analysis WHERE track_analysis.track_id = track.id),
		spectral_complexity = (SELECT spectral_complexity FROM track_analysis WHERE track_analysis.track_id = track.id),
		danceability = (SELECT danceability FROM track_analysis WHERE track_analysis.track_id = track.id),
		energy = (SELECT energy FROM track_analysis WHERE track_analysis.track_id = track.id),
		brightness = (SELECT brightness FROM track_analysis WHERE track_analysis.track_id = track.id),
		dynamic_complexity = (SELECT dynamic_complexity FROM track_analysis WHERE track_analysis.track_id = track.id)
	WHERE EXISTS (SELECT 1 FROM track_analysis WHERE track_analysis.track_id = track.id)
		AND track.loudness_lufs IS NULL`,
	// analyzer 2.1.0 — drop loudness_lufs, true_peak_db, energy. They had no
	// non-UI consumer and `energy` was a misleading duplicate of loudness.
	// `loudness_range_lu` and the other six musical scalars stay. ALTER TABLE
	// DROP COLUMN needs SQLite 3.35+ (better-sqlite3 ships modern SQLite); the
	// migrate loop's "no such column" swallow makes these idempotent.
	`DROP INDEX IF EXISTS track_loudness_lufs_idx`,
	`DROP INDEX IF EXISTS track_true_peak_db_idx`,
	`DROP INDEX IF EXISTS track_energy_idx`,
	`ALTER TABLE track DROP COLUMN loudness_lufs`,
	`ALTER TABLE track DROP COLUMN true_peak_db`,
	`ALTER TABLE track DROP COLUMN energy`,
	`ALTER TABLE track_analysis DROP COLUMN loudness_lufs`,
	`ALTER TABLE track_analysis DROP COLUMN true_peak_db`,
	`ALTER TABLE track_analysis DROP COLUMN energy`,
	// Re-label existing 2.0.0 rows as 2.1.0. The column drop doesn't
	// invalidate the surviving values, so we'd rather skip Path A
	// backfill than recompute 30k tracks just to lose three columns.
	// Anything older than 2.0.0 stays stale and gets re-analyzed.
	`UPDATE track_analysis SET analyzer_version = '2.1.0' WHERE analyzer_version = '2.0.0'`,
	// Product rename: spectral_complexity → density, danceability → hypnosis.
	// The values are unchanged (still Essentia's lowlevel.spectral_complexity.mean
	// and rhythm.danceability under the hood); only the storage label moves to
	// match the product taxonomy. RENAME COLUMN is fast and metadata-only.
	`ALTER TABLE track RENAME COLUMN spectral_complexity TO density`,
	`ALTER TABLE track RENAME COLUMN danceability TO hypnosis`,
	`ALTER TABLE track_analysis RENAME COLUMN spectral_complexity TO density`,
	`ALTER TABLE track_analysis RENAME COLUMN danceability TO hypnosis`,
	// Drop the old indexes and recreate under the new names. SQLite can't
	// rename an index in one shot; drop+create is the standard dance.
	`DROP INDEX IF EXISTS track_spectral_complexity_idx`,
	`DROP INDEX IF EXISTS track_danceability_idx`,
	`CREATE INDEX IF NOT EXISTS track_density_idx ON track(density)`,
	`CREATE INDEX IF NOT EXISTS track_hypnosis_idx ON track(hypnosis)`,
	// metric_cutoffs table — for existing DBs that predate the table. The DDL
	// block above handles fresh installs; this ALTER-style entry is the path
	// for upgrading users. IF NOT EXISTS makes it idempotent.
	`CREATE TABLE IF NOT EXISTS metric_cutoffs (
		metric TEXT PRIMARY KEY,
		cutoff_20 REAL NOT NULL,
		cutoff_40 REAL NOT NULL,
		cutoff_60 REAL NOT NULL,
		cutoff_80 REAL NOT NULL,
		sample_count INTEGER NOT NULL,
		computed_at INTEGER NOT NULL
	)`,
	// Phase 2A — structural segmentation. `segments_json` carries the full
	// labelled segment array; the five scalars are derived shortcuts mirrored
	// onto `track` for sort/filter without parsing JSON per-row. Path A
	// backfill (ANALYZER_VERSION bumped to 2.2.0) repopulates these for
	// every previously-analyzed track. Three of the five are bucketable via
	// metric_cutoffs (drop_count / breakdown_count are low-cardinality
	// integer counts and stay raw).
	`ALTER TABLE track_analysis ADD COLUMN segments_json TEXT`,
	`ALTER TABLE track_analysis ADD COLUMN intro_length_sec REAL`,
	`ALTER TABLE track_analysis ADD COLUMN outro_length_sec REAL`,
	`ALTER TABLE track_analysis ADD COLUMN first_drop_sec REAL`,
	`ALTER TABLE track_analysis ADD COLUMN drop_count INTEGER`,
	`ALTER TABLE track_analysis ADD COLUMN breakdown_count INTEGER`,
	`ALTER TABLE track ADD COLUMN intro_length_sec REAL`,
	`ALTER TABLE track ADD COLUMN outro_length_sec REAL`,
	`ALTER TABLE track ADD COLUMN first_drop_sec REAL`,
	`ALTER TABLE track ADD COLUMN drop_count INTEGER`,
	`ALTER TABLE track ADD COLUMN breakdown_count INTEGER`,
	`CREATE INDEX IF NOT EXISTS track_intro_length_sec_idx ON track(intro_length_sec)`,
	`CREATE INDEX IF NOT EXISTS track_outro_length_sec_idx ON track(outro_length_sec)`,
	`CREATE INDEX IF NOT EXISTS track_first_drop_sec_idx ON track(first_drop_sec)`,
	// Per-track freshness stamp for rekordbox sync — bumped by applyTrackDelta
	// on every tracks-scope pass. Lets us answer "was this synced from RB?"
	// from link existence (no need to infer from cues/segments/labels, which
	// rekordbox often legitimately lacks). Backfill seeds existing rows to
	// their imported_at so the first post-migration query is consistent.
	`ALTER TABLE rekordbox_link ADD COLUMN last_synced_at INTEGER NOT NULL DEFAULT 0`,
	`UPDATE rekordbox_link SET last_synced_at = imported_at WHERE last_synced_at = 0`,
	// Diacritic-folded shadow columns for user-facing search. The SQL
	// pre-filter in getTracksImpl LIKEs against these; the JS-side matcher
	// folds query and field on the fly. Populated by asciify() at every
	// track write site. Backfill for existing rows runs once below via
	// backfillAsciiColumns().
	`ALTER TABLE track ADD COLUMN title_ascii TEXT`,
	`ALTER TABLE track ADD COLUMN album_title_ascii TEXT`,
	`ALTER TABLE track ADD COLUMN label_ascii TEXT`,
	`ALTER TABLE track ADD COLUMN genre_ascii TEXT`,
	`ALTER TABLE track ADD COLUMN artists_ascii TEXT`,
	// Ascii-folded shadow of playlist.name / playlist_folder.name. Mirrors the
	// `track.title_ascii` family — powers `#name` resolution where playlist
	// (and later folder) names share the `#` namespace with user tags. Index
	// on playlist.name_ascii so the EXISTS subquery in the read path hits an
	// index rather than scanning. Backfill via backfillPlaylistAscii() below.
	`ALTER TABLE playlist ADD COLUMN name_ascii TEXT`,
	`ALTER TABLE playlist_folder ADD COLUMN name_ascii TEXT`,
	`CREATE INDEX IF NOT EXISTS playlist_name_ascii_idx ON playlist(name_ascii)`,
	// "User has edited cues for this track inside Curator" stamp. NULL on
	// every existing row at migration time (no one had a cue editor before
	// this) — preserves the rekordbox exporter's footgun guard for tracks
	// the user hasn't touched. Set on first user-driven cue mutation; once
	// non-null, the exporter trusts Curator's current cue set even when
	// empty.
	`ALTER TABLE track ADD COLUMN cues_edited_at INTEGER`,
	// One-shot normalization for the new opaque cue.color contract. Pre-
	// refactor rows may hold legacy named-palette strings ("red", "green",
	// etc) from rb imports; the rb writer + reader no longer recognise
	// those. Clearing them keeps storage consistent (only `cti:N` or NULL)
	// and pushes affected cues through the renderer's default-color path
	// until the user re-colors via the pad context menu. See the
	// rb-color-refactor plan for context.
	`UPDATE cue SET color = NULL WHERE color IS NOT NULL AND color NOT LIKE 'cti:%'`,
	// Upgrade source_link's trackId index to compound (track_id, source).
	// The compound's leftmost prefix serves every existing trackId-only
	// lookup, and the (trackId IN (…) AND source = ?) shape in playlist
	// add/remove + sync paths stops filtering source in-memory.
	`DROP INDEX IF EXISTS source_link_track_idx`,
	`CREATE INDEX IF NOT EXISTS source_link_track_source_idx ON source_link(track_id, source)`,
	// Cue authorship. The importer's pre-scan wipe now deletes only
	// origin='rekordbox' rows so Curator-authored cues survive a re-import.
	// Backfill heuristic for pre-column rows: anything on a track the user
	// has edited cues for in Curator (cues_edited_at set) is conservatively
	// kept as 'curator' (the ADD COLUMN default); everything else predates
	// the cue editor and came from Rekordbox. The backfill is keyed on
	// created_at < the migration moment implicitly — it only flips rows
	// that still carry the default on tracks with no Curator edits, and
	// post-migration writes always set origin explicitly.
	`ALTER TABLE cue ADD COLUMN origin TEXT NOT NULL DEFAULT 'curator'`,
	`UPDATE cue SET origin = 'rekordbox'
		WHERE track_id IN (SELECT id FROM track WHERE cues_edited_at IS NULL)
			AND track_id IN (SELECT track_id FROM rekordbox_link)
			AND origin = 'curator'`,
	// Sortable columns that never got their index (rating + duration are in
	// ZTrackSort; createdAt backs the "added" sort). Also serves the
	// scalarBounds pushdown (rating>=4 etc.).
	`CREATE INDEX IF NOT EXISTS track_rating_idx ON track(rating)`,
	`CREATE INDEX IF NOT EXISTS track_duration_idx ON track(duration)`,
	`CREATE INDEX IF NOT EXISTS track_created_at_idx ON track(created_at)`,
	// Three-way-merge baselines for the zero-override rb sync. NULL on
	// existing rows — the importer's bootstrap path (legacy decideRbWins)
	// runs once per track and seeds them; from then on the merge engine in
	// packages/library-logic/src/merge.ts decides per field / per cue unit.
	`ALTER TABLE rekordbox_link ADD COLUMN fields_seen TEXT`,
	`ALTER TABLE rekordbox_link ADD COLUMN cues_seen TEXT`,
	// Pending sync conflicts (provider-keyed; see schema.ts syncConflict).
	// IF NOT EXISTS makes the upgrade path idempotent; fresh installs get
	// it from the DDL block above.
	`CREATE TABLE IF NOT EXISTS sync_conflict (
		id TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		track_id TEXT NOT NULL REFERENCES track(id) ON DELETE CASCADE,
		kind TEXT NOT NULL,
		field_key TEXT NOT NULL,
		base_json TEXT,
		theirs_json TEXT,
		detected_at INTEGER NOT NULL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS sync_conflict_uniq ON sync_conflict(provider, track_id, kind, field_key)`,
	`CREATE INDEX IF NOT EXISTS sync_conflict_track_idx ON sync_conflict(track_id)`,
	// Playlist membership 3-way merge: per-playlist baseline (the merge
	// ancestor + Curator-delete tombstone), entity-level deleted-content
	// tombstone (anti-resurrection), and playlist-scoped order conflicts.
	// See schema.ts for the column rationale. Backfill below seeds the
	// baseline from current playlist_track so the first post-upgrade sync
	// is a no-op instead of a mass re-add.
	`CREATE TABLE IF NOT EXISTS playlist_conflict (
		id TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		rb_playlist_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		base_json TEXT,
		theirs_json TEXT,
		detected_at INTEGER NOT NULL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS playlist_conflict_uniq ON playlist_conflict(provider, rb_playlist_id, kind)`,
	`CREATE TABLE IF NOT EXISTS rekordbox_membership_baseline (
		rb_playlist_id TEXT NOT NULL,
		member_kind TEXT NOT NULL,
		member_id TEXT NOT NULL,
		position INTEGER NOT NULL,
		updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
		PRIMARY KEY (rb_playlist_id, member_kind, member_id)
	)`,
	`CREATE INDEX IF NOT EXISTS rb_membership_baseline_playlist_idx ON rekordbox_membership_baseline(rb_playlist_id)`,
	`CREATE TABLE IF NOT EXISTS rekordbox_deleted_content (
		rb_content_id TEXT PRIMARY KEY,
		deleted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
	)`,
	// Dual-source analysis. The existing columns become Curator's slot (the
	// analyzer keeps writing them); these rb_* columns are the protected
	// Rekordbox slot (importer writes only here, analyzer never touches them).
	// A player setting picks which the UI shows; both are kept so neither
	// overwrites the other. See schema.ts trackAnalysis + the importer/queue.
	`ALTER TABLE track_analysis ADD COLUMN rb_beatgrid BLOB`,
	`ALTER TABLE track_analysis ADD COLUMN rb_downbeats BLOB`,
	`ALTER TABLE track_analysis ADD COLUMN rb_bpm REAL`,
	`ALTER TABLE track_analysis ADD COLUMN rb_key_camelot TEXT`,
	`ALTER TABLE track_analysis ADD COLUMN rb_key_strength REAL`,
	`ALTER TABLE track_analysis ADD COLUMN rb_segments_json TEXT`,
	// One-time move: rows last written by the importer (analyzer_version =
	// 'rekordbox') hold rb data in the legacy columns — relocate it into the rb
	// slot and clear the legacy (now Curator) columns so the two sources are
	// cleanly separated. Idempotent via the `rb_beatgrid IS NULL` guard.
	// Caveat: a rb track that was ALSO analyzed (version '2.2.0', rb grid
	// preserved in the legacy columns) can't be attributed here and stays as
	// Curator; re-importing Rekordbox repopulates its rb slot cleanly (also the
	// recovery path for grids an earlier force-re-analyze wiped).
	// Runs every boot, so it must only move rows that still HOLD legacy data:
	// the statement after it clears those columns, and a placeholder the
	// importer (or the op-log projection) wrote with a key or phrases but no
	// grid would otherwise have its rb slot overwritten with those NULLs on
	// every launch (2026-10-20, when the rb key started landing in the slot).
	`UPDATE track_analysis SET
		rb_beatgrid = beatgrid, rb_downbeats = downbeats, rb_bpm = bpm,
		rb_key_camelot = key_camelot, rb_key_strength = key_strength,
		rb_segments_json = segments_json
		WHERE analyzer_version = 'rekordbox' AND rb_beatgrid IS NULL
			AND (beatgrid IS NOT NULL OR downbeats IS NOT NULL OR bpm IS NOT NULL OR key_camelot IS NOT NULL OR segments_json IS NOT NULL)`,
	`UPDATE track_analysis SET
		beatgrid = NULL, downbeats = NULL, bpm = NULL,
		key_camelot = NULL, key_strength = NULL, segments_json = NULL,
		intro_length_sec = NULL, outro_length_sec = NULL, first_drop_sec = NULL,
		drop_count = NULL, breakdown_count = NULL
		WHERE analyzer_version = 'rekordbox'`,
	// analyzer 2.3.0 — `brightness` is rewritten as the curator-aligned learned
	// score (no DDL: same column, new meaning, repopulated on re-analysis); `power`
	// is a net-new energy/density score. Added to track_analysis (canonical) and
	// mirrored on track for sort/filter, indexed like the other metrics. Existing
	// brightness values stay (old centroid scale) until a track is re-analyzed with
	// advanced features; cutoffStore re-buckets by percentile either way.
	`ALTER TABLE track_analysis ADD COLUMN power REAL`,
	`ALTER TABLE track ADD COLUMN power REAL`,
	`CREATE INDEX IF NOT EXISTS track_power_idx ON track(power)`,
	// release_date is now a multi-source field (Spotify seeds it at sync, the
	// Beatport enricher overrides), so it's no longer "album"-specific. Rename
	// the legacy column in place — preserves existing Spotify-populated values.
	// On a fresh DB the DDL above already creates `release_date`, so this throws
	// "no such column: album_release_date" and the applier swallows it as a no-op.
	`ALTER TABLE track RENAME COLUMN album_release_date TO release_date`,
	// release_date is a sortable tracklist column (the "Released" header).
	`CREATE INDEX IF NOT EXISTS track_release_date_idx ON track(release_date)`,
	// Soft-delete tombstone — see track.deletedAt in schema.ts. Nullable epoch-ms
	// timestamp; indexed because every non-playlist track query filters it out.
	`ALTER TABLE track ADD COLUMN deleted_at INTEGER`,
	`CREATE INDEX IF NOT EXISTS track_deleted_at_idx ON track(deleted_at)`,
	// Materialized library-membership tier — see track.membership in schema.ts.
	// Nullable ('local'|'streaming'|'followed'|NULL); seeded by the boot-time
	// recomputeAll() and kept current by the MembershipClassifier. Indexed (the
	// feed filter + future library views select on it).
	`ALTER TABLE track ADD COLUMN membership TEXT`,
	`CREATE INDEX IF NOT EXISTS track_membership_idx ON track(membership)`,
	// Drop `hypnosis` (Essentia rhythm.danceability surfaced as a product scalar).
	// It was a column + sortable metric but carried no real signal worth a
	// surface; danceability is still computed inside the MusicExtractor pass and
	// consumed by the brightness/power learned models — only the exposed scalar
	// goes. Same no-recompute rationale as the 2.1.0 column drops above: the
	// surviving values stay valid, so no analyzer_version bump. Drop the index
	// first (DROP COLUMN refuses while an index references it); the applier's
	// "no such column" swallow makes these idempotent on fresh installs.
	`DROP INDEX IF EXISTS track_hypnosis_idx`,
	`ALTER TABLE track DROP COLUMN hypnosis`,
	`ALTER TABLE track_analysis DROP COLUMN hypnosis`,
	`DELETE FROM metric_cutoffs WHERE metric = 'hypnosis'`,
	// Repair BPM corrupted by the old Rekordbox reader, which only divided
	// centi-BPM by 100 when the raw value was > 10000 — so every RB track under
	// 100 BPM landed 100× too large (91.13 stored as 9113). The stored integer
	// is the exact centi-BPM, so /100 recovers it losslessly. No real track
	// exceeds ~300 BPM and nothing else writes bpm > 300, so the threshold
	// cleanly targets only corrupted rows; idempotent (repaired values drop
	// ≤300 and never re-match).
	`UPDATE track SET bpm = bpm / 100.0 WHERE bpm > 300`,
	// Same corruption hid inside the user-override JSON blob: a track edited
	// while its canonical bpm was still centi-scaled captured the wrong value
	// (applyOverrides shadows canonical with override.bpm, so the repair above
	// alone leaves these reading high). json_extract returns NULL for rows
	// without a bpm override, so they're skipped; idempotent on the same > 300
	// threshold.
	`UPDATE track SET overrides = json_set(overrides, '$.bpm', json_extract(overrides, '$.bpm') / 100.0) WHERE json_extract(overrides, '$.bpm') > 300`,
	// Organize recommender matches genre/label on the folded shadow columns
	// (case/diacritic-insensitive) — index them so the categorical pass hits
	// indexes instead of two full-table scans per run.
	`CREATE INDEX IF NOT EXISTS track_genre_ascii_idx ON track(genre_ascii)`,
	`CREATE INDEX IF NOT EXISTS track_label_ascii_idx ON track(label_ascii)`,
	// Play history — per-play audit log (curator player + rekordbox history
	// import). Fresh installs get these from the DDL block; this is the
	// upgrade path. IF NOT EXISTS makes both idempotent.
	`CREATE TABLE IF NOT EXISTS play_session (
		id TEXT PRIMARY KEY,
		origin TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'unknown',
		kind_source TEXT NOT NULL DEFAULT 'auto',
		name TEXT,
		started_at INTEGER NOT NULL,
		ended_at INTEGER,
		rb_history_id TEXT,
		created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
		updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS play_session_rb_history_uniq ON play_session(rb_history_id)`,
	`CREATE INDEX IF NOT EXISTS play_session_started_idx ON play_session(started_at)`,
	`CREATE INDEX IF NOT EXISTS play_session_origin_started_idx ON play_session(origin, started_at)`,
	`CREATE TABLE IF NOT EXISTS play_event (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL REFERENCES play_session(id) ON DELETE CASCADE,
		track_id TEXT REFERENCES track(id) ON DELETE SET NULL,
		rb_content_id TEXT,
		source_track_id TEXT,
		source TEXT NOT NULL,
		played_at INTEGER,
		played_ms INTEGER,
		duration_ms INTEGER,
		max_position_ms INTEGER,
		played75 INTEGER,
		ended_reason TEXT,
		context_type TEXT,
		context_id TEXT,
		track_no INTEGER,
		rb_song_history_id TEXT,
		created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS play_event_rb_song_uniq ON play_event(rb_song_history_id)`,
	`CREATE INDEX IF NOT EXISTS play_event_track_played_idx ON play_event(track_id, played_at)`,
	`CREATE INDEX IF NOT EXISTS play_event_session_idx ON play_event(session_id)`,
	`CREATE INDEX IF NOT EXISTS play_event_played_at_idx ON play_event(played_at)`,
	`CREATE INDEX IF NOT EXISTS play_event_rb_content_idx ON play_event(rb_content_id)`,
	// Core-owned settings store (per-source sync preferences) — see the
	// app_setting comment in schema.ts for why this moved out of the
	// renderer's per-origin localStorage.
	`CREATE TABLE IF NOT EXISTS app_setting (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
	)`,
	// Materialized effective-primary-artist fold for the indexed Artist sort
	// — see track.artistSort in schema.ts. Populated by backfillArtistTables.
	`ALTER TABLE track ADD COLUMN artist_sort TEXT`,
	`CREATE INDEX IF NOT EXISTS track_artist_sort_idx ON track(artist_sort)`,
	// "Convert to WAV" provenance — see track.derivedFromTrackId /
	// playlist.derivedFromPlaylistId in schema.ts.
	`ALTER TABLE track ADD COLUMN derived_from_track_id TEXT`,
	`CREATE INDEX IF NOT EXISTS track_derived_from_idx ON track(derived_from_track_id)`,
	`ALTER TABLE playlist ADD COLUMN derived_from_playlist_id TEXT`,
	// Album entities — see the ALBUM comment in schema.ts. Populated by
	// backfillAlbumTables, maintained by the album seam.
	`ALTER TABLE track ADD COLUMN album_id TEXT`,
	`ALTER TABLE track ADD COLUMN track_number INTEGER`,
	`ALTER TABLE track ADD COLUMN disc_number INTEGER`,
	`CREATE INDEX IF NOT EXISTS track_album_idx ON track(album_id)`,
	// Cloud sync — see track.recordingId and the SYNC section in schema.ts.
	// recording_id is filled by migrateSyncSchema; the tables start empty.
	`ALTER TABLE track ADD COLUMN recording_id TEXT`,
	`CREATE INDEX IF NOT EXISTS track_recording_idx ON track(recording_id)`,
	`CREATE TABLE IF NOT EXISTS sync_outbox (
		op_id TEXT PRIMARY KEY,
		seq_local INTEGER NOT NULL,
		device_id TEXT NOT NULL,
		client_ts INTEGER NOT NULL,
		schema_version INTEGER NOT NULL,
		entity TEXT NOT NULL,
		entity_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		payload TEXT NOT NULL,
		state TEXT NOT NULL DEFAULT 'pending',
		reason TEXT,
		created_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS sync_outbox_state_seq_idx ON sync_outbox(state, seq_local)`,
	`CREATE TABLE IF NOT EXISTS sync_cursor (
		key TEXT PRIMARY KEY,
		last_seq INTEGER NOT NULL DEFAULT 0,
		snapshot_seq INTEGER
	)`,
	`CREATE TABLE IF NOT EXISTS recording_alias (
		loser TEXT PRIMARY KEY,
		winner TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS tombstone (
		entity TEXT NOT NULL,
		entity_id TEXT NOT NULL,
		client_ts INTEGER NOT NULL,
		PRIMARY KEY (entity, entity_id)
	)`,
	// The op log's local merge state (cloud plan B4) — see tombstone and
	// sync_state in schema.ts. The tombstone columns are ADDs because B3
	// shipped the table without them; it was empty until B4, so nothing needs
	// a backfill.
	`ALTER TABLE tombstone ADD COLUMN device_id TEXT`,
	`ALTER TABLE tombstone ADD COLUMN op_id TEXT`,
	`ALTER TABLE tombstone ADD COLUMN recording_id TEXT`,
	`CREATE INDEX IF NOT EXISTS tombstone_recording_idx ON tombstone(recording_id)`,
	`CREATE TABLE IF NOT EXISTS sync_state (
		map TEXT NOT NULL,
		key TEXT NOT NULL,
		recording_id TEXT,
		parent_id TEXT,
		value TEXT NOT NULL,
		PRIMARY KEY (map, key)
	)`,
	`CREATE INDEX IF NOT EXISTS sync_state_recording_idx ON sync_state(recording_id)`,
	`CREATE INDEX IF NOT EXISTS sync_state_parent_idx ON sync_state(map, parent_id)`,
	// Rekordbox name baseline — see playlist.rbNameSeen in schema.ts. No
	// backfill on purpose: NULL reads as "maybe renamed", so the first push
	// after upgrade carries every playlist's name once (exactly what it did on
	// every run before) and a pending Curator-side rename can't be blessed as
	// already-pushed.
	`ALTER TABLE playlist ADD COLUMN rb_name_seen TEXT`,
	// Shared analysis catalogue (apps/core/src/catalogue/) — see
	// trackAnalysis.audioHash and catalogue_entry in schema.ts. The stamp on
	// existing rows is filled by backfillAnalysisAudioHash (gated); the
	// mirror starts empty and fills from the server's inventory.
	`ALTER TABLE track_analysis ADD COLUMN audio_hash TEXT`,
	`CREATE INDEX IF NOT EXISTS track_analysis_audio_hash_idx ON track_analysis(audio_hash)`,
	`CREATE TABLE IF NOT EXISTS catalogue_entry (
		audio_hash TEXT NOT NULL,
		unit TEXT NOT NULL,
		variant TEXT NOT NULL,
		version_key TEXT NOT NULL,
		remote_rev INTEGER NOT NULL DEFAULT 0,
		bytes INTEGER NOT NULL DEFAULT 0,
		local_state TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (audio_hash, unit, variant)
	)`,
	`CREATE INDEX IF NOT EXISTS catalogue_entry_state_idx ON catalogue_entry(local_state)`,
	// Per-device rekordbox baseline for the rb analysis units — see
	// rekordboxUnitSeen in schema.ts. Starts empty: a unit's first import
	// after upgrade behaves as before (emits if it differs), then holds.
	`CREATE TABLE IF NOT EXISTS rekordbox_unit_seen (
		track_id TEXT NOT NULL REFERENCES track(id) ON DELETE CASCADE,
		unit TEXT NOT NULL,
		digest TEXT NOT NULL,
		seen_at INTEGER NOT NULL,
		PRIMARY KEY (track_id, unit)
	)`,
	// Source credits under artist alias rules — see track.artistsBase in
	// schema.ts. No backfill: a row a rule rewrote before this column keeps
	// the spelling it has (its source spelling is gone), which is the
	// behaviour it had before.
	`ALTER TABLE track ADD COLUMN artists_base TEXT`,
];

// System tags seeded on every migrate. `INSERT OR IGNORE` keeps it idempotent.
// IDs match the constants exported from @curator/shared so the renderer can
// reference them without a lookup.
const SYSTEM_TAGS: string = `
	INSERT OR IGNORE INTO tag (id, name, kind, sort_order) VALUES
		('interested', 'Interested', 'system', 0),
		('basket',     'Basket',     'system', 1);
`;

// Idempotent backfill: merge canonical track rows that share an ISRC.
//
// Spotify (and other providers) routinely surface the same recording under
// multiple provider ids — re-releases, regional variants, etc. The original
// sync code created a fresh `track` row per provider id, so the same ISRC
// could end up on 2-N canonical tracks. The forward fix (ISRC-lookup in
// SpotifySync.upsertTrack) prevents new duplicates; this migration cleans
// up everything that landed before the fix.
//
// Strategy: per ISRC group, pick the oldest createdAt as the survivor.
// Move source_links / playlist_track / track_tag rows onto the survivor,
// handling the UNIQUE / PK collision cases by keeping the survivor's row
// and dropping the duplicate's row. Finally delete the duplicate track.
// Wrapped in a single transaction so the DB stays consistent even on
// power loss mid-migrate.
//
// Duration guard: providers occasionally assign the same ISRC to materially
// different recordings (radio edit + extended mix sharing a metadata tag by
// mistake). Only merge dupes whose duration is within ±5s of the survivor;
// outliers stay as independent tracks. Survivor duration null → guard is
// permissive (fall back to ISRC-trust behaviour).
const DUR_TOLERANCE_S = 5;

// Idempotent backfill: fill track.release_date for rows that don't have one
// yet, using data we already hold in source_link payloads (no network). Spotify
// stores the album release date on its payload (album.release_date); Beatport
// stores a track-level date (release_date) — prefer Beatport when both exist,
// matching the enricher-wins policy in LibrarySink. Only touches NULL rows;
// existing values and the forward Beatport override (at enrichment time) are
// left alone. Cheap when nothing's null (single indexed scan).
//
// Tracks whose only source carries no date (Tidal, Rekordbox, or local files
// never matched on Beatport) stay NULL — there's no date to backfill from.
function backfillReleaseDates(sqlite: Database.Database): void {
	const rows = sqlite.prepare(`
		SELECT sl.track_id AS trackId, sl.source AS source, sl.payload AS payload
		FROM source_link sl
		JOIN track t ON t.id = sl.track_id
		WHERE t.release_date IS NULL
		  AND sl.source IN ('spotify', 'beatport')
		  AND sl.payload IS NOT NULL
	`).all() as { trackId: string; source: string; payload: string }[];
	if (rows.length === 0) return;

	// Per track, collect each source's date so we can prefer Beatport's.
	const byTrack = new Map<string, { spotify?: string; beatport?: string }>();
	for (const r of rows) {
		let date: string | null = null;
		try {
			const p = JSON.parse(r.payload) as { release_date?: string; album?: { release_date?: string } };
			date = r.source === 'beatport' ? (p.release_date ?? null) : (p.album?.release_date ?? null);
		} catch { /* malformed payload — skip */ }
		if (!date) continue;
		const slot = byTrack.get(r.trackId) ?? {};
		slot[r.source as 'spotify' | 'beatport'] = date;
		byTrack.set(r.trackId, slot);
	}

	const upd = sqlite.prepare(`UPDATE track SET release_date = ? WHERE id = ? AND release_date IS NULL`);
	let filled = 0;
	const tx = sqlite.transaction(() => {
		for (const [trackId, slot] of byTrack) {
			const date = slot.beatport ?? slot.spotify;
			if (!date) continue;
			upd.run(date, trackId);
			filled++;
		}
	});
	tx();
	if (filled > 0) mlog.info('backfilled release_date from source_link payloads', { filled });
}

// One-time: collapse the dual key representation to a single canonical column.
// Key is now stored ONLY as Camelot; musical notation is a UI projection. We
// drop `track.key_musical`, but first recover any Camelot we can from it (and
// from override blobs that carried only keyMusical), so nothing salvageable is
// lost. Idempotent: once the column is gone (fresh installs, re-runs) it no-ops.
function migrateKeyToCamelotOnly(sqlite: Database.Database): void {
	const cols = sqlite.prepare(`PRAGMA table_info(track)`).all() as { name: string }[];
	if (!cols.some((c) => c.name === 'key_musical')) return; // already migrated

	// Canonical: fill key_camelot from key_musical where it's the only form.
	const rows = sqlite.prepare(
		`SELECT id, key_musical FROM track WHERE key_camelot IS NULL AND key_musical IS NOT NULL`
	).all() as { id: string; key_musical: string }[];
	const updCam = sqlite.prepare(`UPDATE track SET key_camelot = ? WHERE id = ?`);

	// Overrides: convert keyMusical→keyCamelot where the blob lacks a Camelot,
	// then strip keyMusical from every blob that carries it.
	const ovRows = sqlite.prepare(
		`SELECT id, overrides FROM track WHERE overrides IS NOT NULL AND overrides LIKE '%keyMusical%'`
	).all() as { id: string; overrides: string }[];
	const updOv = sqlite.prepare(`UPDATE track SET overrides = ? WHERE id = ?`);

	let recovered = 0;
	let ovFixed = 0;
	const tx = sqlite.transaction(() => {
		for (const r of rows) {
			const cam = keyToCamelot(r.key_musical);
			if (cam) { updCam.run(cam, r.id); recovered++; }
		}
		for (const r of ovRows) {
			let o: Record<string, unknown>;
			try { o = (JSON.parse(r.overrides) as Record<string, unknown>) ?? {}; } catch { continue; }
			if (o.keyMusical === undefined) continue;
			if (o.keyCamelot === undefined) {
				const cam = keyToCamelot(typeof o.keyMusical === 'string' ? o.keyMusical : null);
				if (cam) o.keyCamelot = cam;
			}
			delete o.keyMusical;
			updOv.run(Object.keys(o).length > 0 ? JSON.stringify(o) : null, r.id);
			ovFixed++;
		}
	});
	tx();

	// Everything salvageable now lives in key_camelot — drop the column.
	sqlite.exec(`ALTER TABLE track DROP COLUMN key_musical`);
	mlog.info('key→Camelot-only: dropped track.key_musical', { recovered, overridesFixed: ovFixed });
}

// ─── ISRC canonicalisation ──────────────────────────────────────────────────
// One-shot, versioned in app_setting. Every write path now runs ISRCs
// through normalizeIsrc (uppercase, separators stripped, shape-checked), but
// the columns still hold what file tags and older sync code wrote — 425
// lowercase and 10 hyphenated values on 2026-10-17 — which fail provider
// lookups and split dedup groups (dedupeTracksByIsrc groups by the raw column
// value). Rewrite track.isrc and source_link.isrc_local to canonical form. A
// value that is not an ISRC at all is nulled rather than "cleaned up": on
// track it is logged with the row id so nothing vanishes silently, on
// source_link it moves into payload.isrcRaw beside the link's other provider
// fields. updated_at is deliberately left alone — this is a representation
// fix, not a content change, and a bump would mark every touched track dirty
// for the next rekordbox push.
const ISRC_NORMALIZE_VERSION = 1;
const ISRC_NORMALIZE_KEY = 'isrc_normalize_version';

function normalizeIsrcColumns(sqlite: Database.Database, dbPath: string): void {
	if (readSettingInt(sqlite, ISRC_NORMALIZE_KEY) >= ISRC_NORMALIZE_VERSION) return;

	const trackRows = sqlite.prepare(`SELECT id, isrc FROM track WHERE isrc IS NOT NULL`).all() as Array<{ id: string; isrc: string }>;
	const trackRewrites: Array<{ id: string; isrc: string }> = [];
	const trackNulled: Array<{ trackId: string; raw: string }> = [];
	for (const r of trackRows) {
		const norm = normalizeIsrc(r.isrc);
		if (norm === r.isrc) continue;
		if (norm) trackRewrites.push({ id: r.id, isrc: norm });
		else trackNulled.push({ trackId: r.id, raw: r.isrc });
	}

	const linkRows = sqlite.prepare(`SELECT id, isrc_local, payload FROM source_link WHERE isrc_local IS NOT NULL`).all() as Array<{ id: string; isrc_local: string; payload: string | null }>;
	const linkRewrites: Array<{ id: string; isrc: string }> = [];
	const linkMoves: Array<{ id: string; payload: string }> = [];
	for (const r of linkRows) {
		const norm = normalizeIsrc(r.isrc_local);
		if (norm === r.isrc_local) continue;
		if (norm) { linkRewrites.push({ id: r.id, isrc: norm }); continue; }
		let base: Record<string, unknown> = {};
		if (r.payload) {
			try {
				const parsed = JSON.parse(r.payload) as unknown;
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
			} catch { /* malformed payload — the raw value still gets a home */ }
		}
		linkMoves.push({ id: r.id, payload: JSON.stringify({ ...base, isrcRaw: r.isrc_local }) });
	}

	const gate = sqlite.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
	if (trackRewrites.length + trackNulled.length + linkRewrites.length + linkMoves.length === 0) {
		// Fresh install or an already-clean library — nothing worth a backup.
		gate.run(ISRC_NORMALIZE_KEY, JSON.stringify(ISRC_NORMALIZE_VERSION), Date.now());
		return;
	}

	backupDatabase(sqlite, dbPath, 'pre-isrc-normalise');
	const updTrack = sqlite.prepare(`UPDATE track SET isrc = ? WHERE id = ?`);
	const updLink = sqlite.prepare(`UPDATE source_link SET isrc_local = ? WHERE id = ?`);
	const moveLink = sqlite.prepare(`UPDATE source_link SET isrc_local = NULL, payload = ? WHERE id = ?`);
	sqlite.transaction(() => {
		for (const u of trackRewrites) updTrack.run(u.isrc, u.id);
		for (const u of trackNulled) updTrack.run(null, u.trackId);
		for (const u of linkRewrites) updLink.run(u.isrc, u.id);
		for (const u of linkMoves) moveLink.run(u.payload, u.id);
		gate.run(ISRC_NORMALIZE_KEY, JSON.stringify(ISRC_NORMALIZE_VERSION), Date.now());
	})();
	mlog.info('normalised ISRC columns', {
		tracksRewritten: trackRewrites.length,
		tracksNulled: trackNulled.length,
		tracksNulledExamples: trackNulled.slice(0, 20),
		linksRewritten: linkRewrites.length,
		linksMovedToPayload: linkMoves.length,
	});
}

// Live rows only. A soft-deleted row is a tombstone, not a duplicate: a track
// merge leaves the ISRC on both the survivor and the deleted loser, and the
// loser is usually the OLDER row — so counting it made the loser the
// "survivor", pulled the kept row's file/playlists/tags back onto the
// tombstone and hard-deleted the kept row (and its rekordbox_link via
// cascade). Undid every such merge on the next launch (2026-09-23).
//
// Derived rows (derived_from_track_id set — e.g. a "Convert to WAV" copy) are
// excluded too: they are deliberate same-recording copies, and this pass
// HARD-deletes duplicates. The copy is minted with isrc = NULL, so this guard
// only matters if something later writes an ISRC onto it.
//
// Grouping by the raw column value is correct only because the column holds
// exactly one spelling per ISRC: normalizeIsrcColumns ran before this on the
// first boot after it shipped, and every write path since goes through
// normalizeIsrc. No LOWER()/REPLACE() here — that would also defeat
// track_isrc_idx on the per-group lookup.
function dedupeTracksByIsrc(sqlite: Database.Database): void {
	const dupGroups = sqlite.prepare(`
		SELECT isrc FROM track
		WHERE isrc IS NOT NULL AND isrc != '' AND deleted_at IS NULL AND derived_from_track_id IS NULL
		GROUP BY isrc HAVING COUNT(*) > 1
	`).all() as { isrc: string }[];

	if (dupGroups.length === 0) return;

	// Canonical-track fields we coalesce up to the survivor. Enrichment
	// writes (Beatport BPM/key/genre/label, Tidal ISRC fixups) often land
	// on a younger duplicate row before merge; if the older survivor's
	// field is null, we want to inherit the dupe's value rather than lose
	// the data when its row gets deleted.
	const INHERITABLE = [
		'bpm', 'key_camelot', 'genre', 'label',
		'album_title', 'release_date', 'mbid', 'cover_url',
		'copyright', 'explicit',
	] as const;
	const selectFields = `id, ${INHERITABLE.join(', ')}`;
	const setClauses = INHERITABLE.map((f) => `${f} = ?`).join(', ');

	let mergedCount = 0;
	let inheritedFields = 0;
	let skippedDurMismatch = 0;
	const tx = sqlite.transaction(() => {
		for (const { isrc } of dupGroups) {
			const group = sqlite.prepare(`
				SELECT id, duration FROM track WHERE isrc = ? AND deleted_at IS NULL AND derived_from_track_id IS NULL ORDER BY created_at ASC, id ASC
			`).all(isrc) as { id: string; duration: number | null }[];
			if (group.length < 2) continue;
			const survivor = group[0]!.id;
			const survivorDur = group[0]!.duration;
			const dupes = group.slice(1);

			// Coalesce metadata onto the survivor before we delete its
			// dupes. Skip dupes that the duration guard will reject so we
			// don't pull data from rows we're going to leave standing.
			const eligibleDupeIds: string[] = [];
			for (const dup of dupes) {
				if (survivorDur != null && dup.duration != null && Math.abs(dup.duration - survivorDur) > DUR_TOLERANCE_S) {
					skippedDurMismatch++;
					continue;
				}
				eligibleDupeIds.push(dup.id);
			}
			if (eligibleDupeIds.length > 0) {
				const placeholders = ['?', ...eligibleDupeIds.map(() => '?')].join(',');
				const rows = sqlite.prepare(`SELECT ${selectFields} FROM track WHERE id IN (${placeholders})`).all(survivor, ...eligibleDupeIds) as Array<Record<string, unknown>>;
				const survivorRow = rows.find((r) => r.id === survivor) as Record<string, unknown>;
				const next = { ...survivorRow };
				let changed = false;
				for (const dup of rows) {
					if (dup.id === survivor) continue;
					for (const f of INHERITABLE) {
						if ((next[f] === null || next[f] === undefined || next[f] === '') && dup[f] != null && dup[f] !== '') {
							next[f] = dup[f];
							inheritedFields++;
							changed = true;
						}
					}
				}
				if (changed) {
					const values = INHERITABLE.map((f) => next[f] ?? null);
					sqlite.prepare(`UPDATE track SET ${setClauses}, updated_at = (unixepoch() * 1000) WHERE id = ?`).run(...values, survivor);
				}
			}

			for (const dup of dupes) {
				// Duration guard. Skip merge for outliers — likely a
				// provider-side ISRC collision between distinct mixes.
				if (survivorDur != null && dup.duration != null) {
					if (Math.abs(dup.duration - survivorDur) > DUR_TOLERANCE_S) {
						// Already counted in skippedDurMismatch above.
						continue;
					}
				}
				const dupId = dup.id;
				// Sync (cloud scenario 14): this fold must reach every other
				// device as `recording.merge`, or they keep two rows where this
				// one has one and diverge silently. Read what the re-assert
				// needs before the cascade below takes the dupe's cues.
				const dupRecording = (sqlite.prepare(`SELECT recording_id FROM track WHERE id = ?`).get(dupId) as { recording_id: string | null } | undefined)?.recording_id ?? null;
				const dupCueSlots = sqlite.prepare(`SELECT slot, kind FROM cue WHERE track_id = ?`).all(dupId) as Array<{ slot: number; kind: 'hot' | 'memory' }>;
				// source_link — UNIQUE (source, source_track_id). If the
				// survivor already owns a link with the same provider id,
				// drop the duplicate's; otherwise re-point it.
				const dupLinks = sqlite.prepare(`
					SELECT id, source, source_track_id FROM source_link WHERE track_id = ?
				`).all(dupId) as { id: string; source: string; source_track_id: string }[];
				for (const link of dupLinks) {
					const clash = sqlite.prepare(`
						SELECT id FROM source_link
						WHERE track_id = ? AND source = ? AND source_track_id = ?
					`).get(survivor, link.source, link.source_track_id);
					if (clash) {
						sqlite.prepare(`DELETE FROM source_link WHERE id = ?`).run(link.id);
					} else {
						sqlite.prepare(`UPDATE source_link SET track_id = ? WHERE id = ?`).run(survivor, link.id);
					}
				}

				// playlist_track — keyed by row id, and neither the id nor the
				// unique (playlist_id, position) involves track_id, so the
				// re-point cannot collide. The schema explicitly allows the
				// same track to appear at multiple positions in a playlist.
				sqlite.prepare(`UPDATE playlist_track SET track_id = ? WHERE track_id = ?`).run(survivor, dupId);

				// track_tag — PK is (track_id, tag_id). If the duplicate
				// carries a tag the survivor already has, drop the dupe's
				// row; otherwise re-point it.
				const dupTags = sqlite.prepare(`SELECT tag_id FROM track_tag WHERE track_id = ?`).all(dupId) as { tag_id: string }[];
				for (const { tag_id } of dupTags) {
					const clash = sqlite.prepare(`SELECT 1 FROM track_tag WHERE track_id = ? AND tag_id = ?`).get(survivor, tag_id);
					if (clash) {
						sqlite.prepare(`DELETE FROM track_tag WHERE track_id = ? AND tag_id = ?`).run(dupId, tag_id);
					} else {
						sqlite.prepare(`UPDATE track_tag SET track_id = ? WHERE track_id = ? AND tag_id = ?`).run(survivor, dupId, tag_id);
					}
				}

				sqlite.prepare(`DELETE FROM track WHERE id = ?`).run(dupId);
				// Every row of the dupe was re-pointed (none dropped), so the
				// only re-assert beyond the survivor's state is its cue slots.
				if (dupRecording) mergeRecordingRaw(sqlite, { loserRecordingId: dupRecording, winnerTrackId: survivor, droppedMemberRows: [], loserCueSlots: dupCueSlots });
				mergedCount++;
			}
		}
	});
	tx();
	if (mergedCount > 0 || skippedDurMismatch > 0) {
		mlog.info('merged duplicate track rows by ISRC (coalesced canonical fields from younger dupes onto survivors)', {
			merged: mergedCount,
			isrcGroups: dupGroups.length,
			inheritedFields,
			skippedDurMismatch,
			durToleranceS: DUR_TOLERANCE_S,
		});
	}
}

// One-time backfill of the diacritic-folded shadow columns on `track`.
// Runs after every migrate() but is idempotent — only touches rows where
// at least one *_ascii column is still NULL. New rows get their values
// from asciify() at write time, so the WHERE clause keeps the second
// invocation essentially free.
// One-time backfill of playlist + playlist_folder name_ascii. Same shape as
// backfillAsciiColumns — idempotent, only touches rows where name_ascii is
// still NULL. Write-path mirroring at sync/insert/rename sites keeps the
// second invocation a no-op.
function backfillPlaylistAscii(sqlite: Database.Database): void {
	const playlistRows = sqlite.prepare(
		`SELECT id, name FROM playlist WHERE name_ascii IS NULL`
	).all() as Array<{ id: string; name: string | null }>;
	const folderRows = sqlite.prepare(
		`SELECT id, name FROM playlist_folder WHERE name_ascii IS NULL`
	).all() as Array<{ id: string; name: string | null }>;
	if (playlistRows.length === 0 && folderRows.length === 0) return;

	const updPl = sqlite.prepare(`UPDATE playlist SET name_ascii = ? WHERE id = ?`);
	const updFd = sqlite.prepare(`UPDATE playlist_folder SET name_ascii = ? WHERE id = ?`);
	const tx = sqlite.transaction(() => {
		for (const r of playlistRows) updPl.run(searchFold(r.name), r.id);
		for (const r of folderRows) updFd.run(searchFold(r.name), r.id);
	});
	tx();
	mlog.info('backfilled name_ascii', { playlists: playlistRows.length, folders: folderRows.length });
}

function backfillAsciiColumns(sqlite: Database.Database): void {
	type Row = { id: string; title: string | null; album_title: string | null; label: string | null; genre: string | null; artists: string | null };
	const rows = sqlite.prepare(`
		SELECT id, title, album_title, label, genre, artists FROM track
		WHERE title_ascii IS NULL
			OR album_title_ascii IS NULL
			OR label_ascii IS NULL
			OR genre_ascii IS NULL
			OR artists_ascii IS NULL
	`).all() as Row[];
	if (rows.length === 0) return;

	const update = sqlite.prepare(`
		UPDATE track SET
			title_ascii = ?,
			album_title_ascii = ?,
			label_ascii = ?,
			genre_ascii = ?,
			artists_ascii = ?
		WHERE id = ?
	`);
	const tx = sqlite.transaction(() => {
		for (const r of rows) {
			let artistsAscii = '';
			if (r.artists) {
				try {
					const arr = JSON.parse(r.artists) as Array<{ name?: string }>;
					if (Array.isArray(arr)) {
						artistsAscii = arr.map((a) => searchFold(a?.name ?? '')).filter(Boolean).join(' | ');
					}
				} catch {
					// Malformed JSON shouldn't fail the whole backfill — leave
					// artists_ascii empty for this row and let the next write fix it.
				}
			}
			update.run(
				searchFold(r.title),
				searchFold(r.album_title),
				searchFold(r.label),
				searchFold(r.genre),
				artistsAscii,
				r.id
			);
		}
	});
	tx();
	mlog.info('backfilled *_ascii columns', { tracks: rows.length });
}

// Bump whenever searchFold's normalization rules change. The persisted
// `*_ascii` columns are derived from the fold; a rule change makes every
// stored value stale, and the NULL-gated backfills above won't touch a
// non-null-but-wrong value. refoldAllAscii re-derives every row once, gated
// on PRAGMA user_version so it runs exactly once per fold revision.
//
//   v1 — strip connector punctuation (. - _ ' ‘ ’) so "DWY" ↔ "D.W.Y".
const FOLD_VERSION = 1;

// Unconditional re-fold of every `*_ascii` value on track + playlist +
// playlist_folder. Unlike backfillAsciiColumns this ignores NULL-ness — it
// rewrites all rows — so it must stay behind the user_version gate to avoid
// a full-table rewrite on every boot.
function refoldAllAscii(sqlite: Database.Database): void {
	type Row = { id: string; title: string | null; album_title: string | null; label: string | null; genre: string | null; artists: string | null };
	const rows = sqlite.prepare(
		`SELECT id, title, album_title, label, genre, artists FROM track`
	).all() as Row[];
	const updTrack = sqlite.prepare(`
		UPDATE track SET
			title_ascii = ?, album_title_ascii = ?, label_ascii = ?,
			genre_ascii = ?, artists_ascii = ?
		WHERE id = ?
	`);
	const playlistRows = sqlite.prepare(`SELECT id, name FROM playlist`).all() as Array<{ id: string; name: string | null }>;
	const folderRows = sqlite.prepare(`SELECT id, name FROM playlist_folder`).all() as Array<{ id: string; name: string | null }>;
	const updPl = sqlite.prepare(`UPDATE playlist SET name_ascii = ? WHERE id = ?`);
	const updFd = sqlite.prepare(`UPDATE playlist_folder SET name_ascii = ? WHERE id = ?`);

	const tx = sqlite.transaction(() => {
		for (const r of rows) {
			let artistsAscii = '';
			if (r.artists) {
				try {
					const arr = JSON.parse(r.artists) as Array<{ name?: string }>;
					if (Array.isArray(arr)) {
						artistsAscii = arr.map((a) => searchFold(a?.name ?? '')).filter(Boolean).join(' | ');
					}
				} catch {
					// Malformed JSON — leave artists_ascii empty; next write fixes it.
				}
			}
			updTrack.run(
				searchFold(r.title), searchFold(r.album_title), searchFold(r.label),
				searchFold(r.genre), artistsAscii, r.id
			);
		}
		for (const r of playlistRows) updPl.run(searchFold(r.name), r.id);
		for (const r of folderRows) updFd.run(searchFold(r.name), r.id);
		refoldArtistTable(sqlite);
	});
	tx();
	mlog.info('re-folded *_ascii', { tracks: rows.length, playlists: playlistRows.length, folders: folderRows.length, foldVersion: FOLD_VERSION });
}

// artist.name_ascii is the identity key, so a fold-rule change can make two
// rows collide. Re-fold each row; when the new fold already belongs to
// another live row, turn this one into an alias of it (the seam follows
// merged_into, so track_artist re-points on the rebuild below). Then rebuild
// every track's junction rows + artist_sort from the JSON, which is
// unaffected by the fold. Runs inside refoldAllAscii's transaction.
function refoldArtistTable(sqlite: Database.Database): void {
	type A = { id: string; name: string; name_ascii: string; merged_into: string | null };
	const artists = sqlite.prepare(`SELECT id, name, name_ascii, merged_into FROM artist`).all() as A[];
	const byFold = sqlite.prepare(`SELECT id FROM artist WHERE name_ascii = ? AND id != ?`);
	const setFold = sqlite.prepare(`UPDATE artist SET name_ascii = ? WHERE id = ?`);
	const setAlias = sqlite.prepare(`UPDATE artist SET merged_into = ?, name_ascii = ? WHERE id = ?`);
	let aliased = 0;
	for (const a of artists) {
		const fold = artistKey(a.name);
		if (fold === a.name_ascii) continue;
		const clash = byFold.get(fold, a.id) as { id: string } | undefined;
		if (clash) {
			// Keep the UNIQUE index honest: the alias row parks under a
			// synthetic fold nobody will ever search for.
			setAlias.run(a.merged_into ?? clash.id, `${fold}#alias:${a.id}`, a.id);
			aliased++;
		} else {
			setFold.run(fold, a.id);
		}
	}
	const rows = sqlite.prepare(`SELECT id, artists, overrides FROM track`).all() as Array<{ id: string; artists: string; overrides: string | null }>;
	syncTrackArtistsRaw(sqlite, rows);
	if (aliased) mlog.info('re-fold aliased colliding artists', { aliased });
}

// ─── artist / track_artist backfill ─────────────────────────────────────────
// One-shot, versioned in app_setting (not PRAGMA user_version — that is the
// fold-rule gate and this isn't a fold change). Splits every packed credit
// left behind by the rekordbox pull / local-tag fallback ("Rampa, Adam Port,
// &ME" as ONE TrackArtist), drops the positional roles the sync writers used
// to fabricate (i===0 ? main : featured — nothing ever read them, and
// rendering them would print "Rampa feat. Adam Port"), then populates the
// artist tables from the normalized JSON.
//
// The protect set keeps a name with a separator whole only when SPOTIFY's
// artist entity vouches for it: a payload artist object carrying an id
// ("Crosby, Stills & Nash", "TH;EN", "Yusuf / Cat Stevens"). Nothing weaker
// counts — not a multi-element array (two ID3 frames can hold one packed
// credit beside a clean one), not artists_local (Beatport enrichment
// appends the packed tag beside its scraped names), and not Tidal entities:
// Tidal mints combined artists for collaboration singles ("Paons, Dave DK"
// is a real Tidal id), which is exactly the packing we're undoing. Audit
// 2026-09-21 found six packed names protected those ways.
const ARTIST_BACKFILL_VERSION = 1;
const ARTIST_BACKFILL_KEY = 'artist_backfill_version';

function readSettingInt(sqlite: Database.Database, key: string): number {
	const row = sqlite.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(key) as { value: string } | undefined;
	if (!row) return 0;
	try {
		const n = Number(JSON.parse(row.value));
		return Number.isFinite(n) ? n : 0;
	} catch {
		return 0;
	}
}

function backfillArtistTables(sqlite: Database.Database, dbPath: string): void {
	if (readSettingInt(sqlite, ARTIST_BACKFILL_KEY) >= ARTIST_BACKFILL_VERSION) {
		repairArtistTables(sqlite);
		return;
	}
	backupDatabase(sqlite, dbPath, 'pre-artist-backfill');

	type Row = { id: string; title: string; artists: string; overrides: string | null };
	const rows = sqlite.prepare(`SELECT id, title, artists, overrides FROM track`).all() as Row[];
	const parse = (s: string | null): TrackArtist[] => {
		if (!s) return [];
		try { const v = JSON.parse(s) as unknown; return Array.isArray(v) ? (v as TrackArtist[]) : []; } catch { return []; }
	};
	const parseOv = (s: string | null): TrackOverrides | null => {
		if (!s) return null;
		try { return JSON.parse(s) as TrackOverrides; } catch { return null; }
	};

	// 1. Protect set — Spotify artist entities (objects with an id) only.
	const protect = new Set<string>();
	const parsed = rows.map((r) => ({ id: r.id, title: r.title, artists: parse(r.artists), overrides: parseOv(r.overrides) }));
	for (const l of sqlite.prepare(`SELECT json_extract(payload, '$.artists') AS artists FROM source_link WHERE payload IS NOT NULL AND source = 'spotify'`).all() as Array<{ artists: string | null }>) {
		if (!l.artists) continue;
		try {
			const refs = JSON.parse(l.artists) as Array<{ id?: unknown; name?: unknown }>;
			if (!Array.isArray(refs)) continue;
			for (const a of refs) {
				if (a && a.id != null && typeof a.name === 'string' && a.name.trim()) protect.add(searchFold(a.name.trim()));
			}
		} catch { /* malformed payload — nothing to learn */ }
	}
	const isProtected = (fold: string): boolean => protect.has(fold);

	// 2. Split + role strip; rewrite only rows that changed.
	const strip = (list: TrackArtist[]): TrackArtist[] => list.map((a) => ({ name: a?.name ?? '' }));
	const upd = sqlite.prepare(`UPDATE track SET artists = ?, overrides = ?, artists_ascii = ? WHERE id = ?`);
	let tracksRewritten = 0;
	let packedSplit = 0;
	let protectedKept = 0;
	let remixersTagged = 0;
	let remixersAdded = 0;
	let spellingsFixed = 0;
	let linksAdded = 0;
	const tx = sqlite.transaction(() => {
		for (const r of parsed) {
			const nextArtists = normalizeArtistList(strip(r.artists), { protect: isProtected });
			let nextOverrides = r.overrides;
			if (r.overrides?.artists) {
				const ov = normalizeArtistList(strip(r.overrides.artists), { protect: isProtected });
				nextOverrides = { ...r.overrides, artists: ov };
			}
			const artistsChanged = JSON.stringify(nextArtists) !== JSON.stringify(r.artists);
			const overridesChanged = JSON.stringify(nextOverrides) !== JSON.stringify(r.overrides);
			for (const a of [...r.artists, ...(r.overrides?.artists ?? [])]) {
				if (a?.name && isPackedCredit(a.name)) {
					if (isProtected(searchFold(a.name))) protectedKept++; else packedSplit++;
				}
			}
			if (artistsChanged || overridesChanged) {
				upd.run(
					JSON.stringify(nextArtists),
					nextOverrides ? JSON.stringify(nextOverrides) : null,
					nextArtists.map((a) => searchFold(a.name)).filter(Boolean).join(' | '),
					r.id,
				);
				tracksRewritten++;
			}
			r.artists = nextArtists;
			r.overrides = nextOverrides;
		}
		// 3. Populate the tables from the normalized lists.
		syncTrackArtistsRaw(sqlite, parsed);
		// 4. Remixers off the titles — now that the artist table knows every
		// split name, "(X Remix)" resolves X against it. Titles untouched.
		const knownStmt = sqlite.prepare(`SELECT 1 FROM artist WHERE name_ascii = ?`);
		const known = (fold: string): boolean => knownStmt.get(fold) != null;
		const remixRows: typeof parsed = [];
		for (const r of parsed) {
			const title = r.overrides?.title ?? r.title;
			const nextArtists = applyRemixers(r.artists, title, { known });
			let nextOverrides = r.overrides;
			if (r.overrides?.artists) {
				const ov = applyRemixers(r.overrides.artists, title, { known });
				if (ov !== r.overrides.artists) nextOverrides = { ...r.overrides, artists: ov };
			}
			if (nextArtists === r.artists && nextOverrides === r.overrides) continue;
			for (const a of (nextOverrides?.artists ?? nextArtists)) {
				if (a.role !== 'remixer') continue;
				const before = (r.overrides?.artists ?? r.artists).find((b) => searchFold(b.name) === searchFold(a.name));
				if (before) remixersTagged++; else remixersAdded++;
			}
			upd.run(
				JSON.stringify(nextArtists),
				nextOverrides ? JSON.stringify(nextOverrides) : null,
				nextArtists.map((a) => searchFold(a.name)).filter(Boolean).join(' | '),
				r.id,
			);
			r.artists = nextArtists;
			r.overrides = nextOverrides;
			remixRows.push(r);
		}
		syncTrackArtistsRaw(sqlite, remixRows);
		// 5. Display spelling = the most-credited spelling. The seam names a
		// row after the first spelling it meets; with identity ignoring
		// punctuation and spaces, "Pig&Dan" (1 credit) must not title the
		// row over "Pig & Dan" (30). Curated names are left alone.
		const spellings = new Map<string, Map<string, number>>();
		for (const r of parsed) {
			for (const a of (r.overrides?.artists ?? r.artists)) {
				if (!a?.name) continue;
				const k = artistKey(a.name);
				const m = spellings.get(k) ?? new Map<string, number>();
				m.set(a.name.trim(), (m.get(a.name.trim()) ?? 0) + 1);
				spellings.set(k, m);
			}
		}
		const setName = sqlite.prepare(`UPDATE artist SET name = ? WHERE name_ascii = ? AND name_curated_at IS NULL AND name != ?`);
		for (const [k, m] of spellings) {
			const best = [...m.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]![0];
			if (setName.run(best, k, best).changes) spellingsFixed++;
		}
		// 6. Provider identities off the synced payloads (Spotify / Tidal
		// track.artists[] carry artist ids) — one link row per (source, id).
		// json_extract keeps this to the artists array — whole Spotify payloads
		// are ~3 KB each and 40k of them don't belong in memory at once.
		const linkRows = sqlite.prepare(`SELECT source, json_extract(payload, '$.artists') AS artists FROM source_link WHERE payload IS NOT NULL AND source IN ('spotify', 'tidal')`).all() as Array<{ source: string; artists: string | null }>;
		for (const l of linkRows) {
			if (!l.artists) continue;
			try {
				const refs = JSON.parse(l.artists) as Array<{ id?: string | number; name?: string; external_urls?: { spotify?: string } }>;
				if (Array.isArray(refs)) linksAdded += upsertArtistLinksRaw(sqlite, l.source, refs);
			} catch (err) {
				mlog.warn('artist link backfill: payload skipped', { source: l.source, error: err instanceof Error ? err.message : String(err) });
			}
		}
		sqlite.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
			.run(ARTIST_BACKFILL_KEY, JSON.stringify(ARTIST_BACKFILL_VERSION), Date.now());
	});
	tx();
	const artistCount = (sqlite.prepare(`SELECT count(*) AS n FROM artist`).get() as { n: number }).n;
	mlog.info('backfilled artist tables', { tracks: rows.length, tracksRewritten, packedSplit, protectedKept, protectSet: protect.size, remixersTagged, remixersAdded, spellingsFixed, linksAdded, artists: artistCount });
}

// Every boot, ungated and cheap: a live track with artists but no junction
// rows means a write site bypassed the seam. Heal it and say so.
function repairArtistTables(sqlite: Database.Database): void {
	const rows = sqlite.prepare(`
		SELECT t.id, t.artists, t.overrides FROM track t
		WHERE t.deleted_at IS NULL AND t.artists != '[]'
			AND NOT EXISTS (SELECT 1 FROM track_artist ta WHERE ta.track_id = t.id)
	`).all() as Array<{ id: string; artists: string; overrides: string | null }>;
	if (rows.length === 0) return;
	sqlite.transaction(() => syncTrackArtistsRaw(sqlite, rows))();
	mlog.warn('repaired tracks missing artist rows (a write site bypassed the artist seam)', { tracks: rows.length });
}

// ─── album / album_artist / album_link backfill ─────────────────────────────
// One-shot, versioned in app_setting like the artist backfill: derive every
// live track's release through the album seam (in albumBackfillOrderRaw's
// order, so provider-backed releases claim their keys before a guess can),
// then a cheap per-boot repair. Writes only the new tables + track.album_id
// / track_number / disc_number, but it touches every row, so it backs up
// first like the artist one.
const ALBUM_BACKFILL_VERSION = 1;
const ALBUM_BACKFILL_KEY = 'album_backfill_version';

function backfillAlbumTables(sqlite: Database.Database, dbPath: string): void {
	if (readSettingInt(sqlite, ALBUM_BACKFILL_KEY) >= ALBUM_BACKFILL_VERSION) {
		const fixed = repairAlbumTablesRaw(sqlite);
		if (fixed > 0) mlog.warn('repaired tracks missing an album (a write site bypassed the album seam)', { tracks: fixed });
		return;
	}
	backupDatabase(sqlite, dbPath, 'pre-album-backfill');
	const started = Date.now();
	const ids = albumBackfillOrderRaw(sqlite);
	sqlite.transaction(() => {
		syncTrackAlbumsRaw(sqlite, ids);
		sqlite.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
			.run(ALBUM_BACKFILL_KEY, JSON.stringify(ALBUM_BACKFILL_VERSION), Date.now());
	})();
	const count = (sql: string): number => (sqlite.prepare(sql).get() as { n: number }).n;
	mlog.info('backfilled album tables', {
		tracks: ids.length,
		tracksWithAlbum: count(`SELECT count(*) AS n FROM track WHERE deleted_at IS NULL AND album_id IS NOT NULL`),
		albums: count(`SELECT count(*) AS n FROM album WHERE merged_into IS NULL`),
		various: count(`SELECT count(*) AS n FROM album WHERE merged_into IS NULL AND artists_source = 'various'`),
		providerArtists: count(`SELECT count(*) AS n FROM album WHERE merged_into IS NULL AND artists_source = 'source'`),
		links: count(`SELECT count(*) AS n FROM album_link`),
		trackNumbers: count(`SELECT count(*) AS n FROM track WHERE deleted_at IS NULL AND track_number IS NOT NULL`),
		ms: Date.now() - started,
	});
}

// Sync schema (cloud plan B3), one gated pass behind one backup:
//
//   - track.recording_id for every row, soft-deleted ones included so a
//     tombstone has an identity to tombstone.
//   - playlist_track rebuilt from PRIMARY KEY (playlist_id, position) to a row
//     id plus a fractional order key. SQLite cannot change a primary key, so
//     this is the documented table rebuild (sqlite.org/lang_altertable.html,
//     "Making Other Kinds Of Table Schema Changes"): foreign keys off outside
//     the transaction, create the new table, copy, drop, rename, recreate the
//     indexes, foreign_key_check, commit. Rows keep their current order
//     (position, then insertion order) and get evenly spaced keys per
//     playlist; position is re-based to 0..n-1, which also folds the 1-based
//     numbering the old reorder wrote. Duplicates stay — identity is the
//     row, not the track.
//
// updated_at is left alone: neither change is a content edit, and a bump
// would mark every track dirty for the next rekordbox push.
//
// The gate records the one-shot; the rebuild itself is keyed on the table's
// shape so it can never run twice, and the null-recording_id fill runs on
// every boot (an indexed no-op once filled) so an insert site that forgets
// the column is healed on the next launch with the id it should have
// written (recordingIdForTrack is deterministic).
const SYNC_SCHEMA_VERSION = 1;
const SYNC_SCHEMA_KEY = 'sync_schema_version';

function hasColumn(sqlite: Database.Database, table: string, column: string): boolean {
	return (sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>).some((c) => c.name === column);
}

function fillRecordingIds(sqlite: Database.Database): number {
	const ids = sqlite.prepare(`SELECT id FROM track WHERE recording_id IS NULL`).pluck().all() as string[];
	if (ids.length === 0) return 0;
	const upd = sqlite.prepare(`UPDATE track SET recording_id = ? WHERE id = ?`);
	sqlite.transaction(() => {
		for (const id of ids) upd.run(recordingIdForTrack(id), id);
	})();
	return ids.length;
}

function rebuildPlaylistTrack(sqlite: Database.Database): { rows: number; playlists: number } {
	const fkViolations = (): number => (sqlite.prepare(`PRAGMA foreign_key_check(playlist_track)`).all() as unknown[]).length;
	// Violations the old table already carried (rows written while foreign
	// keys were off) are copied as they are — this pass changes layout, not
	// content — so only an INCREASE means the rebuild broke something.
	const before = fkViolations();
	const rows = sqlite.prepare(`
		SELECT playlist_id, track_id, position, added_at, added_by, source_track_id
		FROM playlist_track
		ORDER BY playlist_id, position, rowid
	`).all() as Array<{ playlist_id: string; track_id: string; position: number; added_at: number | null; added_by: string | null; source_track_id: string }>;
	sqlite.exec(`DROP TABLE IF EXISTS playlist_track_v2; CREATE TABLE playlist_track_v2 (${PLAYLIST_TRACK_COLUMNS});`);
	const ins = sqlite.prepare(`
		INSERT INTO playlist_track_v2 (id, playlist_id, track_id, order_key, position, added_at, added_by, source_track_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);
	let playlists = 0;
	for (let i = 0; i < rows.length;) {
		let j = i;
		while (j < rows.length && rows[j]!.playlist_id === rows[i]!.playlist_id) j++;
		const keys = rebalance(j - i);
		for (let k = i; k < j; k++) {
			const r = rows[k]!;
			ins.run(randomUUID(), r.playlist_id, r.track_id, keys[k - i]!, k - i, r.added_at, r.added_by, r.source_track_id);
		}
		playlists++;
		i = j;
	}
	sqlite.exec(`DROP TABLE playlist_track; ALTER TABLE playlist_track_v2 RENAME TO playlist_track;`);
	sqlite.exec(PLAYLIST_TRACK_INDEXES);
	const after = fkViolations();
	if (after > before) throw new Error(`playlist_track rebuild broke ${after - before} foreign key reference(s)`);
	return { rows: rows.length, playlists };
}

function migrateSyncSchema(sqlite: Database.Database, dbPath: string): void {
	const gated = readSettingInt(sqlite, SYNC_SCHEMA_KEY) >= SYNC_SCHEMA_VERSION;
	const oldShape = !hasColumn(sqlite, 'playlist_track', 'order_key');
	if (gated && !oldShape) {
		sqlite.exec(PLAYLIST_TRACK_INDEXES);
		const healed = fillRecordingIds(sqlite);
		if (healed > 0) mlog.warn('filled missing track.recording_id (an insert site skipped it)', { tracks: healed });
		return;
	}

	const missing = (sqlite.prepare(`SELECT count(*) AS n FROM track WHERE recording_id IS NULL`).get() as { n: number }).n;
	const hasMembers = oldShape && sqlite.prepare(`SELECT 1 FROM playlist_track LIMIT 1`).get() != null;
	// A fresh install, or a library with nothing to rewrite, needs no backup.
	if (missing > 0 || hasMembers) backupDatabase(sqlite, dbPath, 'pre-sync-schema');

	const started = Date.now();
	let rebuilt = { rows: 0, playlists: 0 };
	let minted = 0;
	// PRAGMA foreign_keys is a no-op inside a transaction, so it is switched
	// around it, and always restored.
	if (oldShape) sqlite.pragma('foreign_keys = OFF');
	try {
		sqlite.transaction(() => {
			if (oldShape) rebuilt = rebuildPlaylistTrack(sqlite);
			minted = fillRecordingIds(sqlite);
			sqlite.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
				.run(SYNC_SCHEMA_KEY, JSON.stringify(SYNC_SCHEMA_VERSION), Date.now());
		})();
	} finally {
		if (oldShape) sqlite.pragma('foreign_keys = ON');
	}
	sqlite.exec(PLAYLIST_TRACK_INDEXES);
	mlog.info('sync schema migrated', {
		recordingIdsMinted: minted,
		playlistTrackRows: rebuilt.rows,
		playlists: rebuilt.playlists,
		ms: Date.now() - started,
	});
}

// One-shot: collapse the play-history restatements already in the outbox.
// Until the history import became a diff (and emitOps learned to drop
// restatements, see outbox.ts), every rekordbox sync re-emitted every play
// session and play event: the live library held 87k pending play_event ops
// for 29k plays after three syncs.
//
// What is removed: a pending row whose NEXT op on the same entity (same
// entity + entity_id, any kind, by seq_local) is identical in kind and
// payload. The later copy is kept, not the earlier: the local reducer
// records (sync_state) hold the clock of the latest op, so keeping it leaves
// every record's clock pointing at an op that will still be pushed; keeping
// the earliest would let a remote write stamped between the two copies
// resolve differently here than on every other device. Only consecutive
// copies collapse: in A, B, A the second A is a real change back.
//
// Only play_session / play_event: those were restated, and nothing writes
// their records under another entity id. Other entities are left alone —
// a playlist row's key is also written by its playlist's rekey, a
// recording's fields by a merge — so "consecutive on the entity id" would
// not mean "nothing in between" for them.
//
// Only on a library that never synced: no account bound, no device
// registered, no pull cursor, every outbox row still pending. Once anything
// has been pushed the log is shared history and is never rewritten here.
// Acked / pushed / rejected rows are never touched.
const OUTBOX_DEDUPE_VERSION = 1;
const OUTBOX_DEDUPE_KEY = 'outbox_dedupe_version';
const OUTBOX_DEDUPE_ENTITIES = ['play_session', 'play_event'] as const;

function dedupeOutboxRestatements(sqlite: Database.Database, dbPath: string): void {
	if (readSettingInt(sqlite, OUTBOX_DEDUPE_KEY) >= OUTBOX_DEDUPE_VERSION) return;
	const gate = sqlite.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
	const done = (): void => { gate.run(OUTBOX_DEDUPE_KEY, JSON.stringify(OUTBOX_DEDUPE_VERSION), Date.now()); };

	const client = sqlite.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(CLIENT_STATE_KEY) as { value: string } | undefined;
	let bound = false;
	if (client) {
		try {
			const st = JSON.parse(client.value) as { userId?: unknown; registeredFor?: unknown };
			bound = !!st.userId || !!st.registeredFor;
		} catch {
			bound = true; // unreadable: assume the worst, leave the log alone
		}
	}
	const pulled = (sqlite.prepare(`SELECT COALESCE(MAX(last_seq), 0) AS s FROM sync_cursor`).get() as { s: number }).s > 0;
	const pushed = sqlite.prepare(`SELECT 1 FROM sync_outbox WHERE state != 'pending' LIMIT 1`).get() !== undefined;
	if (bound || pulled || pushed) {
		mlog.info('outbox dedupe skipped: library has synced', { bound, pulled, pushed });
		done();
		return;
	}

	const placeholders = OUTBOX_DEDUPE_ENTITIES.map(() => '?').join(',');
	const doomed = sqlite.prepare(`
		SELECT op_id FROM (
			SELECT op_id, kind, payload,
				LEAD(kind) OVER w AS next_kind,
				LEAD(payload) OVER w AS next_payload
			FROM sync_outbox
			WHERE state = 'pending' AND entity IN (${placeholders})
			WINDOW w AS (PARTITION BY entity, entity_id ORDER BY seq_local)
		)
		WHERE next_kind = kind AND next_payload = payload
	`).pluck().all(...OUTBOX_DEDUPE_ENTITIES) as string[];
	if (doomed.length === 0) {
		done();
		return;
	}

	backupDatabase(sqlite, dbPath, 'pre-outbox-dedupe');
	const before = (sqlite.prepare(`SELECT count(*) AS n FROM sync_outbox`).get() as { n: number }).n;
	const del = sqlite.prepare(`DELETE FROM sync_outbox WHERE op_id = ? AND state = 'pending'`);
	let removed = 0;
	sqlite.transaction(() => {
		for (const id of doomed) removed += del.run(id).changes;
		done();
	})();
	mlog.info('outbox restatements removed', { removed, outboxBefore: before, outboxAfter: before - removed });
}

// ─── track_analysis.audio_hash backfill ─────────────────────────────────────
// One-shot, versioned in app_setting. Rows analysed before the stamp existed
// get the hash of their track's single live local link: with one file there
// is only one audio the Curator slot can have been computed from. A track
// with two or more live local links (a duplicate copy, a WAV conversion
// sharing the row) stays NULL — which file was analysed is unknown, so the
// row is neither shared nor filled from the catalogue until a fresh analysis
// stamps it. Writes only the new column, so no backup: nothing it touches
// existed before this version.
const CATALOGUE_HASH_VERSION = 1;
const CATALOGUE_HASH_KEY = 'catalogue_hash_version';

function backfillAnalysisAudioHash(sqlite: Database.Database): void {
	if (readSettingInt(sqlite, CATALOGUE_HASH_KEY) >= CATALOGUE_HASH_VERSION) return;
	const started = Date.now();
	let stamped = 0;
	sqlite.transaction(() => {
		stamped = sqlite.prepare(`
			UPDATE track_analysis SET audio_hash = (
				SELECT sl.audio_hash FROM source_link sl
				WHERE sl.track_id = track_analysis.track_id AND sl.source = 'local' AND sl.missing_at IS NULL
			)
			WHERE audio_hash IS NULL
				AND (SELECT count(*) FROM source_link sl
					WHERE sl.track_id = track_analysis.track_id AND sl.source = 'local' AND sl.missing_at IS NULL) = 1
				AND EXISTS (SELECT 1 FROM source_link sl
					WHERE sl.track_id = track_analysis.track_id AND sl.source = 'local' AND sl.missing_at IS NULL
						AND sl.audio_hash IS NOT NULL)
		`).run().changes;
		sqlite.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
			.run(CATALOGUE_HASH_KEY, JSON.stringify(CATALOGUE_HASH_VERSION), Date.now());
	})();
	const total = (sqlite.prepare(`SELECT count(*) AS n FROM track_analysis`).get() as { n: number }).n;
	mlog.info('stamped analysis rows with their audio hash', { stamped, rows: total, ms: Date.now() - started });
}

// Claim records written before sync_state indexed them by value (store.ts
// claimParentId): fill parent_id so the identity resolver's lookup by audio
// hash sees them. Writes only that index column of the op log's own records
// (no library content), so no backup; one-shot, gated.
const CLAIM_INDEX_VERSION = 1;
const CLAIM_INDEX_KEY = 'sync.claim_index_version';

function indexClaimRecords(sqlite: Database.Database): void {
	if (readSettingInt(sqlite, CLAIM_INDEX_KEY) >= CLAIM_INDEX_VERSION) return;
	sqlite.transaction(() => {
		const put = sqlite.prepare(`UPDATE sync_state SET parent_id = ? WHERE map = 'claims' AND key = ?`);
		let n = 0;
		for (const r of sqlite.prepare(`SELECT key, value FROM sync_state WHERE map = 'claims'`).all() as Array<{ key: string; value: string }>) {
			const v = JSON.parse(r.value) as { kind?: string; value?: string };
			if (typeof v.kind !== 'string' || typeof v.value !== 'string') continue;
			n += put.run(claimParentId(v.kind, v.value), r.key).changes;
		}
		sqlite.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
			.run(CLAIM_INDEX_KEY, JSON.stringify(CLAIM_INDEX_VERSION), Date.now());
		if (n > 0) mlog.info('indexed claim records by value', { rows: n });
	})();
}

// Consistent snapshot next to the DB before a migration that rewrites
// library content. VACUUM INTO works under WAL and needs no open
// transaction. Keeps the newest 3 per tag so the folder doesn't fill up.
function backupDatabase(sqlite: Database.Database, dbPath: string, tag: string): void {
	if (dbPath === ':memory:' || !existsSync(dbPath)) return;
	const dir = dirname(dbPath);
	const base = basename(dbPath);
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const target = join(dir, `${base}.${tag}-${stamp}.bak`);
	sqlite.exec(`VACUUM INTO '${target.replace(/'/g, "''").replace(/\\/g, '/')}'`);
	mlog.info('database backup written', { target });
	const prefix = `${base}.${tag}-`;
	const olds = readdirSync(dir)
		.filter((f) => f.startsWith(prefix) && f.endsWith('.bak'))
		.map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
		.sort((a, b) => b.t - a.t)
		.slice(3);
	for (const o of olds) {
		try { unlinkSync(join(dir, o.f)); } catch { /* best effort */ }
	}
}

// `logger`: the host's root logger. migrate() runs BEFORE createCoreService
// injects it, so without this every migrate record (backups written, ISRC
// dedup merges) went to the console fallback and never reached the session
// JSONL — which left the 2026-09-23 dedup data loss untraceable.
export function migrate(dbPath: string, opts: { logger?: Logger } = {}): void {
	if (opts.logger) setCoreLogger(opts.logger);
	const sqlite = new Database(dbPath);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	sqlite.exec(DDL);
	for (const sql of ALTER_MIGRATIONS) {
		try {
			sqlite.exec(sql);
		} catch (err) {
			// Migrations are idempotent: each ALTER may already have been applied
			// on a previous run. SQLite surfaces three messages we treat as no-ops:
			//   - "duplicate column"  — ADD COLUMN re-run
			//   - "already exists"    — CREATE INDEX re-run (mostly redundant with IF NOT EXISTS)
			//   - "no such column"    — DROP COLUMN re-run (or DROP COLUMN of an already-removed column)
			const message = (err as Error).message ?? '';
			if (!/duplicate column|already exists|no such column/i.test(message)) {
				throw err;
			}
		}
	}
	sqlite.exec(SYSTEM_TAGS);
	// Sync identity: recording_id on every track, playlist_track rebuilt with
	// row ids and order keys. Before every content pass below so its backup
	// is the library as the previous version left it.
	migrateSyncSchema(sqlite, dbPath);
	indexClaimRecords(sqlite);
	// A library born empty is born complete: every row from here on is
	// recorded by the mutators, so no initial push is owed (apply.ts). Nor
	// the recordings backfill: the scanner and the streaming upserts record
	// each new row's create and claims (initial-push.ts CLAIMS_BACKFILL_KEY).
	if (recordsComplete(sqlite)) markRecordsComplete(sqlite);
	if (sqlite.prepare(`SELECT 1 FROM track LIMIT 1`).get() === undefined) {
		sqlite.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`)
			.run(CLAIMS_BACKFILL_KEY, JSON.stringify(Date.now()), Date.now());
	}
	// Collapse key storage to Camelot-only (backfill from key_musical, then
	// drop the column). Runs before dedupe so the INHERITABLE set no longer
	// references the dropped column.
	migrateKeyToCamelotOnly(sqlite);
	// ISRC columns to canonical form so the dedup below sees 'gbsmu1676261',
	// 'GB-SMU-16-76261' and 'GBSMU1676261' as one group. One-shot, gated,
	// backs up first.
	normalizeIsrcColumns(sqlite, dbPath);
	// Backfill duplicate tracks created before the ISRC-lookup landed in
	// SpotifySync.upsertTrack. Cheap when there's nothing to merge (single
	// GROUP BY HAVING). Idempotent — re-running finds no duplicates.
	dedupeTracksByIsrc(sqlite);
	// Fill release_date from source_link payloads for rows that don't have one
	// (runs after dedupe so it operates on survivor rows, not soon-deleted dupes).
	backfillReleaseDates(sqlite);
	// Populate *_ascii shadow columns for any track row missing them. First
	// migration after this lands will touch every row; subsequent boots are
	// O(rows-with-null) — typically zero once write-path asciify() is in.
	backfillAsciiColumns(sqlite);
	// Same shape, for playlist + playlist_folder.name_ascii.
	backfillPlaylistAscii(sqlite);
	// One-shot re-fold when searchFold's rules changed since the last boot.
	// Gated on PRAGMA user_version so it runs once per FOLD_VERSION, not every
	// launch. Must come AFTER the NULL-gated backfills so freshly-added rows
	// already have a (stale-rule) value to overwrite.
	const foldVersion = sqlite.pragma('user_version', { simple: true }) as number;
	if (foldVersion < FOLD_VERSION) {
		refoldAllAscii(sqlite);
		sqlite.pragma(`user_version = ${FOLD_VERSION}`);
	}
	// Artist entities: one-shot split of packed credits + table population,
	// then a cheap per-boot repair. After the re-fold so artists_ascii and
	// artist.name_ascii are derived under the same rules.
	backfillArtistTables(sqlite, dbPath);
	// Album entities: after the artist tables, since album artists are
	// artist rows and a track's main artist resolves through them.
	backfillAlbumTables(sqlite, dbPath);
	// Seed the membership baseline from current rb playlist_track so the
	// first sync after this feature ships is a no-op, not a mass re-add.
	backfillMembershipBaseline(sqlite);
	// pushed_at on rekordbox_deleted_content — must NOT live in
	// ALTER_MIGRATIONS: the grandfather backfill may only run in the same
	// breath as a SUCCESSFUL column add (a re-run would stamp fresh
	// tombstones that are legitimately awaiting their content_delete push).
	addDeletedContentPushedAt(sqlite);
	// Same shape for rekordbox_link.pushed_at — the backfill must ride the
	// successful column add, or a re-run would stamp fresh never-pushed links.
	addLinkPushedAt(sqlite);
	// Collapse play-history restatements a pre-fix rekordbox sync left in a
	// never-synced outbox. One-shot, gated, backs up first.
	dedupeOutboxRestatements(sqlite, dbPath);
	// Stamp existing analysis rows with the audio they describe, so the
	// catalogue can share them. One-shot, gated; touches only the new column.
	backfillAnalysisAudioHash(sqlite);
	sqlite.close();
}

// One-shot: add rekordbox_link.pushed_at ("last verified push") and treat
// every pre-existing link as already pushed (pushed_at = last_synced_at).
// Without the grandfather step the first "Sync updates" after upgrade would
// sweep the whole linked library through the writer. Only links minted from
// here on start null and are pushed on their first updates sync regardless
// of the updatedAt-vs-seen timestamp rule.
function addLinkPushedAt(sqlite: Database.Database): void {
	try {
		sqlite.exec(`ALTER TABLE rekordbox_link ADD COLUMN pushed_at INTEGER`);
	} catch (err) {
		const message = (err as Error).message ?? '';
		if (!/duplicate column/i.test(message)) throw err;
		return; // column already present — grandfathering already happened
	}
	sqlite.exec(`UPDATE rekordbox_link SET pushed_at = last_synced_at`);
}

// One-shot: add rekordbox_deleted_content.pushed_at and grandfather every
// pre-existing tombstone to pushed_at = deleted_at. Those rows predate
// collection-delete propagation — pushing months of accumulated deletes as
// rb collection removals on the first sync after upgrade would be a large
// un-previewed write. Only deletes from here on (and the missing-file
// cleanup flow, which mints fresh tombstones) propagate to rekordbox.
function addDeletedContentPushedAt(sqlite: Database.Database): void {
	try {
		sqlite.exec(`ALTER TABLE rekordbox_deleted_content ADD COLUMN pushed_at INTEGER`);
	} catch (err) {
		const message = (err as Error).message ?? '';
		if (!/duplicate column/i.test(message)) throw err;
		return; // column already present — grandfathering already happened
	}
	sqlite.exec(`UPDATE rekordbox_deleted_content SET pushed_at = deleted_at`);
}

// One-time seed of rekordbox_membership_baseline from the current rb
// playlist_track membership. Runs only while the table is empty (the first
// boot after the merge feature lands); once any sync advances a baseline the
// table is non-empty and this no-ops forever. Member identity mirrors the
// merge: a track with a rekordbox_link is keyed kind='rb' on its content id;
// a Curator-only member is keyed kind='curator' on its track id. The current
// state is treated as the agreed ancestor, so B == C on first export.
function backfillMembershipBaseline(sqlite: Database.Database): void {
	const already = sqlite
		.prepare(`SELECT 1 FROM rekordbox_membership_baseline LIMIT 1`)
		.get();
	if (already) return;
	// rb playlists only: playlist.id is `rb_<rbPlaylistId>`; strip the prefix
	// to the raw rb id the baseline is keyed on. Skip smart playlists (no
	// stored membership).
	const rows = sqlite
		.prepare(
			`SELECT pt.playlist_id AS playlistId, pt.track_id AS trackId, pt.position AS position,
			        rl.rb_content_id AS rbContentId
			   FROM playlist_track pt
			   JOIN playlist p ON p.id = pt.playlist_id
			   LEFT JOIN rekordbox_link rl ON rl.track_id = pt.track_id
			  WHERE p.source = 'rekordbox' AND p.is_smart = 0`,
		)
		.all() as Array<{ playlistId: string; trackId: string; position: number; rbContentId: string | null }>;
	if (rows.length === 0) return;
	const insert = sqlite.prepare(
		`INSERT OR IGNORE INTO rekordbox_membership_baseline
		   (rb_playlist_id, member_kind, member_id, position)
		 VALUES (?, ?, ?, ?)`,
	);
	const run = sqlite.transaction(() => {
		for (const r of rows) {
			const rbPlaylistId = r.playlistId.startsWith('rb_') ? r.playlistId.slice(3) : r.playlistId;
			if (r.rbContentId) insert.run(rbPlaylistId, 'rb', r.rbContentId, r.position);
			else insert.run(rbPlaylistId, 'curator', r.trackId, r.position);
		}
	});
	run();
	mlog.info('seeded rekordbox_membership_baseline', { playlistTrackRows: rows.length });
}

// CLI entry: `pnpm db:migrate`
import { fileURLToPath } from 'node:url';
const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (isMain) {
	const dbPath = process.env.CURATOR_DB_URL ?? './curator.db';
	mlog.info('migrating', { dbPath });
	migrate(dbPath);
	mlog.info('done');
}

