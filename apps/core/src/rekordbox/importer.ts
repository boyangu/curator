// Rekordbox importer — consumes the sidecar's event stream and lands each
// row in SQLite under the per-feature merge policy.
//
// Flow:
//   1. Call `runImport(opts)` from the service. It opens the sidecar, applies
//      watermarks (from rekordbox_sync_watermark, or zero for a full re-read),
//      starts a scan, and pipes events through the matchers + merge logic.
//   2. Per-event handlers update the canonical tables in SQLite transactions.
//   3. On final scan completion, persist new watermarks (or partial ones if
//      the scan was cancelled).
//   4. Emit AnalysisJobEvent-style events upstream so the UI sees progress.
//
// Merge policy — every preferable field is gated by a flag from RekordboxFlags.
//   • flag ON  → overwrite Curator's value unconditionally.
//   • flag OFF → never overwrite; only fill if Curator's value is null.
// Booleans/integers default to "is this currently null/zero" semantically.

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { DEFAULT_ARTIST_CREDIT_FORMAT, type ArtistCreditFormat } from '@curator/shared';
import type { TrackArtist } from '@curator/shared/schema';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import * as mut from '../library/mutators.js';
import {
	track,
	sourceLink,
	cue as cueTable,
	tag as tagTable,
	trackTag,
	playlist as playlistTable,
	playlistFolder as playlistFolderTable,
	playlistTrack,
	trackAnalysis,
	rekordboxLink,
	rekordboxSyncWatermark,
	syncConflict,
	rekordboxMembershipBaseline,
	rekordboxDeletedContent,
	playlistConflict,
	playSession,
	playEvent,
	type NewPlaylist,
	type NewPlaylistFolder,
	type NewCue,
	type NewTag,
	type NewRekordboxLink,
	type SegmentRecord,
	type TrackOverrides,
} from '@curator/shared/schema';
import { searchFold, type CueUnit, type FieldsSeen } from '@curator/shared';
import { keyToCamelot } from '../enrich/keys.js';
import type { Db } from '../db/client.js';
import { mergeCues, mergeTrackFields } from '@curator/library-logic';
import { curatorFieldsView } from '../sync/curator-view.js';
import { applyCueOpsToTrack, buildPullPatch } from '../sync/apply.js';
import { artistProtect, normalizeIncomingArtists, rawOf, syncTrackArtistsById } from '../library/artists.js';
import { syncTrackAlbumsById } from '../library/albums.js';
import { RekordboxSidecar, type SidecarError, type RekordboxScope } from './sidecar.js';
import { advanceRbBaselineAfterPull, eqArr, seqIn } from './order-util.js';
import { float32Buffer, rbIntroOutro, readRbSlot, writeRbSlot } from './rb-slot.js';
import { log } from '../log.js';

const ilog = log.for('rekordbox-import');

// ──────────────────────────────────────────────────────────────────────────────
// Scope flags — per-data-class toggles chosen by the user in
// Settings → Rekordbox. Each maps 1:1 onto a scope name passed to the
// Python sidecar's scan(). Field-level "prefer Rekordbox" toggles used to
// live here too, but conflict resolution is now last-modified-wins per
// track: rb's `djmdContent.updated_at` is compared against Curator's
// `track.updatedAt` using the rb_updated_at_seen baseline stored on
// rekordbox_link. See applyTrackDelta for the full decision matrix.
export interface RekordboxFlags {
	// Track metadata pass (DjmdContent → title/artist/album/BPM/key/comment/
	// rating/colorLabel/playCount/lastPlayedAt/addedAt). When off, new rb
	// tracks won't appear in Curator at all, and existing tracks' field
	// values stay untouched.
	syncTracks: boolean;
	// Playlists + folders pass (DjmdPlaylist + DjmdSongPlaylist + folder
	// hierarchy). When off, the sidebar's Rekordbox tree doesn't pick up
	// changes; existing playlists stay as-is.
	syncPlaylists: boolean;
	// MyTags pass (DjmdMyTag + DjmdSongMyTag). When off, rb's user tags
	// don't sync into Curator's tag table.
	syncMyTags: boolean;
	// Cues + beatgrid + downbeats + PSSI phrases. These share the same ANLZ
	// load, so they're bundled into a single user-facing checkbox. When
	// off, cues + grids + segments stay as whatever Curator has (which is
	// usually rb-sourced from a prior sync, or analyzer-sourced).
	syncCuesGridsPhrases: boolean;
	// Waveform peaks (rb_*.cpk files alongside the analyzer's per-track
	// .cpk). When off, no .cpk band writes happen during the waveform
	// pass — the existing .cpk files on disk stay current.
	syncWaveformPeaks: boolean;
	// Play history pass (DjmdHistory + DjmdSongHistory → play_session /
	// play_event). Read-only on the rekordbox side; automatically skipped on
	// targeted pulls (a subset read mustn't rewrite session state) and forced
	// off in the sync-to-rekordbox pull phase.
	syncHistory: boolean;
}

export const DEFAULT_REKORDBOX_FLAGS: RekordboxFlags = {
	syncTracks: true,
	syncPlaylists: true,
	syncMyTags: true,
	syncCuesGridsPhrases: true,
	syncWaveformPeaks: true,
	syncHistory: true,
};

export interface RunImportOptions {
	mode: 'incremental' | 'full';
	flags: RekordboxFlags;
	dbPath: string;
	key?: string;
	peaksDir: string;
	// When true, the importer bypasses LMW on every conflict (per-track
	// decision in applyTrackDelta + per-data-class writes in
	// applyWaveformDelta). The per-field null-preservation pattern
	// (`if (rb.val != null) patch[k] = rb.val`) still applies, so empty
	// values on the rb side never overwrite Curator's non-null values
	// (preserves cross-source enrichment like Beatport/MusicBrainz Genre
	// + Label). Used by the "Sync Everything" action in the UI. Also
	// causes the sidecar to bypass its .cpk-freshness check so peaks
	// get re-decoded even if the on-disk file looks current.
	overwriteCurator?: boolean;
	// Run the lightweight DjmdCue-only reader pass ('cues' scope) even when
	// syncCuesGridsPhrases is off. Used by the sync-to-rekordbox pipeline's
	// pull phase: it needs current rb cues for the three-way merge but has
	// no business decoding ANLZ beatgrids/phrases/waveforms.
	cuesLite?: boolean;
	// Scoped "Sync from Rekordbox" pull — restricts the scan to a specific
	// set of tracks / playlists / (folder-expanded) playlists rather than the
	// whole library. When present:
	//   • the reader is passed these ids and ignores the USN watermark for
	//     targeted rows (rbPlaylistIds expand to member content ids so the
	//     playlists' tracks pull too; folder targets also carry the folders'
	//     own DjmdPlaylist ids so a hard-deleted folder is reported missing
	//     and pruned — see prunePlaylistsMissingFromRekordbox);
	//   • watermarks are NEITHER loaded NOR persisted — a subset read must
	//     not advance the library-wide incremental cursor;
	//   • the post-scan cue merge is restricted to the targeted tracks so a
	//     scoped pull can never read "absent from buffer" as mass deletion on
	//     the untargeted rest of the library;
	//   • the playlist existence prune likewise judges only the targeted ids
	//     (the reader reports `missing_ids`, never a library-wide live set).
	// The per-row LMW merge is otherwise identical to a full incremental read.
	target?: { rbContentIds: string[]; rbPlaylistIds: string[] };
}

export interface ImportTotals {
	tracksConsidered: number;
	tracksMatched: number;
	tracksUpdated: number;
	cuesUpserted: number;
	playlistsUpserted: number;
	// Playlists/folders removed because rekordbox no longer has them — either
	// a tombstone delta (rb_local_deleted=1) or absence from the post-scan
	// existence index (rekordbox hard-deletes rows no sync peer has seen).
	// rekordbox is authoritative for rb-sourced rows.
	playlistsDeleted: number;
	// Existence-index removals withheld by the mass-prune breaker (more than
	// max(10, 25%) of Curator's rb rows missing at once). Non-zero means the
	// user has to run 'Sync Everything' (overwriteCurator) to apply them.
	playlistsPruneHeld: number;
	myTagsUpserted: number;
	// Tombstoned rb MyTags (rb_local_deleted=1) reconciled this run: merged
	// into a live same-name tag / pruned because Curator had no memberships.
	// Dead tags Curator still curates with are kept and revived on push.
	myTagsMerged: number;
	myTagsPruned: number;
	waveformsUpserted: number;
	beatgridsUpserted: number;
	// Number of tracks where rb-sourced phrases (PSSI) were written into
	// track_analysis.segments_json + the intro/outro length scalars.
	phrasesUpserted: number;
	// Both-sides-changed divergences persisted to sync_conflict during this
	// run. They are NOT applied in either direction until the user resolves
	// them (Sync to Rekordbox modal).
	conflictsDetected: number;
	// Play-history pass. The reader sends the whole history every run, so
	// *Seen counts what it read and *Upserted only what was new or changed
	// (written, and emitted as ops). An unchanged history upserts 0.
	historySessionsUpserted: number;
	historyPlaysUpserted: number;
	historySessionsSeen: number;
	historyPlaysSeen: number;
}

export type RekordboxImportEvent =
	| { kind: 'started';   mode: 'incremental' | 'full' }
	| { kind: 'progress';  phase: string; done: number; total: number }
	| { kind: 'completed'; totals: ImportTotals; cancelled: boolean }
	| { kind: 'failed';    errorKind: string; message: string };

// ──────────────────────────────────────────────────────────────────────────────
// Row shapes mirroring proto.py — duck-typed at the parse boundary, normalized
// inside the importer.

interface TrackDeltaRow {
	rb_content_id: string;
	rb_local_usn: number;
	rb_local_deleted: boolean;
	// epoch ms; null when Rekordbox didn't populate the column on its side.
	// Importer treats null as "rb hasn't changed since rbUpdatedAtSeen".
	rb_updated_at_ms: number | null;
	// Rekordbox's "Date Added" (DjmdContent.StockDate), epoch ms or null.
	// Written to track.addedAt — the user-visible "Added" column prefers
	// this over Curator's createdAt when present.
	rb_added_at_ms: number | null;
	file_path: string | null;
	title: string | null;
	artist: string | null;
	album: string | null;
	genre: string | null;
	label: string | null;
	bpm: number | null;
	key_camelot: string | null;
	key_musical: string | null;
	color_label: string | null;
	rating: number | null;
	comment: string | null;
	play_count: number | null;
	last_played_at_ms: number | null;
	duration_sec: number | null;
}

interface CueDeltaRow {
	rb_content_id: string;
	rb_local_usn: number;
	rb_local_deleted: boolean;
	slot: number;
	kind: 'hot' | 'memory';
	position_sec: number;
	length_sec: number | null;
	color: string | null;
	name: string | null;
}

interface PlaylistDeltaRow {
	rb_playlist_id: string;
	rb_local_usn: number;
	rb_local_deleted: boolean;
	parent_folder_id: string | null;
	name: string;
	is_folder: boolean;
	is_smart: boolean;
	position: number;
	tracks: Array<{ rb_content_id: string; position: number }>;
}

