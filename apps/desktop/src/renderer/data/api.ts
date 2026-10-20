// Data-layer transport facade — the renderer's seam onto the backend. The
// invoke-style facades below route through the tRPC client (data/trpc.ts) over
// IPC; swapping the transport (HTTP for the web build) changes that client and
// this file only — that seam is the point.
//
// Facades stay 1:1 with the backend surface — no renaming, no reshaping. The
// input to each `.mutate(...)` is the SAME args tuple the IPC handler expects
// (no-arg channels pass an empty tuple). Semantics (caching, optimistic
// writes, event ingestion) live in the per-domain store modules, never here.
//
// Event subscriptions (onX) are NOT tRPC calls — they're one-way main→renderer
// pushes — so they stay on the preload's typed `window.api` surface. window.api
// is allowed in this file (renderer/data/ is the boundary script's zone).

import type { DownloadJob, QueueSummary, AutoAnalyzeSettings, RekordboxFlags, ClearableTrackField, RemovableTrackSource } from '@curator/core';
import type { AlbumSummary, ArtistCreditFormat, ArtistLink, ArtistListOpts, ArtistMergeSuggestion, ArtistScope, ArtistSummary } from '@curator/shared';
import type { StreamingSource, SourceSyncSettings, PlayRecordUpsert } from '@curator/shared';
import { trpc } from './trpc.js';

// window.api is typed via the preload global declaration; route the remaining
// (event-subscription) accesses through this helper so the boundary script has
// one needle.
const api = () => window.api;

export const downloadsApi = {
	queue: (): Promise<DownloadJob[]> => trpc.downloads.queue.mutate([]),
	summary: (): Promise<QueueSummary> => trpc.downloads.summary.mutate([]),
	retry: (trackId: string): Promise<void> => trpc.downloads.retry.mutate([trackId]),
	redownload: (trackId: string): Promise<void> => trpc.downloads.redownload.mutate([trackId]),
	clearCompleted: (): Promise<void> => trpc.downloads.clearCompleted.mutate([]),
	clearAll: (): Promise<void> => trpc.downloads.clearAll.mutate([]),
	openFolder: (): Promise<void> => trpc.downloads.openFolder.mutate([]),
	status: () => trpc.downloads.status.mutate([]),
	enable: () => trpc.downloads.enable.mutate([]),
	enqueue: (items: { trackId: string; trackTitle: string; artistName: string }[]) =>
		trpc.downloads.enqueue.mutate([items]),
	onQueueEvent: (cb: Parameters<typeof window.api.onDownloadQueueEvent>[0]) =>
		api().onDownloadQueueEvent(cb),
};

export const authApi = {
	status: () => trpc.auth.status.mutate([]),
	spotifyStart: () => trpc.auth.spotifyStart.mutate([]),
	spotifyDisconnect: () => trpc.auth.spotifyDisconnect.mutate([]),
	tidalStart: () => trpc.auth.tidalStart.mutate([]),
	tidalDisconnect: () => trpc.auth.tidalDisconnect.mutate([]),
};

