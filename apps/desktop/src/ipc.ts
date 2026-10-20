import type { Track, Playlist, PlaylistFolder, PinnedSearch, TrackOverrides, LibraryFolder, Tag, TrackAnalysis, Cue, CueKind, AnalysisJob, PlayRecordUpsert } from '@curator/shared';
import type { ZTrackFilterT, ZTrackSortT, ZTrackPageReqT, TrackPage, ZStateCountsT, StreamingSource, SourceSyncSettings, DjSyncProvider, SyncConflictChoice, ArtistSummary, ArtistListOpts, ArtistLink, ArtistMergeSuggestion, ArtistScope, ArtistCreditFormat, AlbumSummary } from '@curator/shared';
import type { SetSourceLinksResult, RemovableTrackSource, RemoveTrackSourcesResult, TrackMergePreview, TrackMergeOutcome, UpstreamPushOutcome, PlaylistUpstreamDrift, AuthStatus, SyncProgress, DownloadProgress, DownloadJob, QueueSummary, QueueEvent, ScanProgress, AnalysisJobEvent, AnalysisFlags, AutoAnalyzeSettings, RekordboxImportEvent, RekordboxFlags, RekordboxImportTotals, RekordboxExportEvent, ExportFlags, RekordboxExportResult, RekordboxSyncOutcome, RekordboxPullOutcome, RekordboxBackupSummary, RekordboxClearBackupsResult, RekordboxMissingFile, CuePaletteEntry, WavSettings, WavPreview, WavConvertEvent, ClearableTrackField, FeedPage, FeedItem, FeedItemDetail, FeedAction, FeedActionResult, FeedRefreshResult, JourneyDetail, JourneyNode, JourneySeed, JourneySummary, KbAspect, KbEntity, KbEntityDetail, KbEntityKind, KbEvent, KbExpansion, AgentEvent, AgentProvider, AgentStatus, AgentSessionSummary, AgentSessionDetail, AgentResultSet, AgentViewContext, MirEvent, MirSettings, MirStatus, SimilarQuery, SimilarResult, BackupSettings, BackupStatus, BackupSnapshotSummary, BackupRestorePreview, BackupRestoreRequest, BackupTargetStat, BackupEvent, CloudSyncStatusReport, SyncPollPolicy, SyncPollSettings, CloudSyncApplied, CatalogueStatus, CatalogueSettingsPatch, CatalogueBackfillAction } from '@curator/core';
import type { DeviceInfo } from '@curator/protocol';
import type { LogRecord } from '@curator/shared/log';

// Renderer → main fire-and-forget log shipping. NOT in TOOL_CATALOG — that
// catalog is invoke-shaped (every entry has a return the renderer awaits),
// and a log record must never add renderer latency. The preload exposes it
// as api.log.send via ipcRenderer.send; main writes the batch into its root
// logger's sinks (enforcing proc:'renderer' server-side).
export const LOG_BATCH_CHANNEL = 'log:batch' as const;

// IPC contract — channel name → (args, return)
export interface IpcChannels {
	'tracks:list': {
		args: [filter?: ZTrackFilterT, sort?: ZTrackSortT, limit?: number, offset?: number];
		ret: Track[];
	};
	// Windowed list — the path every track-list surface uses. Returns one page
	// + the matching total so the renderer sizes its virtual scroll.
	'tracks:page': {
		args: [filter?: ZTrackFilterT, sort?: ZTrackSortT, req?: ZTrackPageReqT];
		ret: TrackPage;
	};
	// Ordered ids for the whole result set — play-all / queue / select-all.
	'tracks:ids': {
		args: [filter?: ZTrackFilterT, sort?: ZTrackSortT];
		ret: string[];
	};
	'playlists:list': { args: []; ret: Playlist[] };
	'tracks:playlists': { args: [trackId: string]; ret: { playlist: Playlist; folderPath: PlaylistFolder[] }[] };
	'playlists:set-favorite': { args: [playlistId: string, isFavorite: boolean]; ret: void };
	'playlists:rename':       { args: [playlistId: string, newName: string]; ret: { pushedToSource: boolean } };
	'playlists:rename-folder': { args: [folderId: string, newName: string]; ret: void };
	'playlists:reorder': { args: [playlistId: string, newOrder: number[]]; ret: void };
	'tracks:playlists-batch':        { args: [trackIds: string[]]; ret: Record<string, string[]> };
	'playlists:list-with-folders':   { args: []; ret: { playlist: Playlist; folderPath: PlaylistFolder[] }[] };
	'playlists:add-tracks':          { args: [playlistId: string, trackIds: string[]]; ret: { added: number; skipped: number; noUpstreamTrackIds: string[]; upstream: UpstreamPushOutcome } };
	'playlists:remove-tracks':       { args: [playlistId: string, trackIds: string[]]; ret: { removed: number; upstream: UpstreamPushOutcome } };
	'playlists:upstream-drift':      { args: [playlistId: string]; ret: PlaylistUpstreamDrift };
	'playlists:push-local-only':     { args: [playlistId: string, sourceTrackIds?: string[]]; ret: { pushed: number; snapshotId: string | null } };
	'playlists:find-tracks-with-deleted-files': { args: [playlistIds: string[]]; ret: { playlistId: string; trackIds: string[] }[] };
	'pinned:list':   { args: []; ret: PinnedSearch[] };
	'pinned:create': { args: [input: { name: string; query: string; sort?: { column: string; dir: 'asc' | 'desc' } | null }]; ret: PinnedSearch };
	'pinned:rename': { args: [id: string, newName: string]; ret: PinnedSearch };
	'pinned:delete': { args: [id: string]; ret: void };
	'playlists:create-local': { args: [name: string, trackIds: string[]]; ret: Playlist };
	'playlists:create-streaming': { args: [source: StreamingSource, name: string, trackIds: string[]]; ret: { playlist: Playlist; added: number; skipped: number } };
	'sources:get-sync-settings': { args: []; ret: Record<StreamingSource, SourceSyncSettings> };
	'sources:set-sync-settings': { args: [source: StreamingSource, settings: SourceSyncSettings]; ret: void };
	// Credit display format — core-owned (app_setting) because the rekordbox
	// push formats Title/Artist with it; the renderer mirrors it in its UI
	// settings for instant display.
	'credits:get-format': { args: []; ret: { format: ArtistCreditFormat; stored: boolean } };
	'credits:set-format': { args: [fmt: ArtistCreditFormat]; ret: void };
	// Convert to WAV — playlist → lossless WAV copies + "<name> [WAV]".
	'wav:get-settings': { args: []; ret: WavSettings };
	'wav:set-settings': { args: [settings: { outputDir: string }]; ret: WavSettings };
	'wav:preview': { args: [playlistId: string]; ret: WavPreview };
	'wav:convert': { args: [playlistId: string]; ret: { runId: string } };
	'wav:cancel': { args: [runId: string]; ret: void };
	'tracks:state-counts': { args: []; ret: ZStateCountsT };
	'tracks:source-counts': { args: []; ret: { spotify: number; tidal: number; local: number } };
	'sync:status': {
		args: [];
		ret: {
			spotify: { connected: boolean; lastSync: Date | null };
			tidal: { connected: boolean; lastSync: Date | null };
		};
	};
	'auth:status': { args: []; ret: AuthStatus };
	'auth:spotify:start': { args: []; ret: AuthStatus };
	'auth:spotify:disconnect': { args: []; ret: AuthStatus };
	'auth:tidal:start': { args: []; ret: AuthStatus };
	'auth:tidal:disconnect': { args: []; ret: AuthStatus };
	'sync:spotify:run': { args: [opts?: { deleteRemoved?: boolean; force?: boolean }]; ret: { playlists: number; tracksUpserted: number; removed: number } };
	'sync:spotify:plan': { args: []; ret: { toAdd: number; toUpdate: number; toRemove: { id: string; sourceId: string; name: string }[] } };
	'sync:spotify:playlist': { args: [playlistId: string, opts?: { force?: boolean }]; ret: { tracksUpserted: number; tracksEnriched: number; skipped: boolean } };
	'sync:tidal:run': { args: [opts?: { force?: boolean }]; ret: { playlists: number; tracksUpserted: number } };
	'sync:tidal:playlist': { args: [playlistId: string, opts?: { force?: boolean }]; ret: { tracksUpserted: number; skipped: boolean } };
	'enrich:beatport:playlist': { args: [playlistId: string, sort?: { column: ZTrackSortT['column']; dir: 'asc' | 'desc' }]; ret: { enriched: number; scanned: number } };
	'enrich:beatport:track': { args: [trackId: string]; ret: { enriched: number; scanned: number } };
	'enrich:beatport:tracks': { args: [trackIds: string[]]; ret: { enriched: number; scanned: number } };
	'tidal:match-tracks': { args: [trackIds: string[]]; ret: { matched: number; scanned: number } };
	'tracks:source-links': { args: [trackId: string]; ret: { source: string; sourceTrackId: string; url: string | null }[] };
	'tracks:set-overrides': {
		args: [trackId: string, patch: Partial<Record<keyof TrackOverrides, TrackOverrides[keyof TrackOverrides] | null>>];
		ret: Track | null;
	};
	'tracks:set-source-links': {
		args: [trackId: string, urls: { spotify?: string | null; tidal?: string | null; beatport?: string | null }];
		ret: SetSourceLinksResult;
	};
	'tracks:delete-source-link': { args: [trackId: string, source: 'spotify' | 'tidal' | 'beatport']; ret: void };
	'tracks:merge-preview': { args: [aId: string, bId: string]; ret: TrackMergePreview };
	'tracks:merge': { args: [keepId: string, dropId: string]; ret: TrackMergeOutcome };
	'tracks:clear-fields': { args: [trackId: string, fields: ClearableTrackField[]]; ret: Track | null };
	'tracks:field-options': { args: []; ret: { genres: string[]; labels: string[] } };
	// ─── Artists — library artist entities (CoreService.listArtists et al.) ──
	'artists:list':    { args: [opts?: ArtistListOpts]; ret: ArtistSummary[] };
	'artists:get':     { args: [id: string]; ret: ArtistSummary | null };
	'artists:resolve': { args: [name: string]; ret: ArtistSummary | null };
	'artists:links':   { args: [id: string]; ret: ArtistLink[] };
	'artists:merge-suggestions': { args: [scope?: ArtistScope]; ret: ArtistMergeSuggestion[] };
	'artists:dismiss-merge':     { args: [aId: string, bId: string]; ret: void };
	'artists:rename':  { args: [id: string, newName: string]; ret: { artist: ArtistSummary; tracksRewritten: number } };
	'artists:merge':   { args: [keepId: string, dropId: string]; ret: { artist: ArtistSummary; tracksRewritten: number } };
	// ─── Albums — library release entities (CoreService.getAlbumsByIds) ──
	'albums:by-ids':   { args: [ids: string[]]; ret: AlbumSummary[] };
	'tracks:set-rating':   { args: [trackIds: string[], rating: number | null]; ret: Track[] };
	'tracks:delete':       { args: [trackIds: string[]]; ret: { deletedTracks: number; filesTrashed: number; peaksRemoved: number; playlistsTouched: number; errors: { kind: 'file' | 'peaks' | 'playlist'; message: string }[] } };
	'tracks:remove-sources': { args: [trackIds: string[], sources: RemovableTrackSource[]]; ret: RemoveTrackSourcesResult };
	'tracks:undelete':     { args: [trackIds: string[]]; ret: { restored: string[] } };
	// PlayTracker upsert — same id flows insert → checkpoint → finalize.
	'plays:record': { args: [e: PlayRecordUpsert]; ret: void };
	'shell:open-external': { args: [url: string]; ret: void };
	'tidal:match-track': { args: [trackId: string]; ret: { tidalId: string } | null };
	'tidal:set-playlist-hybrid': { args: [playlistId: string, enabled: boolean, sort?: { column: ZTrackSortT['column']; dir: 'asc' | 'desc' }]; ret: { matched: number; scanned: number; enabled: boolean } };
	'enrich:cancel': { args: []; ret: void };
	'tidal:download:enable': { args: []; ret: { connected: boolean } };
	'tidal:download:status': { args: []; ret: { enabled: boolean } };
	'tidal:download:track': { args: [trackId: string]; ret: { outputPath: string; bytes: number } };
	'tidal:download:enqueue': { args: [items: { trackId: string; trackTitle: string; artistName: string }[]]; ret: void };
	'tidal:download:retry': { args: [trackId: string]; ret: void };
	'tidal:download:queue': { args: []; ret: DownloadJob[] };
	'tidal:download:summary': { args: []; ret: QueueSummary };
	'tidal:download:clear-completed': { args: []; ret: void };
	'tidal:download:clear-all': { args: []; ret: void };
	'tidal:download:redownload': { args: [trackId: string]; ret: void };
	'tidal:download:verify': { args: []; ret: { total: number; ok: number; missing: number; corrupt: number; sizeMismatch: number; neverDownloaded: number; inProgress: number; problems: string[] } };
	'tidal:download:open-folder': { args: []; ret: void };
	'shell:show-in-folder': { args: [filePath: string]; ret: void };
	'shell:copy-text': { args: [text: string]; ret: void };
	// Renderer player — fetch the Tidal sniff bearer + clientId, returned as
	// strings without exposing the persistence layer to the renderer. (Spotify
	// tokens are now fetched main-side by the Spotify sidecar host, not over
	// IPC — see SpotifySidecarHost's getToken.)
	'player:tidal:token': { args: []; ret: { token: string; countryCode: string; clientId: string } | null };
	// Native audio engine RPC tunnel. The renderer's local-audio backend
	// in player.ts forwards every transport call (load / play / pause /
	// seek / set_volume / position / stop) through this channel. Main
	// process owns the actual sidecar lifecycle + JSON-RPC correlation.
	// `method` mirrors the sidecar's protocol (see apps/audio/src/protocol.rs).
	// Return shape varies per method — typed at the player.ts call sites.
	'audio:rpc': { args: [method: string, params?: unknown]; ret: unknown };
	// Spotify playback sidecar RPC tunnel. The renderer's Spotify backend in
	// player.ts forwards every transport call (ensure / play / pause / resume /
	// toggle / seek / set_volume / stop) through this channel. Main owns the
	// sidecar lifecycle + JSON-RPC correlation + token provisioning. `method`
	// mirrors apps/spotify-player/src/main.ts. A 'play' that rejects with kind
	// 'track_unavailable' is surfaced as a recognizable message so player.ts can
	// rethrow SpotifyTrackUnavailableError for the Discover auto-skip path.
	'spotify:rpc': { args: [method: string, params?: unknown]; ret: unknown };
	// ─── Tags (Interested / Basket / future user tags) ────────────────────
	'tags:list': { args: []; ret: Tag[] };
	'tags:counts': { args: []; ret: Record<string, number> };
	'tracks:tags': { args: [trackId: string]; ret: string[] };
	'tracks:tags-batch': { args: [trackIds: string[]]; ret: Record<string, string[]> };
	'tracks:add-tag': { args: [trackId: string, tagId: string]; ret: void };
	'tracks:remove-tag': { args: [trackId: string, tagId: string]; ret: void };
	'tracks:add-tag-skipping-local': { args: [trackIds: string[], tagId: string]; ret: { added: number; skipped: number } };
	'tags:create':                   { args: [name: string, color?: string | null]; ret: Tag };
	'organize:recommend':            { args: [trackIds: string[]]; ret: { kind: 'tag' | 'playlist'; id: string; score: number; reason: string }[] };