// Emitted once per COMPLETE playlists pass (never after a failed fetch or a
// cancel). Exactly one field is set: `live_ids` on a whole-library read,
// `missing_ids` (requested ids with no live row) on a targeted pull.
interface PlaylistIndexRow {
	live_ids: string[] | null;
	missing_ids: string[] | null;
}

interface MyTagDeltaRow {
	rb_tag_id: string;
	rb_local_usn: number;
	rb_local_deleted: boolean;
	name: string;
	color: string | null;
	tracks: string[];
}

interface WaveformDeltaRow {
	rb_content_id: string;
	// Peaks paths are null when band decode failed but beatgrid still
	// landed — the row still gets persisted so the transport's bar
	// markers work, just without a waveform.
	peaks_lo_path: string | null;
	peaks_hi_path: string | null;
	beatgrid_sec: number[];
	downbeats_sec: number[];
	// Rekordbox phrases decoded from the PSSI tag. Each entry follows the
	// SegmentRecord wire shape — see _extract_segments in reader.py and
	// SegmentRecord in packages/shared/src/schema.ts. Null when the file
	// has no PSSI tag (~8% of linked tracks).
	segments: SegmentRecord[] | null;
}

interface HistoryPlayRefRow {
	rb_song_history_id: string;
	rb_content_id: string;
	track_no: number;
	created_at_ms: number | null;
}

// One djmdHistory session (Attribute=0) with its plays embedded — the
// classifier needs the whole session's timestamp spread in one look.
interface HistoryDeltaRow {
	rb_history_id: string;
	name: string;
	date_created_ms: number | null;
	plays: HistoryPlayRefRow[];
}

// The history pass's per-play statements, prepared once per handle.
type HistoryStmts = { prior: Database.Statement; insert: Database.Statement; update: Database.Statement };
const HISTORY_STMTS = new WeakMap<Database.Database, HistoryStmts>();
function historyStmts(raw: Database.Database): HistoryStmts {
	let st = HISTORY_STMTS.get(raw);
	if (!st) {
		st = {
			// json_each keeps it one statement whatever the session's size.
			prior: raw.prepare(`SELECT id, session_id, track_id, played_at, track_no, rb_song_history_id FROM play_event
				WHERE rb_song_history_id IN (SELECT value FROM json_each(?))`),
			insert: raw.prepare(`INSERT INTO play_event (id, session_id, track_id, rb_content_id, source, played_at, track_no, rb_song_history_id)
				VALUES (?, ?, ?, ?, 'rekordbox', ?, ?, ?)`),
			update: raw.prepare(`UPDATE play_event SET session_id = ?, played_at = ?, track_no = ?, track_id = COALESCE(?, track_id) WHERE id = ?`),
		};
		HISTORY_STMTS.set(raw, st);
	}
	return st;
}

// A track column against a pull-patch value: timestamps by instant, json
// columns by their serialisation, null and undefined alike. Only used to
// skip writes, so a false "different" costs a redundant write, never data.
function sameColumnValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return a == null && b == null;
	if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
	if (typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
	return false;
}

// Last-modified-wins decision for a single track.
//
// rbTs      = Rekordbox's djmdContent.updated_at for this delta row (null if
//             the sidecar couldn't read it; treated as "rb hasn't changed
//             since the baseline" so Curator keeps any edits).
// curatorTs = track.updatedAt — when Curator-side code last touched the row.
//             Set only by user-driven edits (setTrackOverrides + the track-
//             edit modal) and a handful of sync paths; importantly, the
//             rekordbox importer does NOT bump it (would defeat the LMW rule
//             by always making Curator look "newer" after each import).
// seen      = rekordbox_link.rb_updated_at_seen — the rbTs we recorded the
//             last time we synced this track. Null on first-ever import for
//             this rb_content_id, in which case we defer to Rekordbox so the
//             initial pull seeds Curator.
//
// Decision:
//   1. First import (no seen): Rekordbox wins.
//   2. No rbTs at all: Rekordbox hasn't changed; Curator keeps its row.
//   3. Both changed since `seen`: higher wall-clock wins.
//   4. Only Rekordbox changed: Rekordbox wins.
//   5. Only Curator changed (or neither): Curator keeps its row.
export function decideRbWins(rbTs: Date | null, curatorTs: Date, seen: Date | null): boolean {
	if (!seen) return true;             // first import
	if (!rbTs) return false;            // rb didn't report a timestamp
	const rbMs = rbTs.getTime();
	const curMs = curatorTs.getTime();
	const seenMs = seen.getTime();
	const rbChanged = rbMs > seenMs;
	const curChanged = curMs > seenMs;
	if (rbChanged && curChanged) return rbMs > curMs;
	return rbChanged;
}

// ──────────────────────────────────────────────────────────────────────────────
// Importer — owns the sidecar event-stream subscription for the duration of
// one runImport() call. Re-entry while another import is in-flight throws.

export class RekordboxImporter extends EventEmitter {
	private running = false;
	// curator trackIds where the per-track LMW decision picked Rekordbox in
	// this run. Subsequent passes (cues, mytags, beatgrid) check membership
	// to decide whether to overwrite Curator's data for that track. Reset
	// per runImport() call.
	private rbWinsTracks = new Set<string>();

	constructor(
		private readonly db: Db,
		private readonly sidecar: RekordboxSidecar,
		// Same credit format the exporter pushes with — the three-way merge
		// compares rb's strings against Curator's FORMATTED view, or every
		// remix title would read as a Curator-side edit on each pull.
		private readonly creditFormat: () => ArtistCreditFormat = () => DEFAULT_ARTIST_CREDIT_FORMAT,
	) { super(); }

	isRunning(): boolean { return this.running; }

