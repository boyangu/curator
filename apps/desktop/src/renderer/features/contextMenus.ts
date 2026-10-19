// Context-menus feature — the right-click surfaces for the SRC column
// header, sidebar playlists, rekordbox folders, and downloads rows, plus the
// remove-deleted-files flow these menus trigger. The track-row menus (single +
// multi-select) moved to features/trackCommands.ts, which derives them from a
// declarative command table; this module keeps the surfaces that aren't track
// selections. The menus orchestrate navigation / selection / modal flows that
// still live in main.ts — those arrive via the deps interface wired in boot();
// this module never imports main.ts. IPC goes through the data/api.ts facades,
// never the raw preload bridge (boundary-checked at build time).

import type { Track, Playlist, PlaylistFolder, PinnedSearch, ZTrackFilterT } from '@curator/shared';
import type { RemovableTrackSource } from '@curator/core';
import type { TrackListHandle } from '../track-list.js';
import type { AnalyzeModalHandle } from '../layouts/AnalyzeModal.jsx';
import type { ConfirmDialogOptions } from '../layouts/ConfirmDialog.jsx';
import type { SyncTarget } from '../layouts/SyncToRekordboxModal.jsx';
import type { PullTarget } from '../layouts/SyncFromRekordboxModal.jsx';
import type { JitPlaylist } from '../viewmodel/shell.js';
import { openContextMenu, type ContextMenuItem } from '../components/ContextMenu.jsx';
import { shell } from '../viewmodel/shell.js';
import { library } from '../data/library.js';
import { tracksData } from '../data/tracks.js';
import { downloads } from '../data/downloads.js';
import { tracksApi, playlistsApi, syncApi, enrichApi, tidalApi, shellApi, downloadsApi, wavApi } from '../data/api.js';
import { showToast } from '../ui/toast.js';
import { log } from '../data/log.js';

// Well-known system tag ids now live with the curate commands that consume
// them (features/trackCommands.ts); re-exported here for the callers that still
// import them from this module.
export { SYSTEM_TAG_INTERESTED, SYSTEM_TAG_BASKET } from './trackCommands.js';

// Shared "Analyze…" menu icon — a centred equalizer/waveform glyph. Reused
// by the playlist, rb-folder, and library-folder context menus.
const WAV_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2 12h2l2-5 3 10 3-14 3 14 3-10 2 5h2"/></svg>';
const ANALYZE_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 13v-2M8 17V7M12 21V3M16 16V8M20 13v-2"/></svg>';

// Open the Analyze modal pre-loaded with every analyzable track in a scope
// (a playlist, an rb folder's descendant playlists, or a library folder).
// Analysis runs on local audio files, so we keep only tracks carrying a
// `local` source — streaming-only rows can't be analyzed and would inflate
// the count the modal shows. An empty scope toasts instead of opening an
// empty modal.
export async function openAnalyzeForScope(filter: ZTrackFilterT, scopeName: string): Promise<void> {
	const modal = deps.getAnalyzeModal();
	if (!modal) return;
	let tracks: Track[];
	try {
		tracks = await tracksApi.list(filter);
	} catch (err) {
		showToast('Could not load tracks to analyze', {
			sub: err instanceof Error ? err.message : String(err),
			kind: 'error',
			durationMs: 5000,
		});
		return;
	}
	const ids = tracks.filter((t) => (t.sources ?? []).includes('local')).map((t) => t.id);
	if (ids.length === 0) {
		showToast('Nothing to analyze', { sub: `${scopeName} — no local files`, kind: 'info' });
		return;
	}
	modal.open(ids);
}

// Sort payload shape shared by the sorted enrichment runs
// (enrich:beatport:playlist / tidal:set-playlist-hybrid).
type TrackSort = NonNullable<Parameters<typeof enrichApi.beatportPlaylist>[1]>;