export const tracksApi = {
	sourceLinks: (trackId: string) => trpc.tracks.sourceLinks.mutate([trackId]),
	// Explicit return types on facades whose payload carries Date / optional
	// fields: tRPC's output inference runs the result through its JSON-wire
	// serialization model (Date→string, optional-unknown widening), but our
	// IPC bridge uses structured clone so the real shapes survive at runtime.
	// We re-assert the authoritative contract type (from IpcChannels via the
	// preload `Api`) so downstream callers keep the exact types they had.
	setOverrides: (trackId: string, patch: Parameters<typeof window.api['tracks:set-overrides']>[1]): ReturnType<typeof window.api['tracks:set-overrides']> =>
		trpc.tracks.setOverrides.mutate([trackId, patch]) as ReturnType<typeof window.api['tracks:set-overrides']>,
	setSourceLinks: (trackId: string, urls: { spotify?: string | null; tidal?: string | null; beatport?: string | null }) =>
		trpc.tracks.setSourceLinks.mutate([trackId, urls]),
	deleteSourceLink: (trackId: string, source: 'spotify' | 'tidal' | 'beatport') =>
		trpc.tracks.deleteSourceLink.mutate([trackId, source]),
	// Track merge (Edit modal's "already linked" offer). Both carry Track rows
	// with Date fields — same authoritative-type re-assertion as `list`.
	mergePreview: (aId: string, bId: string): ReturnType<typeof window.api['tracks:merge-preview']> =>
		trpc.tracks.mergePreview.mutate([aId, bId]) as unknown as ReturnType<typeof window.api['tracks:merge-preview']>,
	merge: (keepId: string, dropId: string): ReturnType<typeof window.api['tracks:merge']> =>
		trpc.tracks.merge.mutate([keepId, dropId]) as unknown as ReturnType<typeof window.api['tracks:merge']>,
	clearFields: (trackId: string, fields: ClearableTrackField[]): ReturnType<typeof window.api['tracks:clear-fields']> =>
		trpc.tracks.clearFields.mutate([trackId, fields]) as ReturnType<typeof window.api['tracks:clear-fields']>,
	// Distinct genre/label vocabulary for the Edit Track autocomplete datalists.
	fieldOptions: (): Promise<{ genres: string[]; labels: string[] }> => trpc.tracks.fieldOptions.mutate([]),
	// Fetch tracks by filter (e.g. { playlistId }, { playlistIds }, or
	// { libraryFolderId }) — used by the playlist/folder "Analyze…" context
	// actions to collect a scope's track ids. Same authoritative return-type
	// re-assertion as the other facades (structured-clone IPC preserves the
	// real Track shape that tRPC's wire inference would widen).
	list: (filter?: Parameters<typeof window.api['tracks:list']>[0]): ReturnType<typeof window.api['tracks:list']> =>
		trpc.tracks.list.mutate([filter]) as unknown as ReturnType<typeof window.api['tracks:list']>,
	// Windowed read — the path every list surface uses. Returns one page +
	// matching total. Same authoritative return-type re-assertion as `list`
	// (structured-clone IPC preserves the real Track/Date shapes tRPC would widen).
	page: (
		filter?: Parameters<typeof window.api['tracks:page']>[0],
		sort?: Parameters<typeof window.api['tracks:page']>[1],
		req?: Parameters<typeof window.api['tracks:page']>[2],
	): ReturnType<typeof window.api['tracks:page']> =>
		trpc.tracks.page.mutate([filter, sort, req]) as unknown as ReturnType<typeof window.api['tracks:page']>,
	// Ordered ids for the whole result set (play-all / queue / select-all).
	ids: (
		filter?: Parameters<typeof window.api['tracks:ids']>[0],
		sort?: Parameters<typeof window.api['tracks:ids']>[1],
	): ReturnType<typeof window.api['tracks:ids']> =>
		trpc.tracks.ids.mutate([filter, sort]) as unknown as ReturnType<typeof window.api['tracks:ids']>,
	playlists: (trackId: string) => trpc.tracks.playlists.mutate([trackId]),
	tags: (trackId: string) => trpc.tracks.tags.mutate([trackId]),
	addTag: (trackId: string, tagId: string) => trpc.tracks.addTag.mutate([trackId, tagId]),
	removeTag: (trackId: string, tagId: string) => trpc.tracks.removeTag.mutate([trackId, tagId]),
	addTagSkippingLocal: (trackIds: string[], tagId: string) =>
		trpc.tracks.addTagSkippingLocal.mutate([trackIds, tagId]),
	delete: (trackIds: string[]) => trpc.tracks.delete.mutate([trackIds]),
	// Delete dialog's per-source removal. `updated` carries Track rows with
	// Date fields — same authoritative-type re-assertion as `list`.
	removeSources: (trackIds: string[], sources: RemovableTrackSource[]): ReturnType<typeof window.api['tracks:remove-sources']> =>
		trpc.tracks.removeSources.mutate([trackIds, sources]) as unknown as ReturnType<typeof window.api['tracks:remove-sources']>,
	undelete: (trackIds: string[]) => trpc.tracks.undelete.mutate([trackIds]),
};

// Library artist entities — the Artists browser, the Edit Track artist
// autocomplete, chip → scope resolution and rename/merge. Same authoritative
// return-type re-assertion as the track facades (ArtistSummary carries a
// Date that tRPC's wire inference would widen).
// Credit display format — core-owned so the rekordbox push agrees with the
// screen; the UI-settings store mirrors it (features/uiSettings.ts).
export const creditsApi = {
	getFormat: (): Promise<{ format: ArtistCreditFormat; stored: boolean }> => trpc.credits.getFormat.mutate([]) as unknown as Promise<{ format: ArtistCreditFormat; stored: boolean }>,
	setFormat: (fmt: ArtistCreditFormat): Promise<void> => trpc.credits.setFormat.mutate([fmt]) as unknown as Promise<void>,
};