	// ─── Local library ─────────────────────────────────────────────────────
	'library:list-folders': { args: []; ret: LibraryFolder[] };
	'library:add-folder': { args: [path: string, opts?: { allowCloudSync?: boolean }]; ret: LibraryFolder };
	'library:remove-folder': { args: [folderId: string]; ret: void };
	'library:prune-deleted-files': { args: [opts?: { dryRun?: boolean }]; ret: { scanned: number; missing: number; removed: number } };
	'library:duplicate-audio-groups': { args: []; ret: Array<{ audioHash: string; tracks: Array<{ trackId: string; title: string; filePath: string }> }> };
	'library:resolve-local-file': { args: [filePath: string]; ret: { path: string; size: number | null; format: string | null } | null };
	'library:track-local-file': { args: [trackId: string]; ret: { path: string; size: number | null; format: string | null } | null };
	// Show the OS folder picker. Returns the selected absolute path (forward
	// slashes, normalized) or null if the user cancelled.
	'dialog:pick-folder': { args: []; ret: string | null };

	// ─── Window controls (custom title-bar — window is frame:false) ──────
	'window:minimize': { args: []; ret: void };
	'window:toggle-maximize': { args: []; ret: { maximized: boolean } };
	'window:close': { args: []; ret: void };
	'window:is-maximized': { args: []; ret: boolean };
	'window:focus': { args: []; ret: void };

	// ─── Analyzer ─────────────────────────────────────────────────────────
	'analysis:enqueue': { args: [trackIds: string[], opts?: { priority?: number; force?: boolean; analyzeFlags?: AnalysisFlags }]; ret: void };
	'analysis:cancel': { args: [trackId: string]; ret: void };
	'analysis:job': { args: [trackId: string]; ret: AnalysisJob | null };
	'analysis:get': { args: [trackId: string]; ret: TrackAnalysis | null };
	'analysis:cues': { args: [trackId: string]; ret: Cue[] };
	// User-facing cue mutations from the pad grid. Backend treats the
	// (trackId, slot, kind) tuple as the row identity; the renderer drives
	// `kind: 'hot'` exclusively today.
	'cue:upsert': { args: [input: {
		trackId: string;
		slot: number;
		kind: CueKind;
		positionSec: number;
		lengthSec: number | null;
		color: string | null;
		name: string | null;
	}]; ret: Cue };
	'cue:update': { args: [cueId: string, patch: {
		name?: string | null;
		color?: string | null;
		positionSec?: number;
		lengthSec?: number | null;
	}]; ret: Cue };
	'cue:delete': { args: [cueId: string]; ret: void };
	'analysis:set-auto-enqueue': { args: [settings: AutoAnalyzeSettings]; ret: void };

	// ─── Rekordbox adapter (read-only v1) ─────────────────────────────────
	'rekordbox:detect': { args: []; ret: { dbPath: string | null; running: boolean } };
	'rekordbox:read':   { args: [opts: { mode: 'incremental' | 'full'; flags: RekordboxFlags; key?: string; dbPathOverride?: string; overwriteCurator?: boolean }]; ret: RekordboxImportTotals };
	'rekordbox:cancel': { args: []; ret: void };
	'rekordbox:tree':   { args: []; ret: { folders: PlaylistFolder[]; playlists: Playlist[] } };
	// ─── Sync FROM rekordbox (scoped pull) ────────────────────────────────
	// Re-read a selection (tracks / one playlist / one folder) from rekordbox
	// and merge into Curator (LMW). Progress rides the shared 'rekordbox:event'
	// import stream. 'conflicts' pauses for per-row decisions resolved via
	// 'rekordbox:resolve-pull-conflicts'.
	'rekordbox:sync-from': { args: [opts: { targetKind: 'tracks' | 'playlist' | 'folder'; targetIds: string[]; flags: RekordboxFlags; key?: string; dbPathOverride?: string }]; ret: RekordboxPullOutcome };
	'rekordbox:resolve-pull-conflicts': { args: [opts: { resolutions: Array<{ conflictId: string; choice: SyncConflictChoice }> }]; ret: { applied: number; skipped: number } };
	// ─── Rekordbox WRITE-side (sync TO rekordbox) ─────────────────────────
	// Full pipeline: pull (merge) → conflicts pause | push. The 'conflicts'
	// outcome carries the open conflict list; the renderer collects per-row
	// decisions and resumes via 'sync:resolve-conflicts'.
	'rekordbox:sync':           { args: [opts: { targetKind: 'tracks' | 'playlist' | 'folder' | 'updates'; targetIds: string[]; flags: ExportFlags; key?: string; dbPathOverride?: string }]; ret: RekordboxSyncOutcome };
	'rekordbox:create-preview': { args: [playlistId: string]; ret: { tracks: number; withAnalysis: number; playlist: boolean; unplayable: number } | null };
	'rekordbox:create-preview-tracks': { args: [trackIds: string[]]; ret: { tracks: number; withAnalysis: number; playlist: boolean; unplayable: number } | null };
	// Provider-neutral resume-after-conflicts: applies the user's decisions
	// then runs the push phase with the echoed original target + flags.
	'sync:resolve-conflicts':   { args: [opts: { provider: DjSyncProvider; resolutions: Array<{ conflictId: string; choice: SyncConflictChoice }>; targetKind: 'tracks' | 'playlist' | 'folder' | 'updates'; targetIds: string[]; flags: ExportFlags; key?: string; dbPathOverride?: string }]; ret: RekordboxExportResult };
	// Orphaned rb tracks whose local file is gone (rb-linked, no local
	// source_link, file missing on disk). Powers the sync modal's missing-file
	// cleanup preview. Read-only.
	'rekordbox:missing-files':  { args: []; ret: RekordboxMissingFile[] };
	// Delete a set of missing-file orphans as Curator deletes that propagate to
	// rekordbox on the next sync (tombstone + drop link + soft-delete). Ids are
	// re-validated as orphans server-side. No streaming writes.
	'rekordbox:remove-missing-files': { args: [trackIds: string[]]; ret: { removed: number } };
	'rekordbox:list-backups':   { args: [dbPathOverride?: string]; ret: RekordboxBackupSummary[] };
	'rekordbox:clear-backups':  { args: [dbPathOverride?: string]; ret: RekordboxClearBackupsResult };
	'rekordbox:restore-backup': { args: [backupPath: string, dbPathOverride?: string]; ret: void };
	// Cue palette surfaced from the rb sidecar. Static for the rb version;
	// core caches the result process-life. Renderer fetches once at boot
	// and uses the entries opaquely (id = "cti:N" tokens).
	'rekordbox:cue-palette': { args: []; ret: CuePaletteEntry[] };
	'analysis:status':  { args: []; ret: { running: { trackId: string; name: string }[]; queued: number } };