export interface ContextMenusFeatureDeps {
	// ── main.ts view state (the `state` object) ──────────────────────────
	// Source-pip column filter driven by the SRC header menu.
	getTracksFilter(): 'all' | 'unmatched-tidal' | 'unmatched-beatport' | 'with-local';
	setTracksFilter(filter: 'all' | 'unmatched-tidal' | 'unmatched-beatport' | 'with-local'): void;
	// Current visible sort — passed to the sorted enrichment runs so the
	// indicator moves down the list in the order the user is seeing.
	getSort(): TrackSort;
	// In-flight per-playlist enrichment session (the `enriching` signal).
	// setEnriching writes a reactive signal, so the sidebar repaints itself —
	// no manual sidebar bump needed at the callsites.
	setEnriching(e: { playlistId: string; source: 'beatport' | 'tidal' | 'wav' }): void;
	clearEnrichment(): void;
	// ── rendering / data plumbing still owned by main.ts ─────────────────
	renderTracks(): Promise<void>;
	refreshAll(): Promise<void>;
	refreshTagCounts(): Promise<void>;
	refreshPlaylistsForSyncView(): Promise<void>;
	applyFilterToMainList(): void;
	// Pre-filter cache (main.ts `mainTracksUnfiltered`) — the delete /
	// remove-deleted-files flows splice rows out of it in place.
	getMainTracksUnfiltered(): Track[];
	setMainTracksUnfiltered(tracks: Track[]): void;
	currentPlaylistPositionBase(): number;
	compactCurrentPlaylistPositions(base: number): void;
	// ── selection (single source of truth: the TrackListView handle) ─────
	getSelectedTrackIds(): Set<string>;
	getSelectionAnchor(): string | null;
	setTrackSelection(ids: readonly string[], anchor: string | null): void;
	// ── handles mounted by boot() ─────────────────────────────────────────
	getMainTrackList(): TrackListHandle | null;
	getAnalyzeModal(): AnalyzeModalHandle | null;
	// ── flows that still live in main.ts ──────────────────────────────────
	openSyncToRekordboxModal(target: SyncTarget): Promise<void>;
	openSyncFromRekordboxModal(target: PullTarget): Promise<void>;
	openRatingDialogForTracks(trackIds: string[]): void;
	// Remove from one playlist via the shared commitPlaylistChanges path
	// (IPC, upstream-outcome toast, membership snapshot, visible-list splice +
	// compact, 10 s Undo). Resolves false when nothing was removed / it failed.
	removeTracksFromPlaylist(playlistId: string, trackIds: string[]): Promise<boolean>;
	// The per-source Delete dialog. Resolves with the checked sources, or
	// null on Cancel / Escape / backdrop.
	openDeleteTracksDialog(tracks: Track[]): Promise<RemovableTrackSource[] | null>;
	// The generic Curator confirm modal. Resolves true on the confirm button,
	// false on Cancel / Escape / backdrop.
	confirm(opts: Omit<ConfirmDialogOptions, 'onConfirm' | 'onCancel'>): Promise<boolean>;
	// Convert to WAV status dialog (layouts/WavConvertDialog.tsx, owned by
	// main.ts). `begin` shows it the moment the user confirms; reopenIfActive
	// re-shows a run in progress and returns whether there was one.
	wavConvert: {
		begin(playlistId: string, sourceName: string): void;
		// The run never started (core rejected) — show why in the dialog.
		fail(playlistId: string, message: string): void;
		reopenIfActive(): boolean;
	};
	// Unified Organize modal (tags + playlists). Opened by the single
	// "Organize…" track command and the O keyboard shortcut.
	openOrganize(trackIds: string[]): void;
	openDownloadsView(): void;
	openPlaylistById(id: string): Promise<void>;
	// "Start Journey" — flip Discover into Journeys mode seeded from a
	// library track (see startJourneyFromSeed in main.ts).
	startJourneyFromTrack(trackId: string): void;
	enterJitScope(jit: JitPlaylist, selectTrackId?: string): Promise<void>;
	cssEscape(s: string): string;
	// ── pinned searches (the "Pinned" nav folder) ────────────────────────
	getPinnedSearches(): PinnedSearch[];
	// "Unpin" — delete the saved search.
	unpinSearch(id: string): void;
	// "Create Playlist…" — materialize the pinned search's tracks (in its
	// stored order) into a new, editable local playlist.
	createPlaylistFromPinned(id: string): void;
	// "Rename…" — opens the shared name modal ("Rename" / OK) for a playlist,
	// rekordbox folder, or pinned search and dispatches to the right backend.
	openRenameDialog(target: { kind: 'playlist' | 'folder' | 'pinned'; id: string; name: string }): void;
}

let deps: ContextMenusFeatureDeps;

export function initContextMenusFeature(d: ContextMenusFeatureDeps): void {
	deps = d;
}