// Convert to WAV — core owns the run (files + library DB); progress arrives
// on window.api.onWavConvertEvent.
export const wavApi = {
	getSettings: (): ReturnType<typeof window.api['wav:get-settings']> =>
		trpc.wav.getSettings.mutate([]) as unknown as ReturnType<typeof window.api['wav:get-settings']>,
	setSettings: (settings: { outputDir: string }): ReturnType<typeof window.api['wav:set-settings']> =>
		trpc.wav.setSettings.mutate([settings]) as unknown as ReturnType<typeof window.api['wav:set-settings']>,
	preview: (playlistId: string): ReturnType<typeof window.api['wav:preview']> =>
		trpc.wav.preview.mutate([playlistId]) as unknown as ReturnType<typeof window.api['wav:preview']>,
	convert: (playlistId: string): ReturnType<typeof window.api['wav:convert']> =>
		trpc.wav.convert.mutate([playlistId]) as unknown as ReturnType<typeof window.api['wav:convert']>,
	cancel: (runId: string): ReturnType<typeof window.api['wav:cancel']> =>
		trpc.wav.cancel.mutate([runId]) as unknown as ReturnType<typeof window.api['wav:cancel']>,
};

export const albumsApi = {
	byIds: (ids: string[]): Promise<AlbumSummary[]> => trpc.albums.byIds.mutate([ids]) as unknown as Promise<AlbumSummary[]>,
};

export const artistsApi = {
	list: (opts?: ArtistListOpts): Promise<ArtistSummary[]> =>
		trpc.artists.list.mutate([opts]) as unknown as Promise<ArtistSummary[]>,
	get: (id: string): Promise<ArtistSummary | null> =>
		trpc.artists.get.mutate([id]) as unknown as Promise<ArtistSummary | null>,
	resolve: (name: string): Promise<ArtistSummary | null> =>
		trpc.artists.resolve.mutate([name]) as unknown as Promise<ArtistSummary | null>,
	links: (id: string): Promise<ArtistLink[]> => trpc.artists.links.mutate([id]) as unknown as Promise<ArtistLink[]>,
	mergeSuggestions: (scope?: ArtistScope): Promise<ArtistMergeSuggestion[]> => trpc.artists.mergeSuggestions.mutate([scope]) as unknown as Promise<ArtistMergeSuggestion[]>,
	dismissMerge: (aId: string, bId: string): Promise<void> => trpc.artists.dismissMerge.mutate([aId, bId]) as unknown as Promise<void>,
	rename: (id: string, newName: string): Promise<{ artist: ArtistSummary; tracksRewritten: number }> =>
		trpc.artists.rename.mutate([id, newName]) as unknown as Promise<{ artist: ArtistSummary; tracksRewritten: number }>,
	merge: (keepId: string, dropId: string): Promise<{ artist: ArtistSummary; tracksRewritten: number }> =>
		trpc.artists.merge.mutate([keepId, dropId]) as unknown as Promise<{ artist: ArtistSummary; tracksRewritten: number }>,
};

export const libraryApi = {
	// Two-step (`as unknown as`) cast: LibraryFolder's Date fields don't overlap
	// tRPC's serialized `string` form enough for a direct assertion. The
	// structured-clone IPC bridge actually delivers Date objects at runtime.
	listFolders: (): ReturnType<typeof window.api['library:list-folders']> =>
		trpc.library.listFolders.mutate([]) as unknown as ReturnType<typeof window.api['library:list-folders']>,
	addFolder: (path: string, opts?: { allowCloudSync?: boolean }): ReturnType<typeof window.api['library:add-folder']> =>
		trpc.library.addFolder.mutate([path, opts]) as unknown as ReturnType<typeof window.api['library:add-folder']>,
	removeFolder: (folderId: string) => trpc.library.removeFolder.mutate([folderId]),
	pruneDeletedFiles: (opts?: { dryRun?: boolean }) => trpc.library.pruneDeletedFiles.mutate([opts]),
	duplicateAudioGroups: () => trpc.library.duplicateAudioGroups.mutate([]),
	trackLocalFile: (trackId: string) => trpc.library.trackLocalFile.mutate([trackId]),
};