	// ─── AI audio analysis engine (apps/mir) ──────────────────────────────
	// Similarity in the tracklist goes through tracks:page with
	// filter.similarTo; these are the engine's status/settings surface and a
	// direct similarity call for non-tracklist consumers.
	'mir:status':       { args: []; ret: MirStatus };
	'mir:set-settings': { args: [patch: Partial<MirSettings>]; ret: MirStatus };
	'mir:analyze-now':  { args: [trackIds: string[]]; ret: { queued: number } };
	'mir:provision':    { args: []; ret: MirStatus };
	'mir:similar':      { args: [q: SimilarQuery]; ret: SimilarResult };

	// ─── Backup & restore (planning/tech/backup.md) ───────────────────────
	// Settings + scheduler live in core; the engine runs in a utility process.
	'backup:get-settings':   { args: []; ret: BackupSettings };
	'backup:set-settings':   { args: [patch: Partial<BackupSettings>]; ret: BackupSettings };
	'backup:status':         { args: []; ret: BackupStatus };
	'backup:target-stat':    { args: []; ret: BackupTargetStat | null };
	'backup:list-snapshots': { args: [opts?: { refresh?: boolean }]; ret: BackupSnapshotSummary[] };
	'backup:run':            { args: []; ret: { runId: string } };
	'backup:cancel':         { args: [runId: string]; ret: void };
	'backup:pin':            { args: [snapshotId: string, label: string | null]; ret: void };
	'backup:delete-snapshot': { args: [snapshotId: string]; ret: void };
	'backup:restore-preview': { args: [snapshotId: string]; ret: BackupRestorePreview };
	'backup:restore':        { args: [req: BackupRestoreRequest]; ret: { runId: string; relaunchRequired: boolean } };
	// Google Drive account for the googledrive target (system-browser OAuth;
	// the refresh token lives safeStorage-encrypted in userData, never in the DB).
	'backup:google-connect':    { args: [folderName?: string]; ret: BackupStatus };
	'backup:google-disconnect': { args: []; ret: BackupStatus };
	// Finish a staged Curator-data restore: quit + relaunch (the swap happens
	// at boot before any DB opens).
	'backup:relaunch':       { args: []; ret: void };
	// Renderer settings restored with a snapshot, handed over ONCE at the
	// next boot (the file is deleted on read) so the renderer can seed
	// localStorage before it reads its settings.
	'backup:take-pending-renderer-settings': { args: []; ret: Record<string, string> | null };

	// ─── Curator account + cloud sync (planning/tech/cloud.md) ─────────────
	// The Supabase session lives in main (main/cloud/account.ts); these
	// return its state, never a token. Sign-in errors reject with a message
	// written for the panel.
	'account:status':             { args: []; ret: AccountStatus };
	'account:sign-in-password':   { args: [email: string, password: string]; ret: AccountStatus };
	'account:sign-in-otp-request': { args: [email: string]; ret: { sent: true } };
	'account:sign-in-otp-verify': { args: [email: string, code: string]; ret: AccountStatus };
	'account:sign-out':           { args: []; ret: AccountStatus };
	'account:devices':            { args: []; ret: AccountDevice[] };
	// Op-log sync state from core (named apart from 'sync:*', the Spotify
	// read-sync). 'cloud-sync:now' runs one push-then-pull cycle.
	'cloud-sync:status': { args: []; ret: CloudSyncStatusReport };
	'cloud-sync:now':    { args: []; ret: CloudSyncStatusReport };
	// The fallback poll cadence (per device, never synced). A patch merges
	// over the stored value and is clamped; null restores the defaults.
	'cloud-sync:get-poll-settings': { args: []; ret: SyncPollSettings };
	'cloud-sync:set-poll-policy':   { args: [patch: Partial<SyncPollPolicy> | null]; ret: SyncPollSettings };
	// Shared analysis catalogue (core catalogue/): status, the device-local
	// settings, and the "upload existing analysis" button.
	'catalogue:status':       { args: []; ret: CatalogueStatus };
	'catalogue:set-settings': { args: [patch: CatalogueSettingsPatch]; ret: CatalogueStatus };
	'catalogue:backfill':     { args: [action: CatalogueBackfillAction]; ret: CatalogueStatus };

	// ─── Discover feed ────────────────────────────────────────────────────
	// Feed items live in feed.db behind the core FeedStore — see
	// planning/tech/discover-core.md.
	'feed:get-page': { args: [req?: { cursor?: string | null; limit?: number; genre?: string | null; label?: string | null }]; ret: FeedPage };
	'feed:filter-options': { args: []; ret: { genres: string[]; labels: string[] } };
	'feed:archived-page': { args: [req?: { cursor?: string | null; limit?: number }]; ret: FeedPage };
	'feed:detail':   { args: [itemId: string]; ret: FeedItemDetail | null };
	'feed:enrich':   { args: [itemId: string]; ret: FeedItem | null };
	'feed:action':   { args: [action: FeedAction]; ret: FeedActionResult };
	'feed:unfollow-playlist': { args: [playlistId: string]; ret: FeedActionResult };
	'feed:unfollow-artist':   { args: [artistId: string]; ret: FeedActionResult };
	'feed:refresh':  { args: []; ret: FeedRefreshResult };
	// Temporary: manual Refresh of one producer by id (Refresh Artists / Refresh
	// Playlists buttons). Remove with those buttons.
	'feed:refresh-producer': { args: [producerId: string]; ret: FeedRefreshResult };
	'feed:load-more': { args: [days: number]; ret: FeedRefreshResult };

	// ─── Discovery journeys + knowledge base ──────────────────────────────
	// Journeys are persistent forkable navigation trees; the KB answers
	// entity questions via its resolver ladder and remembers everything in
	// knowledge.db. See planning/tech/discovery-journeys.md.
	'journey:create': { args: [seed: JourneySeed, opts?: { name?: string }]; ret: JourneyDetail };
	'journey:list':   { args: []; ret: JourneySummary[] };
	'journey:get':    { args: [journeyId: string]; ret: JourneyDetail | null };
	'journey:rename': { args: [journeyId: string, name: string]; ret: void };
	'journey:delete': { args: [journeyId: string]; ret: void };
	'journey:navigate': { args: [journeyId: string, entityId: string, opts?: { forceBranch?: boolean }]; ret: { node: JourneyNode; entity: KbEntityDetail } };
	'journey:jump':   { args: [journeyId: string, nodeId: string]; ret: KbEntityDetail };
	'journey:set-view': { args: [journeyId: string, nodeId: string, view: unknown]; ret: void };
	'journey:delete-branch': { args: [journeyId: string, nodeId: string]; ret: { removed: number } };
	'kb:entity':  { args: [entityId: string]; ret: KbEntityDetail | null };
	'kb:expand':  { args: [entityId: string, aspect: KbAspect, opts?: { refresh?: boolean }]; ret: KbExpansion };
	'kb:search':  { args: [query: string, kinds?: KbEntityKind[]]; ret: KbEntity[] };
	'kb:resolve': { args: [seed: JourneySeed]; ret: KbEntityDetail };
	'kb:promote': { args: [entityId: string, opts?: { pin?: boolean }]; ret: { trackId: string } };

	// ─── In-app agent ─────────────────────────────────────────────────────
	// BYOK agent (apps/agent sidecar). Key material NEVER crosses this
	// boundary outward: set-config accepts a key, get-config returns hasKey
	// only (safeStorage custody lives in main/agent-config.ts). agent:send is
	// the long-running pattern — returns {status:'running'} immediately, the
	// turn streams via 'agent:event'.
	'agent:status':         { args: []; ret: AgentStatus };
	'agent:get-config':     { args: []; ret: AgentConfigRedacted | null };
	'agent:set-config':     { args: [input: AgentConfigInput]; ret: AgentStatus };
	'agent:send':           { args: [req: { sessionId?: string; text: string; context?: AgentViewContext }]; ret: { status: 'running'; sessionId: string; turnId: string } };
	'agent:cancel':         { args: [sessionId: string]; ret: void };
	'agent:list-sessions':  { args: []; ret: AgentSessionSummary[] };
	'agent:get-session':    { args: [sessionId: string]; ret: AgentSessionDetail | null };
	'agent:new-session':    { args: []; ret: AgentSessionSummary };
	'agent:delete-session': { args: [sessionId: string]; ret: void };
	'agent:get-result-set': { args: [resultSetId: string]; ret: AgentResultSet | null };

	// ─── MCP bridge ───────────────────────────────────────────────────────
	// The renderer's answer to an 'mcp:confirm' event — approve/deny a
	// Claude-initiated write (streaming playlist mutation etc.). Unmatched or
	// late responses are ignored by main (the request already timed out).
	// alwaysAllow (only honored on approve) waives future modals for this
	// request's kind until the app restarts — see McpConfirmBroker.
	'mcp:confirm-response': { args: [requestId: string, approved: boolean, alwaysAllow?: boolean]; ret: void };
}

// The Curator account as the renderer sees it. `configured` is false when
// this build has no Supabase project (no sign-in at all); `syncAvailable` is
// false when it has no cloud API URL (sign-in still works; sync is off).
export interface AccountStatus {
	signedIn: boolean;
	email: string | null;
	userId: string | null;
	// False when OS credential encryption is unavailable: the session is not
	// remembered across launches.
	persistent: boolean;
	configured: boolean;
	syncAvailable: boolean;
}

