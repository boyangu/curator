// IPC handler bindings. One typed entry per channel in IpcChannels — TypeScript
// enforces that every channel declared in apps/desktop/src/ipc.ts has a
// handler here (and that argument/return types match).
//
// Registered into ipcMain in main/index.ts by iterating TOOL_CATALOG. In
// initiative 4 the AI orchestrator will iterate the same catalog to expose
// these as LLM tools — handlers here are the single execution surface.

import { app, BrowserWindow, clipboard, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoreService, SyncProgress } from '@curator/core';
import { normalizePath } from '@curator/core';
import { mainLog } from './log.js';
import { broadcastEvent, sendEvent } from './events.js';
import { runSpotifyAuthFlow } from './auth/spotify.js';
import { runTidalAuthFlow, clearTidalSession } from './auth/tidal.js';
import { runTidalSniffFlow } from './auth/tidal-sniff.js';
import { getRedactedAgentConfig, saveAgentConfig } from './agent-config.js';
import { disconnectGoogle, runGoogleConnectFlow } from './backup/google-auth.js';
import { PENDING_RENDERER_SETTINGS_FILE } from '@curator/core';
import type { AccountDevice, AccountStatus, IpcChannels } from '../ipc.js';
import type { CloudTransport } from '@curator/core';
import type { CloudAccount } from './cloud/account.js';
import type { CoreSidecarHost } from './core-sidecar/host.js';
import type { AudioSidecarHost } from './audio-sidecar.js';
import type { SpotifySidecarHost } from './spotify-sidecar.js';
import type { McpConfirmBroker } from './mcp/confirm.js';

export interface HandlerContext {
	getMainWindow: () => BrowserWindow | null;
	// When set, IPC channels listed in `migratedChannels` (currently just
	// 'tracks:list') get routed through the sidecar instead of the in-process
	// `svc`. As more channels migrate this set grows; once everything is
	// through, the direct-call code paths can be removed.
	coreSidecar?: CoreSidecarHost | null;
	// Native audio engine sidecar. When unavailable (CURATOR_DISABLE_AUDIO=1
	// or the binary couldn't be found), `audio:rpc` calls reject with a
	// "sidecar unavailable" error and the renderer falls back to silence —
	// the deck UI still functions for visual scrubbing, just without sound.
	audioSidecar?: AudioSidecarHost | null;
	// Spotify playback sidecar. When unavailable (CURATOR_DISABLE_SPOTIFY=1 or
	// the signed bundle is missing), `spotify:rpc` calls reject and the
	// renderer treats Spotify playback as unavailable.
	spotifySidecar?: SpotifySidecarHost | null;
	// MCP bridge confirm broker — routes the renderer's approve/deny back to
	// the pending Claude-initiated write.
	mcpConfirm?: McpConfirmBroker | null;
	// Curator account session (Supabase, main-only). Null when it could not
	// be created; the account channels then report signed out.
	cloudAccount?: CloudAccount | null;
	// The HTTP transport core syncs over; null when no cloud API URL is
	// configured (sign-in works, sync is off).
	cloudTransport?: CloudTransport | null;
	// Profile-mode rails (profile.ts). A non-null message makes the gated
	// channels reject before any network call or disk write: downloads would
	// land in the real ~/Music library folder, and a Google connect would arm
	// a backup target the profile has no engine for.
	profileBlocks?: { downloads: string | null; googleBackup: string | null };
}

export type Handlers = {
	[K in keyof IpcChannels]: (
		...args: IpcChannels[K]['args']
	) => Promise<IpcChannels[K]['ret']>;
};