export const playsApi = {
	record: (e: PlayRecordUpsert): Promise<void> => trpc.plays.record.mutate([e]),
};

export const playlistsApi = {
	rename: (playlistId: string, newName: string) => trpc.playlists.rename.mutate([playlistId, newName]),
	removeTracks: (playlistId: string, trackIds: string[]) =>
		trpc.playlists.removeTracks.mutate([playlistId, trackIds]),
	findTracksWithDeletedFiles: (playlistIds: string[]) =>
		trpc.playlists.findTracksWithDeletedFiles.mutate([playlistIds]),
	upstreamDrift: (playlistId: string) => trpc.playlists.upstreamDrift.mutate([playlistId]),
	pushLocalOnly: (playlistId: string, sourceTrackIds?: string[]) =>
		trpc.playlists.pushLocalOnly.mutate([playlistId, sourceTrackIds]),
};

export const syncApi = {
	spotifyPlaylist: (playlistId: string, opts?: { force?: boolean }) => trpc.sync.spotifyPlaylist.mutate([playlistId, opts]),
	tidalPlaylist: (playlistId: string, opts?: { force?: boolean }) => trpc.sync.tidalPlaylist.mutate([playlistId, opts]),
	resolveConflicts: (opts: Parameters<typeof window.api['sync:resolve-conflicts']>[0]) =>
		trpc.sync.resolveConflicts.mutate([opts]),
};

export const enrichApi = {
	beatportPlaylist: (playlistId: string, sort?: Parameters<typeof window.api['enrich:beatport:playlist']>[1]) =>
		trpc.enrich.beatportPlaylist.mutate([playlistId, sort]),
	beatportTrack: (trackId: string) => trpc.enrich.beatportTrack.mutate([trackId]),
	beatportTracks: (trackIds: string[]) => trpc.enrich.beatportTracks.mutate([trackIds]),
};

export const tidalApi = {
	matchTrack: (trackId: string) => trpc.tidal.matchTrack.mutate([trackId]),
	matchTracks: (trackIds: string[]) => trpc.tidal.matchTracks.mutate([trackIds]),
	setPlaylistHybrid: (playlistId: string, enabled: boolean, sort?: Parameters<typeof window.api['tidal:set-playlist-hybrid']>[2]) =>
		trpc.tidal.setPlaylistHybrid.mutate([playlistId, enabled, sort]),
};

// Discovery journeys + knowledge base — thin facades over the journey:* /
// kb:* channels so components stay off the raw preload bridge (F2). Like the
// feed, these ride the preload's typed invoke surface rather than tRPC for
// now; when the feed migrates onto the router (F6), these move with it.
export const journeyApi = {
	create: (...args: Parameters<typeof window.api['journey:create']>) => api()['journey:create'](...args),
	list: () => api()['journey:list'](),
	get: (journeyId: string) => api()['journey:get'](journeyId),
	rename: (journeyId: string, name: string) => api()['journey:rename'](journeyId, name),
	remove: (journeyId: string) => api()['journey:delete'](journeyId),
	navigate: (...args: Parameters<typeof window.api['journey:navigate']>) => api()['journey:navigate'](...args),
	jump: (journeyId: string, nodeId: string) => api()['journey:jump'](journeyId, nodeId),
	setView: (journeyId: string, nodeId: string, view: unknown) => api()['journey:set-view'](journeyId, nodeId, view),
	deleteBranch: (journeyId: string, nodeId: string) => api()['journey:delete-branch'](journeyId, nodeId),
};

export const kbApi = {
	entity: (entityId: string) => api()['kb:entity'](entityId),
	expand: (...args: Parameters<typeof window.api['kb:expand']>) => api()['kb:expand'](...args),
	search: (...args: Parameters<typeof window.api['kb:search']>) => api()['kb:search'](...args),
	resolve: (...args: Parameters<typeof window.api['kb:resolve']>) => api()['kb:resolve'](...args),
	promote: (...args: Parameters<typeof window.api['kb:promote']>) => api()['kb:promote'](...args),
	// Push stream of expansion/research completions; returns unsubscribe.
	onEvent: (cb: Parameters<typeof window.api.onKbEvent>[0]) => api().onKbEvent(cb),
};