// A registered device of the account, flagged when it is this install.
export interface AccountDevice extends DeviceInfo {
	current: boolean;
}

// BYOK agent config as the renderer sees it — provider + models in the
// clear, the API key reduced to presence. The full key exists only inside
// main (safeStorage-encrypted on disk, decrypted into the sidecar RPC).
export interface AgentConfigRedacted {
	provider: AgentProvider;
	baseUrl?: string;
	routerModel: string;
	researchModel: string;
	hasKey: boolean;
}

// What the settings UI submits. `apiKey` omitted = keep the stored key
// (lets the user change models without re-entering the secret).
export interface AgentConfigInput {
	provider: AgentProvider;
	baseUrl?: string;
	apiKey?: string;
	routerModel: string;
	researchModel: string;
}

// Event channels that main → renderer pushes via webContents.send
export type EventChannels = {
	'sync:progress': SyncProgress;
	'download:progress': DownloadProgress;
	'download:queue-event': QueueEvent;
	'library:scan-progress': ScanProgress;
	'analysis:event': AnalysisJobEvent;
	'rekordbox:event': RekordboxImportEvent;
	// Export-side push channel. Separate from the import stream because
	// the modal flow that consumes it is independent — a sync-to-rb run
	// shouldn't accidentally repaint the import progress strip.
	'rekordbox:export-event': RekordboxExportEvent;
	// Convert to WAV run lifecycle (started / progress / trackFailed /
	// completed / failed) — drives the inline playlist indicator + toasts.
	'wav:convert-event': WavConvertEvent;
	// AI engine: coalesced status snapshots + per-track analyzed/failed.
	'mir:event': MirEvent;
	// Backup & restore: run lifecycle + coalesced status snapshots for the
	// Backup settings tab and the progress dialog.
	'backup:event': BackupEvent;
	// Native audio engine push events. Payload shape mirrors the sidecar's
	// Event enum (state_changed | ended). Renderer's player.ts subscribes
	// to drive reactive position updates + queue advance on natural end.
	'audio:event': AudioEvent;
	// Spotify playback sidecar push events. Payload mirrors the SpotifyEvent
	// union emitted by apps/spotify-player. Renderer's player.ts subscribes to
	// drive reactive position/track updates + queue advance on natural end.
	'spotify:event': SpotifyEvent;
	// One feed item finished enrichment (background drain or on-view). Carries
	// the updated FeedItem so the Discover view can fold fresh genre/label/bpm
	// chips onto the card live, without a manual refresh.
	'feed:enriched': FeedItem;
	// KB expansion progress: a background provider page landed, or agent
	// research completed/errored. The entity page appends the new rows live.
	'kb:event': KbEvent;
	// In-app agent turn stream: text deltas, tool activity, result sets,
	// view commands, turn lifecycle. The agent panel is a pure consumer of
	// this channel; result sets also land in agent.db for refetch-on-reload.
	'agent:event': AgentEvent;
	// MCP bridge: Claude (over MCP) wants a gated write — the renderer shows
	// the confirm modal and answers via 'mcp:confirm-response'. No answer
	// within timeoutMs ⇒ main denies.
	'mcp:confirm': McpConfirmEvent;
	// MCP bridge: a non-gated write happened (tags, ratings, local playlist) —
	// surfaced as a toast so Claude never mutates silently.
	'mcp:notify': { message: string };
	// Cloud sync status snapshots (push/pull state, first-sign-in push
	// progress, errors; progress coalesced ≤ 4/s) and sign-in changes.
	'cloud-sync:status': CloudSyncStatusReport;
	// Shared analysis status (coalesced ≤ 4/s), and on sign-in changes.
	'catalogue:status': CatalogueStatus;
	// A pull or bootstrap changed local rows: the track list patches these
	// rows; container entities (tag / playlist / folder) refresh the sidebar.
	'sync:applied': CloudSyncApplied;
};

export interface McpConfirmEvent {
	requestId: string;
	kind: 'streaming-playlist-write' | 'destructive-write';
	title: string;
	detailLines: string[];
	timeoutMs: number;
}

// Maps each Api.onX subscription method to its wire channel. Single source
// of truth for the event side, mirroring what TOOL_CATALOG is for invoke
// channels: preload derives its ipcRenderer.on bindings from this object,
// and the Api type below derives each callback's payload type from
// EventChannels. Adding an event = one EventChannels entry + one line here;
// the compiler rejects a method that names a channel with no payload type,
// and main-side emitters go through broadcastEvent (main/events.ts) which
// is typed against the same EventChannels map.
export const EVENT_CATALOG = {
	onSyncProgress: 'sync:progress',
	onDownloadProgress: 'download:progress',
	onDownloadQueueEvent: 'download:queue-event',
	onLibraryScanProgress: 'library:scan-progress',
	onAnalysisEvent: 'analysis:event',
	onRekordboxEvent: 'rekordbox:event',
	onRekordboxExportEvent: 'rekordbox:export-event',
	onWavConvertEvent: 'wav:convert-event',
	onAudioEvent: 'audio:event',
	onSpotifyEvent: 'spotify:event',
	onFeedEnriched: 'feed:enriched',
	onMirEvent: 'mir:event',
	onBackupEvent: 'backup:event',
	onKbEvent: 'kb:event',
	onAgentEvent: 'agent:event',
	onMcpConfirm: 'mcp:confirm',
	onMcpNotify: 'mcp:notify',
	onCloudSyncStatus: 'cloud-sync:status',
	onCatalogueStatus: 'catalogue:status',
	onSyncApplied: 'sync:applied',
} as const satisfies Record<string, keyof EventChannels>;

export type Api = {
	[K in keyof IpcChannels]: (...args: IpcChannels[K]['args']) => Promise<IpcChannels[K]['ret']>;
} & {
	// One-way main → renderer event subscriptions. Returns an unsubscribe fn.
	[M in keyof typeof EVENT_CATALOG]: (
		cb: (payload: EventChannels[(typeof EVENT_CATALOG)[M]]) => void,
	) => () => void;
} & {
	// Chromium-native UI zoom — affects every element (text, images, layout,
	// scrollbars) uniformly, the same way Ctrl++ in a browser does. Kept on
	// the preload surface rather than IPC so a fast key-repeat doesn't pay
	// a roundtrip cost.
	zoom: {
		in: () => void;
		out: () => void;
		reset: () => void;
		get: () => number;
		set: (n: number) => void;
	};
} & {
	// Generic tRPC transport bridge — the renderer's typed client
	// (renderer/data/trpc.ts) addresses the main-side router by dotted path.
	// Untyped here on purpose: AppRouter inference happens client-side, this
	// is just the wire.
	trpc: (path: string, input: unknown) => Promise<unknown>;
} & {
	// Fire-and-forget log shipping (see LOG_BATCH_CHANNEL above). Batched by
	// the renderer's IPC sink (renderer/data/log.ts), not called per record.
	log: { send: (records: LogRecord[]) => void };
};

// Push events from the audio sidecar. `state_changed` fires at ~20Hz
// while playing (position monotonic up to total duration); `ended` fires
// exactly once per natural end-of-buffer. Controller variants land per
// planning/tech/controllers-pioneer.md — audio-affecting actions (cue,
// beat-jump, loop, scrub) fire inside the sidecar and are NOT reported
// here; only renderer-bound events come up the wire. Shape mirrors the
// Rust protocol.rs Event enum.
export type AudioEvent =
	// peak_l / peak_r: max-abs of the post-volume, post-envelope output
	// sample over the interval since the previous tick. Sidecar atomically
	// swaps the per-channel peak atomics to 0 on each emission, so the
	// values represent fresh "what hit the speaker in the last ~50ms"
	// rather than a running average. Synchronous events (play/pause/seek
	// edges) report 0.0; the next reporter tick refreshes from the live
	// atomic. Renderer's VU meter consumes these.
	| { event: 'state_changed'; position: number; playing: boolean; peak_l: number; peak_r: number }
	| { event: 'ended' }
	// A previously-armed quantized cue trigger has fired sample-accurately
	// inside the audio callback — the cursor has already jumped to
	// `position` with a 10ms linear crossfade across the seam. Renderer
	// uses this to clear pending-trigger UI flash at the audible moment
	// (~50ms reporter latency, vs. waiting for the next state_changed).
	| { event: 'trigger_fired'; position: number }
	// Sidecar finished its init and is ready for RPCs. Emitted at boot
	// AND on each crash respawn. Renderer subscribes and re-pushes
	// current load/cue/play/loop state so audio + controller LED state
	// survive a sidecar restart.
	| { event: 'sidecar_ready' }
	// A supported controller appeared on USB. `firmware` is present
	// when the device replied to a universal-identity request.
	| { event: 'controller_connected'; model: string; firmware: string | null }
	// Controller dropped off USB enumeration. Sidecar has already
	// released the MIDI/HID handles.
	| { event: 'controller_disconnected'; model: string }
	// Controller event the renderer needs to handle. Action is a
	// discriminated union over `kind`; payload fields are flat per
	// variant. Mirrors the Rust `ControllerAction` in
	// apps/audio/src/protocol.rs and the TS `ControllerAction` in
	// packages/shared/src/controller-mapping.ts.
	//
	// v1 routes all controller actions through this channel — both
	// renderer-bound (browse / back / view) and audio-affecting (cue,
	// beat-jump, loop, play_pause). The renderer's onAudioEvent
	// subscriber dispatches each kind to the appropriate
	// DeckController / player method.
	| { event: 'controller_event'; action: ControllerEventAction };

// Action payload of a controller_event. Mirrors the Rust enum.
export type ControllerEventAction =
	// Renderer-bound
	| { kind: 'browse'; delta: number }
	| { kind: 'browse_press' }
	| { kind: 'back' }
	| { kind: 'view' }
	| { kind: 'shift'; held: boolean }
	| { kind: 'unmapped'; raw: number[] }
	// Audio-affecting — dispatched via DeckController + player in v1
	| { kind: 'cue_trigger'; slot: number }
	| { kind: 'beat_jump'; delta: number }
	| { kind: 'loop_in' }
	| { kind: 'loop_out' }
	| { kind: 'loop_n_beats'; n: number }
	| { kind: 'loop_halve' }
	| { kind: 'loop_double' }
	| { kind: 'play_pause' };