	async runImport(opts: RunImportOptions): Promise<ImportTotals> {
		if (this.running) throw new Error('rekordbox import already in flight');
		this.running = true;
		const totals: ImportTotals = {
			tracksConsidered: 0,
			tracksMatched: 0,
			tracksUpdated: 0,
			cuesUpserted: 0,
			playlistsUpserted: 0,
			playlistsDeleted: 0,
			playlistsPruneHeld: 0,
			myTagsUpserted: 0,
			myTagsMerged: 0,
			myTagsPruned: 0,
			waveformsUpserted: 0,
			beatgridsUpserted: 0,
			phrasesUpserted: 0,
			conflictsDetected: 0,
			historySessionsUpserted: 0,
			historyPlaysUpserted: 0,
			historySessionsSeen: 0,
			historyPlaysSeen: 0,
		};

		// rb_content_id → curator trackId. Populated by the track pass so
		// later passes (cues, mytags) can resolve without re-querying.
		const trackIdByRbId = new Map<string, string>();
		// rb_playlist_id → curator playlist row id (or folder id). Same idea.
		const playlistIdByRbId = new Map<string, string>();

		const emitEvent = (e: RekordboxImportEvent): void => { this.emit('event', e); };
		emitEvent({ kind: 'started', mode: opts.mode });

		// Waveform writes are the hot path on big libraries — buffer them and
		// flush every WAVEFORM_BATCH_SIZE inside a single transaction so the
		// commit/fsync cost amortizes across many rows. Other delta types
		// (track/cue/playlist/mytag) are cheaper individually so we leave
		// them as per-event writes to keep the importer simple.
		const WAVEFORM_BATCH_SIZE = 100;
		const waveformBatch: WaveformDeltaRow[] = [];
		// rb_content_id → this run's full DjmdCue set for that content row.
		// Consumed by processCueMerges() after the scan completes.
		const cueBuffer = new Map<string, CueDeltaRow[]>();
		// Tombstoned MyTags — the reader emits them every pass; reconciled after
		// the stream so every live tag of this run is known (see reconcileDeadMyTags).
		const deadMyTags: MyTagDeltaRow[] = [];
		// Existence index from the playlists pass — applied post-scan (see
		// prunePlaylistsMissingFromRekordbox); null when the pass didn't
		// complete, which must leave Curator's rows alone.
		let playlistIndex: PlaylistIndexRow | null = null;
		// `overwrite` is the closure-captured "Sync Everything" flag. The
		// per-delta handlers below all use it to bypass their LMW gates when
		// the user explicitly asked to overwrite Curator's edits.
		const overwrite = opts.overwriteCurator ?? false;

		// History sessions are batched the same way. The reader sends the
		// whole history every run; a session that changed is a write, and one
		// commit per session (1,200 on the live library, each an fsync under
		// WAL's default synchronous=FULL) was most of a fresh import's cost.
		// Each session still runs in its own savepoint, so one bad session
		// rolls back alone and is logged, as when they committed one by one.
		const HISTORY_BATCH_SIZE = 50;
		const historyBatch: HistoryDeltaRow[] = [];
		const flushHistory = (): void => {
			if (historyBatch.length === 0) return;
			const batch = historyBatch.splice(0, historyBatch.length);
			this.db.transaction(() => {
				for (const r of batch) {
					try {
						this.applyHistoryDelta(r, trackIdByRbId, totals);
					} catch (err) {
						ilog.error('event handler threw', err, { event: 'history' });
					}
				}
			});
		};

		const flushWaveforms = (): void => {
			if (waveformBatch.length === 0) return;
			const batch = waveformBatch.splice(0, waveformBatch.length);
			// The grid and phrase units another device needs: one snapshot +
			// diff per batch (an unchanged re-emitted grid compares equal byte
			// for byte and emits nothing), inside the batch's transaction.
			// Each row names the units applyWaveformDelta writes for it, which
			// is what the per-device rekordbox baseline is kept for.
			const written = new Map<string, Array<'grid' | 'segments'>>();
			for (const r of batch) {
				const id = this.resolveTrackId(r.rb_content_id, trackIdByRbId);
				if (!id) continue;
				const units = written.get(id) ?? [];
				if (Array.isArray(r.beatgrid_sec) && r.beatgrid_sec.length > 0) units.push('grid');
				if (r.segments != null && r.segments.length > 0) units.push('segments');
				written.set(id, units);
			}
			this.db.transaction((tx) => {
				mut.recordRbAnalysisChanges(this.db, written, () => {
					for (const r of batch) {
						this.applyWaveformDelta(r, opts.flags, trackIdByRbId, totals, tx, overwrite);
					}
				});
			});
		};

		const onSidecarEvent = ({ event, frame }: { event: string; frame: Record<string, unknown> }): void => {
			try {
				if (event === 'progress') {
					emitEvent({
						kind: 'progress',
						phase: String(frame['phase']),
						done: Number(frame['done'] ?? 0),
						total: Number(frame['total'] ?? 0),
					});
					return;
				}
				const row = frame['row'] as Record<string, unknown> | undefined;
				if (!row) return;
				if (event === 'track') {
					this.applyTrackDelta(row as unknown as TrackDeltaRow, opts.flags, trackIdByRbId, totals, overwrite);
				} else if (event === 'cues') {
					// Buffered, not applied per-row: the cue pass is a FULL
					// scan (reader.py — DjmdCue has no usable USN), so the
					// complete per-track set is only known once the scan ends.
					// processCueMerges() then does a per-track three-way merge
					// against the cuesSeen baseline.
					const cueRow = row as unknown as CueDeltaRow;
					const list = cueBuffer.get(cueRow.rb_content_id);
					if (list) list.push(cueRow);
					else cueBuffer.set(cueRow.rb_content_id, [cueRow]);
				} else if (event === 'playlist') {
					this.applyPlaylistDelta(row as unknown as PlaylistDeltaRow, trackIdByRbId, playlistIdByRbId, totals);
				} else if (event === 'playlist_index') {
					playlistIndex = row as unknown as PlaylistIndexRow;
				} else if (event === 'mytag') {
					const mt = row as unknown as MyTagDeltaRow;
					if (mt.rb_local_deleted) deadMyTags.push(mt);
					else this.applyMyTagDelta(mt, opts.flags, trackIdByRbId, totals);
				} else if (event === 'waveform') {
					waveformBatch.push(row as unknown as WaveformDeltaRow);
					if (waveformBatch.length >= WAVEFORM_BATCH_SIZE) flushWaveforms();
				} else if (event === 'history') {
					historyBatch.push(row as unknown as HistoryDeltaRow);
					if (historyBatch.length >= HISTORY_BATCH_SIZE) flushHistory();
				}
			} catch (err) {
				ilog.error('event handler threw', err, { event });
			}
		};

		// Fresh decision set for this run.
		this.rbWinsTracks.clear();

		this.sidecar.on('event', onSidecarEvent);
		try {
			await this.sidecar.open({ dbPath: opts.dbPath, key: opts.key });
			// Scoped pulls read the targeted rows at their CURRENT rb state:
			// empty watermarks (the reader bypasses the USN gate on targeted
			// rows anyway) and no persistence (a subset read mustn't move the
			// library-wide cursor).
			const scoped = !!opts.target;
			const watermarks = scoped || opts.mode === 'full' ? {} : this.loadWatermarks();
			const scopes: RekordboxScope[] = [];
			if (opts.flags.syncTracks) scopes.push('tracks');
			if (opts.flags.syncPlaylists) scopes.push('playlists');
			if (opts.flags.syncMyTags) scopes.push('mytags');
			if (opts.flags.syncCuesGridsPhrases) scopes.push('cues_grids_phrases');
			else if (opts.cuesLite) scopes.push('cues');
			if (opts.flags.syncWaveformPeaks) scopes.push('waveform_peaks');
			// History reads its own tables (djmdHistory), independent of the
			// content-id targeting that scopes the other passes — so it runs
			// whenever requested, including on scoped sync-from / sync-to pulls.
			// Full-scan + upsert-by-id makes it idempotent regardless of scope.
			if (opts.flags.syncHistory) scopes.push('history');
			const cueScopeRan = opts.flags.syncCuesGridsPhrases || (opts.cuesLite ?? false);
			const result = await this.sidecar.scan({
				watermarks,
				scopes,
				peaksDir: opts.peaksDir,
				// The Python sidecar's field is still named force_refresh_grids
				// for now; semantically it now means "bypass cpk-freshness".
				// Renamed on the TS side to overwriteCurator since that's the
				// broader user-facing intent (which the importer also honors
				// at the per-track LMW gate below).
				forceRefreshGrids: opts.overwriteCurator,
				targetContentIds: opts.target?.rbContentIds,
				targetPlaylistIds: opts.target?.rbPlaylistIds,
			});
			// Drain the waveform buffer — anything still pending when the scan
			// finished (tail of the last batch) gets one final transaction.
			flushWaveforms();
			flushHistory();
			if (deadMyTags.length > 0) this.reconcileDeadMyTags(deadMyTags, totals);
			// Playlist/folder existence reconcile. The reader only emits the
			// index after a complete playlists pass, and a cancelled scan may
			// have cut the stream before it; both gates must hold.
			if (playlistIndex && !result.cancelled && opts.flags.syncPlaylists) {
				this.prunePlaylistsMissingFromRekordbox(playlistIndex, overwrite, totals);
			}
			// Cue merge runs strictly post-scan: the cue pass is a full scan,
			// so only a COMPLETED scan licenses "absent from buffer = rb has
			// zero cues for this track". On cancel we apply nothing — a
			// partial buffer would read as mass deletion.
			if (cueScopeRan && !result.cancelled) {
				emitEvent({ kind: 'progress', phase: 'cue-merge', done: 0, total: 1 });
				// Scoped pull: restrict the merge to the targeted tracks. The
				// buffer only holds targeted rows (the reader filtered), but the
				// merge otherwise walks EVERY rekordbox_link and would read a
				// non-targeted track's empty buffer entry as "rb deleted all its
				// cues" — mass deletion. Union the emitted buffer keys with the
				// explicitly-requested content ids so a targeted track with zero
				// rb cues is still processed while the untargeted rest is left
				// untouched.
				const cueScope = scoped
					? new Set<string>([...cueBuffer.keys(), ...(opts.target?.rbContentIds ?? [])])
					: undefined;
				this.processCueMerges(cueBuffer, totals, overwrite, cueScope);
				emitEvent({ kind: 'progress', phase: 'cue-merge', done: 1, total: 1 });
			}
			// Heal play events that landed before their track existed (or before
			// its rekordbox_link did) — cheap indexed UPDATE, so run it whenever
			// the history scope was part of this scan.
			if (scopes.includes('history') && !result.cancelled) {
				this.healUnlinkedPlayEvents();
			}
			// Subset reads must not advance the library-wide incremental cursor.
			if (!scoped) this.saveWatermarks(result.watermarks);
			ilog.info('completed', { totals });
			emitEvent({ kind: 'completed', totals, cancelled: result.cancelled });
			return totals;
		} catch (err) {
			// Flush whatever we have so a mid-scan crash doesn't lose the
			// batched-but-not-yet-committed waveforms. If the flush itself
			// throws, swallow it — the outer throw below is what the caller
			// wants to see.
			try { flushWaveforms(); } catch { /* */ }
			try { flushHistory(); } catch { /* */ }
			const e = err as SidecarError;
			const kind = e.kind ?? 'internal';
			const message = e.message ?? String(err);
			emitEvent({ kind: 'failed', errorKind: kind, message });
			throw err;
		} finally {
			this.sidecar.off('event', onSidecarEvent);
			this.running = false;
		}
	}

	cancel(): void {
		if (!this.running) return;
		this.sidecar.cancel().catch((err) => ilog.error('cancel failed', err));
	}

	// ──────────────────────────────────────────────────────────────────────
	// Track pass — resolve match via source_link.filePath, then merge.