// SRC column header context menu — filter to unmatched-tidal /
// unmatched-beatport / with-local / show-all. The Tidal item only appears
// when the active playlist is in hybrid-tidal mode; Beatport always appears
// since enrichment is available on any track that has a source link.
export function showSrcHeaderContextMenu(evt: MouseEvent): void {
	const srcMenuPid = shell.currentPlaylistId();
	const playlist = srcMenuPid ? library.getPlaylist(srcMenuPid) : null;
	const showTidal = !!playlist?.hybridTidal;
	// "Synced with Beatport" isn't a flag we store — treat presence of any
	// beatport source-link in the current view as the indicator. If you've
	// never enriched anything here, the option doesn't apply.
	const showBeatport = tracksData.all().some((t) => (t.sources ?? []).includes('beatport'));
	const checkIcon = (cond: boolean) => `<span class="ctx-menu__check">${cond ? '✓' : ''}</span>`;

	const items: ContextMenuItem[] = [];
	if (showTidal) {
		items.push({ kind: 'item', id: 'unmatched-tidal', label: 'Show Unmatched Tidal', iconHtml: checkIcon(deps.getTracksFilter() === 'unmatched-tidal') });
	}
	if (showBeatport) {
		items.push({ kind: 'item', id: 'unmatched-beatport', label: 'Show Unmatched Beatport', iconHtml: checkIcon(deps.getTracksFilter() === 'unmatched-beatport') });
	}
	items.push({ kind: 'item', id: 'with-local', label: 'Show Local Files', iconHtml: checkIcon(deps.getTracksFilter() === 'with-local') });
	items.push({ kind: 'divider' });
	items.push({ kind: 'item', id: 'all', label: 'Show All', iconHtml: checkIcon(deps.getTracksFilter() === 'all') });

	openContextMenu(items, {
		'unmatched-tidal':    () => { deps.setTracksFilter('unmatched-tidal'); void deps.renderTracks(); },
		'unmatched-beatport': () => { deps.setTracksFilter('unmatched-beatport'); void deps.renderTracks(); },
		'with-local':         () => { deps.setTracksFilter('with-local'); void deps.renderTracks(); },
		'all':                () => { deps.setTracksFilter('all'); void deps.renderTracks(); },
	}, { at: evt });
}

// ─── Context menus ───────────────────────────────────────────────────────

// openContextMenu retired — see components/ContextMenu.tsx. Callers pass a
// typed ContextMenuItem[] instead of an innerHTML string.

// Per-playlist "Sync from Spotify/Tidal" (+ the "re-sync (force)" variant).
// Always toasts — without feedback a snapshot-unchanged skip is indistinguishable
// from a dead button (the reason this looked broken). `force` bypasses the
// provider snapshot short-circuit so an already-synced playlist re-fetches.
async function runPlaylistSync(
	isTidal: boolean,
	playlistId: string,
	name: string,
	opts: { force?: boolean } = {},
): Promise<void> {
	const provider = isTidal ? 'Tidal' : 'Spotify';
	showToast(opts.force ? `Re-syncing from ${provider}…` : `Syncing from ${provider}…`, {
		sub: name, kind: 'info', durationMs: 1800,
	});
	try {
		const res = isTidal
			? await syncApi.tidalPlaylist(playlistId, opts)
			: await syncApi.spotifyPlaylist(playlistId, opts);
		if (res.skipped) {
			showToast('Already up to date', { sub: name, kind: 'info' });
		} else {
			const n = res.tracksUpserted;
			showToast(`${provider} sync complete`, {
				sub: `${n} track${n === 1 ? '' : 's'} updated · ${name}`,
				kind: 'success',
			});
		}
	} catch (err) {
		showToast(`${provider} sync failed`, {
			sub: err instanceof Error ? err.message : String(err),
			kind: 'error',
			durationMs: 5000,
		});
	}
}