// Push events from the Spotify playback sidecar (apps/spotify-player). The SDK
// exposes no position event, so the sidecar polls getCurrentState at ~20Hz
// while playing and pushes `state_changed`; `ended` fires once on natural
// end-of-track. `need_token` is handled host-side (SpotifySidecarHost) and is
// NOT forwarded here. Shape mirrors what sdk.ts emits.
export type SpotifyEvent =
	// position/duration in seconds. `track` is null only in the rare window
	// before the first track loads; otherwise it carries the now-playing meta.
	| { event: 'state_changed'; position: number; duration: number; playing: boolean; track: { id: string; title: string; artist: string; coverUrl: string | null } | null }
	| { event: 'ended' }
	// Device registered with Spotify Connect — playback can target it.
	| { event: 'ready'; deviceId: string }
	// Auth/account failure (bad/expired token, non-Premium account).
	| { event: 'auth_error'; message: string };

// ─── TOOL CATALOG ────────────────────────────────────────────────────────────
// Single source of truth for the IPC surface. Iterated by:
//   - preload (builds the renderer-facing `window.api` map)
//   - main    (binds each handler from buildHandlers() and calls ipcMain.handle)
//   - future AI orchestrator (emits an LLM tool list — initiative 4)
//
// Modelled as a Record keyed by channel so TypeScript enforces that every
// IpcChannels entry has a catalog entry (and vice-versa).
//
// Descriptions are written for the LLM tool surface: imperative, short,
// describe what the tool does — not how the renderer happens to use it.
export interface ToolCatalogEntry {
	description: string;
}