	private applyTrackDelta(
		row: TrackDeltaRow,
		_flags: RekordboxFlags,
		idMap: Map<string, string>,
		totals: ImportTotals,
		overwriteCurator: boolean = false,
	): void {
		totals.tracksConsidered++;
		if (row.rb_local_deleted) {
			// On delete we keep the curator track + just drop the provenance
			// link so a future re-add reconciles cleanly. Cues/tags written
			// from this row are intentionally left in place — destroying
			// user-visible data on a Rekordbox-side delete would be rude.
			//
			// Lifecycle consequence (intentional, but non-obvious): if the
			// user later re-adds the same file in Rekordbox, the path match
			// below re-links it to this SAME curator track — which still
			// carries cues/tags/rating from the previous rb lifecycle. The
			// fresh link has rbUpdatedAtSeen = null, so the first import
			// treats rb as the winner for track fields, while curator-origin
			// cues survive (origin-scoped wipe). Net effect: delete+re-add
			// in rb is not a "factory reset" of the curator side.
			const deadLink = this.db
				.select({ trackId: rekordboxLink.trackId })
				.from(rekordboxLink)
				.where(eq(rekordboxLink.rbContentId, row.rb_content_id))
				.get();
			if (deadLink) {
				// Open conflicts referenced an rb row that no longer exists —
				// there's nothing left to resolve against.
				this.db.delete(syncConflict)
					.where(and(eq(syncConflict.provider, 'rekordbox'), eq(syncConflict.trackId, deadLink.trackId)))
					.run();
			}
			this.db.delete(rekordboxLink).where(eq(rekordboxLink.rbContentId, row.rb_content_id)).run();
			return;
		}
		if (!row.file_path) return;

		// Match: source_link with source='local' + filePath equal. The
		// scanner has already normalized our side; the sidecar normalized
		// theirs. String equality is the contract.
		//
		// Deliberately NOT gated on missing_at. rekordbox still holds the old
		// path of a file the watcher saw vanish, and binding its content to
		// the same track is exactly the identity (cues, tags, rb slot) the
		// pending re-bind is preserving — nothing is read from disk here.
		// Once the file re-binds at its new path and the user relocates it in
		// rekordbox, the next import matches the re-pointed link.
		const link = this.db
			.select({ trackId: sourceLink.trackId })
			.from(sourceLink)
			.where(and(eq(sourceLink.source, 'local'), eq(sourceLink.filePath, row.file_path)))
			.get();
		if (!link) {
			// Sample the first few mismatches to help diagnose path-mismatch
			// problems (e.g. case sensitivity, trailing slashes). Capped to
			// avoid log spam on libraries with many unmatched tracks.
			const unmatched = totals.tracksConsidered - totals.tracksMatched;
			if (unmatched <= 3) {
				ilog.debug('no match for rekordbox path', { filePath: row.file_path });
			}
			return;
		}

		totals.tracksMatched++;
		idMap.set(row.rb_content_id, link.trackId);
		// Periodic progress for very large libraries — every 500 considered.
		if (totals.tracksConsidered % 500 === 0) {
			ilog.debug('tracks progress', { considered: totals.tracksConsidered, matched: totals.tracksMatched });
		}

		const existing = this.db.select().from(track).where(eq(track.id, link.trackId)).get();
		if (!existing) return;

		// Existing rekordbox_link tells us the baseline timestamps. First
		// import for this rb_content_id → linkRow is undefined; we treat
		// that as "rb wins by default" so the initial pull seeds Curator.
		const existingLink = this.db
			.select()
			.from(rekordboxLink)
			.where(eq(rekordboxLink.rbContentId, row.rb_content_id))
			.get();

		const rbTs = row.rb_updated_at_ms != null ? new Date(row.rb_updated_at_ms) : null;
		// "Sync Everything" forces rbWins to true regardless of timestamps —
		// the user has explicitly asked to overwrite Curator's edits. The
		// per-field null-preservation pattern below still keeps Curator's
		// values for fields where rb has null/empty (genre/label from
		// Beatport/MusicBrainz, for example).
		const rbWins = overwriteCurator || decideRbWins(rbTs, existing.updatedAt, existingLink?.rbUpdatedAtSeen ?? null);

		if (rbWins) this.rbWinsTracks.add(link.trackId);

		// None of the patches below bump track.updatedAt — that field tracks
		// the last Curator-side change, and an import that bumps it would
		// make Curator look "newer" after every pull, defeating both the
		// legacy LMW comparison and the push-side changed-track detection.
		const patch: Record<string, unknown> = {};

		// rb-authoritative one-way fields: always pull when rb has a value.
		// These never conflict — Curator has no canonical edit surface for
		// them (bpm/key overrides shadow in the UI but are never pushed).
		if (row.bpm != null) patch['bpm'] = row.bpm;
		// Key is stored canonically as Camelot only. Prefer rb's Camelot; if rb
		// only carried a musical spelling, convert at this boundary (rb's two
		// key fields can disagree — Camelot is the one we trust/keep).
		const rbCamelot = row.key_camelot ?? keyToCamelot(row.key_musical);
		if (rbCamelot != null) patch['keyCamelot'] = rbCamelot;
		if (row.play_count != null) patch['playCount'] = row.play_count;
		if (row.last_played_at_ms != null) patch['lastPlayedAt'] = new Date(row.last_played_at_ms);

		// The bidirectional surface, as rb's current values. Keys must stay
		// aligned with curatorFieldsView() and the exporter's push fields.
		const rbFields: FieldsSeen = {
			title: row.title,
			artist: row.artist,
			album: row.album,
			genre: row.genre,
			label: row.label,
			rating: row.rating,
			comment: row.comment,
			colorLabel: row.color_label,
		};
		const baseline = existingLink?.fieldsSeen ?? null;
		let nextFieldsSeen: FieldsSeen;
		const protect = artistProtect(this.db);

		if (overwriteCurator) {
			// "Sync Everything" — rb wins the whole surface, but keep the
			// per-field null-preservation: empty rb values never erase
			// Curator's non-null data (Beatport/MusicBrainz genre + label).
			Object.assign(patch, buildPullPatch(rbFields, existing.overrides, { nullPreserve: true, clearOverrides: true, protect }));
			this.db.delete(syncConflict)
				.where(and(eq(syncConflict.provider, 'rekordbox'), eq(syncConflict.trackId, link.trackId)))
				.run();
			nextFieldsSeen = rbFields;
		} else if (baseline != null) {
			// Three-way merge per field. `ours` is the EFFECTIVE view
			// (override ?? canonical) — the same values the exporter pushes.
			const merge = mergeTrackFields(baseline, rbFields, curatorFieldsView(existing, this.creditFormat()));
			Object.assign(patch, buildPullPatch(merge.pull, existing.overrides, { nullPreserve: false, clearOverrides: true, protect }));

			// Conflicts: full recompute per delta → replace this track's
			// open field conflicts wholesale. Tracks without a delta this
			// run keep their previously persisted rows (USN gate means rb
			// didn't change them, so those conflicts still stand).
			this.db.delete(syncConflict)
				.where(and(
					eq(syncConflict.provider, 'rekordbox'),
					eq(syncConflict.trackId, link.trackId),
					eq(syncConflict.kind, 'field'),
				))
				.run();
			for (const c of merge.conflicts) {
				this.db.insert(syncConflict).values({
					id: randomUUID(),
					provider: 'rekordbox',
					trackId: link.trackId,
					kind: 'field',
					fieldKey: c.field,
					baseJson: c.base,
					theirsJson: c.theirs,
					detectedAt: new Date(),
				}).run();
				totals.conflictsDetected++;
			}

			// Fields rb reported but the (partial) snapshot has no baseline
			// for: legacy whole-row LMW bias, then seed. rbWins pulls rb's
			// non-null value; otherwise Curator keeps its value and the
			// push phase writes it out.
			const seeded: FieldsSeen = {};
			if (merge.unseeded.length > 0 && rbWins) {
				const unseededPull: FieldsSeen = {};
				for (const f of merge.unseeded) unseededPull[f] = rbFields[f];
				Object.assign(patch, buildPullPatch(unseededPull, existing.overrides, { nullPreserve: true, clearOverrides: false, protect }));
			}
			for (const f of merge.unseeded) seeded[f] = rbFields[f];
			nextFieldsSeen = { ...baseline, ...merge.seenAdvance, ...seeded };
		} else {
			// Bootstrap — no snapshot yet. Legacy whole-row LMW, widened to
			// the full bidirectional surface, then seed the snapshot so the
			// NEXT pull merges per field. Overrides are left in place (they
			// shadow canonical values; the first merged push writes them to
			// rb and the baselines converge from there).
			if (rbWins) {
				Object.assign(patch, buildPullPatch(rbFields, existing.overrides, { nullPreserve: true, clearOverrides: false, protect }));
			}
			nextFieldsSeen = rbFields;
		}

		// addedAt is not user-edited and isn't part of the conflict
		// surface — always write Rekordbox's "Date Added" when present so
		// the UI reflects the user's actual library history rather than the
		// Curator scan timestamp. We only write when null (first import) OR
		// when the rb value is older than what we have (some prior import
		// may have set createdAt-as-fallback; rb's earlier date is truer).
		if (row.rb_added_at_ms != null) {
			const rbAdded = new Date(row.rb_added_at_ms);
			if (existing.addedAt == null || rbAdded.getTime() < existing.addedAt.getTime()) {
				patch['addedAt'] = rbAdded;
			}
		}

		// A pulled artist string is split by buildPullPatch; the title's
		// remixer is read here where the row (and any pulled title) is known.
		if (Array.isArray(patch['artists'])) {
			const title = typeof patch['title'] === 'string' ? patch['title'] : (existing.overrides?.title ?? existing.title);
			patch['artists'] = normalizeIncomingArtists(this.db, patch['artists'] as TrackArtist[], { title });
		}
		// The rb-authoritative fields above are restated on every delta (and a
		// full read sends every row), so drop what the row already holds: an
		// unchanged track costs no write, no artist/album re-derive and is not
		// counted in tracksUpdated. A value that only compares unequal by
		// representation is written as before.
		const current = existing as unknown as Record<string, unknown>;
		for (const k of Object.keys(patch)) if (sameColumnValue(current[k], patch[k])) delete patch[k];

		if (Object.keys(patch).length > 0) {
			// A pulled rating or a cleared override is library state: the diff
			// seam emits one op per synced field the patch changed (canonical
			// fields — bpm, key, title, … — are catalogue data and do not).
			mut.recordTrackStateChanges(this.db, [link.trackId], () => {
				this.db.update(track).set(patch).where(eq(track.id, link.trackId)).run();
				if ('artists' in patch || 'overrides' in patch) syncTrackArtistsById(this.db, [link.trackId]);
				if ('albumTitle' in patch || 'artists' in patch || 'overrides' in patch) syncTrackAlbumsById(this.db, [link.trackId]);
			});
			totals.tracksUpdated++;
		}

		// rb's key also lands in the rekordbox slot (rb_key_camelot), where
		// it is rekordbox's own value whatever track.key_camelot later holds
		// (tags, enrichment), and from where it syncs as the 'key' unit. Only
		// a change is a write: a re-import of the same key costs two reads. A
		// key equal to the slot but not yet in this device's rekordbox
		// baseline still goes through, once, so the baseline knows it — else
		// another desktop's key landing in the slot later would read as
		// rekordbox changing it here (mutators.ts recordRbAnalysisChanges).
		if (rbCamelot != null) {
			const raw = rawOf(this.db);
			if (readRbSlot(raw, link.trackId)?.rb_key_camelot !== rbCamelot || mut.rbUnitSeen(raw, link.trackId, 'key') !== rbCamelot) {
				mut.recordRbAnalysisChanges(this.db, new Map([[link.trackId, ['key'] as const]]), (raw) => writeRbSlot(raw, link.trackId, { keyCamelot: rbCamelot }));
			}
		}

		// Provenance — always upsert. rbUpdatedAtSeen + fieldsSeen advance to
		// what rb reported so the next import has the correct baseline
		// regardless of who won (conflicted fields excepted — their baseline
		// entries were held back by the merge above).
		const linkRow: NewRekordboxLink = {
			trackId: link.trackId,
			rbContentId: row.rb_content_id,
			rbLocalUsn: row.rb_local_usn,
			rbFilePath: row.file_path,
			importedAt: new Date(),
			lastSyncedAt: new Date(),
			rbUpdatedAtSeen: rbTs,
			fieldsSeen: nextFieldsSeen,
			cuesSeen: existingLink?.cuesSeen ?? null,
		};
		// rb_content_id is globally unique (a rb track maps to exactly one
		// Curator track). If it's currently linked to a DIFFERENT track — the
		// file was merged onto another track by the ISRC de-dupe, or otherwise
		// re-matched — drop that stale link first. The upsert below is keyed on
		// trackId, so without this it would trip the separate rb_content_id
		// unique index (SQLITE_CONSTRAINT_UNIQUE) instead of re-homing the link.
		this.db.delete(rekordboxLink)
			.where(and(eq(rekordboxLink.rbContentId, row.rb_content_id), ne(rekordboxLink.trackId, link.trackId)))
			.run();
		this.db.insert(rekordboxLink)
			.values(linkRow)
			.onConflictDoUpdate({
				target: rekordboxLink.trackId,
				set: {
					rbContentId: row.rb_content_id,
					rbLocalUsn: row.rb_local_usn,
					rbFilePath: row.file_path,
					importedAt: new Date(),
					lastSyncedAt: new Date(),
					rbUpdatedAtSeen: rbTs,
					fieldsSeen: nextFieldsSeen,
				},
			})
			.run();
	}

	// buildPullPatch lives in ../sync/apply.ts — shared with the conflict-
	// resolution path so "apply an rb value to Curator" has exactly one
	// implementation (override clearing, ascii mirrors, no updatedAt bump).

	// ──────────────────────────────────────────────────────────────────────
	// Cue pass — per-track three-way set merge, run once after the scan
	// completes (the reader's cue pass is a full scan, so a track absent
	// from the buffer verifiably has zero cues on the rb side).
	//
	// Identity is cueUnitKey(): hot cues by slot (the pad letter IS the
	// identity), memory cues by position — rb's memory slots are
	// ordinals-by-time, so an earlier insert renumbers every later cue and
	// slot-keyed identity would explode into spurious conflicts.
	//
	// Bootstrap (cuesSeen == null) keeps the legacy semantics per track:
	// wipe rekordbox-origin rows, land rb's set, curator-origin rows
	// survive unless the track won LMW. Once a snapshot exists, origin no
	// longer drives decisions — the merge engine does.