export function showPlaylistContextMenu(evt: MouseEvent, playlistId: string): void {
	// Streaming playlists live in state.playlistsById; rb playlists live in
	// library.rekordboxTree().playlists (separate cache populated by the rb tree
	// IPC). The lookup needs both because rb playlists in the sidebar route
	// through this same callback.
	const playlist = library.getPlaylist(playlistId)
		?? library.rekordboxTree().playlists.find((p) => p.id === playlistId);
	const name = playlist?.name ?? 'playlist';
	const isRb = playlist?.source === 'rekordbox';
	const isStreaming = playlist?.source === 'spotify' || playlist?.source === 'tidal';
	const hybridOn = !!playlist?.hybridTidal;

	const isTidal = playlist?.source === 'tidal';
	// Same ownership test as the sidebar drop handler: connected account id
	// must match ownerId (collaborative playlists count as writable too).
	const meId = isTidal ? library.auth()?.tidal.id : library.auth()?.spotify.id;
	const ownedByMe = isStreaming && !playlist?.isSmart
		&& (playlist?.isCollaborative === true || (!!meId && playlist?.ownerId === meId));

	const items: ContextMenuItem[] = [{ kind: 'header', label: name }];
	// Streaming-only items — provider sync / Beatport batch / hybrid-Tidal apply
	// only to streaming-source playlists. Rekordbox + local playlists skip them
	// (rb has its own sync-to-rb model; local playlists are Curator-only).
	if (isStreaming) {
		items.push(
			{
				kind: 'item',
				id: 'sync',
				label: isTidal ? 'Sync from Tidal' : 'Sync from Spotify',
				iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-3.4-7"/><path d="M21 4v5h-5"/></svg>',
			},
			{
				kind: 'item',
				id: 'enrich-beatport',
				label: 'Enrich Key, BPM, Genre & Label',
				iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" opacity="0.15"/><circle cx="12" cy="12" r="3"/></svg>',
			},
		);
		// Hybrid-Tidal matches SPOTIFY playlist members to Tidal ids — on a
		// Tidal-source playlist every member already has one.
		if (!isTidal) {
			items.push({
				kind: 'item',
				id: 'toggle-tidal',
				label: 'Sync with Tidal',
				iconHtml: `<span class="ctx-menu__check">${hybridOn ? '✓' : ''}</span>`,
			});
		}
		items.push(
			{ kind: 'divider' },
			{ kind: 'item', id: 'reset', label: 'Force re-sync (ignore snapshot)' },
		);
		// Replay adds that never reached the provider (made while write-sync
		// was off, or whose push failed). Owned playlists only — the provider
		// 403s writes to followed ones, and core enforces the same boundary.
		if (ownedByMe) {
			items.push({ kind: 'item', id: 'push-local-only', label: `Push local-only tracks to ${isTidal ? 'Tidal' : 'Spotify'}…` });
		}
	}
	// Sync to Rekordbox — rb-sourced playlists (rb-side identity already
	// exists), plus a Convert-to-WAV "[WAV]" playlist that's still local: its
	// sync CREATES the playlist and its WAV tracks in rekordbox (see core
	// rekordbox/create-phase.ts). Other cross-source pushes (Spotify → new rb
	// playlist) stay out of scope.
	const isDerivedLocal = playlist?.source === 'local' && !!playlist?.derivedFromPlaylistId;
	if (isDerivedLocal) {
		items.push({
			kind: 'item',
			id: 'sync-to-rekordbox',
			label: 'Sync to Rekordbox…',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m9 17 3 3 3-3"/><path d="M12 4v16"/><rect x="4" y="3" width="16" height="4" rx="1"/></svg>',
		});
	}
	if (isRb) {
		items.push({
			kind: 'item',
			id: 'sync-from-rekordbox',
			label: 'Sync from Rekordbox…',
			// Arrow pointing UP out of the disc — the pull-direction mirror of
			// the sync-to (down-arrow) glyph.
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m9 7 3-3 3 3"/><path d="M12 4v16"/><rect x="4" y="17" width="16" height="4" rx="1"/></svg>',
		});
		items.push({
			kind: 'item',
			id: 'sync-to-rekordbox',
			label: 'Sync to Rekordbox…',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m9 17 3 3 3-3"/><path d="M12 4v16"/><rect x="4" y="3" width="16" height="4" rx="1"/></svg>',
		});
		// Smart playlists derive membership from criteria — playlist_track
		// is empty for them, so "remove" is a no-op. Hide the item rather
		// than expose a dead row.
		if (!playlist?.isSmart) {
			items.push({ kind: 'divider' });
			items.push({
				kind: 'item',
				id: 'remove-deleted-files',
				label: 'Remove deleted files…',
				iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="m10 11 4 4m0-4-4 4"/></svg>',
				danger: true,
			});
		}
	}
	// Analyze — available on any playlist (rb + streaming). The scope helper
	// keeps only tracks with local files, so a streaming playlist with few
	// matched files still works (and toasts if none qualify).
	items.push({ kind: 'divider' });
	items.push({ kind: 'item', id: 'analyze', label: 'Analyze…', iconHtml: ANALYZE_ICON });
	// Convert to WAV — lossless WAV copies for decks that can't play FLAC.
	// Not offered on a "[WAV]" playlist itself (its members already are the
	// copies) or on smart playlists (no stored track list).
	if (playlist && !playlist.isSmart && !playlist.derivedFromPlaylistId) {
		items.push({ kind: 'item', id: 'convert-wav', label: 'Convert to WAV…', iconHtml: WAV_ICON });
	}
	// Rename — every playlist source. Spotify/Tidal push to the provider
	// immediately (inside renamePlaylist); Rekordbox renames locally and pushes
	// on the next Sync to Rekordbox; local playlists are Curator-only.
	const canRename = !!playlist;
	if (canRename) {
		items.push({ kind: 'divider' });
		items.push({
			kind: 'item',
			id: 'rename',
			label: 'Rename…',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="m14 6 4 4"/></svg>',
		});
	}
	openContextMenu(items, {
		sync: async () => {
			await runPlaylistSync(isTidal, playlistId, name);
			await deps.refreshAll();
		},
		'sync-to-rekordbox': () => {
			void deps.openSyncToRekordboxModal({ kind: 'playlist', ids: [playlistId], displayName: name });
		},
		'sync-from-rekordbox': () => {
			void deps.openSyncFromRekordboxModal({ kind: 'playlist', ids: [playlistId], displayName: name });
		},
		rename: () => {
			deps.openRenameDialog({ kind: 'playlist', id: playlistId, name });
		},
		'enrich-beatport': () => {
			deps.setEnriching({ playlistId, source: 'beatport' });
			// Pass the user's current visible sort so the indicator moves down
			// the list in the same order they're seeing.
			enrichApi.beatportPlaylist(playlistId, deps.getSort())
				.catch((err) => log.for('context-menu').error('beatport enrichment failed', err))
				.finally(() => deps.clearEnrichment());
		},
		'toggle-tidal': async () => {
			// Toggle persists the hybridTidal flag and, when enabling, runs the
			// matcher across all unlinked tracks in the playlist. Progress shows
			// in the inline indicator next to the playlist title.
			if (!hybridOn) {
				deps.setEnriching({ playlistId, source: 'tidal' });
			}
			try {
				const res = await tidalApi.setPlaylistHybrid(playlistId, !hybridOn, deps.getSort());
				if (res.enabled) {
					if (res.scanned > 0) {
						showToast(`Tidal match: ${res.matched} / ${res.scanned}`, {
							sub: name,
							kind: res.matched > 0 ? 'success' : 'error',
						});
					} else {
						showToast('Sync with Tidal enabled', { sub: 'No unlinked tracks to match', kind: 'info' });
					}
				} else {
					showToast('Sync with Tidal disabled', { sub: name, kind: 'info' });
				}
				await deps.refreshAll();
			} catch (err) {
				showToast('Tidal sync failed', {
					sub: err instanceof Error ? err.message : String(err),
					kind: 'error',
					durationMs: 5000,
				});
			} finally {
				deps.clearEnrichment();
			}
		},
		reset: async () => {
			await runPlaylistSync(isTidal, playlistId, name, { force: true });
			await deps.refreshAll();
		},
		'push-local-only': () => {
			void pushLocalOnlyToProvider(playlistId, name, isTidal ? 'Tidal' : 'Spotify');
		},
		'remove-deleted-files': () => {
			void removeDeletedFilesFromPlaylists([playlistId], name);
		},
		analyze: () => {
			void openAnalyzeForScope({ playlistId }, name);
		},
		'convert-wav': () => {
			void convertPlaylistToWav(playlistId);
		},
	}, { at: evt });
}