export const shellApi = {
	openExternal: (url: string) => trpc.shell.openExternal.mutate([url]),
	showInFolder: (filePath: string) => trpc.shell.showInFolder.mutate([filePath]),
	copyText: (text: string) => trpc.shell.copyText.mutate([text]),
	// "Open in Spotify" means *navigate the desktop app to this entity in
	// context* — not play it. The spotify: URI scheme deep-links the desktop
	// app to the track/album/artist/playlist without starting playback, whereas
	// an https://open.spotify.com/… link routes through the browser web player.
	// Accepts either an open.spotify.com URL or an already-built spotify: URI.
	openSpotify: (urlOrUri: string) => trpc.shell.openExternal.mutate([toSpotifyAppUri(urlOrUri)]),
};

// open.spotify.com/{type}/{id} → spotify:{type}:{id}. Returns the input
// unchanged if it isn't a recognisable Spotify entity URL (already a URI, or
// a non-Spotify link the caller passed by mistake).
function toSpotifyAppUri(urlOrUri: string): string {
	const m = urlOrUri.match(/open\.spotify\.com\/(track|album|artist|playlist)\/([A-Za-z0-9]+)/);
	return m ? `spotify:${m[1]}:${m[2]}` : urlOrUri;
}

export const sourcesApi = {
	getSyncSettings: () => trpc.sources.getSyncSettings.mutate([]),
	setSyncSettings: (source: StreamingSource, settings: SourceSyncSettings) =>
		trpc.sources.setSyncSettings.mutate([source, settings]),
};

export const rekordboxApi = {
	detect: () => trpc.rekordbox.detect.mutate([]),
	read: (opts: { mode: 'incremental' | 'full'; flags: RekordboxFlags; key?: string; dbPathOverride?: string; overwriteCurator?: boolean }) =>
		trpc.rekordbox.read.mutate([opts]),
	listBackups: (dbPathOverride?: string) => trpc.rekordbox.listBackups.mutate([dbPathOverride]),
	clearBackups: (dbPathOverride?: string) => trpc.rekordbox.clearBackups.mutate([dbPathOverride]),
	sync: (opts: Parameters<typeof window.api['rekordbox:sync']>[0]): ReturnType<typeof window.api['rekordbox:sync']> =>
		trpc.rekordbox.sync.mutate([opts]) as ReturnType<typeof window.api['rekordbox:sync']>,
	createPreview: (playlistId: string): ReturnType<typeof window.api['rekordbox:create-preview']> =>
		trpc.rekordbox.createPreview.mutate([playlistId]) as ReturnType<typeof window.api['rekordbox:create-preview']>,
	syncFrom: (opts: Parameters<typeof window.api['rekordbox:sync-from']>[0]): ReturnType<typeof window.api['rekordbox:sync-from']> =>
		trpc.rekordbox.syncFrom.mutate([opts]) as ReturnType<typeof window.api['rekordbox:sync-from']>,
	resolvePullConflicts: (opts: Parameters<typeof window.api['rekordbox:resolve-pull-conflicts']>[0]): ReturnType<typeof window.api['rekordbox:resolve-pull-conflicts']> =>
		trpc.rekordbox.resolvePullConflicts.mutate([opts]) as ReturnType<typeof window.api['rekordbox:resolve-pull-conflicts']>,
	restoreBackup: (backupPath: string, dbPathOverride?: string) =>
		trpc.rekordbox.restoreBackup.mutate([backupPath, dbPathOverride]),
	// Missing-file orphan detection + cleanup. One-way reads/mutations that
	// stay on the window.api bridge (not tRPC) — no progress stream to carry.
	missingFiles: (): ReturnType<typeof window.api['rekordbox:missing-files']> =>
		api()['rekordbox:missing-files'](),
	removeMissingFiles: (trackIds: string[]): ReturnType<typeof window.api['rekordbox:remove-missing-files']> =>
		api()['rekordbox:remove-missing-files'](trackIds),
	onEvent: (cb: Parameters<typeof window.api.onRekordboxEvent>[0]) =>
		api().onRekordboxEvent(cb),
	onExportEvent: (cb: Parameters<typeof window.api.onRekordboxExportEvent>[0]) =>
		api().onRekordboxExportEvent(cb),
};

export const analysisApi = {
	setAutoEnqueue: (settings: AutoAnalyzeSettings) => trpc.analysis.setAutoEnqueue.mutate([settings]),
	// Authoritative running/queued snapshot (queued = dispatchable-now, gated by
	// the queue's auto-analyze floor). One-way query, stays on window.api.
	status: () => api()['analysis:status'](),
};