	private processCueMerges(
		buffer: Map<string, CueDeltaRow[]>,
		totals: ImportTotals,
		overwriteCurator: boolean,
		// Scoped pulls pass the targeted rb_content_id set. When present, the
		// merge walks ONLY those links — never treating a non-targeted track's
		// absent buffer entry as an rb-side cue deletion.
		onlyRbContentIds?: Set<string>,
	): void {
		const links = (onlyRbContentIds
			? this.db
				.select({
					trackId: rekordboxLink.trackId,
					rbContentId: rekordboxLink.rbContentId,
					cuesSeen: rekordboxLink.cuesSeen,
				})
				.from(rekordboxLink)
				.where(inArray(rekordboxLink.rbContentId, Array.from(onlyRbContentIds)))
			: this.db
				.select({
					trackId: rekordboxLink.trackId,
					rbContentId: rekordboxLink.rbContentId,
					cuesSeen: rekordboxLink.cuesSeen,
				})
				.from(rekordboxLink))
			.all();
		if (links.length === 0) return;

		// One query for every candidate track's cue rows — not N per-track
		// selects. Full runs use a subquery (clear of SQLite's bind-variable
		// cap); scoped runs pass the handful of targeted track ids directly.
		const allCueRows = onlyRbContentIds
			? this.db
				.select()
				.from(cueTable)
				.where(inArray(cueTable.trackId, links.map((l) => l.trackId)))
				.all()
			: this.db
				.select()
				.from(cueTable)
				.where(inArray(cueTable.trackId, this.db.select({ trackId: rekordboxLink.trackId }).from(rekordboxLink)))
				.all();
		const cueRowsByTrack = new Map<string, typeof allCueRows>();
		for (const r of allCueRows) {
			const list = cueRowsByTrack.get(r.trackId);
			if (list) list.push(r);
			else cueRowsByTrack.set(r.trackId, [r]);
		}

		const toUnit = (r: CueDeltaRow): CueUnit => ({
			kind: r.kind,
			slot: r.slot,
			positionSec: r.position_sec,
			lengthSec: r.length_sec ?? null,
			color: r.color ?? null,
			name: r.name ?? null,
		});

		this.db.transaction(() => {
			for (const link of links) {
				const rbUnits = (buffer.get(link.rbContentId) ?? [])
					.filter((r) => !r.rb_local_deleted && r.slot >= 0)
					.map(toUnit);
				const oursRows = cueRowsByTrack.get(link.trackId) ?? [];

				if (overwriteCurator || link.cuesSeen == null) {
					// Cue ops (whole-cue upsert/delete) for what the bootstrap changed.
					mut.recordCueChanges(this.db, [link.trackId], () => this.bootstrapTrackCues(link.trackId, rbUnits, oursRows, overwriteCurator, totals));
					if (overwriteCurator) {
						this.db.delete(syncConflict)
							.where(and(
								eq(syncConflict.provider, 'rekordbox'),
								eq(syncConflict.trackId, link.trackId),
								eq(syncConflict.kind, 'cue'),
							))
							.run();
					}
					this.db.update(rekordboxLink)
						.set({ cuesSeen: rbUnits })
						.where(eq(rekordboxLink.trackId, link.trackId))
						.run();
					continue;
				}

				const oursUnits: CueUnit[] = oursRows.map((r) => ({
					kind: r.kind,
					slot: r.slot,
					positionSec: r.positionSec,
					lengthSec: r.lengthSec ?? null,
					color: r.color ?? null,
					name: r.name ?? null,
				}));
				const merge = mergeCues(link.cuesSeen, rbUnits, oursUnits);

				// Full recompute → replace this track's open cue conflicts.
				this.db.delete(syncConflict)
					.where(and(
						eq(syncConflict.provider, 'rekordbox'),
						eq(syncConflict.trackId, link.trackId),
						eq(syncConflict.kind, 'cue'),
					))
					.run();
				for (const c of merge.conflicts) {
					this.db.insert(syncConflict).values({
						id: randomUUID(),
						provider: 'rekordbox',
						trackId: link.trackId,
						kind: 'cue',
						fieldKey: c.key,
						baseJson: c.base,
						theirsJson: c.theirs,
						detectedAt: new Date(),
					}).run();
					totals.conflictsDetected++;
				}

				if (merge.apply.length > 0) {
					totals.cuesUpserted += mut.recordCueChanges(this.db, [link.trackId], () => applyCueOpsToTrack(this.db, link.trackId, merge.apply, oursRows));
				}

				// Persist the advanced baseline only when it moved — a no-op
				// merge on a 10k-link library must not produce 10k UPDATEs.
				if (JSON.stringify(merge.seenAdvance) !== JSON.stringify(link.cuesSeen)) {
					this.db.update(rekordboxLink)
						.set({ cuesSeen: merge.seenAdvance })
						.where(eq(rekordboxLink.trackId, link.trackId))
						.run();
				}
			}
		});
	}

	// (Cue-row rebuilding lives in ../sync/apply.ts:applyCueOpsToTrack —
	// shared with the conflict-resolution path.)

	// Legacy first-sync semantics, scoped per track: wipe rekordbox-origin
	// rows (slot ordinals from older imports don't round-trip), land rb's
	// set; a surviving curator-origin row at the same (slot, kind) is kept
	// unless the track won LMW this run (or "Sync Everything" forced it).
	private bootstrapTrackCues(
		trackId: string,
		rbUnits: CueUnit[],
		oursRows: Array<{ id: string; slot: number; kind: 'hot' | 'memory'; origin: 'rekordbox' | 'curator' }>,
		overwriteCurator: boolean,
		totals: ImportTotals,
	): void {
		const rbWins = overwriteCurator || this.rbWinsTracks.has(trackId);
		const wipeIds = oursRows.filter((r) => r.origin === 'rekordbox').map((r) => r.id);
		if (wipeIds.length > 0) {
			this.db.delete(cueTable).where(inArray(cueTable.id, wipeIds)).run();
		}
		const survivors = new Set(
			oursRows.filter((r) => r.origin === 'curator').map((r) => `${r.kind}:${r.slot}`),
		);
		for (const unit of rbUnits) {
			if (survivors.has(`${unit.kind}:${unit.slot}`) && !rbWins) continue;
			const cueRow: NewCue = {
				id: randomUUID(),
				trackId,
				slot: unit.slot,
				positionSec: unit.positionSec,
				lengthSec: unit.lengthSec,
				color: unit.color,
				name: unit.name,
				kind: unit.kind,
				origin: 'rekordbox',
				createdAt: new Date(),
			};
			this.db.insert(cueTable)
				.values(cueRow)
				.onConflictDoUpdate({
					target: [cueTable.trackId, cueTable.slot, cueTable.kind],
					set: {
						positionSec: cueRow.positionSec,
						lengthSec: cueRow.lengthSec,
						color: cueRow.color,
						name: cueRow.name,
						// rbWins overwrote a curator-authored cue at this pad —
						// the row's content is now Rekordbox's, so its origin is too.
						origin: 'rekordbox',
					},
				})
				.run();
			totals.cuesUpserted++;
		}
	}

	// ──────────────────────────────────────────────────────────────────────
	// Playlists + folders.