export const TOOL_CATALOG: Record<keyof IpcChannels, ToolCatalogEntry> = {
	'tracks:list': { description: 'List tracks. Optional filter (state, source, playlistId, bpm range, key, genre, label, search), sort column/direction, limit, offset.' },
	'tracks:page': { description: 'Windowed track list — one server-paged page (filter, sort, {limit, offset}) plus the matching total. The path every list surface uses.' },
	'tracks:ids': { description: 'Ordered track ids for the whole result set (play-all / queue / select-all). Capped.' },
	'playlists:list': { description: 'List all non-hidden playlists across connected sources.' },
	'tracks:playlists': { description: 'List every playlist a track belongs to, each with its full folder ancestry (root-first). Powers the "Playlists" submenu on the track context menu.' },
	'playlists:set-favorite': { description: 'Pin or unpin a playlist as a favorite. Favorite playlists are shown above the rest in the sidebar.' },
	'playlists:rename': { description: 'Rename a playlist. Updates Curator\'s local row immediately; for Spotify playlists also PUTs to /playlists/{id} so the rename reflects on Spotify. For Rekordbox playlists the rename is local-only — user runs Sync to Rekordbox to push the new name. Returns pushedToSource=true iff the upstream push completed.' },
	'playlists:rename-folder': { description: 'Rename a Rekordbox playlist folder. Local-only write; the new name is pushed to Rekordbox on the next Sync to Rekordbox for that folder.' },
	'playlists:reorder': { description: 'Reorder tracks within a playlist. `newOrder` is an array of the rows\' CURRENT positions (playlist_track.position values) listed in the desired order. Position is the unique identity within a playlist, so this disambiguates the same trackId appearing twice. Atomic — written in a single transaction. When the playlist is from a streaming source AND the user has writeSyncAuto enabled for it, mirrors the new order upstream via the source adapter.' },
	'tracks:playlists-batch': { description: 'Batched membership lookup — returns playlistId[] per trackId. Excludes hidden and smart playlists so the picker only ever paints chips for write-eligible targets.' },
	'playlists:list-with-folders': { description: 'Every non-hidden, non-smart playlist with its folder ancestry (root-first). Powers the playlist picker dialog\'s full filterable list.' },
	'playlists:add-tracks': { description: 'Bulk-add tracks to a playlist. Idempotent — tracks already present are skipped (returned in `skipped`). New rows land at the tail (position = max+1, incrementing). Smart playlists reject the write. For spotify/tidal playlists the add is also pushed to the provider when writeSyncAuto is on and the user owns the playlist; `upstream` reports whether that happened (pushed / write-sync-off / not-owner / failed / none) and `noUpstreamTrackIds` lists tracks that could not be added at all because they have no provider id.' },
	'playlists:remove-tracks': { description: 'Bulk-remove tracks from a playlist. Removes every (playlistId, trackId) row, handling the duplicate-position case. Smart playlists reject the write. `upstream` reports whether the removal reached the provider (see playlists:add-tracks).' },
	'playlists:upstream-drift': { description: 'Local-vs-remote membership diff for a spotify/tidal playlist: one provider read, then every local row whose provider id (or any linked provider id for the same track) is absent remotely is returned in `localOnly` — the adds that never reached the provider. Read-only.' },
	'playlists:push-local-only': { description: 'Replay a playlist\'s local-only rows (see playlists:upstream-drift) to the provider, in local position order. Optional `sourceTrackIds` narrows the set. Explicit repair action: ignores writeSyncAuto but still requires playlist ownership. MODIFIES THE USER\'S LIVE ACCOUNT — confirm first.' },
	'playlists:find-tracks-with-deleted-files': { description: 'For each playlist id, return tracks whose local file pointer is dead — every local source_link on the track points at a path missing from disk. Streaming-only tracks (no local source_link) are not included. Stat is performed live, so the answer reflects current on-disk state.' },
	'pinned:list': { description: 'List saved pinned searches (the "Pinned" nav folder), ordered by position. Each is a named, re-runnable query.' },
	'pinned:create': { description: 'Save a pinned search from a query string + display name, plus an optional captured sort (column/dir). Lands at the tail of the Pinned folder. Returns the created row.' },
	'pinned:rename': { description: 'Rename a pinned search. Returns the updated row.' },
	'pinned:delete': { description: 'Delete a pinned search (the "Unpin" action). Idempotent.' },
	'playlists:create-local': { description: 'Materialize a set of tracks (in the given order) into a new editable local playlist (source=local). Used by the pinned-search "Create Playlist" flow — a one-shot copy, not a live link. Returns the created playlist.' },
	'playlists:create-streaming': { description: 'Create a new (private) playlist on the streaming provider, add the tracks that have a provider link, and mirror it locally in the sync\'s row shape. `skipped` counts tracks with no provider id (an all-unlinked request still creates the empty playlist). Throws if the add step fails — the remote playlist and its pending local mirror exist by then. Used by the Organize modal\'s "Create Spotify playlist" row. Spotify only (Tidal has no write adapter).' },
	'sources:get-sync-settings': { description: 'Current per-source sync settings (readSyncAuto, readIntervalMin, writeSyncAuto) from core\'s app_setting store — the single source of truth shared by every renderer origin.' },
	'sources:set-sync-settings': { description: 'Persist per-source sync settings in core (app_setting) and apply them: (a) restart the auto-poll timer for that source at the new interval, (b) gate write-side operations (add/remove/reorder push) on writeSyncAuto.' },
	'credits:get-format': { description: 'The credit display format (artist separator, remix title style) from core\'s app_setting — the value the rekordbox push and pull-side merge format Title/Artist with. `stored` is false until a renderer has pushed one; the renderer then seeds core from its own setting.' },
	'credits:set-format': { description: 'Persist the credit display format in core (app_setting). Applies to the next Sync to Rekordbox: every linked track whose formatted Title/Artist differs from rekordbox\'s gets pushed once.' },
	'wav:get-settings': { description: 'Convert-to-WAV settings: the output folder (normalized path; defaults to <OS Music folder>/WAV) and whether it was explicitly stored.' },
	'wav:set-settings': { description: 'Set the Convert-to-WAV output folder (absolute path; cloud-sync folders are refused). Persisted in core\'s app_setting.' },
	'wav:preview': { description: 'Dry run of Convert to WAV for a playlist: how many FLAC members would be converted, reused (existing WAV copy), kept as-is (already deck-playable), or skipped (no local file); how many need resampling (>48 kHz); estimated output size, free space, output folder, and the "[WAV]" playlist name.' },
	'wav:convert': { description: 'Start Convert to WAV for a playlist in the background: decode each FLAC member to a plain-PCM WAV (bit-exact up to 48 kHz/24-bit) in the output folder, mint a "[WAV]" library track per file carrying the original\'s metadata, cues, tags and analysis, and build "<name> [WAV]" in source order. Progress arrives on wav:convert-event. Writes local files and the library DB; nothing is pushed to rekordbox.' },
	'wav:cancel': { description: 'Cancel a running Convert to WAV run (in-flight conversions are killed; finished copies are kept and the "[WAV]" playlist is built from them).' },
	'tracks:state-counts': { description: 'Return counts of tracks per workflow state (feed, backlog, progress, purchased, unsorted).' },
	'tracks:source-counts': { description: 'Return counts of tracks per source (spotify, tidal, local).' },
	'sync:status': { description: 'Return connection + last-sync timestamp for Spotify and Tidal.' },
	'auth:status': { description: 'Return connection status for each auth provider, including whether this build carries app credentials for it (configured).' },
	'auth:spotify:start': { description: 'Run the Spotify OAuth flow in a popup window. Returns updated auth status.' },
	'auth:spotify:disconnect': { description: 'Disconnect Spotify (clears stored tokens).' },
	'auth:tidal:start': { description: 'Run the Tidal OAuth flow in a popup window. Returns updated auth status.' },
	'auth:tidal:disconnect': { description: 'Disconnect Tidal (clears stored tokens + sniffed session).' },
	'sync:spotify:run': { description: 'Sync all Spotify playlists into the library. `deleteRemoved` removes locally-cached playlists no longer present remotely. `force` bypasses the snapshot_id short-circuit so every playlist\'s /tracks endpoint is re-fetched — used by the "Resync entirely" UI path to recover from local drift.' },
	'sync:spotify:plan': { description: 'Dry-run a Spotify sync — return counts of adds/updates and the list of playlists that would be removed.' },
	'sync:spotify:playlist': { description: 'Sync a single Spotify playlist by playlistId.' },
	'sync:tidal:run': { description: 'Sync all Tidal playlists + their tracks into the library (read-only pull; Tidal writes are capability-gated off). `force` bypasses the lastModifiedAt short-circuit so every playlist\'s items are re-fetched.' },
	'sync:tidal:playlist': { description: 'Sync a single Tidal playlist by playlistId — the lazy sync-on-click path for rows still pending/error.' },
	'enrich:beatport:playlist': { description: 'Enrich every track in a playlist with Beatport metadata (BPM, key, genre, label). Optional sort to prioritize the order tracks are enriched.' },
	'enrich:beatport:track': { description: 'Enrich a single track with Beatport metadata.' },
	'enrich:beatport:tracks': { description: 'Enrich multiple tracks (by ids) with Beatport metadata.' },
	'tidal:match-tracks': { description: 'Run the Tidal matcher against a set of tracks — attaches tidal source_links where a confident match is found.' },
	'tracks:source-links': { description: 'List the source_link rows attached to a track (one per provider).' },
	'tracks:set-overrides': { description: 'Set user overrides on a track. Pass null for a field to revert that override; omit a field to leave it unchanged.' },
	'tracks:set-source-links': { description: 'Set/clear per-source URLs on a track. Refetches metadata for any URL that changed. A provider id already bound to another live track comes back as errors[] with code=already-linked + conflictTrackId (nothing written for that provider).' },
	'tracks:merge-preview': { description: 'Read-only dry run of merging two library tracks: per-side summary (tags/playlists/cues/links/weight), the suggested survivor, and a plan per direction with blockers + warnings.' },
	'tracks:merge': { description: 'Merge dropId into keepId in one transaction: union of tags, playlist memberships, source links, cues, analysis, play history and scalar attributes; drop is soft-deleted. Never pushes to a streaming provider or tombstones rekordbox content. Returns the decorated survivor.' },
	'tracks:delete-source-link': { description: 'Delete the source_link row for a given (track, source). Idempotent — no-ops if absent.' },
	'tracks:clear-fields': { description: 'Hard-clear one or more track fields: drops both override key and canonical column value (for nullable columns). title/artists are NOT NULL — only the override is dropped.' },
	'tracks:field-options': { description: 'Return the distinct genre and label values present across the library (deleted tracks excluded), each sorted — populates the Edit Track modal\'s genre/label autocomplete.' },
	'artists:list': { description: 'List library artists (aliases excluded) with live-track counts. `search` fold-matches the name; `scope` counts only a tab\'s tracks (a provider source_link, or the rekordbox collection); default order is count desc then name; default limit 500. Drives the Artists browser and the Edit Track artist autocomplete.' },
	'artists:get': { description: 'One artist by Curator artist id (null when unknown).' },
	'artists:resolve': { description: 'Look an artist up by name — diacritic/case-insensitive, follows merge aliases. The Discover "Show in library" path.' },
	'artists:links': { description: 'Provider identities for an artist (Spotify / Tidal artist ids gathered from synced track payloads, with direct URLs). Drives the artist scope header links and the Artists folder menu.' },
	'artists:merge-suggestions': { description: 'Artist pairs identity cannot decide — a bare name beside the same name with a bracketed country/city tag ("Maz" / "Maz (EG)"). Live artists only; dismissed pairs excluded; suggested survivor = the more-credited spelling. `scope` counts a tab\'s tracks and keeps pairs with at least one track in scope.' },
	'artists:dismiss-merge': { description: 'Remember an artist pair as "not the same artist" so the Suggested merges review never shows it again.' },
	'albums:by-ids': { description: 'Album summaries for the given Curator album ids (merge aliases answer with the survivor data under the asked id; unknown ids skipped): title, album artists or Various, release date, label, top genres, type, provider track total, live library track count and a cover track id. Drives the track list album group headers.' },
	'artists:rename': { description: 'Rename an artist across the library: every track credit that resolves to it is rewritten (JSON + junction), the spelling becomes curated (sticky against re-sync), a fold-changing rename leaves an alias under the old fold. Renaming onto an existing artist\'s name merges into it.' },
	'artists:merge': { description: 'Merge artist `dropId` into `keepId`: drop becomes an alias, its credits are rewritten to keep\'s spelling. Returns the survivor and how many tracks were rewritten.' },
	'tracks:set-rating': { description: 'Bulk-set the 0..5 star rating on N tracks. Pass null to clear. Rating is a canonical column shared with Rekordbox sync — there is no override layer for it.' },
	'plays:record': { description: 'Upsert one play-history event from the renderer PlayTracker. The same id is written repeatedly: first flush inserts, 30s checkpoints update playedMs/maxPositionMs, the finalize flush sets endedReason + played75. Session assignment (gap-based curator sessions) happens core-side.' },
	'tracks:delete': { description: 'Soft-delete N tracks from the library (every source): trash any local files, remove from every playlist the user can modify (owned Spotify/Tidal playlists are PUSHED TO THE LIVE ACCOUNT regardless of writeSyncAuto; rekordbox is curator-side until Sync to Rekordbox), tombstone rekordbox content, unlink peaks (.cpk), drop the local + rekordbox links and stamp deletedAt. Streaming links and followed-playlist memberships survive so the track shows as deleted there. Returns granular counts + best-effort errors per file/peaks/playlist.' },
	'tracks:remove-sources': { description: 'Remove chosen sources (local | spotify | tidal | rekordbox) from N tracks. local: trash the file(s) + drop the local link. spotify/tidal: remove from every playlist the user OWNS on that source (PUSHES TO THE LIVE ACCOUNT — confirm with the user first) + drop the link. rekordbox: tombstone the rb content (removed from rekordbox on the next Sync to Rekordbox) + drop rb playlist memberships and the link. A track whose every source was removed is soft-deleted (deletedAt). Returns per-source counts, decorated surviving tracks, and best-effort errors.' },
	'tracks:undelete': { description: 'Restore soft-deleted tracks to the library (clears deletedAt; syncs to the user\'s other devices). Tags, cues, rating, history and streaming links were kept by the delete and come back; a local file the scanner found for a deleted track is already attached. Playlist memberships, trashed files and the rekordbox link are not restored. Returns the ids restored.' },
	'shell:open-external': { description: 'Open an http/https URL in the user\'s default browser.' },
	'tidal:match-track': { description: 'Run the Tidal matcher against a single track — returns the matched tidal id, or null.' },
	'tidal:set-playlist-hybrid': { description: 'Toggle hybrid-tidal mode on a Spotify playlist. When enabled, every track is matched against Tidal on sync.' },
	'enrich:cancel': { description: 'Cancel any in-flight enrichment / hybrid-match loop.' },
	'tidal:download:enable': { description: 'Open the Tidal listen.tidal.com window to capture a streaming session bearer (one-time per session).' },
	'tidal:download:status': { description: 'Return whether a usable Tidal download session is currently present.' },
	'tidal:download:track': { description: 'Download a single Tidal track to disk. Emits progress events.' },
	'tidal:download:enqueue': { description: 'Enqueue tracks for background download.' },
	'tidal:download:retry': { description: 'Retry a failed download job.' },
	'tidal:download:queue': { description: 'Return the current download queue (all jobs across states).' },
	'tidal:download:summary': { description: 'Return aggregate counts of the download queue (pending / downloading / done / error).' },
	'tidal:download:clear-completed': { description: 'Remove completed jobs from the download queue.' },
	'tidal:download:clear-all': { description: 'Clear the entire download queue.' },
	'tidal:download:redownload': { description: 'Re-download a track that has already completed (overwrites the existing file).' },
	'tidal:download:verify': { description: 'Verify the on-disk download library against the queue — reports missing / corrupt / size-mismatched files.' },
	'tidal:download:open-folder': { description: 'Open the configured download directory in the OS file manager.' },
	'shell:show-in-folder': { description: 'Open the OS file manager with the given file highlighted.' },
	'shell:copy-text': { description: 'Write a string to the OS clipboard.' },
	'player:tidal:token': { description: 'Return the sniffed Tidal bearer + countryCode + clientId for the renderer player.' },
	'audio:rpc': { description: 'Forward a JSON-RPC call to the native audio engine sidecar. Methods: load, play, pause, seek, seek_with_xfade, arm_trigger, set_beatgrid, jump_beats, set_volume, set_loop, position, stop, scrub_begin, scrub_to, scrub_end.' },
	'spotify:rpc': { description: 'Forward a JSON-RPC call to the Spotify playback sidecar. Methods: ensure, play, pause, resume, toggle, seek, set_volume, stop.' },
	'tags:list': { description: 'List all tags (system + user). System tags include the seeded "interested" and "basket" workflow tags.' },
	'tags:counts': { description: 'Return a per-tag count of how many tracks carry each tag.' },
	'tracks:tags': { description: 'List the tag ids currently applied to a track.' },
	'tracks:tags-batch': { description: 'Batched variant of tracks:tags — returns tag ids for many tracks in one IN-query. Used by the track-list column and the omnibar.' },
	'tracks:add-tag': { description: 'Attach a tag to a track. Idempotent — re-applying an existing tag is a no-op.' },
	'tracks:remove-tag': { description: 'Detach a tag from a track.' },
	'tracks:add-tag-skipping-local': { description: 'Bulk-tag tracks with a tag, skipping any that already have a local file. Returns added + skipped counts so the UI can report what happened. Primary use is the "Add to Basket" multi-select action.' },
	'tags:create': { description: 'Create a new user-kind tag, deduping by folded name — if a user tag with the same name already exists (any casing/diacritics, including zero-member and rb-imported ones), that existing row is returned instead of inserting a duplicate. NOTE: locally-created tags are NOT pushed to Rekordbox — the exporter only syncs tags with rb-side identity (`rb_` id prefix); rb materialization for local tags is a planned follow-up. Used by the Organize modal\'s inline "Create tag" flow.' },
	'organize:recommend': { description: 'Recommend tags AND playlists for a track selection (the Organize modal\'s Recommended row). Market-basket affinity: candidates scored by how many of their member tracks share the selection\'s current tags/playlists, artist, genre, or label (plus a modest brightness/power model nudge). Excludes targets already on the selection; source-balanced so both tags and playlists surface. Re-run on every association change for live re-ranking.' },
	'library:list-folders': { description: 'List all on-disk folders being watched as part of the local library.' },
	'library:add-folder': { description: 'Add a folder to the local library. The scanner ingests audio files in the background and matches them against the canonical track table.' },
	'library:remove-folder': { description: 'Stop watching a library folder. Detaches all local source_links under it; canonical tracks remain.' },
	'library:prune-deleted-files': { description: 'Scan every source_link with source=\'local\' and drop the row when the on-disk file no longer exists. Pass dryRun=true to preview the count without deleting. Canonical tracks are preserved; only the local link is dropped.' },
	'library:duplicate-audio-groups': { description: 'Groups of present local files that carry byte-identical audio (same source_link.audio_hash — tag-independent), largest group first. Each entry lists the tracks and file paths sharing that audio. The scanner mints a separate track for a second copy rather than binding two files to one track, so this is how such copies are found; WAV copies made by Convert to WAV are excluded by design.' },
	'library:resolve-local-file': { description: 'Look up an ingested local file by its on-disk path. Used by curator-local:// before streaming.' },
	'library:track-local-file': { description: 'Return the on-disk path + size + format for the local file backing a track, or null if none.' },
	'dialog:pick-folder': { description: 'Open the OS folder picker and return the selected absolute path (forward-slashes, normalized), or null if cancelled.' },
	'window:minimize': { description: 'Minimize the main window. Custom title-bar surface.' },
	'window:toggle-maximize': { description: 'Toggle maximize/unmaximize on the main window. Returns the new state.' },
	'window:close': { description: 'Close the main window.' },
	'window:is-maximized': { description: 'Return whether the main window is currently maximized.' },
	'window:focus': { description: 'Claim OS keyboard focus for the main window + its webContents. Modals call this when document.hasFocus() is false at open (focus parked in detached DevTools / another app), so their autofocused input actually receives keystrokes without the user alt-tabbing away and back.' },
	'analysis:enqueue': { description: 'Queue one or more local tracks for offline analysis. Default pipeline is fast (bpm/key/beatgrid/peaks/fingerprint); advanced features (brightness, power, loudness range, dissonance, density, dynamic complexity) are computed only when opts.analyzeFlags.advanced is set — driven by the Analyze window. Skips tracks that already have an analysis row unless `force` is set. Higher `priority` jumps the queue. Rejects when the analyzer sidecar is not available in this build.' },
	'analysis:cancel': { description: 'Cancel an in-flight or queued analysis job. Mid-run analyses can only be skipped between stages; queued ones are removed immediately.' },
	'analysis:job': { description: 'Return the current queue state (queued/running/done/error/skipped) of a track\'s analysis, or null if it has never been enqueued.' },
	'analysis:get': { description: 'Return the persisted analysis result for a track — BPM, beatgrid, key, density, brightness and friends — or null if not yet analyzed.' },
	'analysis:cues': { description: 'List the hot + memory cues stored against a track, ordered by slot. Loops are represented as cues with non-zero length_sec.' },
	'cue:upsert': { description: 'Create or replace the cue at (trackId, slot, kind). Slot is namespaced per kind (`hot` covers the 16 pad slots; `memory` is reserved for time-ordered ordinals >= 100). `lengthSec` > 0 stores a loop region; null/0 stores a point cue.' },
	'cue:update': { description: 'Patch a cue\'s name / color / position / length in place. Identified by id. Pass null to clear name or color.' },
	'cue:delete': { description: 'Delete a cue by id.' },
	'analysis:set-auto-enqueue': { description: 'Configure the scanner-driven auto-enqueue path. Accepts the full AutoAnalyzeSettings object: master `enabled` flag plus the unified `flags` (AnalysisFlags) selection shared with the Analyze modal. When `enabled` is false, NO automatic analyzer work happens (backfill skipped, dispatch gated to priority>=100). When enabled, newly-ingested tracks are enqueued with the AnalyzeOptions core derives from `flags`. Renderer pushes from localStorage on boot and on every change. Manual paths (Analyze modal, rb grid sync) are unaffected.' },
	'rekordbox:detect': { description: 'Probe the user\'s system for a Rekordbox master.db; returns the auto-detected path (or null) and whether Rekordbox is currently running. Used by the settings UI to populate the path field + show a "close Rekordbox before reading" warning.' },
	'rekordbox:read': { description: 'Run a read of the user\'s Rekordbox library. The `flags` object selects which data classes to sync (tracks/playlists/mytags/cues+grids+phrases/waveform peaks). `mode=incremental` honours the USN watermark (skip unchanged rows); `mode=full` re-reads every row. `overwriteCurator=true` is the "Sync Everything" semantic: bypasses LMW on every per-track conflict (rb values win unconditionally, EXCEPT null/empty values at source never overwrite Curator\'s non-null values), and bypasses the .cpk-freshness gate so peaks get re-decoded.' },
	'rekordbox:cancel': { description: 'Cancel an in-flight Rekordbox read. Best-effort; the sidecar checks the cancel flag between rows.' },
	'rekordbox:tree': { description: 'Return imported Rekordbox playlist + folder rows for sidebar navigation. Folders are returned flat; the renderer reassembles the hierarchy via parentFolderId.' },
	'rekordbox:sync': { description: 'Run the zero-override sync pipeline against Rekordbox\'s master.db: incremental PULL (metadata + cues, three-way merged per field against the per-link baseline snapshots) → pause with status=\'conflicts\' if any both-sides-changed divergences are open → otherwise PUSH. targetKind=\'tracks\' syncs N tracks; \'playlist\' syncs the playlist row plus its members; \'folder\' recursively syncs every non-smart non-hidden descendant playlist at the chosen scopes; \'updates\' resolves to every rb-linked track whose Curator row has changed since the last sync plus every non-smart non-hidden rb playlist (the writer no-ops unchanged playlist rows). The push performs a timestamped backup, applies the writes, commits, then verifies via PRAGMA integrity_check + per-row diff. Update-only — tracks not yet linked to Rekordbox are skipped — EXCEPT for a Convert-to-WAV "[WAV]" playlist: its unlinked members are created in rekordbox first (WAV copies get the original FLAC\'s beatgrid/waveform/phrase analysis copied over) and the playlist itself is created if it doesn\'t exist there yet.' },
	'rekordbox:create-preview-tracks': { description: 'For an "Add to Rekordbox" track selection: how many of the tracks would be created in rekordbox (local file, not yet in rekordbox), how many get a WAV original\'s analysis copied, and how many can\'t be created (no local file). Null when nothing would be created.' },
	'rekordbox:create-preview': { description: 'For a Convert-to-WAV playlist: what a Sync to Rekordbox would create in rekordbox (track count, how many get the original\'s analysis copied, whether the playlist is created, members without a local file). Null when nothing would be created.' },
	'rekordbox:sync-from': { description: 'Scoped "Sync from Rekordbox" — re-read a selection (targetKind=\'tracks\' → N curator tracks resolved to rb content ids; \'playlist\' → one rb playlist; \'folder\' → every non-smart non-hidden descendant playlist) from master.db and merge into Curator (last-modified-wins). The scan is scoped to the selection only (playlist ids expand to member content ids) and leaves the library-wide USN watermarks untouched. `flags` selects data classes (metadata/cues+grids+phrases/waveform/playlists); tags are unavailable (per-tag membership can\'t be scoped safely). Returns status=\'conflicts\' on both-sides-changed divergences (resolve via rekordbox:resolve-pull-conflicts), else status=\'completed\' with import totals. Progress rides the rekordbox:event import stream.' },
	'rekordbox:resolve-pull-conflicts': { description: 'Resolve the conflict pause from a Sync from Rekordbox pull. Applies per-conflict decisions into Curator (\'theirs\' writes rb\'s value; \'ours\' keeps Curator\'s and converges the baseline). No push — pull direction only. Stale conflict ids no-op.' },
	'sync:resolve-conflicts': { description: 'Resume a sync that paused on conflicts. Applies per-conflict decisions (\'ours\' keeps Curator\'s value and pushes it to the DJ app; \'theirs\' adopts the app-side value into Curator), then runs the push phase with the echoed original target + flags. Stale/unknown conflict ids no-op; conflicts left undecided stay open and remain shielded from the push.' },
	'rekordbox:missing-files': { description: 'List orphaned Rekordbox tracks whose local file is gone: a rekordbox_link exists but the track has no source=\'local\' source_link and the link\'s recorded file path no longer exists on disk. These still show in the Rekordbox tab (a rekordbox_link join) despite being unplayable. Read-only preview for the sync modal\'s cleanup step.' },
	'rekordbox:remove-missing-files': { description: 'Delete missing-file orphans as Curator deletes that propagate to Rekordbox on the next Sync to Rekordbox: tombstones each (content_delete emitted on the next push), drops the rekordbox_link (leaves the tab immediately), and soft-deletes the track. Ids are re-validated as genuine orphans server-side, so a track whose file reappeared can\'t be deleted. Never writes to streaming accounts.' },
	'rekordbox:list-backups': { description: 'List Curator-created master.db backups in the rekordbox directory. Returns path/size/timestamp for each. Rekordbox\'s own .bak files are not included.' },
	'rekordbox:clear-backups': { description: 'Delete every Curator-created master.db backup. Returns the deleted count and bytes freed. Rekordbox\'s own .bak files are not touched.' },
	'rekordbox:restore-backup': { description: 'Restore a backup over master.db. Called from the verify-failed modal when the user picks "Restore previous version." Caller must ensure Rekordbox is not running.' },
	'rekordbox:cue-palette': { description: 'Return rekordbox\'s cue color palette as opaque `{id, hex, label}` entries. `id` is the token Curator stores in cue.color (format "cti:N"); `hex` is renderable for swatches + waveform markers; `label` is the picker label. Source of truth lives in the Python sidecar — high-level layers store and pass these ids opaquely.' },
	'mir:status': { description: 'AI audio analysis engine status: engine state (disabled/starting/ready/unavailable) and device (xpu/cpu/cuda), settings, available models, per-model coverage of the playable library, the track being analyzed, pending count, last error, and whether the packaged env still needs setting up.' },
	'mir:set-settings': { description: 'Update AI engine settings (background embedding on/off, executor local|cloud, ordered model list — the first model is the default for similarity). Persisted in app_setting; returns the new status.' },
	'mir:analyze-now': { description: 'Queue tracks for AI embedding ahead of the background backlog (clears earlier failures for them). Works even when background embedding is off.' },
	'mir:provision': { description: 'Packaged builds only: create the AI engine Python environment (bundled uv + lockfile into userData/mir; multi-GB download), then start the engine.' },
	'mir:similar': { description: 'Rank library tracks by AI-embedding similarity to seed tracks and/or a text description (text needs a text-capable model). Optional library filter restricts candidates. Returns cosine scores plus seeds that have no vector yet.' },
	'backup:get-settings': { description: 'Backup settings: enabled, target (folder path or Google Drive folder name), which data sets are included, snapshots to keep, interval in hours, rekordbox master.db override.' },
	'backup:set-settings': { description: 'Update backup settings (partial patch). A folder target is validated as absolute + writable; cloud-sync folders are allowed as targets. Persisted in core app_setting.' },
	'backup:status': { description: 'Backup status: availability, settings, Google connection, last run + last success, next due time, the run in progress (phase/progress), which heavy job the scheduler is waiting for, pending/applied restore markers.' },
	'backup:target-stat': { description: 'Quota / used / free bytes on the configured backup target (and the Google account email), or null when no target is configured or the target is unreachable.' },
	'backup:list-snapshots': { description: 'Snapshots on the configured target, newest first (id, created, bytes, files, sets, pinned, label, hostname). `refresh` re-lists the target instead of the local cache.' },
	'backup:run': { description: 'Start a backup run now (ignores the schedule; refuses while another run is active or without a target). Progress arrives on backup:event.' },
	'backup:cancel': { description: 'Cancel a running backup/restore. Finished uploads are kept and the next run resumes.' },
	'backup:pin': { description: 'Pin a snapshot with a label so retention never deletes it; label null unpins.' },
	'backup:delete-snapshot': { description: 'Delete a snapshot from the target (its unreferenced objects are garbage-collected by the next run).' },
	'backup:restore-preview': { description: 'What a snapshot contains per data set (files, bytes), whether it came from this machine, the library root its audio files had, whether rekordbox is running, free space for staging.' },
	'backup:restore': { description: 'Restore selected data sets from a snapshot. Curator data (library DB, peaks, embeddings, covers) is staged and applied at the next launch (relaunchRequired=true); audio files are written to their original paths or a chosen root (with a library path remap); rekordbox data is written in place and REQUIRES rekordbox to be closed. DESTRUCTIVE for the current state — confirm first.' },
	'backup:google-connect': { description: 'Connect a Google account for Drive backups via the system browser (drive.file scope), optionally naming the Drive folder; makes Google Drive the active target. Returns status.' },
	'backup:google-disconnect': { description: 'Forget the Google Drive connection (deletes the stored refresh token). Returns status.' },
	'backup:relaunch': { description: 'Quit and relaunch Curator to apply a staged restore.' },
	'backup:take-pending-renderer-settings': { description: 'Renderer-side settings restored with the last applied snapshot, returned once and then discarded; null when there are none.' },
	'account:status': { description: 'Curator account state: signed in, email, user id, whether the session is remembered across launches, whether this build is configured for accounts at all, whether it has a sync server.' },
	'account:sign-in-password': { description: 'Sign in to the Curator account with email and password. Starts cloud sync of the library when a sync server is configured. Returns the account state.' },
	'account:sign-in-otp-request': { description: 'Email a one-time sign-in code (and magic link) to the address; creates the account if the address is new.' },
	'account:sign-in-otp-verify': { description: 'Complete an emailed-code sign-in with the 6-digit code. Returns the account state.' },
	'account:sign-out': { description: 'Sign this install out of the Curator account (other devices stay signed in). Local library data is kept.' },
	'account:devices': { description: 'List the devices registered to the Curator account (name, platform, registered/last seen/revoked), flagging this install.' },
	'cloud-sync:status': { description: 'Library cloud sync status: signed in, pending and rejected op counts, last push/pull, last error, update required, first-sign-in push progress.' },
	'cloud-sync:now': { description: 'Run one library cloud sync cycle now (push local changes, then pull remote ones). Returns the status after it.' },
	'cloud-sync:get-poll-settings': { description: 'How often this device checks the cloud for changes when no push notification arrives: seconds between checks while the app is in use (activeSec), while idle (idleSec), and how long without use counts as idle (idleAfterSec); plus defaults and limits.' },
	'cloud-sync:set-poll-policy': { description: 'Change this device\'s cloud check cadence (partial patch of activeSec / idleSec / idleAfterSec, clamped; null restores defaults). Applies to the running sync at once; not synced to other devices.' },
	'catalogue:status': { description: 'Shared analysis status: whether this device reuses analysis from the account\'s other devices (setting, server stage/policy, entitlement), the account\'s holdings and quota, what this device reused / uploaded / has pending, the existing-library upload state, the last error.' },
	'catalogue:set-settings': { description: 'Change this device\'s shared analysis settings (partial patch: enabled = reuse and share analysis, vectors, maxKBps upload throttle). Device-local, never synced.' },
	'catalogue:backfill': { description: 'Control the upload of this device\'s existing analysis to the account (start | pause | resume | stop). Throttled; waits while analysis runs.' },
	'analysis:status': { description: 'Snapshot of the analyzer queue: trackIds currently being analyzed, and the number of jobs still queued. Used by the renderer to backfill its in-memory state on first wire / HMR reload, since the event stream only delivers transitions from this point forward.' },
	'feed:get-page': { description: 'Return a ranked page of Discover feed items (keyset cursor pagination). Items are recency-ordered, suppression-filtered, and exclude dismissed/archived/promoted rows. Also returns the total visible count for the Discover tab chip.' },
	'feed:archived-page': { description: 'Return a page of archived feed items (state=archived), newest first, keyset-paginated. No suppression filter — archiving is an explicit per-item choice. Returns the total archived count.' },
	'feed:detail': { description: 'Return one feed item plus per-track played state. For album items, lazily fetches and caches the tracklist from the source on first call.' },
	'feed:enrich': { description: 'Run on-view Beatport enrichment for one feed item: fills the album-level genre/label plus per-track bpm/key/genre/label, caches it onto the item, and returns the updated item. Idempotent — an already-enriched item returns untouched (zero Beatport calls). Called after the tracklist renders so rows show instantly and DJ metadata fills in a moment later.' },
	'feed:action': { description: 'Apply a user action to a feed item: dismiss (aka Delete — soft remove, optional artist/label/playlist scope suppression), archive (set aside to the Archived page), unarchive (restore to the feed), interested (promote into the library as backlog + interested tag), uninterested (reverse of interested — delete the promoted/owned library track and return a promoted item to the feed), seen, expanded, or played (sets played-dimming state and logs the listen signal).' },
	'feed:unfollow-playlist': { description: 'Unfollow a source playlist surfaced in the feed: drops it at the source (Spotify) and hard-removes every feed item it produced. Returns removed count. Fail-closed when Spotify is disconnected (ok:false, nothing removed).' },
	'feed:unfollow-artist': { description: 'Unfollow a source artist surfaced in the feed: drops them at the source (Spotify) and hard-removes every feed item they produced or appear on. Returns removed count. Fail-closed when Spotify is disconnected (ok:false, nothing removed).' },
	'feed:filter-options': { description: 'Return the distinct genre and label values present across the visible feed, sorted — populates the Discover genre/label filter dropdowns.' },
	'feed:refresh': { description: 'Run one manual poll pass over every registered feed producer. Returns per-producer inserted counts and errors.' },
	'feed:refresh-producer': { description: 'Run one manual poll pass over a SINGLE feed producer by id. Powers the temporary Refresh Artists / Refresh Playlists buttons. Unknown id is a clean no-op.' },
	'feed:load-more': { description: 'Extend every feed producer\'s history horizon back by N days (clamped 1..60) and ingest the newly-uncovered older items. Powers the "Load more" button at the end of the Discover feed.' },
	'journey:create': { description: 'Start a discovery journey from a seed (library track / KB entity / provider source ref): resolves the seed to a KB entity, creates the journey with that entity as root node + current position, and returns the full journey detail.' },
	'journey:list': { description: 'List non-archived journeys, most-recently-active first, with node counts and the current node\'s entity name for the resume strip.' },
	'journey:get': { description: 'Return one journey plus its full node tree as a flat array — the renderer reassembles the tree via parentNodeId.' },
	'journey:rename': { description: 'Rename a journey.' },
	'journey:delete': { description: 'Delete a journey and all its nodes. KB entities are untouched — knowledge outlives journeys.' },
	'journey:navigate': { description: 'Navigate the journey to a KB entity: appends a child under the current node and moves the pointer. From an interior node this forks a new branch; navigating to an entity already branched from here re-enters that node unless forceBranch. Traversing an agent-researched edge hardens it (implicit confirmation). Returns the new node + the entity\'s detail.' },
	'journey:jump': { description: 'Move the journey\'s current pointer to any existing node (browser-style back/forward jump) and return that node\'s entity detail.' },
	'journey:set-view': { description: 'Persist a node\'s renderer-owned view state (scroll, expanded aspect). Opaque to core; debounce on the caller side.' },
	'journey:delete-branch': { description: 'Remove a node and its whole subtree from a journey. Refuses the root (delete the journey instead); repoints current to the parent when it was inside the removed branch.' },
	'kb:entity': { description: 'Memory-only read of a KB entity: the row, its provenance refs, edges (with tier/confidence/citations for research claims), neighbor entities, per-aspect expansion states, available aspects, and computed library linkage. Never touches the network.' },
	'kb:expand': { description: 'Answer one aspect of an entity via the resolver ladder. A completed aspect answers instantly from knowledge.db; structured aspects (Spotify artist releases, release tracklists) await the first provider page and stream the rest via kb:event; agent aspects (similar-artists research) return status=running immediately and stream results when the research lands. opts.refresh forces a re-fetch.' },
	'kb:search': { description: 'Local folded-name substring search over KB entities, optionally narrowed by kind. Never network — searches only what the KB has already learned.' },
	'kb:resolve': { description: 'Find-or-create a KB entity from a seed without touching any journey — used to warm an entity before starting or navigating.' },
	'kb:promote': { description: 'Promote a KB track into the library — identical path to a feed promotion (ingest match, backlog state, interested pin, membership classification). Requires the track to carry a Spotify ref. Hardens any research claims touching it.' },
	'agent:status': { description: 'Return the in-app agent\'s state (disabled / unconfigured / ready / running) plus the configured provider + model roles.' },
	'agent:get-config': { description: 'Return the BYOK agent config with the API key redacted to hasKey. Null when never configured.' },
	'agent:set-config': { description: 'Persist BYOK agent config (provider, models, optional new API key — omitted key keeps the stored one), encrypt the key via safeStorage, and re-arm the sidecar without a respawn. Returns the new status.' },
	'agent:send': { description: 'Send a user message to the agent. Creates a session when none given. Returns {status:running, sessionId, turnId} immediately; the turn streams over agent:event.' },
	'agent:cancel': { description: 'Cancel the session\'s in-flight turn (Stop button). No-op when idle.' },
	'agent:list-sessions': { description: 'List agent conversation sessions, most recently active first.' },
	'agent:get-session': { description: 'Return one session\'s display transcript (user/assistant turns) + its result-set summaries.' },
	'agent:new-session': { description: 'Create a fresh agent session.' },
	'agent:delete-session': { description: 'Delete a session, its messages and its result sets. Cancels its running turn first.' },
	'agent:get-result-set': { description: 'Fetch a persisted agent result set by id — the renderer\'s refetch-on-reload path for the Discover result-list mode.' },
	'mcp:confirm-response': { description: 'Answer an mcp:confirm event: approve or deny a Claude-initiated write from the MCP bridge. Late answers (after main\'s timeout deny) are ignored.' },
};