// AI audio analysis engine. Similarity for the tracklist rides tracks:page
// (filter.similarTo); this facade is the engine's status/settings surface.
export const mirApi = {
	status: () => api()['mir:status'](),
	similar: (q: Parameters<typeof window.api['mir:similar']>[0]) => api()['mir:similar'](q),
	setSettings: (patch: Parameters<typeof window.api['mir:set-settings']>[0]) => trpc.mir.setSettings.mutate([patch]),
	analyzeNow: (trackIds: string[]) => trpc.mir.analyzeNow.mutate([trackIds]),
	provision: () => trpc.mir.provision.mutate([]),
	onEvent: (cb: Parameters<typeof window.api.onMirEvent>[0]) => api().onMirEvent(cb),
};

// Backup & restore. Status + listings are one-way queries on window.api;
// mutations ride tRPC. The settings tab re-renders on onEvent.
export const backupApi = {
	status: () => api()['backup:status'](),
	targetStat: () => api()['backup:target-stat'](),
	getSettings: () => api()['backup:get-settings'](),
	listSnapshots: (opts?: { refresh?: boolean }) => api()['backup:list-snapshots'](opts),
	setSettings: (patch: Parameters<typeof window.api['backup:set-settings']>[0]) => trpc.backup.setSettings.mutate([patch]),
	run: () => trpc.backup.run.mutate([]),
	cancel: (runId: string) => trpc.backup.cancel.mutate([runId]),
	pin: (snapshotId: string, label: string | null) => trpc.backup.pin.mutate([snapshotId, label]),
	deleteSnapshot: (snapshotId: string) => trpc.backup.deleteSnapshot.mutate([snapshotId]),
	restorePreview: (snapshotId: string) => trpc.backup.restorePreview.mutate([snapshotId]),
	restore: (req: Parameters<typeof window.api['backup:restore']>[0]) => trpc.backup.restore.mutate([req]),
	googleConnect: (folderName?: string) => trpc.backup.googleConnect.mutate([folderName]),
	googleDisconnect: () => trpc.backup.googleDisconnect.mutate([]),
	relaunch: () => trpc.backup.relaunch.mutate([]),
	takePendingRendererSettings: () => api()['backup:take-pending-renderer-settings'](),
	onEvent: (cb: Parameters<typeof window.api.onBackupEvent>[0]) => api().onBackupEvent(cb),
};

// Curator account (session held in main) + library cloud sync. Status reads
// ride window.api; actions ride tRPC. The Account settings tab re-renders on
// onStatus; the track list reacts to onApplied.
export const accountApi = {
	status: () => api()['account:status'](),
	signInPassword: (email: string, password: string) => trpc.account.signInPassword.mutate([email, password]),
	requestCode: (email: string) => trpc.account.signInOtpRequest.mutate([email]),
	verifyCode: (email: string, code: string) => trpc.account.signInOtpVerify.mutate([email, code]),
	signOut: () => trpc.account.signOut.mutate([]),
	devices: () => trpc.account.devices.mutate([]),
};

export const cloudSyncApi = {
	status: () => api()['cloud-sync:status'](),
	syncNow: () => trpc.cloudSync.now.mutate([]),
	pollSettings: () => api()['cloud-sync:get-poll-settings'](),
	setPollPolicy: (patch: Parameters<typeof window.api['cloud-sync:set-poll-policy']>[0]) => trpc.cloudSync.setPollPolicy.mutate([patch]),
	onStatus: (cb: Parameters<typeof window.api.onCloudSyncStatus>[0]) => api().onCloudSyncStatus(cb),
	onApplied: (cb: Parameters<typeof window.api.onSyncApplied>[0]) => api().onSyncApplied(cb),
};

// Shared analysis catalogue (Settings → Account). Status rides window.api,
// actions ride tRPC, like cloudSyncApi.
export const catalogueApi = {
	status: () => api()['catalogue:status'](),
	setSettings: (patch: Parameters<typeof window.api['catalogue:set-settings']>[0]) => trpc.catalogue.setSettings.mutate([patch]),
	backfill: (action: Parameters<typeof window.api['catalogue:backfill']>[0]) => trpc.catalogue.backfill.mutate([action]),
	onStatus: (cb: Parameters<typeof window.api.onCatalogueStatus>[0]) => api().onCatalogueStatus(cb),
};

export const dialogApi = {
	pickFolder: () => trpc.dialog.pickFolder.mutate([]),
};