	private applyPlaylistDelta(
		row: PlaylistDeltaRow,
		trackIdMap: Map<string, string>,
		playlistIdMap: Map<string, string>,
		totals: ImportTotals,
	): void {
		// Smart playlists are dynamic in Rekordbox — DjmdSongPlaylist has no
		// rows for them; SmartList carries the criteria evaluated at runtime.
		// We persist the *definition* (so the sidebar can render them greyed
		// out and the click can show a "coming soon" watermark) but never
		// touch playlist_track for these rows.

		// Defense in depth: the sidecar normalizes "root"/"0"/"" to null, but
		// older builds or unforeseen rekordbox versions may still emit a literal
		// root marker. Treat those as null here too so we never write a dangling
		// `rb_root` foreign key.
		const rawParent = row.parent_folder_id;
		const parentFolderId = (!rawParent || rawParent === 'root' || rawParent === '0')
			? null
			: `rb_${rawParent}`;
		const kindLabel = row.is_folder ? 'folder' : (row.is_smart ? 'smart-playlist' : 'playlist');

		// Tombstone: rekordbox soft-deletes (rb_local_deleted=1 + USN bump) a
		// row some sync peer has already seen (rb_local_synced=1), so that
		// delete rides the normal incremental watermark. Rows no peer has seen
		// are hard-deleted instead and never arrive here — the post-scan
		// existence index (prunePlaylistsMissingFromRekordbox) catches those.
		// rekordbox owns existence for rb-sourced rows, so its delete is
		// Curator's delete either way.
		if (row.rb_local_deleted) {
			const rbId = row.rb_playlist_id;
			this.db.transaction((tx) => {
				this.deleteRbPlaylistRow(tx, { id: `rb_${rbId}`, rbId, isFolder: row.is_folder });
			});
			totals.playlistsDeleted++;
			ilog.info('playlist delta: deleted (rb tombstone)', { kind: kindLabel, name: row.name, rbId });
			return;
		}

		ilog.debug('playlist delta', { kind: kindLabel, name: row.name, rbId: row.rb_playlist_id, parent: parentFolderId ?? '(root)', tracks: row.tracks.length });

		if (row.is_folder) {
			const id = `rb_${row.rb_playlist_id}`;
			const nameAscii = searchFold(row.name);
			const folder: NewPlaylistFolder = {
				id,
				source: 'rekordbox',
				sourceId: row.rb_playlist_id,
				parentFolderId,
				name: row.name,
				nameAscii,
				position: row.position ?? 0,
				createdAt: new Date(),
				updatedAt: new Date(),
			};
			// folder create / rename / move-to-folder for what the upsert changed.
			mut.recordFolderWrite(this.db, id, () => this.db.insert(playlistFolderTable)
				.values(folder)
				.onConflictDoUpdate({
					target: playlistFolderTable.id,
					set: { name: row.name, nameAscii, parentFolderId: folder.parentFolderId, position: folder.position, updatedAt: new Date() },
				})
				.run());
			playlistIdMap.set(row.rb_playlist_id, id);
			totals.playlistsUpserted++;
			return;
		}

		const id = `rb_${row.rb_playlist_id}`;
		const nameAscii = searchFold(row.name);
		const playlist: NewPlaylist = {
			id,
			source: 'rekordbox',
			sourceId: row.rb_playlist_id,
			url: null,
			name: row.name,
			nameAscii,
			description: null,
			ownerName: null,
			ownerId: null,
			coverUrl: null,
			trackCount: row.is_smart ? null : row.tracks.length,
			followers: null,
			isCollaborative: null,
			isPublic: null,
			lastSyncedAt: new Date(),
			remoteUpdatedAt: new Date(),
			syncStatus: 'synced',
			syncError: null,
			syncCursor: null,
			mark: 'R',
			isFavorite: false,
			isHidden: false,
			hybridTidal: false,
			parentFolderId,
			position: row.position ?? 0,
			isSmart: row.is_smart,
			// rekordbox's own name — the push's rename baseline (exporter skips
			// a no-op playlist_merge when name == rbNameSeen).
			rbNameSeen: row.name,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		// playlist create / rename / move-to-folder for what the upsert
		// changed (smart playlists are device-local and emit nothing).
		mut.recordPlaylistWrite(this.db, id, () => this.db.insert(playlistTable)
			.values(playlist)
			.onConflictDoUpdate({
				target: playlistTable.id,
				set: {
					name: row.name,
					nameAscii,
					rbNameSeen: row.name,
					trackCount: playlist.trackCount,
					parentFolderId: playlist.parentFolderId,
					position: playlist.position,
					isSmart: playlist.isSmart,
					lastSyncedAt: new Date(),
					updatedAt: new Date(),
				},
			})
			.run());
		playlistIdMap.set(row.rb_playlist_id, id);

		// Smart playlists: membership is evaluated at runtime by Rekordbox.
		// DjmdSongPlaylist never has rows for them, so we have nothing to
		// write; the sidebar surfaces these as greyed-out + the renderer
		// shows a placeholder when one is selected.
		if (row.is_smart) {
			totals.playlistsUpserted++;
			return;
		}

		// Membership 3-way merge (rb→Curator direction). The old wholesale
		// wipe-and-re-add resurrected Curator-side removals (rb still has the
		// track → re-inserted) and silently dropped rb members Curator can't
		// link. The merge instead classifies each member from (inBaseline,
		// inCurator, inRekordbox) so Curator deletes survive an inbound sync
		// and rb-only members aren't dropped. The Curator→rb half (pushing
		// Curator's deletes/adds, advancing the baseline) lives in the exporter.
		this.mergePlaylistMembership(id, row.rb_playlist_id, row.tracks, trackIdMap);
		totals.playlistsUpserted++;
	}

	// Shared removal for one rb-sourced playlist/folder row — the tombstone
	// branch and the post-scan existence prune must clean the same
	// satellites. playlist_track cascades on the playlist FK, but
	// playlistConflict + rekordboxMembershipBaseline are keyed by the raw rb
	// id with no FK, so clear them explicitly. A folder's surviving children
	// are reparented to root first so a folder delete can never orphan a
	// subtree (a deleted folder's own children are normally gone too and get
	// removed in the same run).
	private deleteRbPlaylistRow(tx: Db, row: { id: string; rbId: string; isFolder: boolean }): void {
		// The library rows go through the mutators (folder: children moved to
		// the root, then the delete; playlist: its rows, then the delete);
		// they run on the root Db and so join the caller's transaction.
		if (row.isFolder) {
			mut.deletePlaylistFolder(this.db, row.id);
		} else {
			tx.delete(playlistConflict).where(and(eq(playlistConflict.provider, 'rekordbox'), eq(playlistConflict.rbPlaylistId, row.rbId))).run();
			tx.delete(rekordboxMembershipBaseline).where(eq(rekordboxMembershipBaseline.rbPlaylistId, row.rbId)).run();
			mut.deletePlaylist(this.db, row.id);
		}
	}

	// Existence reconcile for rb-sourced playlists + folders. rekordbox only
	// tombstones a DjmdPlaylist row a sync peer has already seen
	// (rb_local_synced=1); a row no peer saw is hard-deleted, so its
	// disappearance never rides the USN stream and the tombstone branch above
	// never fires. (The user's library has been in that state since its sync
	// peer went quiet in 2026-07 — deleted gig folders piled up in Curator.)
	// The reader therefore emits `playlist_index` after every COMPLETE
	// playlists pass: `live_ids` on a whole-library read (Curator rows absent
	// from it are gone), `missing_ids` on a targeted pull (only the requested
	// ids are judged). Breaker: a whole-library diff that would remove more
	// than max(10, 25%) of Curator's rb rows is held unless the user asked to
	// overwrite Curator ('Sync Everything') — a truncated index must never
	// read as mass deletion (same instinct as the exporter's RemovalHold).
	private prunePlaylistsMissingFromRekordbox(index: PlaylistIndexRow, overwrite: boolean, totals: ImportTotals): void {
		type RbRow = { id: string; rbId: string; name: string; isFolder: boolean };
		const rows: RbRow[] = [
			...this.db.select({ id: playlistTable.id, rbId: playlistTable.sourceId, name: playlistTable.name })
				.from(playlistTable).where(eq(playlistTable.source, 'rekordbox')).all()
				.map((r) => ({ ...r, isFolder: false })),
			...this.db.select({ id: playlistFolderTable.id, rbId: playlistFolderTable.sourceId, name: playlistFolderTable.name })
				.from(playlistFolderTable).where(eq(playlistFolderTable.source, 'rekordbox')).all()
				.map((r) => ({ ...r, isFolder: true })),
		];
		let gone: RbRow[];
		if (index.live_ids) {
			const live = new Set(index.live_ids);
			gone = rows.filter((r) => !live.has(r.rbId));
			const threshold = Math.max(10, Math.ceil(rows.length * 0.25));
			if (gone.length > threshold && !overwrite) {
				totals.playlistsPruneHeld = gone.length;
				ilog.warn('playlist prune held: too many rb rows missing from rekordbox at once', {
					missing: gone.length, total: rows.length, threshold, sample: gone.slice(0, 5).map((r) => r.name),
				});
				return;
			}
		} else if (index.missing_ids) {
			const missing = new Set(index.missing_ids);
			gone = rows.filter((r) => missing.has(r.rbId));
		} else {
			return;
		}
		if (gone.length === 0) return;
		this.db.transaction((tx) => {
			// Playlists before folders so a gone folder's gone children are
			// deleted outright rather than first reparented to root.
			for (const r of gone) if (!r.isFolder) this.deleteRbPlaylistRow(tx, r);
			for (const r of gone) if (r.isFolder) this.deleteRbPlaylistRow(tx, r);
		});
		for (const r of gone) {
			ilog.info('playlist pruned: missing from rekordbox', { kind: r.isFolder ? 'folder' : 'playlist', name: r.name, rbId: r.rbId });
		}
		totals.playlistsDeleted += gone.length;
	}

	// Per-playlist membership merge. `id` is the Curator playlist id
	// (`rb_<rbPlaylistId>`); `rbPlaylistId` is the raw rb side id;
	// `rbTracks` is rekordbox's current membership R.
	private mergePlaylistMembership(
		id: string,
		rbPlaylistId: string,
		rbTracks: Array<{ rb_content_id: string; position: number }>,
		trackIdMap: Map<string, string>,
	): void {
		const key = (kind: 'rb' | 'curator', memberId: string): string => `${kind}:${memberId}`;

		// B — last-agreed baseline.
		const baseRows = this.db
			.select({ memberKind: rekordboxMembershipBaseline.memberKind, memberId: rekordboxMembershipBaseline.memberId, position: rekordboxMembershipBaseline.position })
			.from(rekordboxMembershipBaseline)
			.where(eq(rekordboxMembershipBaseline.rbPlaylistId, rbPlaylistId))
			.orderBy(rekordboxMembershipBaseline.position)
			.all();
		const baseKeys = new Set(baseRows.map((b) => key(b.memberKind as 'rb' | 'curator', b.memberId)));
		const baseRbOrder = baseRows.filter((b) => b.memberKind === 'rb').map((b) => b.memberId);

		// C — current Curator membership, each tagged with its cross-side id.
		const curRows = this.db
			.select({ trackId: playlistTrack.trackId, position: playlistTrack.position, addedAt: playlistTrack.addedAt, addedBy: playlistTrack.addedBy, sourceTrackId: playlistTrack.sourceTrackId })
			.from(playlistTrack)
			.where(eq(playlistTrack.playlistId, id))
			.orderBy(playlistTrack.position)
			.all();
		const curTrackIds = curRows.map((r) => r.trackId);
		const curLinks = curTrackIds.length === 0 ? [] : this.db
			.select({ trackId: rekordboxLink.trackId, rbContentId: rekordboxLink.rbContentId })
			.from(rekordboxLink)
			.where(inArray(rekordboxLink.trackId, curTrackIds))
			.all();
		const rbByCurTrack = new Map(curLinks.map((l) => [l.trackId, l.rbContentId]));
		type CurMember = { trackId: string; addedAt: Date | null; addedBy: string | null; sourceTrackId: string; kind: 'rb' | 'curator'; memberId: string; key: string };
		const curMembers: CurMember[] = curRows.map((r) => {
			const rbId = rbByCurTrack.get(r.trackId) ?? null;
			const kind = rbId ? 'rb' as const : 'curator' as const;
			const memberId = rbId ?? r.trackId;
			return { trackId: r.trackId, addedAt: r.addedAt, addedBy: r.addedBy, sourceTrackId: r.sourceTrackId, kind, memberId, key: key(kind, memberId) };
		});
		const curByKey = new Map(curMembers.map((m) => [m.key, m]));
		const curRbOrder = curMembers.filter((m) => m.kind === 'rb').map((m) => m.memberId);

		// R — rekordbox's current membership (always rb-kind).
		const rSorted = [...rbTracks].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
		const rOrder = rSorted.map((t) => t.rb_content_id);
		const rSet = new Set(rOrder);

		// Entity tombstones — rb content destructively deleted in Curator.
		const tombstoned = new Set(
			this.db.select({ rbContentId: rekordboxDeletedContent.rbContentId }).from(rekordboxDeletedContent).all().map((r) => r.rbContentId),
		);

		// Decide inclusion per rb member id (the only kind R carries).
		const includeRb = new Set<string>();        // rb content ids kept in Curator
		const removeFromRbTombstoned = new Set<string>(); // tombstoned ids present in R → mark for rb removal
		const allRbIds = new Set<string>([...rSet, ...curRbOrder, ...baseRbOrder]);
		for (const cid of allRbIds) {
			const k = key('rb', cid);
			const inB = baseKeys.has(k);
			const inC = curByKey.has(k);
			const inR = rSet.has(cid);
			if (tombstoned.has(cid)) {
				// Stays deleted. If rb still has it, ensure it leaves rb too
				// (baseline row → exporter's B-vs-C removes it).
				if (inR) removeFromRbTombstoned.add(cid);
				continue;
			}
			if (inR) {
				if (inB && !inC) continue;            // Curator deleted → don't re-add
				includeRb.add(cid);                   // add / unchanged / both-added
			} else {
				if (inC && inB) continue;             // rb deleted → drop from Curator
				if (inC && !inB) includeRb.add(cid);  // Curator added, rb doesn't have yet
			}
		}

		// Order: rb wins unless only Curator reordered. Conflict iff both
		// reordered the common members relative to baseline.
		const common = new Set(baseRbOrder.filter((cid) => rSet.has(cid) && curByKey.has(key('rb', cid))));
		const seq = (order: string[]): string[] => seqIn(order, common);
		const rbReordered = !eqArr(seq(rOrder), seq(baseRbOrder));
		const curatorReordered = !eqArr(seq(curRbOrder), seq(baseRbOrder));
		const orderConflict = rbReordered && curatorReordered;
		const authoritativeRbOrder = (curatorReordered && !rbReordered) ? curRbOrder : rOrder;

		// Build merged rb-id order: authoritative order first (included only),
		// then any included rb member missing from it (Curator-added-not-in-R),
		// in Curator order, then any rb-side add the authoritative order
		// didn't carry (Curator's order won, so rb's adds weren't in it) in
		// rb order — membership is lossless; a Curator reorder must never
		// make an rb-added track vanish until the next pull.
		const mergedRbIds: string[] = [];
		const seen = new Set<string>();
		for (const cid of authoritativeRbOrder) {
			if (includeRb.has(cid) && !seen.has(cid)) { mergedRbIds.push(cid); seen.add(cid); }
		}
		for (const cid of curRbOrder) {
			if (includeRb.has(cid) && !seen.has(cid)) { mergedRbIds.push(cid); seen.add(cid); }
		}
		for (const cid of rOrder) {
			if (includeRb.has(cid) && !seen.has(cid)) { mergedRbIds.push(cid); seen.add(cid); }
		}

		// Resolve rb ids → Curator track ids; unresolvable members (rb content
		// never imported as a track) are skipped from Curator. They are never
		// written to the baseline either, so the exporter's targeted diff never
		// removes them from rb — that's the unlinked-member protection.
		const desired: mut.DesiredMember[] = [];
		// Kept rows keep their add date: reconcile writes `desired`'s columns
		// onto matched rows, and "now" would restamp every member every pull.
		const curAddedAt = new Map(curMembers.map((m) => [m.trackId, m.addedAt]));
		// rb members that actually landed in playlist_track — the only ones
		// the baseline may adopt. An unresolvable cid (rb content Curator never
		// imported) or a cid collapsed by the per-track dedupe below is NOT in
		// Curator, and a baseline entry for it would read as a Curator-side
		// removal on the next push and delete it from rekordbox.
		const adoptedRb = new Set<string>();
		const writtenTracks = new Set<string>();
		for (const cid of mergedRbIds) {
			const trackId = this.resolveTrackId(cid, trackIdMap);
			if (!trackId) continue;
			if (writtenTracks.has(trackId)) continue; // two rb ids resolving to one track: keep the first
			writtenTracks.add(trackId);
			adoptedRb.add(cid);
			desired.push({ trackId, addedAt: curAddedAt.get(trackId) ?? new Date(), addedBy: 'rekordbox', sourceTrackId: cid });
		}
		// Curator-only members (kind='curator') — rb can't track them, so keep
		// whatever Curator currently has, in Curator order.
		for (const m of curMembers) {
			if (m.kind !== 'curator') continue;
			if (writtenTracks.has(m.trackId)) continue;
			writtenTracks.add(m.trackId);
			desired.push({ trackId: m.trackId, addedAt: m.addedAt ?? new Date(), addedBy: m.addedBy, sourceTrackId: m.sourceTrackId });
		}

		this.db.transaction((tx) => {
			// A diff against the current rows (add/move/remove ops for what
			// changed), not a wipe: unchanged members keep their row ids, so a
			// pull that changed nothing writes nothing.
			mut.reconcileMembership(this.db, id, desired, 'rekordbox');
			// Advance the rb-kind baseline to what both sides now hold (see
			// advanceRbBaselineAfterPull for the per-member rules) so the push
			// doesn't mistake rb-originated adds/order for Curator edits. Held
			// back on an order conflict — the ancestor must stay put until the
			// user picks a side (reorderPlaylistToRbOrder / the push advance).
			// Curator-kind rows are left alone: they have no rb identity and
			// the exporter's diff reads rb-kind only.
			if (!orderConflict) {
				const nextBase = advanceRbBaselineAfterPull({
					baseRbOrder,
					rOrder,
					includeRb: adoptedRb,
					mergedOrder: mergedRbIds,
					keepBaseOrder: authoritativeRbOrder === curRbOrder,
				});
				tx.delete(rekordboxMembershipBaseline)
					.where(and(eq(rekordboxMembershipBaseline.rbPlaylistId, rbPlaylistId), eq(rekordboxMembershipBaseline.memberKind, 'rb')))
					.run();
				const now = new Date();
				nextBase.forEach((cid, position) => {
					tx.insert(rekordboxMembershipBaseline)
						.values({ rbPlaylistId, memberKind: 'rb', memberId: cid, position, updatedAt: now })
						.run();
				});
			}
			// Tombstoned-but-still-in-rb members: seed a baseline row so the
			// exporter's B-vs-C diff issues a targeted remove from rekordbox.
			for (const cid of removeFromRbTombstoned) {
				tx.insert(rekordboxMembershipBaseline)
					.values({ rbPlaylistId, memberKind: 'rb', memberId: cid, position: 0, updatedAt: new Date() })
					.onConflictDoNothing()
					.run();
			}
			// Order conflict surfacing — upsert on both-reordered, clear otherwise.
			if (orderConflict) {
				tx.insert(playlistConflict)
					.values({ id: randomUUID(), provider: 'rekordbox', rbPlaylistId, kind: 'order', baseJson: seq(baseRbOrder), theirsJson: seq(rOrder), detectedAt: new Date() })
					.onConflictDoUpdate({
						target: [playlistConflict.provider, playlistConflict.rbPlaylistId, playlistConflict.kind],
						set: { theirsJson: seq(rOrder), baseJson: seq(baseRbOrder), detectedAt: new Date() },
					})
					.run();
			} else {
				tx.delete(playlistConflict)
					.where(and(
						eq(playlistConflict.provider, 'rekordbox'),
						eq(playlistConflict.rbPlaylistId, rbPlaylistId),
						eq(playlistConflict.kind, 'order'),
					))
					.run();
			}
		});
	}

	// ──────────────────────────────────────────────────────────────────────
	// MyTags — 1:1 mapping into Curator's tag table (kind='user').

	private applyMyTagDelta(
		row: MyTagDeltaRow,
		_flags: RekordboxFlags,
		idMap: Map<string, string>,
		totals: ImportTotals,
	): void {
		const tagId = `rb_${row.rb_tag_id}`;
		const tagRow: NewTag = {
			id: tagId,
			name: row.name,
			kind: 'user',
			color: row.color ?? null,
			sortOrder: 0,
			createdAt: new Date(),
		};
		mut.recordTagWrite(this.db, tagId, () => this.db.insert(tagTable)
			.values(tagRow)
			.onConflictDoUpdate({
				target: tagTable.id,
				set: { name: row.name, color: row.color ?? null },
			})
			.run());

		// Membership: additive. Rekordbox tag-removals don't propagate back
		// because tag membership has no per-pair timestamp — the LMW rule
		// only works at the track level. If a user removes a track from an
		// rb tag in Rekordbox, they'll need to also remove it in Curator.
		// (When per-field LMW lands we can do better here.)
		const members: string[] = [];
		for (const rbContentId of row.tracks) {
			const trackId = this.resolveTrackId(rbContentId, idMap);
			if (trackId) members.push(trackId);
		}
		// One track_tag add per assignment that is new.
		mut.tagTracks(this.db, members, tagId);
		totals.myTagsUpserted++;
	}

	// rekordbox soft-deleted these MyTags (rb_local_deleted=1) — they are gone
	// from its tag pane, and any DjmdSongMyTag row pointing at them is
	// invisible. Curator used to import them as live tags and kept pushing
	// memberships at the dead ids (2026-08-25: one rb operation tombstoned 33
	// tags incl. vocal/controlling/afterglow). Per dead tag:
	//   1. a LIVE rb tag with the same name exists (rekordbox re-created it,
	//      e.g. the second "vocal") → move memberships onto it, drop the dead
	//      tag. Affected tracks are marked dirty so the next push rewrites
	//      their rb membership from the live id.
	//   2. no memberships in Curator → prune the tag row.
	//   3. still curated with → keep as-is; the exporter's tags op references
	//      it and writer.apply_tags revives the rb row (same id, same group).
	// Idempotent — runs on every import over the full tombstone set.
	private reconcileDeadMyTags(dead: MyTagDeltaRow[], totals: ImportTotals): void {
		const deadIds = new Set(dead.map((d) => `rb_${d.rb_tag_id}`));
		const allTags = this.db.select({ id: tagTable.id, name: tagTable.name }).from(tagTable).all();
		const liveByName = new Map<string, string>();
		for (const t of allTags) {
			if (!t.id.startsWith('rb_') || deadIds.has(t.id)) continue;
			const k = t.name.trim().toLowerCase();
			if (!liveByName.has(k)) liveByName.set(k, t.id);
		}
		const present = new Set(allTags.map((t) => t.id));
		const now = new Date();
		for (const d of dead) {
			const deadId = `rb_${d.rb_tag_id}`;
			if (!present.has(deadId)) continue;
			const members = this.db.select({ trackId: trackTag.trackId }).from(trackTag).where(eq(trackTag.tagId, deadId)).all();
			const liveId = liveByName.get(d.name.trim().toLowerCase());
			if (liveId) {
				this.db.transaction((tx) => {
					// Assignments onto the live tag (adds), then the dead tag's
					// delete — container delete hides whatever it still holds.
					mut.tagTracks(this.db, members.map((m) => m.trackId), liveId, { addedAt: now });
					mut.deleteTag(this.db, deadId);
					// Dirty the tracks so "Sync updates" rewrites their rb membership.
					for (let i = 0; i < members.length; i += 500) {
						tx.update(track).set({ updatedAt: now }).where(inArray(track.id, members.slice(i, i + 500).map((m) => m.trackId))).run();
					}
				});
				ilog.info('dead rb tag merged into live same-name tag', { dead: deadId, live: liveId, name: d.name, members: members.length });
				totals.myTagsMerged++;
			} else if (members.length === 0) {
				mut.deleteTag(this.db, deadId);
				ilog.info('dead rb tag pruned (no memberships)', { dead: deadId, name: d.name });
				totals.myTagsPruned++;
			} else {
				ilog.info('dead rb tag kept — still curated; next push revives it', { dead: deadId, name: d.name, members: members.length });
			}
		}
	}

	// ──────────────────────────────────────────────────────────────────────
	// Play history — one djmdHistory session per event, upserted whole.

	private applyHistoryDelta(
		row: HistoryDeltaRow,
		idMap: Map<string, string>,
		totals: ImportTotals,
	): void {
		const plays = row.plays ?? [];
		// The session's real date: rekordbox bakes it into the name
		// ("HISTORY 2026-08-14 (2)"); DateCreated falls back. For USB-imported
		// histories DateCreated is the import instant, so the name is the
		// only truthful record of when the set happened.
		const nameDate = /HISTORY (\d{4})-(\d{2})-(\d{2})/.exec(row.name ?? '');
		const startedAtMs = nameDate
			? new Date(Number(nameDate[1]), Number(nameDate[2]) - 1, Number(nameDate[3])).getTime()
			: row.date_created_ms ?? Date.now();

		// USB/CDJ set detection — deterministic, not a heuristic: a history
		// imported from the USB device pane bulk-inserts every djmdSongHistory
		// row in the same instant (span ≈ 0 across 20-50 plays), while a live
		// rekordbox session spreads row created_at across the session. Bulk
		// sessions keep only trackNo order; their per-play timestamps are the
		// import moment and are dropped.
		const times = plays
			.map((p) => p.created_at_ms)
			.filter((t): t is number => t != null);
		const spanMs = times.length ? Math.max(...times) - Math.min(...times) : 0;
		const isBulk = plays.length >= 3 && spanMs <= 2000;
		const autoKind: 'set' | 'prep' = isBulk ? 'set' : 'prep';
		const endedAt = !isBulk && times.length ? new Date(Math.max(...times)) : null;

		// The reader sends the WHOLE history on every sync (~1.2k sessions /
		// 29k plays on the live library), so this runs as a diff: a session or
		// play is written, and emitted as an op, only when it is new or one of
		// its synced fields moved. Re-importing an unchanged history is reads
		// only. It used to upsert every play and re-emit every session and
		// play on each sync (2026-10-18: 87k pending play ops after three
		// syncs, the playlists→completed segment up from ~5 s to ~12 s, all on
		// the main loop).
		const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);
		let sessionChanged = false;
		const changedEvents: string[] = [];
		this.db.transaction((tx) => {
			const existing = tx
				.select({
					id: playSession.id,
					kind: playSession.kind,
					kindSource: playSession.kindSource,
					name: playSession.name,
					startedAt: playSession.startedAt,
					endedAt: playSession.endedAt,
				})
				.from(playSession)
				.where(eq(playSession.rbHistoryId, row.rb_history_id))
				.get();
			let sessionId: string;
			if (existing) {
				sessionId = existing.id;
				// A user override is permanent — the classifier only writes
				// while kindSource is still 'auto'.
				const kind = existing.kindSource === 'user' ? existing.kind : autoKind;
				sessionChanged = existing.name !== row.name
					|| ms(existing.startedAt) !== startedAtMs
					|| ms(existing.endedAt) !== ms(endedAt)
					|| existing.kind !== kind;
				if (sessionChanged) {
					tx.update(playSession)
						.set({
							name: row.name,
							startedAt: new Date(startedAtMs),
							endedAt,
							updatedAt: new Date(),
							...(existing.kindSource === 'user' ? {} : { kind: autoKind }),
						})
						.where(eq(playSession.id, sessionId))
						.run();
				}
			} else {
				sessionId = randomUUID();
				sessionChanged = true;
				tx.insert(playSession)
					.values({
						id: sessionId,
						origin: 'rekordbox',
						kind: autoKind,
						kindSource: 'auto',
						name: row.name,
						startedAt: new Date(startedAtMs),
						endedAt,
						rbHistoryId: row.rb_history_id,
					})
					.run();
			}

			// Resolve rb_content_id → trackId in one batched query for the ids
			// the track pass didn't already cache. Unmatched plays keep
			// trackId null + rbContentId; healUnlinkedPlayEvents re-links them
			// once the track/link exists.
			const missing = [...new Set(plays.map((p) => p.rb_content_id))].filter((cid) => !idMap.has(cid));
			if (missing.length) {
				const links = tx
					.select({ trackId: rekordboxLink.trackId, rbContentId: rekordboxLink.rbContentId })
					.from(rekordboxLink)
					.where(inArray(rekordboxLink.rbContentId, missing))
					.all();
				for (const l of links) idMap.set(l.rbContentId, l.trackId);
			}

			// The rows these plays already have, keyed by rb_song_history_id
			// (not by session: a play can move between sessions), in one query.
			// Raw statements prepared once per handle: this loop runs 29k
			// times per sync and drizzle builds + compiles every call.
			const st = historyStmts(rawOf(this.db));
			type Prior = { id: string; session_id: string; track_id: string | null; played_at: number | null; track_no: number | null };
			const prior = new Map<string, Prior>();
			for (const r of st.prior.all(JSON.stringify(plays.map((p) => p.rb_song_history_id))) as Array<Prior & { rb_song_history_id: string }>) {
				prior.set(r.rb_song_history_id, r);
			}

			for (const p of plays) {
				const trackId = idMap.get(p.rb_content_id) ?? null;
				const playedAt = !isBulk && p.created_at_ms != null ? p.created_at_ms : null;
				const cur = prior.get(p.rb_song_history_id);
				if (!cur) {
					const id = randomUUID();
					st.insert.run(id, sessionId, trackId, p.rb_content_id, playedAt, p.track_no, p.rb_song_history_id);
					prior.set(p.rb_song_history_id, { id, session_id: sessionId, track_id: trackId, played_at: playedAt, track_no: p.track_no });
					changedEvents.push(id);
					continue;
				}
				// Never null out a previously-resolved trackId just because the
				// link vanished this run.
				const nextTrackId = trackId ?? cur.track_id;
				if (cur.session_id === sessionId && cur.played_at === playedAt && cur.track_no === p.track_no && cur.track_id === nextTrackId) continue;
				st.update.run(sessionId, playedAt, p.track_no, trackId, cur.id);
				prior.set(p.rb_song_history_id, { ...cur, session_id: sessionId, played_at: playedAt, track_no: p.track_no, track_id: nextTrackId });
				changedEvents.push(cur.id);
			}
			// play_session + play_event appends for exactly what changed.
			mut.recordPlayAppended(this.db, changedEvents, sessionChanged ? [sessionId] : []);
		});
		totals.historySessionsSeen++;
		totals.historyPlaysSeen += plays.length;
		if (sessionChanged) totals.historySessionsUpserted++;
		totals.historyPlaysUpserted += changedEvents.length;
	}