// Right-click on a rb-folder row in the sidebar. v1 surface: a single
// "Sync to Rekordbox…" item that opens the same modal as a playlist
// sync, scoped to the folder. The exporter walks descendants and emits
// one playlist WriteOp per non-smart non-hidden child, all under a
// single backup + verify pass.
export function showRekordboxFolderContextMenu(evt: MouseEvent, folderId: string): void {
	const folder = library.rekordboxTree().folders.find((f) => f.id === folderId);
	const name = folder?.name ?? 'folder';
	const items: ContextMenuItem[] = [
		{ kind: 'header', label: name },
		{
			kind: 'item',
			id: 'sync-from-rekordbox',
			label: 'Sync from Rekordbox…',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m9 7 3-3 3 3"/><path d="M12 4v16"/><rect x="4" y="17" width="16" height="4" rx="1"/></svg>',
		},
		{
			kind: 'item',
			id: 'sync-to-rekordbox',
			label: 'Sync to Rekordbox…',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m9 17 3 3 3-3"/><path d="M12 4v16"/><rect x="4" y="3" width="16" height="4" rx="1"/></svg>',
		},
		{ kind: 'divider' },
		{
			kind: 'item',
			id: 'remove-deleted-files',
			label: 'Remove deleted files…',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="m10 11 4 4m0-4-4 4"/></svg>',
			danger: true,
		},
		{ kind: 'divider' },
		{ kind: 'item', id: 'analyze', label: 'Analyze…', iconHtml: ANALYZE_ICON },
		{ kind: 'divider' },
		{
			kind: 'item',
			id: 'rename',
			label: 'Rename…',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="m14 6 4 4"/></svg>',
		},
	];
	openContextMenu(items, {
		'sync-to-rekordbox': () => {
			void deps.openSyncToRekordboxModal({ kind: 'folder', ids: [folderId], displayName: name });
		},
		'sync-from-rekordbox': () => {
			void deps.openSyncFromRekordboxModal({ kind: 'folder', ids: [folderId], displayName: name });
		},
		'remove-deleted-files': () => {
			const ids = collectRbFolderDescendantPlaylistIds(folderId);
			void removeDeletedFilesFromPlaylists(ids, name);
		},
		analyze: () => {
			const pids = collectRbFolderDescendantPlaylistIds(folderId);
			if (pids.length === 0) {
				showToast('Nothing to analyze', { sub: `${name} — no playlists`, kind: 'info' });
				return;
			}
			void openAnalyzeForScope({ playlistIds: pids }, name);
		},
		rename: () => {
			deps.openRenameDialog({ kind: 'folder', id: folderId, name });
		},
	}, { at: evt });
}

