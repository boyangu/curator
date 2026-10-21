// Service interface — the API surface used by the Electron client.
// IPC handlers in apps/desktop/main call into these methods directly.
// When core is deployed remotely, the same surface gets exposed via
// HTTP/WSS — desktop swaps the transport, not the calls.

import { and, asc, count, countDistinct, desc, eq, exists, gte, inArray, isNotNull, isNull, like, lte, ne, notExists, or, sql, type SQL } from 'drizzle-orm';
import { scoreCandidates, type CandidateCounts, type RecommendColumnCounts, type ScoredRecommendation } from './recommend.js';
import { createDb, type Db } from './db/client.js';
import {
	track,
	playlist,
	playlistTrack,
	playlistFolder,
	pinnedSearch,
	sourceLink,
	libraryFolder,
	tag,
	trackTag,
	rekordboxLink,
	rekordboxDeletedContent,
	appSetting,
	artist,
	artistLink,
	trackArtist,
	type PlayRecordUpsert,
	type PlaySession,
	type PlaySessionKind,
	type PlaySessionOrigin,
	type Track,
	type Playlist,
	type PlaylistFolder,
	type PlaylistSource,
	type PinnedSearch,
	type NewPinnedSearch,
	type NewPlaylist,
	type TrackOverrides,
	type TrackArtist,
	type LibraryFolder,
	type NewLibraryFolder,
	type Tag,
	TRACK_STATES,
	type TrackState,
} from '@curator/shared/schema';
import { LibraryScanner, isCloudSyncPath, normalizePath, type ScanProgress, type ScanProgressFn } from './local/scanner.js';
import { log, setCoreLogger } from './log.js';
import type { Logger } from '@curator/shared/log';
import { parseInline } from './ingest/parser.js';
import type { ParseFn } from './ingest/types.js';
import type { ZTrackFilterT, ZTrackSortT, ZTrackPageReqT, TrackPage, ZStateCountsT, StreamingSource, SourceSyncSettings, DjSyncProvider, SyncConflict, SyncConflictChoice, ArtistSummary, ArtistListOpts, ArtistLink, ArtistMergeSuggestion, ArtistScope, AlbumSummary } from '@curator/shared';
import { DEFAULT_SOURCE_SYNC_SETTINGS, artistKey, asciify, asciifyArtists, searchFold, type ArtistCreditFormat } from '@curator/shared';
import { loadArtistAliasMap, mapCredits, rederiveTrackCreditsRaw } from './library/artist-alias.js';
import { lookupArtistRaw, normalizeIncomingArtists, rawOf, syncTrackArtistsById } from './library/artists.js';
import { healAlbumArtistAliasesRaw, liveAlbumIdRaw, syncTrackAlbumsById } from './library/albums.js';
import { createAlbumEnricher } from './library/album-enrich.js';
import { SpotifyAdapter } from './sources/spotify-adapter.js';
import { SourceSyncScheduler } from './sources/scheduler.js';
import type { StreamingSourceAdapter, RemoteWritePolicy } from './sources/adapter.js';
import { makeRemoteWriteGate, guardRemoteWrites } from './sources/adapter.js';
import * as plays from './plays/plays.js';
import type { PlayHistoryRow, PlaySessionSummary, SessionPlayRow, TopPlayedRow } from './plays/plays.js';
import { AuthService, type AuthStatus } from './auth/service.js';
import { randomUUID } from 'node:crypto';
import { dirname, join as joinPath } from 'node:path';
import { SpotifySync, LIKED_SONGS_SENTINEL_ID, type ProgressFn } from './sync/spotify.js';
import { recomputePositions } from './library/playlist-order.js';
import * as mut from './library/mutators.js';
import { createSyncClient, firstPullDone, type CloudSyncEvent, type CloudSyncStatus, type CloudTransport, type SyncClient, type UnlinkOutcome, type WakeReason } from './sync-log/client.js';
import { readPollPolicy, readPollSettings, writePollPolicy, type SyncPollPolicy, type SyncPollSettings } from './sync-log/poll-policy.js';
import { remoteRowCount, requestRematerialize } from './sync-log/remote-rows.js';
import { claimLinksOf, claimLinkUrl, dismissClaimLink } from './sync-log/claim-links.js';
import { masterDevice, serverReadsTrackMeta, setMasterDevice } from './sync-log/track-meta.js';
import type { DevicePlatform } from '@curator/protocol';
import { applyTrackMerge, describeMergeSide, planTrackMerge, suggestKeepId, type TrackMergeSide, type TrackMergePlan, type TrackMergeResult } from './library/merge-tracks.js';

export type SourceLinkError = {
	source: string;
	message: string;
	code?: 'already-linked';
	// The live track that owns the provider id (code === 'already-linked').
	conflictTrackId?: string;
};
export type SetSourceLinksResult = { updated: string[]; refetched: string[]; errors: SourceLinkError[] };

export type { TrackMergeSide, TrackMergePlan, TrackMergeResult } from './library/merge-tracks.js';
export { TrackMergeBlockedError } from './library/merge-tracks.js';
export interface TrackMergePreview {
	a: TrackMergeSide;
	b: TrackMergeSide;
	suggestedKeepId: string;
	// Dry-run plans keyed by the id that would survive.
	plans: Record<string, TrackMergePlan>;
}
export interface TrackMergeOutcome extends TrackMergeResult {
	survivor: Track;
	peaksMoved: number;
	// Best-effort post-transaction steps (peaks rename, feed re-point) that
	// failed; the DB merge itself has already committed.
	errors: string[];
}

// Why a streaming-playlist add/remove did or didn't reach the provider.
// 'none' = nothing to push (local/rekordbox playlist, no provider ids, or no
// adapter). Every other value is worth surfacing to the user: the local DB
// now disagrees with the provider until someone reconciles it.
export type UpstreamPushOutcome = 'pushed' | 'write-sync-off' | 'not-owner' | 'failed' | 'none';

// The sources a user can strip off a track one at a time from the Delete
// dialog. Metadata-only links (beatport, traxsource, musicbrainz, discogs)
// are not "sources" in this sense — they carry no file and no account-side
// state, so they travel with the track row. 'rekordbox' is the rekordbox_link
// row (collection membership), not a source_link.
export type RemovableTrackSource = 'local' | 'spotify' | 'tidal' | 'rekordbox';
export const REMOVABLE_TRACK_SOURCES: readonly RemovableTrackSource[] = ['local', 'spotify', 'tidal', 'rekordbox'];

export interface RemoveTrackSourcesResult {
	// Rows that lost their last removable source and were tombstoned
	// (deletedAt stamped; or DELETEd on the hard path).
	tombstonedTrackIds: string[];
	// Decorated survivors with their refreshed `sources` — the renderer
	// patches these into visible rows instead of refetching the page.
	updated: Track[];
	filesTrashed: number;
	peaksRemoved: number;
	// rekordbox_deleted_content tombstones minted (pushed on the next sync).
	rekordboxTombstoned: number;
	// Playlists that lost at least one of the tracks, by playlist source.
	playlistsTouched: Record<'local' | 'spotify' | 'tidal' | 'rekordbox', number>;
	linksDropped: Record<RemovableTrackSource, number>;
	// Streaming memberships left in place because the user can't modify the
	// playlist (followed). The track still shows there — with a "deleted"
	// chip once tombstoned — and a read-sync may re-link a surviving row.
	followedKept: number;
	errors: { kind: 'file' | 'peaks' | 'playlist'; source?: RemovableTrackSource; message: string }[];
}

// Local-vs-remote membership diff for one streaming playlist. `localOnly`
// rows are Curator additions that never reached the provider (e.g. added
// while writeSyncAuto was off) — pushPlaylistLocalOnly replays them.
export interface PlaylistUpstreamDrift {
	playlistId: string;
	name: string;
	source: PlaylistSource;
	// canModifyUpstream(pl): owned / collaborative, so a push would succeed.
	canModify: boolean;
	localCount: number;
	remoteCount: number;
	// Remote members no local row references — informational only (the
	// read sync is the path that pulls those in).
	remoteOnlyCount: number;
	localOnly: Array<{
		trackId: string;
		// Provider track id the push would send.
		sourceTrackId: string;
		position: number;
		addedAt: Date | null;
		title: string;
		artists: string;
	}>;
}
import { keyToCamelot } from './enrich/keys.js';
import { SqliteFeedStore } from './feed/store.js';
import { createFeedService } from './feed/service.js';
import type { LibraryMembershipLookup } from './feed/pipeline.js';
import type { FeedAction, FeedActionResult, FeedItem, FeedItemDetail, FeedMembershipTier, LibraryTier, FeedPage, FeedRefreshResult, EnrichmentResult } from './feed/types.js';
import { resolveFeedMembership } from './feed/types.js';
import { LibrarySink } from './enrich/sinks/library-sink.js';
import type { FeedFilter } from './feed/store.js';
import { SqliteKnowledgeStore } from './knowledge/store.js';
import { createKnowledgeService } from './knowledge/service.js';
import { ResearcherSidecar } from './knowledge/researcher-sidecar.js';
import type {
	JourneyDetail,
	JourneyNode,
	JourneySeed,
	JourneySummary,
	KbAspect,
	KbEntity,
	KbEntityDetail,
	KbEntityKind,
	KbEvent,
	KbExpansion,
} from './knowledge/types.js';
import type { SpotifyTrack } from '@curator/spotify';
import { SpotifyClient } from '@curator/spotify';
import { SqliteAgentStore, type AgentSessionDetail, type AgentSessionSummary } from './agent/store.js';
import { AgentSidecarManager, type AgentSidecarSpec } from './agent/sidecar.js';
import { buildAgentTools } from './agent/tools.js';
import { createAgentService, type AgentEvent, type AgentStatus, type AgentViewContext } from './agent/service.js';
import type { AgentConfig, WireToolSpec } from './agent/protocol.js';
import type { AgentResultSet, ResultRefPorts } from './agent/result-set.js';
import { createWorkspaceManager } from './agent/workspace/manager.js';
import { createInlineWorkspaceHost, type WorkspaceHost } from './agent/workspace/host.js';
import type { WorkspaceDbPaths } from './agent/workspace/engine.js';
import { TidalSync } from './sync/tidal.js';
import { TidalHybrid } from './sync/tidal-hybrid.js';
import { TidalApiClient } from '@curator/tidal';
import { config } from './config.js';
import { TidalDownloader, type DownloadProgress, type DownloadProgressFn } from './sync/download-orchestrator.js';
import { DownloadQueue, type DownloadJob, type QueueSummary, type QueueEvent } from './sync/download-queue.js';
export type { WavSettings, WavPreview, WavConvertEvent, WavConvertResult } from './wav/types.js';
export type { WavConverterSpec } from './wav/converter.js';
export type { DownloadProgress } from './sync/download-orchestrator.js';
export type { DownloadJob, QueueSummary, QueueEvent, DownloadErrorKind } from './sync/download-queue.js';

// Fields the Edit-Track modal can hard-clear. Matches the canonical track
// columns. `title`/`artists` are NOT NULL — clearTrackFields drops only the
// override for those; for the rest, both override key and canonical column
// are nulled.
export type ClearableTrackField =
	| 'title' | 'artists' | 'albumTitle' | 'label' | 'genre'
	| 'bpm' | 'keyCamelot' | 'releaseDate';

// Per-track playlist membership row, with the parent folder ancestry resolved
// to actual folder rows. `folderPath` is ordered root-first so the renderer
// can join it with '/' for a breadcrumb display. Empty array → playlist lives
// at the source's root, no folder context to show.
export type TrackPlaylistEntry = {
	playlist: Playlist;
	folderPath: PlaylistFolder[];
};
import { CancelToken } from './sync/cancellation.js';
import { sortColumn as sharedSortColumn, indexSortColumn } from './sync/sort.js';
import { applyOverrides, computePositionalMoves, normalizeIsrc } from '@curator/library-logic';

// A provider's own track id, as the upstream API takes it: Spotify's 22-char
// base62 id, Tidal's numeric id. Anything else on a streaming playlist row
// (a Curator track id projected from another device, null) must never be
// sent upstream. Measured on the live library 2026-10-21: every Spotify row
// is 22-char base62 and every Tidal row numeric, except 13 projected rows.
export function isProviderTrackId(source: 'spotify' | 'tidal', id: string | null | undefined): id is string {
	if (!id) return false;
	return source === 'spotify' ? /^[0-9A-Za-z]{22}$/.test(id) : /^\d{1,20}$/.test(id);
}
import { effectiveTitle, effectiveArtistName } from './sync/curator-view.js';
import { BeatportClient, type FetchLike as BeatportFetch } from '@curator/beatport';
import { AnalyzerSidecar } from './analyzer/sidecar.js';
import { AnalysisQueue, formatAnalyzerTrackName, splitFileless, type AnalysisJobEvent } from './analyzer/queue.js';
import { type AnalysisFlags, type AutoAnalyzeSettings, DEFAULT_AUTO_ANALYZE_SETTINGS, analysisFlagsToOptions } from './analyzer/flags.js';
import { CutoffStore } from './analyzer/cutoffs.js';
import { homedir, hostname } from 'node:os';
import { WavConverter } from './wav/convert-run.js';
import type { WavConverterSpec } from './wav/converter.js';
import type { WavSettings, WavPreview, WavConvertEvent } from './wav/types.js';
import { MembershipClassifier } from './library/membership.js';
import { libraryTrackAttrs } from './library/track-attrs.js';
import { RekordboxSidecar } from './rekordbox/sidecar.js';
import { RekordboxImporter, type RekordboxFlags, type RekordboxImportEvent, type ImportTotals } from './rekordbox/importer.js';
import { RekordboxExporter, type ExportFlags, type ExportResult, type RekordboxExportEvent, rekordboxDirOf } from './rekordbox/exporter.js';
import { planCreateForTracks, planCreatePhase } from './rekordbox/create-phase.js';
import { listOpenConflicts, applyConflictResolutions } from './rekordbox/sync-pipeline.js';
import type { BackupSummary, ClearBackupsResult, CuePaletteEntry } from './rekordbox/sidecar.js';
import { defaultRekordboxDbPath, defaultRekordboxSettingsDir } from './rekordbox/paths.js';
import { createBackupService } from './backup/service.js';
import { createInlineBackupHost } from './backup/host.js';
import { remapLocalPaths } from './backup/apply.js';
import type { BackupEngineConfig, BackupEvent, BackupHost, BackupRestorePreview, BackupRestoreRequest, BackupSettings, BackupSnapshotSummary, BackupStatus, BackupTargetStat, GoogleAuthStatus } from './backup/types.js';
import { createMirLayer } from './mir/layer.js';
import { createCatalogueLayer, type CatalogueLayer } from './catalogue/layer.js';
import { readCatalogueSettings, writeCatalogueSettings, clampKbps } from './catalogue/mirror.js';
import type { CatalogueBackfillAction, CatalogueBlobStore, CatalogueEvent, CatalogueSettingsPatch, CatalogueStatus } from './catalogue/types.js';
import { sqliteLibraryPort } from './mir/library-port.js';
import type { MirSidecarSpec } from './mir/sidecar.js';
import type { MirProvisionSpec } from './mir/provision.js';
import type { MirEvent, MirSettings, MirStatus, SimilarQuery, SimilarResult } from './mir/types.js';
import {
	analysisJob,
	trackAnalysis,
	cue as cueTable,
	type AnalysisJob,
	type TrackAnalysis,
	type Cue,
	type CueKind,
} from '@curator/shared/schema';

export interface CoreServiceOptions {
	// In Electron main, pass `net.fetch.bind(net)`. Without this, Beatport's
	// Cloudflare WAF 403s our requests because Node/undici TLS fingerprints
	// don't look like a browser.
	beatportFetch?: BeatportFetch;
	// Authorizes writes to the user's live streaming account (playlist CRUD,
	// track add/remove/reorder, unfollow). DEFAULT-DENY: when omitted, every
	// remote write throws RemoteWriteDeniedError before any HTTP call. Injected
	// ONLY by the desktop main process — the path where the UI has already taken
	// the user's confirmation. Off-product code (scripts, tests, CLI, the
	// read-only core-sidecar) must leave this unset. See CLAUDE.md "Streaming
	// remote writes".
	remoteWritePolicy?: RemoteWritePolicy;
	// Write-audit sink. Called with one flat entry per external write: every
	// streaming remote-write attempt (allowed AND denied — denials are the
	// suspicious events) and every rekordbox write batch. The desktop main
	// appends these to a JSONL file so the next data-loss forensics session
	// takes minutes instead of hours of backup archaeology. Fire-and-forget:
	// implementations must never throw into the write path.
	writeAudit?: (entry: Record<string, unknown>) => void;
	// Test seam: replace a provider's streaming adapter (the object that talks
	// HTTP to Spotify/Tidal). Injected adapters are still wrapped by the
	// remote-write gate, so a test without `remoteWritePolicy` proves the
	// default-deny floor holds in front of a fake just as it does the real one.
	sourceAdapters?: Partial<Record<StreamingSource, StreamingSourceAdapter>>;
	// Where .cpk peak files live. Resolved by the Electron main process via
	// `app.getPath('userData')`; passed down so the analyzer queue can write
	// peaks alongside the SQLite DB. Created on demand if missing.
	peaksDir?: string;
	// Spawn-spec for the Python analyzer sidecar. When omitted, the analyzer
	// pipeline is disabled — useful for tests + the unit-test core where we
	// don't want to depend on a Python install.
	analyzer?: {
		executable: string;
		args?: string[];
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		// Set when the analyzer is hosted inside WSL on Windows (no published
		// Windows wheel for Essentia). The sidecar wrapper translates file
		// paths to /mnt/<drive>/... on outbound JSON and back on inbound.
		translatePathsToWsl?: boolean;
	};
	// Spawn-spec for the Python rekordbox sidecar. Same shape as `analyzer`.
	// When omitted, rekordbox read methods reject with "rekordbox disabled".
	rekordbox?: {
		executable: string;
		args?: string[];
		cwd?: string;
		env?: NodeJS.ProcessEnv;
	};
	// Spawn-spec for the Node research sidecar (apps/researcher — agent
	// research over the Claude Agent SDK). When omitted, the KB's agent tier
	// is off: similar-artists reads "unavailable", everything else works.
	// The desktop main only passes this when an Anthropic API key is
	// configured (the env must carry ANTHROPIC_API_KEY).
	researcher?: {
		executable: string;
		args?: string[];
		cwd?: string;
		env?: NodeJS.ProcessEnv;
	};
	// Spawn-spec for the Node agent sidecar (apps/agent — the in-app agent's
	// provider-generic harness loop). When omitted, the agent is off: status
	// reads 'disabled', the panel shows an unavailable state. Unlike the
	// researcher, no API key is required at spawn — the sidecar boots
	// unconfigured and is armed via configureAgent (BYOK key over RPC, so
	// rotation never respawns).
	agent?: AgentSidecarSpec;
	// Factory for the agent workspace's execution host. The desktop main
	// injects the utilityProcess-backed host (OS-killable — agent-written SQL
	// must never wedge the main loop; better-sqlite3 has no interrupt). When
	// omitted, the synchronous inline host runs the engine in-process — fine
	// for tests/CLI and the core-sidecar, where core is already off the main
	// loop. Same injection pattern as parseAudio.
	workspaceHost?: (paths: WorkspaceDbPaths) => WorkspaceHost;
	// Out-of-process audio metadata parser. The Electron main process injects
	// a utility-process-backed implementation (see apps/desktop/src/main/
	// ingest/) so the library scanner doesn't run music-metadata's parseFile
	// on the main event loop. When omitted, the scanner falls back to the
	// in-process parseInline — fine for tests and headless CLI usage, where
	// no renderer is competing for the loop.
	parseAudio?: ParseFn;
	// Send a file to the OS trash. Electron main wires `shell.trashItem`;
	// tests/CLI can pass a stub or omit (in which case deleteTracks will
	// skip the trash step and report it via the errors[] surface). Kept
	// out of CoreService's own code path so we don't drag the Electron
	// surface into the headless build.
	trashFile?: (filePath: string) => Promise<void>;
	// Spawn-spec for the audio sidecar binary in its `convert` mode (Convert
	// to WAV). When omitted, conversion is disabled: preview reports
	// available=false and convertPlaylistToWav rejects.
	wavConverter?: WavConverterSpec;
	// Default WAV output folder — the desktop main passes
	// <app.getPath('music')>/WAV so it follows the OS Music known folder
	// (which may live outside the home dir). Fallback: ~/Music/WAV.
	wavDefaultOutputDir?: string;
	// Spawn-spec for the AI audio analysis engine (apps/mir, Python/torch,
	// Windows-native). When omitted, the engine can't compute new vectors or
	// embed text queries, but seed-based similarity still answers from vectors
	// already in mir.db — disabled is a supported state.
	mir?: MirSidecarSpec;
	// Packaged builds: how to create the env `mir.executable` lives in
	// (bundled uv + lockfile -> <userData>/mir/venv). Dev runs apps/mir/.venv.
	mirProvision?: MirProvisionSpec;
	// Structured logger. When omitted, core logs to the console (tests, CLI,
	// headless — same "disabled is a supported state" contract as the
	// sidecars). The desktop main injects its root logger so core records
	// land in the session log file; the core-sidecar entry injects a
	// port-forwarding logger. Swapping the sink is the hosted-mode seam —
	// call sites never change (see apps/core/src/log.ts).
	logger?: Logger;
	// Backup & restore (planning/tech/backup.md). `host` runs the engine —
	// the desktop injects a utilityProcess-backed host so VACUUM INTO,
	// hashing and uploads never touch the main loop; omitted ⇒ inline
	// engine (tests, CLI). Omit `backup` entirely and the feature reports
	// unavailable — disabled is a supported state.
	backup?: {
		userDataDir: string;
		peaksDir?: string;
		coversDir?: string;
		appVersion?: string;
		host?: (cfg: BackupEngineConfig) => BackupHost;
		// Desktop-only pre-run work: renderer settings export + the
		// safeStorage token sidecar (both machine-bound files in userData).
		beforeRun?: () => Promise<void>;
		google?: { status(): GoogleAuthStatus; needsReconnect(): boolean; accessToken(): Promise<string> };
	};
	// Cloud sync of the library op log (cloud plan C). `transport` talks to
	// the Curator cloud API and holds the account session (the desktop main
	// injects an HTTP transport over its Supabase session; tests inject an
	// in-memory server). `subscribeWakeups` delivers "pull now" pings — the
	// Realtime broadcast, window focus, network regain, sign-in. Omit `cloud`
	// and sync is off: getCloudSyncStatus reports disabled, cloudSyncNow
	// resolves without a network call. Disabled is a supported state.
	// Never wire this from scripts or tests against a real account.
	cloud?: {
		transport: CloudTransport;
		subscribeWakeups?: (onWake: (reason?: WakeReason) => void) => () => void;
		// Whether the user is using the app, decided by the host (desktop
		// main: window focus + OS idle time). Started with startCloudSync;
		// `idleAfterMs` is pushed whenever the poll setting changes. Omitted ⇒
		// always "in use" (the active cadence), as in tests and the CLI.
		watchActivity?: (onChange: (active: boolean) => void) => CloudActivityWatcher;
		// Sent with account.registerDevice on first sign-in.
		device?: { name: string; platform: DevicePlatform };
		// The shared analysis catalogue's Storage objects (lo/hi .cpk), moved
		// by the device with its own session. With `transport.catalogue`, this
		// builds the catalogue layer (apps/core/src/catalogue/); without
		// either, there is none and analysis behaves exactly as before.
		blobs?: CatalogueBlobStore;
	};
}

export type CloudActivityWatcher = {
	setIdleAfterMs(ms: number): void;
	stop(): void;
};

// What getCloudSyncStatus answers: the client's status, or `enabled: false`
// (with neutral values) when the build has no cloud transport.
export type CloudSyncStatusReport = CloudSyncStatus & { enabled: boolean };

// The account-level library picture for Settings → Account (protocol v3):
// the master device, how many of the account's tracks this device holds no
// source of (its remote rows: "not on this device"), and whether the server
// reads base metadata at all (a v2 server: no master can be set, nothing is
// shared).
export type AccountLibraryInfo = {
	masterDeviceId: string | null;
	remoteOnlyCount: number;
	metaSyncAvailable: boolean;
};

// What unlinkCloudLibrary did (`outcome` null: sync is off in this build,
// nothing to unlink) and the status after it.
export type CloudUnlinkResult = { outcome: UnlinkOutcome | null; status: CloudSyncStatusReport };

// Outcome union for the sync-to-rekordbox pipeline. 'conflicts' is the
// clean pause: nothing is held in memory (conflicts are sync_conflict
// rows), no sidecar write session is open — the renderer shows the
// resolution UI and resumes via resolveSyncConflicts, or the user walks
// away and the conflicts re-surface on the next sync.
export type RekordboxSyncOutcome =
	| { status: 'completed'; result: ExportResult }
	| { status: 'conflicts'; conflicts: SyncConflict[] };

// Outcome union for the scoped "Sync from Rekordbox" pull. Same clean
// 'conflicts' pause as the push pipeline (both-sides-changed rows are
// persisted sync_conflict rows), but 'completed' carries import totals
// rather than an export result — the pull writes into Curator, not rb.
export type RekordboxPullOutcome =
	| { status: 'completed'; totals: ImportTotals }
	| { status: 'conflicts'; conflicts: SyncConflict[] };

// One orphaned Rekordbox track: linked to rb but its local file is gone.
// Surfaced by findRekordboxMissingFiles for the sync modal's cleanup preview.
export interface RekordboxMissingFile {
	trackId: string;
	rbContentId: string;
	title: string;
	artist: string | null;
	// The path rekordbox_link last recorded for the file — shown so the user
	// can tell an intentional delete from an unmounted-drive false positive.
	filePath: string | null;
}

// One row of Settings → Deleted Tracks (listDeletedTracks).
export interface DeletedTrack {
	trackId: string;
	title: string;
	artist: string | null;
	deletedAt: number;
	// How it got here: a Convert-to-WAV copy, the loser of a recording merge
	// (its curation lives on in the winner), or a delete.
	cause: 'deleted' | 'merged' | 'wav-copy';
	// What the tombstone still holds — the sources it is linked to (the
	// evidence that keeps it deleted) and the curation a restore brings back.
	sources: string[];
	tags: number;
	playlists: number;
}

export interface CoreService {
	// Windowed track read — the single path every list surface uses (playlist,
	// folder, tag view, omnibox / pinned search, all-items). The server owns
	// filter / sort / search; returns one ~1000-row page plus the matching
	// `total` so the renderer sizes its virtual scroll without holding the
	// whole scope. Mirrors getFeedPage; transport-agnostic for the cloud port.
	getTracksPage(filter?: ZTrackFilterT, sort?: ZTrackSortT, req?: ZTrackPageReqT): Promise<TrackPage>;
	// Ordered ids for the entire result set — play-all / build-queue / select-all
	// when the rows aren't all resident. Capped; unbounded bulk mutations use
	// predicate selection (pass the filter) rather than an enumerated id list.
	getTrackIds(filter?: ZTrackFilterT, sort?: ZTrackSortT): Promise<string[]>;
	// By-id / small internal reads only (e.g. repaint one row after its analysis
	// completes). NOT for scope loads — those go through getTracksPage.
	getTracks(filter?: ZTrackFilterT, sort?: ZTrackSortT, limit?: number, offset?: number): Promise<Track[]>;
	getPlaylists(): Promise<Playlist[]>;
	// All playlists a track belongs to, each with its full folder ancestry
	// (root-first, immediate parent last) so the renderer can show breadcrumbs
	// in the track context menu's "Playlists" submenu. Excludes hidden
	// playlists to match sidebar visibility.
	getTrackPlaylists(trackId: string): Promise<TrackPlaylistEntry[]>;
	// Batched membership lookup for a selection. Powers the playlist picker
	// dialog's three-state chips — one IN-query per open, not N. Smart and
	// hidden playlists are dropped from the result so chips don't paint for
	// targets the user can't write to.
	getTrackPlaylistsBatch(trackIds: string[]): Promise<Record<string, string[]>>;
	// Every non-hidden, non-smart playlist with its folder ancestry. The
	// playlist picker uses this to render the full filterable list of
	// add/remove targets without round-tripping per-row.
	getPlaylistsWithFolders(): Promise<TrackPlaylistEntry[]>;
	// Bulk-add tracks to a playlist. Skips tracks already in the playlist
	// so the call is idempotent for the "add to all selected" gesture.
	// Smart playlists reject the write (derived membership only). Returns
	// the actual count inserted so the UI can toast accurately, the ids it
	// could NOT add (streaming playlist, track has no provider link — those
	// rows are not inserted locally either), and whether the streaming
	// push happened. Callers must surface a non-'pushed'/'none' outcome:
	// the local row exists but the provider doesn't have it.
	addTracksToPlaylist(playlistId: string, trackIds: string[]): Promise<{ added: number; skipped: number; noUpstreamTrackIds: string[]; upstream: UpstreamPushOutcome }>;
	// Bulk-remove tracks from a playlist. Removes every row matching
	// (playlistId, trackId) — handles the duplicate-position case where a
	// single trackId appears in the playlist at multiple positions. Returns
	// the row count removed. Smart playlists reject the write.
	//
	// `forceUpstream` forces the upstream push for streaming sources even
	// when the user has writeSyncAuto disabled. Reserved for destructive
	// flows (deleteTracks) where the user has explicitly chosen total
	// removal — without it, the curator-side prune succeeds but the next
	// auto-read tick pulls the track back from the provider, defeating the
	// delete. Default false: ordinary picker-driven removes keep
	// respecting the user's per-source auto-write preference.
	removeTracksFromPlaylist(playlistId: string, trackIds: string[], opts?: { forceUpstream?: boolean }): Promise<{ removed: number; upstream: UpstreamPushOutcome }>;
	// For each playlistId, return the track ids in it whose local file
	// pointer is dead — i.e. there is a source_link with source='local'
	// whose filePath no longer exists on disk. Tracks without any local
	// source_link are NOT included (those are streaming-only and not
	// "deleted files" in the user-visible sense). Used by the rekordbox
	// playlist/folder "Remove deleted files" action: caller diffs the
	// result, confirms with the user, then calls
	// removeTracksFromPlaylist per playlist.
	findTracksWithDeletedFiles(playlistIds: string[]): Promise<Array<{ playlistId: string; trackIds: string[] }>>;
	setPlaylistFavorite(playlistId: string, isFavorite: boolean): Promise<void>;
	// Rename a playlist. Updates Curator's local row immediately; for
	// source='spotify' also PUTs to /playlists/{id} so the rename
	// reflects on Spotify. For source='rekordbox' the rename is local
	// only — user runs the Sync to Rekordbox flow to push the change
	// (the playlist scope in that flow writes DjmdPlaylist.Name).
	// Returns `pushedToSource: true` iff the upstream push completed.
	renamePlaylist(playlistId: string, newName: string): Promise<{ pushedToSource: boolean }>;
	// Rename a rekordbox playlist FOLDER. Local write only; the new name is
	// pushed to rekordbox on the next "Sync to Rekordbox" for that folder (the
	// exporter emits a name op the Python writer applies to the folder's
	// DjmdPlaylist row — the importer would otherwise clobber a local-only
	// rename on the next read). Library (on-disk) folders aren't renamable here.
	renamePlaylistFolder(folderId: string, newName: string): Promise<void>;
	// Reorder a playlist's tracks. `newOrder` is an array of the rows' CURRENT
	// positions in the playlist, listed in the desired new order. Position is
	// unique within a playlist ((playlistId, position) is a unique index), so
	// it disambiguates duplicates that `trackId` alone can't. Atomic: only the
	// displaced rows get new order keys, then positions are restamped 0..N-1
	// in the new order, which callers read back on their next fetch.
	reorderPlaylistTracks(playlistId: string, newOrder: number[]): Promise<void>;
	// Per-source sync settings. Core owns the canonical store (app_setting
	// table — origin-independent, shared by dev + packaged renderers; see
	// schema.ts). The renderer reads them at boot, then calls set after
	// every user toggle (and once at boot to start the scheduler's timers
	// after the window is up) so the scheduler can restart its timers and
	// the write router can gate on the latest writeSyncAuto value.
	getSourceSyncSettings(): Promise<Record<StreamingSource, SourceSyncSettings>>;
	setSourceSyncSettings(source: StreamingSource, settings: SourceSyncSettings): Promise<void>;
	// Credit display format (artist separator, remix title style). Lives in
	// core's app_setting — like the sync settings — because the rekordbox
	// push and the pull-side merge format Title/Artist with it; a
	// renderer-local copy would drift between the dev and packaged origins.
	// The renderer hydrates its UI setting from here at boot and pushes
	// changes back.
	// `stored` is false until a renderer has ever pushed a value — the
	// renderer then seeds core from its own setting instead of adopting
	// core's defaults (which would silently reset the user's choice).
	getCreditFormat(): Promise<{ format: ArtistCreditFormat; stored: boolean }>;
	setCreditFormat(fmt: ArtistCreditFormat): Promise<void>;
	// ─── Convert to WAV (see wav/convert-run.ts) ──────────────────────────
	// Output folder for converted WAVs (app_setting 'wav.output_dir').
	getWavSettings(): Promise<WavSettings>;
	setWavSettings(settings: { outputDir: string }): Promise<WavSettings>;
	// Dry run for the confirm dialog: per-member plan counts, size estimate,
	// free space, and the derived playlist's name.
	previewPlaylistWavConversion(playlistId: string): Promise<WavPreview>;
	// Starts a background run; progress + result arrive on
	// subscribeWavConvertEvents. Rejects when a run is in flight or the
	// converter isn't configured.
	convertPlaylistToWav(playlistId: string): Promise<{ runId: string }>;
	cancelWavConversion(runId: string): Promise<void>;
	subscribeWavConvertEvents(cb: (e: WavConvertEvent) => void): () => void;
	// Local-vs-remote membership diff for a streaming playlist (one read
	// of the provider's playlist). Rejects non-streaming playlists and the
	// Liked Songs pseudo-playlist.
	getPlaylistUpstreamDrift(playlistId: string): Promise<PlaylistUpstreamDrift>;
	// Replay local-only rows to the provider (the repair for adds made while
	// writeSyncAuto was off, or whose push failed). Optional `sourceTrackIds`
	// narrows to a subset of the drift's localOnly rows. Explicit, user-
	// confirmed action: NOT gated on writeSyncAuto (like deleteTracks'
	// forceUpstream), still gated on playlist ownership + the remote-write
	// policy. Returns how many ids were sent.
	pushPlaylistLocalOnly(playlistId: string, sourceTrackIds?: string[]): Promise<{ pushed: number; snapshotId: string | null }>;

	// ─── Pinned searches ─────────────────────────────────────────────────────
	// A pinned search persists an omnibar/drill query (the JIT grammar string)
	// for quick re-access — not its tracks. The renderer re-runs the query
	// through its JIT scope path on activation, so a pin always reflects the
	// live library. `sort` (captured at pin time) restores the user's ordering.
	getPinnedSearches(): Promise<PinnedSearch[]>;
	// Create a pin at the tail of the Pinned folder. Returns the created row
	// (with its generated id + position) so the renderer can select it.
	createPinnedSearch(input: {
		name: string;
		query: string;
		sort?: { column: string; dir: 'asc' | 'desc' } | null;
	}): Promise<PinnedSearch>;
	// Rename a pin. Returns the updated row.
	renamePinnedSearch(id: string, newName: string): Promise<PinnedSearch>;
	// Delete a pin (the "Unpin" action). Idempotent — no-op if already gone.
	deletePinnedSearch(id: string): Promise<void>;
	// Materialize a set of tracks (in the given order) into a new local
	// playlist — Curator's own editable playlist, source='local'. Used by the
	// pinned-search "Create Playlist…" flow: the snapshot is a one-shot copy,
	// not a live link to the query. Returns the created playlist row.
	createLocalPlaylistFromTracks(name: string, trackIds: string[]): Promise<Playlist>;
	// Create a playlist directly on a streaming account (Spotify only today —
	// the only source with a write adapter) and mirror it locally in the
	// sync's row shape, so the next read sync updates the same row instead of
	// minting a duplicate. Tracks without a source_link for that provider are
	// skipped (nothing to push). Remote calls route through the remote-write
	// gate — default-deny without a policy.
	createStreamingPlaylist(source: StreamingSource, name: string, trackIds: string[]): Promise<{ playlist: Playlist; added: number; skipped: number }>;
	getStateCounts(): Promise<ZStateCountsT>;
	getSourceCounts(): Promise<{ spotify: number; tidal: number; local: number }>;
	getSyncStatus(): Promise<{
		spotify: { connected: boolean; lastSync: Date | null };
		tidal: { connected: boolean; lastSync: Date | null };
	}>;
	auth: AuthService;
	runSpotifySync(progress?: ProgressFn, opts?: { deleteRemoved?: boolean; force?: boolean }): Promise<{ playlists: number; tracksUpserted: number; removed: number }>;
	planSpotifySync(): Promise<{ toAdd: number; toUpdate: number; toRemove: { id: string; sourceId: string; name: string }[] }>;
	runSpotifyPlaylistSync(playlistId: string, progress?: ProgressFn, opts?: { force?: boolean }): Promise<{ tracksUpserted: number; tracksEnriched: number; skipped: boolean }>;
	runTidalSync(progress?: ProgressFn, opts?: { force?: boolean }): Promise<{ playlists: number; tracksUpserted: number }>;
	runTidalPlaylistSync(playlistId: string, progress?: ProgressFn, opts?: { force?: boolean }): Promise<{ tracksUpserted: number; skipped: boolean }>;
	enrichBeatportPlaylist(playlistId: string, progress?: ProgressFn, sort?: { column: ZTrackSortT['column']; dir: 'asc' | 'desc' }): Promise<{ enriched: number; scanned: number }>;
	enrichBeatportTrack(trackId: string, progress?: ProgressFn): Promise<{ enriched: number; scanned: number }>;
	enrichBeatportTracks(trackIds: string[], progress?: ProgressFn): Promise<{ enriched: number; scanned: number }>;
	matchTidalForTracks(trackIds: string[], progress?: ProgressFn): Promise<{ matched: number; scanned: number }>;
	// The row's own links, then — `derived: true` — the provider ids it
	// knows only from the account's claims (sync-log/claim-links.ts) for
	// providers it has no own link for. Display and Open-in only: nothing
	// that pushes upstream reads this.
	getTrackSourceLinks(trackId: string): Promise<{ source: string; sourceTrackId: string; url: string | null; derived?: boolean }[]>;
	setTrackOverrides(trackId: string, patch: Partial<Record<keyof TrackOverrides, TrackOverrides[keyof TrackOverrides] | null>>): Promise<Track | null>;
	// `errors[]` is in-band (the call resolves) so a partial success still
	// reports per provider. `code: 'already-linked'` + `conflictTrackId`
	// identify the identity-guard case — the provider id is bound to another
	// live track — which the Edit modal turns into a merge offer.
	setTrackSourceLinks(trackId: string, urls: { spotify?: string | null; tidal?: string | null; beatport?: string | null }): Promise<SetSourceLinksResult>;
	deleteTrackSourceLink(trackId: string, source: 'spotify' | 'tidal' | 'beatport'): Promise<void>;
	// Merge two library rows into one (library/merge-tracks.ts). Preview is a
	// read-only dry run for BOTH directions plus the per-side summary the
	// dialog shows; `suggestedKeepId` is the more-curated side (`aId` on a
	// tie — pass the track the user is editing as `aId`). mergeTracks applies
	// one direction in a transaction, moves the peaks sidecars, re-points the
	// feed's promoted_track_id and returns the decorated survivor. Blocked
	// merges (both rekordbox-linked, a deleted side) throw
	// TrackMergeBlockedError before any write.
	previewTrackMerge(aId: string, bId: string): Promise<TrackMergePreview>;
	mergeTracks(keepId: string, dropId: string): Promise<TrackMergeOutcome>;
	// Hard-clear one or more fields: drops both the override key AND the
	// canonical column value (for nullable fields). Used by the Edit Track
	// modal's per-field × button — distinct from setTrackOverrides({k:null})
	// which only removes the override and lets canonical shine through.
	// `title` and `artists` are NOT NULL in the schema; for those, only the
	// override is removed.
	clearTrackFields(trackId: string, fields: ClearableTrackField[]): Promise<Track | null>;
	// Distinct non-empty canonical genre and label values across the library
	// (deleted tracks excluded), each sorted case-insensitively — populates the
	// Edit Track modal's genre/label autocomplete. Reads the canonical columns
	// (the library's vocabulary from streaming/Beatport/rekordbox); purely
	// user-typed override values aren't aggregated here.
	getLibraryFieldOptions(): Promise<{ genres: string[]; labels: string[] }>;
	// Bulk-set the rating column on N tracks. Rating is a canonical column
	// (not an override) since Rekordbox sync writes through to the same place;
	// passing rating=null clears. Returns the updated rows so the renderer can
	// patch its cache without a full refetch.
	setRating(trackIds: string[], rating: number | null): Promise<Track[]>;
	// Delete tracks from the library. SOFT by default (the tracklist's Delete
	// action); `hard: true` is the full cascade burn (feed un-promotion). For
	// each trackId:
	//   1. Sends every local file (source_link with source='local') to
	//      the OS trash via opts.trashFile.
	//   2. Removes the track from the user's OWN playlists via
	//      removeTracksFromPlaylist (streaming playlists push upstream when
	//      writeSyncAuto is enabled; rekordbox is curator-side until the user
	//      runs Sync to Rekordbox). FOLLOWED playlists (ones the user can't
	//      modify) keep the membership on a soft delete, so the track still
	//      shows there flagged with a "deleted" chip. A hard delete removes
	//      from every playlist (the cascade does it anyway).
	//   3. Unlinks the track's analyzer-generated .cpk peaks (lo + hi)
	//      and the rb_<contentId>.cpk variant when a rekordbox_link
	//      row exists; tombstones rekordbox content so a later rb re-add
	//      resolves to "remove from rekordbox" rather than resurrecting it.
	//   4a. SOFT: drops the now-dead local source_link and stamps
	//       track.deletedAt — the row, its streaming source_links, and its
	//       followed-playlist memberships survive (see getTracksImpl + the
	//       feed's deleted-keys probe for where the chip is painted).
	//   4b. HARD: DELETEs the canonical track row. Cascade drops source_link,
	//       playlist_track, trackTag, cue, trackAnalysis, analysisJob, and
	//       rekordboxLink. download_job rows (no FK) survive — known v1
	//       limitation; user can clear the downloads queue if needed.
	// Best-effort throughout: trash / unlink / playlist push errors are
	// collected into `errors[]` rather than aborting, so a single broken
	// file doesn't strand a 100-track selection halfway through.
	deleteTracks(trackIds: string[], opts?: { hard?: boolean }): Promise<{
		deletedTracks: number;
		filesTrashed: number;
		peaksRemoved: number;
		playlistsTouched: number;
		errors: { kind: 'file' | 'peaks' | 'playlist'; message: string }[];
	}>;
	// Per-source removal — the Delete dialog's checkboxes. For each track,
	// each requested source it actually has is stripped:
	//   local     → file(s) to the OS trash, local source_link dropped.
	//   spotify / tidal → removed from every playlist the user OWNS on that
	//               source (pushed upstream regardless of writeSyncAuto —
	//               the user just confirmed a destructive dialog), link
	//               dropped. Followed playlists keep the membership.
	//   rekordbox → removed from rekordbox playlists (curator-side; pushed on
	//               Sync to Rekordbox), rekordbox_deleted_content tombstone,
	//               rb_<contentId>.cpk peaks unlinked, rekordbox_link dropped.
	// Tombstone rule: let D(t) be the removable sources the track has before
	// the call. The row is soft-deleted (deletedAt) iff D(t) ⊆ requested —
	// every source it had is being removed. A metadata-only row (D = ∅)
	// tombstones on any request. A tombstoned row keeps its streaming links:
	// they're what identifies it as "deleted" in a followed playlist / feed
	// album (the deleted chip) and what stops the read-sync re-minting it.
	// deleteTracks' soft path is exactly removeTrackSources(ids, ALL).
	removeTrackSources(trackIds: string[], sources: RemovableTrackSource[]): Promise<RemoveTrackSourcesResult>;
	// Undo a soft delete. The rows come back with what a soft delete keeps
	// (tags, cues, rating, history, streaming links) plus any local file the
	// scanner bound to them while they were deleted (scanner.ts: a deleted
	// track's audio is held for it, never minted into a fresh row). A
	// library_track undelete op carries it to every device. Not restored:
	// playlist memberships, trashed files, the rekordbox link. Returns the
	// ids that were deleted and now are not.
	undeleteTracks(trackIds: string[]): Promise<{ restored: string[] }>;
	// Settings → Deleted Tracks: every soft-deleted row not yet purged, newest
	// delete first. The one surface that lists tombstones on purpose.
	listDeletedTracks(): Promise<DeletedTrack[]>;
	// "Delete permanently": strips the tombstones' tags and cues (synced) and
	// takes them off the list. The rows stay as identity evidence so the
	// track stays deleted — see mutators.ts purgeDeletedTracks. Live or
	// already-purged ids are ignored. Returns the ids purged.
	purgeDeletedTracks(trackIds: string[]): Promise<{ purged: string[] }>;
	matchTidalForTrack(trackId: string): Promise<{ tidalId: string } | null>;
	setPlaylistHybridTidal(playlistId: string, enabled: boolean, progress?: ProgressFn, sort?: { column: ZTrackSortT['column']; dir: 'asc' | 'desc' }): Promise<{ matched: number; scanned: number; enabled: boolean }>;
	cancelEnrichment(): Promise<void>;
	getTrackCoverUrl(trackId: string): Promise<string | null>;
	// Embedded album-art extraction for tracks backed by a local file. Returns
	// the raw image bytes + mime type or null if the file has no APIC/cover
	// frame. Used by the curator-cover:// protocol as a fallback when no
	// remote URL is registered (i.e. Rekordbox or scanner-only tracks).
	extractLocalCover(trackId: string): Promise<{ data: Uint8Array; format: string } | null>;
	// Resolve the on-disk path of a track's peaks file for the given tier.
	// Returns null when no peaks have been generated for that trackId yet.
	// Lookup order: analyzer-generated file at <peaksDir>/<tier>/<trackId>.cpk
	// (Essentia worker), then the rekordbox-imported file at
	// <peaksDir>/<tier>/rb_<rbContentId>.cpk via the rekordbox_link table.
	resolveTrackPeaksPath(trackId: string, tier: 'lo' | 'hi'): Promise<string | null>;
	hasTidalDownloadSession(): Promise<boolean>;
	downloadTidalTrack(trackId: string, progress?: DownloadProgressFn): Promise<{ outputPath: string; bytes: number }>;
	enqueueTidalDownloads(items: { trackId: string; trackTitle: string; artistName: string }[]): Promise<void>;
	retryTidalDownload(trackId: string): Promise<void>;
	getDownloadQueue(): Promise<DownloadJob[]>;
	getDownloadSummary(): Promise<QueueSummary>;
	clearCompletedDownloads(): Promise<void>;
	clearAllDownloads(): Promise<void>;
	redownloadTidalTrack(trackId: string): Promise<void>;
	verifyDownloads(): Promise<{ total: number; ok: number; missing: number; corrupt: number; sizeMismatch: number; neverDownloaded: number; inProgress: number; problems: string[] }>;
	getDownloadDir(): Promise<string>;
	subscribeDownloadQueue(cb: (evt: QueueEvent) => void): () => void;
	// ─── Tags (Interested / Basket / future user tags) ──────────────────────
	getTags(): Promise<Tag[]>;
	getTagCounts(): Promise<Record<string, number>>;
	// ─── Artists — library artist entities (derived from track.artists by
	// library/artists.ts; see the ARTIST comment in schema.ts) ─────────────
	// Live artists (aliases excluded) with live-track counts; artists whose
	// only tracks are soft-deleted are omitted. `search` is fold-matched.
	listArtists(opts?: ArtistListOpts): Promise<ArtistSummary[]>;
	getArtist(id: string): Promise<ArtistSummary | null>;
	// Fold lookup that follows aliases — the Discover "Show in library" path.
	resolveArtistByName(name: string): Promise<ArtistSummary | null>;
	// Rename across the library: every track credit that resolves to this
	// artist is rewritten (JSON + junction), the spelling becomes curated
	// (sticky against re-sync), and a fold-changing rename leaves an alias
	// under the old fold. Renaming onto an existing artist's fold merges.
	renameArtist(id: string, newName: string): Promise<{ artist: ArtistSummary; tracksRewritten: number }>;
	// Provider identities for an artist (Spotify/Tidal ids gathered from the
	// synced track payloads) — the artist scope header's link row.
	getArtistLinks(id: string): Promise<ArtistLink[]>;
	// ─── Albums — library release entities (derived by library/albums.ts;
	// see the ALBUM comment in schema.ts) ──────────────────────────────────
	// Summaries for the track list's album group headers, one per requested
	// id (merge aliases answer with their survivor's data under the asked
	// id). Unknown ids are skipped. Member stats count live tracks only.
	getAlbumsByIds(ids: string[]): Promise<AlbumSummary[]>;
	// Pairs identity can't decide: a bare name beside the same name with a
	// bracketed disambiguator ("Maz" / "Maz (EG)"). Live artists only;
	// dismissed pairs are remembered in app_setting and never resurface;
	// merging one removes it naturally (the dropped row becomes an alias).
	// `scope` narrows the counts (and drops pairs with no track in scope) to
	// the tab the user is looking at, so the review reads like the sidebar.
	listArtistMergeSuggestions(scope?: ArtistScope): Promise<ArtistMergeSuggestion[]>;
	dismissArtistMergeSuggestion(aId: string, bId: string): Promise<void>;
	// Merge `dropId` into `keepId`: drop becomes an alias, its credits are
	// rewritten to keep's spelling. Unmerge is deferred.
	mergeArtists(keepId: string, dropId: string): Promise<{ artist: ArtistSummary; tracksRewritten: number }>;
	// Create a new user-kind tag. Local-only: no Rekordbox MyTag id yet — it
	// materializes upstream on the next Sync to Rekordbox, the same
	// local-then-push shape as a renamed folder. Name is trimmed; empty is
	// rejected. Returns the created row so the caller can immediately apply it.
	createTag(name: string, color?: string | null): Promise<Tag>;
	getTrackTags(trackId: string): Promise<string[]>;
	// Batched variant used by the track list + omnibar. One IN-query for
	// the whole page; preserves the "no per-row IPC" invariant the track
	// list relies on for snappy renders over tens of thousands of tracks.
	getTrackTagsBatch(trackIds: string[]): Promise<Record<string, string[]>>;
	addTrackTag(trackId: string, tagId: string): Promise<void>;
	removeTrackTag(trackId: string, tagId: string): Promise<void>;
	// Bulk-tag with a "skip if a local source already exists" guard — the
	// canonical "Add to Basket" semantic from the workflow brief. Returns
	// counts so the renderer can show a "applied to X, skipped Y" toast.
	addTrackTagSkippingLocal(trackIds: string[], tagId: string): Promise<{ added: number; skipped: number }>;
	// Recommend tags for a selection. Returns up to ~8 user-kind tag ids
	// scored by co-occurrence with the selection's existing tags. When the
	// selection carries no tags yet, falls back to the most-popular user
	// tags so the recommended row in the picker is never empty for a
	// library that has any tagging activity at all.
	// Recommend tags AND playlists for a selection — the Organize modal's
	// Recommended row. Market-basket affinity: candidates scored by how many of
	// their member tracks look like the selection (shared tag/playlist, artist,
	// genre, label; plus a modest brightness/power model nudge). Excludes
	// targets already on the selection; source-balanced so both kinds surface.
	recommendForSelection(trackIds: string[]): Promise<ScoredRecommendation[]>;

	// ─── Local library ──────────────────────────────────────────────────────
	getLibraryFolders(): Promise<LibraryFolder[]>;
	// Sets of present local files that carry the same audio (same
	// source_link.audio_hash), largest group first. The scanner mints a
	// separate row for a byte-identical copy rather than binding two files to
	// one track (rekordbox holds one content per track), so this is where
	// those copies become visible. WAV copies made by Convert to WAV share
	// their original's hash by design and are left out.
	getDuplicateAudioGroups(): Promise<Array<{ audioHash: string; tracks: Array<{ trackId: string; title: string; filePath: string }> }>>;
	// Add a folder to watch. Throws when the path is inside a known cloud-sync
	// root (OneDrive/Dropbox/Google Drive/iCloud) — caller must pass
	// `allowCloudSync: true` to override.
	addLibraryFolder(path: string, opts?: { allowCloudSync?: boolean }): Promise<LibraryFolder>;
	removeLibraryFolder(folderId: string): Promise<void>;
	// Sweep every source_link with source='local' and a filePath that no
	// longer exists on disk; with `dryRun: true` only counts them, with
	// dryRun=false also DELETEs those rows — including links the watcher
	// flagged missing_at, which would otherwise wait up to 30 days as
	// re-bind hints (scanner.ts). Canonical track rows are left alone —
	// streaming sourceLinks (Spotify/Tidal) on the same track survive, and
	// a re-add of the file later re-matches into the same track. Used by
	// the Library settings "Remove deleted files" button to cover files
	// removed while the watcher was offline.
	pruneDeletedLocalFiles(opts?: { dryRun?: boolean }): Promise<{ scanned: number; missing: number; removed: number }>;
	// Resolve a local file by its on-disk path. Used by curator-local:// to
	// verify a requested URL points at a file we've ingested.
	resolveLocalFile(filePath: string): Promise<{ path: string; size: number | null; format: string | null } | null>;
	// Resolve a track's local file (if any) — used by "Open File Location"
	// and the local-playback backend.
	getLocalFileForTrack(trackId: string): Promise<{ path: string; size: number | null; format: string | null } | null>;
	subscribeLibraryScan(cb: ScanProgressFn): () => void;
	// Start watching every folder marked watching=true in the DB. Called by
	// the desktop main process after the renderer has finished loading, so
	// the scan's sync DB pressure doesn't block the renderer's bootstrap IPC.
	startLibraryWatching(): Promise<void>;
	// Spawn the analyzer sidecar. Called by the desktop main after the window
	// has finished loading: on Windows the spawn goes through wsl.exe, and a
	// cold WSL boot brings up a Hyper-V network adapter whose arrival makes
	// Chromium abort in-flight renderer loads (ERR_NETWORK_CHANGED). Analysis
	// enqueued before this waits; idempotent; no-op when the analyzer is off.
	startAnalyzer(): void;
	// Full recompute of track.membership. Called after a Spotify connect /
	// disconnect / account switch — that flips the my-vs-followed split for
	// every track, so the whole table must be reclassified.
	recomputeMembership(): void;

	// ─── Analyzer (offline music analysis) ───────────────────────────────────
	// `analyzeOptions` — per-call analyzer tuning forwarded to the sidecar
	// at dispatch time. Used by the Analyze window to opt-in to advanced
	// feature computation (MusicExtractor is skipped by default; passing
	// `analyzeOptions.features = [...]` re-enables it for the selected tracks).
	// `analyzeFlags` — the unified AnalysisFlags selection (Analyze modal /
	// auto-analyze settings). Core converts it to the sidecar's AnalyzeOptions
	// at the boundary so the renderer never has to know the wire shape.
	enqueueAnalysis(trackIds: string[], opts?: { priority?: number; force?: boolean; analyzeFlags?: AnalysisFlags }): Promise<void>;
	// Configure the scanner-driven onIngest auto-enqueue path. Default
	// `enabled: false` — analyzer work only happens on explicit user
	// action (Analyze modal, rb grid sync) until the user flips this on
	// in Settings → Library. The sub-flags inside the settings object
	// gate which analyzer stages run on each newly-ingested track. The
	// renderer pushes the full settings object from localStorage on boot
	// and on every change.
	setAutoAnalyzeSettings(settings: AutoAnalyzeSettings): Promise<void>;
	cancelAnalysis(trackId: string): Promise<void>;
	getAnalysisJob(trackId: string): Promise<AnalysisJob | null>;
	getTrackAnalysis(trackId: string): Promise<TrackAnalysis | null>;
	getTrackCues(trackId: string): Promise<Cue[]>;
	// Create or replace the cue at (trackId, slot, kind). Slot is namespaced
	// per `kind`: 'hot' covers the 16 hot-cue pads (slot 0..15); 'memory'
	// is reserved for time-ordered ordinals (slot >= 100, written by the
	// rekordbox importer). The UI's pad clicks always create kind='hot'.
	// `lengthSec` > 0 stores a loop region; null/0 stores a point cue.
	upsertCue(input: {
		trackId: string;
		slot: number;
		kind: CueKind;
		positionSec: number;
		lengthSec: number | null;
		color: string | null;
		name: string | null;
	}): Promise<Cue>;
	// Patch a cue's name / color / region in place. Identified by id so the
	// renderer doesn't need to re-resolve the row after a sibling write.
	updateCue(cueId: string, patch: {
		name?: string | null;
		color?: string | null;
		positionSec?: number;
		lengthSec?: number | null;
	}): Promise<Cue>;
	deleteCue(cueId: string): Promise<void>;
	// Snapshot of the analyzer queue for renderer backfill — the event stream
	// only sees transitions from this point forward, so on first wire / HMR
	// reload the renderer queries this once to populate "currently running"
	// and queue depth.
	getAnalysisStatus(): Promise<{ running: { trackId: string; name: string }[]; queued: number }>;
	subscribeAnalysisEvents(cb: (e: AnalysisJobEvent) => void): () => void;

	// ─── Rekordbox adapter (read-only v1) ────────────────────────────────────
	detectRekordbox(): Promise<{ dbPath: string | null; running: boolean }>;
	runRekordboxImport(opts: { mode: 'incremental' | 'full'; flags: RekordboxFlags; key?: string; dbPathOverride?: string; overwriteCurator?: boolean }): Promise<ImportTotals>;
	cancelRekordboxImport(): Promise<void>;
	subscribeRekordboxEvents(cb: (e: RekordboxImportEvent) => void): () => void;
	// Returns the imported Rekordbox playlist/folder hierarchy for sidebar
	// rendering. Folders + playlists are returned as flat arrays; the
	// renderer reassembles them into a tree via parentFolderId. Hidden
	// playlists are excluded just like getPlaylists().
	getRekordboxTree(): Promise<{ folders: PlaylistFolder[]; playlists: Playlist[] }>;
	// Read-only detection of "orphaned" Rekordbox tracks: rows that carry a
	// rekordbox_link but whose local file is gone — no source='local'
	// source_link AND the link's rb_file_path no longer exists on disk. These
	// show in the Rekordbox tab (the tab is a rekordbox_link join) even though
	// Curator can't play them. Powers the Sync-to-Rekordbox modal's
	// missing-file cleanup preview. Cheap: one link scan + one existsSync per
	// candidate (the no-local-link filter keeps the candidate set small).
	findRekordboxMissingFiles(): Promise<RekordboxMissingFile[]>;
	// Turn a set of missing-file orphans into Curator deletes that propagate to
	// rekordbox: tombstone each (rekordbox_deleted_content, pushed_at NULL so
	// the next Sync-to-Rekordbox emits a content_delete), drop the
	// rekordbox_link (removes it from the tab immediately), soft-delete the
	// track (deletedAt), and unlink its rb peaks. Deliberately does NOT touch
	// streaming: no upstream Spotify/Tidal playlist writes (unlike deleteTracks)
	// — a missing local file is no reason to mutate the user's live streaming
	// account. trackIds are filtered to genuine orphans server-side, so a stale
	// id from the renderer can't delete a track whose file is actually present.
	// Returns the count actually removed.
	removeRekordboxMissingFiles(trackIds: string[]): Promise<{ removed: number }>;

	// ─── Sync FROM rekordbox (scoped pull) ───────────────────────────────────
	// Mirror of syncToRekordbox in the pull direction: re-read a SPECIFIC set
	// of tracks / a playlist / a folder from rekordbox and merge into Curator
	// (last-modified-wins; both-sides-changed rows surface as conflicts). The
	// scan is scoped to the selection only — not a whole-library incremental —
	// and the library-wide USN watermarks are left untouched. targetKind
	// 'tracks' takes curator track.id[] (resolved to rb content ids via
	// rekordbox_link); 'playlist' takes a single curator rb-playlist id;
	// 'folder' takes a single curator rb-folder id (expanded to every
	// non-smart non-hidden descendant playlist). 'conflicts' is the same clean
	// pause as the push pipeline; the renderer resolves via
	// resolveRekordboxPullConflicts (writes the chosen side into Curator; no
	// push). syncMyTags is intentionally unavailable — the per-tag membership
	// model can't be safely scoped to a track subset.
	syncFromRekordbox(opts: {
		targetKind: 'tracks' | 'playlist' | 'folder';
		targetIds: string[];
		flags: RekordboxFlags;
		key?: string;
		dbPathOverride?: string;
	}): Promise<RekordboxPullOutcome>;
	// Apply the user's decisions from a syncFromRekordbox conflict pause.
	// 'theirs' writes rb's value into Curator; 'ours' keeps Curator's and
	// converges the baseline so it won't re-detect. No push — this is the
	// pull direction. Stale conflict ids no-op.
	resolveRekordboxPullConflicts(opts: {
		resolutions: Array<{ conflictId: string; choice: SyncConflictChoice }>;
	}): Promise<{ applied: number; skipped: number }>;

	// ─── Rekordbox WRITE-side (sync TO rekordbox) ────────────────────────────
	// Targets: targetKind='tracks' takes curator track.id[] — length 1 for a
	// single-row context-menu, N for multi-select. 'playlist' takes a single-
	// element array of curator playlist.id (must be source='rekordbox' to
	// have an rb-side identity). 'folder' takes a single-element array of
	// curator playlist_folder.id (source='rekordbox') and pushes every
	// non-smart non-hidden descendant playlist in one batched backup +
	// verify pass. dbPathOverride mirrors the read side — falls back to the
	// OS-default location when null.
	// Runs the full zero-override pipeline: incremental PULL from rb
	// (metadata + cues, three-way merged against the per-link baselines) →
	// pause if any both-sides-changed conflicts are open (status:
	// 'conflicts'; the renderer collects decisions and calls
	// resolveSyncConflicts) → otherwise PUSH (status: 'completed').
	//
	// What a Sync to Rekordbox of `playlistId` would CREATE in rekordbox
	// (Convert-to-WAV playlists only — see rekordbox/create-phase.ts). Null
	// when it would create nothing. Read-only; for the sync modal's notice.
	previewRekordboxCreate(playlistId: string): Promise<{ tracks: number; withAnalysis: number; playlist: boolean; unplayable: number } | null>;
	// Same for "Add to Rekordbox" on a track selection (syncToRekordbox with
	// targetKind 'tracks' + flags.createMissing).
	previewRekordboxCreateTracks(trackIds: string[]): Promise<{ tracks: number; withAnalysis: number; playlist: boolean; unplayable: number } | null>;
	syncToRekordbox(opts: {
		// 'updates' is the incremental sweep — resolves to every rb-linked
		// track changed since the last sync, plus every non-smart non-hidden
		// rb playlist. Triggered from the Rekordbox source-tab right-click;
		// other kinds map to per-track / per-playlist / per-folder context
		// menus.
		targetKind: 'tracks' | 'playlist' | 'folder' | 'updates';
		targetIds: string[];
		flags: ExportFlags;
		key?: string;
		dbPathOverride?: string;
	}): Promise<RekordboxSyncOutcome>;
	// Resume after the conflict pause: apply the user's per-conflict
	// decisions ('ours' keeps Curator's value and pushes it; 'theirs'
	// adopts the app-side value into Curator), then run the push phase
	// with the original target + flags. Stale conflict ids no-op.
	resolveSyncConflicts(opts: {
		provider: DjSyncProvider;
		resolutions: Array<{ conflictId: string; choice: SyncConflictChoice }>;
		targetKind: 'tracks' | 'playlist' | 'folder' | 'updates';
		targetIds: string[];
		flags: ExportFlags;
		key?: string;
		dbPathOverride?: string;
	}): Promise<ExportResult>;
	subscribeRekordboxExportEvents(cb: (e: RekordboxExportEvent) => void): () => void;
	listRekordboxBackups(dbPathOverride?: string): Promise<BackupSummary[]>;
	clearRekordboxBackups(dbPathOverride?: string): Promise<ClearBackupsResult>;
	// Restore is callable only from the verify-failed modal — the renderer
	// presents the choice; we trust the path it hands back. The dbPath
	// fallback chain matches the rest of the cluster.
	restoreRekordboxBackup(backupPath: string, dbPathOverride?: string): Promise<void>;
	// Surface rb's cue color palette as opaque `{id, hex, label}` entries.
	// The high-level app stores `id` (format `cti:N`) in cue.color and uses
	// `hex` for swatches + waveform markers. Only the rb sidecar knows what
	// those ids mean in rb's storage. Static palette — process-life cache;
	// one sidecar RPC per app launch.
	listCuePalette(): Promise<CuePaletteEntry[]>;

	// ─── Discover feed ───────────────────────────────────────────────────
	// Feed items live in their own feed.db behind the FeedStore seam — see
	// planning/tech/discover-core.md. These method shapes are the contract
	// the future cloud-hosted feed keeps.
	getFeedPage(req?: { cursor?: string | null; limit?: number } & FeedFilter): Promise<FeedPage>;
	// Distinct genre/label values across the visible feed — populates the
	// renderer's filter dropdowns.
	getFeedFilterOptions(): Promise<{ genres: string[]; labels: string[] }>;
	// The Archived page — items set aside via the 'archive' action.
	getArchivedFeedPage(req?: { cursor?: string | null; limit?: number }): Promise<FeedPage>;
	// Lazily resolves album tracklists (one source call, cached onto the
	// item payload) and returns per-track played-state for dimming.
	getFeedItemDetail(itemId: string): Promise<FeedItemDetail | null>;
	// On-view Beatport enrichment for one feed item: fills the album-level
	// genre/label + per-track bpm/key/genre/label, persists, and returns the
	// updated item. Idempotent (already-enriched items return untouched).
	enrichFeedItem(itemId: string): Promise<FeedItem | null>;
	feedAction(action: FeedAction): Promise<FeedActionResult>;
	// Unfollow a source playlist surfaced in the feed: drops it at the source
	// (Spotify) and hard-removes every feed item it produced. No-op-safe when
	// Spotify is disconnected (returns ok:false).
	unfollowFeedPlaylist(playlistId: string): Promise<FeedActionResult>;
	// Unfollow a source artist surfaced in the feed: drops them at the source
	// (Spotify) and hard-removes every feed item they produced/appear on.
	unfollowFeedArtist(artistId: string): Promise<FeedActionResult>;
	runFeedRefresh(): Promise<FeedRefreshResult>;
	// Manual Refresh of one feed producer by id (see FEED_PRODUCER_IDS in
	// feed/service.ts) — drives the temporary per-source Refresh buttons.
	runFeedProducerRefresh(producerId: string): Promise<FeedRefreshResult>;
	// "Load more" — push every producer's history horizon back by `days`
	// (clamped 1..60) and ingest the newly-uncovered older window.
	loadMoreFeed(days: number): Promise<FeedRefreshResult>;
	// Per-item feed enrichment completions (background drain + on-view). The
	// desktop forwards these as a 'feed:enriched' push so cards update live.
	subscribeFeedEnriched(cb: (item: FeedItem) => void): () => void;
	// Started by desktop main AFTER the renderer bootstrap lands — same
	// constraint as startLibraryWatching().
	startFeedPolling(): void;
	// Background Spotify album fill (library/album-enrich.ts): fetches the
	// full album object for every release with a Spotify id not yet fetched,
	// paced through the shared rate gate. Called by the desktop main after
	// the renderer's first load (same deferred-start constraint as the feed);
	// re-kicked after each Spotify sync. No-op when Spotify is disconnected
	// or CURATOR_DISABLE_ALBUM_ENRICH=1.
	startAlbumEnrichment(): void;

	// ─── Discovery journeys + knowledge base ───────────────────────────
	// The KB is a virtual answering service over its own knowledge.db (see
	// planning/tech/discovery-journeys.md); journeys are persistent forkable
	// navigation trees over its entities. These shapes are the contract a
	// future hosted knowledge service keeps.
	createJourney(seed: JourneySeed, opts?: { name?: string }): Promise<JourneyDetail>;
	listJourneys(): Promise<JourneySummary[]>;
	getJourney(journeyId: string): Promise<JourneyDetail | null>;
	renameJourney(journeyId: string, name: string): Promise<void>;
	deleteJourney(journeyId: string): Promise<void>;
	// Navigate = append a child under the current node + move the pointer;
	// from an interior node this forks a new branch. Revisiting an existing
	// child re-enters it unless forceBranch.
	journeyNavigate(journeyId: string, entityId: string, opts?: { forceBranch?: boolean }): Promise<{ node: JourneyNode; entity: KbEntityDetail }>;
	// Move the pointer only (browser back-jump to any node).
	journeyJumpTo(journeyId: string, nodeId: string): Promise<KbEntityDetail>;
	journeySetNodeView(journeyId: string, nodeId: string, view: unknown): Promise<void>;
	journeyDeleteBranch(journeyId: string, nodeId: string): Promise<{ removed: number }>;
	// Memory-only entity read (never network).
	getKbEntity(entityId: string): Promise<KbEntityDetail | null>;
	// Resolver-ladder answer for one aspect: structured aspects await the
	// first provider page; agent aspects return 'running' and stream via
	// the kb event subscription.
	expandKbEntity(entityId: string, aspect: KbAspect, opts?: { refresh?: boolean }): Promise<KbExpansion>;
	searchKb(query: string, kinds?: KbEntityKind[]): Promise<KbEntity[]>;
	// Find-or-create a KB entity from a seed (library track / source ref).
	resolveKbEntity(seed: JourneySeed): Promise<KbEntityDetail>;
	// Promote a KB track into the library — same path as a feed promotion.
	promoteKbTrack(entityId: string, opts?: { pin?: boolean }): Promise<{ trackId: string }>;
	// KB expansion events (background pages landing, research completing).
	// The desktop forwards these as the 'kb:event' push.
	subscribeKbEvents(cb: (e: KbEvent) => void): () => void;

	// ─── In-app agent ──────────────────────────────────────────────────
	// BYOK agent over the apps/agent sidecar: read-only tool access to the
	// library / feed / KB / providers, result sets that drive the Discover
	// view, streamed via subscribeAgentEvents → 'agent:event'. These shapes
	// are the contract a future hosted agent keeps (transport swaps, calls
	// don't).
	agentStatus(): Promise<AgentStatus>;
	// Arm (or re-arm) the sidecar with provider + key + model roles. The key
	// lives in the desktop main's safeStorage — core only forwards it.
	configureAgent(config: AgentConfig): Promise<AgentStatus>;
	// Long-running pattern: returns immediately; the turn streams via
	// 'agent:event' (text deltas, tool activity, result sets, turn-finished).
	// `context` is the renderer's view snapshot — scopes ambiguous asks.
	agentSend(req: { sessionId?: string; text: string; context?: AgentViewContext }): Promise<{ status: 'running'; sessionId: string; turnId: string }>;
	agentCancel(sessionId: string): Promise<void>;
	listAgentSessions(): Promise<AgentSessionSummary[]>;
	getAgentSession(sessionId: string): Promise<AgentSessionDetail | null>;
	newAgentSession(): Promise<AgentSessionSummary>;
	deleteAgentSession(sessionId: string): Promise<void>;
	getAgentResultSet(resultSetId: string): Promise<AgentResultSet | null>;
	subscribeAgentEvents(cb: (e: AgentEvent) => void): () => void;
	// External (MCP bridge) tool access: the agent tool registry driven one
	// call at a time by an outside model (Claude over MCP). No sidecar/BYOK
	// involved — works even when the in-app agent is disabled/unconfigured.
	agentExternalToolSpecs(): WireToolSpec[];
	agentCreateExternalSession(title: string): AgentSessionSummary;
	agentRunExternalTool(req: { sessionId: string; name: string; args: unknown }): Promise<unknown>;

	// ─── Play history ──────────────────────────────────────────────────
	// Per-play audit log (play_session / play_event). Curator plays arrive
	// from the renderer PlayTracker via plays:record (same id upserted:
	// insert → 30s checkpoints → finalize); rekordbox plays land through the
	// history import scope. v1 has no renderer views — the read surface is
	// the agent/MCP tools + /ask-library.
	recordPlay(e: PlayRecordUpsert): Promise<void>;
	getTrackPlayHistory(trackId: string, opts?: { limit?: number; offset?: number }): Promise<{ rows: PlayHistoryRow[]; total: number }>;
	listPlaySessions(opts?: { origin?: PlaySessionOrigin; kind?: PlaySessionKind; fromMs?: number; toMs?: number; limit?: number; offset?: number }): Promise<PlaySessionSummary[]>;
	getPlaySession(sessionId: string): Promise<{ session: PlaySession; plays: SessionPlayRow[] } | null>;
	getTopPlayed(opts?: { fromMs?: number; toMs?: number; origin?: PlaySessionOrigin; limit?: number }): Promise<TopPlayedRow[]>;
	// Manual set/prep override — kindSource flips to 'user' and the import
	// classifier stops touching that session. Local-DB write only (never
	// pushed to rekordbox).
	setPlaySessionKind(sessionId: string, kind: 'set' | 'prep'): Promise<void>;

	// ─── AI audio analysis engine (apps/mir; vectors in mir.db) ────────
	// Foundation-model embeddings of the playable library and similarity over
	// them. The renderer reaches similarity through getTracksPage's
	// `filter.similarTo` (results land in the tracklist); these methods are the
	// status/settings surface plus a direct API for agents and other apps.
	mirStatus(): Promise<MirStatus>;
	setMirSettings(patch: Partial<MirSettings>): Promise<MirStatus>;
	// Analyze these tracks next (user lane): clears earlier failures, jumps
	// the background queue. Works even when background embedding is off.
	mirAnalyzeNow(trackIds: string[]): Promise<{ queued: number }>;
	// Packaged builds: create the engine's Python env (multi-GB download).
	mirProvision(): Promise<MirStatus>;
	getSimilarTracks(q: SimilarQuery): Promise<SimilarResult>;
	// Raw track vector for callers doing their own math (null = not analyzed).
	getTrackVector(trackId: string, model?: string): Promise<number[] | null>;
	subscribeMirEvents(cb: (e: MirEvent) => void): () => void;

	// ─── Backup & restore (see backup/service.ts) ────────────────────────
	// Settings live in app_setting ('backup.settings'); the scheduler runs
	// in core without a renderer. Everything heavy happens in the injected
	// BackupHost; these calls return immediately and progress rides
	// subscribeBackupEvents.
	getBackupSettings(): Promise<BackupSettings>;
	setBackupSettings(patch: Partial<BackupSettings>): Promise<BackupSettings>;
	getBackupStatus(): Promise<BackupStatus>;
	getBackupTargetStat(): Promise<BackupTargetStat | null>;
	listBackupSnapshots(opts?: { refresh?: boolean }): Promise<BackupSnapshotSummary[]>;
	// Starts a run now (ignores "due", still refuses while another run is
	// active). Rejects when no target is configured.
	runBackupNow(): Promise<{ runId: string }>;
	cancelBackup(runId: string): Promise<void>;
	// label null ⇒ unpin.
	pinBackupSnapshot(snapshotId: string, label: string | null): Promise<void>;
	deleteBackupSnapshot(snapshotId: string): Promise<void>;
	previewBackupRestore(snapshotId: string): Promise<BackupRestorePreview>;
	// Curator data sets are staged and need a relaunch (relaunchRequired);
	// tracks and rekordbox sets are written directly. Rekordbox sets are
	// refused while rekordbox runs or when the sidecar is unavailable.
	restoreBackup(req: BackupRestoreRequest): Promise<{ runId: string; relaunchRequired: boolean }>;
	// Prefix-remap every local file path + library folder after audio files
	// moved to a new root; restarts the watcher.
	remapLibraryRoot(from: string, to: string): Promise<{ links: number; folders: number }>;
	// Arms the overdue-at-launch check + the periodic tick. Called by the
	// desktop main after the renderer's first load, like startFeedPolling.
	startBackupScheduler(): void;
	subscribeBackupEvents(cb: (e: BackupEvent) => void): () => void;

	// ─── Cloud sync (planning/tech/cloud.md) ─────────────────────────────
	// Named apart from getSyncStatus (the Spotify read-sync). Push/pull state
	// of the op log: signed in, pending / rejected outbox counts, last push
	// and pull, the last error, "update required", first-sign-in push
	// progress.
	getCloudSyncStatus(): Promise<CloudSyncStatusReport>;
	// One push-then-pull cycle now (resets any backoff). Resolves with the
	// status after it; a no-op when sync is disabled or signed out.
	cloudSyncNow(): Promise<CloudSyncStatusReport>;
	// Status changes and `applied` batches (changed local track / playlist
	// ids) — the renderer refreshes the affected rows.
	subscribeCloudSync(cb: (e: CloudSyncEvent) => void): () => void;
	// The fallback poll cadence (app_setting 'sync.poll', per device — never
	// synced): every activeSec while the app is in use, every idleSec once
	// it has not been used for idleAfterSec. Readable and settable with sync
	// disabled; a change applies to the running client at once. A patch is
	// merged over the current value and clamped; null restores the defaults.
	getCloudSyncPollSettings(): Promise<SyncPollSettings>;
	setCloudSyncPollPolicy(patch: Partial<SyncPollPolicy> | null): Promise<SyncPollSettings>;
	// Arms the scheduler (wake-ups, the fallback poll, push on local write).
	// Called by the desktop main after the renderer's first load, like
	// startBackupScheduler: the first-sign-in push must not compete with boot.
	startCloudSync(): void;
	// Detach this install from its Curator account (sync-log/client.ts
	// `unlink`): revoke this device on the account when it can, sign this
	// install out, and give it a fresh device id. Every local row and every
	// outbox op is kept (pending ops move to the new id); the library stays
	// bound to the account whose history it holds, so signing in with that
	// account later resumes as a new device and another account is refused.
	// Also the way out of the revoked state. Never deletes library data.
	unlinkCloudLibrary(): Promise<CloudUnlinkResult>;
	// The master device and the remote-row count (AccountLibraryInfo).
	getAccountLibraryInfo(): Promise<AccountLibraryInfo>;
	// Make `deviceId` the account's master device: its base metadata wins on
	// every other device for the tracks it holds (protocol state.ts
	// resolveTrackMeta). An account setting op; every device re-picks its
	// remote rows on its next sync. Refused when sync is off, signed out, or
	// the server does not read protocol v3 yet.
	setMasterDevice(deviceId: string): Promise<AccountLibraryInfo>;

	// ─── Shared analysis catalogue (apps/core/src/catalogue/) ───────────
	// Analysis one of the account's devices computed, reused by the others
	// (inline units + waveforms by audio hash). Settings are device-local
	// (app_setting 'catalogue.settings', never synced). `available: false`
	// when the build has no cloud transport / blob store.
	getCatalogueStatus(): Promise<CatalogueStatus>;
	setCatalogueSettings(patch: CatalogueSettingsPatch): Promise<CatalogueStatus>;
	// The "upload existing analysis" run: only ever started from here.
	setCatalogueBackfill(action: CatalogueBackfillAction): Promise<CatalogueStatus>;
	subscribeCatalogue(cb: (e: CatalogueEvent) => void): () => void;

	close(): void;
}

export function createCoreService(dbPath: string, opts: CoreServiceOptions = {}): CoreService {
	// First, before anything can log: swap core's module-level accessor onto
	// the host's logger (no-op when omitted — the console default stands).
	if (opts.logger) setCoreLogger(opts.logger);
	// Plays last heard before this instance started belong to a renderer that
	// is gone (plays.ts finalizeInterruptedPlays).
	const startedAt = Date.now();
	const { db, sqlite } = createDb(dbPath);
	const auth = new AuthService(db);
	// One cancel token shared across both enrichers — cancelling fires
	// whichever loop is currently active. Both classes reset it at the start
	// of their own loops so a stale flag from a previous run can't carry over.
	const cancelToken = new CancelToken();
	// One curator.db enrichment sink, shared by the library batch enrich and feed
	// promotion so a promoted track and a directly-enriched one are persisted by
	// the SAME code (DJ-field merge policy + source_link rows). See feedPromote.
	const librarySink = new LibrarySink(db);
	const spotifySync = new SpotifySync(db, auth, { beatportFetch: opts.beatportFetch, cancelToken, librarySink });
	const albumEnricher = createAlbumEnricher({
		raw: rawOf(db),
		getClient: async () => {
			const token = await auth.getSpotifyAccessToken().catch(() => null);
			return token ? new SpotifyClient(token, 'album-enrich') : null;
		},
		disabled: process.env['CURATOR_DISABLE_ALBUM_ENRICH'] === '1' || dbPath === ':memory:',
	});
	const tidalSync = new TidalSync(db, auth);
	const tidalHybrid = new TidalHybrid(db, auth, { cancelToken });
	// A streaming read-sync on a signed-in device waits for its first cloud
	// pull (sync-log/client.ts FIRST_PULL_KEY). Until then this device's
	// records lack the account's provider-id claims, so every track another
	// desktop already holds would be minted again as a new recording — the
	// 2026-10-20 second-desktop incident, ~3.5k duplicates. Signed out (or
	// sync disabled) there is nothing to wait for.
	const streamingReadWait = (source: 'Spotify' | 'Tidal'): string | null => {
		if (!opts.cloud || !opts.cloud.transport.session() || firstPullDone(sqlite)) return null;
		return `Curator is still loading your library from your account on this computer. ${source} sync starts once that finishes.`;
	};
	const assertStreamingReadOpen = (source: 'Spotify' | 'Tidal'): void => {
		const why = streamingReadWait(source);
		if (why) throw new Error(why);
	};

	// ─── Streaming-source adapters + auto-poll scheduler ──────────────
	// Adapters are constructed eagerly; they hold no token state (resolved
	// per call via AuthService), so a long-lived instance survives token
	// rotations + reconnects cleanly. Renderer's setSourceSyncSettings push
	// drives the scheduler's per-source timers. Tidal has a read runner
	// (TidalSync) but no write adapter — its write capabilities are all
	// false, so the write router has nothing to register.
	// Default-deny gate for every streaming remote write. `opts.remoteWritePolicy`
	// is supplied only by the desktop main process; without it the guarded adapter
	// (and the feed's unfollow path) throw before any HTTP call — see CLAUDE.md.
	const remoteWriteGate = makeRemoteWriteGate(opts.remoteWritePolicy, opts.writeAudit);
	// Wrap the adapter so EVERY mutating method routes through the gate. Every
	// consumer of `sourceAdapters` (add/remove/reorder/rename, the deleteTracks
	// cascade, forceUpstream) inherits the guard automatically.
	const spotifyAdapter = guardRemoteWrites(opts.sourceAdapters?.spotify ?? new SpotifyAdapter(auth), remoteWriteGate);
	const sourceAdapters: Partial<Record<StreamingSource, StreamingSourceAdapter>> = {
		spotify: spotifyAdapter,
	};
	// Hydrated from app_setting so the packaged and dev renderers (different
	// browser origins, hence different localStorage) gate on ONE value. Rows
	// absent → defaults (write-sync OFF). Only the in-memory mirror is filled
	// here; the scheduler's timers start when the renderer re-pushes at boot.
	const sourceSyncSettingKey = (src: StreamingSource): string => `sourceSync.${src}`;
	const loadSourceSyncSettings = (src: StreamingSource): SourceSyncSettings => {
		const row = db
			.select({ value: appSetting.value })
			.from(appSetting)
			.where(eq(appSetting.key, sourceSyncSettingKey(src)))
			.get();
		const stored = (row?.value && typeof row.value === 'object' ? row.value : {}) as Partial<SourceSyncSettings>;
		return { ...DEFAULT_SOURCE_SYNC_SETTINGS, ...stored };
	};
	const sourceSyncSettings: Record<StreamingSource, SourceSyncSettings> = {
		spotify: loadSourceSyncSettings('spotify'),
		tidal:   loadSourceSyncSettings('tidal'),
	};
	const CREDIT_FORMAT_KEY = 'credit_format';
	const loadCreditFormat = (): { format: ArtistCreditFormat; stored: boolean } => {
		const row = db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, CREDIT_FORMAT_KEY)).get();
		const v = (row?.value && typeof row.value === 'object' ? row.value : {}) as Partial<ArtistCreditFormat>;
		return {
			format: {
				separator: v.separator === '/' || v.separator === ';' ? v.separator : ',',
				remixStyle: v.remixStyle === 'dash' ? 'dash' : 'parenthesis',
			},
			stored: !!row,
		};
	};
	let creditFormat: ArtistCreditFormat = loadCreditFormat().format;
	let creditFormatStored = loadCreditFormat().stored;
	// Can the connected user mutate this playlist upstream? `/me/playlists`
	// includes FOLLOWED playlists owned by other users; Spotify (and Tidal)
	// answer 403 to a DELETE/POST on a playlist you neither own nor
	// collaborate on. Gate every upstream add/remove on this so a
	// library-wide delete doesn't spew 403s for tracks that also live in
	// someone else's playlist. ownerId unknown (null) → attempt anyway, to
	// avoid regressing owned rows synced before owner info was captured.
	const canModifyUpstream = (pl: { source: string; ownerId: string | null; isCollaborative: boolean | null }): boolean => {
		if (pl.isCollaborative === true) return true;
		if (pl.ownerId == null) return true;
		const status = auth.getStatus();
		const myId = pl.source === 'tidal' ? status.tidal.id : status.spotify.id;
		return myId != null && pl.ownerId === myId;
	};
	const isFollowedPlaylist: FollowedPlaylistProbe = (playlistId) => {
		const pl = db.select({ source: playlist.source, ownerId: playlist.ownerId, isCollaborative: playlist.isCollaborative })
			.from(playlist).where(eq(playlist.id, playlistId)).get();
		return !!pl && (pl.source === 'spotify' || pl.source === 'tidal') && !canModifyUpstream(pl);
	};
	// Local-vs-remote membership diff for one streaming playlist. One
	// provider read (the adapter unrolls pagination). A local row counts as
	// present remotely if ANY provider id we know for its track is in the
	// remote set — the row's own sourceTrackId or any source_link id for the
	// same track — so a track that carries two Spotify ids (re-released
	// single, region variant) isn't re-added as a near-duplicate.
	const computeUpstreamDrift = async (playlistId: string): Promise<PlaylistUpstreamDrift> => {
		const pl = db.select().from(playlist).where(eq(playlist.id, playlistId)).get();
		if (!pl) throw new Error(`Playlist ${playlistId} not found`);
		if (pl.source !== 'spotify' && pl.source !== 'tidal') throw new Error('Not a streaming playlist');
		if (pl.sourceId === LIKED_SONGS_SENTINEL_ID) throw new Error('Liked Songs is not a playlist the provider lets us write to');
		const src = pl.source as StreamingSource;
		const adapter = sourceAdapters[src];
		if (!adapter) throw new Error(`No ${src} adapter`);
		const remote = await adapter.fetchPlaylistTracks(pl.sourceId);
		const remoteIds = new Set(remote.map((r) => r.remoteId));
		const rows = db
			.select({
				trackId: playlistTrack.trackId,
				sourceTrackId: playlistTrack.sourceTrackId,
				position: playlistTrack.position,
				addedAt: playlistTrack.addedAt,
				title: track.title,
				artists: track.artists,
			})
			.from(playlistTrack)
			.innerJoin(track, eq(track.id, playlistTrack.trackId))
			.where(eq(playlistTrack.playlistId, playlistId))
			.orderBy(asc(playlistTrack.position))
			.all();
		const links = chunkedIn(rows.map((r) => r.trackId), (chunk) => db
			.select({ trackId: sourceLink.trackId, sourceTrackId: sourceLink.sourceTrackId })
			.from(sourceLink)
			.where(and(eq(sourceLink.source, src), inArray(sourceLink.trackId, chunk)))
			.all());
		const altIds = new Map<string, string[]>();
		for (const l of links) {
			const arr = altIds.get(l.trackId) ?? [];
			arr.push(l.sourceTrackId);
			altIds.set(l.trackId, arr);
		}
		const seen = new Set<string>();
		const knownRemote = new Set<string>();
		const localOnly: PlaylistUpstreamDrift['localOnly'] = [];
		for (const r of rows) {
			const candidates = [r.sourceTrackId, ...(altIds.get(r.trackId) ?? [])];
			for (const c of candidates) if (remoteIds.has(c)) knownRemote.add(c);
			if (seen.has(r.trackId)) continue;
			seen.add(r.trackId);
			if (candidates.some((id) => remoteIds.has(id))) continue;
			// Rows inserted before link resolution carry the Curator uuid as
			// sourceTrackId (the local/rekordbox fallback) — push a real
			// provider id instead, or skip if there is none to push.
			const pushId = r.sourceTrackId !== r.trackId ? r.sourceTrackId : altIds.get(r.trackId)?.[0];
			if (!pushId) continue;
			localOnly.push({
				trackId: r.trackId,
				sourceTrackId: pushId,
				position: r.position,
				addedAt: r.addedAt ?? null,
				title: r.title ?? '',
				artists: (Array.isArray(r.artists) ? r.artists : []).map((a) => a?.name ?? '').filter(Boolean).join(', '),
			});
		}
		return {
			playlistId,
			name: pl.name,
			source: pl.source,
			canModify: canModifyUpstream(pl),
			localCount: rows.length,
			remoteCount: remote.length,
			remoteOnlyCount: remote.filter((r) => !knownRemote.has(r.remoteId)).length,
			localOnly,
		};
	};
	const sourceScheduler = new SourceSyncScheduler();
	// Runner = the existing full Spotify sync. It already snapshot_id-
	// short-circuits unchanged playlists internally, so calling it on a
	// 5-min tick is cheap — typically 1-2 requests for the index, zero
	// for any playlist that hasn't moved. The connected guard stops a
	// disconnected session from stamping a failed sync_job row every tick.
	sourceScheduler.registerRunner('spotify', async () => {
		if (!(await auth.getSpotifyAccessToken())) return;
		// The next tick tries again; the first pull is seconds away.
		if (streamingReadWait('Spotify')) return;
		await spotifySync.run();
		albumEnricher.kick();
	});
	// Tidal ticks are equally cheap: lastModifiedAt+numberOfItems short-
	// circuits unchanged playlists, so an idle poll is index pages only.
	// The renderer arms this timer whenever tidal read-sync is on — also on
	// machines with no Tidal account — so a disconnected session no-ops
	// instead of stamping a failed sync_job row every tick.
	sourceScheduler.registerRunner('tidal', async () => {
		if (!(await auth.getTidalAccessToken())) return;
		if (streamingReadWait('Tidal')) return;
		await tidalSync.run();
	});

	// ─── Discover feed service ─────────────────────────────────────────
	// The feed engine is a self-contained service behind ports (see
	// planning/tech/discover-feed-service.md) — the same code can later run
	// off-main or in the cloud by swapping the port adapters. feed.db sits
	// next to curator.db but is its own file behind the FeedStore seam.
	// Local adapters: AuthService (token), beatportFetch (Electron net.fetch),
	// and the LibraryPort below — the only place the feed touches curator.db.
	const feedDbPath = dbPath === ':memory:' ? ':memory:' : joinPath(dirname(dbPath), 'feed.db');
	// Library-membership probe — batched, read-only, mirroring
	// SpotifySync.upsertTrack's identity logic: match by ISRC (track_isrc_idx)
	// and by spotify source-track id (source_link_uniq).
	const feedLibraryMembership: LibraryMembershipLookup = async ({ isrcs, spotifyTrackIds }) => {
		const membershipByIsrc: Record<string, LibraryTier> = {};
		const membershipBySpotifyId: Record<string, LibraryTier> = {};
		// isrc/sid → resolved curator track id, so libraryTrackAttrs can map the
		// pinned tag + owning source back onto the feed keys.
		const idByIsrc = new Map<string, string>();
		const idBySpotifyId = new Map<string, string>();
		// Tier comes from the materialized track.membership column; join track for
		// the spotify branch (and filter deletedAt on both) so a soft-deleted row
		// never reads as in-library. A null tier (in library at the 'none' tier)
		// is omitted — the feed treats absent the same as 'none'.
		// Remote rows (track.remoteOnly) match here by ISRC on purpose: the
		// feed asks "does the account hold this recording", and a track held
		// on another device is in the library, not a discovery. They never
		// match the spotify branch (no source_link on this device).
		for (let i = 0; i < isrcs.length; i += 500) {
			const chunk = isrcs.slice(i, i + 500);
			const rows = db
				.select({ isrc: track.isrc, id: track.id, membership: track.membership })
				.from(track)
				.where(and(inArray(track.isrc, chunk), isNull(track.deletedAt)))
				.all();
			for (const r of rows) {
				if (!r.isrc) continue;
				if (r.membership) membershipByIsrc[r.isrc] = r.membership;
				idByIsrc.set(r.isrc, r.id);
			}
		}
		for (let i = 0; i < spotifyTrackIds.length; i += 500) {
			const chunk = spotifyTrackIds.slice(i, i + 500);
			const rows = db
				.select({ sid: sourceLink.sourceTrackId, id: sourceLink.trackId, membership: track.membership })
				.from(sourceLink)
				.innerJoin(track, eq(track.id, sourceLink.trackId))
				.where(and(eq(sourceLink.source, 'spotify'), inArray(sourceLink.sourceTrackId, chunk), isNull(track.deletedAt)))
				.all();
			for (const r of rows) {
				if (!r.sid) continue;
				if (r.membership) membershipBySpotifyId[r.sid] = r.membership;
				idBySpotifyId.set(r.sid, r.id);
			}
		}
		// Resolve pinned + source once over the union of matched ids, then fan the
		// per-track attributes back onto the isrc/sid keys.
		const { pinned, source } = libraryTrackAttrs(db, auth.getStatus().spotify.id, [...new Set([...idByIsrc.values(), ...idBySpotifyId.values()])]);
		const pinnedByIsrc = new Set<string>();
		const pinnedBySpotifyId = new Set<string>();
		const sourceByIsrc: Record<string, StreamingSource> = {};
		const sourceBySpotifyId: Record<string, StreamingSource> = {};
		for (const [isrc, id] of idByIsrc) {
			if (pinned.has(id)) pinnedByIsrc.add(isrc);
			const s = source.get(id);
			if (s) sourceByIsrc[isrc] = s;
		}
		for (const [sid, id] of idBySpotifyId) {
			if (pinned.has(id)) pinnedBySpotifyId.add(sid);
			const s = source.get(id);
			if (s) sourceBySpotifyId[sid] = s;
		}
		return { membershipByIsrc, membershipBySpotifyId, pinnedByIsrc, pinnedBySpotifyId, sourceByIsrc, sourceBySpotifyId };
	};
	// Promotion adapter — feed → library. Reuses the exact playlist-sync ingest
	// rules (provider-id → ISRC → create), flips the track to backlog, persists
	// the feed's carried enrichment through the SHARED LibrarySink (so a promoted
	// track is identical to one enriched directly in the library — DJ-field merge
	// policy + source_link rows), and adds the interested tag. Owns every
	// curator.db write for promotion.
	const feedPromote = async (st: SpotifyTrack, enrichResult: EnrichmentResult | null, opts?: { pin?: boolean }): Promise<string> => {
		const trackId = spotifySync.ingestExternalTrack(st);
		const now = new Date();
		// Stamp the real "added to library" moment. createdAt is when Curator
		// first ingested the row — for a track that was already in curator.db
		// before promotion (e.g. pulled in by an earlier followed-playlist sync)
		// that can predate this by hours/days, and the Added column prefers
		// addedAt over createdAt, so without this it shows the stale ingest time.
		// The backlog flip is synced state (library_track set-state); addedAt
		// is this device's ingest bookkeeping and stays local.
		mut.recordTrackStateChanges(db, [trackId], () => {
			db.update(track)
				.set({ state: 'backlog', stateChangedAt: now, updatedAt: now, addedAt: now })
				.where(eq(track.id, trackId))
				.run();
		});
		// Carry the feed's enrichment through the same sink the library batch uses.
		// LibrarySink applies the merge (local bpm/key win; genre/label/releaseDate
		// refresh) and writes the matched beatport/traxsource source_link rows.
		if (enrichResult && (enrichResult.patch || enrichResult.sourceLinks.length > 0)) {
			await librarySink.persist(trackId, enrichResult);
		}
		// The `interested` ("Pinned") tag marks a discovery candidate. The plain
		// "Organize" path promotes with pin:false — the track enters the library
		// but isn't pinned; it's owned via the tags/playlists the user assigns.
		if (opts?.pin ?? true) mut.tagTracks(db, [trackId], 'interested', { addedAt: now });
		// Freshly ingested row — classify it (a promoted track already in one of
		// the user's playlists should carry that tier immediately, not wait for
		// the next sync).
		membership.recomputeForTrack(trackId);
		// Fallback: the feed carried no usable match (a clean 'na', a legacy item
		// with no stored metadata, or one promoted before the drain reached it).
		// Re-run the library enrich from the CANONICAL track row — its query (the
		// full ingested track) often matches where the feed's payload-derived
		// query missed, and it's the exact path the user runs by hand. Detached +
		// best-effort: a miss/throw must not fail the promotion.
		if (!enrichResult?.patch) {
			void spotifySync.enrichBeatportTrack(trackId).catch((err) => {
				log.for('feed').warn('post-promote enrich failed', { trackId }, err);
			});
		}
		return trackId;
	};
	// Resolve canonical curator track ids for feed tracks the library owns —
	// keyed by spotify source-track id (source_link) and by ISRC (track). Lets
	// the feed detail surface a sourceTrackId → trackId map (see getItemDetail).
	const feedLibraryTrackIds = async ({ isrcs, spotifyTrackIds }: { isrcs: string[]; spotifyTrackIds: string[] }) => {
		const bySpotify: Record<string, string> = {};
		const byIsrc: Record<string, string> = {};
		const tierBySpotify: Record<string, FeedMembershipTier> = {};
		const tierByIsrc: Record<string, FeedMembershipTier> = {};
		// Keys carrying the `interested` ("Pinned") tag — drives the renderer's
		// "Not Interested" (un-pin) action, offered for pinned tracks ONLY.
		const pinnedBySpotify = new Set<string>();
		const pinnedByIsrc = new Set<string>();
		// raw tier + curator id per matched key, resolved to the DISPLAY tier
		// (pinned/local → library, own playlist → its source, followed → followed)
		// once libraryTrackAttrs is read for the union of matched ids.
		const rawBySpotify = new Map<string, LibraryTier>();
		const idBySpotify = new Map<string, string>();
		const rawByIsrc = new Map<string, LibraryTier>();
		const idByIsrc = new Map<string, string>();
		// `by*` is the OWNED curator-id map that drives the row's curate menu (Tag /
		// Add-to-playlist, and — for pinned tracks — Not Interested). A track counts
		// as owned when it's local/streaming tier (have the file / in my own
		// playlist), in a curated state (backlog/progress/purchased — i.e.
		// promoted/pulled in), OR carries the `interested` ("Pinned") tag (folded in
		// below, once libraryTrackAttrs has resolved pinned — covers a track pinned
		// from the library without a curated state or owned source). A merely-SYNCED
		// followed-playlist track (followed tier, state 'unsorted', not pinned) is
		// deliberately excluded: it's in curator.db only because I follow that
		// playlist, so the row should offer "Interested" (promote), not curate it.
		// `tier*` stays complete (all matched tiers) so the chip can still show
		// "In Followed Playlist". Soft-deleted rows are split out via deletedKeys.
		const CURATED_STATES = new Set(['backlog', 'progress', 'purchased']);
		const owned = (membership: string | null, state: string): boolean =>
			membership === 'local' || membership === 'streaming' || CURATED_STATES.has(state);
		for (let i = 0; i < spotifyTrackIds.length; i += 500) {
			const chunk = spotifyTrackIds.slice(i, i + 500);
			const rows = db
				.select({ sid: sourceLink.sourceTrackId, trackId: sourceLink.trackId, membership: track.membership, state: track.state })
				.from(sourceLink)
				.innerJoin(track, eq(track.id, sourceLink.trackId))
				.where(and(eq(sourceLink.source, 'spotify'), inArray(sourceLink.sourceTrackId, chunk), isNull(track.deletedAt)))
				.all();
			for (const r of rows) {
				if (!r.sid || !r.trackId) continue;
				if (owned(r.membership, r.state)) bySpotify[r.sid] = r.trackId;
				if (r.membership) rawBySpotify.set(r.sid, r.membership);
				idBySpotify.set(r.sid, r.trackId);
			}
		}
		for (let i = 0; i < isrcs.length; i += 500) {
			const chunk = isrcs.slice(i, i + 500);
			const rows = db.select({ isrc: track.isrc, id: track.id, membership: track.membership, state: track.state }).from(track).where(and(inArray(track.isrc, chunk), isNull(track.deletedAt))).all();
			for (const r of rows) {
				if (!r.isrc) continue;
				if (owned(r.membership, r.state)) byIsrc[r.isrc] = r.id;
				if (r.membership) rawByIsrc.set(r.isrc, r.membership);
				idByIsrc.set(r.isrc, r.id);
			}
		}
		// Resolve display tiers: pinned + owning source over the union of matched
		// ids, then fold each key's raw tier into the chip tier the renderer shows.
		// A pinned track also enters the owned `by*` map (so its menu can act) and
		// the `pinned*` set (so its menu offers Not Interested).
		const { pinned, source } = libraryTrackAttrs(db, auth.getStatus().spotify.id, [...new Set([...idBySpotify.values(), ...idByIsrc.values()])]);
		for (const [sid, id] of idBySpotify) {
			const tier = resolveFeedMembership(rawBySpotify.get(sid), pinned.has(id), source.get(id));
			if (tier) tierBySpotify[sid] = tier;
			if (pinned.has(id)) { bySpotify[sid] = id; pinnedBySpotify.add(sid); }
		}
		for (const [isrc, id] of idByIsrc) {
			const tier = resolveFeedMembership(rawByIsrc.get(isrc), pinned.has(id), source.get(id));
			if (tier) tierByIsrc[isrc] = tier;
			if (pinned.has(id)) { byIsrc[isrc] = id; pinnedByIsrc.add(isrc); }
		}
		return { bySpotify, byIsrc, tierBySpotify, tierByIsrc, pinnedBySpotify, pinnedByIsrc };
	};
	// Which feed tracks are SOFT-DELETED in the library — keyed by spotify
	// source-track id and by ISRC. Mirrors feedLibraryTrackIds but selects the
	// `deletedAt IS NOT NULL` side. Drives the feed's "hide deleted track-items
	// / chip the deleted album rows" behaviour (see createFeedService.getPage +
	// getItemDetail). Returns presence sets, not curator ids — the renderer only
	// needs to know "is this one deleted".
	const feedLibraryDeletedKeys = async ({ isrcs, spotifyTrackIds }: { isrcs: string[]; spotifyTrackIds: string[] }) => {
		const spotify = new Set<string>();
		const isrc = new Set<string>();
		for (let i = 0; i < spotifyTrackIds.length; i += 500) {
			const chunk = spotifyTrackIds.slice(i, i + 500);
			const rows = db
				.select({ sid: sourceLink.sourceTrackId })
				.from(sourceLink)
				.innerJoin(track, eq(track.id, sourceLink.trackId))
				.where(and(eq(sourceLink.source, 'spotify'), inArray(sourceLink.sourceTrackId, chunk), isNotNull(track.deletedAt)))
				.all();
			for (const r of rows) if (r.sid) spotify.add(r.sid);
		}
		for (let i = 0; i < isrcs.length; i += 500) {
			const chunk = isrcs.slice(i, i + 500);
			const rows = db.select({ isrc: track.isrc }).from(track).where(and(inArray(track.isrc, chunk), isNotNull(track.deletedAt))).all();
			for (const r of rows) if (r.isrc) isrc.add(r.isrc);
		}
		return { spotify, isrc };
	};
	// Reverse of feedPromote — fully remove the track from the library. This is
	// the "undo a promotion" path (feed 'uninterested'), so it HARD-deletes:
	// the candidate returns to the visible feed and must not leave a soft-delete
	// tombstone behind (a tombstoned row would get hidden as a deleted feed
	// track-item, swallowing the very item we're handing back). Cascades
	// source_link/trackTag/playlist_track/cue/analysis, trashes any local file,
	// pushes streaming-playlist removals. svcRef is the forward-ref assigned at
	// the end of createCoreService; safe here because this only runs via IPC.
	const feedUnpromote = async (trackId: string): Promise<void> => {
		await svcRef!.deleteTracks([trackId], { hard: true });
	};
	// Held separately so mergeTracks can re-point promoted_track_id without
	// going through the feed engine.
	const feedStore = new SqliteFeedStore(feedDbPath);
	const feedService = createFeedService({
		store: feedStore,
		auth, // AuthService satisfies FeedAuthPort structurally
		beatportFetch: opts.beatportFetch,
		library: { membership: feedLibraryMembership, promote: feedPromote, libraryTrackIds: feedLibraryTrackIds, deletedKeys: feedLibraryDeletedKeys, unpromote: feedUnpromote },
		// Feed unfollow (playlist/artist) mutates the live account — same gate.
		remoteWriteGate,
	});

	// ─── Knowledge service (discovery journeys) ────────────────────────
	// knowledge.db is the third DB file: the KB's write-behind memory +
	// journey trees (see planning/tech/discovery-journeys.md). The library
	// port reuses the feed's promotion adapter verbatim so a journey-promoted
	// track is byte-identical to a feed-promoted one. The research sidecar is
	// spawned only when a spec was injected (⇒ an Anthropic key exists) —
	// disabled is a supported state; without it the agent tier simply isn't
	// registered.
	const knowledgeDbPath = dbPath === ':memory:' ? ':memory:' : joinPath(dirname(dbPath), 'knowledge.db');
	let researcherSidecar: ResearcherSidecar | null = null;
	if (opts.researcher) {
		researcherSidecar = new ResearcherSidecar(opts.researcher);
		researcherSidecar.start();
	}
	const knowledgeService = createKnowledgeService({
		store: new SqliteKnowledgeStore(knowledgeDbPath),
		auth,
		library: {
			promote: feedPromote,
			libraryTrackIds: async (probe) => {
				const r = await feedLibraryTrackIds(probe);
				return { bySpotify: r.bySpotify, byIsrc: r.byIsrc };
			},
			getTrackSeed: async (trackId) => {
				const row = db.select().from(track).where(eq(track.id, trackId)).get();
				if (!row) return null;
				const sp = db
					.select({ sid: sourceLink.sourceTrackId })
					.from(sourceLink)
					.where(and(eq(sourceLink.trackId, trackId), eq(sourceLink.source, 'spotify')))
					.get();
				return {
					title: row.title,
					artists: row.artists.map((a) => a.name),
					isrc: row.isrc,
					durationSec: row.duration,
					coverUrl: row.coverUrl,
					releaseDate: row.releaseDate,
					spotifyTrackId: sp?.sid ?? null,
				};
			},
		},
		...(researcherSidecar ? { researcher: researcherSidecar } : {}),
	});

	// ─── Agent service (in-app agent) ──────────────────────────────────
	// agent.db is the fourth DB file: sessions + result sets, beside
	// knowledge.db. The sidecar (apps/agent) is spawned only when a spec was
	// injected — disabled is a supported state. Tools close over the service
	// forward-ref (svcRef) because the agent registry calls the same public
	// query surface the renderer uses; result-set ref validation resolves
	// against the three stores so the model can never present an id it
	// didn't actually see.
	const agentDbPath = dbPath === ':memory:' ? ':memory:' : joinPath(dirname(dbPath), 'agent.db');
	let agentSidecar: AgentSidecarManager | undefined;
	if (opts.agent) {
		agentSidecar = new AgentSidecarManager(opts.agent);
		agentSidecar.start();
	}
	const agentRefs: ResultRefPorts = {
		async libraryTracks(ids) {
			const out = new Map<string, string | null>();
			const rows = chunkedIn(ids, (chunk) =>
				db.select({ id: track.id }).from(track).where(and(inArray(track.id, chunk), isNull(track.deletedAt))).all());
			for (const r of rows) out.set(r.id, null);
			const links = chunkedIn(ids, (chunk) =>
				db.select({ trackId: sourceLink.trackId, sid: sourceLink.sourceTrackId })
					.from(sourceLink)
					.where(and(inArray(sourceLink.trackId, chunk), eq(sourceLink.source, 'spotify')))
					.all());
			for (const l of links) if (out.has(l.trackId)) out.set(l.trackId, l.sid);
			return out;
		},
		async feedItems(ids) {
			const out = new Map<string, { playSpotifyId: string | null }>();
			// Per-id detail reads — result sets cap at 100 items and feed refs
			// are typically a handful; not a hot path.
			for (const id of [...new Set(ids)]) {
				const detail = await feedService.getItemDetail(id).catch(() => null);
				if (!detail) continue;
				const item = detail.item;
				out.set(id, {
					playSpotifyId: item.type === 'track' && item.source === 'spotify' ? item.sourceId : null,
				});
			}
			return out;
		},
		async kbEntities(ids) {
			const out = new Map<string, { resolvedId: string; playSpotifyId: string | null }>();
			for (const id of [...new Set(ids)]) {
				const detail = await knowledgeService.getKbEntity(id).catch(() => null);
				if (!detail) continue;
				const spRef = detail.sources.find((r) => r.source === 'spotify' && r.sourceKind === 'track');
				out.set(id, { resolvedId: detail.entity.id, playSpotifyId: spRef?.sourceId ?? null });
			}
			return out;
		},
	};
	// The workspace needs real DB files (read-only main + attaches) — a
	// :memory: core has none, so the workspace is simply off there.
	const workspaceManager = dbPath === ':memory:'
		? undefined
		: createWorkspaceManager(
			(opts.workspaceHost ?? createInlineWorkspaceHost)({
				curatorDb: dbPath,
				feedDb: feedDbPath,
				knowledgeDb: knowledgeDbPath,
			}),
		);
	const agentService = createAgentService({
		store: new SqliteAgentStore(agentDbPath),
		...(agentSidecar ? { sidecar: agentSidecar } : {}),
		...(workspaceManager ? { workspace: workspaceManager } : {}),
		refs: agentRefs,
		getFeedFilterOptions: () => feedService.filterOptions(),
		tools: buildAgentTools({
			svc: () => svcRef!,
			getSpotifyClient: async () => {
				const token = await auth.getSpotifyAccessToken().catch(() => null);
				return token ? new SpotifyClient(token, 'agent') : null;
			},
			beatport: opts.beatportFetch ? new BeatportClient({ fetchImpl: opts.beatportFetch }) : null,
			waitForKbExpansion: (entityId, aspect, timeoutMs) =>
				new Promise<boolean>((resolve) => {
					const timer = setTimeout(() => { unsub(); resolve(false); }, timeoutMs);
					const unsub = knowledgeService.subscribeEvents((e) => {
						if (e.kind === 'expansion' && e.entityId === entityId && e.aspect === aspect
							&& (e.status === 'complete' || e.status === 'partial' || e.status === 'error')) {
							clearTimeout(timer);
							unsub();
							resolve(e.status !== 'error');
						}
					});
				}),
		}),
	});

	const tidalDownloader = new TidalDownloader(db, auth);
	const downloadQueue = new DownloadQueue(tidalDownloader, db);
	// `parseAudio` is the off-main parser when provided (utility-process
	// pool in the desktop app). Without it the scanner runs parseFile on
	// the caller's thread via parseInline — fine for tests + CLI but bad
	// for Electron, where it would block the event loop.
	const parseAudio: ParseFn = opts.parseAudio ?? parseInline;
	const libraryScanner = new LibraryScanner(db, parseAudio);
	// NOTE: startAll() is NOT called here. The desktop main process triggers
	// it via startLibraryWatching() after the renderer has loaded its UI —
	// otherwise a folder with thousands of files saturates the main event loop
	// with sync better-sqlite3 calls before the renderer's bootstrap IPC
	// requests can land, producing a blank window on launch.

	// Metric-cutoff store. Loaded synchronously so getTracksImpl can decorate
	// rows with bucket levels from its first call. Boot-time staleness check
	// runs here too — if analyzed count has drifted >5% since last recompute
	// (or no cutoffs exist yet), we recompute. Cheap: ~<100ms even at 50k tracks.
	const cutoffStore = new CutoffStore(db);
	cutoffStore.recomputeIfStaleAtBoot();

	// Library-membership classifier — materializes track.membership (local >
	// streaming > followed). `sqlite` is the raw better-sqlite3 handle (the CASE
	// recompute is one indexed UPDATE); the my-id thunk reads the connected
	// Spotify account so owned-vs-followed can be told apart. Invalidation is
	// wired at every write site that can change local-file presence or playlist
	// membership (scanner ingest below; sync wrappers, playlist add/remove,
	// promote, delete, and auth connect/disconnect further down).
	const membership = new MembershipClassifier(sqlite, () => auth.getStatus().spotify.id);
	// Local-file presence changes the tier — recompute whenever the scanner
	// ingests (created/matched → may become 'local') or orphans (file removed →
	// may fall back). Ungated on the analyzer, unlike the eager-analysis hook
	// below: membership must stay correct even with the analyzer off.
	libraryScanner.onIngest((evt) => {
		if (evt.outcome === 'created' || evt.outcome === 'matched' || evt.outcome === 'rebound' || evt.outcome === 'orphaned') {
			membership.recomputeForTrack(evt.trackId);
		}
	});

	// Analyzer sidecar + queue. Only spawned when the caller supplies a
	// spawn-spec — keeps tests + bare-bones CLI usage Python-free. Peaks
	// directory is mkdir-on-construct (lazy) inside the queue.
	let analyzerSidecar: AnalyzerSidecar | null = null;
	let analysisQueue: AnalysisQueue | null = null;
	// Full auto-analyze settings for the scanner-driven onIngest path.
	// Default is `enabled: false` so a fresh install doesn't churn through
	// the library without the user asking. The renderer pushes the
	// persisted localStorage value via setAutoAnalyzeSettings on boot and
	// on every change to the Library settings checkboxes. Manual paths
	// (Analyze modal, rb grid sync) bypass this object entirely.
	let autoAnalyzeSettings: AutoAnalyzeSettings = { ...DEFAULT_AUTO_ANALYZE_SETTINGS };
	if (opts.analyzer && opts.peaksDir) {
		// Not started here: the desktop main calls startAnalyzer() once the
		// window has loaded (on Windows the spawn boots WSL, and its network
		// adapter appearing aborts the renderer's in-flight module loads).
		// Jobs dispatched before then wait inside the sidecar wrapper.
		analyzerSidecar = new AnalyzerSidecar(opts.analyzer);
		analysisQueue = new AnalysisQueue(db, analyzerSidecar, { peaksDir: opts.peaksDir });
		// Eager analysis: any time the scanner ingests a new (or re-matched)
		// local file, queue it at low priority — but only when the user has
		// opted in. AnalyzeOptions get built from the sub-flags so the
		// worker only runs the stages the user wants. The queue's
		// enqueue() dedupes already-done tracks so re-matched files don't
		// re-analyze.
		// The audio under a known path changed (scanner.ts audioChanged): the
		// old analysis describes other audio — re-queued in full (queue.ts
		// requeueChangedAudio). Not gated on auto-analyze: it is queued as
		// background work, which waits for auto-analyze like any other.
		libraryScanner.onIngest((evt) => {
			if (evt.audioChanged) analysisQueue!.requeueChangedAudio(evt.trackId);
		});
		libraryScanner.onIngest((evt) => {
			// Only freshly created/re-matched files have new audio to analyze —
			// skipped (already known), failed, and orphaned (file removed) don't.
			if (evt.outcome !== 'created' && evt.outcome !== 'matched') return;
			if (evt.audioChanged) return;
			if (!autoAnalyzeSettings.enabled) return;
			const analyzeOptions = analysisFlagsToOptions(autoAnalyzeSettings.flags);
			analysisQueue!.enqueue([evt.trackId], { priority: 0, analyzeOptions });
		});
		// Cutoff drift trigger: each successful analysis nudges a debounced
		// recompute (30s window). A long backfill of N tracks coalesces to
		// one recompute at the tail, so the UI doesn't render hour-stale
		// levels during a backfill run.
		analysisQueue.on('event', (evt: AnalysisJobEvent) => {
			if (evt.kind === 'completed') cutoffStore.scheduleRecompute();
		});
	}

	// AI audio analysis engine. mir.db is the fifth DB file (vectors are
	// derived/rebuildable — kept out of curator.db and its backups). Settings
	// live in app_setting so dev and packaged builds share one value. The
	// engine's backfill yields while the Essentia analyzer is busy.
	const MIR_SETTINGS_KEY = 'mir.settings';
	const mirLayer = createMirLayer({
		mirDbPath: dbPath === ':memory:' ? ':memory:' : joinPath(dirname(dbPath), 'mir.db'),
		sidecar: opts.mir ?? null,
		provision: opts.mirProvision ?? null,
		library: sqliteLibraryPort(sqlite),
		loadSettings: () => {
			const row = db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, MIR_SETTINGS_KEY)).get();
			return row?.value && typeof row.value === 'object' ? row.value as Partial<MirSettings> : null;
		},
		saveSettings: (s) => { mut.setSetting(db, MIR_SETTINGS_KEY, s); },
		busyElsewhere: () => analysisQueue?.busy ?? false,
	});

	// `filter.similarTo` → ranked ids. Every other filter field narrows the
	// candidate set first (SQL pushdown), so the ranking happens inside the
	// user's scope; the synchronous builders below only ever see `ids`.
	type SimilarResolved = { filter: ZTrackFilterT; score: Map<string, number> };
	const resolveSimilar = async (filter: ZTrackFilterT | undefined): Promise<SimilarResolved | null> => {
		const st = filter?.similarTo;
		if (!filter || !st) return null;
		const { similarTo: _omit, ...base } = filter;
		const scoped = Object.values(base).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0));
		const allow = scoped ? new Set(getTrackIdsImpl(db, base, undefined, 200_000, isFollowedPlaylist)) : null;
		const r = await mirLayer.rank({ seeds: st.seeds ?? [], text: st.text, model: st.model, k: st.k, allow });
		return { filter: { ids: r.items.map((i) => i.trackId) }, score: new Map(r.items.map((i) => [i.trackId, i.score])) };
	};
	// Rank order unless the user picked a real column; 'match' and "no sort"
	// both mean best-first.
	const orderByMatch = (rows: Track[], sim: SimilarResolved, sort: ZTrackSortT | undefined): Track[] => {
		for (const t of rows) t.matchScore = sim.score.get(t.id) ?? null;
		if (sort && sort.column !== 'match') return rows;
		const dir = sort?.dir === 'asc' ? -1 : 1;
		return rows.sort((a, b) => dir * ((b.matchScore ?? -2) - (a.matchScore ?? -2)));
	};
	const sqlSort = (sort: ZTrackSortT | undefined): ZTrackSortT | undefined =>
		sort && sort.column !== 'match' ? sort : undefined;

	// Rekordbox sidecar + importer. Same on/off pattern — disabled when no
	// spawn-spec is supplied (tests, headless CLI). The importer holds onto
	// the sidecar handle across imports; only one import runs at a time.
	let rekordboxSidecar: RekordboxSidecar | null = null;
	let rekordboxImporter: RekordboxImporter | null = null;
	let rekordboxExporter: RekordboxExporter | null = null;
	if (opts.rekordbox) {
		rekordboxSidecar = new RekordboxSidecar(opts.rekordbox);
		rekordboxSidecar.start();
		rekordboxImporter = new RekordboxImporter(db, rekordboxSidecar, () => creditFormat);
		// Exporter shares the same sidecar process — the open() vs
		// open_for_write() distinction on the Python side makes
		// concurrent read+write sessions safe (one mode at a time, last
		// open() wins). Caller-side: importer and exporter serialize via
		// their own `running` flags so we never have both in flight.
		rekordboxExporter = new RekordboxExporter(db, rekordboxSidecar, opts.writeAudit, () => creditFormat);
	}

	// Forward-ref into the constructed `service`, assigned at the end of
	// createCoreService. Used by deleteTracks to call back into the public
	// surface (removeTracksFromPlaylist) after construction. We can't pass
	// `service` directly here because it's declared below.
	let svcRef: CoreService | null = null;

	// ─── Convert to WAV ────────────────────────────────────────────────
	// Output folder lives in app_setting (core gates where it writes, so the
	// value can't be per-renderer-origin — see the app_setting schema note).
	const WAV_OUTPUT_DIR_KEY = 'wav.output_dir';
	const defaultWavDir = normalizePath(opts.wavDefaultOutputDir ?? joinPath(homedir(), 'Music', 'WAV'));
	const loadWavSettings = (): WavSettings => {
		const row = db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, WAV_OUTPUT_DIR_KEY)).get();
		return typeof row?.value === 'string' && row.value
			? { outputDir: row.value, stored: true }
			: { outputDir: defaultWavDir, stored: false };
	};
	let wavSettings = loadWavSettings();
	const wavConverter = new WavConverter({
		db,
		sqlite,
		spec: opts.wavConverter ?? null,
		peaksDir: opts.peaksDir,
		outputDir: () => wavSettings.outputDir,
		ensureWatched: async (dir) => {
			const norm = normalizePath(dir).replace(/\/+$/, '').toLowerCase();
			const folders = db.select({ path: libraryFolder.path }).from(libraryFolder).all();
			const covered = folders.some((f) => {
				const p = f.path.replace(/\/+$/, '').toLowerCase();
				return norm === p || norm.startsWith(`${p}/`);
			});
			if (!covered) await svcRef!.addLibraryFolder(dir);
		},
		recomputeMembership: (trackId) => membership.recomputeForTrack(trackId),
		requestPeaks: (trackIds) => svcRef!.enqueueAnalysis(trackIds, {
			priority: 50,
			analyzeFlags: { beatgrid: false, key: false, segments: false, peaks: true, fingerprint: true, advanced: false },
		}),
		creditFormat: () => creditFormat,
	});

	// ─── Backup & restore ──────────────────────────────────────────────
	// The library id names this library's backup set on the target. It
	// lives in curator.db on purpose: a restored DB carries it along, so the
	// new machine continues the same lineage instead of starting a second one.
	const LIBRARY_ID_KEY = 'library.id';
	const ensureLibraryId = (): string => {
		const row = db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, LIBRARY_ID_KEY)).get();
		if (typeof row?.value === 'string' && row.value) return row.value;
		const id = randomUUID();
		const at = new Date();
		db.insert(appSetting).values({ key: LIBRARY_ID_KEY, value: id, updatedAt: at }).onConflictDoUpdate({ target: appSetting.key, set: { value: id, updatedAt: at } }).run();
		return id;
	};
	// Which heavy background job the backup scheduler should yield to right
	// now (null = idle). The names show up in the Backup tab's "waiting for".
	const heavyJobInFlight = (): string | null => {
		if (analysisQueue?.busy) return 'audio analysis';
		if (wavConverter.isRunning()) return 'WAV conversion';
		if (rekordboxImporter?.isRunning() || rekordboxExporter?.isRunning()) return 'rekordbox sync';
		if (sourceScheduler.anyInFlight()) return 'playlist sync';
		if (mirLayer.isBusy()) return 'AI analysis';
		if (downloadQueue.hasActive()) return 'downloads';
		if (catalogue?.isUploading()) return 'shared analysis upload';
		return null;
	};
	const backupEngineConfig = (): BackupEngineConfig => {
		const b = opts.backup!;
		const dbDir = dbPath === ':memory:' ? b.userDataDir : dirname(dbPath);
		return {
			userDataDir: b.userDataDir,
			dbDir,
			peaksDir: b.peaksDir ?? opts.peaksDir ?? joinPath(b.userDataDir, 'peaks'),
			coversDir: b.coversDir ?? joinPath(b.userDataDir, 'covers'),
			libraryId: ensureLibraryId(),
			hostname: hostname(),
			platform: process.platform,
			appVersion: b.appVersion ?? 'dev',
			rekordboxDbPath: backupService.getSettings().rekordboxDbPath ?? defaultRekordboxDbPath(),
			rekordboxSettingsDir: defaultRekordboxSettingsDir(),
		};
	};
	// The host is built once, lazily, because the engine config reads the
	// backup settings (rekordbox path) which the service below owns.
	let backupHostInstance: BackupHost | null = null;
	const backupHostLazy = (): BackupHost | null => {
		if (!opts.backup) return null;
		if (!backupHostInstance) {
			const google = opts.backup.google;
			backupHostInstance = opts.backup.host
				? opts.backup.host(backupEngineConfig())
				: createInlineBackupHost(backupEngineConfig(), google ? { googleAccessToken: () => google.accessToken() } : {});
		}
		return backupHostInstance;
	};
	const backupService = createBackupService({
		db,
		userDataDir: opts.backup?.userDataDir ?? dirname(dbPath),
		get host() { return backupHostLazy(); },
		engineConfig: backupEngineConfig,
		heavyJobInFlight,
		beforeRun: opts.backup?.beforeRun,
		google: opts.backup?.google ? { status: () => opts.backup!.google!.status(), needsReconnect: () => opts.backup!.google!.needsReconnect() } : undefined,
		rekordbox: {
			available: () => rekordboxSidecar != null,
			detect: () => svcRef!.detectRekordbox(),
			preRestoreCopy: async (rbDbPath) => { await rekordboxSidecar!.backup(rbDbPath); },
		},
		remapLibraryRoot: (from, to) => svcRef!.remapLibraryRoot(from, to),
	});

	// ─── Cloud sync client ─────────────────────────────────────────────
	// Off unless the host injects a transport. The client only moves ops;
	// the membership tier of rows a pull touched is recomputed here, like
	// every other membership-changing writer.
	const cloudClient: SyncClient | null = opts.cloud
		? createSyncClient({
			db: sqlite,
			transport: opts.cloud.transport,
			device: opts.cloud.device,
			pollPolicy: readPollPolicy(sqlite),
			// A fresh device's first sync materialises the whole account
			// (remote rows): one indexed pass beats 40k ids in chunks.
			onApplied: (a) => {
				if (a.tracks.length > 5_000) membership.recomputeAll();
				else if (a.tracks.length > 0) membership.recomputeForTracks(a.tracks);
			},
		})
		: null;
	let cloudWakeUnsub: (() => void) | null = null;
	let cloudActivity: CloudActivityWatcher | null = null;

	// ─── Shared analysis catalogue ─────────────────────────────────────
	// Built only with a sync client, the transport's catalogue procedures
	// and a blob store. It plugs into the analyzer queue (pull-before-compute
	// for background jobs, upload after persist) and fills tracks in on its
	// own from the account's inventory — which needs no analyzer at all.
	const catalogueTransport = opts.cloud?.transport.catalogue;
	const catalogue: CatalogueLayer | null = cloudClient && opts.cloud && catalogueTransport && opts.cloud.blobs
		? createCatalogueLayer({
			db,
			raw: sqlite,
			transport: { catalogue: catalogueTransport, session: () => opts.cloud!.transport.session() },
			blobs: opts.cloud.blobs,
			deviceId: () => cloudClient.deviceId(),
			peaksDir: opts.peaksDir ?? null,
			serverFeatures: () => cloudClient.serverFeatures(),
			busyElsewhere: () => (analysisQueue?.busy ? 'audio analysis' : mirLayer.isBusy() ? 'AI analysis' : null),
			onHydrated: (trackIds) => {
				// A queued background job whose work just arrived is done.
				analysisQueue?.settleSatisfied(trackIds, (id, o) => catalogue!.remaining(id, o));
				cutoffStore.scheduleRecompute();
			},
		})
		: null;
	if (catalogue) {
		analysisQueue?.setCatalogue(catalogue.queueHook);
		// New or re-bound files may be the audio the account already holds.
		libraryScanner.onIngest((evt) => {
			if (evt.outcome === 'created' || evt.outcome === 'matched' || evt.outcome === 'rebound') catalogue.wake('ingest');
		});
		// The sync client learns the server's features on every push/pull:
		// the first answer listing 'catalogue' starts the catalogue's work.
		let offered: boolean | null = null;
		cloudClient!.subscribe((e) => {
			if (e.kind !== 'status') return;
			const now = cloudClient!.serverFeatures()?.includes('catalogue') ?? null;
			if (now !== offered) {
				offered = now;
				if (now) catalogue.wake('features');
			}
		});
	}
	const catalogueStatusReport = (): CatalogueStatus => catalogue
		? catalogue.status()
		: {
			available: false, settings: readCatalogueSettings(sqlite), signedIn: false, serverOffers: null, policy: null,
			entitled: null, usage: null, account: { items: 0, bytes: 0 }, device: { reused: 0, uploaded: 0, pending: null },
			backfill: { state: readCatalogueSettings(sqlite).backfill, uploadedItems: 0, uploadedBytes: 0, waitingFor: null },
			activity: null, lastHydrateAt: null, lastUploadAt: null, lastCheckedAt: null, lastError: null, nextRetryAt: null,
		};

	const accountLibraryInfo = (): AccountLibraryInfo => ({
		masterDeviceId: masterDevice(sqlite),
		remoteOnlyCount: remoteRowCount(sqlite),
		metaSyncAvailable: !!cloudClient && serverReadsTrackMeta(cloudClient.serverFeatures()),
	});
	const cloudStatusReport = (): CloudSyncStatusReport => cloudClient
		? { ...cloudClient.status(), enabled: true }
		: {
			enabled: false, signedIn: false, userId: null, email: null, deviceId: '', pending: 0, rejected: 0,
			lastPushAt: null, lastPullAt: null, lastCheckedAt: null, lastChangedAt: null, transferring: false, lastSeq: 0, lastError: null, needsUpdate: false, revoked: false, boundUserId: null, initialPushDone: false,
			initialPush: null, bootstrap: null, running: false, nextRetryAt: null,
			poll: { policy: readPollPolicy(sqlite), active: true, nextPollAt: null },
		};

	// Shared body of deleteTracks (soft == every source; hard == row DELETE)
	// and removeTrackSources (the Delete dialog's per-source checkboxes). See
	// the CoreService doc comments for the per-source semantics and the
	// tombstone rule. Everything we need is snapshotted BEFORE the first
	// write so the cascade can't pull rows out from under later steps.
	// Best-effort throughout: trash / unlink / playlist push errors are
	// collected into errors[] rather than aborting, so a single broken file
	// doesn't strand a 100-track selection halfway through.
	async function removeSourcesImpl(
		trackIds: string[],
		requested: ReadonlySet<RemovableTrackSource>,
		hard: boolean,
	): Promise<RemoveTrackSourcesResult> {
		const result: RemoveTrackSourcesResult = {
			tombstonedTrackIds: [],
			updated: [],
			filesTrashed: 0,
			peaksRemoved: 0,
			rekordboxTombstoned: 0,
			playlistsTouched: { local: 0, spotify: 0, tidal: 0, rekordbox: 0 },
			linksDropped: { local: 0, spotify: 0, tidal: 0, rekordbox: 0 },
			followedKept: 0,
			errors: [],
		};
		if (trackIds.length === 0) return result;
		const ids = Array.from(new Set(trackIds));

		// ── Snapshot ──────────────────────────────────────────────────────
		const linkRows = chunkedIn(ids, (chunk) => db
			.select({ trackId: sourceLink.trackId, source: sourceLink.source, filePath: sourceLink.filePath, missingAt: sourceLink.missingAt })
			.from(sourceLink)
			.where(inArray(sourceLink.trackId, chunk))
			.all());
		const rbLinks = chunkedIn(ids, (chunk) => db
			.select({ trackId: rekordboxLink.trackId, rbContentId: rekordboxLink.rbContentId })
			.from(rekordboxLink)
			.where(inArray(rekordboxLink.trackId, chunk))
			.all());
		const rbByTrack = new Map(rbLinks.map((l) => [l.trackId, l.rbContentId]));
		// D(t): the removable sources each track has right now.
		const have = new Map<string, Set<RemovableTrackSource>>(ids.map((id) => [id, new Set<RemovableTrackSource>()]));
		for (const l of linkRows) {
			if (l.source === 'local' || l.source === 'spotify' || l.source === 'tidal') have.get(l.trackId)?.add(l.source);
		}
		for (const id of rbByTrack.keys()) have.get(id)?.add('rekordbox');
		const tombstone = new Set<string>(ids.filter((id) => hard || [...have.get(id)!].every((s) => requested.has(s))));
		// Only files still on disk go to the trash — a link flagged missing_at
		// has none (see resolveLocalFile); its row is still dropped in step 4.
		const filePaths = requested.has('local')
			? linkRows.filter((l) => l.source === 'local' && !!l.filePath && l.missingAt == null).map((l) => l.filePath as string)
			: [];

		// Playlist memberships, grouped per playlist so each playlist gets one
		// removeTracksFromPlaylist call (one transaction, one position compact,
		// one upstream push — same shape as the regular remove path).
		const memberships = chunkedIn(ids, (chunk) => db
			.select({ playlistId: playlistTrack.playlistId, trackId: playlistTrack.trackId })
			.from(playlistTrack)
			.where(inArray(playlistTrack.trackId, chunk))
			.all());
		const byPlaylist = new Map<string, Set<string>>();
		for (const m of memberships) {
			const set = byPlaylist.get(m.playlistId) ?? new Set<string>();
			set.add(m.trackId);
			byPlaylist.set(m.playlistId, set);
		}
		const plRows = byPlaylist.size > 0
			? db.select().from(playlist).where(inArray(playlist.id, [...byPlaylist.keys()])).all()
			: [];
		const plById = new Map(plRows.map((p) => [p.id, p]));

		// Peaks to unlink. Analyzer `<trackId>.cpk` belongs to the track, so it
		// goes only with a tombstone; `rb_<contentId>.cpk` goes with the
		// rekordbox link. We don't reuse resolveTrackPeaksPath because we want
		// every variant on disk, not the first hit.
		const peaksPaths: string[] = [];
		if (opts.peaksDir) {
			const { join } = await import('node:path');
			const { existsSync } = await import('node:fs');
			for (const id of ids) {
				const rb = rbByTrack.get(id);
				for (const tier of ['lo', 'hi'] as const) {
					if (tombstone.has(id)) {
						const p = join(opts.peaksDir, tier, `${id}.cpk`);
						if (existsSync(p)) peaksPaths.push(p);
					}
					if (rb && (tombstone.has(id) || requested.has('rekordbox'))) {
						const rp = join(opts.peaksDir, tier, `rb_${rb}.cpk`);
						if (existsSync(rp)) peaksPaths.push(rp);
					}
				}
			}
		}

		// ── 1. Trash files first — recoverable from the OS trash if the user
		//       changes their mind, and a safety net if a later step throws.
		if (opts.trashFile && filePaths.length > 0) {
			for (const p of filePaths) {
				try {
					await opts.trashFile(p);
					result.filesTrashed++;
				} catch (err) {
					result.errors.push({ kind: 'file', source: 'local', message: `${p}: ${err instanceof Error ? err.message : String(err)}` });
				}
			}
		}

		// ── 2. Playlist memberships. A membership goes when:
		//   - the track is being tombstoned and the playlist is one the user can
		//     modify (followed streaming playlists keep it → deleted chip), or
		//   - the playlist's source was requested: owned spotify/tidal playlists
		//     (push upstream — forceUpstream overrides writeSyncAuto, NOT the
		//     ownership boundary) and every rekordbox playlist (curator-side).
		// Local/curator playlists only lose a track that is tombstoned.
		for (const [playlistId, trackIdSet] of byPlaylist) {
			const pl = plById.get(playlistId);
			if (!pl) continue;
			const streaming = pl.source === 'spotify' || pl.source === 'tidal';
			const modifiable = hard || canModifyUpstream(pl);
			const remove: string[] = [];
			for (const tid of trackIdSet) {
				const bySource = (streaming && requested.has(pl.source as RemovableTrackSource))
					|| (pl.source === 'rekordbox' && requested.has('rekordbox'));
				if (tombstone.has(tid) || bySource) {
					if (streaming && !modifiable) result.followedKept++;
					else remove.push(tid);
				}
			}
			if (remove.length === 0) continue;
			try {
				const res = await svcRef!.removeTracksFromPlaylist(playlistId, remove, { forceUpstream: true });
				if (res.removed > 0) {
					const key = (pl.source === 'spotify' || pl.source === 'tidal' || pl.source === 'rekordbox') ? pl.source : 'local';
					result.playlistsTouched[key]++;
				}
			} catch (err) {
				const source = streaming ? (pl.source as RemovableTrackSource) : pl.source === 'rekordbox' ? 'rekordbox' : undefined;
				result.errors.push({ kind: 'playlist', source, message: `${playlistId}: ${err instanceof Error ? err.message : String(err)}` });
			}
		}

		// ── 3. Peaks — derived data, no need to trash.
		if (peaksPaths.length > 0) {
			const { unlink } = await import('node:fs/promises');
			for (const p of peaksPaths) {
				try {
					await unlink(p);
					result.peaksRemoved++;
				} catch (err) {
					const e = err as NodeJS.ErrnoException;
					if (e?.code !== 'ENOENT') result.errors.push({ kind: 'peaks', message: `${p}: ${e?.message ?? String(err)}` });
				}
			}
		}

		// ── 4. Rekordbox: tombstone the content so a later rb re-add resolves
		//       to "remove from rekordbox" rather than resurrecting the track,
		//       then drop the link so an inbound merge can't resurrect
		//       membership through a dangling back-reference.
		const rbDrop = ids.filter((id) => rbByTrack.has(id) && (tombstone.has(id) || requested.has('rekordbox')));
		for (const id of rbDrop) {
			const res = db.insert(rekordboxDeletedContent)
				.values({ rbContentId: rbByTrack.get(id)!, deletedAt: new Date() })
				.onConflictDoNothing()
				.run();
			result.rekordboxTombstoned += res.changes ?? 0;
		}
		if (rbDrop.length > 0 && !hard) {
			chunkedRun(rbDrop, (chunk) => {
				const res = db.delete(rekordboxLink).where(inArray(rekordboxLink.trackId, chunk)).run();
				result.linksDropped.rekordbox += res.changes ?? 0;
			});
		}

		// ── 5. Source links. Local goes whenever requested (the file is in the
		//       trash — the pointer is a 404). Streaming links go only on
		//       SURVIVING rows; tombstoned rows keep them (see the doc comment).
		//       The hard path's cascade removes everything anyway.
		if (!hard) {
			if (requested.has('local')) {
				chunkedRun(ids, (chunk) => {
					const res = db.delete(sourceLink)
						.where(and(eq(sourceLink.source, 'local'), inArray(sourceLink.trackId, chunk)))
						.run();
					result.linksDropped.local += res.changes ?? 0;
				});
			}
			const survivors = ids.filter((id) => !tombstone.has(id));
			for (const src of ['spotify', 'tidal'] as const) {
				if (!requested.has(src) || survivors.length === 0) continue;
				chunkedRun(survivors, (chunk) => {
					const res = db.delete(sourceLink)
						.where(and(eq(sourceLink.source, src), inArray(sourceLink.trackId, chunk)))
						.run();
					result.linksDropped[src] += res.changes ?? 0;
				});
			}
		}

		// ── 6. The row: DELETE (hard — cascade drops source_link,
		//       playlist_track, trackTag, cue, trackAnalysis, analysisJob,
		//       rekordboxLink; download_job has no FK — known v1 limitation) or
		//       tombstone (soft — `isNull` guard keeps a re-delete idempotent).
		const toTombstone = [...tombstone];
		if (hard) {
			// The cascade takes the rows' playlist memberships with it; the
			// survivors' positions are restamped so the playlists stay 0..n-1.
			const touchedPlaylists = new Set(chunkedIn(toTombstone, (chunk) => db
				.selectDistinct({ playlistId: playlistTrack.playlistId })
				.from(playlistTrack)
				.where(inArray(playlistTrack.trackId, chunk))
				.all()).map((r) => r.playlistId));
			sqlite.transaction(() => {
				// The cascade takes tags and cues with the row: state their
				// removal (and the delete) before it, in the same transaction.
				mut.emitHardDelete(db, toTombstone);
				chunkedRun(toTombstone, (chunk) => {
					db.delete(track).where(inArray(track.id, chunk)).run();
				});
				for (const pid of touchedPlaylists) recomputePositions(sqlite, pid);
			})();
			result.tombstonedTrackIds = toTombstone;
		} else if (toTombstone.length > 0) {
			// library_track delete per stamped row. The mutator also clears the
			// materialized tier alongside the tombstone — a deleted track is
			// not-in-library regardless of its old tier, and the recompute
			// skips deleted rows so it won't be re-set. Already-deleted rows
			// are left alone, which keeps a re-delete idempotent.
			result.tombstonedTrackIds = mut.softDeleteTracks(db, toTombstone);
		}

		// Engine vectors go with the row (re-embedded automatically if the
		// track is ever restored — pending work is derived, not queued).
		if (result.tombstonedTrackIds.length > 0) mirLayer.onTracksDeleted(result.tombstonedTrackIds);

		// ── 7. Survivors: a dropped local link or playlist row can change the
		//       membership tier; hand back decorated rows with fresh `sources`.
		const survivors = ids.filter((id) => !tombstone.has(id));
		if (survivors.length > 0) {
			membership.recomputeForTracks(survivors);
			const rows = chunkedIn(survivors, (chunk) => db.select().from(track).where(inArray(track.id, chunk)).all());
			result.updated = decorateTracks(db, cutoffStore, rows.map(applyOverrides));
		}
		return result;
	}

	// Process-life cache of rb's cue palette. The palette is static for a
	// given rb sidecar version; we pay one RPC roundtrip per launch.
	let cuePaletteCache: CuePaletteEntry[] | null = null;

	// Stamp the track row as "user has authoritatively edited cues here in
	// Curator." Bumps `updatedAt` (mirrors every other peripheral mutator)
	// and sets `cuesEditedAt` once-and-forever to flip the rekordbox
	// exporter's empty-cues guard for this track. Idempotent: re-stamping
	// just refreshes updatedAt.
	function markCuesEdited(trackId: string): void {
		const now = new Date();
		db.update(track).set({ updatedAt: now, cuesEditedAt: now }).where(eq(track.id, trackId)).run();
	}

	const service: CoreService = {
		auth,
		// Manual sync goes through the scheduler's wrapper so:
		//   • An auto-tick can't fire concurrently (inFlight mutex).
		//   • The next auto-tick is N minutes from THIS run's completion,
		//     not from the previous scheduled boundary — so clicking
		//     "Sync now" at 4:59 doesn't trigger another sync at 5:00.
		runSpotifySync: async (progress, opts) => {
			assertStreamingReadOpen('Spotify');
			// A sync rewrites owned/followed playlists + Liked Songs + their
			// playlist_track rows — the biggest membership-churn site. Recompute
			// the whole table once at the tail (one indexed pass; also self-heals
			// any drift) rather than tracking per-playlist deltas.
			return sourceScheduler.aroundExternalRun('spotify', () => spotifySync.run(progress, opts))
				.then((r) => { membership.recomputeAll(); albumEnricher.kick(); return r; });
		},
		planSpotifySync: () => spotifySync.planRun(),
		runSpotifyPlaylistSync: async (playlistId, progress, opts) => {
			assertStreamingReadOpen('Spotify');
			return sourceScheduler.aroundExternalRun('spotify', () => spotifySync.runSinglePlaylist(playlistId, progress, opts))
				.then((r) => { membership.recomputeAll(); return r; });
		},
		// Same scheduler mutex + membership recompute shape as the Spotify
		// pair above — Tidal is just another membership-churn site.
		runTidalSync: async (progress, opts) => {
			assertStreamingReadOpen('Tidal');
			return sourceScheduler.aroundExternalRun('tidal', () => tidalSync.run(progress, opts))
				.then((r) => { membership.recomputeAll(); return r; });
		},
		runTidalPlaylistSync: async (playlistId, progress, opts) => {
			assertStreamingReadOpen('Tidal');
			return sourceScheduler.aroundExternalRun('tidal', () => tidalSync.runSinglePlaylist(playlistId, progress, opts))
				.then((r) => { membership.recomputeAll(); return r; });
		},
		enrichBeatportPlaylist: (playlistId, progress, sort) => spotifySync.enrichBeatportPlaylist(playlistId, progress, sort),
		enrichBeatportTrack: (trackId, progress) => spotifySync.enrichBeatportTrack(trackId, progress),
		enrichBeatportTracks: (trackIds, progress) => spotifySync.enrichBeatportTracks(trackIds, progress),
		matchTidalForTrack: (trackId) => tidalHybrid.matchOne(trackId),
		matchTidalForTracks: (trackIds, progress) => tidalHybrid.matchMany(trackIds, progress),
		setPlaylistHybridTidal: (playlistId, enabled, progress, sort) => tidalHybrid.setPlaylistHybrid(playlistId, enabled, progress, sort),
		async cancelEnrichment() { cancelToken.request(); },

		async hasTidalDownloadSession() { return auth.hasTidalSession(); },
		async downloadTidalTrack(trackId, progress) { return tidalDownloader.downloadTrack(trackId, progress); },
		async enqueueTidalDownloads(items) { downloadQueue.enqueue(items); },
		async retryTidalDownload(trackId) { downloadQueue.retry(trackId); },
		async getDownloadQueue() { return downloadQueue.getJobs(); },
		async getDownloadSummary() { return downloadQueue.getSummary(); },
		async clearCompletedDownloads() { downloadQueue.clearCompleted(); },
		async clearAllDownloads() { downloadQueue.clearAll(); },
		async redownloadTidalTrack(trackId) { await downloadQueue.redownload(trackId, { deleteFile: true }); },
		async verifyDownloads() { return downloadQueue.verify(); },
		async getDownloadDir() { return (await import('./config.download.js')).downloadConfig.dir; },
		subscribeDownloadQueue(cb) { return downloadQueue.onUpdate(cb); },

		async getTrackCoverUrl(trackId) {
			const row = db.select({ coverUrl: track.coverUrl }).from(track).where(eq(track.id, trackId)).get();
			if (row?.coverUrl) return row.coverUrl;

			// Fallback: dig into source_link.payload for Spotify tracks. After
			// the cover_url column was added, existing rows are still null
			// until next sync — which skips on snapshot_id match. Reading the
			// already-saved Spotify track JSON avoids forcing a resync.
			const link = db
				.select({ payload: sourceLink.payload })
				.from(sourceLink)
				.where(and(eq(sourceLink.trackId, trackId), eq(sourceLink.source, 'spotify')))
				.get();
			const payload = link?.payload as { album?: { images?: { url?: string }[] } } | null;
			const url = payload?.album?.images?.[0]?.url ?? null;
			if (url) {
				// Backfill so subsequent reads skip the JSON walk entirely.
				db.update(track).set({ coverUrl: url, updatedAt: new Date() }).where(eq(track.id, trackId)).run();
			}
			return url;
		},

		async extractLocalCover(trackId) {
			// Resolve the local file path through the same source_link lookup
			// the playback path uses. Returns null when the track has no live
			// `source='local'` link (missing_at: see resolveLocalFile).
			const row = db
				.select({ filePath: sourceLink.filePath })
				.from(sourceLink)
				.where(and(eq(sourceLink.source, 'local'), eq(sourceLink.trackId, trackId), isNull(sourceLink.missingAt)))
				.get();
			if (!row?.filePath) return null;

			// Lazy-import music-metadata so the (modest) startup cost of
			// loading parser plugins is paid only when a cover request lands
			// for a local file with no remote URL. Cached by Node's module
			// system after the first call.
			try {
				const { parseFile } = await import('music-metadata');
				const meta = await parseFile(row.filePath, { duration: false });
				const pic = meta.common.picture?.[0];
				if (!pic?.data || pic.data.length === 0) return null;
				// `pic.data` is a Uint8Array (newer music-metadata versions
				// dropped the Buffer alias). Coerce to Uint8Array so the IPC
				// surface is structured-clone friendly even when the caller
				// runs in a renderer.
				const data = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data as ArrayLike<number>);
				return { data, format: pic.format || 'image/jpeg' };
			} catch (err) {
				log.for('cover').warn('embedded-art extract failed', { trackId }, err);
				return null;
			}
		},

		async resolveTrackPeaksPath(trackId, tier) {
			if (!opts.peaksDir) return null;
			const { join } = await import('node:path');
			const { existsSync } = await import('node:fs');
			// Analyzer-generated file uses the canonical track UUID — checked
			// first because Essentia output is deterministic and we always
			// prefer our own analysis when both are available.
			const analyzerPath = join(opts.peaksDir, tier, `${trackId}.cpk`);
			if (existsSync(analyzerPath)) return analyzerPath;
			// Fallback: rekordbox-imported file keyed on the rekordbox content
			// id. rekordbox_link is the bridge from our trackId → rb id.
			const link = db
				.select({ rbContentId: rekordboxLink.rbContentId })
				.from(rekordboxLink)
				.where(eq(rekordboxLink.trackId, trackId))
				.get();
			if (link?.rbContentId) {
				const rbPath = join(opts.peaksDir, tier, `rb_${link.rbContentId}.cpk`);
				if (existsSync(rbPath)) return rbPath;
			}
			return null;
		},

		async getTrackSourceLinks(trackId) {
			// Every id per provider, the primary first: own links (the most
			// recently fetched first), then the claim-derived ones in rank order
			// (claim-links.ts). Open-in and the Edit field take the first of a
			// provider; the Edit screen lists the rest.
			const own = sqlite.prepare(`SELECT source, source_track_id AS sourceTrackId, url FROM source_link WHERE track_id = ?
				ORDER BY source, fetched_at IS NULL, fetched_at DESC, id`).all(trackId) as Array<{ source: string; sourceTrackId: string; url: string | null; derived?: boolean }>;
			// An own link replaces the derived one of its id when it lands
			// (migrate.ts trigger); the filter only guards a read racing that.
			const ownIds = new Set(own.map((l) => `${l.source}\u0000${l.sourceTrackId}`));
			for (const l of claimLinksOf(sqlite, [trackId]).get(trackId) ?? []) {
				if (ownIds.has(`${l.source}\u0000${l.sourceTrackId}`)) continue;
				own.push({ source: l.source, sourceTrackId: l.sourceTrackId, url: claimLinkUrl(l.source, l.sourceTrackId), derived: true });
			}
			return own;
		},

		async setTrackOverrides(trackId, patch) {
			const row = db.select({ overrides: track.overrides, artists: track.artists, title: track.title }).from(track).where(eq(track.id, trackId)).get();
			if (!row) return null;
			const next: Record<string, unknown> = { ...(row.overrides ?? {}) };
			for (const [k, v] of Object.entries(patch)) {
				if (v === null || v === undefined) delete next[k];
				else next[k] = v;
			}
			if (Array.isArray(next['artists'])) {
				// Effective title (the override the user may be setting in the
				// same patch wins) drives the remixer read.
				const title = typeof next['title'] === 'string' ? next['title'] : row.title;
				next['artists'] = normalizeIncomingArtists(db, next['artists'] as TrackArtist[], { title });
			}
			const finalOverrides = Object.keys(next).length > 0 ? (next as TrackOverrides) : null;
			// One set-override op per field that actually changed, in the
			// write's transaction (library/mutators.ts).
			mut.recordTrackStateChanges(db, [trackId], () => {
				// artists_ascii mirrors the EFFECTIVE list so search finds the
				// overridden spelling, not the canonical one it shadows.
				const set: Record<string, unknown> = { overrides: finalOverrides, updatedAt: new Date() };
				if ('artists' in patch) set['artistsAscii'] = asciifyArtists(finalOverrides?.artists ?? row.artists);
				db.update(track).set(set).where(eq(track.id, trackId)).run();
				if ('artists' in patch) syncTrackArtistsById(db, [trackId]);
				// An album-title override moves the track to that release; an
				// artist edit can change which release a derived album key names.
				if ('albumTitle' in patch || 'artists' in patch) syncTrackAlbumsById(db, [trackId]);
			});
			const updated = db.select().from(track).where(eq(track.id, trackId)).get();
			return updated ? decorateTracks(db, cutoffStore, [applyOverrides(updated)])[0]! : null;
		},

		async setTrackSourceLinks(trackId, urls) {
			const updated: string[] = [];
			const refetched: string[] = [];
			const errors: SourceLinkError[] = [];
			const t = db.select().from(track).where(eq(track.id, trackId)).get();
			if (!t) return { updated, refetched, errors: [{ source: 'track', message: 'Track not found' }] };

			const upsert = (source: 'spotify' | 'tidal' | 'beatport', srcId: string, fullUrl: string): boolean => {
				// Guard the UNIQUE(source, source_track_id) index: an external
				// track maps to exactly one library track. If THIS id is already
				// claimed by a *different* track, assigning it here would collide —
				// surface it instead of letting SQLite throw a raw constraint error.
				const owner = db
					.select({ trackId: sourceLink.trackId })
					.from(sourceLink)
					.where(and(eq(sourceLink.source, source), eq(sourceLink.sourceTrackId, srcId)))
					.get();
				if (owner && owner.trackId !== trackId) {
					errors.push({
						source,
						message: `That ${source} track is already linked to another library track`,
						code: 'already-linked',
						conflictTrackId: owner.trackId,
					});
					return false;
				}
				const existing = db
					.select({ id: sourceLink.id })
					.from(sourceLink)
					.where(and(eq(sourceLink.trackId, trackId), eq(sourceLink.source, source)))
					.get();
				if (existing) {
					db.update(sourceLink)
						.set({ sourceTrackId: srcId, url: fullUrl, fetchedAt: new Date() })
						.where(eq(sourceLink.id, existing.id))
						.run();
				} else {
					db.insert(sourceLink).values({
						id: randomUUID(),
						trackId,
						source,
						sourceTrackId: srcId,
						url: fullUrl,
						isrcLocal: null,
						titleLocal: null,
						artistsLocal: null,
						albumLocal: null,
						durationLocal: null,
						bpmLocal: null,
						keyLocal: null,
						payload: null,
						fetchedAt: new Date(),
					}).run();
				}
				updated.push(source);
				// The user's pick is the account's claim for the row's recording
				// (an anchor, like a provider-id mint), so the account's other
				// devices show it too (sync-log/claim-links.ts). A no-op when the
				// records already hold it.
				mut.addClaims(db, trackId, [{ kind: source, value: srcId, confidence: 1 }]);
				return true;
			};

			// Spotify URL is link-only — no per-track endpoint plumbed yet, so
			// we just record the link without refetching attributes.
			if (urls.spotify && urls.spotify.trim()) {
				const id = parseSpotifyTrackId(urls.spotify);
				if (!id) errors.push({ source: 'spotify', message: 'Could not parse Spotify track id from URL' });
				else upsert('spotify', id, `https://open.spotify.com/track/${id}`);
				// (link-only — nothing to refetch; upsert's return is unused here)
			}

			// Tidal URL: trust the user's explicit pick (no length/title matching).
			// Fetch the chosen track by id and update canonical fields the user
			// hasn't overridden — same shape as the Beatport flow below.
			if (urls.tidal && urls.tidal.trim()) {
				const id = parseTidalTrackId(urls.tidal);
				if (!id) {
					errors.push({ source: 'tidal', message: 'Could not parse Tidal track id from URL' });
				} else if (upsert('tidal', id, `https://tidal.com/browse/track/${id}`)) {
					try {
						const token = await auth.getTidalAccessToken();
						if (!token) {
							errors.push({ source: 'tidal', message: 'Tidal not connected — link saved, metadata not fetched' });
						} else {
							const countryCode = auth.getTidalCountryCode() ?? 'US';
							const client = new TidalApiClient(config.tidal.apiBase, async () => token, countryCode);
							const td = await client.getTrackById(id);
							if (!td) {
								errors.push({ source: 'tidal', message: `Tidal track ${id} not found in catalog` });
							} else {
								const o = (t.overrides ?? {}) as Partial<Record<string, unknown>>;
								const patch: Record<string, unknown> = {};
								// BPM: only fill when canonical is empty. An
								// analyzer-measured value beats Tidal's catalog
								// value, and a user override beats both.
								if (td.bpm != null && o.bpm === undefined && t.bpm == null) patch['bpm'] = td.bpm;
								// Tidal v2 key is in scale-agnostic form ("C", "FSharp" etc.)
								// — leave musical/camelot alone unless we can map it.
								// Canonical ISRC only (the indexed column keys identity);
								// the verbatim value stays in the link payload.
								const tdIsrc = normalizeIsrc(td.isrc);
								if (tdIsrc && !t.isrc) patch['isrc'] = tdIsrc;
								// updatedAt only with a real change — it marks the row
								// edited for the rekordbox "Sync updates" selection.
								if (Object.keys(patch).length > 0) {
									patch['updatedAt'] = new Date();
									db.update(track).set(patch).where(eq(track.id, trackId)).run();
								}
								// Update source_link with the real metadata too.
								db.update(sourceLink)
									.set({
										isrcLocal: tdIsrc,
										titleLocal: td.title,
										durationLocal: td.duration,
										bpmLocal: td.bpm,
										keyLocal: td.key,
										payload: td as unknown,
										fetchedAt: new Date(),
									})
									.where(and(eq(sourceLink.trackId, trackId), eq(sourceLink.source, 'tidal')))
									.run();
								refetched.push('tidal');
							}
						}
					} catch (err) {
						errors.push({ source: 'tidal', message: err instanceof Error ? err.message : String(err) });
					}
				}
			}

			// Beatport URL: same trust-user pattern, with the existing fetchById
			// path. Errors surface to the renderer instead of being swallowed.
			if (urls.beatport && urls.beatport.trim()) {
				const id = parseBeatportTrackId(urls.beatport);
				if (!id) {
					errors.push({ source: 'beatport', message: 'Could not parse Beatport track id from URL' });
				} else if (upsert('beatport', String(id), `https://www.beatport.com/track/-/${id}`)) {
					try {
						const client = new BeatportClient({ fetchImpl: opts.beatportFetch });
						const bp = await client.fetchById(id);
						if (!bp) {
							errors.push({ source: 'beatport', message: `Beatport track ${id} not found or page parse failed` });
						} else {
							const o = (t.overrides ?? {}) as Partial<Record<string, unknown>>;
							const patch: Record<string, unknown> = {};
							// BPM/key: only fill when the canonical value is empty.
							// Analyzer-measured BPM/key beat Beatport's catalog
							// values, and an explicit user override beats both.
							if (bp.bpm != null && o.bpm === undefined && t.bpm == null) patch['bpm'] = bp.bpm;
							if (bp.key && o.keyCamelot === undefined && t.keyCamelot == null) {
								const cam = keyToCamelot(bp.key);
								if (cam) patch['keyCamelot'] = cam;
							}
							// Genre/label have no local source of truth — let
							// Beatport fill them unless the user has overridden.
							if (bp.genre && o.genre === undefined && bp.genre !== t.genre) patch['genre'] = bp.genre;
							if (bp.label && o.label === undefined && bp.label !== t.label) patch['label'] = bp.label;
							// updatedAt only with a real change — it marks the row
							// edited for the rekordbox "Sync updates" selection.
							if (Object.keys(patch).length > 0) {
								patch['updatedAt'] = new Date();
								db.update(track).set(asciify(patch)).where(eq(track.id, trackId)).run();
							}
							// Also refresh the source_link's local cache so the UI's
							// "what does Beatport say" view stays current.
							db.update(sourceLink)
								.set({
									isrcLocal: normalizeIsrc(bp.isrc),
									titleLocal: bp.title,
									durationLocal: bp.duration,
									bpmLocal: bp.bpm,
									keyLocal: bp.key,
									payload: bp as unknown,
									fetchedAt: new Date(),
								})
								.where(and(eq(sourceLink.trackId, trackId), eq(sourceLink.source, 'beatport')))
								.run();
							refetched.push('beatport');
						}
					} catch (err) {
						errors.push({ source: 'beatport', message: err instanceof Error ? err.message : String(err) });
					}
				}
			}

			return { updated, refetched, errors };
		},
		async deleteTrackSourceLink(trackId, source) {
			// Idempotent — silently no-ops if the row doesn't exist. Used by the
			// Edit Track modal's per-field reset button to drop a Spotify/Tidal/
			// Beatport link without touching other source_links or canonical
			// fields. Refetched data already on the canonical track stays put.
			// One transaction: the own links' delete trigger vetoes each id and
			// may queue a re-derive, and every derived id of the provider the
			// user cleared is dismissed for this row (claim_link_veto, per id)
			// — claims are append-only, so they would otherwise come straight
			// back, and none may stand in for the cleared field.
			sqlite.transaction(() => {
				db.delete(sourceLink)
					.where(and(eq(sourceLink.trackId, trackId), eq(sourceLink.source, source)))
					.run();
				dismissClaimLink(sqlite, trackId, source);
			})();
		},
		async previewTrackMerge(aId, bId) {
			const rows = await svcRef!.getTracks({ ids: [aId, bId] });
			const ta = rows.find((t) => t.id === aId);
			const tb = rows.find((t) => t.id === bId);
			if (!ta || !tb) throw new Error('One of the tracks no longer exists');
			const a = describeMergeSide(db, ta);
			const b = describeMergeSide(db, tb);
			return {
				a, b,
				suggestedKeepId: suggestKeepId(a, b),
				plans: { [aId]: planTrackMerge(db, aId, bId), [bId]: planTrackMerge(db, bId, aId) },
			};
		},
		async mergeTracks(keepId, dropId) {
			const res = applyTrackMerge(db, sqlite, keepId, dropId);
			const errors: string[] = [];
			// Peaks sidecars are keyed by track id: when drop's analysis row
			// became keep's, its .cpk files follow; otherwise drop's are dead.
			let peaksMoved = 0;
			if (opts.peaksDir) {
				const { existsSync } = await import('node:fs');
				const { rename, unlink } = await import('node:fs/promises');
				for (const tier of ['lo', 'hi'] as const) {
					const from = joinPath(opts.peaksDir, tier, `${dropId}.cpk`);
					if (!existsSync(from)) continue;
					const to = joinPath(opts.peaksDir, tier, `${keepId}.cpk`);
					try {
						if (res.analysisTakenFromDrop) {
							if (existsSync(to)) await unlink(to);
							await rename(from, to);
							peaksMoved++;
						} else {
							await unlink(from);
						}
					} catch (err) {
						errors.push(`peaks ${tier}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
			}
			try {
				await feedStore.repointPromotedTrack(dropId, keepId);
			} catch (err) {
				errors.push(`feed: ${err instanceof Error ? err.message : String(err)}`);
			}
			// Engine vectors follow track identity like the .cpk files above.
			try { mirLayer.onTrackMerged(dropId, keepId); }
			catch (err) { errors.push(`mir: ${err instanceof Error ? err.message : String(err)}`); }
			membership.recomputeForTrack(keepId);
			const [survivor] = await svcRef!.getTracks({ ids: [keepId] });
			if (!survivor) throw new Error('Merged track vanished');
			log.for('merge-tracks').info('tracks merged', { keepId, dropId, tagsAdded: res.tagsAdded, membershipsMoved: res.membershipsMoved, linksMoved: res.linksMoved, analysis: res.analysis });
			return { ...res, survivor, peaksMoved, errors };
		},
		async clearTrackFields(trackId, fields) {
			const row = db
				.select({ overrides: track.overrides })
				.from(track)
				.where(eq(track.id, trackId))
				.get();
			if (!row) return null;

			// Drop the override keys for every requested field.
			const nextOverrides: Record<string, unknown> = { ...(row.overrides ?? {}) };
			for (const f of fields) delete nextOverrides[f];
			const finalOverrides = Object.keys(nextOverrides).length > 0
				? (nextOverrides as TrackOverrides)
				: null;

			// Null the canonical column for nullable fields. `title` and `artists`
			// are NOT NULL — leave the canonical alone for those (override removal
			// is the only effect).
			const patch: Record<string, unknown> = { overrides: finalOverrides, updatedAt: new Date() };
			for (const f of fields) {
				if (f === 'title' || f === 'artists') continue;
				patch[f] = null;
			}
			// The cleared overrides travel as set-override(null) ops; the
			// canonical columns nulled here are catalogue data and do not.
			mut.recordTrackStateChanges(db, [trackId], () => {
				// asciify mirrors any cleared searchable field (albumTitle/label/
				// genre) onto its *_ascii column so search results don't lag behind.
				db.update(track).set(asciify(patch)).where(eq(track.id, trackId)).run();
				if (fields.includes('artists')) {
					// The effective list fell back to canonical — re-mirror and
					// re-derive the artist rows from it.
					const canon = db.select({ artists: track.artists }).from(track).where(eq(track.id, trackId)).get();
					db.update(track).set({ artistsAscii: asciifyArtists(canon?.artists ?? []) }).where(eq(track.id, trackId)).run();
					syncTrackArtistsById(db, [trackId]);
				}
				if (fields.includes('albumTitle') || fields.includes('artists')) syncTrackAlbumsById(db, [trackId]);
			});
			const updated = db.select().from(track).where(eq(track.id, trackId)).get();
			return updated ? decorateTracks(db, cutoffStore, [applyOverrides(updated)])[0]! : null;
		},
		async getLibraryFieldOptions() {
			// One DISTINCT scan per column over live rows. `genre`/`label` are
			// plain text columns (no unique index), so this is a table scan —
			// cheap at personal-library scale and only run when the editor opens.
			const distinct = (col: typeof track.genre | typeof track.label): string[] => {
				const cmp = (a: string, b: string) =>
					a.localeCompare(b, undefined, { sensitivity: 'base' });
				return db.selectDistinct({ v: col })
					.from(track)
					.where(and(isNotNull(col), isNull(track.deletedAt)))
					.all()
					.map((r) => (r.v ?? '').trim())
					.filter((v) => v !== '')
					.sort(cmp);
			};
			return { genres: distinct(track.genre), labels: distinct(track.label) };
		},
		async setRating(trackIds, rating) {
			if (trackIds.length === 0) return [];
			// Clamp into the Rekordbox 0..5 domain; null is the "no rating"
			// state. Bad values from the wire become null rather than a half-
			// applied write that would silently de-rate every selected track.
			const clamped = rating == null
				? null
				: Math.max(0, Math.min(5, Math.round(rating)));
			mut.setRating(db, trackIds, clamped);
			const rows = chunkedIn(trackIds, (chunk) => db.select().from(track).where(inArray(track.id, chunk)).all());
			// Return fully-decorated rows: the renderer patches these straight
			// into visible tracklist rows (commitRating → patchOne), so a bare
			// applyOverrides row (no `sources`) would blank the SRC pips.
			return decorateTracks(db, cutoffStore, rows.map(applyOverrides));
		},
		async deleteTracks(trackIds, deleteOpts) {
			// Soft == every removable source (removeSourcesImpl's tombstone rule
			// then tombstones every row); hard == the cascade burn used by feed
			// un-promotion. Result reshaped to the original contract.
			const r = await removeSourcesImpl(trackIds, new Set(REMOVABLE_TRACK_SOURCES), deleteOpts?.hard === true);
			const t = r.playlistsTouched;
			return {
				deletedTracks: r.tombstonedTrackIds.length,
				filesTrashed: r.filesTrashed,
				peaksRemoved: r.peaksRemoved,
				playlistsTouched: t.local + t.spotify + t.tidal + t.rekordbox,
				errors: r.errors.map(({ kind, message }) => ({ kind, message })),
			};
		},
		async undeleteTracks(trackIds) {
			const restored = mut.undeleteTracks(db, [...new Set(trackIds)]);
			// Deleted rows carry no tier (softDeleteTracks clears it); a file
			// bound while deleted makes the row local again.
			if (restored.length > 0) membership.recomputeForTracks(restored);
			return { restored };
		},
		async listDeletedTracks() {
			// The correlated subqueries name `track.id` literally: drizzle prints
			// a single-table column bare ("id"), which inside a subquery over a
			// table with its own id column binds to that table instead.
			const rows = db
				.select({
					id: track.id, title: track.title, artists: track.artists, overrides: track.overrides,
					deletedAt: track.deletedAt, derivedFrom: track.derivedFromTrackId,
					merged: sql<number>`EXISTS (SELECT 1 FROM recording_alias ra WHERE ra.loser = track.recording_id)`,
					sources: sql<string | null>`(SELECT group_concat(DISTINCT s.source) FROM source_link s WHERE s.track_id = track.id)`,
					rb: sql<number>`EXISTS (SELECT 1 FROM rekordbox_link r WHERE r.track_id = track.id)`,
					tags: sql<number>`(SELECT count(*) FROM track_tag x WHERE x.track_id = track.id)`,
					playlists: sql<number>`(SELECT count(DISTINCT pt.playlist_id) FROM playlist_track pt WHERE pt.track_id = track.id)`,
				})
				.from(track)
				.where(and(isNotNull(track.deletedAt), isNull(track.purgedAt)))
				.orderBy(desc(track.deletedAt))
				.all();
			return rows.map((r): DeletedTrack => {
				const sources = r.sources ? r.sources.split(',') : [];
				if (r.rb) sources.push('rekordbox');
				return {
					trackId: r.id,
					title: effectiveTitle(r, creditFormat),
					artist: effectiveArtistName(r, creditFormat),
					deletedAt: r.deletedAt!.getTime(),
					cause: r.derivedFrom ? 'wav-copy' : r.merged ? 'merged' : 'deleted',
					sources: sources.sort(),
					tags: r.tags,
					playlists: r.playlists,
				};
			});
		},
		async purgeDeletedTracks(trackIds) {
			return { purged: mut.purgeDeletedTracks(db, [...new Set(trackIds)]) };
		},
		async removeTrackSources(trackIds, sources) {
			const requested = new Set(sources.filter((s): s is RemovableTrackSource => (REMOVABLE_TRACK_SOURCES as readonly string[]).includes(s)));
			if (requested.size === 0) throw new Error('No sources selected');
			return removeSourcesImpl(trackIds, requested, false);
		},
		async getTracksPage(filter, sort, req): Promise<TrackPage> {
			const limit = Math.min(Math.max(req?.limit ?? 1000, 1), 5000);
			const offset = Math.max(req?.offset ?? 0, 0);
			const sim = await resolveSimilar(filter);
			if (sim) {
				// At most k (<= 500) rows: fetch all, order in memory, slice.
				if (sim.score.size === 0) return { items: [], total: 0, nextCursor: null };
				const all = orderByMatch(getTracksImpl(db, cutoffStore, sim.filter, sqlSort(sort), 5000, 0, isFollowedPlaylist), sim, sort);
				return { items: all.slice(offset, offset + limit), total: all.length, nextCursor: null };
			}
			const items = getTracksImpl(db, cutoffStore, filter, sort, limit, offset, isFollowedPlaylist);
			// A page that didn't fill ends the result — total is known without a
			// COUNT (covers playlists, tag views, searches under one page, and the
			// last page of a large scope). Only a full page needs the real count.
			const total = items.length < limit
				? offset + items.length
				: countTracksImpl(db, filter, isFollowedPlaylist);
			return { items, total, nextCursor: null };
		},

		async getTrackIds(filter, sort) {
			const sim = await resolveSimilar(filter);
			if (sim) {
				if (sim.score.size === 0) return [];
				return orderByMatch(getTracksImpl(db, cutoffStore, sim.filter, sqlSort(sort), 5000, 0, isFollowedPlaylist), sim, sort).map((t) => t.id);
			}
			// Cap well above any real list but below the 50k unbounded-load shape.
			return getTrackIdsImpl(db, filter, sort, 200_000, isFollowedPlaylist);
		},

		async getTracks(filter, sort, limit = 50000, offset = 0) {
			const sim = await resolveSimilar(filter);
			if (sim) {
				if (sim.score.size === 0) return [];
				return orderByMatch(getTracksImpl(db, cutoffStore, sim.filter, sqlSort(sort), 5000, 0, isFollowedPlaylist), sim, sort).slice(offset, offset + limit);
			}
			return getTracksImpl(db, cutoffStore, filter, sort, limit, offset, isFollowedPlaylist);
		},

		async getPlaylists() {
			return db
				.select()
				.from(playlist)
				.where(eq(playlist.isHidden, false))
				.orderBy(asc(playlist.createdAt))
				.all();
		},

		async getTrackPlaylists(trackId) {
			// One join to find the playlists; a second SELECT pulls the folder
			// tree slice we need to walk parent chains in-memory. Avoids N
			// recursive CTEs (one per playlist) when a track sits across many
			// playlists with deep folder ancestry.
			const rows = db
				.select({ pl: playlist })
				.from(playlist)
				.innerJoin(playlistTrack, eq(playlistTrack.playlistId, playlist.id))
				.where(and(eq(playlistTrack.trackId, trackId), eq(playlist.isHidden, false)))
				.all();
			if (rows.length === 0) return [];

			// Pull only the folders for the sources actually represented in the
			// track's playlists. Folder count is small enough across all sources
			// (~hundreds at most for power users) that a per-source filter is
			// already plenty selective.
			const sources = Array.from(new Set(rows.map((r) => r.pl.source)));
			const allFolders = db
				.select()
				.from(playlistFolder)
				.where(inArray(playlistFolder.source, sources as PlaylistSource[]))
				.all();
			const folderById = new Map(allFolders.map((f) => [f.id, f]));

			const walkAncestry = (startFolderId: string | null): PlaylistFolder[] => {
				const chain: PlaylistFolder[] = [];
				const seen = new Set<string>();
				let cur = startFolderId;
				while (cur) {
					if (seen.has(cur)) break; // self-referential safety net
					seen.add(cur);
					const f = folderById.get(cur);
					if (!f) break;
					chain.push(f);
					cur = f.parentFolderId;
				}
				return chain.reverse(); // root-first
			};

			return rows.map((r) => ({
				playlist: r.pl,
				folderPath: walkAncestry(r.pl.parentFolderId ?? null),
			}));
		},

		async getTrackPlaylistsBatch(trackIds) {
			if (trackIds.length === 0) return {};
			// Inner join filters out hidden + smart playlists at SQL level so the
			// renderer never has to know which playlists are write-eligible — they
			// just don't appear in the membership map. Chunked: callers pass the
			// whole resident scope's ids, which overflows the param cap at scale.
			const rows = chunkedIn(trackIds, (chunk) => db
				.select({ trackId: playlistTrack.trackId, playlistId: playlistTrack.playlistId })
				.from(playlistTrack)
				.innerJoin(playlist, eq(playlist.id, playlistTrack.playlistId))
				.where(and(
					inArray(playlistTrack.trackId, chunk),
					eq(playlist.isHidden, false),
					eq(playlist.isSmart, false),
				))
				.all());
			const out: Record<string, string[]> = {};
			for (const r of rows) {
				// De-dupe — a single track at multiple positions in the same
				// playlist would otherwise appear twice in the membership list,
				// which would break the three-state count math downstream.
				const list = (out[r.trackId] ??= []);
				if (!list.includes(r.playlistId)) list.push(r.playlistId);
			}
			return out;
		},

		async getPlaylistsWithFolders() {
			// Every write-eligible playlist. Mirrors getTrackPlaylists's
			// folder-walk shape so the renderer can use the same path builder
			// for both surfaces.
			const playlists = db
				.select()
				.from(playlist)
				.where(and(eq(playlist.isHidden, false), eq(playlist.isSmart, false)))
				.all();
			if (playlists.length === 0) return [];
			// One folder pull, walked in memory — same approach as
			// getTrackPlaylists, scaled across the whole library.
			const sources = Array.from(new Set(playlists.map((p) => p.source)));
			const allFolders = db
				.select()
				.from(playlistFolder)
				.where(inArray(playlistFolder.source, sources as PlaylistSource[]))
				.all();
			const folderById = new Map(allFolders.map((f) => [f.id, f]));
			const walkAncestry = (startFolderId: string | null): PlaylistFolder[] => {
				const chain: PlaylistFolder[] = [];
				const seen = new Set<string>();
				let cur = startFolderId;
				while (cur) {
					if (seen.has(cur)) break;
					seen.add(cur);
					const f = folderById.get(cur);
					if (!f) break;
					chain.push(f);
					cur = f.parentFolderId;
				}
				return chain.reverse();
			};
			return playlists.map((p) => ({
				playlist: p,
				folderPath: walkAncestry(p.parentFolderId ?? null),
			}));
		},

		async addTracksToPlaylist(playlistId, trackIds) {
			if (trackIds.length === 0) return { added: 0, skipped: 0, noUpstreamTrackIds: [], upstream: 'none' };
			const pl = db.select().from(playlist).where(eq(playlist.id, playlistId)).get();
			if (!pl) throw new Error(`Playlist ${playlistId} not found`);
			if (pl.isSmart) throw new Error('Cannot add to a smart playlist');

			// Tracks already present — skip so the gesture is idempotent.
			// "Already in playlist" is the common case for multi-select add
			// flows where part of the selection is already a member.
			const existing = chunkedIn(trackIds, (chunk) => db
				.select({ trackId: playlistTrack.trackId })
				.from(playlistTrack)
				.where(and(eq(playlistTrack.playlistId, playlistId), inArray(playlistTrack.trackId, chunk)))
				.all());
			const alreadyIn = new Set(existing.map((r) => r.trackId));
			let toAdd = trackIds.filter((id) => !alreadyIn.has(id));
			let noUpstream = 0;

			// For streaming-source playlists, the row's `sourceTrackId` must
			// be the provider's track id (e.g. Spotify track id) — otherwise
			// the upstream push below would send a Curator UUID to the API,
			// and the next read sync wouldn't recognize the added row. Batch-
			// resolve via source_link; drop tracks with no matching link from
			// `toAdd` (we have nothing to push for them) and count them as
			// skipped so the caller sees a non-zero skipped delta.
			const isStreaming = pl.source === 'spotify' || pl.source === 'tidal';
			let upstreamIdByTrackId = new Map<string, string>();
			let noUpstreamTrackIds: string[] = [];
			if (isStreaming && toAdd.length > 0) {
				const links = chunkedIn(toAdd, (chunk) => db
					.select({ trackId: sourceLink.trackId, sourceTrackId: sourceLink.sourceTrackId })
					.from(sourceLink)
					.where(and(eq(sourceLink.source, pl.source), inArray(sourceLink.trackId, chunk)))
					.all());
				upstreamIdByTrackId = new Map(links.map((l) => [l.trackId, l.sourceTrackId]));
				const withUpstream = toAdd.filter((id) => upstreamIdByTrackId.has(id));
				noUpstreamTrackIds = toAdd.filter((id) => !upstreamIdByTrackId.has(id));
				noUpstream = noUpstreamTrackIds.length;
				toAdd = withUpstream;
			}
			if (toAdd.length === 0) return { added: 0, skipped: alreadyIn.size + noUpstream, noUpstreamTrackIds, upstream: 'none' };

			// New rows land at the tail: order keys after the current last row,
			// then positions restamped (appendRows / recomputePositions).
			// (addMembers: one transaction, one `add` op per row.) On a
			// streaming playlist the add ops are marked pending upstream in the
			// same transaction (F23), so no read-sync — here or on another
			// desktop — reads the service's list as removing them before the
			// push below lands; the push's outcome settles them.
			const now = new Date();
			const addRows = () => mut.addMembers(db, playlistId, toAdd.map((trackId) => ({
				playlistId,
				trackId,
				addedAt: now,
				addedBy: null,
				// Streaming sources: provider track id (resolved above) so the
				// row matches what the next read sync will report. Local /
				// rekordbox / other: fall back to the Curator track id as a
				// stable round-trip identity (no upstream to push to anyway).
				sourceTrackId: upstreamIdByTrackId.get(trackId) ?? trackId,
			})));
			const pendingOps = isStreaming ? mut.withUpstreamPending(db, pl.source as StreamingSource, addRows).opIds : (addRows(), []);
			// Refresh trackCount cache so the sidebar's per-playlist counter
			// matches the new state immediately.
			const total = db
				.select({ n: count() })
				.from(playlistTrack)
				.where(eq(playlistTrack.playlistId, playlistId))
				.get();
			db.update(playlist)
				.set({ trackCount: total?.n ?? 0, updatedAt: now })
				.where(eq(playlist.id, playlistId))
				.run();

			// Upstream push — mirrors the reorder + remove paths. Best-effort:
			// failure logs but does NOT roll back the local insert; the local
			// rows stay ahead of the provider until pushPlaylistLocalOnly
			// replays them (the read sync never removes local-only rows).
			// Every skip reason is logged AND returned — a silent skip here is
			// how a month of adds went missing (2026-09-09).
			let upstream: UpstreamPushOutcome = 'none';
			if (isStreaming) {
				const src = pl.source as StreamingSource;
				const settings = sourceSyncSettings[src];
				const adapter = sourceAdapters[src];
				const remoteIds = toAdd.map((id) => upstreamIdByTrackId.get(id)!).filter(Boolean);
				const ctx = { source: src, playlistSourceId: pl.sourceId, count: remoteIds.length };
				if (!adapter || !adapter.capabilities.canAddTracks || remoteIds.length === 0) {
					upstream = 'none';
				} else if (!canModifyUpstream(pl)) {
					// Same ownership boundary as the remove path — can't add to a
					// playlist we don't own / collaborate on (Spotify 403s).
					upstream = 'not-owner';
					log.for('add-tracks').warn('upstream push skipped — not the playlist owner; rows are local-only', ctx);
				} else if (!settings.writeSyncAuto) {
					upstream = 'write-sync-off';
					log.for('add-tracks').warn('upstream push skipped — writeSyncAuto is off; rows are local-only until pushed', ctx);
				} else {
					try {
						const upRes = await adapter.addTracks(pl.sourceId, remoteIds);
						if (upRes.snapshotId) {
							db.update(playlist)
								.set({ syncCursor: upRes.snapshotId, lastSyncedAt: new Date() })
								.where(eq(playlist.id, playlistId))
								.run();
						}
						upstream = 'pushed';
						log.for('add-tracks').info('pushed upstream', ctx);
						mut.ackUpstream(db, pendingOps, src, 'pushed');
					} catch (err) {
						upstream = 'failed';
						log.for('add-tracks').warn('upstream push failed', ctx, err);
						mut.ackUpstream(db, pendingOps, src, 'failed', err instanceof Error ? err.message : String(err));
					}
				}
			}

			// Added to a playlist → membership may rise (e.g. into 'streaming' if
			// this is one of the user's own playlists). Recompute the added ids.
			membership.recomputeForTracks(toAdd);

			return { added: toAdd.length, skipped: alreadyIn.size + noUpstream, noUpstreamTrackIds, upstream };
		},

		async removeTracksFromPlaylist(playlistId, trackIds, opts) {
			if (trackIds.length === 0) return { removed: 0, upstream: 'none' };
			const pl = db.select().from(playlist).where(eq(playlist.id, playlistId)).get();
			if (!pl) throw new Error(`Playlist ${playlistId} not found`);
			if (pl.isSmart) throw new Error('Cannot remove from a smart playlist');

			// Capture sourceTrackIds BEFORE the delete — the rows are about to
			// vanish, and we need the provider-side ids (e.g. Spotify track id)
			// to push the removal upstream. Distinct values: Spotify's API
			// removes every occurrence of each URI in one shot.
			// A row whose sourceTrackId is its own Curator track id has no
			// provider id here (the fallback for rows projected from another
			// device before this one linked the track — a remote row, say):
			// there is nothing to remove upstream for it, and sending the uuid
			// would only earn a provider error. The same rule as the drift
			// check (computeUpstreamDrift). A claim-derived id is never used
			// in its place: it is not this device's link to act on.
			const sourceRows = chunkedIn(trackIds, (chunk) => db
				.select({ trackId: playlistTrack.trackId, sourceTrackId: playlistTrack.sourceTrackId })
				.from(playlistTrack)
				.where(and(eq(playlistTrack.playlistId, playlistId), inArray(playlistTrack.trackId, chunk)))
				.all());
			const remoteIds = Array.from(new Set(
				sourceRows.filter((r) => r.sourceTrackId !== r.trackId).map((r) => r.sourceTrackId).filter((s): s is string => !!s),
			));

			// Delete + restamp positions in one transaction. Survivors keep
			// their order keys; without the restamp their positions would gap
			// (removing #5 of 10 leaves 0..3,5..9) and the "#" column, the
			// renderer's reorder wire format and anything reading
			// position-as-rank would see holes.
			// (removeMembersByTrack: one `remove` op per row.) Pending upstream
			// until the push below settles it, as on the add path (F23).
			const streamingRemove = (pl.source === 'spotify' || pl.source === 'tidal') && remoteIds.length > 0;
			const removeRows = () => mut.removeMembersByTrack(db, playlistId, trackIds);
			const { result: removed, opIds: pendingOps } = streamingRemove
				? mut.withUpstreamPending(db, pl.source as StreamingSource, removeRows)
				: { result: removeRows(), opIds: [] as string[] };
			if (removed > 0) {
				const total = db
					.select({ n: count() })
					.from(playlistTrack)
					.where(eq(playlistTrack.playlistId, playlistId))
					.get();
				db.update(playlist)
					.set({ trackCount: total?.n ?? 0, updatedAt: new Date() })
					.where(eq(playlist.id, playlistId))
					.run();
			}

			// Upstream push — mirrors the reorder path below. Best-effort: a
			// failure here logs but does NOT roll back the local delete; the
			// next auto-read tick reconciles in the other direction.
			//
			// `forceUpstream` lets the destructive deleteTracks flow push
			// regardless of the user's writeSyncAuto preference — otherwise a
			// delete with auto-write off would clear curator but leave the
			// track in the Spotify playlist, and the next sync would re-add it.
			let upstream: UpstreamPushOutcome = 'none';
			if (removed > 0 && remoteIds.length > 0 && (pl.source === 'spotify' || pl.source === 'tidal')) {
				const src = pl.source as StreamingSource;
				const settings = sourceSyncSettings[src];
				const adapter = sourceAdapters[src];
				const force = opts?.forceUpstream === true;
				const ctx = { source: src, playlistSourceId: pl.sourceId, count: remoteIds.length };
				// Skip followed/other-owned playlists — we can't (and Spotify
				// won't let us) remove tracks from them. force overrides the
				// writeSyncAuto preference, NOT the ownership boundary.
				if (!adapter || !adapter.capabilities.canRemoveTracks) {
					upstream = 'none';
				} else if (!canModifyUpstream(pl)) {
					upstream = 'not-owner';
					log.for('remove-tracks').warn('upstream push skipped — not the playlist owner', ctx);
				} else if (!settings.writeSyncAuto && !force) {
					upstream = 'write-sync-off';
					log.for('remove-tracks').warn('upstream push skipped — writeSyncAuto is off; the provider still has these rows', ctx);
				} else {
					try {
						const upRes = await adapter.removeTracks(pl.sourceId, remoteIds);
						if (upRes.snapshotId) {
							db.update(playlist)
								.set({ syncCursor: upRes.snapshotId, lastSyncedAt: new Date() })
								.where(eq(playlist.id, playlistId))
								.run();
						}
						upstream = 'pushed';
						log.for('remove-tracks').info('pushed upstream', ctx);
						mut.ackUpstream(db, pendingOps, src, 'pushed');
					} catch (err) {
						upstream = 'failed';
						log.for('remove-tracks').warn('upstream push failed', ctx, err);
						mut.ackUpstream(db, pendingOps, src, 'failed', err instanceof Error ? err.message : String(err));
						// Re-throw on forced pushes so deleteTracks can collect
						// the error and surface it to the user — a silent
						// failure here on a destructive action would leave them
						// thinking the upstream removal succeeded.
						if (force) throw err;
					}
				}
			}

			// Removed from a playlist → membership may drop (e.g. out of
			// 'streaming' if this was the only owned playlist holding it).
			if (removed > 0) membership.recomputeForTracks(trackIds);

			return { removed, upstream };
		},

		async findTracksWithDeletedFiles(playlistIds) {
			if (playlistIds.length === 0) return [];
			// One round-trip per call: pull every (playlistId, trackId,
			// filePath) row across all requested playlists in a single
			// IN-query, then stat each unique filePath once. With duplicate
			// tracks across playlists this stays cheap even at folder scope.
			const rows = db
				.select({
					playlistId: playlistTrack.playlistId,
					trackId: playlistTrack.trackId,
					filePath: sourceLink.filePath,
				})
				.from(playlistTrack)
				.innerJoin(sourceLink, and(
					eq(sourceLink.trackId, playlistTrack.trackId),
					eq(sourceLink.source, 'local'),
				))
				.innerJoin(track, eq(track.id, playlistTrack.trackId))
				.where(and(inArray(playlistTrack.playlistId, playlistIds), isNull(track.deletedAt)))
				.all();

			const { existsSync } = await import('node:fs');
			const missingByPath = new Map<string, boolean>();
			const isMissing = (p: string | null): boolean => {
				if (!p) return false;
				const cached = missingByPath.get(p);
				if (cached !== undefined) return cached;
				const missing = !existsSync(p);
				missingByPath.set(p, missing);
				return missing;
			};

			// A track may have multiple local source_links (rare — multiple
			// on-disk files for the same track). Treat as "deleted" only
			// when ALL its local files under this playlist are missing —
			// matches the user-visible meaning of "the file is gone".
			const perPair = new Map<string, { anyPresent: boolean; anyChecked: boolean }>();
			for (const r of rows) {
				const key = `${r.playlistId}\x00${r.trackId}`;
				let state = perPair.get(key);
				if (!state) {
					state = { anyPresent: false, anyChecked: false };
					perPair.set(key, state);
				}
				if (r.filePath) {
					state.anyChecked = true;
					if (!isMissing(r.filePath)) state.anyPresent = true;
				}
			}

			const byPlaylist = new Map<string, string[]>();
			for (const [key, state] of perPair) {
				if (!state.anyChecked || state.anyPresent) continue;
				const [playlistId, trackId] = key.split('\x00') as [string, string];
				let arr = byPlaylist.get(playlistId);
				if (!arr) {
					arr = [];
					byPlaylist.set(playlistId, arr);
				}
				arr.push(trackId);
			}
			return playlistIds.map((id) => ({ playlistId: id, trackIds: byPlaylist.get(id) ?? [] }));
		},

		async setPlaylistFavorite(playlistId, isFavorite) {
			mut.setPlaylistFavorite(db, playlistId, isFavorite);
		},

		async getPinnedSearches() {
			return db
				.select()
				.from(pinnedSearch)
				.orderBy(asc(pinnedSearch.position), asc(pinnedSearch.createdAt))
				.all();
		},

		async createPinnedSearch(input) {
			const name = input.name.trim();
			if (!name) throw new Error('Pinned search name cannot be empty');
			const query = input.query.trim();
			if (!query) throw new Error('Pinned search query cannot be empty');
			// New pins land at the tail of the Pinned folder.
			const tail = db
				.select({ max: sql<number>`COALESCE(MAX(${pinnedSearch.position}), -1)` })
				.from(pinnedSearch)
				.get();
			const id = randomUUID();
			const row: NewPinnedSearch = {
				id,
				name,
				query,
				sortColumn: input.sort?.column ?? null,
				sortDir: input.sort?.dir ?? null,
				position: (tail?.max ?? -1) + 1,
			};
			mut.createPinnedSearch(db, { id, name, query, sortColumn: row.sortColumn ?? null, sortDir: row.sortDir ?? null, position: row.position ?? 0 });
			return db.select().from(pinnedSearch).where(eq(pinnedSearch.id, id)).get()!;
		},

		async renamePinnedSearch(id, newName) {
			const name = newName.trim();
			if (!name) throw new Error('Pinned search name cannot be empty');
			mut.renamePinnedSearch(db, id, name);
			const row = db.select().from(pinnedSearch).where(eq(pinnedSearch.id, id)).get();
			if (!row) throw new Error(`Pinned search ${id} not found`);
			return row;
		},

		async deletePinnedSearch(id) {
			mut.deletePinnedSearch(db, id);
		},

		async createLocalPlaylistFromTracks(name, trackIds) {
			const trimmed = name.trim();
			if (!trimmed) throw new Error('Playlist name cannot be empty');
			const id = randomUUID();
			const now = new Date();
			const row: NewPlaylist = {
				id,
				source: 'local',
				// Local playlists have no upstream id — reuse the row id so the
				// (source, source_id) unique index stays satisfied.
				sourceId: id,
				name: trimmed,
				nameAscii: searchFold(trimmed),
				trackCount: trackIds.length,
				// 'synced' (not the default 'pending') so a row click doesn't kick
				// the lazy-sync path — there's nothing upstream to pull.
				syncStatus: 'synced',
				createdAt: now,
				updatedAt: now,
			};
			// Playlist + membership in one transaction: create, then one `add`
			// per row. Membership keeps the materialized order; the track id
			// doubles as source_track_id (no external provider id).
			sqlite.transaction(() => {
				mut.createPlaylist(db, row);
				mut.addMembers(db, id, trackIds.map((tid) => ({
					playlistId: id,
					trackId: tid,
					addedAt: now,
					sourceTrackId: tid,
				})));
			})();
			return db.select().from(playlist).where(eq(playlist.id, id)).get()!;
		},

		async createStreamingPlaylist(source, name, trackIds) {
			const trimmed = name.trim();
			if (!trimmed) throw new Error('Playlist name cannot be empty');
			const adapter = sourceAdapters[source];
			if (!adapter) throw new Error(`No write adapter for source "${source}" — only Spotify playlists can be created upstream`);
			if (!adapter.capabilities.canCreatePlaylist) throw new Error(`${adapter.displayName} does not support playlist creation`);

			// Resolve provider ids BEFORE creating anything remote — tracks with
			// no source_link for this provider have nothing to push and count as
			// skipped. An all-unlinked request still creates the (empty) playlist:
			// the user asked for it by name, and the caller warns about skips.
			const links = chunkedIn(trackIds, (chunk) => db
				.select({ trackId: sourceLink.trackId, sourceTrackId: sourceLink.sourceTrackId })
				.from(sourceLink)
				.where(and(eq(sourceLink.source, source), inArray(sourceLink.trackId, chunk)))
				.all());
			const upstreamIdByTrackId = new Map(links.map((l) => [l.trackId, l.sourceTrackId]));
			const linked = trackIds.filter((id) => upstreamIdByTrackId.has(id));

			// Remote first — both calls route through the remote-write gate.
			// Private by default: a DJ's working playlist is not a public artifact.
			const remote = await adapter.createPlaylist(trimmed, { isPublic: false });
			let snapshotId = remote.snapshotId;
			let addFailure: unknown = null;
			if (linked.length > 0) {
				try {
					const res = await adapter.addTracks(remote.remoteId, linked.map((id) => upstreamIdByTrackId.get(id)!));
					if (res.snapshotId) snapshotId = res.snapshotId;
				} catch (err) {
					// The remote playlist EXISTS at this point — still write the
					// local mirror (as 'pending' so lazy-sync pulls the truth),
					// then surface the failure to the caller.
					addFailure = err;
				}
			}

			// Local mirror in the sync's row shape: (source, sourceId) is the
			// sync upsert key, so the next read sync updates this row rather
			// than minting a duplicate; syncCursor = snapshotId short-circuits
			// the next poll when nothing moved upstream since.
			const tracksLanded = addFailure == null ? linked : [];
			const id = randomUUID();
			const now = new Date();
			const status = auth.getStatus();
			const myId = source === 'tidal' ? status.tidal.id : status.spotify.id;
			const row: NewPlaylist = {
				id,
				source,
				sourceId: remote.remoteId,
				url: source === 'spotify' ? `https://open.spotify.com/playlist/${remote.remoteId}` : null,
				name: trimmed,
				nameAscii: searchFold(trimmed),
				ownerId: myId ?? null,
				trackCount: tracksLanded.length,
				isCollaborative: false,
				isPublic: false,
				syncStatus: addFailure == null ? 'synced' : 'pending',
				syncCursor: addFailure == null ? snapshotId : null,
				lastSyncedAt: addFailure == null ? now : null,
				mark: 'P',
				createdAt: now,
				updatedAt: now,
			};
			sqlite.transaction(() => {
				mut.createPlaylist(db, row);
				mut.addMembers(db, id, tracksLanded.map((tid) => ({
					playlistId: id,
					trackId: tid,
					addedAt: now,
					sourceTrackId: upstreamIdByTrackId.get(tid)!,
				})));
			})();
			if (tracksLanded.length > 0) membership.recomputeForTracks(tracksLanded);
			if (addFailure != null) {
				const msg = addFailure instanceof Error ? addFailure.message : String(addFailure);
				throw new Error(`Playlist "${trimmed}" was created on ${adapter.displayName} but adding tracks failed: ${msg}`);
			}
			return {
				playlist: db.select().from(playlist).where(eq(playlist.id, id)).get()!,
				added: tracksLanded.length,
				skipped: trackIds.length - linked.length,
			};
		},

		async renamePlaylist(playlistId, newName) {
			const trimmed = newName.trim();
			if (!trimmed) throw new Error('Playlist name cannot be empty');
			const row = db.select().from(playlist).where(eq(playlist.id, playlistId)).get();
			if (!row) throw new Error(`Playlist ${playlistId} not found`);
			if (row.name === trimmed) return { pushedToSource: false };

			// Local update first so the UI reflects the change even if the
			// upstream push fails. The upstream error is surfaced to the
			// caller via a thrown Error after the local commit lands.
			mut.renamePlaylist(db, playlistId, trimmed);

			// Streaming sources route through the adapter — the one write
			// path that used to import SpotifyClient directly. Unlike the
			// add/remove/reorder paths this is NOT gated on writeSyncAuto:
			// rename is an explicit, named user action on this playlist,
			// and renaming locally-only by default would silently fork the
			// name from the provider (the pre-adapter behavior pushed
			// unconditionally too).
			if (row.source === 'spotify' || row.source === 'tidal') {
				const adapter = sourceAdapters[row.source as StreamingSource];
				if (adapter?.capabilities.canRename) {
					await adapter.renamePlaylist(row.sourceId, trimmed);
					return { pushedToSource: true };
				}
			}

			// Rekordbox + local + sources without rename capability: rename
			// is local-only. For rekordbox the user runs Sync to Rekordbox
			// to push the new name through DjmdPlaylist.Name (see exporter
			// buildWriteOps).
			return { pushedToSource: false };
		},

		async renamePlaylistFolder(folderId, newName) {
			const trimmed = newName.trim();
			if (!trimmed) throw new Error('Folder name cannot be empty');
			mut.renamePlaylistFolder(db, folderId, trimmed);
		},

		async reorderPlaylistTracks(playlistId, newOrder) {
			// Validate before any writes — counts must match exactly.
			const existing = db
				.select({ id: playlistTrack.id, position: playlistTrack.position })
				.from(playlistTrack)
				.where(eq(playlistTrack.playlistId, playlistId))
				.all();
			const have = new Set(existing.map((r) => r.position));
			if (newOrder.length !== have.size) {
				throw new Error(`reorder length mismatch: got ${newOrder.length}, have ${have.size}`);
			}
			const seen = new Set<number>();
			for (const pos of newOrder) {
				if (!have.has(pos)) throw new Error(`reorder: unknown position ${pos}`);
				if (seen.has(pos)) throw new Error(`reorder: duplicate position ${pos}`);
				seen.add(pos);
			}

			// Permutation in OLD-index space, captured before the rewrite: the
			// upstream push translates it into positional moves so the provider
			// never sees a full replace (which would reset every item's
			// added-at — see computePositionalMoves). Assumes remote order ==
			// local pre-drag order, same assumption the old full-replace made;
			// the next auto-read tick reconciles any drift.
			const oldPositionsSorted = existing.map((r) => r.position).sort((a, b) => a - b);
			const oldIndexOf = new Map(oldPositionsSorted.map((p, i) => [p, i]));
			const perm = newOrder.map((p) => oldIndexOf.get(p)!);

			// Only the displaced rows get new order keys (between their new
			// neighbours); the rest keep theirs, so a single drag rewrites one
			// row's key. Positions are then restamped 0..N-1 in the new order.
			// One `move` op per displaced row (a reverse sort is N, a drag 1).
			// On a streaming playlist the moves are pending upstream until the
			// push below settles them (F23): a read-sync meanwhile keeps the
			// local order instead of reverting the drag.
			const rowIdAt = new Map(existing.map((r) => [r.position, r.id]));
			const reorderRows = () => mut.reorderMembers(db, playlistId, newOrder.map((p) => rowIdAt.get(p)!));
			const before = db.select({ source: playlist.source }).from(playlist).where(eq(playlist.id, playlistId)).get();
			const pendingOps = before?.source === 'spotify' || before?.source === 'tidal'
				? mut.withUpstreamPending(db, before.source, reorderRows).opIds
				: (reorderRows(), [] as string[]);

			db.update(playlist)
				.set({ updatedAt: new Date() })
				.where(eq(playlist.id, playlistId))
				.run();

			// Upstream push — if the playlist is from a streaming source and
			// the user has writeSyncAuto enabled for that source, mirror the
			// new ordering to the provider via the adapter. Best-effort: a
			// failure here logs but does NOT roll back the local write —
			// the next auto-read tick will reconcile in the other direction.
			// (Rolling back would be worse: it'd erase the user's drag and
			// leave them confused about why the row jumped back.)
			const pl = db.select().from(playlist).where(eq(playlist.id, playlistId)).get();
			if (!pl) return;
			if (pl.source !== 'spotify' && pl.source !== 'tidal') return;
			const src = pl.source as StreamingSource;
			const settings = sourceSyncSettings[src];
			const adapter = sourceAdapters[src];
			if (!adapter || !settings.writeSyncAuto || !adapter.capabilities.canReorder) return;

			// Every row must carry this provider's own track id before anything
			// is sent. A row projected from another device (a "not on this
			// device" track, or one whose provider id never reached this
			// device) stores the Curator track id instead, or nothing. Sent
			// as-is, a full replace would drop it from the real playlist (and a
			// filtered list did exactly that silently), and positional moves
			// would be computed against positions the provider does not have.
			// So the push is refused whole; the local order stays, and the
			// next read-sync reconciles. (2026-10-21, second-desktop work.)
			const wire = db
				.select({ trackId: playlistTrack.trackId, sourceTrackId: playlistTrack.sourceTrackId })
				.from(playlistTrack)
				.where(eq(playlistTrack.playlistId, playlistId))
				.all();
			const unresolved = wire.filter((r) => !isProviderTrackId(src, r.sourceTrackId) || r.sourceTrackId === r.trackId);
			if (unresolved.length > 0) {
				log.for('reorder').warn('upstream reorder refused: rows without a provider id', { source: src, playlistSourceId: pl.sourceId, rows: unresolved.length });
				mut.ackUpstream(db, pendingOps, src, 'failed', `${unresolved.length} track(s) in this playlist have no ${src} id on this computer, so the new order was kept here only`);
				return;
			}

			try {
				let snapshotId: string | null = null;
				const moves = computePositionalMoves(perm);
				if (moves.length === 0) {
					// The provider already has this order.
					mut.ackUpstream(db, pendingOps, src, 'pushed');
					return;
				}
				// Positional moves cost one sequential API call EACH. Perfect
				// for drags (a dragged block = blockSize calls) — catastrophic
				// for a mass permutation like reverse-playlist, where ~N calls
				// would hammer the rate limiter and a mid-flight failure
				// strands a half-applied order. Past this threshold the full
				// replace wins: 1 call per 100 tracks, near-atomic. Cost: the
				// provider re-adds every item, resetting remote added-at —
				// acceptable for a deliberate mass reorder, and Curator's own
				// added_at survives either way (the read sync keeps the
				// earliest value it has ever seen per member).
				const MASS_REORDER_REPLACE_THRESHOLD = 50;
				if (adapter.reorderTracks && moves.length <= MASS_REORDER_REPLACE_THRESHOLD) {
					// Positional moves — rows move in place on the provider, so
					// per-item added-at survives.
					snapshotId = (await adapter.reorderTracks(pl.sourceId, moves, pl.syncCursor)).snapshotId;
				} else {
					// Full replace — no positional API, or mass reorder.
					// Look up the source-side track ids in the new playlist
					// order. `sourceTrackId` is the canonical provider id stored
					// on each playlist_track row. Pull them ordered by the
					// freshly-rewritten position so the wire payload matches
					// what we just persisted.
					const rows = db
						.select({ sourceTrackId: playlistTrack.sourceTrackId })
						.from(playlistTrack)
						.where(eq(playlistTrack.playlistId, playlistId))
						.orderBy(asc(playlistTrack.position))
						.all();
					const remoteIds = rows.map((r) => r.sourceTrackId).filter((s): s is string => !!s);
					snapshotId = (await adapter.replaceTracks(pl.sourceId, remoteIds)).snapshotId;
				}
				if (snapshotId) {
					// Stash the new snapshot so the next auto-read tick sees
					// this playlist as unchanged and skips the /tracks call.
					db.update(playlist)
						.set({ syncCursor: snapshotId, lastSyncedAt: new Date() })
						.where(eq(playlist.id, playlistId))
						.run();
				}
				mut.ackUpstream(db, pendingOps, src, 'pushed');
			} catch (err) {
				log.for('reorder').warn('upstream push failed', { source: src, playlistSourceId: pl.sourceId }, err);
				mut.ackUpstream(db, pendingOps, src, 'failed', err instanceof Error ? err.message : String(err));
			}
		},

		async getSourceSyncSettings() {
			return {
				spotify: { ...sourceSyncSettings.spotify },
				tidal: { ...sourceSyncSettings.tidal },
			};
		},

		async getCreditFormat() {
			return { format: { ...creditFormat }, stored: creditFormatStored };
		},
		async setCreditFormat(fmt) {
			const next: ArtistCreditFormat = {
				separator: fmt.separator === '/' || fmt.separator === ';' ? fmt.separator : ',',
				remixStyle: fmt.remixStyle === 'dash' ? 'dash' : 'parenthesis',
			};
			creditFormat = next;
			creditFormatStored = true;
			mut.setSetting(db, CREDIT_FORMAT_KEY, next);
		},
		async getWavSettings() {
			return { ...wavSettings };
		},
		async setWavSettings(settings) {
			const raw = settings.outputDir?.trim();
			if (!raw) throw new Error('WAV output folder cannot be empty');
			if (!/^([A-Za-z]:[\\/]|\/)/.test(raw)) throw new Error('WAV output folder must be an absolute path');
			const outputDir = normalizePath(raw).replace(/\/+$/, '');
			if (isCloudSyncPath(outputDir)) {
				throw new Error('Refusing a cloud-sync folder (OneDrive/Dropbox/Google Drive/iCloud) for WAV output — the library watcher can\'t follow it reliably.');
			}
			const now = new Date();
			db.insert(appSetting)
				.values({ key: WAV_OUTPUT_DIR_KEY, value: outputDir, updatedAt: now })
				.onConflictDoUpdate({ target: appSetting.key, set: { value: outputDir, updatedAt: now } })
				.run();
			wavSettings = { outputDir, stored: true };
			return { ...wavSettings };
		},
		async previewPlaylistWavConversion(playlistId) {
			return wavConverter.preview(playlistId);
		},
		async convertPlaylistToWav(playlistId) {
			return wavConverter.start(playlistId);
		},
		async cancelWavConversion(runId) {
			wavConverter.cancel(runId);
		},
		subscribeWavConvertEvents(cb) {
			return wavConverter.subscribe(cb);
		},
		async setSourceSyncSettings(source, settings) {
			const next: SourceSyncSettings = { ...settings };
			sourceSyncSettings[source] = next;
			const now = new Date();
			db.insert(appSetting)
				.values({ key: sourceSyncSettingKey(source), value: next, updatedAt: now })
				.onConflictDoUpdate({ target: appSetting.key, set: { value: next, updatedAt: now } })
				.run();
			sourceScheduler.applySettings(source, next);
		},

		async getPlaylistUpstreamDrift(playlistId) {
			return computeUpstreamDrift(playlistId);
		},

		async pushPlaylistLocalOnly(playlistId, sourceTrackIds) {
			const drift = await computeUpstreamDrift(playlistId);
			const pl = db.select().from(playlist).where(eq(playlist.id, playlistId)).get()!;
			const src = pl.source as StreamingSource;
			const adapter = sourceAdapters[src];
			if (!adapter || !adapter.capabilities.canAddTracks) throw new Error(`${src} does not support adding tracks`);
			if (!drift.canModify) throw new Error('Not the playlist owner — the provider would reject the write');
			const only = sourceTrackIds ? new Set(sourceTrackIds) : null;
			// Local position order, so the provider's tail ends up in the
			// same order the user added them.
			const ids = drift.localOnly
				.filter((r) => !only || only.has(r.sourceTrackId))
				.map((r) => r.sourceTrackId);
			if (ids.length === 0) return { pushed: 0, snapshotId: null };
			// Deliberately NOT gated on writeSyncAuto: this is the explicit,
			// user-confirmed repair for rows the auto path skipped while the
			// toggle was off — gating it on the same toggle would make the
			// repair impossible in exactly the state that needs it. The
			// remote-write policy gate (guardRemoteWrites) still applies.
			const ctx = { source: src, playlistSourceId: pl.sourceId, count: ids.length };
			const res = await adapter.addTracks(pl.sourceId, ids);
			if (res.snapshotId) {
				db.update(playlist)
					.set({ syncCursor: res.snapshotId, lastSyncedAt: new Date() })
					.where(eq(playlist.id, playlistId))
					.run();
			}
			log.for('push-local-only').info('pushed local-only rows upstream', ctx);
			// Their adds were pending upstream (F23); the service has them now.
			const pushedRows = new Set(ids);
			const rowIds = db.select({ id: playlistTrack.id, sourceTrackId: playlistTrack.sourceTrackId }).from(playlistTrack)
				.where(eq(playlistTrack.playlistId, playlistId)).all()
				.filter((r) => r.sourceTrackId != null && pushedRows.has(r.sourceTrackId)).map((r) => r.id);
			mut.ackUpstream(db, mut.pendingAddOps(sqlite, rowIds), src, 'pushed');
			return { pushed: ids.length, snapshotId: res.snapshotId };
		},

		async getStateCounts() {
			const rows = db
				.select({ state: track.state, n: count() })
				.from(track)
				.where(isNull(track.deletedAt))
				.groupBy(track.state)
				.all();

			const out: ZStateCountsT = {
				feed: 0,
				backlog: 0,
				progress: 0,
				purchased: 0,
				unsorted: 0,
			};
			for (const r of rows) {
				if ((TRACK_STATES as readonly string[]).includes(r.state)) {
					out[r.state as TrackState] = r.n;
				}
			}
			return out;
		},

		// Per-source track counts — one COUNT GROUP BY over source_link. The
		// renderer uses `local` to decide whether the Rekordbox tab's onboarding
		// panel (no rekordbox library AND no local files) should take over.
		// Distinct live tracks: a deleted track keeps its streaming links (and
		// can hold a re-appearing file), and one track can carry two links of
		// a source.
		async getSourceCounts() {
			// A local link flagged missing_at is not a file (see resolveLocalFile).
			const rows = db
				.select({ source: sourceLink.source, n: countDistinct(sourceLink.trackId) })
				.from(sourceLink)
				.innerJoin(track, eq(track.id, sourceLink.trackId))
				.where(and(isNull(track.deletedAt), or(ne(sourceLink.source, 'local'), isNull(sourceLink.missingAt))))
				.groupBy(sourceLink.source)
				.all();
			const out = { spotify: 0, tidal: 0, local: 0 };
			for (const r of rows) {
				if (r.source === 'spotify') out.spotify = r.n;
				else if (r.source === 'tidal') out.tidal = r.n;
				else if (r.source === 'local') out.local = r.n;
			}
			return out;
		},

		// ─── Local library ──────────────────────────────────────────────────
		async getLibraryFolders() {
			return db.select().from(libraryFolder).orderBy(asc(libraryFolder.addedAt)).all();
		},
		async getDuplicateAudioGroups() {
			// "Present" = link not flagged missing and its track live and not a
			// derived (WAV) copy — the same liveness the scanner's re-bind uses,
			// so the two views agree on what a duplicate is. One pass over the
			// audio_hash index; grouping and the size-desc order happen here.
			const rows = sqlite.prepare(`
				SELECT sl.audio_hash AS audioHash, sl.track_id AS trackId, t.title AS title, sl.file_path AS filePath
				FROM source_link sl JOIN track t ON t.id = sl.track_id
				WHERE sl.source = 'local' AND sl.audio_hash IS NOT NULL AND sl.missing_at IS NULL AND sl.file_path IS NOT NULL
					AND t.deleted_at IS NULL AND t.derived_from_track_id IS NULL
					AND sl.audio_hash IN (
						SELECT sl2.audio_hash FROM source_link sl2 JOIN track t2 ON t2.id = sl2.track_id
						WHERE sl2.source = 'local' AND sl2.audio_hash IS NOT NULL AND sl2.missing_at IS NULL
							AND t2.deleted_at IS NULL AND t2.derived_from_track_id IS NULL
						GROUP BY sl2.audio_hash HAVING COUNT(*) > 1
					)
				ORDER BY sl.audio_hash, t.title COLLATE NOCASE, sl.file_path
			`).all() as Array<{ audioHash: string; trackId: string; title: string; filePath: string }>;
			const groups = new Map<string, Array<{ trackId: string; title: string; filePath: string }>>();
			for (const r of rows) {
				let g = groups.get(r.audioHash);
				if (!g) { g = []; groups.set(r.audioHash, g); }
				g.push({ trackId: r.trackId, title: r.title, filePath: r.filePath });
			}
			return [...groups.entries()]
				.map(([audioHash, tracks]) => ({ audioHash, tracks }))
				.sort((a, b) => b.tracks.length - a.tracks.length || a.tracks[0]!.title.localeCompare(b.tracks[0]!.title));
		},
		async addLibraryFolder(path, opts) {
			const norm = normalizePath(path);
			if (!opts?.allowCloudSync && isCloudSyncPath(norm)) {
				throw new Error('Refusing to watch a cloud-sync root (OneDrive/Dropbox/Google Drive/iCloud). Pass allowCloudSync to override.');
			}
			const existing = db.select().from(libraryFolder).where(eq(libraryFolder.path, norm)).get();
			if (existing) return existing;
			const row: NewLibraryFolder = {
				id: randomUUID(),
				path: norm,
				excludeGlobs: null,
				watching: true,
				scanState: 'idle',
				scanError: null,
				addedAt: new Date(),
				lastScannedAt: null,
			};
			db.insert(libraryFolder).values(row).run();
			const inserted = db.select().from(libraryFolder).where(eq(libraryFolder.id, row.id)).get()!;
			// Start watching in the background — never block the caller on the
			// initial scan, which may iterate thousands of files.
			libraryScanner.startWatching(inserted).catch((err) => log.for('scanner').error('startWatching failed', err));
			return inserted;
		},
		async removeLibraryFolder(folderId) {
			await libraryScanner.stopWatching(folderId);
			// Drop the folder row and any source_links whose file lives under it.
			const folder = db.select().from(libraryFolder).where(eq(libraryFolder.id, folderId)).get();
			if (folder) {
				const prefix = folder.path.endsWith('/') ? folder.path : folder.path + '/';
				db.delete(sourceLink)
					.where(and(eq(sourceLink.source, 'local'), like(sourceLink.filePath, `${prefix}%`)))
					.run();
			}
			db.delete(libraryFolder).where(eq(libraryFolder.id, folderId)).run();
		},
		async pruneDeletedLocalFiles(opts) {
			// Pull every local source_link's filePath once, stat each, and
			// collect the missing ones. filePath has a uniqueIndex so each
			// row's path is distinct — no dedup needed. The DELETE runs in
			// chunked IN() batches to dodge SQLite's 999-variable limit on
			// users with very large libraries.
			const rows = db
				.select({ filePath: sourceLink.filePath })
				.from(sourceLink)
				.where(eq(sourceLink.source, 'local'))
				.all();
			const { existsSync } = await import('node:fs');
			const missingPaths: string[] = [];
			for (const r of rows) {
				if (!r.filePath) continue;
				if (!existsSync(r.filePath)) missingPaths.push(r.filePath);
			}
			const scanned = rows.length;
			const missing = missingPaths.length;
			if (opts?.dryRun || missing === 0) {
				return { scanned, missing, removed: 0 };
			}
			let removed = 0;
			for (let i = 0; i < missingPaths.length; i += 500) {
				const chunk = missingPaths.slice(i, i + 500);
				const res = db.delete(sourceLink)
					.where(and(eq(sourceLink.source, 'local'), inArray(sourceLink.filePath, chunk)))
					.run();
				removed += res.changes ?? 0;
			}
			return { scanned, missing, removed };
		},
		async resolveLocalFile(filePath) {
			const norm = normalizePath(filePath);
			// missing_at IS NULL: the watcher keeps a vanished file's link for up
			// to 30 days as a re-bind hint (scanner.ts), so a local link alone no
			// longer means a file on disk. Every present-file reader applies this.
			const row = db
				.select({ path: sourceLink.filePath, size: sourceLink.fileSize, format: sourceLink.fileFormat })
				.from(sourceLink)
				.where(and(eq(sourceLink.source, 'local'), eq(sourceLink.filePath, norm), isNull(sourceLink.missingAt)))
				.get();
			return row?.path ? { path: row.path, size: row.size, format: row.format } : null;
		},
		async getLocalFileForTrack(trackId) {
			const row = db
				.select({ path: sourceLink.filePath, size: sourceLink.fileSize, format: sourceLink.fileFormat })
				.from(sourceLink)
				.where(and(eq(sourceLink.source, 'local'), eq(sourceLink.trackId, trackId), isNull(sourceLink.missingAt)))
				.get();
			return row?.path ? { path: row.path, size: row.size, format: row.format } : null;
		},
		subscribeLibraryScan(cb) {
			return libraryScanner.onProgress(cb);
		},
		async startLibraryWatching() {
			// Seed track.membership once per launch (idempotent, one indexed pass).
			// Deferred to here — same post-bootstrap slot as the watcher — so the
			// recompute can't stall first paint. Self-healing: covers any tier drift
			// from a missed invalidation, and tracks not touched by the scan.
			membership.recomputeAll();
			// Same once-per-launch slot: plays a quit or crash left open are
			// finalised and synced. A failure must not stop the watcher.
			try { plays.finalizeInterruptedPlays(db, { before: startedAt }); } catch (err) { log.for('plays').warn('finalising interrupted plays failed', undefined, err); }
			await libraryScanner.startAll();
		},
		recomputeMembership() {
			membership.recomputeAll();
		},
		startAnalyzer() {
			if (analyzerSidecar && !analyzerSidecar.hasStarted) analyzerSidecar.start();
		},

		// ─── Discover feed ──────────────────────────────────────────────────
		// Feed methods delegate to the feed service (feed/service.ts) — the
		// engine lives behind its ports; CoreService just exposes its
		// interface on the public surface.
		async getFeedPage(req) {
			return feedService.getPage(req);
		},
		async getFeedFilterOptions() {
			return feedService.filterOptions();
		},
		async getArchivedFeedPage(req) {
			return feedService.getArchivedPage(req);
		},
		async getFeedItemDetail(itemId) {
			return feedService.getItemDetail(itemId);
		},
		async enrichFeedItem(itemId) {
			return feedService.enrichItem(itemId);
		},
		async feedAction(action) {
			return feedService.action(action);
		},
		async unfollowFeedPlaylist(playlistId) {
			return feedService.unfollowPlaylist(playlistId);
		},
		async unfollowFeedArtist(artistId) {
			return feedService.unfollowArtist(artistId);
		},
		async runFeedRefresh() {
			return feedService.refresh();
		},
		async runFeedProducerRefresh(producerId) {
			return feedService.refreshProducer(producerId);
		},
		async loadMoreFeed(days) {
			return feedService.loadMore(days);
		},
		subscribeFeedEnriched(cb) {
			return feedService.subscribeEnriched(cb);
		},
		startFeedPolling() {
			feedService.startPolling();
		},
		startAlbumEnrichment() {
			albumEnricher.start();
		},

		// ─── Discovery journeys + knowledge base ────────────────────────────
		async createJourney(seed, opts) {
			return knowledgeService.createJourney(seed, opts);
		},
		async listJourneys() {
			return knowledgeService.listJourneys();
		},
		async getJourney(journeyId) {
			return knowledgeService.getJourney(journeyId);
		},
		async renameJourney(journeyId, name) {
			return knowledgeService.renameJourney(journeyId, name);
		},
		async deleteJourney(journeyId) {
			return knowledgeService.deleteJourney(journeyId);
		},
		async journeyNavigate(journeyId, entityId, opts) {
			return knowledgeService.journeyNavigate(journeyId, entityId, opts);
		},
		async journeyJumpTo(journeyId, nodeId) {
			return knowledgeService.journeyJumpTo(journeyId, nodeId);
		},
		async journeySetNodeView(journeyId, nodeId, view) {
			return knowledgeService.journeySetNodeView(journeyId, nodeId, view);
		},
		async journeyDeleteBranch(journeyId, nodeId) {
			return knowledgeService.journeyDeleteBranch(journeyId, nodeId);
		},
		async getKbEntity(entityId) {
			return knowledgeService.getKbEntity(entityId);
		},
		async expandKbEntity(entityId, aspect, opts) {
			return knowledgeService.expandKbEntity(entityId, aspect, opts);
		},
		async searchKb(query, kinds) {
			return knowledgeService.searchKb(query, kinds);
		},
		async resolveKbEntity(seed) {
			return knowledgeService.resolveKbEntity(seed);
		},
		async promoteKbTrack(entityId, opts) {
			return knowledgeService.promoteKbTrack(entityId, opts);
		},
		subscribeKbEvents(cb) {
			return knowledgeService.subscribeEvents(cb);
		},

		// ─── In-app agent ────────────────────────────────────────────────
		async agentStatus() {
			return agentService.status();
		},
		async configureAgent(config) {
			return agentService.configure(config);
		},
		async agentSend(req) {
			return agentService.send(req);
		},
		async agentCancel(sessionId) {
			return agentService.cancel(sessionId);
		},
		async listAgentSessions() {
			return agentService.listSessions();
		},
		async getAgentSession(sessionId) {
			return agentService.getSession(sessionId);
		},
		async newAgentSession() {
			return agentService.newSession();
		},
		async deleteAgentSession(sessionId) {
			return agentService.deleteSession(sessionId);
		},
		async getAgentResultSet(resultSetId) {
			return agentService.getResultSet(resultSetId);
		},
		subscribeAgentEvents(cb) {
			return agentService.subscribeEvents(cb);
		},
		agentExternalToolSpecs() {
			return agentService.externalToolSpecs();
		},
		agentCreateExternalSession(title) {
			return agentService.createExternalSession(title);
		},
		async agentRunExternalTool(req) {
			return agentService.runExternalTool(req);
		},

		// ─── Play history ───────────────────────────────────────────────────
		async recordPlay(e) {
			plays.recordPlay(db, e);
		},
		async getTrackPlayHistory(trackId, opts) {
			return plays.getTrackPlayHistory(db, trackId, opts);
		},
		async listPlaySessions(opts) {
			return plays.listPlaySessions(db, opts);
		},
		async getPlaySession(sessionId) {
			return plays.getPlaySession(db, sessionId);
		},
		async getTopPlayed(opts) {
			return plays.getTopPlayed(db, opts);
		},
		async setPlaySessionKind(sessionId, kind) {
			plays.setPlaySessionKind(db, sessionId, kind);
		},

		// ─── Tags ───────────────────────────────────────────────────────────
		async getTags() {
			return db.select().from(tag).orderBy(asc(tag.sortOrder), asc(tag.name)).all();
		},
		async getTagCounts() {
			// Soft-deleted tracks keep their track_tag rows (undelete restores
			// them), so count only live tracks — otherwise the tab badges disagree
			// with the lists, which getTracks already filters by deletedAt.
			const rows = db
				.select({ tagId: trackTag.tagId, n: count() })
				.from(trackTag)
				.innerJoin(track, eq(track.id, trackTag.trackId))
				.where(isNull(track.deletedAt))
				.groupBy(trackTag.tagId)
				.all();
			const out: Record<string, number> = {};
			for (const r of rows) out[r.tagId] = r.n;
			return out;
		},
		async listArtists(opts) {
			const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 5000);
			const fold = opts?.search ? artistKey(opts.search) : '';
			const conds = [isNull(artist.mergedInto)];
			// searchFold strips `_`; escape `%` and `\` so a typed wildcard
			// can't widen the LIKE.
			if (fold) conds.push(sql`${artist.nameAscii} LIKE ${`%${fold.replace(/[\\%]/g, (c) => `\\${c}`)}%`} ESCAPE '\\'`);
			const rows = artistSummaryQuery(db, opts?.scope)
				.where(and(...conds))
				.groupBy(artist.id)
				.having(sql`count(${track.id}) > 0`)
				.orderBy(...(opts?.sort === 'name'
					? [asc(artist.nameAscii)]
					: [desc(sql`count(${track.id})`), asc(artist.nameAscii)]))
				.limit(limit)
				.all();
			return rows.map(toArtistSummary);
		},
		async getArtist(id) {
			const row = artistSummaryQuery(db).where(eq(artist.id, id)).groupBy(artist.id).get();
			return row ? toArtistSummary(row) : null;
		},
		async resolveArtistByName(name) {
			const live = lookupArtistRaw(rawOf(db), name);
			return live ? svcRef!.getArtist(live.id) : null;
		},
		async listArtistMergeSuggestions(scope) {
			// No HAVING here: a pair stays relevant while EITHER side has a
			// track in scope; the other side then shows 0 for this tab.
			const live = artistSummaryQuery(db, scope)
				.where(isNull(artist.mergedInto))
				.groupBy(artist.id)
				.all()
				.map(toArtistSummary);
			const dismissed = loadDismissedArtistMerges(db);
			const byBase = new Map<string, ArtistSummary[]>();
			for (const a of live) {
				const base = artistKey(stripArtistDisambiguator(a.name));
				if (!base) continue;
				const arr = byBase.get(base) ?? [];
				arr.push(a);
				byBase.set(base, arr);
			}
			const out: ArtistMergeSuggestion[] = [];
			for (const group of byBase.values()) {
				if (group.length < 2 || !group.some((a) => hasArtistDisambiguator(a.name))) continue;
				const sorted = [...group].sort((x, y) => y.trackCount - x.trackCount || x.name.localeCompare(y.name));
				for (let i = 0; i < sorted.length; i++) {
					for (let j = i + 1; j < sorted.length; j++) {
						const a = sorted[i]!;
						const b = sorted[j]!;
						if (dismissed.has(artistPairKey(a.id, b.id))) continue;
						if (a.trackCount + b.trackCount === 0) continue;
						// Survivor = the more-credited spelling; on a tie the tagged
						// one (it carries the disambiguation the platforms use).
						const keep = a.trackCount === b.trackCount && hasArtistDisambiguator(b.name) && !hasArtistDisambiguator(a.name) ? b : a;
						out.push({ a, b, signal: 'suffix', suggestedKeepId: keep.id });
					}
				}
			}
			out.sort((x, y) => (y.a.trackCount + y.b.trackCount) - (x.a.trackCount + x.b.trackCount) || x.a.name.localeCompare(y.a.name));
			return out;
		},
		async dismissArtistMergeSuggestion(aId, bId) {
			const set = loadDismissedArtistMerges(db);
			set.add(artistPairKey(aId, bId));
			mut.setSetting(db, ARTIST_MERGE_DISMISSED_KEY, [...set]);
		},
		async getArtistLinks(id) {
			const live = lookupLiveArtist(db, id);
			if (!live) return [];
			return db.select({ source: artistLink.source, sourceId: artistLink.sourceId, url: artistLink.url })
				.from(artistLink).where(eq(artistLink.artistId, live.id)).orderBy(asc(artistLink.source)).all();
		},
		async getAlbumsByIds(ids) {
			return readAlbumSummaries(rawOf(db), ids);
		},
		async renameArtist(id, newName) {
			const trimmed = newName.trim();
			if (!trimmed) throw new Error('Artist name is empty');
			const live = lookupLiveArtist(db, id);
			if (!live) throw new Error('Unknown artist');
			const fold = artistKey(trimmed);
			if (!fold) throw new Error('Artist name is empty');
			const clash = db.select({ id: artist.id, mergedInto: artist.mergedInto }).from(artist).where(eq(artist.nameAscii, fold)).get();
			const clashLive = clash && clash.id !== live.id ? lookupLiveArtist(db, clash.id) : null;
			if (clashLive && clashLive.id !== live.id) {
				// The typed name IS another artist — that's a merge, with the
				// user's spelling winning on the survivor.
				const res = await svcRef!.mergeArtists(clashLive.id, live.id);
				if (clashLive.name !== trimmed) return svcRef!.renameArtist(clashLive.id, trimmed);
				return res;
			}
			const now = new Date();
			let tracksRewritten = 0;
			rawOf(db).transaction(() => {
				// A clash that resolves to THIS artist is one of its own aliases
				// (renaming back to an earlier spelling) — reclaim the fold by
				// dropping the alias; nothing references alias rows.
				if (clash && clash.id !== live.id) db.delete(artist).where(eq(artist.id, clash.id)).run();
				// Order matters: move the row to the new fold FIRST, then park an
				// alias under the old fold, THEN rewrite credits. The rewrite
				// resolves each credit through the alias and the seam it runs
				// re-derives under the new fold — done the other way round the
				// seam mints a second row for the new spelling.
				db.update(artist)
					.set({ name: trimmed, nameAscii: fold, nameCuratedAt: now, updatedAt: now })
					.where(eq(artist.id, live.id))
					.run();
				if (fold !== live.nameAscii) {
					// Alias under the old fold so a re-sync spelling the old way
					// still lands on the renamed artist.
					db.insert(artist)
						.values({ id: randomUUID(), name: live.name, nameAscii: live.nameAscii, mergedInto: live.id, createdAt: now, updatedAt: now })
						.run();
				}
				// One rule per spelling key that now resolves here — the new
				// key (a spelling rule: the curated name), the old one, and
				// every alias merged in earlier — so a device that never saw
				// those older merges still rewrites the same credits.
				// Rules first: the canonical credits are derived from the
				// converged map, which must already hold them.
				const rules = artistFoldsOf(db, live.id).map((f) => ({ from: f.name, to: trimmed, key: f.nameAscii }));
				mut.emitArtistAliases(db, rules);
				tracksRewritten = rewriteArtistCredits(db, new Set([live.id]), new Map(rules.map((r) => [r.key, trimmed])), now);
			})();
			log.for('artists').info('artist renamed', { id: live.id, from: live.name, to: trimmed, tracksRewritten });
			return { artist: (await svcRef!.getArtist(live.id))!, tracksRewritten };
		},
		async mergeArtists(keepId, dropId) {
			const keep = lookupLiveArtist(db, keepId);
			const drop = lookupLiveArtist(db, dropId);
			if (!keep || !drop) throw new Error('Unknown artist');
			if (keep.id === drop.id) return { artist: (await svcRef!.getArtist(keep.id))!, tracksRewritten: 0 };
			const now = new Date();
			let tracksRewritten = 0;
			rawOf(db).transaction(() => {
				// Rules for every spelling key that resolved to drop (its own and
				// its aliases'), read before drop is re-pointed; emitted before
				// the rewrite, which derives credits from the converged map.
				const rules = artistFoldsOf(db, drop.id).map((f) => ({ from: f.name, to: keep.name, key: f.nameAscii }));
				mut.emitArtistAliases(db, rules);
				tracksRewritten = rewriteArtistCredits(db, new Set([drop.id]), new Map(rules.map((r) => [r.key, keep.name])), now);
				db.update(artist).set({ mergedInto: keep.id, updatedAt: now }).where(eq(artist.id, drop.id)).run();
				// Flatten aliases that pointed at drop so lookups stay one hop.
				db.update(artist).set({ mergedInto: keep.id, updatedAt: now })
					.where(and(eq(artist.mergedInto, drop.id), sql`${artist.id} != ${keep.id}`))
					.run();
				// A curated spelling on the survivor stays sticky; an uncurated
				// survivor adopts nothing — keep's name is what every rewritten
				// credit now carries.
				// Releases credited to drop move to keep (and their identity
				// keys with them — two releases may turn out to be one).
				healAlbumArtistAliasesRaw(rawOf(db));
			})();
			log.for('artists').info('artists merged', { keep: keep.id, drop: drop.id, tracksRewritten });
			return { artist: (await svcRef!.getArtist(keep.id))!, tracksRewritten };
		},
		async createTag(name, color) {
			const trimmed = name.trim();
			if (!trimmed) throw new Error('Tag name cannot be empty');
			// Dedupe by folded name against every user-kind tag (including
			// zero-member and rb-imported ones the picker may not be showing) —
			// tag.name has no unique constraint, and a duplicate of an
			// rb-imported tag would silently never sync (the exporter keys rb
			// identity off the `rb_` id prefix). Returning the existing row
			// makes "create" converge to "apply the tag you meant".
			const wanted = searchFold(trimmed);
			const existing = db.select().from(tag).where(eq(tag.kind, 'user')).all()
				.find((t) => searchFold(t.name) === wanted);
			if (existing) return existing;
			const id = mut.createTag(db, { name: trimmed, kind: 'user', color: color ?? null, sortOrder: 0 });
			return db.select().from(tag).where(eq(tag.id, id)).get()!;
		},
		async getTrackTags(trackId) {
			const rows = db
				.select({ tagId: trackTag.tagId })
				.from(trackTag)
				.where(eq(trackTag.trackId, trackId))
				.all();
			return rows.map((r) => r.tagId);
		},
		async getTrackTagsBatch(trackIds) {
			if (trackIds.length === 0) return {};
			// Chunked: the renderer calls this with every resident track id
			// (the whole scope until the list is windowed), which overflows the
			// 32766 param cap past ~33k tracks.
			const rows = chunkedIn(trackIds, (chunk) => db
				.select({ trackId: trackTag.trackId, tagId: trackTag.tagId })
				.from(trackTag)
				.where(inArray(trackTag.trackId, chunk))
				.all());
			const out: Record<string, string[]> = {};
			for (const r of rows) {
				(out[r.trackId] ??= []).push(r.tagId);
			}
			return out;
		},
		async addTrackTag(trackId, tagId) {
			// Tag membership lives in track_tag, but the rekordbox exporter's
			// incremental sweep keys "dirty" off track.updatedAt — a tag-only
			// edit would otherwise be invisible to Sync updates and never get
			// pushed. `bump` sets it, mirroring markCuesEdited, only on a real
			// insert: a no-op re-tag must not mark the track dirty.
			mut.tagTracks(db, [trackId], tagId, { bump: true });
		},
		async removeTrackTag(trackId, tagId) {
			// See addTrackTag: keep tag edits visible to the rekordbox sweep.
			mut.untagTracks(db, [trackId], tagId, { bump: true });
		},
		async addTrackTagSkippingLocal(trackIds, tagId) {
			if (trackIds.length === 0) return { added: 0, skipped: 0 };
			// Tracks that already have a local file — skip them. "Add to
			// Basket" is meant for tracks the user still needs to acquire; a
			// link flagged missing_at is a file they no longer have (see
			// resolveLocalFile).
			const haveLocal = new Set(
				chunkedIn(trackIds, (chunk) => db.select({ trackId: sourceLink.trackId })
					.from(sourceLink)
					.where(and(eq(sourceLink.source, 'local'), isNull(sourceLink.missingAt), inArray(sourceLink.trackId, chunk)))
					.all())
					.map((r) => r.trackId)
			);
			const wanted = trackIds.filter((id) => !haveLocal.has(id));
			// See addTrackTag: bump updatedAt on the rows that actually changed
			// so these tag edits are picked up by the rekordbox sweep.
			const addedIds = mut.tagTracks(db, wanted, tagId, { bump: true });
			return { added: addedIds.length, skipped: trackIds.length - wanted.length };
		},
		async recommendForSelection(trackIds) {
			if (trackIds.length === 0) return [];
			// Generous per-kind pool so the renderer can page ("more…") well past
			// the initial row without a refetch, while staying source-balanced.
			const PER_KIND = 30;
			const N = trackIds.length;
			const selSet = new Set(trackIds);

			// Ownership gate for playlists: a followed streaming playlist can't
			// be written to, and a 10k-track editorial playlist would drown the
			// cooccur column with co-memberships the user never curated — so
			// non-owned playlists neither seed nor become candidates.
			const authStatus = auth.getStatus();
			const spotifyMeId = authStatus.spotify.id;
			const tidalMeId = authStatus.tidal.id;
			const ownedPlaylist = (source: string, ownerId: string | null): boolean =>
				source === 'rekordbox' || source === 'local'
					? true
					: source === 'spotify'
						? !!spotifyMeId && ownerId === spotifyMeId
						: !!tidalMeId && ownerId === tidalMeId;

			// ── 1. Selection profile ──────────────────────────────────────
			// Folded genre/label (the *Ascii shadow columns, so matching is
			// case/diacritic-insensitive across sources — rb's "Melodic House &
			// Techno" meets Beatport's "melodic house & techno"), folded artist
			// names, and the analyzer's brightness/power means for the model
			// nudge — one IN-query.
			const selRows = chunkedIn(trackIds, (chunk) => db
				.select({
					genreAscii: track.genreAscii, labelAscii: track.labelAscii,
					brightness: track.brightness, power: track.power,
				})
				.from(track)
				.where(inArray(track.id, chunk))
				.all());
			const genreSet = new Set<string>();
			const labelSet = new Set<string>();
			for (const r of selRows) {
				if (r.genreAscii) genreSet.add(r.genreAscii);
				if (r.labelAscii) labelSet.add(r.labelAscii);
			}
			// Artists by Curator id off the junction — identity is already
			// fold-resolved and aliased there, so no string surgery.
			const artistFreq = new Map<string, number>();
			for (const r of chunkedIn(trackIds, (chunk) => db
				.select({ artistId: trackArtist.artistId })
				.from(trackArtist)
				.where(inArray(trackArtist.trackId, chunk))
				.all())) {
				artistFreq.set(r.artistId, (artistFreq.get(r.artistId) ?? 0) + 1);
			}
			const G = [...genreSet];
			const L = [...labelSet];
			// Cap artists so a compilation selection doesn't fan out into
			// dozens; the most-common ones carry the signal.
			const A = [...artistFreq.entries()]
				.sort((a, b) => b[1] - a[1])
				.map(([id]) => id)
				.slice(0, 8);

			// ── 2. Per-target coverage over the selection ─────────────────
			// How many of the selected tracks each tag/playlist already holds.
			// Drives three things: FULL targets (k = N) are excluded outright;
			// PARTIAL targets (0 < k < N) become the "complete the association"
			// tier up top; and the keys are the cooccur seeds. Seeds are
			// hygiene-filtered — user-kind tags only (interested/basket are
			// workflow infrastructure, not curation signal) and owned, visible
			// playlists only.
			const tagCover = new Map<string, number>();
			chunkedRun(trackIds, (chunk) => {
				for (const r of db.select({ tagId: trackTag.tagId })
					.from(trackTag).innerJoin(tag, eq(tag.id, trackTag.tagId))
					.where(and(inArray(trackTag.trackId, chunk), eq(tag.kind, 'user'))).all()) {
					tagCover.set(r.tagId, (tagCover.get(r.tagId) ?? 0) + 1);
				}
			});
			const plCover = new Map<string, number>();
			chunkedRun(trackIds, (chunk) => {
				// selectDistinct: the same track can sit at two positions in one
				// playlist (schema allows it) — it still covers only once.
				for (const r of db.selectDistinct({
					playlistId: playlistTrack.playlistId, trackId: playlistTrack.trackId,
					source: playlist.source, ownerId: playlist.ownerId,
				})
					.from(playlistTrack).innerJoin(playlist, eq(playlist.id, playlistTrack.playlistId))
					.where(and(
						inArray(playlistTrack.trackId, chunk),
						eq(playlist.isSmart, false), eq(playlist.isHidden, false),
					)).all()) {
					if (!ownedPlaylist(r.source, r.ownerId)) continue;
					plCover.set(r.playlistId, (plCover.get(r.playlistId) ?? 0) + 1);
				}
			});
			const seedTagIds = [...tagCover.keys()];
			const seedPlIds = [...plCover.keys()];
			// Anything already touching the selection is not an affinity
			// candidate — full targets are done, partials get their own tier.
			const excludeIds = new Set<string>([...seedTagIds, ...seedPlIds]);

			// Model-derived brightness/power tags (ported from the old
			// recommendTags). Folded in as a modest bonus, not pinned.
			const mean = (vals: (number | null)[]): number | null => {
				const f = vals.filter((v): v is number => v != null && Number.isFinite(v));
				return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
			};
			const BRIGHT_BY_LEVEL: Record<number, string> = { 5: 'b1', 4: 'b0', 2: 'd1', 1: 'd2' };
			const POWER_BY_LEVEL: Record<number, string> = { 5: 'p5', 4: 'p4', 3: 'p3', 2: 'p2', 1: 'p1' };
			const bLevel = cutoffStore.levelFor('brightness', mean(selRows.map((r) => r.brightness)));
			const pLevel = cutoffStore.levelFor('power', mean(selRows.map((r) => r.power)));
			const wantNames = [
				bLevel ? BRIGHT_BY_LEVEL[bLevel] : undefined,
				pLevel ? POWER_BY_LEVEL[pLevel] : undefined,
			].filter((n): n is string => !!n);
			const modelTagIds = new Set<string>();
			if (wantNames.length) {
				for (const t of db.select({ id: tag.id }).from(tag)
					.where(and(eq(tag.kind, 'user'), inArray(tag.name, wantNames))).all()) {
					modelTagIds.add(t.id);
				}
			}

			// ── 3. Matched-track flags (0/1 per column), excluding the
			// selection's own tracks — we count OTHER tracks that look like it.
			const matched = new Map<string, RecommendColumnCounts>();
			const flag = (id: string, key: keyof RecommendColumnCounts): void => {
				if (selSet.has(id)) return;
				let m = matched.get(id);
				if (!m) { m = { cooccur: 0, artist: 0, genre: 0, label: 0, model: 0 }; matched.set(id, m); }
				m[key] = 1;
			};
			if (G.length) for (const r of db.select({ id: track.id }).from(track)
				.where(and(inArray(track.genreAscii, G), isNull(track.deletedAt))).all()) flag(r.id, 'genre');
			if (L.length) for (const r of db.select({ id: track.id }).from(track)
				.where(and(inArray(track.labelAscii, L), isNull(track.deletedAt))).all()) flag(r.id, 'label');
			// One indexed lookup over the junction replaces the old per-name
			// LIKE full scans (up to 8 per Organize open).
			if (A.length) for (const r of db.select({ trackId: trackArtist.trackId })
				.from(trackArtist).innerJoin(track, eq(track.id, trackArtist.trackId))
				.where(and(inArray(trackArtist.artistId, A), isNull(track.deletedAt))).all()) flag(r.trackId, 'artist');
			// Cooccur joins track so soft-deleted rows drop out — track_tag rows
			// survive a soft delete, and the other three passes already filter
			// deletedAt; this keeps the four signals consistent.
			if (seedTagIds.length) for (const r of db.selectDistinct({ trackId: trackTag.trackId })
				.from(trackTag).innerJoin(track, eq(track.id, trackTag.trackId))
				.where(and(inArray(trackTag.tagId, seedTagIds), isNull(track.deletedAt))).all()) flag(r.trackId, 'cooccur');
			if (seedPlIds.length) for (const r of db.selectDistinct({ trackId: playlistTrack.trackId })
				.from(playlistTrack).innerJoin(track, eq(track.id, playlistTrack.trackId))
				.where(and(inArray(playlistTrack.playlistId, seedPlIds), isNull(track.deletedAt))).all()) flag(r.trackId, 'cooccur');

			const matchedIds = [...matched.keys()];

			// ── 4. Candidate accumulation — sum matched flags over each
			// candidate's membership. One member track contributes ≤1 per column.
			const cand = new Map<string, CandidateCounts>();
			const bump = (id: string, kind: 'tag' | 'playlist', m: RecommendColumnCounts): void => {
				let c = cand.get(id);
				if (!c) { c = { id, kind, columns: { cooccur: 0, artist: 0, genre: 0, label: 0, model: 0 } }; cand.set(id, c); }
				c.columns.cooccur += m.cooccur;
				c.columns.artist += m.artist;
				c.columns.genre += m.genre;
				c.columns.label += m.label;
			};
			chunkedRun(matchedIds, (chunk) => {
				// track_tag's PK is (trackId, tagId) — no dedupe needed here.
				for (const r of db.select({ tagId: trackTag.tagId, trackId: trackTag.trackId })
					.from(trackTag).innerJoin(tag, eq(tag.id, trackTag.tagId))
					.where(and(inArray(trackTag.trackId, chunk), eq(tag.kind, 'user'))).all()) {
					const m = matched.get(r.trackId);
					if (m) bump(r.tagId, 'tag', m);
				}
			});
			chunkedRun(matchedIds, (chunk) => {
				// selectDistinct: a track at two positions in one playlist must
				// not double-vote. Non-owned playlists are dropped so the
				// per-kind pool isn't spent on rows the picker can't write to.
				for (const r of db.selectDistinct({
					playlistId: playlistTrack.playlistId, trackId: playlistTrack.trackId,
					source: playlist.source, ownerId: playlist.ownerId,
				})
					.from(playlistTrack).innerJoin(playlist, eq(playlist.id, playlistTrack.playlistId))
					.where(and(inArray(playlistTrack.trackId, chunk), eq(playlist.isSmart, false), eq(playlist.isHidden, false))).all()) {
					if (!ownedPlaylist(r.source, r.ownerId)) continue;
					const m = matched.get(r.trackId);
					if (m) bump(r.playlistId, 'playlist', m);
				}
			});
			// Model bonus lands on the matched brightness/power tags (whether or
			// not they already have affinity mass).
			for (const tid of modelTagIds) {
				let c = cand.get(tid);
				if (!c) { c = { id: tid, kind: 'tag', columns: { cooccur: 0, artist: 0, genre: 0, label: 0, model: 0 } }; cand.set(tid, c); }
				c.columns.model += 1;
			}

			// ── 5. Score the affinity candidates (covered targets excluded).
			const affinity = scoreCandidates([...cand.values()], { excludeIds, perKind: PER_KIND });

			// ── 6. "Complete the association" tier — targets already on SOME of
			// the selection (0 < k < N) are the strongest recommendation there
			// is: the user put part of this very selection there. They lead the
			// list, ordered by coverage; scored far above affinity so the
			// renderer's score-ordered display keeps them in front.
			const partials: ScoredRecommendation[] = [];
			if (N > 1) {
				for (const [id, k] of tagCover) if (k < N) partials.push({ kind: 'tag', id, score: 1_000_000_000 + k, reason: `on ${k}/${N} selected` });
				for (const [id, k] of plCover) if (k < N) partials.push({ kind: 'playlist', id, score: 1_000_000_000 + k, reason: `on ${k}/${N} selected` });
				partials.sort((a, b) => b.score - a.score);
			}

			const out = [...partials, ...affinity];
			if (out.length > 0) return out;

			// ── 7. Cold-start fallback — nothing matched (fresh files with no
			// genre/label/tags/analysis). Most-popular user tags, so the row is
			// never uselessly empty (parity with the old recommendTags).
			return db.select({ tagId: trackTag.tagId, score: count() })
				.from(trackTag)
				.innerJoin(tag, eq(tag.id, trackTag.tagId))
				.innerJoin(track, eq(track.id, trackTag.trackId))
				.where(and(eq(tag.kind, 'user'), isNull(track.deletedAt)))
				.groupBy(trackTag.tagId)
				.orderBy(desc(count()))
				.limit(10)
				.all()
				.filter((r) => !excludeIds.has(r.tagId))
				.map((r) => ({ kind: 'tag' as const, id: r.tagId, score: r.score, reason: 'popular in your library' }));
		},

		async getSyncStatus() {
			const s = auth.getStatus();
			return {
				spotify: { connected: s.spotify.connected, lastSync: s.spotify.connectedAt },
				tidal: { connected: s.tidal.connected, lastSync: s.tidal.connectedAt },
			};
		},

		// ─── Analyzer ───────────────────────────────────────────────────────
		async enqueueAnalysis(trackIds, opts) {
			if (!analysisQueue) {
				// Reject rather than silently no-op — a user-initiated enqueue
				// with no feedback reads as "the button is broken". The renderer
				// surfaces this as a toast.
				log.for('service').warn('enqueueAnalysis called but analyzer is disabled (no sidecar configured)');
				throw new Error('The analysis sidecar is not available in this build.');
			}
			// Same reasoning for a sidecar that gave up (not found, broken
			// Python env, crash loop): the queue parks rather than failing the
			// backlog, so a click would otherwise just sit in 'queued'.
			const stopped = analyzerSidecar?.disabled;
			if (stopped) throw new Error(`The analyzer is not running: ${stopped}`);
			// Remote rows and streaming-only rows have no file here; the queue
			// drops them (their analysis, if any device made it, arrives
			// through the catalogue). A request made of nothing else is refused
			// so the Analyze modal's toast says why instead of claiming queued
			// work that never runs.
			if (trackIds.length > 0 && splitFileless(db, trackIds).own.length === 0) {
				throw new Error(trackIds.length === 1
					? 'This track has no file on this device — there is nothing to analyze.'
					: 'These tracks have no files on this device — there is nothing to analyze.');
			}
			// Translate the unified flags into the sidecar wire shape here — the
			// one conversion point shared with the scanner's auto-analyze path.
			const analyzeOptions = opts?.analyzeFlags ? analysisFlagsToOptions(opts.analyzeFlags) : undefined;
			analysisQueue.enqueue(trackIds, { priority: opts?.priority, force: opts?.force, analyzeOptions });
		},
		async setAutoAnalyzeSettings(settings) {
			// In-memory only — the renderer's localStorage is the persistent
			// store and re-pushes on every boot. Closure-scoped so the
			// onIngest handler above reads the live settings.
			autoAnalyzeSettings = { ...settings };
			// Mirror the master flag into the AnalysisQueue's auto-enable
			// gate. Enabling here also triggers the stale-version backfill
			// + kicks the drain loop so any queued background jobs start
			// flowing (see AnalysisQueue.setAutoEnabled). Disabling parks
			// priority-0 jobs in 'queued' state without dispatching them
			// until the user re-enables.
			analysisQueue?.setAutoEnabled(settings.enabled);
		},
		async cancelAnalysis(trackId) {
			if (!analysisQueue) return;
			analysisQueue.cancel(trackId);
		},
		async getAnalysisJob(trackId) {
			if (!analysisQueue) return null;
			return analysisQueue.getJob(trackId);
		},
		async getAnalysisStatus() {
			// The chip should reflect only work the analyzer can actually act
			// on. With the queue disabled (no sidecar) nothing dispatches, so
			// report an empty status rather than surfacing orphaned/parked rows
			// as active.
			if (!analysisQueue) return { running: [], queued: 0 };
			// Running track-ids (+ display name via a left join on the track
			// row, so a running job whose track row is missing still surfaces,
			// falling back to the id).
			const runningRows = db
				.select({ trackId: analysisJob.trackId, title: track.title, artists: track.artists })
				.from(analysisJob)
				.leftJoin(track, eq(track.id, analysisJob.trackId))
				.where(eq(analysisJob.state, 'running'))
				.all();
			// Count only the queued jobs the dispatcher would actually pick up,
			// mirroring pickBatch exactly so the chip can't advertise work that
			// will never run:
			//   • priority >= dispatchFloor() — while auto-analyze is off,
			//     priority-0 background jobs are parked behind the gate.
			//   • has a live local source_link (missing_at IS NULL) — the analyzer
			//     only reads local audio; a streaming-only track (no file) is
			//     enqueued by nothing sane, but a stale row or manual analyze
			//     could leave one stuck in `queued`. count(distinct) because a
			//     track with two local links would otherwise be double-counted
			//     by the join.
			const queuedRow = db
				.select({ n: sql<number>`count(distinct ${analysisJob.trackId})` })
				.from(analysisJob)
				.innerJoin(sourceLink, and(
					eq(sourceLink.trackId, analysisJob.trackId),
					eq(sourceLink.source, 'local'),
					isNull(sourceLink.missingAt),
				))
				.where(and(eq(analysisJob.state, 'queued'), gte(analysisJob.priority, analysisQueue.dispatchFloor())))
				.get();
			return {
				running: runningRows.map((r) => ({
					trackId: r.trackId,
					name: r.title ? formatAnalyzerTrackName(r.title, r.artists) : r.trackId,
				})),
				queued: queuedRow?.n ?? 0,
			};
		},
		async getTrackAnalysis(trackId) {
			return db.select().from(trackAnalysis).where(eq(trackAnalysis.trackId, trackId)).get() ?? null;
		},
		async getTrackCues(trackId) {
			return db.select().from(cueTable).where(eq(cueTable.trackId, trackId)).orderBy(asc(cueTable.slot)).all();
		},
		async upsertCue(input) {
			// (trackId, slot, kind) is the unique key — replace the existing
			// row so the user-set cue takes that pad's identity instead of
			// piling up duplicates. Drop first then insert: SQLite's UPSERT
			// would also work but we want a fresh id so listeners can treat
			// "cue changed" and "cue replaced" identically (UI keys by id).
			// One whole-cue `upsert` op for the slot (recordCueChanges).
			const row = {
				id: randomUUID(),
				trackId: input.trackId,
				slot: input.slot,
				positionSec: input.positionSec,
				lengthSec: input.lengthSec,
				color: input.color,
				name: input.name,
				kind: input.kind,
				// User-authored — survives the rekordbox importer's pre-scan
				// wipe (which deletes only origin='rekordbox' rows).
				origin: 'curator' as const,
				createdAt: new Date(),
			};
			mut.recordCueChanges(db, [input.trackId], () => {
				db.delete(cueTable)
					.where(and(
						eq(cueTable.trackId, input.trackId),
						eq(cueTable.slot, input.slot),
						eq(cueTable.kind, input.kind),
					))
					.run();
				db.insert(cueTable).values(row).run();
				markCuesEdited(input.trackId);
			});
			return db.select().from(cueTable).where(eq(cueTable.id, row.id)).get()!;
		},
		async updateCue(cueId, patch) {
			const set: Partial<Pick<Cue, 'name' | 'color' | 'positionSec' | 'lengthSec' | 'origin'>> = {};
			if (patch.name !== undefined) set.name = patch.name;
			if (patch.color !== undefined) set.color = patch.color;
			if (patch.positionSec !== undefined) set.positionSec = patch.positionSec;
			if (patch.lengthSec !== undefined) set.lengthSec = patch.lengthSec;
			const before = db.select({ trackId: cueTable.trackId }).from(cueTable).where(eq(cueTable.id, cueId)).get();
			if (!before) throw new Error(`cue ${cueId} not found`);
			mut.recordCueChanges(db, [before.trackId], () => {
				if (Object.keys(set).length > 0) {
					// Editing an rb-imported cue makes it user-authored: from here
					// on it survives the importer's rekordbox-origin wipe and is
					// arbitrated per-track by LMW instead.
					set.origin = 'curator';
					db.update(cueTable).set(set).where(eq(cueTable.id, cueId)).run();
				}
				markCuesEdited(before.trackId);
			});
			return db.select().from(cueTable).where(eq(cueTable.id, cueId)).get()!;
		},
		async deleteCue(cueId) {
			// Read trackId before deleting so we can stamp the parent track —
			// the exporter needs that stamp to know an empty cue list is
			// intentional rather than "never loaded."
			const row = db.select({ trackId: cueTable.trackId }).from(cueTable).where(eq(cueTable.id, cueId)).get();
			if (!row) return;
			mut.recordCueChanges(db, [row.trackId], () => {
				db.delete(cueTable).where(eq(cueTable.id, cueId)).run();
				markCuesEdited(row.trackId);
			});
		},
		subscribeAnalysisEvents(cb) {
			if (!analysisQueue) return () => {};
			const handler = (e: AnalysisJobEvent): void => { try { cb(e); } catch (err) { log.for('analyzer').error('subscriber threw', err); } };
			analysisQueue.on('event', handler);
			return () => { analysisQueue!.off('event', handler); };
		},

		// ─── Rekordbox ──────────────────────────────────────────────────────
		async detectRekordbox() {
			// Prefer the sidecar's detect (knows about psutil + actual disk
			// presence); fall back to the Node-only path lookup when the
			// sidecar isn't running (e.g. settings opened before it boots).
			if (rekordboxSidecar) {
				try { return await rekordboxSidecar.detect(); }
				catch (err) {
					log.for('rekordbox').warn('detect via sidecar failed; falling back to Node lookup', undefined, err);
				}
			}
			return { dbPath: defaultRekordboxDbPath(), running: false };
		},
		async runRekordboxImport(args) {
			if (!rekordboxImporter || !opts.peaksDir) {
				throw new Error('rekordbox adapter is disabled (no sidecar or peaksDir configured)');
			}
			// Both importer and exporter share the same sidecar process and the
			// sidecar holds at most one DB session at a time. Starting an import
			// while a sync-to-rekordbox is in flight would tear the writer's
			// session apart mid-commit (open() in main.py drops any prior
			// session). Gate at the service edge — symmetric guard lives in
			// syncToRekordbox below.
			if (rekordboxExporter?.isRunning()) {
				throw new Error('a sync-to-rekordbox is in flight — wait for it to complete before running an import');
			}
			const dbPath = args.dbPathOverride ?? defaultRekordboxDbPath();
			if (!dbPath) throw new Error('Rekordbox master.db not found; configure the path in settings');
			return rekordboxImporter.runImport({
				mode: args.mode,
				flags: args.flags,
				dbPath,
				key: args.key,
				peaksDir: opts.peaksDir,
				overwriteCurator: args.overwriteCurator,
			});
		},
		async cancelRekordboxImport() {
			rekordboxImporter?.cancel();
		},
		subscribeRekordboxEvents(cb) {
			if (!rekordboxImporter) return () => {};
			const handler = (e: RekordboxImportEvent): void => { try { cb(e); } catch (err) { log.for('rekordbox').error('subscriber threw', err); } };
			rekordboxImporter.on('event', handler);
			return () => { rekordboxImporter!.off('event', handler); };
		},
		async getRekordboxTree() {
			const folders = db
				.select()
				.from(playlistFolder)
				.where(eq(playlistFolder.source, 'rekordbox'))
				.orderBy(asc(playlistFolder.position), asc(playlistFolder.name))
				.all();
			// Order by Rekordbox's Seq (now persisted to playlist.position) so
			// the sidebar matches the user's manual ordering in the Rekordbox
			// UI. Fall back to name for rows with position=0 (legacy + null).
			const playlists = db
				.select()
				.from(playlist)
				.where(and(eq(playlist.source, 'rekordbox'), eq(playlist.isHidden, false)))
				.orderBy(asc(playlist.position), asc(playlist.name))
				.all();
			return { folders, playlists };
		},

		async findRekordboxMissingFiles() {
			const { existsSync } = await import('node:fs');
			// Candidates: rb-linked tracks with NO live local source_link (a
			// link flagged missing_at is a vanished file — see resolveLocalFile).
			// The tab join is rekordbox_link; a track that also has a local file
			// is playable and never an orphan, so the NOT EXISTS prunes the set
			// hard before we touch the filesystem.
			const rows = db
				.select({
					trackId: rekordboxLink.trackId,
					rbContentId: rekordboxLink.rbContentId,
					rbFilePath: rekordboxLink.rbFilePath,
					title: track.title,
					artists: track.artists,
					overrides: track.overrides,
				})
				.from(rekordboxLink)
				.innerJoin(track, eq(track.id, rekordboxLink.trackId))
				.where(and(
					isNull(track.deletedAt),
					notExists(
						db.select({ one: sql`1` })
							.from(sourceLink)
							.where(and(
								eq(sourceLink.trackId, rekordboxLink.trackId),
								eq(sourceLink.source, 'local'),
								isNull(sourceLink.missingAt),
							)),
					),
				))
				.all();
			const out: RekordboxMissingFile[] = [];
			for (const r of rows) {
				// A link with no recorded path is treated as missing too — there's
				// no file to point at, and it can't be reached from the tab.
				if (r.rbFilePath && existsSync(r.rbFilePath)) continue;
				out.push({
					trackId: r.trackId,
					rbContentId: r.rbContentId,
					title: effectiveTitle(r, creditFormat),
					artist: effectiveArtistName(r, creditFormat),
					filePath: r.rbFilePath,
				});
			}
			return out;
		},

		async removeRekordboxMissingFiles(trackIds) {
			if (trackIds.length === 0) return { removed: 0 };
			// Re-derive the orphan set server-side and intersect with the
			// caller's ids — a stale renderer id whose file reappeared (drive
			// remounted, track re-downloaded) must never delete a live track.
			const orphans = await svcRef!.findRekordboxMissingFiles();
			const orphanById = new Map(orphans.map((o) => [o.trackId, o]));
			const targets = Array.from(new Set(trackIds))
				.map((id) => orphanById.get(id))
				.filter((o): o is RekordboxMissingFile => o != null);
			if (targets.length === 0) return { removed: 0 };

			// Unlink rb peaks (rb_<contentId>.cpk) + analyzer peaks
			// (<trackId>.cpk) up front — derived data, safe to remove eagerly.
			if (opts.peaksDir) {
				const { join } = await import('node:path');
				const { existsSync } = await import('node:fs');
				const { unlink } = await import('node:fs/promises');
				for (const t of targets) {
					for (const tier of ['lo', 'hi'] as const) {
						for (const p of [join(opts.peaksDir, tier, `${t.trackId}.cpk`), join(opts.peaksDir, tier, `rb_${t.rbContentId}.cpk`)]) {
							if (existsSync(p)) { try { await unlink(p); } catch { /* best-effort */ } }
						}
					}
				}
			}

			const now = new Date();
			const ids = targets.map((t) => t.trackId);
			db.transaction((tx) => {
				for (const t of targets) {
					// Tombstone drives the content_delete on the next Sync to
					// Rekordbox. Force pushed_at NULL even if a settled row exists
					// (shouldn't, given the live link — but a stale settled
					// tombstone must re-propagate, not stay silent).
					tx.insert(rekordboxDeletedContent)
						.values({ rbContentId: t.rbContentId, deletedAt: now, pushedAt: null })
						.onConflictDoUpdate({ target: rekordboxDeletedContent.rbContentId, set: { deletedAt: now, pushedAt: null } })
						.run();
				}
				// Drop the links (gone from the tab immediately) and soft-delete
				// the tracks. Streaming source_links + memberships survive — no
				// upstream writes, matching the missing-file cleanup contract.
				chunkedRun(ids, (chunk) => tx.delete(rekordboxLink).where(inArray(rekordboxLink.trackId, chunk)).run());
				// library_track delete per row, inside this transaction.
				mut.softDeleteTracks(db, ids, now);
			});
			log.for('rekordbox').info('removed missing-file orphans', { count: targets.length });
			return { removed: targets.length };
		},

		// ─── Sync FROM rekordbox (scoped pull) ──────────────────────────────
		async syncFromRekordbox(args) {
			if (!rekordboxImporter || !opts.peaksDir) {
				throw new Error('rekordbox adapter is disabled (no sidecar or peaksDir configured)');
			}
			// Shared-sidecar / single-session guards, symmetric with the push
			// pipeline and the read import.
			if (rekordboxImporter.isRunning()) {
				throw new Error('a rekordbox import is already in flight');
			}
			if (rekordboxExporter?.isRunning()) {
				throw new Error('a sync-to-rekordbox is in flight — wait for it to complete before pulling');
			}
			const dbPath = args.dbPathOverride ?? defaultRekordboxDbPath();
			if (!dbPath) throw new Error('Rekordbox master.db not found; configure the path in settings');

			// Resolve the curator selection → the rb ids the sidecar scopes on.
			// rb playlist ids come from curator's `rb_<rbId>` naming (sourceId is
			// the fallback, matching the exporter).
			let rbContentIds: string[] = [];
			let rbPlaylistIds: string[] = [];
			if (args.targetKind === 'tracks') {
				if (args.targetIds.length > 0) {
					rbContentIds = db
						.select({ rb: rekordboxLink.rbContentId })
						.from(rekordboxLink)
						.where(inArray(rekordboxLink.trackId, args.targetIds))
						.all()
						.map((r) => r.rb);
				}
			} else if (args.targetKind === 'playlist') {
				rbPlaylistIds = db
					.select({ id: playlist.id, source: playlist.source, sourceId: playlist.sourceId })
					.from(playlist)
					.where(inArray(playlist.id, args.targetIds))
					.all()
					.filter((p) => p.source === 'rekordbox')
					.map((p) => (p.id.startsWith('rb_') ? p.id.slice(3) : p.sourceId));
			} else {
				// folder — BFS descendants → every rb playlist underneath, the
				// same walk the exporter uses for folder pushes. Unlike the push
				// path, smart + hidden playlists are included: a pull only READS
				// them, and leaving one out means the reader could never report it
				// missing once rekordbox hard-deleted it. The reader expands each
				// to its member content ids.
				const rootFolderId = args.targetIds[0];
				if (rootFolderId) {
					const visited = new Set<string>([rootFolderId]);
					let frontier: string[] = [rootFolderId];
					while (frontier.length > 0) {
						const children = db
							.select({ id: playlistFolder.id })
							.from(playlistFolder)
							.where(and(eq(playlistFolder.source, 'rekordbox'), inArray(playlistFolder.parentFolderId, frontier)))
							.all();
						frontier = [];
						for (const c of children) {
							if (visited.has(c.id)) continue;
							visited.add(c.id);
							frontier.push(c.id);
						}
					}
					rbPlaylistIds = db
						.select({ id: playlist.id, sourceId: playlist.sourceId })
						.from(playlist)
						.where(and(
							eq(playlist.source, 'rekordbox'),
							inArray(playlist.parentFolderId, Array.from(visited)),
						))
						.all()
						.map((p) => (p.id.startsWith('rb_') ? p.id.slice(3) : p.sourceId));
					// The folders themselves ride along: they're DjmdPlaylist rows
					// too, so the reader can report one rekordbox hard-deleted as
					// missing (PlaylistIndex) and the importer prunes it — the only
					// way a stale folder targeted here can ever go away. A live
					// folder just re-emits its own delta (harmless upsert).
					rbPlaylistIds.push(
						...db
							.select({ sourceId: playlistFolder.sourceId })
							.from(playlistFolder)
							.where(and(eq(playlistFolder.source, 'rekordbox'), inArray(playlistFolder.id, Array.from(visited))))
							.all()
							.map((f) => f.sourceId),
					);
				}
			}

			const totals = await rekordboxImporter.runImport({
				mode: 'incremental',
				flags: {
					// Metadata (DjmdContent field merge).
					syncTracks: args.flags.syncTracks,
					// Playlist rows + membership. Meaningless for a bare track
					// selection (no playlist context) — force off there.
					syncPlaylists: args.targetKind === 'tracks' ? false : args.flags.syncPlaylists,
					// MyTags can't be scoped safely — a per-tag wipe-and-re-add
					// would strip the tag from every untargeted track. Never here.
					syncMyTags: false,
					syncCuesGridsPhrases: args.flags.syncCuesGridsPhrases,
					syncWaveformPeaks: args.flags.syncWaveformPeaks,
					// Always refresh play history on a sync-from — it's read-only,
					// full-scan, and idempotent, so the user's set history stays
					// current regardless of which tracks/playlists they targeted.
					syncHistory: true,
				},
				dbPath,
				key: args.key,
				peaksDir: opts.peaksDir,
				target: { rbContentIds, rbPlaylistIds },
			});

			// Same clean pause as the push pipeline: LMW already applied the
			// non-conflicting rb changes during the import; both-sides-changed
			// rows are persisted sync_conflict / playlist_conflict rows the
			// renderer resolves via resolveRekordboxPullConflicts.
			const conflicts = listOpenConflicts(db, creditFormat);
			if (conflicts.length > 0) return { status: 'conflicts', conflicts };
			return { status: 'completed', totals };
		},
		async resolveRekordboxPullConflicts(args) {
			if (rekordboxImporter?.isRunning() || rekordboxExporter?.isRunning()) {
				throw new Error('a rekordbox sync is in flight — wait for it to complete before resolving conflicts');
			}
			// 'theirs' writes rb → Curator; 'ours' keeps Curator + converges the
			// baseline. No push — the pull direction ends here.
			const { applied, skipped } = applyConflictResolutions(db, args.resolutions);
			log.for('rekordbox-sync').info('pull conflict resolutions', { applied, skipped });
			return { applied, skipped };
		},

		// ─── Rekordbox WRITE-side ───────────────────────────────────────────
		async previewRekordboxCreate(playlistId) {
			const plan = await planCreatePhase(db, playlistId, true, creditFormat);
			if (!plan) return null;
			return {
				tracks: plan.contentOps.length,
				withAnalysis: plan.contentOps.filter((o) => o.source_rb_content_id != null).length,
				playlist: plan.playlistOp != null,
				unplayable: plan.unplayable,
			};
		},
		async previewRekordboxCreateTracks(trackIds) {
			const plan = await planCreateForTracks(db, trackIds, creditFormat);
			if (!plan) return null;
			return {
				tracks: plan.contentOps.length,
				withAnalysis: plan.contentOps.filter((o) => o.source_rb_content_id != null).length,
				playlist: false,
				unplayable: plan.unplayable,
			};
		},
		async syncToRekordbox(args) {
			if (!rekordboxExporter) {
				throw new Error('rekordbox adapter is disabled (no sidecar configured)');
			}
			// Mirror of the importer-side guard (see runRekordboxImport):
			// the shared sidecar can only hold one session at a time, so
			// the two flows must serialize. The pipeline's own pull→push
			// phases are strictly sequential for the same reason.
			if (rekordboxImporter?.isRunning()) {
				throw new Error('a rekordbox import is in flight — wait for it to complete before syncing');
			}
			if (rekordboxExporter.isRunning()) {
				throw new Error('a sync-to-rekordbox is already in flight');
			}
			const dbPath = args.dbPathOverride ?? defaultRekordboxDbPath();
			if (!dbPath) throw new Error('Rekordbox master.db not found; configure the path in settings');

			// Phase 1 — PULL. A full incremental reconcile of rb's data into
			// Curator BEFORE we push: track fields + cues + beatgrids +
			// phrases + waveform peaks (playlists conditionally; see below).
			// Not just conflict-detection data — rekordbox re-analyzes tracks
			// (new/changed grids + waveforms), and nothing else backfills the
			// rb analysis slot or the rb_*.cpk files: the waveform pass is
			// cpk-freshness-gated, not push-driven, so a track that rb analyzed
			// after our last from-rekordbox sync would otherwise stay
			// grid/waveform-less indefinitely (its wavemap never renders) even
			// as its metadata/cues sync through here. Pulling the ANLZ data
			// closes that gap on every push. Pull progress is re-emitted on the
			// export event stream so the modal's progress bar covers the whole
			// pipeline.
			if (rekordboxImporter && opts.peaksDir) {
				const peaksDir = opts.peaksDir;
				const fwd = (e: RekordboxImportEvent): void => {
					if (e.kind === 'progress') {
						rekordboxExporter!.emit('event', {
							kind: 'progress', phase: `pull:${e.phase}`, done: e.done, total: e.total,
						} satisfies RekordboxExportEvent);
					}
				};
				rekordboxImporter.on('event', fwd);
				try {
					await rekordboxImporter.runImport({
						mode: 'incremental',
						flags: {
							syncTracks: true,
							// Pull playlists for playlist/folder/updates targets so the
							// 3-way membership merge runs BEFORE the push — rb-side
							// adds/reorders land in Curator and a both-sides reorder
							// surfaces a playlistConflict that Phase 2 pauses on.
							// Without this the push diffs Curator-vs-baseline blind to
							// rb's current order and clobbers manual rb reorders. 'tracks'
							// pushes no playlist ops, so it stays off (a playlist pull
							// could only pause it on an unrelated order conflict). The
							// pull is incremental + USN-watermarked: no rb churn → no deltas.
							syncPlaylists:
								args.targetKind === 'playlist'
								|| args.targetKind === 'folder'
								|| args.targetKind === 'updates',
							syncMyTags: false,
							// Cues + beatgrids + phrases (one ANLZ load) and the
							// waveform bands. Cues run a three-way merge that can
							// surface a cue conflict → Phase 2 pause; that's the
							// intended reconciliation. Grids/phrases/waveforms write
							// only the rb-owned slot (rb_* columns + rb_*.cpk) — no
							// LMW, no conflict surface — so they never pause the push,
							// they just refresh. Cost: the waveform pass isn't
							// USN-gated, so it stat-walks every content row each push
							// (seconds) and only reloads ANLZ for rows whose .cpk is
							// stale/missing. Supersedes the old cuesLite pull.
							syncCuesGridsPhrases: true,
							syncWaveformPeaks: true,
							// Play history is never PUSHED (read-only on the rb
							// side), but the push pipeline's pull phase is the
							// natural moment to refresh it — so a Sync to Rekordbox
							// also brings the user's set history current.
							syncHistory: true,
						},
						dbPath,
						key: args.key,
						peaksDir,
					});
				} finally {
					rekordboxImporter.off('event', fwd);
				}
			}

			// Phase 2 — pause on open conflicts (library-wide: the pull may
			// have surfaced divergence on tracks outside this push target,
			// and those are just as real). Clean pause — no write session
			// is open, conflicts are persisted rows.
			const conflicts = listOpenConflicts(db, creditFormat);
			if (conflicts.length > 0) {
				return { status: 'conflicts', conflicts };
			}

			// Phase 3 — PUSH.
			const result = await rekordboxExporter.runExport({
				targetKind: args.targetKind,
				targetIds: args.targetIds,
				flags: args.flags,
				dbPath,
				key: args.key,
			});
			return { status: 'completed', result };
		},
		async resolveSyncConflicts(args) {
			if (args.provider !== 'rekordbox') {
				throw new Error(`unknown sync provider: ${args.provider}`);
			}
			if (!rekordboxExporter) {
				throw new Error('rekordbox adapter is disabled (no sidecar configured)');
			}
			if (rekordboxImporter?.isRunning() || rekordboxExporter.isRunning()) {
				throw new Error('a rekordbox sync is in flight — wait for it to complete before resolving conflicts');
			}
			const dbPath = args.dbPathOverride ?? defaultRekordboxDbPath();
			if (!dbPath) throw new Error('Rekordbox master.db not found; configure the path in settings');
			const { applied, skipped } = applyConflictResolutions(db, args.resolutions);
			log.for('rekordbox-sync').info('conflict resolutions', { applied, skipped });
			// Resume the push with the original target + flags. Any conflict
			// the user left unresolved is still shielded by the exporter.
			return rekordboxExporter.runExport({
				targetKind: args.targetKind,
				targetIds: args.targetIds,
				flags: args.flags,
				dbPath,
				key: args.key,
			});
		},
		subscribeRekordboxExportEvents(cb) {
			if (!rekordboxExporter) return () => {};
			const handler = (e: RekordboxExportEvent): void => {
				try { cb(e); }
				catch (err) { log.for('rekordbox-export').error('subscriber threw', err); }
			};
			rekordboxExporter.on('event', handler);
			return () => { rekordboxExporter!.off('event', handler); };
		},
		async listRekordboxBackups(dbPathOverride) {
			if (!rekordboxSidecar) return [];
			const dbPath = dbPathOverride ?? defaultRekordboxDbPath();
			if (!dbPath) return [];
			const { backups } = await rekordboxSidecar.listBackups(rekordboxDirOf(dbPath));
			return backups;
		},
		async clearRekordboxBackups(dbPathOverride) {
			if (!rekordboxSidecar) return { deleted: 0, freedBytes: 0 };
			const dbPath = dbPathOverride ?? defaultRekordboxDbPath();
			if (!dbPath) return { deleted: 0, freedBytes: 0 };
			return rekordboxSidecar.clearBackups(rekordboxDirOf(dbPath));
		},
		async restoreRekordboxBackup(backupPath, dbPathOverride) {
			if (!rekordboxSidecar) {
				throw new Error('rekordbox adapter is disabled (no sidecar configured)');
			}
			const dbPath = dbPathOverride ?? defaultRekordboxDbPath();
			if (!dbPath) throw new Error('Rekordbox master.db not found; configure the path in settings');
			await rekordboxSidecar.restoreBackup(backupPath, dbPath);
		},
		async listCuePalette() {
			// Process-life cache — the palette is static for a given rb
			// version, and the underlying RPC opens no db (just returns the
			// in-memory list from palette.py). One round trip per launch.
			if (cuePaletteCache) return cuePaletteCache;
			if (!rekordboxSidecar) {
				// Disabled-sidecar configurations (tests, headless CLI) get an
				// empty palette — renderer's `cueColor()` fallback handles it.
				return [];
			}
			const res = await rekordboxSidecar.listCuePalette();
			cuePaletteCache = res.entries;
			return cuePaletteCache;
		},

		async mirStatus() {
			return mirLayer.status();
		},
		async setMirSettings(patch) {
			return mirLayer.setSettings(patch);
		},
		async mirAnalyzeNow(trackIds) {
			return mirLayer.analyzeNow(trackIds);
		},
		async mirProvision() {
			return mirLayer.provision();
		},
		async getSimilarTracks(q) {
			const { filter, ...rest } = q;
			const scoped = filter && Object.values(filter).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0));
			const allow = scoped ? new Set(getTrackIdsImpl(db, filter, undefined, 200_000, isFollowedPlaylist)) : null;
			return mirLayer.rank({ ...rest, seeds: rest.seeds ?? [], allow });
		},
		async getTrackVector(trackId, model) {
			return mirLayer.trackVector(trackId, model);
		},
		subscribeMirEvents(cb) {
			return mirLayer.subscribe(cb);
		},

		async getBackupSettings() { return backupService.getSettings(); },
		async setBackupSettings(patch) { return backupService.setSettings(patch); },
		async getBackupStatus() { return backupService.getStatus(); },
		async getBackupTargetStat() {
			const h = backupHostLazy();
			const t = backupService.getSettings().target;
			if (!h || !t) return null;
			try { return await h.targetStat(t); } catch { return null; }
		},
		async listBackupSnapshots(opts) { return backupService.listSnapshots(opts); },
		async runBackupNow() { return backupService.runNow(); },
		async cancelBackup(runId) { return backupService.cancel(runId); },
		async pinBackupSnapshot(snapshotId, label) { return backupService.pin(snapshotId, label); },
		async deleteBackupSnapshot(snapshotId) { return backupService.deleteSnapshot(snapshotId); },
		async previewBackupRestore(snapshotId) { return backupService.restorePreview(snapshotId); },
		async restoreBackup(req) { return backupService.restore(req); },
		async remapLibraryRoot(from, to) {
			const r = remapLocalPaths(sqlite, normalizePath(from), normalizePath(to));
			// Watchers are keyed by folder path — restart them on the new root.
			await libraryScanner.stopAll().catch(() => { /* best-effort */ });
			await svcRef!.startLibraryWatching().catch((err) => log.for('backup').warn('watcher restart after remap failed', undefined, err));
			return r;
		},
		startBackupScheduler() { backupService.startScheduler(); },
		subscribeBackupEvents(cb) { return backupService.subscribe(cb); },

		async getCloudSyncStatus() { return cloudStatusReport(); },
		async cloudSyncNow() {
			if (cloudClient) await cloudClient.syncNow();
			return cloudStatusReport();
		},
		subscribeCloudSync(cb) {
			return cloudClient ? cloudClient.subscribe(cb) : () => { /* sync disabled */ };
		},
		async getCloudSyncPollSettings() { return readPollSettings(sqlite); },
		async setCloudSyncPollPolicy(patch) {
			const next = writePollPolicy(sqlite, patch);
			cloudClient?.setPollPolicy(next.policy);
			cloudActivity?.setIdleAfterMs(next.policy.idleAfterSec * 1000);
			return next;
		},
		async getAccountLibraryInfo() { return accountLibraryInfo(); },
		async setMasterDevice(deviceId) {
			if (!cloudClient) throw new Error('Cloud sync is off in this build.');
			if (!serverReadsTrackMeta(cloudClient.serverFeatures())) throw new Error('The sync server does not support a master device yet — sync once more, or update the server.');
			if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 128) throw new Error('Not a device id.');
			setMasterDevice(sqlite, deviceId);
			// The next cycle pushes it and re-picks this device's remote rows.
			requestRematerialize(sqlite);
			cloudClient.wake('local');
			return accountLibraryInfo();
		},
		async unlinkCloudLibrary() {
			if (!cloudClient) return { outcome: null, status: cloudStatusReport() };
			const outcome = await cloudClient.unlink();
			// The catalogue was working for the old id under the ended session;
			// it re-reads both on its next wake (a sign-in).
			return { outcome, status: cloudStatusReport() };
		},
		startCloudSync() {
			if (!cloudClient || cloudWakeUnsub) return;
			cloudClient.start();
			catalogue?.start();
			cloudWakeUnsub = opts.cloud?.subscribeWakeups?.((reason) => {
				cloudClient.wake(reason);
				if (reason) catalogue?.wake(reason);
			}) ?? (() => { /* no wake source */ });
			cloudActivity = opts.cloud?.watchActivity?.((active) => cloudClient.setActive(active)) ?? null;
			cloudActivity?.setIdleAfterMs(readPollPolicy(sqlite).idleAfterSec * 1000);
		},

		async getCatalogueStatus() { return catalogueStatusReport(); },
		async setCatalogueSettings(patch) {
			if (catalogue) return catalogue.setSettings(patch);
			// No layer: still a device setting the user may set ahead of time.
			const cur = readCatalogueSettings(sqlite);
			writeCatalogueSettings(sqlite, {
				...cur,
				...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
				...(typeof patch.vectors === 'boolean' ? { vectors: patch.vectors } : {}),
				...(typeof patch.maxKBps === 'number' && Number.isFinite(patch.maxKBps) ? { maxKBps: clampKbps(patch.maxKBps) } : {}),
			});
			return catalogueStatusReport();
		},
		async setCatalogueBackfill(action) {
			if (!catalogue) throw new Error('Shared analysis is not available in this build.');
			return catalogue.setBackfill(action);
		},
		subscribeCatalogue(cb) {
			return catalogue ? catalogue.subscribe(cb) : () => { /* no catalogue */ };
		},

		close() {
			// Stop cloud sync before the DB closes: a cycle mid-apply would
			// otherwise write into a closed handle.
			cloudWakeUnsub?.();
			cloudActivity?.stop();
			cloudActivity = null;
			cloudClient?.stop();
			catalogue?.stop();
			// Stop the backup scheduler + engine host first: a run mid-upload
			// must not outlive the DB it snapshotted.
			backupService.stop();
			// Stop chokidar watchers before closing the SQLite handle — late
			// ingestion ticks could otherwise hit a closed DB.
			libraryScanner.stopAll().catch(() => { /* best-effort */ });
			// Kill converter children (they'd otherwise finish writing a .part
			// nobody will rename) before the DB they report into closes.
			wavConverter.cancelActive();
			// Discard the analyze backlog on shutdown — pending (queued +
			// running) jobs are dropped so the app doesn't grind through a
			// stale queue on next launch. Terminal rows (done/error/skipped)
			// are kept as history. Must run before sqlite.close() below.
			analysisQueue?.clearPending();
			// Tear the analyzer sidecar down cleanly so its worker pool isn't
			// orphaned. shutdown() races against a 2s SIGKILL fallback so we
			// can fire-and-forget without blocking close().
			analyzerSidecar?.shutdown().catch(() => { /* best-effort */ });
			rekordboxSidecar?.shutdown().catch(() => { /* best-effort */ });
			// Any pending debounced cutoff recompute is dropped on shutdown —
			// next boot's staleness check picks up whatever analyses landed since.
			cutoffStore.cancelPendingRecompute();
			// Stop per-source poll timers so they don't fire after the DB
			// handle is gone.
			sourceScheduler.stopAll();
			albumEnricher.stop();
			feedService.stop(); // stops scheduler + enrichment + closes feed.db
			knowledgeService.stop(); // stops the expansion queue + closes knowledge.db
			void researcherSidecar?.shutdown();
			agentService.stop(); // closes agent.db
			void agentSidecar?.shutdown();
			void mirLayer.close(); // engine shutdown (3 s grace) + closes mir.db
			sqlite.close();
		},
	};
	svcRef = service;
	return service;
}

// Column map for ZTrackFilter.scalarBounds. Most entries are indexed on
// `track` (see schema.ts) so a pushed bound can hit an index; the count
// columns (playCount/dropCount/breakdownCount) aren't — they're rarely the
// primary filter and SQLite picks the best single index per query anyway.
const SCALAR_BOUND_COLUMNS = {
	rating: track.rating,
	duration: track.duration,
	playCount: track.playCount,
	dropCount: track.dropCount,
	breakdownCount: track.breakdownCount,
	loudnessRangeLu: track.loudnessRangeLu,
	dissonance: track.dissonance,
	density: track.density,
	brightness: track.brightness,
	power: track.power,
	dynamicComplexity: track.dynamicComplexity,
	introLengthSec: track.introLengthSec,
	outroLengthSec: track.outroLengthSec,
	firstDropSec: track.firstDropSec,
} as const;

// Run a per-chunk IN query and concatenate the rows — keeps any single
// statement under SQLite's bound-param cap (SQLITE_MAX_VARIABLE_NUMBER =
// 32766). Use at every batch read whose id list is caller-supplied and can
// exceed that: the renderer batch-loads tags / playlist memberships for the
// whole resident scope, and bulk actions can target a select-all set.
// ─── Artist helpers ─────────────────────────────────────────────────────────
// A trailing bracketed tag the platforms use to tell homonyms apart: a 2–3
// letter code ("(EG)", "(tr)") or one capitalised word ("(Tulum)").
const ARTIST_DISAMBIGUATOR_RE = /\s*[([](?:[A-Za-z]{2,3}|[A-Z][a-z]+)[)\]]\s*$/;
const hasArtistDisambiguator = (name: string): boolean => ARTIST_DISAMBIGUATOR_RE.test(name);
const stripArtistDisambiguator = (name: string): string => name.replace(ARTIST_DISAMBIGUATOR_RE, '');
const artistPairKey = (a: string, b: string): string => [a, b].sort().join('|');
const ARTIST_MERGE_DISMISSED_KEY = 'artist_merge_dismissed';
function loadDismissedArtistMerges(db: Db): Set<string> {
	const row = db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, ARTIST_MERGE_DISMISSED_KEY)).get();
	return new Set(Array.isArray(row?.value) ? (row!.value as unknown[]).filter((x): x is string => typeof x === 'string') : []);
}

type ArtistSummaryRow = {
	id: string; name: string; nameAscii: string; mergedInto: string | null;
	nameCuratedAt: Date | null; trackCount: number;
};

// artist ⟕ track_artist ⟕ live track, grouped by artist — the one shape
// every artist read uses so counts can't drift between list/get/resolve.
// An optional scope narrows the counted tracks to a tab's membership (any
// of the given sources — see sourceMembership). It rides on the track
// join's ON clause, so out-of-scope tracks count as absent rather than
// dropping the artist row.
function artistSummaryQuery(db: Db, scope?: ArtistScope) {
	const scoped = scope && scope.sources.length > 0 ? sourceMembership(scope.sources) : null;
	return db
		.select({
			id: artist.id, name: artist.name, nameAscii: artist.nameAscii,
			mergedInto: artist.mergedInto, nameCuratedAt: artist.nameCuratedAt,
			trackCount: sql<number>`count(${track.id})`,
		})
		.from(artist)
		.leftJoin(trackArtist, eq(trackArtist.artistId, artist.id))
		.leftJoin(track, scoped ? and(eq(track.id, trackArtist.trackId), isNull(track.deletedAt), scoped) : and(eq(track.id, trackArtist.trackId), isNull(track.deletedAt)))
		.$dynamic();
}

function toArtistSummary(r: ArtistSummaryRow): ArtistSummary {
	return { id: r.id, name: r.name, nameAscii: r.nameAscii, trackCount: Number(r.trackCount ?? 0), mergedInto: r.mergedInto, nameCuratedAt: r.nameCuratedAt };
}

// Resolve an artist id through its alias chain to the live row.
function lookupLiveArtist(db: Db, id: string): { id: string; name: string; nameAscii: string } | null {
	let cur = db.select({ id: artist.id, name: artist.name, nameAscii: artist.nameAscii, mergedInto: artist.mergedInto }).from(artist).where(eq(artist.id, id)).get();
	for (let hops = 0; cur?.mergedInto && hops < 8; hops++) {
		cur = db.select({ id: artist.id, name: artist.name, nameAscii: artist.nameAscii, mergedInto: artist.mergedInto }).from(artist).where(eq(artist.id, cur.mergedInto)).get();
	}
	return cur ? { id: cur.id, name: cur.name, nameAscii: cur.nameAscii } : null;
}

// Every artist row (live or alias) whose chain ends at `liveId`, itself
// included: the spelling keys an alias rule must name. UNION, not UNION ALL,
// so a corrupt cyclic merge cannot recurse forever.
function artistFoldsOf(db: Db, liveId: string): Array<{ name: string; nameAscii: string }> {
	return rawOf(db).prepare(`WITH RECURSIVE a(id, name, name_ascii) AS (
			SELECT id, name, name_ascii FROM artist WHERE id = ?
			UNION SELECT r.id, r.name, r.name_ascii FROM artist r JOIN a ON r.merged_into = a.id
		) SELECT name, name_ascii AS nameAscii FROM a ORDER BY name_ascii`).all(liveId) as Array<{ name: string; nameAscii: string }>;
}

// Re-derive the canonical credits of every track a rename / merge reaches,
// rewrite the override lists it names, then re-mirror artists_ascii and
// re-derive the junction. Bumps updatedAt: a rename/merge is a user edit the
// rekordbox push should carry upstream.
//
// Canonical credits are DERIVED (library/artist-alias.ts, consumer 2): the
// track's source credits (artists_base) under the converged alias map, which
// already holds this rename's rules (the caller emits them first). That is
// the same function a device that pulls the rules runs, so the two end with
// identical lists, and a concurrent rename of the same artist elsewhere that
// later wins re-derives these rows from their source spelling rather than
// from this device's rename of it. Candidates are the tracks the junction
// links to `artistIds`, every track with an override list (a canonical list
// hidden under an override is not in the junction) and every track with
// recorded source credits (one a rename rewrote away is not either); only
// those whose credits name a key of `rules` are touched.
//
// The override lists are mapped by `rules` and travel as set-override ops
// (recordTrackStateChanges diffs them): they are op-log records, and the
// pulling device does not rewrite records itself; a record left naming the
// old artist would be projected back onto the row by the next op for that
// track.
function rewriteArtistCredits(db: Db, artistIds: Set<string>, rules: ReadonlyMap<string, string>, now: Date): number {
	const raw = rawOf(db);
	const linked = chunkedIn([...artistIds], (chunk) => db
		.selectDistinct({ trackId: trackArtist.trackId })
		.from(trackArtist)
		.where(inArray(trackArtist.artistId, chunk))
		.all()).map((r) => r.trackId);
	const withOverrideArtists = (raw.prepare(`SELECT id FROM track WHERE json_extract(overrides, '$.artists') IS NOT NULL`).all() as Array<{ id: string }>).map((r) => r.id);
	const withBase = raw.prepare(`SELECT id FROM track WHERE artists_base IS NOT NULL`).pluck().all() as string[];
	const trackIds = [...new Set([...linked, ...withOverrideArtists, ...withBase])];
	const target = (key: string): string | undefined => rules.get(key);
	const keys = new Set(rules.keys());
	const alias = loadArtistAliasMap(raw);
	const relink = new Set(linked);
	let rewritten = 0;
	mut.recordTrackStateChanges(db, trackIds, () => {
		const canonChanged = new Set(rederiveTrackCreditsRaw(raw, trackIds, keys, alias, now.getTime()));
		for (const id of trackIds) {
			const row = db.select({ artists: track.artists, overrides: track.overrides }).from(track).where(eq(track.id, id)).get();
			if (!row) continue;
			const ov = row.overrides?.artists ? mapCredits(row.overrides.artists, target) : null;
			if (!canonChanged.has(id) && !ov?.changed) continue;
			if (ov?.changed) {
				const nextOverrides = { ...row.overrides, artists: ov.list } as TrackOverrides;
				db.update(track)
					.set({ overrides: nextOverrides, artistsAscii: asciifyArtists(ov.list), updatedAt: now })
					.where(eq(track.id, id))
					.run();
			}
			relink.add(id);
			rewritten++;
		}
	});
	syncTrackArtistsById(db, [...relink]);
	return rewritten;
}

function chunkedIn<T>(ids: string[], run: (chunk: string[]) => T[], size = 500): T[] {
	const out: T[] = [];
	for (let i = 0; i < ids.length; i += size) out.push(...run(ids.slice(i, i + size)));
	return out;
}

// Void variant for chunked write statements (DELETE / UPDATE ... WHERE id IN).
function chunkedRun(ids: string[], run: (chunk: string[]) => void, size = 500): void {
	for (let i = 0; i < ids.length; i += size) run(ids.slice(i, i + size));
}

// The dynamic-query type the filter ladder produces. The join branches all
// reassign `q` with different select shapes, so it stays loosely typed (the
// branches cast `as unknown as TrackDynQuery`) — the row normalizer at the
// bottom of getTracksImpl re-narrows `{ t: track, pp?, ta? }` back to Track.
type TrackDynQuery = ReturnType<ReturnType<typeof baseTrackQuery>['$dynamic']>;
function baseTrackQuery(db: Db) {
	return db.select().from(track);
}

// Shared filter/join builder for every track read — the page, its COUNT, and
// the id-only read all go through this so the predicate can never drift between
// them. Returns the narrowed dynamic query (no sort / limit / offset / row
// decoration), or `{ empty: true }` for a filter that resolves to nothing
// (e.g. an unknown library folder).
// Album header summaries — chunked IN reads over album / album_artist and
// the live member tracks (label + genre fallbacks, count, cover track).
function readAlbumSummaries(raw: ReturnType<typeof rawOf>, ids: readonly string[]): AlbumSummary[] {
	const requested = [...new Set(ids)].filter(Boolean);
	const liveOf = new Map<string, string>();
	for (const id of requested) {
		const live = liveAlbumIdRaw(raw, id);
		if (live) liveOf.set(id, live);
	}
	const liveIds = [...new Set(liveOf.values())];
	type AlbumRowR = { id: string; title: string; artists_source: string; release_date: string | null; label: string | null; album_type: string | null; total_tracks: number | null };
	type ArtistRowR = { album_id: string; id: string; name: string };
	type MemberRowR = { album_id: string; id: string; label: string | null; genre: string | null; cover_url: string | null; release_date: string | null; overrides: string | null };
	const albums = new Map<string, AlbumRowR>();
	const artists = new Map<string, Array<{ id: string; name: string }>>();
	const members = new Map<string, MemberRowR[]>();
	for (let i = 0; i < liveIds.length; i += 500) {
		const chunk = liveIds.slice(i, i + 500);
		const ph = chunk.map(() => '?').join(',');
		for (const r of raw.prepare(`SELECT id, title, artists_source, release_date, label, album_type, total_tracks FROM album WHERE id IN (${ph})`).all(...chunk) as AlbumRowR[]) {
			albums.set(r.id, r);
		}
		for (const r of raw.prepare(`
			SELECT aa.album_id, ar.id, ar.name FROM album_artist aa JOIN artist ar ON ar.id = aa.artist_id
			WHERE aa.album_id IN (${ph}) ORDER BY aa.album_id, aa.position`).all(...chunk) as ArtistRowR[]) {
			const arr = artists.get(r.album_id) ?? [];
			arr.push({ id: r.id, name: r.name });
			artists.set(r.album_id, arr);
		}
		for (const r of raw.prepare(`
			SELECT album_id, id, label, genre, cover_url, release_date, overrides FROM track
			WHERE album_id IN (${ph}) AND deleted_at IS NULL
			ORDER BY coalesce(disc_number, 1), coalesce(track_number, 1000000), created_at`).all(...chunk) as MemberRowR[]) {
			const arr = members.get(r.album_id) ?? [];
			arr.push(r);
			members.set(r.album_id, arr);
		}
	}
	// Most common non-empty value first; ties keep first-seen order.
	const ranked = (values: Array<string | null | undefined>): string[] => {
		const counts = new Map<string, number>();
		for (const v of values) {
			const t = (v ?? '').trim();
			if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
		}
		return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
	};
	const ov = (json: string | null): TrackOverrides | null => {
		if (!json) return null;
		try { return JSON.parse(json) as TrackOverrides; } catch { return null; }
	};
	const out: AlbumSummary[] = [];
	for (const id of requested) {
		const liveId = liveOf.get(id);
		const a = liveId ? albums.get(liveId) : undefined;
		if (!a) continue;
		const mem = members.get(a.id) ?? [];
		out.push({
			id,
			title: a.title,
			artists: a.artists_source === 'various' ? [] : (artists.get(a.id) ?? []),
			various: a.artists_source === 'various',
			releaseDate: a.release_date ?? ranked(mem.map((m) => ov(m.overrides)?.releaseDate ?? m.release_date))[0] ?? null,
			label: a.label ?? ranked(mem.map((m) => ov(m.overrides)?.label ?? m.label))[0] ?? null,
			genres: ranked(mem.map((m) => ov(m.overrides)?.genre ?? m.genre)).slice(0, 3),
			albumType: a.album_type,
			totalTracks: a.total_tracks,
			trackCount: mem.length,
			coverTrackId: (mem.find((m) => m.cover_url) ?? mem[0])?.id ?? null,
		});
	}
	return out;
}

// A track's membership in a set of sources, as one SQL predicate (any-of).
// 'rekordbox' lives in rekordbox_link — rekordbox tracks are matched to a
// local file on import and carry no source='rekordbox' source_link — while
// every other source is a source_link row. The renderer already presents
// rekordbox as one of a track's `sources` (decorateTracks unions it in);
// this is the SQL side of that vocabulary, shared by getTracks'
// hasSource / lacksSource and the artist scope so the two can't drift.
function sourceMembership(sources: readonly string[], opts: { remote?: boolean } = {}): SQL {
	const parts: SQL[] = [];
	const linkSources = sources.filter((s) => s !== 'rekordbox');
	if (linkSources.length > 0) {
		const list = sql.join(linkSources.map((s) => sql`${s}`), sql`, `);
		// A local link flagged missing_at is not a file on disk (see
		// resolveLocalFile); no other source carries that state.
		parts.push(sql`EXISTS (SELECT 1 FROM source_link sl WHERE sl.track_id = ${track.id} AND sl.source IN (${list}) AND (sl.source <> 'local' OR sl.missing_at IS NULL))`);
	}
	if (sources.includes('rekordbox')) {
		parts.push(sql`EXISTS (SELECT 1 FROM rekordbox_link rl WHERE rl.track_id = ${track.id})`);
	}
	// A remote row (track.remoteOnly) has no links here; it stands where the
	// device whose meta it shows holds the track (remote_source), so a file
	// on the master is in this device's library root too, marked "not on
	// this device". rekordbox is not a meta source: a remote row never
	// claims it.
	// `lacksSource` asks what this device lacks: a remote row lacks it all.
	const remote = opts.remote === false ? [] : sources.filter((s) => s === 'local' || s === 'spotify' || s === 'tidal');
	if (remote.length > 0) {
		parts.push(sql`(${track.remoteOnly} = 1 AND ${track.remoteSource} IN (${sql.join(remote.map((s) => sql`${s}`), sql`, `)}))`);
	}
	if (parts.length === 0) return sql`0`;
	return parts.length === 1 ? parts[0]! : sql`(${sql.join(parts, sql` OR `)})`;
}

// Is this playlist one the user follows but can't modify (a delete leaves the
// track in it)? Owned by createCoreService, where the account ids live.
type FollowedPlaylistProbe = (playlistId: string) => boolean;

function buildFilteredTrackQuery(
	db: Db,
	filter: ZTrackFilterT | undefined,
	isFollowed: FollowedPlaylistProbe,
): { empty: true } | { empty: false; q: TrackDynQuery } {
	let q: TrackDynQuery = db.select().from(track).$dynamic();

	const conditions = [];
	if (filter?.state) conditions.push(eq(track.state, filter.state));
	if (filter?.ids && filter.ids.length > 0) conditions.push(inArray(track.id, filter.ids));
	if (filter?.bpmMin !== undefined) conditions.push(gte(track.bpm, filter.bpmMin));
	if (filter?.bpmMax !== undefined) conditions.push(lte(track.bpm, filter.bpmMax));
	// Indexed scalar range bounds from the query grammar (rating>=4,
	// diss<0.3, …). NULL columns fail gte/lte in SQL exactly like the
	// in-memory matchTrack pass fails comparisons on missing analyzer data,
	// so push-down can't widen the result set.
	for (const b of filter?.scalarBounds ?? []) {
		const col = SCALAR_BOUND_COLUMNS[b.field];
		if (!col) continue;
		if (b.min !== undefined) conditions.push(gte(col, b.min));
		if (b.max !== undefined) conditions.push(lte(col, b.max));
	}
	if (filter?.keyCamelot) conditions.push(eq(track.keyCamelot, filter.keyCamelot));
	if (filter?.genre) conditions.push(eq(track.genre, filter.genre));
	if (filter?.label) conditions.push(eq(track.label, filter.label));
	// Source membership (any-of / none) — pushed predicates, so the Rekordbox
	// tab root, the grammar's `source:` terms and the SRC-pip filters all work
	// windowed. 'rekordbox' resolves to rekordbox_link inside sourceMembership.
	if (filter?.hasSource) {
		const has = Array.isArray(filter.hasSource) ? filter.hasSource : [filter.hasSource];
		if (has.length > 0) conditions.push(sourceMembership(has));
	}
	if (filter?.lacksSource) {
		conditions.push(sql`NOT ${sourceMembership([filter.lacksSource], { remote: false })}`);
	}
	if (filter?.hideRemote) conditions.push(eq(track.remoteOnly, false));
	// Album scope by id — the indexed album_id column. Ids are resolved
	// through merge aliases first so a scope opened before a merge (a pinned
	// search, a history entry) still finds the release.
	if (filter?.albumIds && filter.albumIds.length > 0) {
		const raw = rawOf(db);
		const live = [...new Set(filter.albumIds.map((id) => liveAlbumIdRaw(raw, id) ?? id))];
		conditions.push(inArray(track.albumId, live));
	}
	// Artist scope by id — indexed EXISTS on the junction, OR within the list.
	if (filter?.artistIds && filter.artistIds.length > 0) {
		conditions.push(exists(db.select({ one: sql`1` }).from(trackArtist)
			.where(and(eq(trackArtist.trackId, track.id), inArray(trackArtist.artistId, filter.artistIds)))));
	}
	if (filter?.search) {
		// Multi-column OR — title, album, label, genre, both key spellings,
		// and the artist-names blob. Text fields hit their `*_ascii` shadow
		// columns with a `searchFold`-ed term so "Bohmer" finds "Böhmer"
		// (and vice-versa). Key columns are ASCII codes ("8A", "Em") and
		// don't need folding. A pure-numeric query also unions an exact
		// bpm match (rounded) so "120" surfaces 120.x BPM tracks — bpm is
		// real (carries decimals). Shadow columns maintained by asciify() at every
		// track write site — see @curator/shared/search.
		const term = filter.search;
		const asciiPat = `%${searchFold(term)}%`;
		const pat = `%${term}%`;
		const orParts = [
			like(track.titleAscii, asciiPat),
			like(track.albumTitleAscii, asciiPat),
			like(track.labelAscii, asciiPat),
			like(track.genreAscii, asciiPat),
			like(track.keyCamelot, pat),
			like(track.artistsAscii, asciiPat),
		];
		// Key is stored only as Camelot now — let the user still search by
		// musical notation ("Am") by converting the term at query time.
		const camFromTerm = keyToCamelot(term);
		if (camFromTerm) orParts.push(eq(track.keyCamelot, camFromTerm));
		const asNum = Number(term);
		if (Number.isFinite(asNum) && /^\d+$/.test(term)) {
			orParts.push(sql`round(${track.bpm}) = ${asNum}`); // round: bpm has decimals (91.13), so "91" still matches
		}
		conditions.push(or(...orParts)!);
	}
	// Soft-delete visibility: a deleted track doesn't exist, in EVERY scope
	// except a FOLLOWED streaming playlist read on its own. A delete can't
	// take the track out of a playlist the user doesn't own, so it stays
	// there and the renderer paints a "deleted" chip. Any other playlist
	// still holding a deleted row (a missing-file cleanup, a delete synced
	// from another device) hides it like every other scope. `conditions` is
	// spread into every join branch below and the no-scope base, so this
	// single guard covers them all.
	if (!(filter?.playlistId && isFollowed(filter.playlistId))) conditions.push(isNull(track.deletedAt));
	if (conditions.length) q = q.where(and(...conditions));

	// playlist + source filters need joins
	if (filter?.playlistId) {
		// Single-playlist read: include playlist_track.position so the renderer
		// can show the canonical "#" (track's identity within the playlist).
		// Stays stable across client-side sort/filter — see Track.playlistPosition.
		q = db
			.select({ t: track, pp: playlistTrack.position })
			.from(track)
			.innerJoin(playlistTrack, eq(playlistTrack.trackId, track.id))
			.where(and(eq(playlistTrack.playlistId, filter.playlistId), ...(conditions.length ? conditions : [])))
			.$dynamic() as unknown as typeof q;
	} else if (filter?.playlistIds && filter.playlistIds.length > 0) {
		// Multi-playlist aggregate — used when a Rekordbox folder is selected
		// in the sidebar. The renderer expands the folder into the set of
		// descendant playlist ids and we union them. GROUP BY track.id
		// dedupes so a track appearing in N of the selected playlists shows
		// once. Per-playlist position (the "#" column in playlist context)
		// becomes meaningless across a union, so the index sort falls back
		// to track.createdAt — see indexSortColumn below.
		q = db
			.select({ t: track })
			.from(track)
			.innerJoin(playlistTrack, eq(playlistTrack.trackId, track.id))
			.where(and(inArray(playlistTrack.playlistId, filter.playlistIds), ...(conditions.length ? conditions : [])))
			.groupBy(track.id)
			.$dynamic() as unknown as typeof q;
	}
	// Tag filter — joins track_tag. Takes precedence over source/folder
	// filters because it's the primary signal for the Interested / Basket
	// views; passing both filters at once is allowed but the tag join
	// narrows the result set further by intersecting.
	//
	// `nameClauses` is the omnibar/filterbox `#name` syntax under the merged
	// `#` namespace — each clause expands to `(EXISTS track_tag OR EXISTS
	// playlist_track JOIN playlist)`; clauses AND together. The OR within a
	// clause is what gives us the "track has a tag named X OR is in a
	// playlist named X" semantics without splitting `#` into two operators.
	// Single-tag (`filter.tagId`, used by Interested/Basket) keeps the
	// existing simpler join — no EXISTS-AND needed and the column-set stays
	// clean for the row normalization at the bottom.
	const nameClauses = filter?.nameClauses ?? [];
	if (nameClauses.length > 0 && !filter?.playlistId) {
		const clauseConds = nameClauses.map((c) => {
			const parts: ReturnType<typeof sql>[] = [];
			if (c.tagIds.length > 0) {
				parts.push(sql`EXISTS (SELECT 1 FROM track_tag WHERE track_tag.track_id = ${track.id} AND track_tag.tag_id IN (${sql.join(c.tagIds.map((id) => sql`${id}`), sql`, `)}))`);
			}
			if (c.playlistNamesAscii.length > 0) {
				parts.push(sql`EXISTS (SELECT 1 FROM playlist_track pt JOIN playlist p ON pt.playlist_id = p.id WHERE pt.track_id = ${track.id} AND p.name_ascii IN (${sql.join(c.playlistNamesAscii.map((n) => sql`${n}`), sql`, `)}))`);
			}
			// extractSqlPrefilter filters out empty clauses upstream, but be
			// defensive — an empty clause should short-circuit to "match
			// nothing", not silently drop the constraint.
			if (parts.length === 0) return sql`0`;
			if (parts.length === 1) return parts[0]!;
			return sql`(${sql.join(parts, sql` OR `)})`;
		});
		// When the user is in a tag view (Interested/Basket) AND types `#name`
		// in the filterbox, keep both narrows — the tag-id join AND the
		// EXISTS conditions intersect.
		if (filter?.tagId) {
			q = db
				.select({ t: track, ta: trackTag.addedAt })
				.from(track)
				.innerJoin(trackTag, eq(trackTag.trackId, track.id))
				.where(and(eq(trackTag.tagId, filter.tagId), ...clauseConds, ...(conditions.length ? conditions : [])))
				.$dynamic() as unknown as typeof q;
		} else {
			q = db
				.select()
				.from(track)
				.where(and(...clauseConds, ...(conditions.length ? conditions : [])))
				.$dynamic() as unknown as typeof q;
		}
	} else if (filter?.tagId && !filter?.playlistId) {
		q = db
			.select({ t: track, ta: trackTag.addedAt })
			.from(track)
			.innerJoin(trackTag, eq(trackTag.trackId, track.id))
			.where(and(eq(trackTag.tagId, filter.tagId), ...(conditions.length ? conditions : [])))
			.$dynamic() as unknown as typeof q;
	} else
	// Library-folder filter — joins source_link where source='local' and the
	// file path falls under the folder's root. Implies source='local'; takes
	// precedence over the plain source filter when both are passed.
	if (filter?.libraryFolderId && !filter?.playlistId) {
		const folder = db.select().from(libraryFolder).where(eq(libraryFolder.id, filter.libraryFolderId)).get();
		if (!folder) {
			// Unknown folder id → empty result; bypass the rest of the query.
			return { empty: true };
		}
		const prefix = folder.path.endsWith('/') ? folder.path : folder.path + '/';
		q = db
			.select({ t: track })
			.from(track)
			.innerJoin(sourceLink, eq(sourceLink.trackId, track.id))
			.where(and(
				eq(sourceLink.source, 'local'),
				// A vanished file is no longer in the folder (see resolveLocalFile).
				isNull(sourceLink.missingAt),
				like(sourceLink.filePath, `${prefix}%`),
				...(conditions.length ? conditions : []),
			))
			.$dynamic() as unknown as typeof q;
	} else if (filter?.source && !filter?.playlistId) {
		q = db
			.select({ t: track })
			.from(track)
			.innerJoin(sourceLink, eq(sourceLink.trackId, track.id))
			.where(and(eq(sourceLink.source, filter.source), ...(conditions.length ? conditions : [])))
			.$dynamic() as unknown as typeof q;
	}

	return { empty: false, q };
}

// Apply the user's sort (or the default bpm-asc) to a filtered track query.
// `index` maps to playlist position in a single-playlist context, else
// track.createdAt; tag views surface track_tag.added_at for the "Added" column.
// Shared by the page read and the id-only read so ordering can't drift.
function applyTrackSort(
	q: TrackDynQuery,
	filter: ZTrackFilterT | undefined,
	sort: ZTrackSortT | undefined,
): TrackDynQuery {
	// 'match' only means something inside a similarTo scope (ordered in
	// memory there); anywhere else it falls back to the default order.
	if (sort?.column === 'match') sort = undefined;
	if (sort) {
		const isTagView = !!filter?.tagId && !filter?.playlistId;
		const col = sort.column === 'index'
			? indexSortColumn({ playlistContext: !!filter?.playlistId })
			: sort.column === 'createdAt' && isTagView
				? trackTag.addedAt
				: sharedSortColumn(sort.column);
		if (col) return q.orderBy(sort.dir === 'desc' ? desc(col) : asc(col)) as TrackDynQuery;
		return q;
	}
	return q.orderBy(asc(track.bpm)) as TrackDynQuery;
}

// Total rows matching `filter` — wraps the shared builder as a subquery so a
// page and its count always agree (and the GROUP BY dedupe in the playlistIds
// branch is counted as distinct tracks, not raw join rows).
function countTracksImpl(db: Db, filter: ZTrackFilterT | undefined, isFollowed: FollowedPlaylistProbe): number {
	const built = buildFilteredTrackQuery(db, filter, isFollowed);
	if (built.empty) return 0;
	const sub = built.q.as('cnt_sub');
	const row = db.select({ n: sql<number>`count(*)` }).from(sub).get();
	return row?.n ?? 0;
}

// Ordered ids matching `filter` — for whole-result operations that can't read
// from the renderer's sparse page cache (play-all / build queue / select-all).
// Capped to bound an accidental unbounded request; bulk mutations over an
// unbounded scope use predicate selection instead. Reuses the page ladder, so
// it currently reads full rows (Phase 2 narrows this to an id-only projection).
function getTrackIdsImpl(
	db: Db,
	filter: ZTrackFilterT | undefined,
	sort: ZTrackSortT | undefined,
	cap: number,
	isFollowed: FollowedPlaylistProbe,
): string[] {
	const built = buildFilteredTrackQuery(db, filter, isFollowed);
	if (built.empty) return [];
	const q = applyTrackSort(built.q, filter, sort).limit(cap) as TrackDynQuery;
	return q.all().map((r: unknown) => {
		const obj = r as Record<string, unknown>;
		const t = (obj.t ? obj.t : r) as { id: string };
		return t.id;
	});
}

function getTracksImpl(
	db: Db,
	cutoffStore: CutoffStore,
	filter: ZTrackFilterT | undefined,
	sort: ZTrackSortT | undefined,
	limit: number,
	offset: number,
	isFollowed: FollowedPlaylistProbe,
): Track[] {
	const built = buildFilteredTrackQuery(db, filter, isFollowed);
	if (built.empty) return [];
	const q = applyTrackSort(built.q, filter, sort).limit(limit).offset(offset) as TrackDynQuery;

	const rows = q.all();
	// when we joined we get { t: Track } shape; normalize back. Single-playlist
	// joins also carry `pp` (playlist_track.position) — attach it as
	// Track.playlistPosition so the renderer's idx column can show the
	// stable playlist position rather than the in-array index.
	const tracks = rows.map((r: unknown) => {
		const obj = r as Record<string, unknown>;
		const t = (obj.t ? obj.t : r) as Track;
		const out = applyOverrides(t);
		if (obj.pp != null) out.playlistPosition = obj.pp as number;
		// Tag-view reads (Pinned / Basket) carry track_tag.added_at as `ta` —
		// surface it as the membership-relative "Added" time so the column
		// reflects when the track was pinned, not when the recording first
		// entered the library (createdAt, which a feed-promoted dupe predates).
		if (obj.ta != null) out.addedAt = obj.ta as Date;
		return out;
	});

	return decorateTracks(db, cutoffStore, tracks);
}

// Attach the renderer-facing decorations to raw (applyOverrides'd) Track rows:
// source-link pips, playlist-name membership, and per-metric bucket levels.
// Any CoreService method that hands Track rows to the renderer cache must run
// this — a bare applyOverrides row has no `sources`, so patching one into a
// visible tracklist row (e.g. commitRating's patchOne) would blank the SRC
// pips. This is the single home for that hydration; getTracksImpl and the
// write methods that return Track[] both delegate here.
function decorateTracks(db: Db, cutoffStore: CutoffStore, tracks: Track[]): Track[] {
	// Batched source-link lookup — single query per chunk for all tracks,
	// grouped client-side. Avoids one-per-row IPC over many tracks while
	// keeping the join out of the caller's paginated query (which would
	// multiply rows and break per-row sort/limit). Chunked at 500: SQLite caps
	// bound params (SQLITE_MAX_VARIABLE_NUMBER = 32766) — same chunk size as
	// every other batched IN site in this file.
	if (tracks.length) {
		const ids = tracks.map((t) => t.id);
		const bySrc = new Map<string, string[]>();
		for (let i = 0; i < ids.length; i += 500) {
			// A missing_at local link gets no pip — the same rule as
			// sourceMembership, so `source:local` means the same thing in SQL
			// and in the renderer's in-memory matchTrack.
			const linkRows = db
				.selectDistinct({ trackId: sourceLink.trackId, source: sourceLink.source })
				.from(sourceLink)
				.where(and(
					inArray(sourceLink.trackId, ids.slice(i, i + 500)),
					or(ne(sourceLink.source, 'local'), isNull(sourceLink.missingAt)),
				))
				.all();
			for (const r of linkRows) {
				const arr = bySrc.get(r.trackId) ?? [];
				arr.push(r.source);
				bySrc.set(r.trackId, arr);
			}
		}
		// Rekordbox membership isn't a source_link (provenance lives in
		// rekordbox_link) — union it into the same array so the renderer's
		// in-memory matchTrack can evaluate `source:rekordbox` exactly like
		// the SQL `hasSource: 'rekordbox'` predicate (sourceMembership). The
		// SRC-pip renderer whitelists which sources get pips.
		for (let i = 0; i < ids.length; i += 500) {
			const rbRows = db
				.select({ trackId: rekordboxLink.trackId })
				.from(rekordboxLink)
				.where(inArray(rekordboxLink.trackId, ids.slice(i, i + 500)))
				.all();
			for (const r of rbRows) {
				const arr = bySrc.get(r.trackId) ?? [];
				arr.push('rekordbox');
				bySrc.set(r.trackId, arr);
			}
		}
		for (const t of tracks) t.sources = bySrc.get(t.id) ?? [];
		// Claim-derived provider ids (sync-log/claim-links.ts): a separate
		// field, never `sources` — see Track.claimSources. Same chunked shape.
		const derived = claimLinksOf(rawOf(db), ids);
		for (const t of tracks) {
			const d = derived.get(t.id);
			// One entry per provider (a row may know several ids of one), and
			// none the row holds an own link of — a pip says "known only from
			// the account".
			t.claimSources = d ? [...new Set(d.map((l) => l.source))].filter((s) => !t.sources!.includes(s)) : [];
		}

		// Same shape, for playlist-name memberships. Powers the in-memory
		// matchTrack pass for `#name` tokens (filterbox path): without this
		// the renderer would have to either re-issue SQL on every keystroke
		// or carry a global playlist-membership cache. Batched DISTINCT join
		// is cheap — one query per chunk, naturally limited by page size.
		const byTrack = new Map<string, string[]>();
		for (let i = 0; i < ids.length; i += 500) {
			const plRows = db
				.selectDistinct({ trackId: playlistTrack.trackId, nameAscii: playlist.nameAscii })
				.from(playlistTrack)
				.innerJoin(playlist, eq(playlist.id, playlistTrack.playlistId))
				.where(inArray(playlistTrack.trackId, ids.slice(i, i + 500)))
				.all();
			for (const r of plRows) {
				if (!r.nameAscii) continue;
				const arr = byTrack.get(r.trackId) ?? [];
				arr.push(r.nameAscii);
				byTrack.set(r.trackId, arr);
			}
		}
		for (const t of tracks) t.playlistNamesAscii = byTrack.get(t.id) ?? [];

		// Curator artist ids, position-aligned with the effective artists
		// array (the seam derives both from the same list). Same chunked
		// shape as the pips above — one query per 500 rows, never per row.
		const artistIdsByTrack = new Map<string, Array<{ position: number; artistId: string }>>();
		for (let i = 0; i < ids.length; i += 500) {
			const rows = db
				.select({ trackId: trackArtist.trackId, artistId: trackArtist.artistId, position: trackArtist.position })
				.from(trackArtist)
				.where(inArray(trackArtist.trackId, ids.slice(i, i + 500)))
				.all();
			for (const r of rows) {
				const arr = artistIdsByTrack.get(r.trackId) ?? [];
				arr.push({ position: r.position, artistId: r.artistId });
				artistIdsByTrack.set(r.trackId, arr);
			}
		}
		for (const t of tracks) {
			const arr = artistIdsByTrack.get(t.id);
			if (!arr) continue;
			const out: string[] = [];
			for (const e of arr.sort((a, b) => a.position - b.position)) out[e.position] = e.artistId;
			t.artistIds = out;
		}
	}

	// Decorate with bucket levels (1..5) per metric, computed against the
	// in-memory cutoff snapshot loaded at service boot. Null raw → null level;
	// per-metric below-threshold sample count also yields null. UI uses null
	// to render a "needs analysis" placeholder rather than a misleading 1/5.
	for (const t of tracks) {
		t.brightnessLevel         = cutoffStore.levelFor('brightness',         t.brightness);
		t.powerLevel              = cutoffStore.levelFor('power',              t.power);
		t.dissonanceLevel         = cutoffStore.levelFor('dissonance',         t.dissonance);
		t.densityLevel            = cutoffStore.levelFor('density',            t.density);
		t.loudnessRangeLuLevel    = cutoffStore.levelFor('loudness_range_lu',  t.loudnessRangeLu);
		t.dynamicComplexityLevel  = cutoffStore.levelFor('dynamic_complexity', t.dynamicComplexity);
		t.introLengthSecLevel     = cutoffStore.levelFor('intro_length_sec',   t.introLengthSec);
		t.outroLengthSecLevel     = cutoffStore.levelFor('outro_length_sec',   t.outroLengthSec);
		t.firstDropSecLevel       = cutoffStore.levelFor('first_drop_sec',     t.firstDropSec);
	}

	return tracks;
}

// User overrides shadow canonical fields at read time. Sync/enrichment
// writers keep updating the canonical columns underneath, so changes from
// Spotify/Beatport are still observable in `overrides`-less rows or via
// future "Reset to source" UI.

// Provider URL → track id parsers. Accept both full URLs and bare IDs.
// Spotify track URLs are 22-char base62 ids: open.spotify.com/track/<id> or
// spotify:track:<id>. Tidal: tidal.com/browse/track/<id>, /track/<id>,
// listen.tidal.com/track/<id>. Beatport: beatport.com/track/<slug>/<numeric>.

function parseSpotifyTrackId(s: string): string | null {
	const v = s.trim();
	const m = v.match(/(?:open\.spotify\.com\/track\/|spotify:track:)([A-Za-z0-9]{22})/);
	if (m && m[1]) return m[1];
	if (/^[A-Za-z0-9]{22}$/.test(v)) return v;
	return null;
}

function parseTidalTrackId(s: string): string | null {
	const v = s.trim();
	const m = v.match(/tidal\.com\/(?:browse\/)?track\/(\d+)/);
	if (m && m[1]) return m[1];
	if (/^\d+$/.test(v)) return v;
	return null;
}

function parseBeatportTrackId(s: string): number | null {
	const v = s.trim();
	const m = v.match(/beatport\.com\/track\/[^/]+\/(\d+)/);
	if (m && m[1]) return Number(m[1]);
	if (/^\d+$/.test(v)) return Number(v);
	return null;
}