	// Re-link rekordbox play events whose track didn't exist (or wasn't
	// linked) when the play was imported. Indexed on rb_content_id; runs once
	// per history-scoped scan.
	//
	// Healed plays are emitted (recording_id is synced state). Before the
	// history import became a diff, the next sync's full restate carried a
	// heal to the log by accident; now nothing else would.
	private healUnlinkedPlayEvents(): void {
		this.db.transaction((tx) => {
			const healed = tx.all<{ id: string }>(sql`
				SELECT id FROM play_event
				WHERE track_id IS NULL
				  AND rb_content_id IS NOT NULL
				  AND EXISTS (
					SELECT 1 FROM rekordbox_link rl
					WHERE rl.rb_content_id = play_event.rb_content_id
				  )
			`).map((r) => r.id);
			if (healed.length === 0) return;
			tx.run(sql`
				UPDATE play_event SET track_id = (
					SELECT rl.track_id FROM rekordbox_link rl
					WHERE rl.rb_content_id = play_event.rb_content_id
				)
				WHERE track_id IS NULL
				  AND rb_content_id IS NOT NULL
				  AND EXISTS (
					SELECT 1 FROM rekordbox_link rl
					WHERE rl.rb_content_id = play_event.rb_content_id
				  )
			`);
			mut.recordPlayAppended(this.db, healed, []);
		});
	}