// Pinned-search row menu: materialize into a real playlist, or unpin. A pinned
// search owns no track membership (it re-runs a query), so there's no add /
// remove / reorder here — "Create Playlist…" is the bridge to an editable copy.
const PLAYLIST_ADD_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h12M3 12h8M3 18h8"/><path d="M17 13v8M21 17h-8"/></svg>';
const UNPIN_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M9 4h6l-1 5 2.5 2.5"/><path d="M7.5 12.5L6 14h7"/><path d="M12 17v4"/></svg>';

export function showPinnedSearchContextMenu(evt: MouseEvent, id: string): void {
	const pinned = deps.getPinnedSearches().find((p) => p.id === id);
	const name = pinned?.name ?? 'search';
	const items: ContextMenuItem[] = [
		{ kind: 'header', label: name },
		{
			kind: 'item',
			id: 'rename',
			label: 'Rename…',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="m14 6 4 4"/></svg>',
		},
		{ kind: 'item', id: 'create-playlist', label: 'Create Playlist…', iconHtml: PLAYLIST_ADD_ICON },
		{ kind: 'divider' },
		{ kind: 'item', id: 'unpin', label: 'Unpin', iconHtml: UNPIN_ICON, danger: true },
	];
	openContextMenu(items, {
		rename: () => deps.openRenameDialog({ kind: 'pinned', id, name }),
		'create-playlist': () => deps.createPlaylistFromPinned(id),
		unpin: () => deps.unpinSearch(id),
	}, { at: evt });
}

// Walk an rb folder's subtree and collect every non-smart playlist id under
// it (any depth). Smart playlists are skipped because (a) Curator doesn't
// populate playlist_track for them and (b) removeTracksFromPlaylist would
// reject the write. The walk reads the flat folder + playlist arrays from
// library.rekordboxTree() — same source the sidebar uses.
function collectRbFolderDescendantPlaylistIds(folderId: string): string[] {
	const { folders, playlists } = library.rekordboxTree();
	const playlistsByParent = new Map<string | null, Playlist[]>();
	for (const p of playlists) {
		const k = p.parentFolderId ?? null;
		const arr = playlistsByParent.get(k);
		if (arr) arr.push(p); else playlistsByParent.set(k, [p]);
	}
	const foldersByParent = new Map<string | null, PlaylistFolder[]>();
	for (const f of folders) {
		const k = f.parentFolderId ?? null;
		const arr = foldersByParent.get(k);
		if (arr) arr.push(f); else foldersByParent.set(k, [f]);
	}
	const out: string[] = [];
	const walk = (id: string): void => {
		for (const p of playlistsByParent.get(id) ?? []) {
			if (!p.isSmart) out.push(p.id);
		}
		for (const f of foldersByParent.get(id) ?? []) walk(f.id);
	};
	walk(folderId);
	return out;
}