export function buildHandlers(svc: CoreService, ctx: HandlerContext): Handlers {
	const broadcastProgress = (p: SyncProgress): void => broadcastEvent('sync:progress', p);
	const requireAccount = (): CloudAccount => {
		if (!ctx.cloudAccount) throw new Error('Curator accounts are not configured in this build (CURATOR_SUPABASE_URL / CURATOR_SUPABASE_PUBLISHABLE_KEY).');
		return ctx.cloudAccount;
	};
	const refuseIf = (reason: string | null | undefined): void => {
		if (reason) throw new Error(reason);
	};
	const accountStatus = (): AccountStatus => ({
		...(ctx.cloudAccount?.state() ?? { signedIn: false, email: null, userId: null, persistent: false }),
		configured: !!ctx.cloudAccount,
		syncAvailable: !!ctx.cloudTransport,
	});
	// The account's devices with this install flagged; empty when sync is off
	// or signed out. The current device id comes from core (unlink changes it).
	const listAccountDevices = async (): Promise<AccountDevice[]> => {
		if (!ctx.cloudTransport || !ctx.cloudAccount?.cloudSession()) return [];
		const [devices, status] = await Promise.all([ctx.cloudTransport.account.devices(), svc.getCloudSyncStatus()]);
		return devices.map((d) => ({ ...d, current: d.deviceId === status.deviceId }));
	};

	// Route a READ-ONLY channel through the core sidecar when it's enabled —
	// these are the hot per-page lookups (track list, tag/playlist membership
	// batches, sidebar trees) whose sync better-sqlite3 calls otherwise run
	// on main's event loop and block every other IPC + paint while they scan.
	// The channel must have a matching dispatch entry in
	// core-sidecar/entry.ts; the in-process call is the fallback when the
	// sidecar is disabled or failed to boot. Only pure reads belong here —
	// writes stay in-process until the full core migration moves them
	// together with their event plumbing.
	const readViaSidecar = <K extends keyof IpcChannels>(
		channel: K,
		direct: (...args: IpcChannels[K]['args']) => Promise<IpcChannels[K]['ret']>,
	) => async (...args: IpcChannels[K]['args']): Promise<IpcChannels[K]['ret']> => {
		if (ctx.coreSidecar) {
			return ctx.coreSidecar.call(channel, args) as Promise<IpcChannels[K]['ret']>;
		}
		return direct(...args);
	};

	// Token-freshness gate. Tidal bearers are 24h JWTs; running a long queue
	// with a token that expires mid-flight would land every late job in
	// auth_required. Pre-flight the sniff once when we're inside the 15min
	// danger zone — the persistent listen.tidal.com session cookies usually
	// let the new window auto-sign-in without user input.
	const ensureFreshTidalSession = async (): Promise<void> => {
		if (svc.auth.isTidalSessionFresh()) return;
		mainLog.for('tidal').info('session stale (or absent), running sniff to refresh');
		await runTidalSniffFlow(svc.auth);
	};

	return {
		'tracks:list': readViaSidecar('tracks:list', async (filter, sort, limit, offset) => svc.getTracks(filter, sort, limit, offset)),
		'tracks:page': readViaSidecar('tracks:page', async (filter, sort, req) => svc.getTracksPage(filter, sort, req)),
		'tracks:ids': readViaSidecar('tracks:ids', async (filter, sort) => svc.getTrackIds(filter, sort)),
		'playlists:list': readViaSidecar('playlists:list', async () => svc.getPlaylists()),
		'tracks:playlists': readViaSidecar('tracks:playlists', async (trackId) => svc.getTrackPlaylists(trackId)),
		'playlists:set-favorite': async (playlistId, isFavorite) => svc.setPlaylistFavorite(playlistId, isFavorite),
		'playlists:rename':       async (playlistId, newName)    => svc.renamePlaylist(playlistId, newName),
		'playlists:rename-folder': async (folderId, newName)     => svc.renamePlaylistFolder(folderId, newName),
		'playlists:reorder': async (playlistId, newOrder) => svc.reorderPlaylistTracks(playlistId, newOrder),
		// Pinned searches stay in-process (like the feed channels): tiny,
		// low-frequency reads/writes against main's CoreService instance.
		'pinned:list':   async () => svc.getPinnedSearches(),
		'pinned:create': async (input) => svc.createPinnedSearch(input),
		'pinned:rename': async (id, newName) => svc.renamePinnedSearch(id, newName),
		'pinned:delete': async (id) => svc.deletePinnedSearch(id),
		'playlists:create-local': async (name, trackIds) => svc.createLocalPlaylistFromTracks(name, trackIds),
		'playlists:create-streaming': async (source, name, trackIds) => svc.createStreamingPlaylist(source, name, trackIds),
		'sources:get-sync-settings': async () => svc.getSourceSyncSettings(),
		'sources:set-sync-settings': async (source, settings) => svc.setSourceSyncSettings(source, settings),
		'credits:get-format': async () => svc.getCreditFormat(),
		'credits:set-format': async (fmt) => svc.setCreditFormat(fmt),
		// Convert to WAV writes local files + the library DB — in-process only.
		'wav:get-settings': async () => svc.getWavSettings(),
		'wav:set-settings': async (settings) => svc.setWavSettings(settings),
		'wav:preview': async (playlistId) => svc.previewPlaylistWavConversion(playlistId),
		'wav:convert': async (playlistId) => svc.convertPlaylistToWav(playlistId),
		'wav:cancel': async (runId) => svc.cancelWavConversion(runId),
		// Both need main's adapter + auth (a provider read, then a gated
		// remote write) — never sidecar-routed.
		'playlists:upstream-drift': async (playlistId) => svc.getPlaylistUpstreamDrift(playlistId),
		'playlists:push-local-only': async (playlistId, sourceTrackIds) => svc.pushPlaylistLocalOnly(playlistId, sourceTrackIds),
		'tracks:state-counts': readViaSidecar('tracks:state-counts', async () => svc.getStateCounts()),
		// Feed channels stay in-process (not sidecar-routed): low-frequency
		// reads, and the poll scheduler + promotion writes live on main's
		// CoreService instance.
		'feed:get-page': async (req) => svc.getFeedPage(req),
		'feed:filter-options': async () => svc.getFeedFilterOptions(),
		'feed:archived-page': async (req) => svc.getArchivedFeedPage(req),
		'feed:detail': async (itemId) => svc.getFeedItemDetail(itemId),
		'feed:enrich': async (itemId) => svc.enrichFeedItem(itemId),
		'feed:action': async (action) => svc.feedAction(action),
		'feed:unfollow-playlist': async (playlistId) => svc.unfollowFeedPlaylist(playlistId),
		'feed:unfollow-artist': async (artistId) => svc.unfollowFeedArtist(artistId),
		'feed:refresh': async () => svc.runFeedRefresh(),
		'feed:refresh-producer': async (producerId) => svc.runFeedProducerRefresh(producerId),
		'feed:load-more': async (days) => svc.loadMoreFeed(days),
		'feed:role': async () => svc.getFeedRole(),
		// Journeys + knowledge base — in-process like the feed (user-paced
		// reads; the expansion queue already backgrounds provider crawls).
		'journey:create': async (seed, opts) => svc.createJourney(seed, opts),
		'journey:list': async () => svc.listJourneys(),
		'journey:get': async (journeyId) => svc.getJourney(journeyId),
		'journey:rename': async (journeyId, name) => svc.renameJourney(journeyId, name),
		'journey:delete': async (journeyId) => svc.deleteJourney(journeyId),
		'journey:navigate': async (journeyId, entityId, opts) => svc.journeyNavigate(journeyId, entityId, opts),
		'journey:jump': async (journeyId, nodeId) => svc.journeyJumpTo(journeyId, nodeId),
		'journey:set-view': async (journeyId, nodeId, view) => svc.journeySetNodeView(journeyId, nodeId, view),
		'journey:delete-branch': async (journeyId, nodeId) => svc.journeyDeleteBranch(journeyId, nodeId),
		'kb:entity': async (entityId) => svc.getKbEntity(entityId),
		'kb:expand': async (entityId, aspect, opts) => svc.expandKbEntity(entityId, aspect, opts),
		'kb:search': async (query, kinds) => svc.searchKb(query, kinds),
		'kb:resolve': async (seed) => svc.resolveKbEntity(seed),
		'kb:promote': async (entityId, opts) => svc.promoteKbTrack(entityId, opts),

		// ─── In-app agent ─────────────────────────────────────────────────
		// Key custody stays in main (agent-config.ts + safeStorage): set-config
		// persists + decrypts + forwards into core's configure; the renderer
		// only ever sees the redacted shape.
		'agent:status': async () => svc.agentStatus(),
		'agent:get-config': async () => getRedactedAgentConfig(),
		'agent:set-config': async (input) => {
			const config = saveAgentConfig(input);
			if (config) await svc.configureAgent(config);
			return svc.agentStatus();
		},
		'agent:send': async (req) => svc.agentSend(req),
		'agent:cancel': async (sessionId) => svc.agentCancel(sessionId),
		'agent:list-sessions': async () => svc.listAgentSessions(),
		'agent:get-session': async (sessionId) => svc.getAgentSession(sessionId),
		'agent:new-session': async () => svc.newAgentSession(),
		'agent:delete-session': async (sessionId) => svc.deleteAgentSession(sessionId),
		'agent:get-result-set': async (resultSetId) => svc.getAgentResultSet(resultSetId),
		// MCP bridge write confirmations. Unmatched/late requestIds are ignored
		// (the pending entry already resolved as a timeout deny).
		'mcp:confirm-response': async (requestId, approved, alwaysAllow) => { ctx.mcpConfirm?.resolve(requestId, approved, alwaysAllow); },
		'tracks:source-counts': readViaSidecar('tracks:source-counts', async () => svc.getSourceCounts()),
		'sync:status': async () => svc.getSyncStatus(),

		'auth:status': async () => svc.auth.getStatus(),
		'auth:spotify:start': async () => {
			await runSpotifyAuthFlow(svc.auth);
			// Connecting (or switching) the Spotify account changes who "I" am,
			// flipping the streaming-vs-followed split — reclassify everything.
			svc.recomputeMembership();
			return svc.auth.getStatus();
		},
		'auth:spotify:disconnect': async () => {
			// Through the cloud this drops the account's grant on every device.
			await svc.auth.disconnectSpotify();
			// No account → streaming/followed can't be determined; recompute
			// collapses them to NULL (local survives).
			svc.recomputeMembership();
			return svc.auth.getStatus();
		},
		'auth:tidal:start': async () => {
			await runTidalAuthFlow(svc.auth);
			return svc.auth.getStatus();
		},
		'auth:tidal:disconnect': async () => {
			svc.auth.disconnectTidal();
			await clearTidalSession();
			return svc.auth.getStatus();
		},

		'sync:spotify:run': async (opts) => svc.runSpotifySync(broadcastProgress, opts),
		'sync:spotify:plan': async () => svc.planSpotifySync(),
		'sync:spotify:playlist': async (playlistId, opts) => svc.runSpotifyPlaylistSync(playlistId, broadcastProgress, opts),
		'sync:tidal:run': async (opts) => svc.runTidalSync(broadcastProgress, opts),
		'sync:tidal:playlist': async (playlistId, opts) => svc.runTidalPlaylistSync(playlistId, broadcastProgress, opts),

		'enrich:beatport:playlist': async (playlistId, sort) => svc.enrichBeatportPlaylist(playlistId, broadcastProgress, sort),
		'enrich:beatport:track': async (trackId) => svc.enrichBeatportTrack(trackId, broadcastProgress),
		'enrich:beatport:tracks': async (trackIds) => svc.enrichBeatportTracks(trackIds, broadcastProgress),
		'tidal:match-tracks': async (trackIds) => svc.matchTidalForTracks(trackIds, broadcastProgress),
		'tracks:source-links': async (trackId) => svc.getTrackSourceLinks(trackId),
		'tracks:set-overrides': async (trackId, patch) => svc.setTrackOverrides(trackId, patch),
		'tracks:set-source-links': async (trackId, urls) => svc.setTrackSourceLinks(trackId, urls),
		'tracks:delete-source-link': async (trackId, source) => svc.deleteTrackSourceLink(trackId, source),
		'tracks:merge-preview': async (aId, bId) => svc.previewTrackMerge(aId, bId),
		'tracks:merge': async (keepId, dropId) => svc.mergeTracks(keepId, dropId),
		'tracks:clear-fields': async (trackId, fields) => svc.clearTrackFields(trackId, fields),
		'tracks:field-options': async () => svc.getLibraryFieldOptions(),
		// ─── Artists ────────────────────────────────────────────────────────
		'artists:list': readViaSidecar('artists:list', async (opts) => svc.listArtists(opts)),
		'artists:get': readViaSidecar('artists:get', async (id) => svc.getArtist(id)),
		'artists:resolve': readViaSidecar('artists:resolve', async (name) => svc.resolveArtistByName(name)),
		'artists:links': readViaSidecar('artists:links', async (id) => svc.getArtistLinks(id)),
		'albums:by-ids': readViaSidecar('albums:by-ids', async (ids) => svc.getAlbumsByIds(ids)),
		'artists:merge-suggestions': readViaSidecar('artists:merge-suggestions', async (scope) => svc.listArtistMergeSuggestions(scope)),
		'artists:dismiss-merge': async (aId, bId) => svc.dismissArtistMergeSuggestion(aId, bId),
		'artists:rename': async (id, newName) => svc.renameArtist(id, newName),
		'artists:merge': async (keepId, dropId) => svc.mergeArtists(keepId, dropId),
		'tracks:set-rating': async (trackIds, rating) => svc.setRating(trackIds, rating),
		'tracks:delete': async (trackIds) => svc.deleteTracks(trackIds),
		'tracks:remove-sources': async (trackIds, sources) => svc.removeTrackSources(trackIds, sources),
		'tracks:undelete': async (trackIds) => svc.undeleteTracks(trackIds),
		'tracks:list-deleted': async () => svc.listDeletedTracks(),
		'tracks:purge-deleted': async (trackIds) => svc.purgeDeletedTracks(trackIds),
		'plays:record': async (e) => svc.recordPlay(e),
		'tidal:match-track': async (trackId) => svc.matchTidalForTrack(trackId),
		'tidal:set-playlist-hybrid': async (playlistId, enabled, sort) => svc.setPlaylistHybridTidal(playlistId, enabled, broadcastProgress, sort),
		'enrich:cancel': async () => svc.cancelEnrichment(),

		// Tidal download flow — sniff is required because the official OAuth tier
		// is locked out of /trackFiles + /trackManifests. enable opens the
		// listen.tidal.com BrowserWindow once; status returns whether we have a
		// sniffed bearer; track triggers a single-track download with progress.
		'tidal:download:enable': async () => {
			await runTidalSniffFlow(svc.auth);
			return { connected: true };
		},
		'tidal:download:status': async () => ({ enabled: await svc.hasTidalDownloadSession() }),
		'tidal:download:track': async (trackId) => {
			refuseIf(ctx.profileBlocks?.downloads);
			await ensureFreshTidalSession();
			return svc.downloadTidalTrack(trackId, (p) => {
				sendEvent(ctx.getMainWindow(), 'download:progress', p);
			});
		},
		'tidal:download:enqueue': async (items) => {
			refuseIf(ctx.profileBlocks?.downloads);
			await ensureFreshTidalSession();
			await svc.enqueueTidalDownloads(items);
		},
		'tidal:download:retry': async (trackId) => {
			refuseIf(ctx.profileBlocks?.downloads);
			await ensureFreshTidalSession();
			await svc.retryTidalDownload(trackId);
		},
		'tidal:download:queue': async () => svc.getDownloadQueue(),
		'tidal:download:summary': async () => svc.getDownloadSummary(),
		'tidal:download:clear-completed': async () => svc.clearCompletedDownloads(),
		'tidal:download:clear-all': async () => svc.clearAllDownloads(),
		'tidal:download:redownload': async (trackId) => {
			refuseIf(ctx.profileBlocks?.downloads);
			await ensureFreshTidalSession();
			await svc.redownloadTidalTrack(trackId);
		},
		'tidal:download:verify': async () => svc.verifyDownloads(),
		'tidal:download:open-folder': async () => {
			const dir = await svc.getDownloadDir();
			await shell.openPath(dir).catch((err) => mainLog.for('shell').error('openPath failed', err));
		},

		// Renderer player credentials. Tidal returns the sniff bearer — the
		// INTERNAL-tier token the official web player uses, which is what
		// @tidal-music/player needs to hit the streaming endpoints. (Spotify
		// tokens are fetched main-side by the Spotify sidecar host.)
		'player:tidal:token': async () => {
			const t = svc.auth.getTidalSessionToken();
			if (!t) return null;
			const { config: cfg } = await import('@curator/core');
			return { token: t.token, countryCode: t.countryCode, clientId: cfg.tidal.clientId };
		},
		// Generic JSON-RPC pass-through to the audio sidecar. Method names
		// + param shapes documented in apps/audio/src/protocol.rs. When the
		// sidecar isn't available (disabled or missing binary), reject so
		// the renderer's local backend can surface a clear "audio engine
		// unavailable" state instead of silently hanging.
		'audio:rpc': async (method, params) => {
			if (!ctx.audioSidecar) {
				throw new Error('audio sidecar unavailable');
			}
			return ctx.audioSidecar.request(method, params);
		},

		// Generic JSON-RPC pass-through to the Spotify playback sidecar. Method
		// names + param shapes documented in apps/spotify-player/src/main.ts.
		// Rejects when the sidecar is disabled/missing so the renderer surfaces
		// a clear "Spotify playback unavailable" state.
		'spotify:rpc': async (method, params) => {
			if (!ctx.spotifySidecar) {
				throw new Error('spotify sidecar unavailable');
			}
			return ctx.spotifySidecar.request(method, params);
		},

		'shell:show-in-folder': async (filePath) => {
			// `showItemInFolder` opens the OS file manager with the file
			// highlighted (Explorer / Finder / xdg-open). Resilient to missing
			// files — it logs and silently no-ops.
			if (typeof filePath === 'string' && filePath.length > 0) {
				shell.showItemInFolder(filePath);
			}
		},
		// Only forward http/https and spotify: — the latter deep-links the
		// Spotify desktop app in-context (no playback). Allowlisting these two
		// schemes protects against javascript:/file: URLs sneaking through the
		// renderer surface.
		'shell:open-external': async (url) => {
			if (typeof url === 'string' && /^(https?:\/\/|spotify:)/i.test(url)) {
				await shell.openExternal(url).catch((err) => mainLog.for('shell').error('openExternal failed', err));
			}
		},
		// OS clipboard write. Lives here (not navigator.clipboard) so it doesn't
		// depend on the renderer holding focus / a secure context — the same
		// reason the other shell:* OS actions cross the boundary.
		'shell:copy-text': async (text) => {
			if (typeof text === 'string') clipboard.writeText(text);
		},

		// ─── Tags ───────────────────────────────────────────────────────────
		'tags:list': readViaSidecar('tags:list', async () => svc.getTags()),
		'tags:counts': readViaSidecar('tags:counts', async () => svc.getTagCounts()),
		'tracks:tags': readViaSidecar('tracks:tags', async (trackId) => svc.getTrackTags(trackId)),
		'tracks:tags-batch': readViaSidecar('tracks:tags-batch', async (trackIds) => svc.getTrackTagsBatch(trackIds)),
		'tracks:add-tag': async (trackId, tagId) => svc.addTrackTag(trackId, tagId),
		'tracks:remove-tag': async (trackId, tagId) => svc.removeTrackTag(trackId, tagId),
		'tracks:add-tag-skipping-local': async (trackIds, tagId) => svc.addTrackTagSkippingLocal(trackIds, tagId),
		'tags:create': async (name, color) => svc.createTag(name, color ?? null),
		'organize:recommend': readViaSidecar('organize:recommend', async (trackIds) => svc.recommendForSelection(trackIds)),
		'tracks:playlists-batch': readViaSidecar('tracks:playlists-batch', async (trackIds) => svc.getTrackPlaylistsBatch(trackIds)),
		'playlists:list-with-folders': readViaSidecar('playlists:list-with-folders', async () => svc.getPlaylistsWithFolders()),
		'playlists:add-tracks': async (playlistId, trackIds) => svc.addTracksToPlaylist(playlistId, trackIds),
		'playlists:remove-tracks': async (playlistId, trackIds) => svc.removeTracksFromPlaylist(playlistId, trackIds),
		'playlists:find-tracks-with-deleted-files': async (playlistIds) => svc.findTracksWithDeletedFiles(playlistIds),

		// ─── Local library ──────────────────────────────────────────────────
		'library:list-folders': async () => svc.getLibraryFolders(),
		'library:add-folder': async (path, opts) => svc.addLibraryFolder(path, opts),
		'library:remove-folder': async (folderId) => svc.removeLibraryFolder(folderId),
		'library:prune-deleted-files': async (opts) => svc.pruneDeletedLocalFiles(opts),
		'library:duplicate-audio-groups': async () => svc.getDuplicateAudioGroups(),
		'library:resolve-local-file': async (filePath) => svc.resolveLocalFile(filePath),
		'library:track-local-file': async (trackId) => svc.getLocalFileForTrack(trackId),
		'dialog:pick-folder': async () => {
			const w = ctx.getMainWindow() ?? undefined;
			const res = w
				? await dialog.showOpenDialog(w, { properties: ['openDirectory'] })
				: await dialog.showOpenDialog({ properties: ['openDirectory'] });
			if (res.canceled || res.filePaths.length === 0) return null;
			return normalizePath(res.filePaths[0]!);
		},

		// ─── Window controls ────────────────────────────────────────────────
		// Window is frame:false; the renderer's custom title bar dispatches
		// here for OS-level min/max/close so users can still drive the window
		// without native chrome.
		'window:minimize': async () => {
			const w = ctx.getMainWindow();
			if (w && !w.isDestroyed()) w.minimize();
		},
		'window:toggle-maximize': async () => {
			const w = ctx.getMainWindow();
			if (!w || w.isDestroyed()) return { maximized: false };
			if (w.isMaximized()) {
				w.unmaximize();
				return { maximized: false };
			}
			w.maximize();
			return { maximized: true };
		},
		'window:close': async () => {
			const w = ctx.getMainWindow();
			if (w && !w.isDestroyed()) w.close();
		},
		'window:is-maximized': async () => {
			const w = ctx.getMainWindow();
			return !!(w && !w.isDestroyed() && w.isMaximized());
		},
		'window:focus': async () => {
			const w = ctx.getMainWindow();
			if (!w || w.isDestroyed()) return;
			// win.focus() activates the OS window but does NOT pull keyboard
			// focus back into the page when it's parked in the detached
			// DevTools — webContents.focus() covers that half.
			w.focus();
			w.webContents.focus();
		},

		// ─── Analyzer ───────────────────────────────────────────────────────
		'analysis:enqueue':          async (trackIds, opts) => svc.enqueueAnalysis(trackIds, opts),
		'analysis:cancel':           async (trackId)        => svc.cancelAnalysis(trackId),
		'analysis:job':              async (trackId)        => svc.getAnalysisJob(trackId),
		'analysis:get':              async (trackId)        => svc.getTrackAnalysis(trackId),
		'analysis:fetch-peaks':      async (trackId)        => svc.fetchTrackPeaks(trackId),
		'analysis:cues':             async (trackId)        => svc.getTrackCues(trackId),
		'cue:upsert':                async (input)          => svc.upsertCue(input),
		'cue:update':                async (cueId, patch)   => svc.updateCue(cueId, patch),
		'cue:delete':                async (cueId)          => svc.deleteCue(cueId),
		'analysis:status':           async ()               => svc.getAnalysisStatus(),
		'analysis:set-auto-enqueue': async (settings)       => svc.setAutoAnalyzeSettings(settings),

		// ─── AI audio analysis engine ───────────────────────────────────────
		// In-process (not readViaSidecar): only the main process's core owns
		// the engine sidecar; the core-sidecar copy has stored vectors only.
		'mir:status':       async ()          => svc.mirStatus(),
		'mir:set-settings': async (patch)     => svc.setMirSettings(patch),
		'mir:analyze-now':  async (trackIds)  => svc.mirAnalyzeNow(trackIds),
		'mir:provision':    async ()          => svc.mirProvision(),
		'mir:similar':      async (q)         => svc.getSimilarTracks(q),

		// ─── Backup & restore ───────────────────────────────────────────────
		// In-process: the scheduler + settings live on main's core, the engine
		// in main's utility process.
		'backup:get-settings':    async ()               => svc.getBackupSettings(),
		'backup:set-settings':    async (patch)          => svc.setBackupSettings(patch),
		'backup:status':          async ()               => svc.getBackupStatus(),
		'backup:target-stat':     async ()               => svc.getBackupTargetStat(),
		'backup:list-snapshots':  async (opts)           => svc.listBackupSnapshots(opts),
		'backup:run':             async ()               => svc.runBackupNow(),
		'backup:cancel':          async (runId)          => svc.cancelBackup(runId),
		'backup:pin':             async (id, label)      => svc.pinBackupSnapshot(id, label),
		'backup:delete-snapshot': async (id)             => svc.deleteBackupSnapshot(id),
		'backup:restore-preview': async (id)             => svc.previewBackupRestore(id),
		'backup:restore':         async (req)            => svc.restoreBackup(req),
		'backup:google-connect': async (folderName) => {
			refuseIf(ctx.profileBlocks?.googleBackup);
			await runGoogleConnectFlow();
			const cur = await svc.getBackupSettings();
			const name = folderName?.trim() || (cur.target?.kind === 'googledrive' ? cur.target.folderName : 'Curator Backups');
			await svc.setBackupSettings({ target: { kind: 'googledrive', folderName: name } });
			return svc.getBackupStatus();
		},
		'backup:google-disconnect': async () => {
			disconnectGoogle();
			const cur = await svc.getBackupSettings();
			if (cur.target?.kind === 'googledrive') await svc.setBackupSettings({ target: null, enabled: false });
			return svc.getBackupStatus();
		},
		'backup:relaunch': async () => {
			// before-quit runs the graceful teardown; the staged restore is
			// applied by the next boot before any DB opens.
			app.relaunch();
			app.quit();
		},
		'account:status': async () => accountStatus(),
		// Sign-in itself wakes the sync client (CloudAccount → 'session').
		'account:sign-in-password': async (email, password) => { await requireAccount().signInWithPassword(email, password); return accountStatus(); },
		'account:sign-in-otp-request': async (email) => requireAccount().requestOtp(email),
		'account:sign-in-otp-verify': async (email, code) => { await requireAccount().verifyOtp(email, code); return accountStatus(); },
		// A revoked device's id is dead for good, so signing it out goes
		// through the unlink (fresh id, same sign-out): otherwise the next
		// sign-in would be refused all over again.
		'account:sign-out': async () => {
			const account = requireAccount();
			if ((await svc.getCloudSyncStatus()).revoked) await svc.unlinkCloudLibrary();
			else await account.signOut();
			return accountStatus();
		},
		'account:devices': async () => listAccountDevices(),
		'account:revoke-device': async (deviceId) => {
			if (!ctx.cloudTransport || !ctx.cloudAccount?.cloudSession()) throw new Error('Sign in first.');
			if (deviceId === (await svc.getCloudSyncStatus()).deviceId) throw new Error('This is this computer: use "Unlink this library" instead.');
			await ctx.cloudTransport.account.revokeDevice({ deviceId });
			return listAccountDevices();
		},
		'account:sign-out-others': async () => { await requireAccount().signOutOthers(); return { ok: true as const }; },
		'cloud-sync:status': () => svc.getCloudSyncStatus(),
		'cloud-sync:now': () => svc.cloudSyncNow(),
		'cloud-sync:unlink': () => svc.unlinkCloudLibrary(),
		'cloud-sync:get-poll-settings': () => svc.getCloudSyncPollSettings(),
		'cloud-sync:set-poll-policy': (patch) => svc.setCloudSyncPollPolicy(patch),
		'account:library-info': () => svc.getAccountLibraryInfo(),
		'account:set-master-device': (deviceId) => svc.setMasterDevice(deviceId),
		'catalogue:status': () => svc.getCatalogueStatus(),
		'catalogue:set-settings': (patch) => svc.setCatalogueSettings(patch),
		'catalogue:backfill': (action) => svc.setCatalogueBackfill(action),
		'backup:take-pending-renderer-settings': async () => {
			const p = join(app.getPath('userData'), PENDING_RENDERER_SETTINGS_FILE);
			if (!existsSync(p)) return null;
			try {
				return JSON.parse(await readFile(p, 'utf8')) as Record<string, string>;
			} catch {
				return null;
			} finally {
				await rm(p, { force: true });
			}
		},

		// ─── Rekordbox ──────────────────────────────────────────────────────
		'rekordbox:detect': async ()     => svc.detectRekordbox(),
		'rekordbox:read':   async (args) => svc.runRekordboxImport(args),
		'rekordbox:cancel': async ()     => svc.cancelRekordboxImport(),
		'rekordbox:tree':   async ()     => svc.getRekordboxTree(),
		// ─── Sync from rekordbox (scoped pull) ─────────────────────────────
		'rekordbox:sync-from':              async (args) => svc.syncFromRekordbox(args),
		'rekordbox:resolve-pull-conflicts': async (args) => svc.resolveRekordboxPullConflicts(args),
		// ─── Rekordbox write-side ──────────────────────────────────────────
		'rekordbox:sync':           async (args)                       => svc.syncToRekordbox(args),
		'rekordbox:create-preview': async (playlistId)                 => svc.previewRekordboxCreate(playlistId),
		'rekordbox:create-preview-tracks': async (trackIds)            => svc.previewRekordboxCreateTracks(trackIds),
		'rekordbox:missing-files':  async ()                            => svc.findRekordboxMissingFiles(),
		'rekordbox:remove-missing-files': async (trackIds)             => svc.removeRekordboxMissingFiles(trackIds),
		'sync:resolve-conflicts':   async (args)                       => svc.resolveSyncConflicts(args),
		'rekordbox:list-backups':   async (dbPathOverride)             => svc.listRekordboxBackups(dbPathOverride),
		'rekordbox:clear-backups':  async (dbPathOverride)             => svc.clearRekordboxBackups(dbPathOverride),
		'rekordbox:restore-backup': async (backupPath, dbPathOverride) => svc.restoreRekordboxBackup(backupPath, dbPathOverride),
		'rekordbox:cue-palette':    async ()                            => svc.listCuePalette(),
	};
}