	// ──────────────────────────────────────────────────────────────────────
	// Waveforms + beatgrids.

	// `db` parameter (default = this.db) lets the batch flusher pass a tx
	// from db.transaction(...), so a run of waveform writes commits as one
	// WAL fsync instead of one fsync per row. On a fresh import with N=4500
	// the per-row autocommit pattern was the dominant cost; batching at
	// N=100 cuts the importer side to ~45 commits.
	//
	// `overwriteCurator` is the "Sync Everything" flag: when true we bypass
	// the rbWins LMW gate and unconditionally write the rb beatgrid +
	// downbeats + segments, re-stamping analyzer_version='rekordbox'. Used
	// when the user explicitly opts to take rb's values over Curator's.
	private applyWaveformDelta(
		row: WaveformDeltaRow,
		_flags: RekordboxFlags,
		idMap: Map<string, string>,
		totals: ImportTotals,
		db: Db = this.db,
		_overwriteCurator: boolean = false,
	): void {
		const trackId = this.resolveTrackId(row.rb_content_id, idMap);
		if (!trackId) return;

		// Waveform peaks: the sidecar wrote .cpk files keyed on rb_<contentId>.
		// We don't bother renaming — track_analysis doesn't carry the path; the
		// renderer will look up the rekordbox link to find the path when the
		// per-track UI lands. For now, this just means we have a second set
		// of .cpk files on disk. Sidecar's mtime check prevents regenerating
		// them needlessly.
		totals.waveformsUpserted++;

		// Beatgrid + segments → the Rekordbox SLOT (rb_* columns). This slot is
		// rb-owned: the analyzer never writes it and never reads it, so there's
		// no Curator data to protect and no LMW gate is needed — each import
		// just refreshes rb's grid/segments. The Curator slot (the legacy
		// columns) is left completely untouched here. A player setting decides
		// which slot the UI displays. (Pre-dual-source this wrote the legacy
		// columns behind an rbWins gate, which is what let a force-re-analyze
		// later clobber the rb grid.)
		const hasBeatgrid = Array.isArray(row.beatgrid_sec) && row.beatgrid_sec.length > 0;
		const hasSegments = row.segments != null && row.segments.length > 0;
		if (!hasBeatgrid && !hasSegments) return;

		const toBuf = float32Buffer;

		// Derived intro/outro scalars from rb segments (rb-slot.ts), mirrored
		// onto the track row for the virtualized list's sort/filter.
		const { introLengthSec, outroLengthSec } = hasSegments && row.segments ? rbIntroOutro(row.segments) : { introLengthSec: null, outroLengthSec: null };

		// NOT NULL on a fresh row — placeholder marking "rb data present, no
		// Curator analysis yet". The analyzer overwrites it with its own
		// version when it runs; the rb slot is independent of this marker. On
		// an existing row we leave analyzer_version (and all Curator columns)
		// alone — the update set carries only rb_* fields.
		const insertValues: Record<string, unknown> = {
			trackId,
			analyzerVersion: 'rekordbox',
			analyzedAt: new Date(),
		};
		const updateSet: Record<string, unknown> = {};
		if (hasBeatgrid) {
			const beatBuf = toBuf(row.beatgrid_sec);
			const downbeatBuf = toBuf(row.downbeats_sec);
			insertValues['rbBeatgrid'] = beatBuf;
			insertValues['rbDownbeats'] = downbeatBuf;
			updateSet['rbBeatgrid'] = beatBuf;
			updateSet['rbDownbeats'] = downbeatBuf;
		}
		if (hasSegments && row.segments) {
			insertValues['rbSegmentsJson'] = row.segments;
			updateSet['rbSegmentsJson'] = row.segments;
		}

		db.insert(trackAnalysis)
			.values(insertValues as never)
			.onConflictDoUpdate({
				target: trackAnalysis.trackId,
				set: updateSet,
			})
			.run();
		if (hasBeatgrid) totals.beatgridsUpserted++;
		if (hasSegments) {
			totals.phrasesUpserted++;
			// Mirror the derived scalars onto the track row so the virtualized
			// list can sort/filter without a track_analysis join. (Track-list
			// columns reflecting the displayed source per the toggle is a
			// deferred follow-up; for now rb's intro/outro land here as before.)
			db.update(track)
				.set({ introLengthSec, outroLengthSec })
				.where(eq(track.id, trackId))
				.run();
		}
	}

	// ──────────────────────────────────────────────────────────────────────
	// Helpers.

	private resolveTrackId(rbContentId: string, idMap: Map<string, string>): string | null {
		const cached = idMap.get(rbContentId);
		if (cached) return cached;
		const link = this.db
			.select({ trackId: rekordboxLink.trackId })
			.from(rekordboxLink)
			.where(eq(rekordboxLink.rbContentId, rbContentId))
			.get();
		if (link) {
			idMap.set(rbContentId, link.trackId);
			return link.trackId;
		}
		return null;
	}

	private loadWatermarks(): Record<string, number> {
		const rows = this.db.select().from(rekordboxSyncWatermark).all();
		const out: Record<string, number> = {};
		for (const r of rows) out[r.tableName] = r.lastUsn;
		return out;
	}

	private saveWatermarks(marks: Record<string, number>): void {
		const now = new Date();
		for (const [tableName, lastUsn] of Object.entries(marks)) {
			this.db.insert(rekordboxSyncWatermark)
				.values({ tableName, lastUsn, lastSyncedAt: now })
				.onConflictDoUpdate({
					target: rekordboxSyncWatermark.tableName,
					set: { lastUsn, lastSyncedAt: now },
				})
				.run();
		}
	}
}