// Diff a streaming playlist against the provider, show what would be sent,
// and push on confirmation. The diff is a provider read; the push is a live
// account write, so it never runs without the confirm.
async function pushLocalOnlyToProvider(playlistId: string, name: string, provider: 'Spotify' | 'Tidal'): Promise<void> {
	let drift;
	try {
		drift = await playlistsApi.upstreamDrift(playlistId);
	} catch (err) {
		showToast(`Couldn't compare with ${provider}`, { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
		return;
	}
	if (drift.localOnly.length === 0) {
		showToast(`“${name}” is in sync with ${provider}`, { sub: `${drift.localCount} tracks here, ${drift.remoteCount} there`, kind: 'info', durationMs: 3000 });
		return;
	}
	const sample = drift.localOnly.slice(0, 8).map((r) => `• ${r.artists ? r.artists + ' – ' : ''}${r.title}`).join('\n');
	const more = drift.localOnly.length > 8 ? `\n…and ${drift.localOnly.length - 8} more` : '';
	const msg = `Push ${drift.localOnly.length} track${drift.localOnly.length === 1 ? '' : 's'} to “${name}” on ${provider}?\n\nThese are in Curator but not on ${provider}:\n${sample}${more}\n\nThis modifies your live ${provider} playlist.`;
	if (!window.confirm(msg)) return;
	try {
		const res = await playlistsApi.pushLocalOnly(playlistId);
		showToast(`Pushed ${res.pushed} to “${name}”`, { sub: `Now on ${provider}`, kind: 'success', durationMs: 4000 });
		await deps.refreshAll();
	} catch (err) {
		showToast(`${provider} push failed`, { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 6000 });
	}
}

// Find tracks-with-deleted-files across `playlistIds`, confirm with the user,
// then remove. Skips silently with a toast if nothing's affected. The
// confirmation message names the scope (single playlist vs folder); display
// name is passed in so we don't second-guess the caller's labelling. After
// the removes land, patches the visible track list (when the current
// playlist/folder is touched) and refreshes playlist metadata so the
// sidebar's per-playlist trackCount badges match.
function fmtBytes(n: number): string {
	return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
}

// Convert to WAV: preview → confirm → start the background run, with the
// status dialog up from the moment of confirm. Progress and the result come
// off the wav:convert-event stream (main.ts wireWavConvertEvents).
async function convertPlaylistToWav(playlistId: string): Promise<void> {
	const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
	// One run at a time (core enforces it too) — show the one in progress.
	if (deps.wavConvert.reopenIfActive()) return;
	let preview: Awaited<ReturnType<typeof wavApi.preview>>;
	try {
		preview = await wavApi.preview(playlistId);
	} catch (err) {
		showToast('Convert to WAV unavailable', { sub: errText(err), kind: 'error', durationMs: 6000 });
		return;
	}
	if (!preview.available) {
		showToast('Convert to WAV unavailable', { sub: 'The audio engine binary is missing from this build.', kind: 'error', durationMs: 6000 });
		return;
	}
	if (preview.convert + preview.reuse + preview.kept === 0) {
		showToast('Nothing to convert', { sub: `No track in "${preview.playlistName}" has a local file`, kind: 'info' });
		return;
	}
	// A conversion that fills the disk takes the library DB and the OS down
	// with it — refuse up front rather than fail halfway.
	if (preview.freeBytes != null && preview.convert > 0 && preview.estimatedBytes > preview.freeBytes) {
		showToast('Not enough disk space', {
			sub: `~${fmtBytes(preview.estimatedBytes)} needed, ${fmtBytes(preview.freeBytes)} free on the drive holding ${preview.outputDir}. Pick another folder in Settings → Library.`,
			kind: 'error',
			durationMs: 9000,
		});
		return;
	}
	const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
	const target = `"${preview.targetPlaylistName}"`;
	const lines: string[] = [];
	if (preview.convert > 0) lines.push(`~${fmtBytes(preview.estimatedBytes)} of WAV${preview.freeBytes != null ? ` (${fmtBytes(preview.freeBytes)} free)` : ''}`);
	if (preview.reuse > 0) lines.push(`${plural(preview.reuse, 'track')} already converted — reused`);
	if (preview.kept > 0) lines.push(`${plural(preview.kept, 'track')} already deck-playable (WAV/AIFF/MP3/AAC) — added as-is`);
	if (preview.resample > 0) lines.push(`${plural(preview.resample, 'track')} above 48 kHz — resampled for older decks`);
	if (preview.skipped > 0) {
		const names = preview.skippedTitles.slice(0, 3).join(', ');
		lines.push(`${plural(preview.skipped, 'track')} skipped — no local file${names ? ` (${names}${preview.skipped > 3 ? ', …' : ''})` : ''}`);
	}
	const ok = await deps.confirm({
		title: 'Convert to WAV',
		message: preview.convert > 0
			? `Convert ${plural(preview.convert, 'FLAC track')} to WAV in ${preview.outputDir}, then ${preview.targetPlaylistExists ? 'update' : 'create'} ${target}.`
			: `Nothing new to convert — ${preview.targetPlaylistExists ? 'update' : 'create'} ${target} from existing files.`,
		note: lines.join('\n'),
		confirmLabel: 'Convert',
	});
	if (!ok) return;
	deps.wavConvert.begin(playlistId, preview.playlistName);
	try {
		await wavApi.convert(playlistId);
	} catch (err) {
		deps.wavConvert.fail(playlistId, errText(err));
	}
}

async function removeDeletedFilesFromPlaylists(playlistIds: string[], displayName: string): Promise<void> {
	if (playlistIds.length === 0) {
		showToast('Nothing to scan', { sub: `"${displayName}" has no playlists`, kind: 'info' });
		return;
	}
	let result: { playlistId: string; trackIds: string[] }[];
	try {
		result = await playlistsApi.findTracksWithDeletedFiles(playlistIds);
	} catch (err) {
		showToast('Scan failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
		return;
	}
	const touched = result.filter((r) => r.trackIds.length > 0);
	const totalRemovals = touched.reduce((n, r) => n + r.trackIds.length, 0);
	if (totalRemovals === 0) {
		showToast('No deleted files found', { sub: displayName, kind: 'info' });
		return;
	}
	const isFolder = playlistIds.length > 1;
	const msg = isFolder
		? `Remove ${totalRemovals} track${totalRemovals === 1 ? '' : 's'} with deleted files from ${touched.length} playlist${touched.length === 1 ? '' : 's'} in "${displayName}"?\n\nThe tracks themselves stay in your library.`
		: `Remove ${totalRemovals} track${totalRemovals === 1 ? '' : 's'} with deleted files from "${displayName}"?\n\nThe tracks themselves stay in your library.`;
	if (!window.confirm(msg)) return;

	let removedTotal = 0;
	const errors: string[] = [];
	// One IPC per playlist — keeps each remove atomic at the service layer
	// and matches how commitPlaylistChanges issues per-playlist writes.
	for (const r of touched) {
		try {
			const res = await playlistsApi.removeTracks(r.playlistId, r.trackIds);
			removedTotal += res.removed;
		} catch (err) {
			errors.push(err instanceof Error ? err.message : String(err));
		}
	}

	// Patch the current view if the user's looking at a touched playlist.
	// Folder view aggregates descendant playlists — the simplest correct
	// path there is a single renderTracks() call instead of trying to
	// reconcile the multi-playlist union by hand.
	if (shell.currentPlaylistId() && touched.some((r) => r.playlistId === shell.currentPlaylistId())) {
		const removed = touched.find((r) => r.playlistId === shell.currentPlaylistId())?.trackIds ?? [];
		if (removed.length > 0) {
			const removedSet = new Set(removed);
			// Snapshot the playlist's base BEFORE splice — otherwise removing
			// the row currently at min shifts the visible base up and we'd
			// renumber to a different starting position than the DB.
			const base = deps.currentPlaylistPositionBase();
			deps.setMainTracksUnfiltered(deps.getMainTracksUnfiltered().filter((t) => !removedSet.has(t.id)));
			tracksData.removeMany(removedSet);
			if (Number.isFinite(base)) deps.compactCurrentPlaylistPositions(base);
			deps.applyFilterToMainList();
		}
	} else if (shell.currentFolderId() && isFolder) {
		// Folder view aggregates multiple playlists' positions and getTracks
		// re-decorates from the freshly-compacted DB, so a refetch is the
		// path of least confusion.
		void deps.renderTracks();
	}
	void deps.refreshPlaylistsForSyncView();

	if (errors.length > 0) {
		showToast(`Removed ${removedTotal}, ${errors.length} failed`, {
			sub: errors[0],
			kind: 'error',
			durationMs: 5000,
		});
	} else {
		showToast(`Removed ${removedTotal} track${removedTotal === 1 ? '' : 's'}`, {
			sub: `From ${touched.length} playlist${touched.length === 1 ? '' : 's'} — sync to Rekordbox to push`,
			kind: 'success',
		});
	}
}

export function showDlRowContextMenu(evt: MouseEvent, trackId: string): void {
	const job = downloads.job(trackId);
	if (!job) return;
	const hasFile = (job.state === 'done' || job.state === 'skipped') && !!job.outputPath;
	const ICON_REVEAL = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7h6l2 2h10v10H3z"/></svg>';
	const ICON_DOWNLOAD = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 4v12"/><path d="m6 10 6 6 6-6"/><path d="M5 20h14"/></svg>';
	const ICON_SEARCH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
	const items: ContextMenuItem[] = [{ kind: 'header', label: job.trackTitle }];
	if (hasFile) {
		items.push({ kind: 'item', id: 'reveal', label: 'Open File Location', iconHtml: ICON_REVEAL });
	}
	items.push({ kind: 'item', id: 'download', label: `Download${job.state === 'done' ? ' again' : ''}`, iconHtml: ICON_DOWNLOAD });
	items.push({ kind: 'item', id: 'search-tidal', label: 'Search in Tidal', iconHtml: ICON_SEARCH });
	items.push({ kind: 'item', id: 'search-beatport', label: 'Search in Beatport', iconHtml: ICON_SEARCH });
	// Query string mirrors the tracks-table menu — artist + title when we
	// have an artist, falling back to title alone. This is a user-driven
	// browser visit, distinct from the programmatic provider lookups which
	// must always include an artist (see [[feedback_no_title_only_search]]).
	const q = job.artistName ? `${job.trackTitle} ${job.artistName}` : job.trackTitle;
	openContextMenu(items, {
		reveal: () => {
			if (job.outputPath) shellApi.showInFolder(job.outputPath);
		},
		download: async () => {
			try { await downloadsApi.redownload(trackId); }
			catch (err) { showToast('Re-download failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' }); }
		},
		'search-tidal': () => {
			shellApi.openExternal(`https://tidal.com/search?q=${encodeURIComponent(q)}`);
		},
		'search-beatport': () => {
			shellApi.openExternal(`https://www.beatport.com/search?q=${encodeURIComponent(q)}`);
		},
	}, { at: evt });
}
