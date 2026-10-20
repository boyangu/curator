import type { Api } from '../ipc.js';
import type { Track, Playlist, PlaylistFolder, PinnedSearch, SegmentRecord } from '@curator/shared';
import type { ArtistLink, ArtistScope, ArtistSummary } from '@curator/shared';
import { artistExternalLinks } from './features/artistLinks.js';
import type { ClearableTrackField } from '@curator/core';
import type { SyncProgress, DownloadJob, QueueSummary, AuthStatus, ScanProgress, JourneySeed, AgentResultSet, AgentViewCommand, AgentViewContext } from '@curator/core';
import * as player from './player.js';
import type { PlayerState } from './player.js';
import { initPlayTracker, setPlayContextProvider } from './play-tracker.js';
import { createSignal, createEffect, createMemo, on } from 'solid-js';
import { mountTrackList, twoLineColumns, type TrackListHandle, ALL_COLUMNS, type Column, type LayoutColumn } from './track-list.js';
import type { GroupBy } from './trackGroups.js';
import { albums } from './data/albums.js';
import { parseQuery, matchTrack, collectTagNames, extractSqlPrefilter, isEmptyExpr, buildExactAttr, hasSimilarTerm, type TagResolver, type SqlPrefilter } from './query.js';
import { attachTagSuggest } from './tagSuggest.js';
import { BIG_ZOOM_BAR_LEVELS, BIG_ZOOM_DEFAULT_IDX } from './components/MainWaveformView.jsx';
import { SKINS, type SkinId } from './renderers/waveformStyles.js';
import { mountPlayerFooter, type PlayerFooterHandle } from './layouts/PlayerFooter.jsx';
import { mountNowPlayingChip } from './components/NowPlayingChip.jsx';
import { mountTopFrame, type TopFrameHandle, type AnalyzerStatus } from './layouts/TopFrame.jsx';
import { mountSidebar, type SidebarHandle, type SidebarSnapshot } from './layouts/Sidebar.jsx';
import { mountMainPane, type MainPaneHandle } from './layouts/MainPane.jsx';
import { mountAppShell, type AppShellHandle } from './layouts/AppShell.jsx';
import { mountDownloadsView, type DownloadsViewHandle } from './components/DownloadsView.jsx';
import { mountDiscoverView, type DiscoverViewHandle } from './components/DiscoverView.jsx';
import { mountJourneyView, type JourneyViewHandle } from './components/JourneyView.jsx';
import { mountAgentPanel, type AgentPanelHandle } from './components/AgentPanel.jsx';
import { mountAgentResultView, type AgentResultViewHandle } from './components/AgentResultView.jsx';
import { startEqDriver } from './eq-driver.js';
import { mountSyncView, type SyncViewHandle, type SyncRowSnapshot } from './components/SyncView.jsx';
import { mountSettingsModal, type SettingsModalHandle, type SettingsTab } from './layouts/SettingsModal.jsx';
import { mountTrackEditModal, type TrackEditModalHandle } from './layouts/TrackEditModal.jsx';
import { mountAnalyzeModal, type AnalyzeModalHandle } from './layouts/AnalyzeModal.jsx';
import { mountRatingDialog, type RatingDialogHandle } from './layouts/RatingDialog.jsx';
import { mountNamePromptDialog, type NamePromptHandle, type NamePromptOptions } from './layouts/NamePromptDialog.jsx';
import { mountDeleteTracksDialog, type DeleteTracksDialogHandle } from './layouts/DeleteTracksDialog.jsx';
import { mountConfirmDialog, type ConfirmDialogHandle } from './layouts/ConfirmDialog.jsx';
import { mountWavConvertDialog, type WavConvertDialogHandle } from './layouts/WavConvertDialog.jsx';
import { mountBackupProgressDialog, type BackupProgressDialogHandle } from './layouts/BackupProgressDialog.jsx';
import { mountBackupRestoreDialog, type BackupRestoreDialogHandle } from './layouts/BackupRestoreDialog.jsx';
import { mountMergeTracksDialog, type MergeTracksHandle } from './layouts/MergeTracksDialog.jsx';
import { mountArtistMergeReviewDialog, type ArtistMergeReviewHandle } from './layouts/ArtistMergeReviewDialog.jsx';
import { mountMcpConfirmModal } from './layouts/McpConfirmModal.jsx';
import { mountOrganizeDialog, type OrganizeDialogHandle, type OrganizeItem, type OrganizeSource } from './layouts/TagPlaylistPickerDialog.jsx';
import { mountSyncToRekordboxModal, DEFAULT_SYNC_FLAGS, type SyncToRekordboxModalHandle, type SyncFlags, type SyncTarget } from './layouts/SyncToRekordboxModal.jsx';
import { mountSyncFromRekordboxModal, DEFAULT_PULL_FLAGS, type SyncFromRekordboxModalHandle, type PullFlags, type PullTarget } from './layouts/SyncFromRekordboxModal.jsx';
import { openContextMenu, dismissContextMenu, type ContextMenuItem } from './components/ContextMenu.jsx';
import * as analysisStore from './stores/analysisStore.js';
import type { PeaksTier, CueData } from './stores/analysisStore.js';
import { loadCuePalette, cueColor, cuePaletteEntries } from './cuePalette.js';
import * as tagsStore from './stores/tagsStore.js';
import { createDeck, type DeckController } from './deck/controller.js';
import { wireControllers, getConnectedControllers } from './controllers.js';
import { createRoot } from 'solid-js';
import { getNowPlayingTrackId, setNowPlayingTrackId } from './now-playing.js';
import { getSidebarW, setSidebarW, getSidebarCollapsed, setSidebarCollapsed, getAllColumnWidths, setColumnWidth, getColumnVisibility, setColumnVisibility, getColumnOrder, setColumnOrder, resetColumnOrder, getPlaylistSort, setPlaylistSort, hasPlaylistSort, isSpotifyBackfillDone, markSpotifyBackfillDone } from './ui-settings.js';
import { getSourceCapabilities, searchFold, type StreamingSource } from '@curator/shared';
import { mountOmnibar, openOmnibar } from './omnibar.js';
import { CommandRegistry } from './commands.js';
import { isModalOpen } from './modalGate.js';

declare global {
	interface Window {
		api: Api;
	}
}

type SortColumn = 'match' | 'index' | 'title' | 'artist' | 'album' | 'releaseDate' | 'label' | 'genre' | 'bpm' | 'keyCamelot' | 'duration' | 'createdAt' | 'rating' | 'loudnessRangeLu' | 'dissonance' | 'density' | 'brightness' | 'power' | 'dynamicComplexity';
type SortDir = 'asc' | 'desc';

// Used by sidebar activation handlers to apply per-playlist sort memory:
// look up the user's last-used sort for this id; if none, default to index
// asc (= Spotify's "Custom order"). Narrows the stored string back to the
// SortColumn union before assigning — anything unrecognized falls through
// to the default rather than poisoning state.sortColumn with a bogus value.
const KNOWN_SORT_COLUMNS = new Set<SortColumn>([
	'index', 'title', 'artist', 'album', 'releaseDate', 'label', 'genre', 'bpm', 'keyCamelot',
	'duration', 'createdAt', 'loudnessRangeLu', 'dissonance', 'density',
	'brightness', 'power', 'dynamicComplexity',
]);
// One-time migration. For every Spotify playlist already in the user's
// library, pre-seed a `playlistSorts` entry with `{ column: 'createdAt',
// dir: 'desc' }` (= "Added ↓", which mirrors Spotify's "Recently added"
// view). Idempotent: only stamps playlists that have no manual entry
// yet, so a subsequent run after the user has chosen other sorts won't
// clobber their choices. Gated by isSpotifyBackfillDone() so it only
// runs once per install.
function backfillSpotifyPlaylistSorts(): void {
	if (isSpotifyBackfillDone()) return;
	let count = 0;
	for (const pl of library.allPlaylists()) {
		if (pl.source !== 'spotify') continue;
		if (hasPlaylistSort(pl.id)) continue;
		setPlaylistSort(pl.id, { column: 'createdAt', dir: 'desc' });
		count++;
	}
	markSpotifyBackfillDone();
	if (count > 0) log.for('ui-settings').info('Spotify backfill stamped playlists with Added ↓', { count });
}

function applyStoredOrDefaultSort(id: string): void {
	const stored = getPlaylistSort(id);
	if (stored && KNOWN_SORT_COLUMNS.has(stored.column as SortColumn)) {
		state.sortColumn = stored.column as SortColumn;
		state.sortDir = stored.dir;
	} else {
		// Source-aware default. Spotify playlists default to `Added ↓` to
		// match the "Recently added" view users typically have selected in
		// the Spotify app — the Web API doesn't expose that UI preference,
		// so this is the closest we can get to "mirror what Spotify shows".
		// Everything else (Rekordbox, local folders, library folders)
		// defaults to `index asc`, which is the natural ordering for those
		// surfaces.
		const pl = library.getPlaylist(id);
		if (pl?.source === 'spotify') {
			state.sortColumn = 'createdAt';
			state.sortDir = 'desc';
		} else {
			state.sortColumn = 'index';
			state.sortDir = 'asc';
		}
	}
	state.tracksFilter = 'all';
	mainTrackList?.setSort({ column: state.sortColumn, dir: state.sortDir });
}
import { shell, type JitPlaylist } from './viewmodel/shell.js';
import { navHistory, locationKey, makeEntry, stackOf, type NavLocation, type NavEntry, type NavRestore, type NavGesture, type NavTab, type TracksScope } from './viewmodel/navHistory.js';
import { mountRegionEffect, type RegionEffectHandle } from './views/regionEffect.js';
import { agentApi } from './data/agent.js';
import { downloads } from './data/downloads.js';
import { syncState } from './data/sync.js';
import { analysisStatus } from './data/analysisStatus.js';
import { library } from './data/library.js';
import { tracksData } from './data/tracks.js';
import { fmtTime, fmtAgo, coverGradient, escapeHtml } from './ui/format.js';
import { showToast } from './ui/toast.js';
import { wireDataEvents } from './data/events.js';
import { log, installGlobalErrorCapture } from './data/log.js';
import { backupApi, cloudSyncApi } from './data/api.js';
import { initBackupSettingsFeature } from './features/backupSettings.js';
import { initSettingsFeature, handleSettingsTabActivate, handleSettingsClose, renderSettingsConnections, renderSettingsPlayer, pushAllSourceSyncSettingsToCore, hydrateCreditFormatFromCore, getSourceSyncSettings, loadRekordboxSettings, startRekordboxImport } from './features/settings.js';
import { initUiSettingsFeature, tagCountsSignal, setTagCountsSignal, visibleSourceTabsMemo, visibleStateTabsMemo, applyActiveTabFallback, uiSettingsSignal, updateUiSettings } from './features/uiSettings.js';
import { setSimilarityRefTrack, similaritySettingsSignal } from './features/similarity.js';
import { loadAutoAnalyzeSettings, pushAutoAnalyzeToCore } from './features/analysisFlags.js';
import { initEditTrackFeature, saveTrackEditor, resetTrackEditorField, handleTrackEditorClose } from './features/editTrack.js';
import { initLibraryPanelFeature, refreshLibraryFolders, repaintLibraryFolderSurfaces, renderLibraryFoldersModalIfOpen, scheduleLibraryPanelRepaint } from './features/libraryPanel.js';
import { initContextMenusFeature, type ContextMenusFeatureDeps, showSrcHeaderContextMenu, showPlaylistContextMenu, showRekordboxFolderContextMenu, showPinnedSearchContextMenu, showDlRowContextMenu, openAnalyzeForScope, SYSTEM_TAG_INTERESTED, SYSTEM_TAG_BASKET } from './features/contextMenus.js';
import { initTrackCommands, showTrackMenu, runTrackCommand, trackCommandAvailable, type TrackSelectionContext } from './features/trackCommands.js';

// SourceTab + JitPlaylist now live in the shell view model — single
// definition for the whole renderer.
import type { SourceTab } from './viewmodel/shell.js';

// Scoped loggers for the areas main.ts logs into repeatedly; one-off areas
// use inline log.for('x') at the call site.
const tagsLog = log.for('tags');
const syncLog = log.for('sync');
const rbLog = log.for('rekordbox');
const analysisLog = log.for('analysis');
const pinnedLog = log.for('pinned');
const downloadLog = log.for('download');

// Navigation state (activeSource / activeView / currentPlaylistId /
// currentFolderId / currentJit) lives in the shell view model — read via
// shell.X(), write via shell transitions ONLY. The fields were deleted
// here (not aliased) so stale-writer code fails to compile.
const state = {
	sortColumn: 'bpm' as SortColumn,
	sortDir: 'asc' as SortDir,
	// (Sync session state moved to data/sync.ts; playlists / rb tree /
	// library folders / auth snapshot moved to data/library.ts.)
	// (Visible-tracks cache moved to data/tracks.ts.)
	// (Sync running/retry/stop flags + current-playlist pointer moved to
	// data/sync.ts.)
	// (In-flight per-playlist enrichment session moved to the `enriching`
	// signal near getSidebarSnapshot — it's a reactive sidebar input.)
	// (Download queue mirror moved to data/downloads.ts.)
	// Track-row multi-selection lives in the TrackListView handle (Phase 4) —
	// read it via getSelectedTrackIds() / getSelectionAnchor(), never a
	// state mirror.
	// Per-source UI snapshot. When the user tabs between Spotify ↔ Tidal we
	// want each tab to remember its own scope (playlist / folder / search /
	// root) + selection rather than clearing on every switch, the way
	// browser tabs keep their page. captureSourceState() writes the active
	// source's slot, restoreSourceState() loads from the destination's slot.
	sourceSlots: new Map<SourceTab, { scope: TracksScope; selectedTrackIds: string[]; selectionAnchor: string | null }>(),
	// Per-playlist scroll anchor — the track id we land on when the user
	// re-activates this playlist via a click. Preferred over a raw scrollTop
	// because it survives sort changes and playlist additions/removals.
	// Captured on playlist leave (or session persist); restored on activate.
	playlistAnchors: new Map<string, string>(),
	// Source-pip column filter. Set via the SRC header context menu; resets
	// on playlist change. Filters are applied client-side on the already-
	// fetched track list (the indicator data is already in each row).
	tracksFilter: 'all' as 'all' | 'unmatched-tidal' | 'unmatched-beatport' | 'with-local',
	// (Manually-expanded rekordbox folder ids moved to the `rekordboxExpanded`
	// signal near getSidebarSnapshot — it's a reactive sidebar input.)
	// Per-folder live scan totals — populated from library:scan-progress
	// events and cleared when the folder finishes scanning. Renderer uses
	// this to show "scanned 234 of …" labels while a watcher is still
	// emitting `add` events for existing files.
	libraryScanByFolder: new Map<string, ScanProgress>(),
	// (Analyzer queue status moved to data/analysisStatus.ts.)
};

const $ = (sel: string): HTMLElement | null => document.querySelector(sel);
// (formatters extracted to ui/format.ts — F3.0)

// Sync render — reads from the in-memory library cache instead of
// refetching. refreshAll() owns the cache refresh; every other sidebar
// input change (tab switch, filter type, enrichment indicator update) is a
// reactive recompute of the snapshot memo, ~2-5ms instead of 50-100ms + IPC.
//
// Star button SVG. Stroke-only (border) by default; the `.starred` modifier
// STAR_SVG moved into layouts/Sidebar.tsx — rendered as inline JSX in
// each row rather than a re-used innerHTML string.



// Smart-playlist placeholder. Toggles a tab-empty card that lives in the
// same slot as the connect/onboarding panels. Hides the tracks-view so
// the user clearly sees the watermark instead of a stale prior playlist.
function showSmartPlaylistWatermark(name: string): void {
	const el = document.getElementById('tab-empty');
	if (!el) return;
	// Visibility (panel shown, table hidden) derives from this in the
	// region effect — the painter only owns the content.
	shell.setEmptyState({ kind: 'watermark', source: 'rekordbox' });
	el.dataset.source = 'rekordbox';
	el.innerHTML = `
		<div class="tab-empty__mark"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.5 2.5M16.5 16.5L19 19M5 19l2.5-2.5M16.5 7.5L19 5"/><circle cx="12" cy="12" r="4"/></svg></div>
		<div class="tab-empty__title">${escapeHtml(name)}</div>
		<div class="tab-empty__sub">Smart playlists currently not supported. Coming soon.</div>
	`;
	el.hidden = false;
}

// Walk the Rekordbox tree under `folderId` and return every descendant
// playlist's id. Used by renderTracks when a folder is selected — we union
// the descendants and ask the backend for the aggregate track set.
function gatherDescendantPlaylistIds(folderId: string): string[] {
	const { folders, playlists } = library.rekordboxTree();
	const foldersByParent = new Map<string, PlaylistFolder[]>();
	for (const f of folders) {
		const p = f.parentFolderId ?? '';
		if (!p) continue;
		if (!foldersByParent.has(p)) foldersByParent.set(p, []);
		foldersByParent.get(p)!.push(f);
	}
	const playlistsByParent = new Map<string, Playlist[]>();
	for (const p of playlists) {
		const par = p.parentFolderId ?? '';
		if (!par) continue;
		if (!playlistsByParent.has(par)) playlistsByParent.set(par, []);
		playlistsByParent.get(par)!.push(p);
	}
	const result: string[] = [];
	const walk = (fid: string): void => {
		for (const p of playlistsByParent.get(fid) ?? []) result.push(p.id);
		for (const f of foldersByParent.get(fid) ?? []) walk(f.id);
	};
	walk(folderId);
	return result;
}

// Names of every Rekordbox folder ancestor of `nodeId` (a folder OR a
// playlist id), root-first and excluding the node itself. The caller appends
// the node's own name to form the `A / B / C` breadcrumb shown as the
// tracklist title. Empty when the node sits at the tree root. Playlists are
// resolved through getPlaylist since they live in a flat list separate from
// folders (mirrors expandRbAncestors' parent-chain walk).
function rekordboxAncestorNames(nodeId: string): string[] {
	const folderById = new Map(library.rekordboxTree().folders.map((f) => [f.id, f]));
	const asFolder = folderById.get(nodeId);
	let parentId: string | null = asFolder
		? asFolder.parentFolderId ?? null
		: library.getPlaylist(nodeId)?.parentFolderId ?? null;
	const names: string[] = [];
	while (parentId) {
		const p: PlaylistFolder | undefined = folderById.get(parentId);
		if (!p) break;
		names.unshift(p.name);
		parentId = p.parentFolderId ?? null;
	}
	return names;
}


// In-flight star toggles. Key = playlist/folder id, value = the target
// favorite state once the 1s timer fires. Visual state in the sidebar reads
// from this map (via effectiveFavorite) so a row's star flips fill
// immediately on click; the actual `isFavorite` field is patched only when
// the timer elapses, which is when the FLIP-animated re-sort kicks in.
//
// pendingFavorite + playlistsDelegationWired flag moved into the Sidebar
// component — favorite optimistic state lives in a Solid signal per
// instance, and there's no delegated listener to wire because event
// handlers are JSX-attached per row.

// ─── Track selection (single source of truth: the TrackListView handle) ────
// Phase 4: the old state.selectedTrackIds / state.selectionAnchor mirrors
// are gone — they drifted from the component between onSelectionChange
// syncs, and a context menu firing inside that window acted on the wrong
// rows. Every reader goes through these helpers; every writer goes through
// setTrackSelection so the handle and persistence can't disagree. Before
// the list mounts (boot-time loadUiState runs first), writes land in
// pendingSelection and mountMainTrackList's caller consumes them.
let pendingSelection: { ids: string[]; anchor: string | null } | null = null;

function getSelectedTrackIds(): Set<string> {
	if (mainTrackList) return new Set(mainTrackList.getSelectedIds());
	return new Set(pendingSelection?.ids ?? []);
}

function getSelectionAnchor(): string | null {
	if (mainTrackList) return mainTrackList.getSelectionAnchor();
	return pendingSelection?.anchor ?? null;
}

function setTrackSelection(ids: readonly string[], anchor: string | null): void {
	if (mainTrackList) {
		mainTrackList.setSelectedIds([...ids]);
		mainTrackList.setSelectionAnchor(anchor);
	} else {
		pendingSelection = { ids: [...ids], anchor };
	}
}

// Clears selection state — call when the displayed track set changes so a
// bulk action can't accidentally hit tracks that just scrolled off-screen.
function clearTrackSelection(): void {
	setTrackSelection([], null);
}

// Snapshot the active source's user-visible state into its slot. Called
// just before switching tabs so the destination's restore doesn't bury
// uncommitted changes (playlist click, selection, etc.).
function captureSourceState(): void {
	// The slot describes the source's TRACKS view. Tag views (Interested /
	// Basket) clear the scope while they're up, so a capture there would
	// overwrite the remembered playlist with "nothing".
	if (shell.activeView() !== 'tracks') return;
	state.sourceSlots.set(shell.activeSource(), {
		scope: currentTracksScope(),
		selectedTrackIds: [...getSelectedTrackIds()],
		selectionAnchor: getSelectionAnchor(),
	});
}

// Put a tracks scope into the shell — the one place the four scope
// transitions are chosen from a TracksScope value.
function applyTracksScope(scope: TracksScope): void {
	switch (scope.type) {
		case 'all': shell.clearScope(); break;
		case 'playlist': shell.setPlaylist(scope.id); break;
		case 'folder': shell.setFolder(scope.id); break;
		case 'jit': shell.setJit(scope.jit); break;
	}
}

// Pull the destination source's stored slot back into top-level state.
// First-time tabs (no slot yet) collapse to "nothing selected, no playlist
// open" — same as if the user just landed on this source. Subsequent
// renderTracks() will re-prune anything the new source's track list
// doesn't include.
function restoreSourceState(src: SourceTab): void {
	const slot = state.sourceSlots.get(src);
	applyTracksScope(slot?.scope ?? { type: 'all' });
	setTrackSelection(slot?.selectedTrackIds ?? [], slot?.selectionAnchor ?? null);
}

// Records a per-playlist anchor track so a future activation can jump
// back to where the user was. Anchor preference order:
//   1. First selected track in playlist order (the row the user marked)
//   2. Top-of-viewport track derived from scrollTop (their reading position)
// Nothing is recorded when there's no current playlist or no visible tracks.

function captureCurrentAnchor(): void {
	if (!shell.currentPlaylistId()) return;
	const tracks = getMainTracks();
	if (tracks.length === 0) return;
	let anchorId: string | null = null;
	const selected = getSelectedTrackIds();
	if (selected.size > 0) {
		for (const t of tracks) {
			if (selected.has(t.id)) { anchorId = t.id; break; }
		}
	}
	if (!anchorId) {
		// The top-of-viewport track. The list owns its row geometry (two-line
		// rows, group headers) — ask it rather than dividing scrollTop.
		const idx = mainTrackList?.getFirstVisibleIndex() ?? -1;
		anchorId = idx >= 0 ? tracks[idx]?.id ?? null : null;
	}
	const pid = shell.currentPlaylistId();
	if (anchorId && pid) state.playlistAnchors.set(pid, anchorId);
}

// Scrolls the tracks view to the saved anchor for the current playlist if
// the track still exists in the current list. Silent no-op otherwise —
// e.g. when the anchor track was removed from the playlist upstream.
function restoreCurrentAnchor(): void {
	const pid = shell.currentPlaylistId();
	if (!pid) return;
	const anchorId = state.playlistAnchors.get(pid);
	if (!anchorId) return;
	mainTrackList?.scrollToTrack(anchorId);
}

// ─── Main tracks list (TrackListView handle) ───────────────────────────────
// The component (track-list.ts) owns row rendering, virtualization,
// selection, sort headers, and column resize. main.ts holds one handle to
// the mounted instance; selection is read/written exclusively through the
// getSelectedTrackIds / getSelectionAnchor / setTrackSelection helpers
// above (Phase 4 removed the state mirrors).
let mainTrackList: TrackListHandle | null = null;
// Pre-filter cache. renderTracks() puts the freshly-fetched list here;
// applyFilterToMainList() narrows it with the filterbox query and pushes
// the result into the component. Keeping the unfiltered copy out-of-band
// means re-typing the filter doesn't re-hit the IPC.
let mainTracksUnfiltered: Track[] = [];
let mainFilterText: string = '';
let filterDebounceHandle: ReturnType<typeof setTimeout> | null = null;
// PlayerFooter (Phase 3.A) — single mount that composes every player-
// surface Solid component into one render tree. Owned by boot();
// destroy() unmounts cleanly for HMR. Individual component handles
// (NowPlayingCard, TransportView, etc.) are not exposed because
// nothing outside the footer needs them — the snapTo escape hatch is
// re-surfaced via the layout handle.
let playerFooter: PlayerFooterHandle | null = null;
// DeckController — musical-time scheduler above player.ts. Owns the
// quantize toggle, active loop region, beat-jump math, and cue-trigger
// deferral. UI callbacks in the PlayerFooter mount forward into deck
// methods; deck reads the beatgrid from analysisStore and drives seeks
// through player.seekBy. Instantiated lazily so deck.snapTo can close
// over the playerFooter handle (which the deck uses to hard-cut the
// played-position overlay on programmatic seeks).
let deck: DeckController | null = null;
let topFrame: TopFrameHandle | null = null;
let sidebar: SidebarHandle | null = null;
// MainPane (Phase 3.D) — structural extraction of the `.main` view
// container. Static inner ids (#playlist-title, #sync-list,
// #tracks-view, …) are preserved so the remaining
// procedural render code (renderEmptyState, renderSyncView,
// the #tracks-view track-list mount) keeps working unchanged.
// The dl-view is empty under MainPane — DownloadsView paints into it.
let mainPane: MainPaneHandle | null = null;
// AppShell (Phase 3.E) — the entire renderer skeleton. Mounted into
// the single #app-root div in index.html. Renders .app-shell + the
// four region hosts + the shared overlays in one pass; the other four
// mountX() calls below target the hosts AppShell paints.
let appShell: AppShellHandle | null = null;
// DownloadsView — reactive component mounted into #dl-view inside
// MainPane. Replaces the imperative renderDownloadsView + the dl-
// toolbar wireX calls. Reads jobs/summary via signals updated by
// the queue/progress IPC listeners.
let downloadsView: DownloadsViewHandle | null = null;
let discoverView: DiscoverViewHandle | null = null;
let journeyView: JourneyViewHandle | null = null;
// Agent surfaces inside Discover: the docked conversational panel (right
// column) and the result-set list (third main-area mode). Assigned by
// mountDiscoverRegion.
let agentPanel: AgentPanelHandle | null = null;
let agentResultView: AgentResultViewHandle | null = null;
// Feed ↔ Journeys ↔ agent-results mode inside the Discover region —
// assigned by mountDiscoverRegion (v1 minimal toggle; the Discover
// toolbar/side-pane design pass replaces it). 'agent-results' is entered
// programmatically (a result set arriving / a card click), not via the bar.
let setDiscoverMode: (m: 'feed' | 'journeys' | 'agent-results') => void = () => {};
// Mirror of the current Discover mode for the agent's view-context capture.
let currentDiscoverMode: 'feed' | 'journeys' | 'agent-results' = 'feed';
let regionEffect: RegionEffectHandle | null = null;
// SyncView — reactive component mounted into #sync-view inside
// MainPane. Replaces renderSyncView + wireSyncNowButton. Reads rows /
// running via signals updated by wireSyncProgressEvents and the
// playlists refresh helpers.
let syncView: SyncViewHandle | null = null;
// SettingsModal — Solid component owning the modal shell, tab strip,
// and open/close lifecycle (backdrop, ESC, close button). The three
// panel bodies (#settings-connections, #lib-folders-body,
// #settings-rekordbox) stay imperative; main.ts paints them on
// onTabActivate.
let settingsModal: SettingsModalHandle | null = null;
// TrackEditModal — Solid component owning the modal shell + form
// markup + open/close lifecycle. features/editTrack.ts fills the form
// fields by name in openTrackEditor() and reads them back in
// saveTrackEditor(), reaching the handle via its injected getter.
let trackEditModal: TrackEditModalHandle | null = null;
let analyzeModal: AnalyzeModalHandle | null = null;
let ratingDialog: RatingDialogHandle | null = null;
let namePromptDialog: NamePromptHandle | null = null;
let deleteTracksDialog: DeleteTracksDialogHandle | null = null;
let confirmDialog: ConfirmDialogHandle | null = null;
let wavConvertDialog: WavConvertDialogHandle | null = null;
let backupProgressDialog: BackupProgressDialogHandle | null = null;
let backupRestoreDialog: BackupRestoreDialogHandle | null = null;
let mergeTracksDialog: MergeTracksHandle | null = null;
let artistMergeReview: ArtistMergeReviewHandle | null = null;
// IDs the dialog is currently editing. Captured at open time so a tracklist
// re-render during the dialog's lifetime (e.g. an unrelated enrichment event)
// can't substitute a different selection on submit.
let ratingDialogTargetIds: string[] = [];
let organizeDialog: OrganizeDialogHandle | null = null;

// Playlist-picker membership snapshot. trackId → set of playlistIds the
// track currently belongs to. Filled ASYNCHRONOUSLY after dialog open via the
// batched IPC (the modal opens instantly and chips flip in place when the
// batch lands), then mutated in place by commitPlaylistChanges so the picker's
// three-state chips refresh without a full refetch.
const playlistMembership = new Map<string, Set<string>>();
// False from Organize open until the membership batch (playlists + tags) has
// landed for the current selection. The dialog gates chip WRITES on this —
// a click against half-loaded membership would compute a wrong tri-state
// diff. Search/browse stay live regardless.
const [organizeMembershipReady, setOrganizeMembershipReady] = createSignal(true);
// Monotonic open counter — stale-guards the async membership fill (and the
// cold-cache catalog fetch) against a rapid re-open with a new selection.
let organizeOpenSeq = 0;
// Cached playlist portion of the Organize modal's unified item list, mapped
// from library.playlistEntries() (the client-side catalog kept warm by
// refreshOrganizeCatalog). Re-mapped on open and on catalog refresh; combined
// with the live tag list (from tagsStore) by buildOrganizeItems().
let organizePlaylistItems: OrganizeItem[] = [];
// Deferred feed-track promotion for the plain "Organize" (no-pin) path. The
// modal opens on a PROVISIONAL id (FEED_PROMO_ID) — no library row exists yet;
// the first membership write calls `promote()` (creating the unpinned row) and
// stamps `realId`, after which every id the modal reads/writes is aliased to it
// (resolveOrganizeId). `rollback` undoes the promotion if the modal closes with
// nothing applied, so a cancelled Organize never leaves an orphan row. Null when
// no deferred session is active (the normal owned-track open path).
const FEED_PROMO_ID = '__feed-promo__';
let feedPromo: {
	promote: () => Promise<string>;
	rollback: (trackId: string) => Promise<void>;
	realId: string | null;
} | null = null;
// Alias the provisional id to the real curator id once the deferred promotion
// has run — every membership read/write the modal makes goes through this.
// Bumped when the deferred session's real id lands. Read inside
// resolveOrganizeId so every reactive reader of the alias (the modal's header
// row, tag + playlist membership) re-evaluates on promotion — the row may
// already be in the page cache from the promote's own refresh, in which case
// no tracksData tick fires and the header would otherwise stay on the
// star-less count fallback.
const [feedPromoRev, setFeedPromoRev] = createSignal(0);
function resolveOrganizeId(id: string): string {
	feedPromoRev();
	return feedPromo && feedPromo.realId && id === FEED_PROMO_ID ? feedPromo.realId : id;
}
// Resolve a modal id list for a WRITE: if it targets the provisional feed track,
// run the deferred promotion (once) and swap in the real curator id. Throws if
// the promotion fails — the caller aborts the write and toasts.
async function resolveOrganizeWriteIds(ids: readonly string[]): Promise<string[]> {
	if (!feedPromo || !ids.includes(FEED_PROMO_ID)) return [...ids];
	if (feedPromo.realId === null) {
		feedPromo.realId = await feedPromo.promote();
		// The freshly minted row is usually on no page — pull it into the cache
		// so the modal header flips from the count fallback to the real track
		// (with stars) as soon as the promotion lands. Then re-resolve the alias
		// for readers whose row was already cached.
		void ensureTrackCached(feedPromo.realId);
		setFeedPromoRev((n) => n + 1);
	}
	const realId = feedPromo.realId;
	return ids.map((id) => (id === FEED_PROMO_ID ? realId : id));
}
let syncToRekordboxModal: SyncToRekordboxModalHandle | null = null;
// Subscription handle for the rb export event stream — torn down + replaced
// every time a sync starts so a prior run's listener can't repaint a fresh
// modal session with stale events.
let syncToRekordboxExportUnsub: (() => void) | null = null;
// Pull-direction (Sync from Rekordbox) modal + its import-event subscription.
let syncFromRekordboxModal: SyncFromRekordboxModalHandle | null = null;
let syncFromRekordboxImportUnsub: (() => void) | null = null;
// Beat-grid availability signal — read by TransportView to enable/disable
// the jump buttons. Updated in loadAnalysisFor / track-change so the
// component's `disabled` attribute flips reactively. Replaces the previous
// applyJumpButtonAvailability() DOM-query approach.
const [beatsAvailable, setBeatsAvailable] = createSignal(false);
// Cue list signal — read by CueGridView (and any future cue-aware
// component) for the currently-loaded track. Refreshed alongside
// beatsAvailable whenever the analysisStore cache changes or the player
// switches tracks. Empty array when no analysis is cached for the
// current track yet.
const [currentCues, setCurrentCues] = createSignal<CueData[]>([]);
function refreshCurrentCues(): void {
	setCurrentCues(analysisStore.getCurrentAnalysis()?.cues ?? []);
}

// The three jump magnitudes — Jump / Jumpx4 / Jumpx16 (footer buttons +
// keyboard). The same number is BEATS on an analyzed local track and SECONDS
// on a streaming (Spotify) one — see performJump.
const JUMP_MAGS = [4, 16, 32] as const;

// One jump primitive shared by the footer jump row and the keyboard. When the
// current track has a usable beatgrid (analyzed local), jump by BEATS through
// the deck — musical, sub-beat-phase preserving. Otherwise (Spotify/Discover,
// or unanalyzed local) there is no grid, so jump the same magnitude in SECONDS
// via the streaming-capable seekBy. `signedMag` carries the direction.
function performJump(signedMag: number): void {
	if (beatsAvailable() && deck) {
		player.markUiAction('beat-jump');
		deck.jumpByBeats(signedMag);
	} else {
		player.seekBy(signedMag).catch(() => {});
	}
}
// Peaks signal — read by MiniWaveMapView (and the future BigWaveformView
// when it lands) for the currently-loaded track's tier. Refreshed
// alongside cues whenever peaks finish loading. Null until the first
// load completes for the current track.
const [currentPeaksSignal, setCurrentPeaksSignal] = createSignal<PeaksTier | null>(null);
function refreshCurrentPeaks(): void {
	setCurrentPeaksSignal(analysisStore.getCurrentPeaks()?.tier ?? null);
}
// Beats signal — read by MainWaveformView for viewport computation +
// beat-grid overlay. Refreshed alongside cues from analysisStore loads.
const [currentBeats, setCurrentBeats] = createSignal<Float32Array | null>(null);
function refreshCurrentBeats(): void {
	setCurrentBeats(analysisStore.getCurrentAnalysis()?.beats ?? null);
}
// Downbeats signal — the authoritative bar-boundary times. Distinct from
// `beats[::4]` because rb-sourced tracks routinely have N pickup beats
// before the first downbeat (e.g. beats[0]=0.444s, downbeats[0]=1.444s on
// a 120 BPM track with a 2-beat pickup). MainWaveformView uses this for
// the bar-tick layer and the "<curBar> / <totalBars>" counter so both
// align with rb's bar grid instead of drifting by the pickup offset.
const [currentDownbeats, setCurrentDownbeats] = createSignal<Float32Array | null>(null);
function refreshCurrentDownbeats(): void {
	setCurrentDownbeats(analysisStore.getCurrentAnalysis()?.downbeats ?? null);
}
// Segments signal — read by MainWaveformView for the phrase lane +
// boundary triangles. Refreshed alongside beats/cues from analysisStore.
// Null when the current track has no structural segmentation yet (no
// analyzer Stage 6, no rb PSSI import) — the painter draws an empty
// band instead of collapsing the lane.
const [currentSegments, setCurrentSegments] = createSignal<SegmentRecord[] | null>(null);
function refreshCurrentSegments(): void {
	setCurrentSegments(analysisStore.getCurrentAnalysis()?.segments ?? null);
}
// APPLIED player mode signal — the deck preference gated by big-mode
// allowance, computed and written (incl. the body attribute) by the region
// effect; this signal is just its hand-off into MainWaveformView's small/big
// paint dispatch + the big-mode rAF loop.
const [currentPlayerMode, setCurrentPlayerModeSignal] = createSignal<'small' | 'big'>('small');
// Deck-player big/small PREFERENCE — what the user last chose for the deck
// surface, persisted. The region effect derives the applied mode from it, so
// a streaming variant forces small without clobbering this choice.
const [deckPlayerModePref, setDeckPlayerModePrefSignal] = createSignal<'small' | 'big'>(storedDeckPlayerMode());

// Waveform skin signal — single source of truth shared by the big
// waveform AND the mini wavemap so the user picks one style and both
// views update together. Initialized from localStorage on boot;
// updates persist via `setWaveformSkin` below.
const [currentWaveformSkin, setCurrentWaveformSkinSignal] = createSignal<SkinId>('rekordbox');
function setWaveformSkin(id: SkinId): void {
	setCurrentWaveformSkinSignal(id);
	try { localStorage.setItem('curator.skin', id); } catch { /* private mode */ }
}

// ─── TopFrame signals ──────────────────────────────────────────────────
// The TopFrame layout reads these via Accessor props. main.ts is the
// authoritative source; the existing global mutations (shell.activeSource(),
// shell.activeView(), etc.) ALSO fan out into these signals so the topframe
// re-renders on tab/view/zoom/analyzer changes without depending on
// document.getElementById fan-out.
// (activeSource / activeView signals retired — the shell view model owns
// them; TopFrame and friends subscribe to shell.activeSource/activeView.)
// (tagCountsSignal moved to features/uiSettings.ts — F3.1; main.ts still
// writes it via the imported setTagCountsSignal.)
// (analyzerStatusSignal retired — data/analysisStatus.ts owns chip state.)
const [zoomLevelSignal, setZoomLevelSignal] = createSignal(0);
// tracksCacheRev retired — data/tracks.ts bumps its internal rev on every
// write; NowPlayingCard subscribes via tracksData.rev().
// Revision counter for tagsStore writes. TagPickerDialog reads it inside
// its membership memo so writes propagate without a manual refresh path.
// Initialised by subscribing to tagsStore.onTagsChanged so a Rekordbox-sync
// definitions-reload also bumps the rev (covers the case where an external
// source mutates the tag set while the dialog is open).
const [tagsRev, setTagsRev] = createSignal(0);
tagsStore.onTagsChanged(() => setTagsRev((n) => n + 1));
// Revision counter for playlist picker state — bumped after every
// successful add/remove so the dialog's membership memo re-fires.
const [playlistPickerRev, setPlaylistPickerRev] = createSignal(0);

// ─── Downloads signals ──────────────────────────────────────────────────
// (Download queue reactive surface retired — data/downloads.ts owns the
// store; DownloadsView + chip read it directly.)

// ─── Sync view snapshots ───────────────────────────────────────────────
// SyncView reads this as a reactive accessor — it tracks the sync store's
// rows (and the temporary playlist-join tick) and recomputes per change.
// The playlist-timestamp join still reads the legacy playlistsById Map;
// refreshPlaylistsForSyncView bumps syncState.bumpPlaylistJoin() until the
// playlists slice replaces that Map with a store.
function computeSyncRowSnapshots(): SyncRowSnapshot[] {
	return syncState.rows().map((r) => {
		const pl = r.playlistId ? library.getPlaylist(r.playlistId) : null;
		return {
			playlistId: r.playlistId,
			name: r.name,
			source: r.source,
			mark: r.mark,
			state: r.state,
			trackCount: r.trackCount,
			tracksDone: r.tracksDone,
			remoteUpdatedAt: pl?.remoteUpdatedAt ?? null,
			lastSyncedAt: pl?.lastSyncedAt ?? null,
			playlistTrackCount: pl?.trackCount ?? null,
		};
	});
}

// Per-source "breathing" indicator on the source tabs. Replaces the icon
// with an animated rect + a popover summarizing scan progress. Cap on the
// updated-playlist names list so a 50-playlist sync doesn't produce a
// novel-length tooltip; the rest collapses to "+N more".
//
// Shape: { tooltip, alert } per source. `alert` flips the breathing rect
// to its orange variant — used when the source has hit connection trouble
// and is in the retry loop. Tooltip already carries the user-readable
// reason; alert is the colour signal.
const TOOLTIP_NAME_CAP = 6;
export interface SourceSyncStatus { tooltip: string; alert: boolean }
const [sourceSyncTooltipSignal, setSourceSyncTooltipSignal] =
	createSignal<Partial<Record<SourceTab, SourceSyncStatus>>>({});

function buildSpotifySyncTooltip(): string | null {
	if (!syncState.running() && !syncState.currentSpotify() && !syncState.retrying()) return null;
	const cur = syncState.currentSpotify();
	const skippedCount = syncState.rows().filter((r) => r.state === 'skipped').length;
	const syncedRows = syncState.rows().filter((r) => r.state === 'synced' || r.state === 'syncing');
	const updatedNames = syncedRows.map((r) => r.name);
	const lines: string[] = [];
	// Connection-lost retry sits at the top so it's the first thing the
	// user sees on hover, before the (now stale) "scanning..." line.
	if (syncState.retrying()) {
		lines.push('Connection lost — retrying…');
		lines.push('Press Stop in Settings → Connections to cancel');
	}
	if (cur) {
		const pct = cur.total > 0 ? Math.round((cur.index / cur.total) * 100) : 0;
		lines.push(`Scanning: ${cur.name} (${cur.index} of ${cur.total}, ${pct}%)`);
	} else if (syncState.running() && !syncState.retrying()) {
		lines.push('Spotify sync starting…');
	}
	lines.push(`${skippedCount} playlists unchanged`);
	lines.push(`${updatedNames.length} updated playlists`);
	if (updatedNames.length > 0) {
		const shown = updatedNames.slice(0, TOOLTIP_NAME_CAP);
		const overflow = updatedNames.length - shown.length;
		const trailer = overflow > 0 ? `\n  +${overflow} more` : '';
		lines.push(shown.map((n) => `  • ${n}`).join('\n') + trailer);
	}
	return lines.join('\n');
}

// In-flight Tidal sync pointer — set/cleared by the onSyncProgress handler
// (events stamped source:'tidal'). Deliberately NOT part of syncState: that
// store's running/retrying flags gate Spotify-specific machinery (SyncView
// rows, the retry loop), and the two providers can sync concurrently.
const [tidalSyncProgress, setTidalSyncProgress] =
	createSignal<{ current: { name: string; index: number; total: number } | null } | null>(null);

function buildTidalSyncTooltip(): string | null {
	const st = tidalSyncProgress();
	if (!st) return null;
	if (!st.current) return 'Tidal sync starting…';
	const pct = st.current.total > 0 ? Math.round((st.current.index / st.current.total) * 100) : 0;
	return `Scanning: ${st.current.name} (${st.current.index} of ${st.current.total}, ${pct}%)`;
}

// Reads the sync store reactively — wrapped in a boot createEffect so the
// tooltip recomputes on every store change with no manual call chain.
function refreshSourceSyncTooltipSignal(): void {
	const next: Partial<Record<SourceTab, SourceSyncStatus>> = {};
	const spotify = buildSpotifySyncTooltip();
	if (spotify) next.spotify = { tooltip: spotify, alert: syncState.retrying() };
	const tidal = buildTidalSyncTooltip();
	if (tidal) next.tidal = { tooltip: tidal, alert: false };
	setSourceSyncTooltipSignal(next);
}
// (Analyzer chip bridge retired — TopFrame reads data/analysisStatus.ts.)

// ─── Reactive sidebar inputs ─────────────────────────────────────────────
// The Sidebar layout reads its data from getSidebarSnapshot(), which is
// invoked inside a Solid memo. Every accessor that snapshot touches is
// reactive (shell.* signals, library.* tick getters, and the two signals
// below), so the memo recomputes whenever any sidebar input changes — no
// manual repaint tick is needed.
//
// In-flight per-playlist enrichment session. Set when the user clicks
// "Enrich…" or "Sync with Tidal" on a playlist; cleared on completion.
// Drives the inline indicator next to the playlist title and the breathing
// pulse on the sidebar nav item.
// Also carries a running Convert to WAV ('wav', with its runId so Stop can
// cancel that run rather than the enrichment token).
const [enriching, setEnriching] = createSignal<{ playlistId: string; source: 'beatport' | 'tidal' | 'wav'; processed?: number; total?: number; runId?: string } | null>(null);
// Folder ids the user has manually expanded. Default is collapsed (matches
// Rekordbox's own initial state on big libraries — most folders are noise
// until you drill in). Persisted to localStorage via
// `curator.rekordbox-expanded.v1` so the user's open folders survive
// reloads. Toggles reassign a NEW Set so the signal fires.
const [rekordboxExpanded, setRekordboxExpanded] = createSignal<Set<string>>(new Set());
// Tri-state for the Rekordbox tab's pre-content surface, distinct from the
// imperative `rekordboxTreeLoaded` latch below. 'loading' = the lazy tree fetch
// is in flight (we don't yet know if anything is imported, so show a neutral
// spinner rather than flashing the import CTA); 'empty' = fetch resolved with
// nothing (show the import CTA — rekordbox genuinely not set); 'loaded' = the
// tree has content. Reactive so the sidebar snapshot and renderEmptyState both
// repaint on transitions. Starts at 'loading' because boot paints the empty
// state before the first fetch resolves — without this, that first paint is the
// CTA. We never reset back to 'loading' on a re-check, so background refetches
// don't flash the spinner over an already-decided surface.
const [rekordboxLoadState, setRekordboxLoadState] = createSignal<'loading' | 'empty' | 'loaded'>('loading');
// Saved pinned searches (the "Pinned" nav folder). Reactive sidebar input —
// refreshed from `pinned:list` on boot and after every pin/unpin/rename.
const [pinnedSearches, setPinnedSearches] = createSignal<PinnedSearch[]>([]);
// Expand/collapse of the Pinned folder. Defaults open so a fresh pin is
// immediately visible; persisted via loadPinnedExpanded/savePinnedExpanded.
const [pinnedExpanded, setPinnedExpanded] = createSignal<boolean>(true);
// Artists folder (sidebar) — rows are fetched on demand (top-N by track
// count, or the filter's matches), never the whole 17k-row artist table.
const [artistsList, setArtistsList] = createSignal<ArtistSummary[]>([]);
const [artistsExpanded, setArtistsExpanded] = createSignal<boolean>(false);
const [artistsSearch, setArtistsSearch] = createSignal('');
const [artistsLoading, setArtistsLoading] = createSignal(false);
// Perf contract with Sidebar.tsx: the arrays here may be fresh per call,
// but the ITEMS must be the same object references between updates (Solid's
// keyed <For> diffs by reference — stable refs mean an input change only
// pays the sort/tree-index memos, not row DOM rebuilds). playlistsById
// values satisfy that: objects are replaced only when playlists actually
// refetch, which is exactly when their rows should repaint. Don't map/
// clone items in here.
function getSidebarSnapshot(): SidebarSnapshot {
	return {
		activeSource: shell.activeSource(),
		playlists: library.allPlaylists(),
		rekordboxTree: library.rekordboxTree(),
		currentPlaylistId: shell.currentPlaylistId(),
		currentFolderId: shell.currentFolderId(),
		enriching: enriching(),
		rekordboxExpanded: rekordboxExpanded(),
		rekordboxLoading: rekordboxLoadState() === 'loading',
		pinnedSearches: pinnedSearches(),
		// Active pinned search = the loaded JIT's pinnedId (set when activated
		// from the nav or freshly pinned). Drives the row's selected highlight.
		currentPinnedId: shell.currentJit()?.pinnedId ?? null,
		pinnedExpanded: pinnedExpanded(),
		artists: artistsList(),
		artistsExpanded: artistsExpanded(),
		artistsSearch: artistsSearch(),
		artistsLoading: artistsLoading(),
		currentArtistId: artistIdOfJit(shell.currentJit()),
		spotifyMeId: library.auth()?.spotify.id ?? null,
		tidalMeId: library.auth()?.tidal.id ?? null,
	};
}

// Convenience accessor — replaces the old `currentTracks` module global.
// Returns an empty list before the handle is mounted so callers can read
// without null-checking.
function getMainTracks(): readonly Track[] { return mainTrackList?.getTracks() ?? []; }


// Enter a JIT scope — the tracklist swaps to the query's result set with
// `jit.name` shown in the playlist-title slot. A history navigation under
// the active source tab (the scope keeps whatever tab is up). When
// `selectTrackId` is provided (omnibar Shift+Enter path), selects that
// row once the JIT lands so a subsequent Enter starts playback without
// the user having to hunt for the highlighted track.
async function enterJitScope(jit: JitPlaylist, selectTrackId?: string, opts: { drill?: boolean } = {}): Promise<void> {
	await navigate({ kind: 'tracks', source: shell.activeSource(), scope: { type: 'jit', jit } }, { drill: opts.drill });
	if (selectTrackId) {
		const tracks = getMainTracks();
		const idx = tracks.findIndex((t) => t.id === selectTrackId);
		if (idx >= 0) {
			setTrackSelection([selectTrackId], selectTrackId);
			mainTrackList?.scrollToIndex(idx);
			persistUiState();
		}
	}
}

// Work-gating flag (F1): a repaint requested while the tracks layout is
// inactive is deferred — recorded here and replayed once by the effect in
// boot() when the layout returns. `hidden` gates pixels; this gates WORK.
let tracksRepaintDirty = false;

// Monotonic render counter. Every renderTracks() reads the scope at call
// time and awaits the list IPC; without this, a burst of navigations
// (back/back/forward, sidebar ↑↓ stepping) let the SLOWEST fetch paint last,
// over a newer scope. The last call always wins now.
let renderTracksSeq = 0;

async function renderTracks(): Promise<void> {
	if (!shell.showsTracksLayout()) {
		tracksRepaintDirty = true;
		return;
	}
	const renderSeq = ++renderTracksSeq;
	// Playlist title in the filter-bar reflects the open scope (shared with
	// the history labels via scopeTitle). Hidden at the source-level "all
	// tracks for this provider" view. Tag views (Interested / Basket) have
	// their own static label since they aren't scoped to a playlist.
	paintScopeTitle();
	const jitNow = shell.currentJit();
	const playlistIdNow = shell.currentPlaylistId();

	// Pin button lives in the same header: visible only for JIT scopes, and
	// reflects whether the loaded search is already saved.
	updatePinButton();

	// Indicator visibility follows the active playlist — hides when navigating
	// to another playlist mid-enrichment, reappears on return.
	renderEnrichInline();

	// JIT scope branch — when active, the tracklist is the result of the
	// JIT's grammar query, not a playlist / folder / source view. SQL
	// prefilter narrows the candidate set; matchTrack refines for AST
	// constraints SQL can't push (OR branches, attr substrings, analyzer-
	// scalar comparisons). Same pattern the omnibar's runQuery uses.
	if (jitNow) {
		const jit = jitNow;
		const expr = parseQuery(jit.query);
		const tagResolver = makeTagResolver();
		const pre = extractSqlPrefilter(expr, tagResolver);
		if (pre.hasUnresolvedRequiredTag) {
			tracksData.setAll([]);
			mainTracksUnfiltered = [];
			applyFilterToMainList();
			updateReorderableState();
			return;
		}
		const filter: {
			search?: string;
			keyCamelot?: string;
			bpmMin?: number;
			bpmMax?: number;
			scalarBounds?: SqlPrefilter['scalarBounds'];
			nameClauses?: { tagIds: string[]; playlistNamesAscii: string[] }[];
			hasSource?: string | string[];
			artistIds?: string[];
			albumIds?: string[];
			similarTo?: { seeds?: string[]; text?: string };
		} = {};
		if (pre.search) filter.search = pre.search;
		if (pre.keyCamelot) filter.keyCamelot = pre.keyCamelot;
		if (pre.bpmMin != null) filter.bpmMin = pre.bpmMin;
		if (pre.bpmMax != null) filter.bpmMax = pre.bpmMax;
		if (pre.scalarBounds && pre.scalarBounds.length > 0) filter.scalarBounds = pre.scalarBounds;
		if (pre.nameClauses && pre.nameClauses.length > 0) filter.nameClauses = pre.nameClauses;
		// `source:` terms (incl. the omnibar scope pill baked in by Shift+Enter)
		// — one membership slot; core resolves 'rekordbox' to rekordbox_link.
		if (pre.hasSource) filter.hasSource = pre.hasSource;
		// `artistid={…}` — the artist chip / drill scope, an indexed EXISTS.
		if (pre.artistIds && pre.artistIds.length > 0) filter.artistIds = pre.artistIds;
		// `albumid={…}` — the Drill Into ▶ Album scope, the indexed album_id.
		if (pre.albumIds && pre.albumIds.length > 0) filter.albumIds = pre.albumIds;
		// `similar:` / `sounds:` — the AI engine ranks inside the other filters.
		if (pre.similarTo) filter.similarTo = pre.similarTo;
		// 2000 keeps the worst-case fetch bounded — a label drill-down on
		// "Anjunadeep" returning every track on that label is the realistic
		// upper bound. Bumped past the omnibar's 500 since this is the
		// definitive view of the JIT, not a candidate window.
		let jitTracks = await window.api['tracks:list'](
			filter as never,
			{ column: state.sortColumn, dir: state.sortDir },
			2000,
		);
		if (renderSeq !== renderTracksSeq) return; // superseded by a newer render
		// Same lazy-cache fix as the omnibar / track-list filter — matchTrack
		// reads tagsStore which returns [] for unloaded tracks.
		if (!isEmptyExpr(expr) && collectTagNames(expr).length > 0) {
			await tagsStore.ensureTracksLoaded(jitTracks.map((t) => t.id));
			if (renderSeq !== renderTracksSeq) return;
		}
		if (!isEmptyExpr(expr)) {
			jitTracks = jitTracks.filter((t) => matchTrack(expr, t, tagResolver));
		}
		tracksData.setAll(jitTracks);
		mainTracksUnfiltered = jitTracks;
		applyFilterToMainList();
		updateReorderableState();
		// Tag column membership for the page (fire-and-forget). The visible
		// rows already painted; chips pop in when the IPC returns.
		if (jitTracks.length > 0) {
			const ids = jitTracks.map((t) => t.id);
			tagsStore.ensureTracksLoaded(ids).then(() => {
				for (const t of jitTracks) mainTrackList?.patchOne(t);
				if (mainFilterText.trim() && collectTagNames(parseQuery(mainFilterText)).length > 0) {
					applyFilterToMainList();
				}
			}).catch((err) => {
				tagsLog.error('batch fetch failed', err);
			});
		}
		return;
	}

	// Tracks come from source_link join when a source is filtered, OR from the
	// specific playlist when one's selected — any playlist: a provider's, a
	// rekordbox one, or a Curator-local one (pinned-search snapshots,
	// Convert-to-WAV "[WAV]" playlists). Folder selection (`currentFolderId`,
	// the rekordbox tree) fans out into every descendant playlist's tracks
	// deduped via the playlistIds union filter. Interested + Basket are
	// global tag filters.
	// Smart playlist short-circuit: if the user has navigated to one (e.g.
	// state restored at boot), we show the "coming soon" watermark instead
	// of running a doomed `tracks:list` call. `currentTracks` stays empty so
	// no stale rows linger.
	const currentPl = playlistIdNow ? library.getPlaylist(playlistIdNow) : undefined;
	if (currentPl?.isSmart) {
		tracksData.setAll([]);
		showSmartPlaylistWatermark(currentPl.name);
		mainTrackList?.update([]);
		return;
	}

	// Folder filter only fires on the tab that surfaces the rb tree.
	// Spotify/Tidal would otherwise inherit a stale folder selection from a
	// prior visit and start serving rekordbox tracks under the wrong source
	// label.
	const folderIdNow = shell.currentFolderId();
	const folderPlaylistIds = folderIdNow && shell.activeSource() === 'rekordbox'
		? gatherDescendantPlaylistIds(folderIdNow)
		: null;
	const tagView = shell.activeView() === 'interested'
		? SYSTEM_TAG_INTERESTED
		: shell.activeView() === 'basket'
			? SYSTEM_TAG_BASKET
			: null;
	const allTracks = await window.api['tracks:list'](
		tagView
			? { tagId: tagView }
			: folderPlaylistIds && folderPlaylistIds.length > 0
				? { playlistIds: folderPlaylistIds }
				// Rekordbox tab root → the DJ-side library: the rekordbox
				// collection plus local files rekordbox doesn't have yet (their
				// rows lack the rekordbox SRC pip). Membership, not `source:`
				// — rb provenance lives in rekordbox_link, not source_link.
				: shell.activeSource() === 'rekordbox' && !playlistIdNow
				? { hasSource: ['rekordbox', 'local'] }
				: {
					source: playlistIdNow ? undefined : shell.activeSource(),
					playlistId: playlistIdNow ?? undefined,
				},
		{ column: state.sortColumn, dir: state.sortDir },
	);
	if (renderSeq !== renderTracksSeq) return; // superseded by a newer render

	// Client-side SRC-filter — applied AFTER the server fetch so toggling
	// "Show Unmatched X" doesn't round-trip the DB. The full set lives in
	// allTracks; tracksById indexes only what's visible.
	const tracks = (() => {
		switch (state.tracksFilter) {
			case 'unmatched-tidal':    return allTracks.filter((t) => !(t.sources ?? []).includes('tidal'));
			case 'unmatched-beatport': return allTracks.filter((t) => !(t.sources ?? []).includes('beatport'));
			case 'with-local':         return allTracks.filter((t) =>  (t.sources ?? []).includes('local'));
			default:                   return allTracks;
		}
	})();

	tracksData.setAll(tracks);

	// Hand the freshly-fetched list to the client-side filter pipeline,
	// which applies the filterbox query (if any) and pushes the result
	// into the component. Selection-pruning happens inside the component
	// when .update() is called.
	mainTracksUnfiltered = tracks;
	applyFilterToMainList();
	// Reorder affordance depends on the new sort + playlist context — re-
	// evaluate now that the data set has been swapped.
	updateReorderableState();

	// Fire-and-forget batch load of tag memberships for the visible page.
	// The 'tags' column renders empty until this resolves, then bumps the
	// resolver via patchOne on each row that now has tags. We don't await
	// — the table is already on screen by this point; the chip cells just
	// pop in once the IPC returns (~5-20ms over a page of ~50-200 tracks).
	if (tracks.length > 0) {
		const ids = tracks.map((t) => t.id);
		tagsStore.ensureTracksLoaded(ids).then(() => {
			// Only re-paint rows whose ids are still the current ones —
			// renderTracks may have been called again in the meantime
			// (sort change, filter switch). patchOne is a no-op for
			// rows that aren't currently mounted. (A `#tag` filter typed
			// before this batch settles is handled inside
			// applyFilterToMainList, which gates tag evaluation on
			// tagsStore.areTracksSettled and re-applies itself.)
			for (const t of tracks) mainTrackList?.patchOne(t);
		}).catch((err) => {
			tagsLog.error('batch fetch failed', err);
		});
	}
}

// Shared resolver for `#name` token evaluation. `#` is a single namespace
// that resolves to either a user/system tag OR a playlist by ascii name
// (union semantics — see the playlist→tag design memo). `hasPlaylistName`
// uses state.playlistsById, which getPlaylists() seeds with every non-hidden
// playlist across all sources, so iterating it covers Spotify + Tidal +
// Rekordbox without a separate cache. Cache the name set per resolver
// instance — the closure dies with the resolver, so playlist add/rename
// since the resolver was constructed is invisible (which is fine for
// per-query usage but means we re-create on each call rather than caching
// globally).
function makeTagResolver(): TagResolver {
	let nameSet: Set<string> | null = null;
	const ensureNameSet = (): Set<string> => {
		if (nameSet) return nameSet;
		const s = new Set<string>();
		for (const p of library.allPlaylists()) s.add(searchFold(p.name));
		nameSet = s;
		return s;
	};
	return {
		idsForTrack: (id) => tagsStore.getTagsForTrack(id),
		nameToId: (name) => tagsStore.resolveTagByName(name)?.id ?? null,
		hasPlaylistName: (ascii) => ensureNameSet().has(ascii),
	};
}

// Mirror the service-side compaction (removeTracksFromPlaylist re-stamps
// surviving rows to playlist_track.position = 0..N-1 after a delete) onto
// the in-memory Track cache so the "#" column updates immediately, without
// waiting for the next getTracks read. Every writer keeps positions 0-based,
// so the pre-splice min callers pass as `base` is 0 whenever the cache holds
// the playlist's first row.
// No-op when playlistPosition is absent (folder/library/tag views).
function compactCurrentPlaylistPositions(base: number): void {
	const withPos = mainTracksUnfiltered.filter((t) => t.playlistPosition != null);
	if (withPos.length === 0) return;
	withPos.sort((a, b) => (a.playlistPosition ?? 0) - (b.playlistPosition ?? 0));
	let next = base;
	for (const t of withPos) {
		t.playlistPosition = next++;
	}
}

// Snapshot the smallest playlistPosition across the current in-memory
// tracks. Returns Infinity when no track in view has a position — the
// caller passes it through to compactCurrentPlaylistPositions which
// then no-ops. Must be called BEFORE the post-delete splice; once the
// deleted rows are gone, deleting the original min can falsely shift
// the base up.
function currentPlaylistPositionBase(): number {
	let base = Infinity;
	for (const t of mainTracksUnfiltered) {
		if (t.playlistPosition != null && t.playlistPosition < base) base = t.playlistPosition;
	}
	return base;
}

// Apply the current filterbox query to the unfiltered cache and push the
// narrowed result into the component. Cheap — pure JS over an already-loaded
// array, no IPC. Tag resolution goes through tagsStore so `#name` runs
// AND together against the per-track tag id set and the per-track playlist
// names (Track.playlistNamesAscii decorated by getTracks).
function applyFilterToMainList(): void {
	if (!mainFilterText.trim()) {
		mainTrackList?.update(mainTracksUnfiltered);
		return;
	}
	const expr = parseQuery(mainFilterText);
	// `#tag` terms evaluate against tagsStore's membership cache. If the
	// current rows' memberships are still in flight (pre-seeded, not
	// fetched), evaluating now paints a wrong — usually empty — result for
	// the IPC round-trip window. Keep the previous paint, wait for the
	// batch to settle, then re-apply. Re-entry is safe: by the time the
	// await resolves areTracksSettled() is true for these ids (or the list
	// was swapped by a newer renderTracks, and the re-check covers it).
	if (collectTagNames(expr).length > 0) {
		const ids = mainTracksUnfiltered.map((t) => t.id);
		if (!tagsStore.areTracksSettled(ids)) {
			void tagsStore.ensureTracksLoaded(ids)
				.then(() => applyFilterToMainList())
				.catch((err) => tagsLog.error('membership load for filter failed', err));
			return;
		}
	}
	const filtered = mainTracksUnfiltered.filter((t) => matchTrack(expr, t, makeTagResolver()));
	mainTrackList?.update(filtered);
}

// Toggle the component's drag-reorder mode based on current sort + playlist
// context. Rule:
//   • Sort must be `index asc` — drag only makes sense when the visible
//     order matches storage order.
//   • A single playlist must be the current scope (not a folder union, not
//     a tag view, not a source view). Reorder operates on playlist_track,
//     which doesn't exist in those other views.
//   • Filterbox must be empty — dragging in a filtered view would map drops
//     against an incomplete neighbour set; surprising more often than useful.
//   • For Spotify/Tidal playlists, the user must have flipped on
//     auto-write-sync AND the provider's capabilities must include reorder.
//     Otherwise a local drag would silently diverge from the upstream
//     ordering (Spotify) or be permanently rejected (Tidal). Rekordbox /
//     local playlists aren't gated by this — they have no upstream to sync
//     against, so writeSync is irrelevant.
function updateReorderableState(): void {
	const sortOk = state.sortColumn === 'index' && state.sortDir === 'asc';
	const playlistOk = !!shell.currentPlaylistId() && !shell.currentFolderId();
	const filterOk = mainFilterText.trim().length === 0;
	const reorderPid = shell.currentPlaylistId();
	const pl = reorderPid ? library.getPlaylist(reorderPid) : null;
	const notSmart = !pl?.isSmart;
	let providerOk = true;
	if (pl && (pl.source === 'spotify' || pl.source === 'tidal')) {
		const src = pl.source as StreamingSource;
		const caps = getSourceCapabilities(src);
		const cfg = getSourceSyncSettings(src);
		providerOk = caps.canReorder && cfg.writeSyncAuto;
	}
	// Grouped rows aren't in playlist order (groups follow the sort, album
	// groups play in album order), so an in-list drop has no clean meaning.
	const ungrouped = uiSettingsSignal().trackGroupBy === 'none';
	mainTrackList?.setReorderable(sortOk && playlistOk && filterOk && notSmart && providerOk && ungrouped);
}

// Returns the columns the user currently has visible, in the user's order.
// Built from the persisted column order (defaulting to ALL_COLUMNS) and the
// per-column visibility flags. Columns with no explicit entry default to
// visible (matches getColumnVisibility's semantics) so a freshly-added
// column appears for everyone; a hidden column keeps its slot in the order
// and reappears there when shown again.
// Two-line rows have a fixed column set (paired fields, the design's order)
// derived from the same per-field visibility.
function currentVisibleColumns(): LayoutColumn[] {
	const similar = isSimilarScope();
	const ui = uiSettingsSignal();
	if (ui.trackRowLines === 2) {
		return twoLineColumns((c) => COLUMN_LOCKED.has(c) || getColumnVisibility(c), { groupBy: ui.trackGroupBy, match: similar });
	}
	return getColumnOrder(ALL_COLUMNS).filter((c) => (c === 'match' ? similar : getColumnVisibility(c)));
}

// Fields visible for the two-line paired columns (locked fields always).
function currentVisibleFields(): ReadonlySet<Column> {
	return new Set(ALL_COLUMNS.filter((c) => COLUMN_LOCKED.has(c) || getColumnVisibility(c)));
}

// Collapsed group keys, per grouping field — session-only memory that
// survives remounts (column / row-mode changes) and scope changes.
const collapsedGroupsBy = new Map<GroupBy, Set<string>>();
function collapsedGroupsFor(by: GroupBy): Set<string> {
	let s = collapsedGroupsBy.get(by);
	if (!s) { s = new Set(); collapsedGroupsBy.set(by, s); }
	return s;
}

// The Match column exists only inside an AI-similarity scope (a JIT whose
// query carries similar:/sounds:). Columns are table structure, so crossing
// that boundary remounts the list; within a scope nothing changes.
let mountedColumns: LayoutColumn[] = [];
// Row mode + grouping the list was mounted with — a remount that changes
// them changes every row's height, so the scroll restore goes by track.
let mountedLayout = '';
function isSimilarScope(): boolean {
	const jit = shell.currentJit();
	return !!jit && hasSimilarTerm(jit.query);
}
function syncMatchColumn(): void {
	if (mountedColumns.includes('match') !== isSimilarScope()) rebuildMainTrackList();
}

// Tear-down + re-mount the main tracklist with the current column set.
// Used by the show/hide-columns menu — column visibility is part of the
// table's HTML structure (colgroup + thead), so changing it cleanly
// requires a fresh mount. We restore scroll position and selection so
// the user doesn't notice the swap.
function rebuildMainTrackList(): void {
	// Capture from the OLD handle before destroy — it's the only source of
	// selection truth now (no state mirror to fall back on).
	const oldScroll = mainTrackList?.getScrollTop() ?? 0;
	const oldSelected = mainTrackList?.getSelectedIds() ?? [];
	const oldAnchor = mainTrackList?.getSelectionAnchor() ?? null;
	const oldLayout = mountedLayout;
	const topIdx = mainTrackList?.getFirstVisibleIndex() ?? -1;
	const oldTopId = topIdx >= 0 ? mainTrackList?.getTracks()[topIdx]?.id ?? null : null;
	mainTrackList?.destroy();
	mountMainTrackList();
	// Re-push current data + selection into the fresh handle.
	applyFilterToMainList();
	updateReorderableState();
	setTrackSelection(oldSelected, oldAnchor);
	// Same geometry → the exact pixel offset; a row-mode / grouping change
	// moves every row, so land on the track that was at the top.
	if (mountedLayout === oldLayout || !oldTopId || !mainTrackList?.scrollToTrack(oldTopId, 'start')) {
		mainTrackList?.setScrollTop(oldScroll);
	}
}

// "Music-source" tab type — Spotify/Tidal/Local source tabs that render a
// single track list. Used to scope keyboard navigation shortcuts (arrows,
// Enter, Ctrl+arrows) so they don't fire inside the Sync/Downloads
// views which have their own keyboard semantics. Interested/Basket are
// workflow tabs (different activeView values) and explicitly excluded for now.
function isMusicSourceView(): boolean {
	return shell.activeView() === 'tracks';
}

// Keyboard navigation through the visible tracks. Collapses multi-selection
// to the directional edge (Down → step from bottom-most, Up → top-most),
// then moves ±1 from there. Empty selection → land on the first row. The
// new row is scrolled into view; the component's setSelectedIds applies
// the highlight, scrollToIndex forces a virt repaint so the row exists in
// the DOM by the time the next paint commits.
function navigateTracks(delta: -1 | 1): void {
	const tracks = getMainTracks();
	if (tracks.length === 0) return;
	const ids = tracks.map((t) => t.id);
	const selected = getSelectedTrackIds();
	let nextIdx: number;
	if (selected.size === 0) {
		nextIdx = 0;
	} else if (selected.size === 1) {
		const cur = ids.indexOf([...selected][0]!);
		nextIdx = cur < 0 ? 0 : clamp(cur + delta, 0, ids.length - 1);
	} else {
		let edge = -1;
		for (const id of selected) {
			const i = ids.indexOf(id);
			if (i < 0) continue;
			if (edge < 0) edge = i;
			else edge = delta > 0 ? Math.max(edge, i) : Math.min(edge, i);
		}
		if (edge < 0) edge = 0;
		nextIdx = clamp(edge + delta, 0, ids.length - 1);
	}
	const id = ids[nextIdx]!;
	setTrackSelection([id], id);
	mainTrackList?.scrollToIndex(nextIdx);
	persistUiState();
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

// Anchor the tracklist for keyboard focus on Tab-return. If the user
// already has a selection, just scroll the first-in-list selected row
// into view (don't disturb their selection). If nothing is selected,
// select the topmost visible row so the next ArrowUp/Down moves from
// somewhere the user can see, instead of jumping to row 0 off-screen.
function anchorTracklistFocus(): void {
	const tracks = getMainTracks();
	if (tracks.length === 0) return;
	const selected = getSelectedTrackIds();
	if (selected.size > 0) {
		const idx = tracks.findIndex((t) => selected.has(t.id));
		if (idx >= 0) mainTrackList?.scrollToIndex(idx);
		return;
	}
	const firstVisible = mainTrackList?.getFirstVisibleIndex() ?? 0;
	const idx = firstVisible >= 0 ? firstVisible : 0;
	const id = tracks[idx]?.id;
	if (!id) return;
	setTrackSelection([id], id);
	mainTrackList?.scrollToIndex(idx);
	persistUiState();
}

// ─── In-place Beatport enrichment ────────────────────────────────────────
// Driven by `sync:progress` events with stage='enriching'. The 'before' phase
// highlights the row + updates the banner; the 'after' phase writes the new
// cell values back into the DOM in place.

function handleEnrichmentEvent(e: NonNullable<SyncProgress['enrichment']>): void {
	// Indicator shows a completion count — items finished, not the iteration
	// position. 'before' fires when a track starts (nothing completed yet for
	// that track), 'after' fires once the match/enrich landed.
	const processed = e.phase === 'after' ? e.index : e.index - 1;
	updateEnrichInline(processed, e.total);

	// Bulk matcher/sync runs are intentionally non-disruptive: no row-level
	// highlight, no auto-scroll. The inline indicator next to the playlist
	// title is the user-visible progress signal; cell values + source pips
	// update in place so the table stays current without any focus motion.
	if (e.phase === 'before') return;

	// phase === 'after' — update the canonical cache, then hand the patched
	// Track to the component for a one-row re-render. The component's
	// patchOne() replaces the <tr> in place via the same row factory used
	// for fresh renders, so the source pip insertion order, key-cell
	// markup, and selection class all stay consistent without per-cell
	// surgery here.
	if (e.result || (e.source === 'tidal' && e.matched)) {
		const cached = tracksData.get(e.trackId);
		if (cached) {
			if (e.result) {
				if (e.result.bpm        != null) cached.bpm        = e.result.bpm;
				if (e.result.keyCamelot != null) cached.keyCamelot = e.result.keyCamelot;
				if (e.result.label      != null) cached.label      = e.result.label;
				if (e.result.genre      != null) cached.genre      = e.result.genre;
			}
			const sources = new Set(cached.sources ?? []);
			if (e.source === 'beatport' && e.result) sources.add('beatport');
			if (e.source === 'tidal' && e.matched)  sources.add('tidal');
			cached.sources = [...sources];
			mainTrackList?.patchOne(cached);
		}
	}
}

// Update the inline indicator next to the playlist title. Visible only when
// the currently-open playlist matches the in-flight enrichment session — so
// switching to another playlist hides it cleanly. The sidebar breathing
// indicator stays put regardless (driven by the `enriching` signal +
// renderPlaylists).
// `processed` is a completion count (0 → total), not the iteration position.
// The sidebar reads only playlistId/source, so patching the count fields in
// place on the session object (rather than reassigning the signal) avoids
// repainting the whole sidebar on every progress tick.
function updateEnrichInline(processed: number, total: number): void {
	const e = enriching();
	if (e) {
		e.processed = processed;
		e.total = total;
	}
	renderEnrichInline();
}

// Idempotent paint of the inline indicator from current state. Called both
// from event handlers (with fresh counts) and from view-switches (to flip
// the indicator on/off based on which playlist is open).
function renderEnrichInline(): void {
	const wrap = document.getElementById('enrich-inline');
	const label = document.getElementById('enrich-inline-label');
	if (!wrap || !label) {
		log.for('enrich-inline').warn('DOM elements missing', { wrap: !!wrap, label: !!label });
		return;
	}
	const e = enriching();
	const show = !!e && shell.currentPlaylistId() === e.playlistId;
	if (!show || !e) {
		wrap.hidden = true;
		return;
	}
	wrap.hidden = false;
	wrap.setAttribute('data-src', e.source);
	const verb = e.source === 'beatport' ? 'ENRICHING' : e.source === 'wav' ? 'CONVERTING' : 'MATCHING';
	// Pad processed-count to match the total's digit count so the indicator's
	// width is stable across "001/137" → "023/137" → "137/137" without
	// jittering.
	const total = e.total ?? 0;
	const processed = e.processed ?? 0;
	const width = String(total).length;
	label.textContent = `${verb} ${String(processed).padStart(width, '0')}/${total}`;
}

// Drops all in-flight enrichment state — clears the session, hides the inline
// indicator, removes the breathing class from the sidebar. Re-renders the
// playlists list so the data-working attribute drops.
function clearEnrichment(): void {
	setEnriching(null);
	const wrap = document.getElementById('enrich-inline');
	if (wrap) wrap.hidden = true;
}

// CSS.escape polyfill — minimal version, only needs to handle the chars that
// can appear in a UUID (none of them are CSS-special, but defensive)
function cssEscape(s: string): string {
	if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
	return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// ─── Context menus ───────────────────────────────────────────────────────
// (Playlist / rb-folder / library-folder / downloads / src-header menus live in
// features/contextMenus.ts; the track-row menus + the shared delete flow live in
// features/trackCommands.ts, derived from a declarative command table. boot()
// wires both with one menuDeps object via initContextMenusFeature +
// initTrackCommands.)

// ─── UI persistence ────────────────────────────────────────────────────────
// Last-viewed playlist, source tab, sort, and the selection anchor are saved
// to localStorage on every state-changing interaction and restored on boot.
// localStorage is per-renderer-origin and survives across app restarts, which
// is good enough for "remember what I was looking at last".

type SourceSlotPersisted = {
	// The tab's last scope. Older sessions stored only `currentPlaylistId`;
	// loadUiState folds that into a playlist scope.
	scope?: TracksScope;
	currentPlaylistId?: string | null;
	selectedTrackIds: string[];
	selectionAnchor: string | null;
};

type Persisted = {
	activeSource: SourceTab;
	sortColumn: SortColumn;
	sortDir: SortDir;
	// Per-source UI snapshots. Live snapshot of state.sourceSlots, but with
	// the *active* source's current top-level fields folded in (since those
	// haven't been captured to the map yet). Loading restores both halves.
	sourceSlots: Partial<Record<SourceTab, SourceSlotPersisted>>;
	// Per-playlist anchor track. Key = playlist.id, value = track.id. Used
	// to scroll the user back to where they were when they re-activate a
	// playlist in a future session.
	playlistAnchors: Record<string, string>;
};

const PERSIST_KEY = 'curator.ui-state.v1';

function persistUiState(): void {
	try {
		// Snapshot the active source's current state + the active playlist's
		// scroll anchor into their maps before serialising. Otherwise a
		// session that ends without a tab/playlist switch loses the most
		// recent context.
		captureSourceState();
		captureCurrentAnchor();
		const slots: Partial<Record<SourceTab, SourceSlotPersisted>> = {};
		for (const [src, slot] of state.sourceSlots) slots[src] = slot;
		const anchors: Record<string, string> = {};
		for (const [pid, tid] of state.playlistAnchors) anchors[pid] = tid;
		const data: Persisted = {
			activeSource: shell.activeSource(),
			sortColumn: state.sortColumn,
			sortDir: state.sortDir,
			sourceSlots: slots,
			playlistAnchors: anchors,
		};
		localStorage.setItem(PERSIST_KEY, JSON.stringify(data));
	} catch (err) {
		log.for('ui-state').warn('persist failed', undefined, err);
	}
}

function loadUiState(): void {
	try {
		const raw = localStorage.getItem(PERSIST_KEY);
		if (!raw) return;
		// Old v1 storage had flat currentPlaylistId/selectionAnchor on the
		// root. New v1 stores per-source slots. Read both shapes so users
		// who had state from before this change don't lose their context.
		const data = JSON.parse(raw) as Partial<Persisted> & Partial<{
			currentPlaylistId: string | null;
			selectionAnchor: string | null;
		}>;
		if (data.activeSource === 'spotify' || data.activeSource === 'tidal' || data.activeSource === 'rekordbox') {
			shell.hydrate({ activeSource: data.activeSource });
		} else if ((data.activeSource as string | undefined) === 'local') {
			// The Local tab was folded into Rekordbox — land there rather than
			// on the Spotify default. (A backup restore can re-seed this too.)
			shell.hydrate({ activeSource: 'rekordbox' });
		}
		if (typeof data.sortColumn === 'string') state.sortColumn = data.sortColumn as SortColumn;
		if (data.sortDir === 'asc' || data.sortDir === 'desc') state.sortDir = data.sortDir;

		if (data.playlistAnchors && typeof data.playlistAnchors === 'object') {
			for (const [pid, tid] of Object.entries(data.playlistAnchors)) {
				if (typeof tid === 'string') state.playlistAnchors.set(pid, tid);
			}
		}
		if (data.sourceSlots && typeof data.sourceSlots === 'object') {
			for (const k of ['spotify', 'tidal', 'rekordbox'] as const) {
				const slot = data.sourceSlots[k];
				if (!slot) continue;
				const scope: TracksScope = slot.scope && typeof slot.scope === 'object' && typeof slot.scope.type === 'string'
					? slot.scope
					: slot.currentPlaylistId ? { type: 'playlist', id: slot.currentPlaylistId } : { type: 'all' };
				state.sourceSlots.set(k, {
					scope,
					selectedTrackIds: Array.isArray(slot.selectedTrackIds) ? slot.selectedTrackIds : [],
					selectionAnchor: slot.selectionAnchor ?? null,
				});
			}
		} else if (typeof data.currentPlaylistId === 'string' || data.currentPlaylistId === null) {
			// v1-flat migration — fold the saved root fields into the active
			// source's slot so the user's last view comes back.
			state.sourceSlots.set(shell.activeSource(), {
				scope: data.currentPlaylistId ? { type: 'playlist', id: data.currentPlaylistId } : { type: 'all' },
				selectedTrackIds: typeof data.selectionAnchor === 'string' ? [data.selectionAnchor] : [],
				selectionAnchor: typeof data.selectionAnchor === 'string' ? data.selectionAnchor : null,
			});
		}
		// Lift the active source's slot into top-level state so the first
		// render sees the right playlist/selection.
		restoreSourceState(shell.activeSource());
	} catch (err) {
		log.for('ui-state').warn('load failed', undefined, err);
	}
}

// ─── Toasts ────────────────────────────────────────────────────────────────
// Small bottom-right notifications. Auto-dismissed; use sparingly — these
// (showToast extracted to ui/toast.ts — F3.0)

// Human-friendly byte size for the downloads view. Picks KB / MB / GB based
// on magnitude with one decimal place — readable both for small AAC files
// and big hi-res FLACs without scrolling the column.
// (formatBytes/escapeHtml extracted to ui/format.ts — F3.0)

// ─── Edit Track modal ──────────────────────────────────────────────────────
// (Form pre-fill / save / per-field reset + key-notation parsing moved to
// features/editTrack.ts — F3.2. The TrackEditModalHandle stays here — boot()
// mounts it and hands a getter to initEditTrackFeature.)

// ─── Sync-to-Rekordbox flow ─────────────────────────────────────────────────
// Drives the modal through its three states: idle → in-flight → either
// completed (toast + close) or verify-failed (Restore-or-Leave).
//
// `running` is polled while the modal is open so closing rekordbox unlocks the
// Sync button live. Tear down on close so the poll doesn't leak.

// A Convert-to-WAV playlist created in rekordbox is re-keyed to `rb_<ID>`
// (it's an rb playlist now). Refresh both sidebar caches and, if the user is
// looking at it, follow it to its new id.
async function followRekeyedPlaylist(oldId: string, newId: string): Promise<void> {
	const wasOpen = shell.currentPlaylistId() === oldId;
	// Same place, new id — every history entry that named it follows.
	navHistory.rewritePlaylistId(oldId, newId);
	await refreshAll();
	await refreshRekordboxTree();
	if (wasOpen) await openPlaylistById(newId, { mode: 'replace' });
}

async function openSyncToRekordboxModal(target: SyncTarget): Promise<void> {
	if (!syncToRekordboxModal) {
		log.for('sync-to-rb').warn('modal not mounted');
		return;
	}
	// Pull initial running state from the read-side detect. The exporter
	// also rejects when rb is open (pyrekordbox raises during commit), but
	// the front-line gate stops the user from getting that far.
	let detected: { dbPath: string | null; running: boolean } = { dbPath: null, running: false };
	try { detected = await window.api['rekordbox:detect'](); }
	catch (err) { log.for('sync-to-rb').warn('detect failed', undefined, err); }

	// Orphaned rb tracks whose local file is gone — surfaced in the modal for
	// one-click cleanup that propagates the delete to rekordbox on this sync.
	let missingFiles: Awaited<ReturnType<typeof window.api['rekordbox:missing-files']>> = [];
	try { missingFiles = await window.api['rekordbox:missing-files'](); }
	catch (err) { log.for('sync-to-rb').warn('missing-files probe failed', undefined, err); }

	// Convert-to-WAV playlists and "Add to Rekordbox" track selections: say
	// up front what the sync will CREATE.
	let createNotice: string | null = null;
	const previewCreate = target.kind === 'playlist' && target.ids[0]
		? () => window.api['rekordbox:create-preview'](target.ids[0]!)
		: target.kind === 'tracks' && target.createMissing
			? () => window.api['rekordbox:create-preview-tracks'](target.ids)
			: null;
	if (previewCreate) {
		try {
			const p = await previewCreate();
			if (p) {
				const parts: string[] = [];
				if (p.tracks > 0) {
					const analysed = p.withAnalysis === 0 ? '' : ` (${p.withAnalysis === p.tracks ? 'all' : p.withAnalysis} with the original's beatgrid, waveform and phrases copied)`;
					parts.push(`${p.tracks} new track${p.tracks === 1 ? '' : 's'}${analysed}`);
				}
				if (p.playlist) parts.push('this playlist');
				const noun = target.kind === 'tracks' ? 'track' : 'member';
				const skipped = p.unplayable > 0 ? ` ${p.unplayable} ${noun}${p.unplayable === 1 ? ' has' : 's have'} no local file and will be skipped.` : '';
				createNotice = `Creates ${parts.join(' and ')} in Rekordbox.${skipped}`;
			}
		} catch (err) { log.for('sync-to-rb').warn('create preview failed', undefined, err); }
	}

	syncToRekordboxModal.open({ ...target, createNotice }, detected.running, missingFiles);

	// Poll detect every 2s so the user closing rekordbox unblocks the Sync
	// button without a re-open. Cleared on close.
	const pollHandle = window.setInterval(async () => {
		if (!syncToRekordboxModal?.isOpen()) {
			window.clearInterval(pollHandle);
			return;
		}
		try {
			const next = await window.api['rekordbox:detect']();
			syncToRekordboxModal?.setRunning(next.running);
		} catch { /* keep last value on transient failure */ }
	}, 2000);

	// Stash so the close path tears it down. Idle-state's onClose fires via
	// the modal's own Cancel handler; we hook that by subscribing to the
	// next setInterval guard above (it auto-clears on !isOpen).
	void pollHandle;
}

// Idle-Sync submit: if the user opted to clean up missing-file orphans,
// delete them FIRST (tombstone + drop link + soft-delete) so their
// content_delete ops ride the very sync we're about to start, then run the
// push. The removal drops rekordbox_link, so a library refresh clears the
// now-orphan rows from the Rekordbox tab immediately.
async function submitSyncToRekordbox(
	target: SyncTarget,
	flags: SyncFlags,
	removeMissingFileIds: string[],
): Promise<void> {
	if (removeMissingFileIds.length > 0) {
		try {
			const { removed } = await window.api['rekordbox:remove-missing-files'](removeMissingFileIds);
			if (removed > 0) { void refreshAll(); }
		} catch (err) {
			// A cleanup failure shouldn't strand the sync — log, toast, continue.
			log.for('sync-to-rb').warn('missing-file cleanup failed', undefined, err);
			showToast('Could not remove missing-file tracks', {
				sub: err instanceof Error ? err.message : String(err),
				kind: 'error',
			});
		}
	}
	startSyncToRekordbox(target, flags);
}

// One function drives both pipeline entries: the initial sync (pull →
// conflicts? → push) and the resume-after-conflicts call (`resolutions`
// present → 'sync:resolve-conflicts'). Both share the export event stream
// for progress/completion and the same toast/verify-failed surfaces.
function startSyncToRekordbox(
	target: SyncTarget,
	flags: SyncFlags,
	resolutions?: Array<{ conflictId: string; choice: 'ours' | 'theirs' }>,
	// rbPlaylistIds the user confirmed via a prior push's "Push anyway" —
	// waives the mass-removal breaker for exactly those playlists. Transient
	// (not part of the persisted SyncFlags), so it never leaks into a later
	// unrelated sync.
	allowMassRemovalFor?: string[],
): void {
	if (!syncToRekordboxModal) return;
	// Flip to in-flight immediately — the first wire event (pull progress
	// on the initial run, push 'started' on the resume) can lag by a
	// second while the sidecar opens the db.
	syncToRekordboxModal.setProgress(resolutions ? 'resolve' : 'pull:open', 0, 1);

	// Subscribe to progress + completion events. Replace any prior listener
	// so a previous run can't repaint THIS modal session.
	syncToRekordboxExportUnsub?.();
	// `outcomeHandled` dedupes the success/fail surface — the exporter
	// emits 'failed' AND throws (so the IPC promise also rejects). Both
	// signals can arrive on the renderer; we only show one toast.
	let outcomeHandled = false;
	syncToRekordboxExportUnsub = window.api.onRekordboxExportEvent((evt) => {
		if (evt.kind === 'started') {
			syncToRekordboxModal?.setProgress('resolve', 0, 1);
		} else if (evt.kind === 'progress') {
			syncToRekordboxModal?.setProgress(evt.phase, evt.done, evt.total);
		} else if (evt.kind === 'completed') {
			outcomeHandled = true;
			const r = evt.result;
			// The re-key is committed Curator-side even when verify fails.
			if (r.created?.rekeyedPlaylistId && target.ids[0]) {
				void followRekeyedPlaylist(target.ids[0], r.created.rekeyedPlaylistId);
			} else if (r.created && r.created.tracksLinked > 0) {
				// "Add to Rekordbox": the rows now carry a rekordbox source —
				// repaint so the badge shows and the menu item drops away.
				void refreshAll().then(() => renderTracks());
			}
			if (r.verifyOk) {
				const tracksTouched = r.tracksWritten + r.cuesWritten + r.tagsWritten + r.playlistsWritten + r.contentDeleted;
				// Three distinct messages so the user can tell apart:
				//   1. Nothing was linked to rb at all (most confusing case
				//      without explicit copy — looks like sync silently did
				//      nothing).
				//   2. Linked but no field changes (genuine no-op — Curator
				//      and rb were already in sync).
				//   3. Real writes landed.
				let title: string;
				let sub: string | undefined;
				if (r.tracksConsidered > 0 && r.tracksConsidered === r.tracksSkippedNotLinked && r.contentDeleted === 0) {
					if (target.kind === 'tracks') {
						title = target.ids.length === 1
							? "Track isn't in Rekordbox"
							: 'None of the selected tracks are in Rekordbox';
					} else {
						title = target.kind === 'folder'
								? 'No tracks under this folder are linked to Rekordbox'
								: 'No tracks in this playlist are linked to Rekordbox';
					}
					sub = 'Run a read sync first to link them.';
				} else if (tracksTouched === 0) {
					title = 'No changes to push';
					const parts: string[] = [];
					if (r.tracksSkippedNotLinked > 0) parts.push(`${r.tracksSkippedNotLinked} skipped (not in Rekordbox)`);
					if (r.tracksUnlinked > 0) parts.push(`${r.tracksUnlinked} stale link${r.tracksUnlinked === 1 ? '' : 's'} removed`);
					if (r.playlistsRemoved > 0) parts.push(`${r.playlistsRemoved} stale playlist${r.playlistsRemoved === 1 ? '' : 's'} removed`);
					sub = parts.length > 0 ? parts.join(' · ') : undefined;
				} else {
					title = 'Synced to Rekordbox';
					const subParts: string[] = [];
					if ((target.kind === 'folder' || target.kind === 'updates') && r.playlistsWritten > 0) {
						subParts.push(`${r.playlistsWritten} playlist${r.playlistsWritten === 1 ? '' : 's'}`);
					}
					if (r.tracksSkippedNotLinked > 0) {
						subParts.push(`${r.tracksSkippedNotLinked} skipped (not in Rekordbox)`);
					}
					// Stale curator-side rows that we pruned because the rb side
					// was gone — surface so the user knows their library got
					// trimmed by the sync (and isn't surprised next time they
					// run a Read sync and see fewer rows).
					if (r.tracksUnlinked > 0) subParts.push(`${r.tracksUnlinked} stale link${r.tracksUnlinked === 1 ? '' : 's'} removed`);
					if (r.playlistsRemoved > 0) subParts.push(`${r.playlistsRemoved} stale playlist${r.playlistsRemoved === 1 ? '' : 's'} removed`);
					if (r.contentDeleted > 0) subParts.push(`${r.contentDeleted} removed from Rekordbox`);
					sub = subParts.length > 0 ? subParts.join(' · ') : undefined;
				}
				// Convert-to-WAV create phase — lead with what was minted.
				if (r.created && (r.created.tracksCreated > 0 || r.created.playlistCreated)) {
					const c = r.created;
					const made = [
						c.tracksCreated > 0 ? `${c.tracksCreated} track${c.tracksCreated === 1 ? '' : 's'} created` : '',
						c.anlzMissing > 0 ? `${c.anlzMissing} will be analysed by Rekordbox` : '',
						c.playlistCreated ? 'playlist created' : '',
					].filter(Boolean).join(' · ');
					title = 'Synced to Rekordbox';
					sub = sub ? `${made} · ${sub}` : made;
				}

				// Safety-guard holds — a hold means the sync REFUSED to
				// delete/reorder something (unlinked members or a mass
				// removal) and the user should look before it can ever
				// propagate. A toast is too fleeting for that decision, so
				// keep the modal open in the held-changes view: it lists the
				// held playlists per reason, carries the success summary
				// inline, and offers "Push removals anyway" for the waivable
				// mass-removal holds (wired to onPushAnyway at mount).
				if (r.removalsHeld.length > 0) {
					syncToRekordboxModal?.setHolds({
						holds: r.removalsHeld,
						summary: { title, sub },
					});
				} else {
					syncToRekordboxModal?.close();
					showToast(title, { sub, kind: 'success' });
				}
				// Per-op write failures get their own toast — same
				// don't-bury-the-signal reasoning as the holds above. These ops
				// were skipped (savepoint rolled back) while the rest of the
				// sync landed; baselines didn't advance, so a re-sync retries
				// them once the cause is fixed.
				if (r.writeFailures.length > 0) {
					const names = r.writeFailures.slice(0, 3)
						.map((f) => f.targetLabel ?? f.target).join(', ');
					showToast(
						`${r.writeFailures.length} item${r.writeFailures.length === 1 ? '' : 's'} failed to sync`,
						{
							sub: `${names}${r.writeFailures.length > 3 ? ', …' : ''} — see log for details`,
							kind: 'error',
							durationMs: 6000,
						},
					);
					log.for('sync-to-rb').warn('partial push failure', { failures: r.writeFailures });
				}
			} else {
				// Verify failed — keep the modal open in the failure view so the
				// user can choose Restore or Leave. Failures + backupPath come
				// from the verify result.
				syncToRekordboxModal?.setVerifyFailed({
					pragmaError: r.verifyPragmaError,
					failures: r.verifyFailures,
					backupPath: r.backupPath,
				});
			}
		} else if (evt.kind === 'failed') {
			// Sidecar error / mid-flow throw. The modal's progress view stays
			// up but the user has no actionable choice — show a toast and
			// close the modal so they don't get stuck.
			outcomeHandled = true;
			syncToRekordboxModal?.close();
			showToast('Sync to Rekordbox failed', {
				sub: evt.message,
				kind: 'error',
			});
		}
	});

	// Fire the IPC. Errors bubble through onSidecarEvent's 'failed' event
	// above; we don't need to .catch() here — but we do clean up the
	// subscription once we know one way or the other.
	const settings = loadRekordboxSettings();
	const wireArgs = {
		targetKind: target.kind,
		targetIds: target.ids,
		flags: {
			syncMetadata: flags.syncMetadata,
			syncCues: flags.syncCues,
			// Read-side ExportFlags type splits Metadata into syncMetadata +
			// syncTags (the writer dispatches separately). The modal bundles
			// them under one checkbox; bind both flags to the same boolean.
			syncTags: flags.syncMetadata,
			// User-controlled via the "Playlists" checkbox in the modal.
			// Effective only when target.kind is one of playlist/folder/
			// updates — the exporter's playlist pass is gated on the same
			// kinds so even if a user somehow set the flag on a 'tracks'
			// target (the modal disables the checkbox there) nothing
			// happens. Default true preserves the previous behavior for
			// playlist/folder/updates targets.
			syncPlaylist: flags.syncPlaylist,
			syncBeatgridPhrases: flags.syncBeatgridPhrases,
			syncWaveform: flags.syncWaveform,
			allowMassRemovalFor,
			// "Add to Rekordbox": create the selected tracks rekordbox lacks
			// before pushing (core ignores it for non-'tracks' targets).
			createMissing: target.kind === 'tracks' && target.createMissing === true,
		},
		key: settings.key ?? undefined,
		dbPathOverride: settings.dbPathOverride ?? undefined,
	};
	const call = resolutions
		? window.api['sync:resolve-conflicts']({ provider: 'rekordbox', resolutions, ...wireArgs })
			.then(() => { /* completion surfaced via the export 'completed' event */ })
		: window.api['rekordbox:sync'](wireArgs).then((outcome) => {
			if (outcome.status === 'conflicts') {
				// Clean pause — nothing was pushed, conflicts are persisted
				// rows. The modal collects decisions and re-enters via
				// onResolve; the event subscription is torn down below and
				// re-created on the resume call.
				outcomeHandled = true;
				syncToRekordboxModal?.setConflicts(outcome.conflicts);
			}
		});
	call.catch((err) => {
		// IPC-level error (e.g. rb-import-in-flight from the service guard,
		// or the exporter throwing before the 'started' event fires).
		// Gated on `outcomeHandled` because the 'failed' event handler
		// above already shows a toast — without this guard the user would
		// see two error toasts for one sync.
		log.for('sync-to-rb').error('IPC rejected', err);
		if (!outcomeHandled) {
			outcomeHandled = true;
			syncToRekordboxModal?.close();
			showToast('Sync to Rekordbox failed', {
				sub: err instanceof Error ? err.message : String(err),
				kind: 'error',
			});
		}
	}).finally(() => {
		syncToRekordboxExportUnsub?.();
		syncToRekordboxExportUnsub = null;
	});
}

async function restoreRekordboxBackup(backupPath: string): Promise<void> {
	const settings = loadRekordboxSettings();
	try {
		await window.api['rekordbox:restore-backup'](backupPath, settings.dbPathOverride ?? undefined);
		showToast('Restored previous Rekordbox database', { kind: 'success' });
	} catch (err) {
		showToast('Restore failed', {
			sub: err instanceof Error ? err.message : String(err),
			kind: 'error',
		});
	}
}

// ─── Sync FROM Rekordbox (scoped pull) ──────────────────────────────────────
// Pull-direction sibling of openSyncToRekordboxModal/startSyncToRekordbox.
// Re-reads a selection (tracks / one playlist / one folder) from master.db and
// merges into Curator (LMW). Progress rides the read-import event stream
// ('rekordbox:event'); conflicts pause for per-row decisions.
async function openSyncFromRekordboxModal(target: PullTarget): Promise<void> {
	if (!syncFromRekordboxModal) {
		log.for('sync-from-rb').warn('modal not mounted');
		return;
	}
	let detected: { dbPath: string | null; running: boolean } = { dbPath: null, running: false };
	try { detected = await window.api['rekordbox:detect'](); }
	catch (err) { log.for('sync-from-rb').warn('detect failed', undefined, err); }

	syncFromRekordboxModal.open(target, detected.running);

	const pollHandle = window.setInterval(async () => {
		if (!syncFromRekordboxModal?.isOpen()) {
			window.clearInterval(pollHandle);
			return;
		}
		try {
			const next = await window.api['rekordbox:detect']();
			syncFromRekordboxModal?.setRunning(next.running);
		} catch { /* keep last value on transient failure */ }
	}, 2000);
	void pollHandle;
}

// Drives both entries: the initial pull (→ conflicts? → done) and the
// resume-after-conflicts call (`resolutions` present → resolve-pull-conflicts).
function startSyncFromRekordbox(
	target: PullTarget,
	flags: PullFlags,
	resolutions?: Array<{ conflictId: string; choice: 'ours' | 'theirs' }>,
): void {
	if (!syncFromRekordboxModal) return;
	syncFromRekordboxModal.setProgress('open', 0, 1);

	syncFromRekordboxImportUnsub?.();
	let outcomeHandled = false;
	// Progress rides the read-import stream. Only the initial pull emits scan
	// events; the resolve path is synchronous DB work.
	if (!resolutions) {
		syncFromRekordboxImportUnsub = window.api.onRekordboxEvent((evt) => {
			if (evt.kind === 'started') syncFromRekordboxModal?.setProgress('open', 0, 1);
			else if (evt.kind === 'progress') syncFromRekordboxModal?.setProgress(evt.phase, evt.done, evt.total);
			// completed/failed are surfaced through the IPC promise below.
		});
	}

	const settings = loadRekordboxSettings();
	const common = {
		key: settings.key ?? undefined,
		dbPathOverride: settings.dbPathOverride ?? undefined,
	};
	// PullFlags → RekordboxFlags. syncMyTags is always false (a per-tag
	// wipe-and-re-add can't be scoped to a track subset); the service enforces
	// this regardless of what we send.
	const wireFlags = {
		syncTracks: flags.syncMetadata,
		syncPlaylists: target.kind === 'tracks' ? false : flags.syncPlaylists,
		syncMyTags: false,
		syncCuesGridsPhrases: flags.syncCuesGridsPhrases,
		syncWaveformPeaks: flags.syncWaveform,
		// History is refreshed on every sync-from; the service forces this on
		// regardless of what we send, so the value here is just the honest default.
		syncHistory: true,
	};

	const call = resolutions
		? window.api['rekordbox:resolve-pull-conflicts']({ resolutions }).then((res) => {
			outcomeHandled = true;
			syncFromRekordboxModal?.close();
			showToast('Applied changes from Rekordbox', {
				sub: `${res.applied} conflict${res.applied === 1 ? '' : 's'} resolved`,
				kind: 'success',
			});
			void refreshAll();
		})
		: window.api['rekordbox:sync-from']({ targetKind: target.kind, targetIds: target.ids, flags: wireFlags, ...common })
			.then((outcome) => {
				if (outcome.status === 'conflicts') {
					// Clean pause — non-conflicting changes already landed; the
					// modal collects decisions and re-enters via onResolve.
					outcomeHandled = true;
					syncFromRekordboxModal?.setConflicts(outcome.conflicts);
					return;
				}
				outcomeHandled = true;
				syncFromRekordboxModal?.close();
				const t = outcome.totals;
				// playlistsDeleted counts too: a scoped pull whose only effect was
				// pruning a folder rekordbox hard-deleted must not read as "up to date".
				const touched = t.tracksUpdated + t.cuesUpserted + t.playlistsUpserted + t.playlistsDeleted
					+ t.waveformsUpserted + t.beatgridsUpserted + t.phrasesUpserted;
				if (target.kind === 'tracks' && t.tracksConsidered === 0) {
					showToast(
						target.ids.length === 1 ? "Track isn't in Rekordbox" : 'None of the selected tracks are in Rekordbox',
						{ sub: 'Run a read sync first to link them.', kind: 'info' },
					);
				} else if (touched === 0) {
					showToast('Already up to date', { sub: 'Nothing changed in Rekordbox', kind: 'info' });
				} else {
					const parts: string[] = [];
					if (t.tracksUpdated > 0) parts.push(`${t.tracksUpdated} track${t.tracksUpdated === 1 ? '' : 's'}`);
					if (t.cuesUpserted > 0) parts.push(`${t.cuesUpserted} cue${t.cuesUpserted === 1 ? '' : 's'}`);
					if (t.playlistsUpserted > 0) parts.push(`${t.playlistsUpserted} playlist${t.playlistsUpserted === 1 ? '' : 's'}`);
					if (t.playlistsDeleted > 0) parts.push(`${t.playlistsDeleted} removed`);
					if (t.waveformsUpserted > 0) parts.push(`${t.waveformsUpserted} waveform${t.waveformsUpserted === 1 ? '' : 's'}`);
					showToast('Synced from Rekordbox', { sub: parts.join(' · ') || undefined, kind: 'success' });
				}
				void refreshAll();
			});

	call.catch((err) => {
		log.for('sync-from-rb').error('IPC rejected', err);
		if (!outcomeHandled) {
			outcomeHandled = true;
			syncFromRekordboxModal?.close();
			showToast('Sync from Rekordbox failed', {
				sub: err instanceof Error ? err.message : String(err),
				kind: 'error',
			});
		}
	}).finally(() => {
		syncFromRekordboxImportUnsub?.();
		syncFromRekordboxImportUnsub = null;
	});
}

// wireTrackEditor retired — backdrop/ESC/close/Enter-traversal moved
// into the TrackEditModal Solid component (layouts/TrackEditModal.tsx).
// Mounted in boot() via mountTrackEditModal().

// Open the rating dialog for an explicit id list. Pre-selects round(avg) of
// the existing ratings (zeros included so a mixed selection still seeds
// somewhere reasonable). Empty selection → no-op so a stray key/menu fire
// doesn't pop an editor that has no target.
function openRatingDialogForTracks(trackIds: string[]): void {
	if (!ratingDialog || trackIds.length === 0) return;
	let sum = 0;
	let count = 0;
	for (const id of trackIds) {
		const t = tracksData.get(id);
		if (!t) continue;
		// Null ratings count as 0 so the dialog opens at a sensible default
		// rather than collapsing to "average of the rated subset only" —
		// the user is choosing one rating to write across the whole set.
		sum += t.rating ?? 0;
		count++;
	}
	const seed = count > 0 ? Math.round(sum / count) : 0;
	ratingDialogTargetIds = [...trackIds];
	ratingDialog.open(seed);
}

// Persist a rating to N tracks, patch the local cache + on-screen rows, and
// surface a toast. Single source of truth for "the rating just changed" —
// used by the modal submit path AND the player's per-star click handler.
// Open the tag picker for an explicit id list. The dialog owns its own
// open lifecycle; this helper just hands the selection over. Empty list is
// a no-op so a stray T keypress with no selection doesn't pop an empty
// editor.
// The Organize modal's unified item list: live user tags (from tagsStore, so
// additions elsewhere reflect) followed by the playlist catalog mapping.
// ITEM IDENTITY IS LOAD-BEARING: the dialog's rows are keyed by item
// reference and permanently mounted, so a rebuilt-but-equivalent item would
// dispose + recreate its row DOM. Tag items fast-path on tagsStore's array
// identity, and when definitions DO reload (refreshAll runs
// loadTagDefinitions(true) constantly), per-id reuse keeps the same object
// for tags whose name/color didn't actually change — only genuinely edited
// tags mint new items and rebuild their rows.
let organizeTagItemsSrc: readonly unknown[] | null = null;
let organizeTagItems: OrganizeItem[] = [];
let organizeTagItemsById = new Map<string, OrganizeItem>();
function buildOrganizeItems(): OrganizeItem[] {
	const tags = tagsStore.getUserTagsSorted();
	if (tags !== organizeTagItemsSrc) {
		organizeTagItemsSrc = tags;
		const nextById = new Map<string, OrganizeItem>();
		organizeTagItems = tags.map((t) => {
			const prev = organizeTagItemsById.get(t.id);
			const color = t.color ?? null;
			const item = prev && prev.name === t.name && prev.color === color
				? prev
				: { id: t.id, kind: 'tag' as const, name: t.name, source: 'local' as const, ownedByMe: true, color };
			nextById.set(t.id, item);
			return item;
		});
		organizeTagItemsById = nextById;
	}
	return [...organizeTagItems, ...organizePlaylistItems];
}

// Inline "Create tag" flow (local): create the row, apply it to the selection
// through the shared commit path, then refresh definitions so the new tag
// enters the user-tag list (its member count is now > 0). Bump so the modal
// repaints with the tag showing as fully applied.
async function createTagAndApply(name: string, trackIds: readonly string[]): Promise<void> {
	try {
		const tag = await window.api['tags:create'](name, null);
		await commitTagChanges(tag.id, [...trackIds], []);
		await tagsStore.refreshTagDefinitions();
		setTagsRev((n) => n + 1);
	} catch (err) {
		showToast('Could not create tag', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
	}
}

// Inline "Create playlist" flow for the Local column (a curator-side local
// playlist — no Rekordbox-native create). createLocalPlaylistFromTracks both creates the playlist and adds the
// selection, so the new row shows fully applied. Splice it into the modal's
// snapshot + membership and bump so it appears without a reopen.
async function createLocalPlaylistAndRefresh(name: string, trackIds: readonly string[]): Promise<void> {
	try {
		const pl = await window.api['playlists:create-local'](name, [...trackIds]);
		organizePlaylistItems = [
			{ id: pl.id, kind: 'playlist', name: pl.name, source: 'local', folderPath: [], ownedByMe: true },
			...organizePlaylistItems,
		];
		for (const tid of trackIds) {
			const set = playlistMembership.get(tid) ?? new Set<string>();
			set.add(pl.id);
			playlistMembership.set(tid, set);
		}
		setPlaylistPickerRev((n) => n + 1);
		void refreshPlaylistsForSyncView();
	} catch (err) {
		showToast('Could not create playlist', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
	}
}

// Inline "Create Spotify playlist" flow: core creates the playlist on the
// user's Spotify account (private), pushes the selection's linked tracks, and
// mirrors it locally — same splice-into-snapshot + bump as the local create so
// the new row appears checked without a reopen. Unlinked tracks can't be on a
// Spotify playlist; they're skipped and warned about, not an error.
async function createSpotifyPlaylistAndRefresh(name: string, trackIds: readonly string[]): Promise<void> {
	try {
		const res = await window.api['playlists:create-streaming']('spotify', name, [...trackIds]);
		const pl = res.playlist;
		organizePlaylistItems = [
			{ id: pl.id, kind: 'playlist', name: pl.name, source: 'spotify', folderPath: [], ownedByMe: true },
			...organizePlaylistItems,
		];
		// Core reports counts, not ids — when some were skipped, read back the
		// real membership so the chip shows an honest k/N.
		const landed = res.skipped === 0
			? trackIds
			: await window.api['tracks:playlists-batch']([...trackIds]).then((m) => trackIds.filter((tid) => (m[tid] ?? []).includes(pl.id)));
		for (const tid of landed) {
			const set = playlistMembership.get(tid) ?? new Set<string>();
			set.add(pl.id);
			playlistMembership.set(tid, set);
		}
		setPlaylistPickerRev((n) => n + 1);
		showToast(`Created “${pl.name}” on Spotify`, {
			sub: `Added ${res.added} track${res.added === 1 ? '' : 's'}`,
			kind: 'success',
			durationMs: 4000,
		});
		if (res.skipped > 0) {
			showToast(`${res.skipped} track${res.skipped === 1 ? '' : 's'} not added to “${pl.name}”`, {
				sub: 'No Spotify id — link the track first.',
				kind: 'error',
				durationMs: 6000,
			});
		}
	} catch (err) {
		showToast('Could not create Spotify playlist', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 6000 });
	} finally {
		// Even on failure: core throws AFTER the remote playlist + its pending
		// mirror exist when the add step fails, so the row must still surface.
		void refreshPlaylistsForSyncView();
		refreshOrganizeCatalog();
	}
}

// Human summary for a bulk association diff — drives the undo toast title.
function describeDiff(what: string, addCount: number, removeCount: number): string {
	if (addCount > 0 && removeCount > 0) return `Updated “${what}” on ${addCount + removeCount} tracks`;
	if (addCount > 0) return `Added “${what}” to ${addCount} tracks`;
	return `Removed “${what}” from ${removeCount} tracks`;
}

// Apply a tag diff for the picker. Splits into add/remove IPCs (the existing
// tracks:add-tag / tracks:remove-tag pair) and bumps tagsStore so every
// subscriber (the dialog itself, the player chip row, the omnibar tag
// counts) re-renders. Single source of truth so the player "+" button and
// per-chip Remove flow share this code path.
//
// Bulk writes (> 1 track) get a 10 s undo toast — one click on a fully-
// checked Organize row strips a tag from the whole selection, and that
// gesture deserves a way back. Undo replays the inverse diff through this
// same function with `undoable: false` so it can't chain.
async function commitTagChanges(
	tagId: string,
	addToTrackIds: readonly string[],
	removeFromTrackIds: readonly string[],
	opts?: { undoable?: boolean },
): Promise<void> {
	if (addToTrackIds.length === 0 && removeFromTrackIds.length === 0) return;
	try {
		// Issue the writes in parallel — the underlying SQLite calls are
		// single-row inserts/deletes that complete in microseconds; we
		// don't need to throttle. Order doesn't matter because adds and
		// removes target disjoint trackId sets by construction.
		await Promise.all([
			...addToTrackIds.map((id) => window.api['tracks:add-tag'](id, tagId)),
			...removeFromTrackIds.map((id) => window.api['tracks:remove-tag'](id, tagId)),
		]);
		tagsStore.applyTagDiff(tagId, addToTrackIds, removeFromTrackIds);
		// Track counts shifted — surface in the sidebar tag counts on the
		// next refresh tick. The lightweight refresh below batches with any
		// other in-flight tag/count update.
		void refreshTagCounts();
		if ((opts?.undoable ?? true) && addToTrackIds.length + removeFromTrackIds.length > 1) {
			const name = tagsStore.getTagById(tagId)?.name ?? 'tag';
			const undoAdd = [...removeFromTrackIds];
			const undoRemove = [...addToTrackIds];
			showToast(describeDiff(name, addToTrackIds.length, removeFromTrackIds.length), {
				kind: 'success',
				durationMs: 10_000,
				action: { label: 'Undo', onClick: () => { void commitTagChanges(tagId, undoAdd, undoRemove, { undoable: false }); } },
			});
		}
	} catch (err) {
		showToast('Tag write failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
	}
}

// Open the unified Organize modal for an explicit id list. Opens
// SYNCHRONOUSLY from the client-side caches — the playlist catalog is kept
// warm by refreshOrganizeCatalog, tag membership is usually already cached
// for visible rows — so the modal never waits on the core sidecar (which can
// be busy for hundreds of ms during a sync/analysis). The per-selection
// membership batch lands async and flips the chips in place; chip WRITES are
// gated on organizeMembershipReady until then so a click can't compute a
// diff from half-loaded membership. Cold-cache fallback (open raced boot):
// await the catalog fetch once, as the old path always did.
async function openOrganizeForTracks(trackIds: string[]): Promise<void> {
	if (!organizeDialog || trackIds.length === 0) return;
	feedPromo = null; // a normal open on real ids — never a deferred session
	const seq = ++organizeOpenSeq;
	try {
		if (library.playlistEntries().length === 0) {
			library.setPlaylistEntries(await window.api['playlists:list-with-folders']());
			if (seq !== organizeOpenSeq) return; // superseded while awaiting
		}
		organizePlaylistItems = mapOrganizePlaylistItems(library.playlistEntries());
		playlistMembership.clear();
		setOrganizeMembershipReady(false);
		setTagsRev((n) => n + 1);
		setPlaylistPickerRev((n) => n + 1);
		organizeDialog.open(trackIds);
		// Multi-select shows the count header — only a single open needs the row.
		if (trackIds.length === 1) void ensureTrackCached(trackIds[0]!);
		void Promise.all([
			window.api['tracks:playlists-batch'](trackIds),
			tagsStore.ensureTracksLoaded(trackIds),
		]).then(([membershipRaw]) => {
			if (seq !== organizeOpenSeq) return; // a newer open owns the maps now
			for (const id of trackIds) {
				playlistMembership.set(id, new Set(membershipRaw[id] ?? []));
			}
			// Ready BEFORE the rev bumps — the dialog's rev-driven recommend
			// effect reads readiness untracked, and this order makes the bump
			// that repaints the chips also schedule the first recommend fetch.
			setOrganizeMembershipReady(true);
			setTagsRev((n) => n + 1);
			setPlaylistPickerRev((n) => n + 1);
		}).catch((err) => {
			showToast('Could not load memberships', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
		});
	} catch (err) {
		showToast('Could not open Organize', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
	}
}

// Background refresh of the client-side playlist catalog (rows + folder
// ancestry) that Organize opens from. Trailing-debounced: sync flows call
// refreshPlaylistsForSyncView per playlist transition, and one catalog fetch
// after the burst settles is enough. On land: store the entries, re-map the
// modal's item list with current auth (ownedByMe), and bump so an OPEN modal
// picks up the change live. Re-mapping mints new item references, so the
// dialog's keyed rows rebuild — refresh-paced, not keystroke-paced, fine.
let organizeCatalogTimer: ReturnType<typeof setTimeout> | null = null;
function refreshOrganizeCatalog(): void {
	if (organizeCatalogTimer) clearTimeout(organizeCatalogTimer);
	organizeCatalogTimer = setTimeout(() => {
		organizeCatalogTimer = null;
		void window.api['playlists:list-with-folders']().then((entries) => {
			library.setPlaylistEntries(entries);
			organizePlaylistItems = mapOrganizePlaylistItems(entries);
			setPlaylistPickerRev((n) => n + 1);
		}).catch((err) => log.for('organize').warn('catalog refresh failed', undefined, err));
	}, 500);
}

// Playlist portion of the Organize modal's item list. "Owned by me" = writeable:
// Rekordbox + local are the user's own libraries so always owned; streaming
// sources compare `ownerId` against the connected account id (missing/
// disconnected → not owned, since we can't push add/remove upstream).
// Per-id identity reuse for the same reason as the tag items above — the
// catalog refreshes in the background (boot, every sync transition batch),
// and an unchanged playlist must keep its item reference or its permanently-
// mounted row rebuilds on every refresh.
let organizePlaylistItemsById = new Map<string, OrganizeItem>();
function mapOrganizePlaylistItems(
	entries: Awaited<ReturnType<(typeof window.api)['playlists:list-with-folders']>>,
): OrganizeItem[] {
	const spotifyMeId = library.auth()?.spotify.id ?? null;
	const tidalMeId = library.auth()?.tidal.id ?? null;
	const nextById = new Map<string, OrganizeItem>();
	const out = entries.map((e) => {
		const folderPath = e.folderPath.map((f) => f.name);
		const ownedByMe = e.playlist.source === 'rekordbox' || e.playlist.source === 'local'
			? true
			: e.playlist.source === 'spotify'
				? !!spotifyMeId && e.playlist.ownerId === spotifyMeId
				: !!tidalMeId && e.playlist.ownerId === tidalMeId;
		const prev = organizePlaylistItemsById.get(e.playlist.id);
		const item = prev
			&& prev.name === e.playlist.name
			&& prev.source === e.playlist.source
			&& prev.ownedByMe === ownedByMe
			&& (prev.folderPath ?? []).join(' ') === folderPath.join(' ')
			? prev
			: {
				id: e.playlist.id,
				kind: 'playlist' as const,
				name: e.playlist.name,
				source: e.playlist.source as OrganizeSource,
				folderPath,
				ownedByMe,
			};
		nextById.set(e.playlist.id, item);
		return item;
	});
	organizePlaylistItemsById = nextById;
	return out;
}

// Open Organize for a not-yet-owned feed track WITHOUT promoting it up front
// (the plain "Organize" action). The modal opens on the provisional FEED_PROMO_ID
// — no library row exists yet — and `session.promote` runs on the first
// membership write (see resolveOrganizeWriteIds). Closing with nothing applied
// rolls the promotion back, so a cancelled Organize leaves no orphan row.
async function openOrganizeForFeedPromotion(session: {
	promote: () => Promise<string>;
	rollback: (trackId: string) => Promise<void>;
}): Promise<void> {
	if (!organizeDialog) return;
	feedPromo = { ...session, realId: null };
	const seq = ++organizeOpenSeq;
	try {
		if (library.playlistEntries().length === 0) {
			library.setPlaylistEntries(await window.api['playlists:list-with-folders']());
			if (seq !== organizeOpenSeq) { return; } // superseded (the newer open reset feedPromo)
		}
		organizePlaylistItems = mapOrganizePlaylistItems(library.playlistEntries());
		// Provisional track carries no memberships — seed empty so the modal
		// paints all-"none" until the user's first apply promotes + aliases.
		// Nothing to fetch, so writes are ready immediately.
		playlistMembership.set(FEED_PROMO_ID, new Set());
		setOrganizeMembershipReady(true);
		setTagsRev((n) => n + 1);
		setPlaylistPickerRev((n) => n + 1);
		organizeDialog.open([FEED_PROMO_ID]);
	} catch (err) {
		feedPromo = null;
		showToast('Could not open Organize', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
	}
}

// The real, editable playlist the tracklist is showing — what "Remove from
// playlist" acts on. Not an rb folder, not a JIT/pinned/search scope, not a
// smart playlist.
function currentEditablePlaylist(): Playlist | null {
	if (shell.activeView() !== 'tracks' || shell.currentFolderId() || shell.currentJit()) return null;
	const pid = shell.currentPlaylistId();
	if (!pid) return null;
	const pl = library.getPlaylist(pid);
	return pl && !pl.isSmart ? pl : null;
}

// Apply a playlist diff. Splits into one add IPC + one remove IPC (each
// already bulk over its trackIds list) and mutates the local membership
// snapshot so the picker's chips refresh without a refetch. Errors surface
// as toasts; partial successes (add succeeded, remove failed) leave the
// snapshot in a partial state but the underlying DB is consistent —
// reopening the picker will re-sync.
//
// Bulk writes (> 1 track) get a 10 s undo toast — a one-click remove-all can
// cascade to a live Spotify playlist, so give it a way back. Undo replays the
// inverse diff (undoable: false so it can't chain); undone removes re-add at
// the playlist tail — original positions aren't restored.
async function commitPlaylistChanges(
	playlistId: string,
	addToTrackIds: readonly string[],
	removeFromTrackIds: readonly string[],
	// toast 'always': show the Undo toast even for a single track — the
	// Remove-from-playlist command's way back after its confirm.
	opts?: { undoable?: boolean; toast?: 'bulk-only' | 'always' },
): Promise<boolean> {
	if (addToTrackIds.length === 0 && removeFromTrackIds.length === 0) return true;
	try {
		const [addRes, removeRes] = await Promise.all([
			addToTrackIds.length > 0 ? window.api['playlists:add-tracks'](playlistId, [...addToTrackIds]) : null,
			removeFromTrackIds.length > 0 ? window.api['playlists:remove-tracks'](playlistId, [...removeFromTrackIds]) : null,
		]);
		const name = library.getPlaylist(playlistId)?.name
			?? organizePlaylistItems.find((p) => p.id === playlistId)?.name
			?? 'playlist';
		const minForToast = opts?.toast === 'always' ? 1 : 2;
		if ((opts?.undoable ?? true) && addToTrackIds.length + removeFromTrackIds.length >= minForToast) {
			const undoAdd = [...removeFromTrackIds];
			const undoRemove = [...addToTrackIds];
			showToast(describeDiff(name, addToTrackIds.length, removeFromTrackIds.length), {
				// rekordbox playlists are curator-side until the user syncs.
				sub: library.getPlaylist(playlistId)?.source === 'rekordbox' ? 'Run Sync to Rekordbox to push the change' : undefined,
				kind: 'success',
				durationMs: 10_000,
				action: { label: 'Undo', onClick: () => { void commitPlaylistChanges(playlistId, undoAdd, undoRemove, { undoable: false }); } },
			});
		}
		// A streaming write that stayed local is not a success, whatever the
		// chip shows — say so. (A month of Spotify adds went missing behind a
		// silently-off write-sync toggle on 2026-09-09.)
		const upstream = addRes?.upstream ?? removeRes?.upstream ?? 'none';
		if (upstream !== 'pushed' && upstream !== 'none') {
			const sub = upstream === 'write-sync-off'
				? 'Push is off for this source — Settings → Connections → "Push local edits immediately". Use the playlist menu\'s "Push local-only tracks" to send it later.'
				: upstream === 'not-owner'
					? 'Not your playlist — the provider would reject the write.'
					: 'The provider rejected the write. Check the log; the playlist menu can retry the push.';
			showToast(`Saved in Curator only — not on ${library.getPlaylist(playlistId)?.source === 'tidal' ? 'Tidal' : 'Spotify'}`, { sub, kind: 'error', durationMs: 8000 });
		}
		const notAdded = new Set(addRes?.noUpstreamTrackIds ?? []);
		if (notAdded.size > 0) {
			showToast(`${notAdded.size} track${notAdded.size === 1 ? '' : 's'} not added to “${name}”`, {
				sub: 'No streaming id for this playlist\'s source — link the track first.',
				kind: 'error',
				durationMs: 6000,
			});
		}
		// Patch the local snapshot. Adds land first, removes after — order
		// only matters for the no-op case (same id in both lists), which
		// the dialog's three-state cycle never produces. Tracks core refused
		// (no provider id) are left out so the chip doesn't claim membership.
		for (const trackId of addToTrackIds) {
			if (notAdded.has(trackId)) continue;
			const set = playlistMembership.get(trackId) ?? new Set<string>();
			set.add(playlistId);
			playlistMembership.set(trackId, set);
		}
		for (const trackId of removeFromTrackIds) {
			const set = playlistMembership.get(trackId);
			if (set) set.delete(playlistId);
		}
		setPlaylistPickerRev((n) => n + 1);
		// Refresh the playlist metadata cache so the sidebar's per-playlist
		// trackCount badge matches the DB. Uses the lightweight sync-view
		// helper since it already fetches `playlists:list` + updates
		// state.playlistsById without forcing a full rerender.
		void refreshPlaylistsForSyncView();
		// If the currently-viewed playlist matches, reflect the diff in the
		// visible tracklist. Removes are applied to the local cache directly
		// (instant — the row vanishes before the picker closes); adds need
		// the full Track row, so we kick a re-fetch.
		if (shell.currentPlaylistId() === playlistId) {
			if (removeFromTrackIds.length > 0) {
				const removedSet = new Set(removeFromTrackIds);
				// Snapshot pre-splice — see compactCurrentPlaylistPositions
				// comment for the base-shift gotcha when min row is removed.
				const base = currentPlaylistPositionBase();
				mainTracksUnfiltered = mainTracksUnfiltered.filter((t) => !removedSet.has(t.id));
				tracksData.removeMany(removedSet);
				if (Number.isFinite(base)) compactCurrentPlaylistPositions(base);
				applyFilterToMainList();
			}
			if (addToTrackIds.length > 0) {
				void renderTracks();
			}
		}
		return true;
	} catch (err) {
		showToast('Playlist write failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
		return false;
	}
}

// Dragged track rows dropped on a sidebar playlist. Same semantics as
// checking that playlist in the Organize modal: resolve current membership
// first so only the MISSING tracks are written — that keeps the toast counts
// honest and, more importantly, keeps the bulk-undo precise (undoing a drop
// must not strip tracks that were already in the playlist before it). The
// write then routes through commitPlaylistChanges so the membership
// snapshot, sidebar counts, and the visible tracklist all refresh the same
// way. The sidebar already gates smart/non-owned rows visually; re-checked
// here because this is the write boundary.
async function handleTracksDroppedOnPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
	const pl = library.getPlaylist(playlistId);
	if (!pl || trackIds.length === 0) return;
	if (pl.isSmart) {
		showToast('Smart playlist', { sub: 'Membership is rule-derived — tracks can\'t be added.', kind: 'error', durationMs: 4000 });
		return;
	}
	if (pl.source === 'spotify' || pl.source === 'tidal') {
		const meId = pl.source === 'spotify' ? library.auth()?.spotify.id : library.auth()?.tidal.id;
		if (!meId || pl.ownerId !== meId) {
			showToast('Can\'t add to this playlist', { sub: 'Owned by another user.', kind: 'error', durationMs: 4000 });
			return;
		}
	}
	try {
		const membershipRaw = await window.api['tracks:playlists-batch'](trackIds);
		const missing = trackIds.filter((id) => !(membershipRaw[id] ?? []).includes(playlistId));
		if (missing.length === 0) {
			showToast(
				trackIds.length === 1 ? `Already in “${pl.name}”` : `All ${trackIds.length} already in “${pl.name}”`,
				{ kind: 'info', durationMs: 2500 },
			);
			return;
		}
		const ok = await commitPlaylistChanges(playlistId, missing, []);
		// commitPlaylistChanges only toasts bulk writes (undo affordance);
		// a drop needs visible feedback even for a single track.
		if (ok && missing.length === 1) {
			showToast(`Added to “${pl.name}”`, { kind: 'success', durationMs: 2500 });
		}
	} catch (err) {
		showToast('Drop failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
	}
}

async function commitRating(trackIds: string[], rating: number | null): Promise<void> {
	if (trackIds.length === 0) return;
	try {
		const updated = await window.api['tracks:set-rating'](trackIds, rating);
		// Replace cached rows so subsequent renders use the fresh rating —
		// the wire returns full Track rows with overrides applied, so this
		// is a safe wholesale swap, not a per-field merge.
		// Store writes bump the cache rev — NowPlayingCard repaints reactively.
		tracksData.upsertMany(updated);
		for (const t of updated) mainTrackList?.patchOne(t);
		// Keep the player's now-playing snapshot in step so a rating edit shows
		// live even when the playing row has left the visible cache (removed
		// from the current playlist). No-op unless an id matches what's playing.
		for (const t of updated) player.patchCurrentTrack(t.id, { rating: t.rating });
		const label = rating == null ? 'Rating cleared' : `Rated ${rating}★`;
		const sub = trackIds.length === 1 ? undefined : `${trackIds.length} tracks`;
		showToast(label, { sub, kind: 'success', durationMs: 2000 });
	} catch (err) {
		showToast('Rating failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
	}
}

// Drive omnibar pick events. Track picks send the visible result list as the
// playback queue; playlist picks navigate the sidebar (switching activeSource
// when needed) and load the playlist's tracks. Kept in main.ts because both
// behaviours touch the global state object + IPC surface that omnibar.ts
// deliberately doesn't import.
function wireOmnibar(): void {
	mountOmnibar({
		getPlaylists: () => library.allPlaylists(),
		getRekordboxTree: () => library.rekordboxTree(),
		isSourceEnabled: (src) => {
			if (src === 'spotify') return !!library.auth()?.spotify.connected;
			if (src === 'tidal') return !!library.auth()?.tidal.connected;
			// The Rekordbox pill covers local files too, so a watched folder
			// alone is enough to make it worth showing.
			if (src === 'rekordbox') return library.rekordboxTree().playlists.length > 0 || library.libraryFolders().length > 0;
			return false;
		},
		onPickTrack: (track, list) => {
			shell.notePlaybackOrigin();
			player.play(track, list).catch((err) => {
				if (err instanceof player.TidalNotReadyError) {
					showToast('Tidal playback', { sub: 'Coming soon', kind: 'info' });
				} else {
					log.for('omnibar').error('play failed', err);
					showToast('Playback failed', { sub: String(err?.message ?? err), kind: 'error' });
				}
			});
		},
		onPickPlaylist: async (pl) => {
			await openPlaylistById(pl.id);
		},
		onPickFolder: async (folder) => {
			await openFolderById(folder.id);
		},
		onLoadAsJit: async (query, name, selectTrackId) => {
			// Re-running a query that's already pinned (verbatim) should light
			// the pin + select its nav row — match by query string.
			const existing = pinnedSearches().find((p) => p.query === query);
			await enterJitScope({ name, query, pinnedId: existing?.id }, selectTrackId ?? undefined);
		},
	});
}

// Open the omnibar, warming the Rekordbox tree first. The omnibar searches
// the tree globally (jump to any RB folder/playlist from any tab), but the
// tree is lazy-loaded — so on a Spotify/Tidal session it may not be in memory
// yet. Fire-and-forget: the fetch resolves while the user types, and the
// next query pass reads the now-populated tree.
function openOmnibarLazy(): void {
	if (!rekordboxTreeLoaded) void ensureRekordboxTree();
	openOmnibar();
}

// Navigate to a rekordbox folder (omnibar pick): a history navigation to
// the folder scope under the Rekordbox tab, plus the sidebar courtesy of
// expanding every ancestor so the activated row is actually visible.
async function openFolderById(folderId: string): Promise<void> {
	if (!rekordboxTreeLoaded) await ensureRekordboxTree();
	const folder = library.rekordboxTree().folders.find((f) => f.id === folderId);
	if (!folder) return;
	expandRbAncestors(folderId);
	scrollSidebarTo(`.playlist[data-rb-folder-id="${cssEscape(folderId)}"]`);
	await navigate({ kind: 'tracks', source: 'rekordbox', scope: { type: 'folder', id: folderId } });
}

// Walk a rekordbox node's parent chain and mark each ancestor folder open.
// `nodeId` may be a folder OR a playlist id — for playlists we look up the
// playlist's parentFolderId via library.getPlaylist since they live in a
// separate flat list from folders. Collects every ancestor into one new Set
// so the rekordboxExpanded signal fires once (not per ancestor).
function expandRbAncestors(nodeId: string): void {
	const folderById = new Map(library.rekordboxTree().folders.map((f) => [f.id, f]));
	let parentId: string | null = null;
	const asFolder = folderById.get(nodeId);
	if (asFolder) {
		parentId = asFolder.parentFolderId ?? null;
	} else {
		const pl = library.getPlaylist(nodeId);
		parentId = pl?.parentFolderId ?? null;
	}
	const next = new Set(rekordboxExpanded());
	while (parentId) {
		next.add(parentId);
		const p: PlaylistFolder | undefined = folderById.get(parentId);
		parentId = p?.parentFolderId ?? null;
	}
	setRekordboxExpanded(next);
	saveRekordboxExpanded(next);
}

// Scroll the sidebar so the matched row is visible. Uses rAF so we run
// after the reactive sidebar re-render has been committed to the DOM.
// Tolerates the row not being mounted (e.g. caller picked a folder under a
// source that hasn't loaded its tree yet) — `scrollIntoView` on null is a
// no-op because we guard with `?.`.
function scrollSidebarTo(selector: string): void {
	requestAnimationFrame(() => {
		const el = document.querySelector<HTMLElement>(`#playlists ${selector}`);
		el?.scrollIntoView({ block: 'nearest' });
	});
}

// Navigate to a playlist by id (omnibar pick, Navigate to ▶ playlist entries,
// post-create follows). A history navigation under the playlist's own tab —
// Rekordbox playlists AND Curator-local playlists (pinned-search snapshots,
// Convert-to-WAV "[WAV]" playlists; the sidebar's Curator section) live under
// 'rekordbox', provider playlists under their tab — plus the sidebar
// courtesies: ancestors expanded, row scrolled into view.
async function openPlaylistById(id: string, opts: { mode?: 'push' | 'replace'; drill?: boolean } = {}): Promise<void> {
	const pl = library.getPlaylist(id);
	if (!pl) return;
	const srcMap: Record<string, SourceTab> = { spotify: 'spotify', tidal: 'tidal', rekordbox: 'rekordbox', local: 'rekordbox' };
	const source = srcMap[pl.source] ?? shell.activeSource();
	// Rekordbox playlists can sit several folder levels deep; flat playlists
	// (Spotify / Tidal) don't have a parent chain to expand.
	if (pl.source === 'rekordbox') expandRbAncestors(id);
	scrollSidebarTo(`.playlist[data-id="${cssEscape(id)}"]`);
	await navigate({ kind: 'tracks', source, scope: { type: 'playlist', id } }, opts);
}


// ─── Top-right source-contextual actions ─────────────────────────────────

// Accepts the auth status as an argument so a refreshAll pass doesn't need
// to refetch it (refreshAll already calls auth:status once at the top).
// When called outside refreshAll (e.g. after a connect/disconnect), passes
// no arg and refetches — same behaviour as before.
async function renderTopRight(auth?: AuthStatus): Promise<void> {
	const wrap = document.getElementById('src-actions');
	if (!wrap) return;
	if (!auth) auth = await window.api['auth:status']();
	const src = shell.activeSource();

	if (src === 'rekordbox') {
		// Rekordbox has no auth surface — it reads master.db locally. The
		// top-right action just opens the Rekordbox tab in settings where the
		// user can pick the master.db, run an incremental read, etc.
		wrap.innerHTML = `
			<button class="src-btn" data-action="open-rekordbox-settings" title="Configure + read Rekordbox library">
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>
				<span class="src-name">Rekordbox settings…</span>
			</button>
		`;
		wrap.querySelectorAll<HTMLButtonElement>('[data-action="open-rekordbox-settings"]').forEach((btn) => {
			btn.addEventListener('click', () => openSettingsModal('rekordbox'));
		});
		return;
	}

	// Spotify / Tidal — both keyed on AuthStatus.
	const connected = auth[src].connected;
	const displayName = auth[src].displayName ?? (src === 'spotify' ? 'Spotify' : 'Tidal');

	if (!connected) {
		wrap.innerHTML = `
			<button class="src-btn disconnected" data-src="${src}" data-action="connect">
				<span class="src-dot"></span>
				<span class="src-name">${src === 'spotify' ? 'Spotify' : 'Tidal'}</span>
				<span class="src-meta">CONNECT</span>
			</button>
		`;
	} else {
		wrap.innerHTML = `
			<button class="src-btn" data-src="${src}" data-action="profile" title="Double-click to disconnect">
				<span class="src-dot"></span>
				<span class="src-name">${escapeHtml(displayName)}</span>
				<span class="src-meta">CONNECTED</span>
			</button>
			<button id="sync-btn" class="src-btn" data-src="${src}" data-action="sync" title="Sync ${src}">
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-3.4-7"/><path d="M21 4v5h-5"/></svg>
				<span class="src-name">Sync</span>
			</button>
		`;
	}

	// rebind events for the new buttons
	wrap.querySelectorAll<HTMLButtonElement>('[data-action="connect"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const s = btn.dataset.src as 'spotify' | 'tidal';
			btn.classList.add('connecting');
			try {
				await window.api[`auth:${s}:start`]();
			} catch (err) {
				log.for('auth').error(`${s} auth failed`, err);
			} finally {
				await refreshAll();
			}
		});
	});
	wrap.querySelectorAll<HTMLButtonElement>('[data-action="profile"]').forEach((btn) => {
		// Double-click on the connected pill disconnects. Single clicks fall
		// through so the user can press it accidentally without losing their
		// session — only the deliberate double-click commits.
		btn.addEventListener('dblclick', async (evt) => {
			evt.preventDefault();
			const s = btn.dataset.src as 'spotify' | 'tidal';
			const label = s === 'spotify' ? 'Spotify' : 'Tidal';
			if (!window.confirm(`Disconnect ${label}?\n\nYour synced tracks stay; you'll need to reconnect to sync again or play tracks in-app.`)) return;
			await window.api[`auth:${s}:disconnect`]();
			showToast(`${label} disconnected`, { kind: 'info' });
			await refreshAll();
		});
	});
	wrap.querySelectorAll<HTMLButtonElement>('[data-action="sync"]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const s = btn.dataset.src as 'spotify' | 'tidal';
			if (s === 'tidal') {
				// Tidal sync runs in the background with toast + tab-indicator
				// feedback only — the Sync view's row machinery (retry loop,
				// plan-and-confirm deletes) is Spotify-shaped and Tidal's
				// smaller surface doesn't need it yet.
				void runTidalSyncNow();
				return;
			}
			// Header SYNC button is navigational — it opens the sync view (its
			// own tab, history-wise; the region seeds its rows from the
			// playlists cache on mount / re-entry). The actual sync trigger
			// lives inside the view as "Sync Now".
			void switchToTab('sync', () => ({ kind: 'sync' }));
		});
	});
}

// ─── Tidal sync trigger ─────────────────────────────────────────────────────
// One in-flight run at a time; core's scheduler mutex would reject an overlap
// anyway ("tidal sync already in progress") — this just gives a friendlier
// path. Progress lands via onSyncProgress (source:'tidal') → the Tidal tab's
// breathing indicator; completion refreshes the whole UI so the sidebar picks
// up the new playlists.
let tidalSyncInFlight = false;
async function runTidalSyncNow(opts: { force?: boolean } = {}): Promise<void> {
	if (tidalSyncInFlight) {
		showToast('Tidal sync already running', { kind: 'info' });
		return;
	}
	tidalSyncInFlight = true;
	try {
		const res = await window.api['sync:tidal:run'](opts);
		showToast('Tidal synced', {
			sub: `${res.playlists} playlist${res.playlists === 1 ? '' : 's'} · ${res.tracksUpserted} tracks`,
			kind: 'success',
		});
		await refreshAll();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		showToast('Tidal sync failed', { sub: msg, kind: 'error', durationMs: 6000 });
	} finally {
		tidalSyncInFlight = false;
	}
}

// ─── Source-tab right-click menus ──────────────────────────────────────────
// Each source tab opens its OWN menu of source-level actions — the right-click
// peer of the top-right action buttons renderTopRight paints. Routed through
// TopFrame's onSourceContextMenu; the `contextual` flag on each SourceTabDef
// gates which tabs accept the gesture. Kept beside renderTopRight since they
// surface the same per-source operations (connect/sync/folders/read).

// Spotify — connection-keyed. Connected: sync + disconnect. Disconnected:
// connect. Both states expose the shared Connections settings panel. Mirrors
// the connect / disconnect / sync flows in renderTopRight so behaviour stays
// identical.
function showSpotifyTabMenu(evt: MouseEvent): void {
	const connected = !!library.auth()?.spotify.connected;
	const items: ContextMenuItem[] = [{ kind: 'header', label: 'Spotify' }];
	const handlers: Record<string, () => void | Promise<void>> = {};
	if (connected) {
		items.push({
			kind: 'item', id: 'sync', label: 'Sync from Spotify',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-3.4-7"/><path d="M21 4v5h-5"/></svg>',
		});
		handlers.sync = () => { void switchToTab('sync', () => ({ kind: 'sync' })); };
		items.push({ kind: 'divider' });
		items.push({
			kind: 'item', id: 'disconnect', label: 'Disconnect Spotify', danger: true,
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M18.4 5.6 5.6 18.4"/><path d="M9 7 7 5a3 3 0 0 0-4 4l2 2M15 17l2 2a3 3 0 0 0 4-4l-2-2"/></svg>',
		});
		handlers.disconnect = async () => {
			if (!window.confirm('Disconnect Spotify?\n\nYour synced tracks stay; you\'ll need to reconnect to sync again or play tracks in-app.')) return;
			await window.api['auth:spotify:disconnect']();
			showToast('Spotify disconnected', { kind: 'info' });
			await refreshAll();
		};
	} else {
		items.push({
			kind: 'item', id: 'connect', label: 'Connect Spotify',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7 7 5a3 3 0 0 0-4 4l2 2M15 17l2 2a3 3 0 0 0 4-4l-2-2"/><path d="m8.5 15.5 7-7"/></svg>',
		});
		handlers.connect = async () => {
			try { await window.api['auth:spotify:start'](); }
			catch (err) { log.for('auth').error('spotify auth failed', err); }
			finally { await refreshAll(); }
		};
	}
	items.push({ kind: 'divider' });
	items.push({
		kind: 'item', id: 'settings', label: 'Connection settings…',
		iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8 1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2 2 2 0 1 1-2.8-2.8A1.7 1.7 0 0 0 4.6 13 2 2 0 1 1 4.6 9a1.7 1.7 0 0 0 1.1-2.9 2 2 0 1 1 2.8-2.8A1.7 1.7 0 0 0 11 4.6 2 2 0 1 1 15 4.6a1.7 1.7 0 0 0 2.9 1.1 2 2 0 1 1 2.8 2.8A1.7 1.7 0 0 0 19.4 11Z"/></svg>',
	});
	handlers.settings = () => openSettingsModal('connections');
	openContextMenu(items, handlers, { at: evt });
}

// Tidal — same connection-keyed shape as Spotify, minus the Sync-view hop:
// the sync trigger fires directly (background run, toast + tab indicator).
function showTidalTabMenu(evt: MouseEvent): void {
	const connected = !!library.auth()?.tidal.connected;
	const items: ContextMenuItem[] = [{ kind: 'header', label: 'Tidal' }];
	const handlers: Record<string, () => void | Promise<void>> = {};
	if (connected) {
		items.push({
			kind: 'item', id: 'sync', label: 'Sync from Tidal',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-3.4-7"/><path d="M21 4v5h-5"/></svg>',
		});
		handlers.sync = () => { void runTidalSyncNow(); };
		items.push({ kind: 'divider' });
		items.push({
			kind: 'item', id: 'disconnect', label: 'Disconnect Tidal', danger: true,
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M18.4 5.6 5.6 18.4"/><path d="M9 7 7 5a3 3 0 0 0-4 4l2 2M15 17l2 2a3 3 0 0 0 4-4l-2-2"/></svg>',
		});
		handlers.disconnect = async () => {
			if (!window.confirm('Disconnect Tidal?\n\nYour synced tracks stay; you\'ll need to reconnect to sync again.')) return;
			await window.api['auth:tidal:disconnect']();
			showToast('Tidal disconnected', { kind: 'info' });
			await refreshAll();
		};
	} else {
		items.push({
			kind: 'item', id: 'connect', label: 'Connect Tidal',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7 7 5a3 3 0 0 0-4 4l2 2M15 17l2 2a3 3 0 0 0 4-4l-2-2"/><path d="m8.5 15.5 7-7"/></svg>',
		});
		handlers.connect = async () => {
			try { await window.api['auth:tidal:start'](); }
			catch (err) { log.for('auth').error('tidal auth failed', err); }
			finally { await refreshAll(); }
		};
	}
	items.push({ kind: 'divider' });
	items.push({
		kind: 'item', id: 'settings', label: 'Connection settings…',
		iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8 1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2 2 2 0 1 1-2.8-2.8A1.7 1.7 0 0 0 4.6 13 2 2 0 1 1 4.6 9a1.7 1.7 0 0 0 1.1-2.9 2 2 0 1 1 2.8-2.8A1.7 1.7 0 0 0 11 4.6 2 2 0 1 1 15 4.6a1.7 1.7 0 0 0 2.9 1.1 2 2 0 1 1 2.8 2.8A1.7 1.7 0 0 0 19.4 11Z"/></svg>',
	});
	handlers.settings = () => openSettingsModal('connections');
	openContextMenu(items, handlers, { at: evt });
}

// OS folder picker → watch it → background scan. The quick path shared by
// the Rekordbox tab menu and its onboarding CTA; Settings → Library has its
// own copy (libraryPanel.ts) that also repaints the folder panel.
async function addLibraryFolderFlow(): Promise<void> {
	try {
		const path = await window.api['dialog:pick-folder']();
		if (!path) return;
		await window.api['library:add-folder'](path);
		await refreshAll();
	} catch (err) {
		showToast('Could not add folder', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 6000 });
	}
}

// Rekordbox — read the master.db library, push updates back, manage the
// watched folders whose files show here, open settings.
function showRekordboxTabMenu(evt: MouseEvent): void {
	const settings = loadRekordboxSettings();
	const items: ContextMenuItem[] = [
		{ kind: 'header', label: 'Rekordbox' },
		{
			kind: 'item', id: 'read-incremental', label: 'Read library (incremental)',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-3.4-7"/><path d="M21 4v5h-5"/></svg>',
		},
		{
			kind: 'item', id: 'read-full', label: 'Full re-read',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/></svg>',
		},
		{ kind: 'divider' },
		{
			// "Sync updates" is the write-side mirror of incremental read — opens
			// the standard sync modal so the user picks what to push, then resolves
			// server-side via targetKind:'updates'.
			kind: 'item', id: 'sync-updates', label: 'Sync updates to Rekordbox…',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m9 17 3 3 3-3"/><path d="M12 4v16"/><rect x="4" y="3" width="16" height="4" rx="1"/></svg>',
		},
		{ kind: 'divider' },
		{
			// Local files live on this tab too — the watched folders they come
			// from are managed in Settings → Library; this is the quick add.
			kind: 'item', id: 'add-folder', label: 'Add music folder…',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7l-2-2H5a2 2 0 0 0-2 2z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
		},
		{
			kind: 'item', id: 'library-folders', label: 'Library folders…',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7l-2-2H5a2 2 0 0 0-2 2z"/></svg>',
		},
		{ kind: 'divider' },
		{
			kind: 'item', id: 'settings', label: 'Rekordbox settings…',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/></svg>',
		},
	];
	openContextMenu(items, {
		'read-incremental': () => startRekordboxImport('incremental', settings),
		'read-full':        () => {
			if (!window.confirm('Re-read the entire Rekordbox library? On a large library this can take several minutes.')) return;
			startRekordboxImport('full', settings);
		},
		'sync-updates':     () => {
			// `ids` is ignored by the 'updates' resolver but the SyncTarget shape
			// requires it; pass an empty array. displayName doubles as the subhead.
			void openSyncToRekordboxModal({ kind: 'updates', ids: [], displayName: 'Updates since last sync' });
		},
		'add-folder':       () => { void addLibraryFolderFlow(); },
		'library-folders':  () => openSettingsModal('library'),
		'settings':         () => openSettingsModal('rekordbox'),
	}, { at: evt });
}

// ─── Per-tab empty states ─────────────────────────────────────────────────

function renderEmptyState(
	auth: { spotify: { connected: boolean }; tidal: { connected: boolean } },
	hasPlaylistsForActive: boolean,
): boolean {
	const el = document.getElementById('tab-empty');
	const tracksView = document.getElementById('tracks-view');
	if (!el || !tracksView) return false;

	const src = shell.activeSource();
	let show = false;
	let html = '';

	if (src === 'spotify') {
		if (!auth.spotify.connected) {
			show = true;
			html = `
				<div class="tab-empty__mark"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" opacity="0.15"/><path d="M7.5 9.5c2.6-.8 6.2-.7 9 .9M8 12.5c2-.6 5.1-.5 7.4.9M8.4 15.4c1.6-.4 4-.4 5.8.8" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg></div>
				<div class="tab-empty__title">Connect Spotify</div>
				<div class="tab-empty__sub">Sync your playlists, Liked Songs, and saved albums. We'll enrich every track with BPM, key, label, and genre from Beatport.</div>
				<button class="tab-empty__cta" data-src="spotify" data-action="connect">Connect Spotify</button>
			`;
		} else if (!hasPlaylistsForActive) {
			show = true;
			html = `
				<div class="tab-empty__mark"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" opacity="0.15"/><path d="M7.5 9.5c2.6-.8 6.2-.7 9 .9" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg></div>
				<div class="tab-empty__title">No Spotify data yet</div>
				<div class="tab-empty__sub">You're connected. Click Sync to pull your playlists.</div>
				<button class="tab-empty__cta" data-src="spotify" data-action="sync">Sync now</button>
			`;
		}
	} else if (src === 'tidal') {
		if (!auth.tidal.connected) {
			show = true;
			html = `
				<div class="tab-empty__mark"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M3 8l4-4 4 4-4 4zM13 8l4-4 4 4-4 4-4-4zM8 13l4-4 4 4-4 4z" opacity="0.7"/></svg></div>
				<div class="tab-empty__title">Connect Tidal</div>
				<div class="tab-empty__sub">Source of lossless audio. Sign in with your normal Tidal account in the popup and Curator will capture your session.</div>
				<button class="tab-empty__cta" data-src="tidal" data-action="connect">Connect Tidal</button>
			`;
		} else if (!hasPlaylistsForActive) {
			show = true;
			html = `
				<div class="tab-empty__mark"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M3 8l4-4 4 4-4 4z"/></svg></div>
				<div class="tab-empty__title">No Tidal data yet</div>
				<div class="tab-empty__sub">You're connected. Click Sync to pull your Tidal playlists and their tracks.</div>
				<button class="tab-empty__cta" data-src="tidal" data-action="sync">Sync now</button>
			`;
		}
	} else if (src === 'rekordbox') {
		// Tri-state, keyed off the lazy-fetch status rather than the tree alone —
		// the tree is empty both while loading AND when genuinely unimported, and
		// those must look different. 'loaded' shows neither (the tracks view, or
		// the sidebar tree waiting for a playlist click, takes over). An
		// unimported library with local files already watched also shows the
		// tracks view — the root lists those files — so onboarding only takes
		// over when BOTH halves of the DJ-side library are empty.
		const st = rekordboxLoadState();
		const hasLocalTracks = library.sourceCounts().local > 0;
		if (st === 'loading') {
			// Fetch in flight: a neutral spinner, never the import CTA — we don't
			// yet know whether a library exists. (Reuses the `spin` keyframe.)
			show = true;
			html = `
				<div class="tab-empty__mark"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation: spin 0.8s linear infinite"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"/></svg></div>
				<div class="tab-empty__title">Loading your Rekordbox library…</div>
				<div class="tab-empty__sub">Reading your playlists, hot cues, beatgrids, and tags.</div>
			`;
		} else if (st === 'empty' && !hasLocalTracks) {
			// Confirmed unimported and nothing on disk yet. Once either lands
			// this never shows again — the tracks view takes over.
			show = true;
			html = `
				<div class="tab-empty__mark"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg></div>
				<div class="tab-empty__title">Set up your library</div>
				<div class="tab-empty__sub">Read your Rekordbox library — playlists, hot cues, beatgrids, MyTags and ratings, with per-field toggles for who wins on conflict — or watch a folder of FLAC, M4A or WAV files. Both show here; files Rekordbox doesn't have yet simply lack its mark.</div>
				<div class="tab-empty__ctas">
					<button class="tab-empty__cta" data-action="open-rekordbox-settings">Open Rekordbox settings…</button>
					<button class="tab-empty__cta" data-action="add-library-folder">Add a music folder…</button>
				</div>
			`;
		}
	}

	el.dataset.source = src;
	el.innerHTML = html;
	// Content only — visibility (panel vs table, gated to the tracks view)
	// derives from this signal inside the region effect, so this async
	// repaint can never mis-render whatever view is active by the time it
	// completes.
	shell.setEmptyState(show ? { kind: 'onboarding', source: src } : null);

	if (show) {
		el.querySelectorAll<HTMLButtonElement>('[data-action="connect"]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const s = btn.dataset.src as 'spotify' | 'tidal';
				try {
					await window.api[`auth:${s}:start`]();
				} catch (err) {
					log.for('auth').error(`${s} auth failed`, err);
				} finally {
					await refreshAll();
				}
			});
		});
		el.querySelectorAll<HTMLButtonElement>('[data-action="sync"]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				if (btn.dataset.src === 'tidal') {
					// Toasts + refreshAll live inside the helper.
					await runTidalSyncNow();
					return;
				}
				try {
					await window.api['sync:spotify:run']();
					await refreshAll();
				} catch (err) {
					syncLog.error('failed', err);
				}
			});
		});
		el.querySelectorAll<HTMLButtonElement>('[data-action="open-rekordbox-settings"]').forEach((btn) => {
			btn.addEventListener('click', () => openSettingsModal('rekordbox'));
		});
		el.querySelectorAll<HTMLButtonElement>('[data-action="add-library-folder"]').forEach((btn) => {
			btn.addEventListener('click', () => { void addLibraryFolderFlow(); });
		});
	}

	return show;
}

// ─── Local library folders ────────────────────────────────────────────────
// (Panel painters + add/remove/prune wiring live in features/libraryPanel.ts,
// painted into Settings → Library. wireLibraryScanEvents below stays here: it
// owns the writes into state.libraryScanByFolder, which the panel reads via
// an injected getter.)

// Lazily-loaded: the Rekordbox tree only renders in the sidebar under the
// Rekordbox tab, so a Spotify/Tidal session never needs it. `rekordbox:tree`
// is a heavy IPC (hundreds of folders/playlists), so we keep it out of the
// unconditional boot/refreshAll path and pull it on demand via
// ensureRekordboxTree() the first time that tab becomes active.
let rekordboxTreeLoaded = false;

// True for the source tab whose sidebar hosts the Rekordbox tree.
function sourceNeedsRekordboxTree(src: SourceTab): boolean {
	return src === 'rekordbox';
}

// Fetch the tree once and cache it; subsequent tab switches are free. The
// onRekordboxEvent('completed') handler force-refreshes via refreshRekordboxTree
// when the tree is already in memory. Fire-and-forget: the sidebar repaints
// reactively off library.setRekordboxTree's tick.
async function ensureRekordboxTree(): Promise<void> {
	if (rekordboxTreeLoaded) return;
	await refreshRekordboxTree();
}

async function refreshRekordboxTree(): Promise<void> {
	try {
		const tree = await window.api['rekordbox:tree']();
		library.setRekordboxTree(tree);
		const treeHasContent = tree.folders.length > 0 || tree.playlists.length > 0;
		// Only latch the lazy-load as "done" when we actually got content. An
		// EMPTY result is ambiguous — it's either a genuinely-unimported library
		// or a transient read (an in-flight incremental sync between delete and
		// re-insert, a momentary DB-lock retry, etc.). Latching `true` on empty
		// would freeze that transient blank in place forever: ensureRekordboxTree
		// short-circuits on the latch, so no tab-switch / omnibar / boot would
		// ever re-check, and the user is stuck staring at the import CTA even
		// though 266 playlists sit in the DB. Re-checking an empty tree on the
		// next trigger is a cheap indexed read, and it's exactly the case where
		// we WANT to keep looking. Once content lands, it latches and stops.
		rekordboxTreeLoaded = treeHasContent;
		// Resolve the tri-state the loading spinner / import CTA / tree key off.
		setRekordboxLoadState(treeHasContent ? 'loaded' : 'empty');
		// The sidebar repaints reactively off the setRekordboxTree tick above, but
		// the main-pane surface is gated by shell.emptyState() — a signal only ever
		// recomputed inside renderEmptyState. Re-run it now that the fetch resolved
		// so the boot-time 'Loading…' placeholder gives way to the tree (content)
		// or the import CTA (confirmed empty); on content, also paint the tracks
		// view for the current selection. (auth is unused by the rekordbox branch,
		// so a benign fallback is fine when it isn't cached yet.)
		if (shell.activeSource() === 'rekordbox') {
			renderEmptyState(library.auth() ?? { spotify: { connected: false }, tidal: { connected: false } }, false);
			if (treeHasContent) void renderTracks();
		}
		rbLog.info('tree loaded', { folders: tree.folders.length, playlists: tree.playlists.length });
		if (tree.folders.length > 0) {
			rbLog.debug('sample folders', { sample: tree.folders.slice(0, 5).map((f) => ({ id: f.id, name: f.name, parent: f.parentFolderId })) });
		}
		if (tree.playlists.length > 0) {
			rbLog.debug('sample playlists', { sample: tree.playlists.slice(0, 5).map((p) => ({ id: p.id, name: p.name, parent: p.parentFolderId })) });
		}
	} catch (err) {
		rbLog.error('tree fetch failed', err);
	}
}

function wireLibraryScanEvents(): void {
	if (!window.api.onLibraryScanProgress) return;
	window.api.onLibraryScanProgress((p) => {
		// Log lifecycle frames only (skip per-file ingesting ticks — too noisy).
		if (p.stage !== 'ingesting') {
			log.for('scan').info('progress', { stage: p.stage, folderId: p.folderId, totals: p.totals });
		}
		state.libraryScanByFolder.set(p.folderId, p);
		// When a scan reaches `done`, the local source-link count may have
		// grown from 0 → N, which means the empty-state panel needs to step
		// aside for the real track list. refreshAll() is the simplest path —
		// it re-fetches source counts and re-evaluates renderEmptyState.
		// We also leave the folder modal repainted so the user sees the final
		// totals in either surface.
		if (p.stage === 'done' || p.stage === 'error') {
			void refreshAll().then(() => {
				repaintLibraryFolderSurfaces();
			});
		} else {
			// Throttle: only repaint surfaces every ~500ms during a busy scan.
			scheduleLibraryPanelRepaint();
		}
	});
}

// ─── Analyzer events ──────────────────────────────────────────────────────
//
// Two surfaces:
//   1. Every event logs to the dev console with an [analysis] prefix so you
//      can see exactly which tracks are flowing through the analyzer
//      pipeline. Useful for verifying the WSL Essentia setup end-to-end.
//   2. The analysis chip in the top frame shows live "Analyzing N" + an
//      animated dot while jobs are running, and flips into an error tint
//      when something fails.
//
// Note: 'enqueued' events are deliberately filtered out by the main process
// (see apps/desktop/src/main/index.ts) — they fired thousands of times during
// a scan and saturated the renderer's message pump. So we only see lifecycle
// transitions: started / progress / partial / completed / failed / cancelled.

// Pull authoritative running/queued counts from the DB and reconcile the chip
// store. Called at boot (the event stream only carries transitions from this
// point on) and right after the user enqueues an analyze — the per-track
// `enqueued` events are filtered out of the broadcast (they'd saturate IPC
// during a scan burst), so without this the queued count (and thus the
// completed/total denominator) would drift low. Errors swallowed: analyzer
// disabled or boot ordering both yield an empty/absent snapshot, which is fine.
async function reseedAnalysisStatus(): Promise<void> {
	try {
		const snap = await window.api['analysis:status']();
		analysisStatus.reconcile(snap.running, snap.queued);
		// Paint the blink on any rows already rendered before this snapshot
		// landed (the tracklist can boot before this IPC resolves). Rows
		// painted after this read it live via createTrackRow.
		for (const id of analysisStatus.snapshot().running) sweepRowAnalyzing(id, true);
	} catch { /* analyzer disabled or boot ordering — ignore */ }
}

// Toggle the blinking-local-pip class on every painted row for this track
// (a track can appear in more than one rendered list). Same DOM-sweep shape
// as now-playing.ts's setNowPlayingTrackId — touches only the handful of
// already-painted matching rows, so it's cheap even mid-backfill. Rows
// scrolled into view later pick the class up at render time via
// createTrackRow's analysisStatus.isRunning() read.
function sweepRowAnalyzing(trackId: string, on: boolean): void {
	document.querySelectorAll<HTMLTableRowElement>(`.trk[data-id="${cssEscape(trackId)}"]`)
		.forEach((r) => r.classList.toggle('row-analyzing', on));
}

// Convert to WAV run lifecycle → the inline playlist indicator (on the SOURCE
// playlist, where the user started it) + a completion toast that opens the
// "[WAV]" playlist.
// A freshly built "[WAV]" playlist isn't in the renderer's playlist cache
// yet — refresh before navigating to it.
async function openConvertedPlaylist(playlistId: string): Promise<void> {
	await refreshAll();
	await openPlaylistById(playlistId);
}

function wireWavConvertEvents(): void {
	if (!window.api.onWavConvertEvent) return;
	window.api.onWavConvertEvent((evt) => {
		if (evt.kind !== 'progress') log.for('wav').info(`convert ${evt.kind}`, evt);
		// Read before forwarding: the dialog drops a finished run it isn't showing.
		const watching = !!wavConvertDialog?.isOpen();
		wavConvertDialog?.handleEvent(evt);
		const mine = (): boolean => enriching()?.source === 'wav' && enriching()?.runId === evt.runId;
		if (evt.kind === 'started') {
			setEnriching({ playlistId: evt.playlistId, source: 'wav', processed: 0, total: evt.total, runId: evt.runId });
			renderEnrichInline();
		} else if (evt.kind === 'progress') {
			if (mine()) updateEnrichInline(Math.floor(evt.done), evt.total);
		} else if (evt.kind === 'completed') {
			if (mine()) clearEnrichment();
			const r = evt.result;
			const parts = [
				r.converted ? `${r.converted} converted` : '',
				r.reused ? `${r.reused} already converted` : '',
				r.kept ? `${r.kept} kept as-is` : '',
				r.skipped ? `${r.skipped} skipped (no local file)` : '',
				r.failed ? `${r.failed} failed` : '',
			].filter(Boolean);
			// The dialog is up showing the summary — take the user to the
			// result behind it instead of stacking a toast on top.
			if (watching) {
				if (r.playlistId) void openConvertedPlaylist(r.playlistId);
				else void refreshAll();
				return;
			}
			const firstFailure = r.failures[0];
			showToast(r.cancelled ? 'Conversion stopped' : r.failed ? 'Converted to WAV, with errors' : 'Converted to WAV', {
				sub: parts.join(' · ') + (firstFailure ? ` — ${firstFailure.title}: ${firstFailure.message}` : ''),
				kind: r.failed ? 'error' : 'success',
				durationMs: r.failed ? 9000 : 6000,
				action: r.playlistId ? { label: 'Open', onClick: () => { void openConvertedPlaylist(r.playlistId); } } : undefined,
			});
			void refreshAll();
		} else if (evt.kind === 'failed') {
			if (mine()) clearEnrichment();
			if (!watching) showToast('Convert to WAV failed', { sub: evt.message, kind: 'error', durationMs: 8000 });
		}
	});
}

// Backup/restore lifecycle: the progress dialog consumes everything; when
// it is not showing, completions and failures surface as toasts (a staged
// restore's toast carries the Restart action).
function wireBackupEvents(): void {
	backupApi.onEvent((evt) => {
		if (evt.kind === 'status') return;
		if (evt.kind !== 'progress') log.for('backup').info(`${evt.op} ${evt.kind}`, evt.kind === 'completed' ? { runId: evt.runId, ...evt.result } : { runId: evt.runId });
		const watching = !!backupProgressDialog?.isOpen();
		// "Back up now" from the settings tab has no dialog yet — open one
		// so the user sees the run (the scheduler's runs stay silent).
		if (evt.kind === 'started' && !watching && !backupProgressDialog?.isRunActive() && document.querySelector('[data-settings-panel="backup"]:not([hidden])')) {
			backupProgressDialog?.begin(evt.op);
		}
		backupProgressDialog?.handleEvent(evt);
		if (backupProgressDialog?.isOpen()) return;
		if (evt.kind === 'completed') {
			const r = evt.result;
			if (evt.op === 'backup') {
				if (r.unchanged) return; // a silent scheduled run: nothing to say
				showToast(r.cancelled ? 'Backup stopped' : 'Backup complete', {
					sub: r.cancelled ? undefined : `${r.files} files · ${r.newObjects ? `${formatBytesShort(r.newBytes)} uploaded` : 'nothing new'}${r.warnings[0] ? ` — ${r.warnings[0]}` : ''}`,
					kind: r.warnings.length ? 'info' : 'success',
					durationMs: 6000,
				});
			} else {
				showToast(r.cancelled ? 'Restore stopped' : r.relaunchRequired ? 'Restore ready — restart to apply' : 'Restore complete', {
					sub: r.relaunchRequired ? 'The restored files are staged and swapped in at the next launch.' : `${r.files} files${r.skipped ? ` · ${r.skipped} already identical` : ''}`,
					kind: 'success',
					durationMs: r.relaunchRequired ? 15000 : 6000,
					action: r.relaunchRequired ? { label: 'Restart', onClick: () => { void backupApi.relaunch(); } } : undefined,
				});
			}
		} else if (evt.kind === 'failed') {
			showToast(evt.op === 'backup' ? 'Backup failed' : 'Restore failed', { sub: evt.message, kind: 'error', durationMs: 9000 });
		}
	});
}

// Cloud sync pulled changes into the library. Rows the pull touched are
// patched in place (patchTrackRow — the same row-refresh hook analysis
// completions use) with one trailing coalesced renderTracks for sort/filter
// and playlist order; a big batch (a bootstrap) skips per-row patches and
// just refetches the view. Container changes (tags, playlists, folders,
// pinned searches) refresh the sidebar through refreshAll, debounced.
const SYNC_PATCH_CAP = 100;
let syncSidebarHandle: ReturnType<typeof setTimeout> | null = null;
function wireCloudSyncEvents(): void {
	cloudSyncApi.onApplied((a) => {
		if (a.tracks.length <= SYNC_PATCH_CAP) for (const id of a.tracks) void patchTrackRow(id);
		if (a.tracks.length > 0 || a.playlists.length > 0) scheduleTracksRefresh(a.tracks.length > SYNC_PATCH_CAP ? 250 : 1500);
		const containers = a.entities.some((e) => e.entity === 'tag' || e.entity === 'playlist' || e.entity === 'playlist_folder' || e.entity === 'pinned_search');
		if (containers) {
			if (syncSidebarHandle) clearTimeout(syncSidebarHandle);
			syncSidebarHandle = setTimeout(() => { syncSidebarHandle = null; void refreshAll(); }, 1000);
		}
	});
}

function formatBytesShort(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
	if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
	return `${n} B`;
}

function wireAnalysisEvents(): void {
	if (!window.api.onAnalysisEvent) return;
	// Backfill on first wire / after HMR reload. The event stream only carries
	// transitions from this point forward, so without the snapshot the badge
	// would show "Analyzing 0" even when work is genuinely running. One-shot
	// query, errors swallowed (e.g. analyzer disabled — empty snapshot is fine).
	void reseedAnalysisStatus();
	window.api.onAnalysisEvent((evt) => {
		// Always log — terse but enough to follow the pipeline.
		switch (evt.kind) {
			case 'enqueued':
				// Main filters these out of the broadcast (the burst during a
				// scan would saturate IPC) so we shouldn't see them; the case
				// only exists to satisfy the exhaustive-union check below.
				break;
			case 'started':
				analysisLog.debug('started', { trackId: evt.trackId });
				// (Queued-count clamp lives in the store — the renderer's mirror
				// of `queued` can drift when enqueued events are filtered out.)
				analysisStatus.started(evt.trackId, evt.name);
				sweepRowAnalyzing(evt.trackId, true);
				break;
			case 'requeued':
				analysisLog.warn('requeued — analyzer unavailable', { trackId: evt.trackId, reason: evt.reason });
				analysisStatus.requeued(evt.trackId);
				sweepRowAnalyzing(evt.trackId, false);
				break;
			case 'progress':
				analysisLog.debug('progress', { trackId: evt.trackId, stage: evt.stage, pct: evt.pct });
				break;
			case 'partial':
				analysisLog.debug('partial', { trackId: evt.trackId, fields: evt.fields });
				break;
			case 'completed':
				analysisLog.debug('completed', { trackId: evt.trackId });
				analysisStatus.completed(evt.trackId);
				// Stop the local-pip blink immediately. patchTrackRow below also
				// rebuilds the row (isRunning now false) but it's async — sweep
				// now so the pip doesn't keep blinking until the IPC returns.
				sweepRowAnalyzing(evt.trackId, false);
				// Evict the stale cached analysis/peaks for this track — a
				// re-analysis otherwise keeps painting the old beats/cues
				// until the session restarts. If it's the playing track the
				// store reloads immediately and repaints via its listeners.
				analysisStore.invalidate(evt.trackId);
				// The track row now has BPM/key in the DB. Patch just that
				// row; a trailing coalesced renderTracks converges sort/
				// filter once the completion burst quiets. (This used to be
				// refreshAll() per event — ~8 IPCs + a full list rebuild per
				// completed track, which saturated the IPC pump for the
				// whole duration of a large backfill. Same lesson as the
				// 'enqueued' filter in main/index.ts.)
				void patchTrackRow(evt.trackId);
				scheduleTracksRefresh();
				break;
			case 'failed':
				analysisLog.error('failed', undefined, { trackId: evt.trackId, errorKind: evt.errorKind, message: evt.message });
				analysisStatus.failed(evt.trackId, `${evt.errorKind}: ${evt.message}`);
				sweepRowAnalyzing(evt.trackId, false);
				break;
			case 'cancelled':
				analysisLog.warn('cancelled', { trackId: evt.trackId });
				analysisStatus.cancelled(evt.trackId);
				sweepRowAnalyzing(evt.trackId, false);
				break;
			default: {
				// Exhaustive check — TS will flag at compile time if a new event
				// kind is added without a handler here.
				const _exhaustive: never = evt;
				analysisLog.warn('unhandled event', { evt: _exhaustive });
			}
		}
		// (TopFrame chip reads analysisStatus.snapshot() reactively.)
	});
}

// renderAnalysisChip moved into layouts/TopFrame.tsx — the chip is now a
// reactive sub-region of TopFrame, reading from analyzerStatusSignal.
// refreshAnalyzerStatus() (above) is the bridge from state.analysis
// mutations into the signal.

// Light refresh helper — re-fetch the visible tracks so newly-analyzed BPM
// and key values show up without a full state reload. Falls back to a no-op
// if the renderer hasn't bound a refresh fn yet (boot ordering).
// Trailing-coalesced full refresh for bursty backend events. A multi-
// thousand-track analyzer backfill completes a track every few seconds for
// hours — calling renderTracks() (let alone refreshAll()) per event keeps
// the IPC pump saturated refetching data that didn't change. Events that
// only move one row should patch it in place (patchTrackRow) and call this
// for eventual sort/filter convergence: the timer keeps pushing out while
// the burst is hot and fires one refresh after it quiets.
let tracksRefreshHandle: ReturnType<typeof setTimeout> | null = null;
function scheduleTracksRefresh(delayMs = 3000): void {
	if (tracksRefreshHandle) clearTimeout(tracksRefreshHandle);
	tracksRefreshHandle = setTimeout(() => {
		tracksRefreshHandle = null;
		void renderTracks();
	}, delayMs);
}

// Make sure a row is in the visible-tracks cache. The Organize modal's
// single-track header (stars, BPM, key) reads tracksData reactively, and a
// track opened from Discover, the now-playing card, or a keyboard shortcut is
// often not on the current library page — the header would silently fall
// back to the star-less "1 track selected" variant. Fetch-and-upsert on a
// miss; the cache bump repaints the header. The stray row is harmless: the
// page's next setAll replaces the whole map, and commitRating already
// upserts off-page rows the same way.
async function ensureTrackCached(trackId: string): Promise<void> {
	if (tracksData.get(trackId)) return;
	try {
		const [fresh] = await window.api['tracks:list']({ ids: [trackId] }, undefined, 1, 0);
		if (fresh) tracksData.upsert(fresh);
	} catch (err) {
		log.for('tracks').warn('cache fill failed', { trackId }, err);
	}
}

// Refetch ONE track row and patch it into the current view in place —
// cache, unfiltered list, and the mounted row DOM. No-op when the track
// isn't in the current view (nothing to paint; the next renderTracks picks
// it up). View decorations the by-id fetch can't compute (playlistPosition
// comes from the playlistId join) are preserved from the existing row.
async function patchTrackRow(trackId: string): Promise<void> {
	const existing = tracksData.get(trackId);
	if (!existing) return;
	try {
		const [fresh] = await window.api['tracks:list']({ ids: [trackId] }, undefined, 1, 0);
		if (!fresh) return;
		const merged: Track = { ...fresh, playlistPosition: existing.playlistPosition };
		tracksData.upsert(merged);
		const idx = mainTracksUnfiltered.findIndex((t) => t.id === trackId);
		if (idx >= 0) mainTracksUnfiltered[idx] = merged;
		mainTrackList?.patchOne(merged);
	} catch (err) {
		log.for('tracks').warn('row patch failed', { trackId }, err);
	}
}

// ─── View switching + Sync view ──────────────────────────────────────────

// Orchestration wrapper: clears JIT scope and records the view in the
// shell model. ALL DOM consequences (region visibility, body attrs,
// player dock/mode) flow from the region-derivation effect — this
// function must never touch the DOM.
// ─── Lazy region lifecycle (F5) ─────────────────────────────────────────
// The overlay regions (Discover / Sync / Downloads) mount on FIRST open
// instead of at boot, and refresh when re-entered. tracks stays eager (the
// boot/default surface). The headline win: DiscoverView — and its feed
// fetch — no longer run at startup for users who never open Discover. The
// host divs are rendered by MainPane at boot; only the component mount +
// its data load are deferred.
function mountDownloadsRegion(): void {
	const dlViewHost = document.getElementById('dl-view');
	if (!dlViewHost) return;
	downloadsView = mountDownloadsView(dlViewHost, {
		jobs: () => downloads.jobsSorted(),
		summary: () => downloads.summary(),
		onRetry: async (trackId) => {
			try { await downloads.retry(trackId); }
			catch (err) { downloadLog.error('retry failed', err); }
		},
		onRowContextMenu: (evt, trackId) => showDlRowContextMenu(evt, trackId),
		onClearCompleted: () => downloads.clearCompleted(),
		onClearAll: async () => {
			// Destructive bulk action — gate behind a confirm so a stray click on
			// a queue full of pending/errored jobs doesn't wipe the workspace.
			const s = downloads.summary();
			if (s.total === 0) return;
			if (!window.confirm(`Remove all ${s.total} jobs from the downloads list?\n\nIn-flight downloads will continue and reappear.`)) return;
			await downloads.clearAll();
		},
		onOpenFolder: async () => {
			try { await window.api['tidal:download:open-folder'](); }
			catch (err) { showToast('Open folder failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' }); }
		},
		onVerify: () => { void runVerifyDownloads(); },
	});
}
function mountDiscoverRegion(): void {
	const discoverViewHost = document.getElementById('discover-view');
	if (!discoverViewHost) return;
	// Split the Discover region: the feed, the journey surface, and the
	// agent-results list behind a minimal Feed/Journeys mode bar (v1 — the
	// real Discover toolbar/side-pane arrives with the journey-tree design
	// pass). Each Solid surface mounts into its own child host. The agent
	// PANEL is no longer here — it docks app-level (mountAgentDock) so it's
	// available on every tab; the ✦ button just toggles that global dock.
	const modeBar = document.createElement('div');
	modeBar.className = 'discover-modebar';
	const feedBtn = document.createElement('button');
	feedBtn.textContent = 'Feed';
	feedBtn.className = 'discover-mode-btn is-active';
	const journeysBtn = document.createElement('button');
	journeysBtn.textContent = 'Journeys';
	journeysBtn.className = 'discover-mode-btn';
	const agentBtn = document.createElement('button');
	agentBtn.textContent = '✦ Agent';
	agentBtn.className = 'discover-mode-btn discover-mode-btn--agent';
	agentBtn.title = 'Toggle the agent panel';
	modeBar.append(feedBtn, journeysBtn, agentBtn);
	const feedHost = document.createElement('div');
	feedHost.className = 'discover-feed-host';
	const journeyHost = document.createElement('div');
	journeyHost.className = 'journey-host';
	journeyHost.hidden = true;
	const agentResultHost = document.createElement('div');
	agentResultHost.className = 'agent-result-host';
	agentResultHost.hidden = true;
	discoverViewHost.append(modeBar, feedHost, journeyHost, agentResultHost);
	setDiscoverMode = (m) => {
		currentDiscoverMode = m;
		feedHost.hidden = m !== 'feed';
		journeyHost.hidden = m !== 'journeys';
		agentResultHost.hidden = m !== 'agent-results';
		feedBtn.classList.toggle('is-active', m === 'feed');
		journeysBtn.classList.toggle('is-active', m === 'journeys');
		if (m === 'journeys') journeyView?.refresh();
	};
	// Mode switches are history navigations: each lands on the sub-state that
	// surface was left in (the feed's filters, the open journey node).
	feedBtn.addEventListener('click', () => { void navigate(feedLocation()); });
	journeysBtn.addEventListener('click', () => {
		const j = journeyView?.getLocation() ?? null;
		void navigate({ kind: 'discover', mode: 'journeys', journeyId: j?.journeyId ?? null, nodeId: j?.nodeId ?? null });
	});
	agentBtn.addEventListener('click', () => toggleAgentDock());
	const playAgentSpotify = async (req: { sourceTrackId: string; title: string; artist: string; coverUrl: string | null; durationSec: number | null }): Promise<void> => {
		try {
			shell.notePlaybackOrigin();
			await player.playFeedSpotify(req.sourceTrackId, {
				title: req.title,
				artist: req.artist,
				coverUrl: req.coverUrl,
				durationSec: req.durationSec,
			});
		} catch (err) {
			showToast('Playback failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
		}
	};
	agentResultView = mountAgentResultView(agentResultHost, {
		onPlay: (req) => { void playAgentSpotify(req); },
		onBackToFeed: () => { void navigate(feedLocation()); },
		onToast: (msg, kind, sub) => showToast(msg, { kind, sub }),
	});
	journeyView = mountJourneyView(journeyHost, {
		onToast: (msg, kind, sub) => showToast(msg, { kind, sub }),
		// Journey hops / breadcrumb jumps / back-to-list are history entries
		// the view applies itself; it reports each one before moving.
		onNavigate: (loc) => recordNavigation(
			{ kind: 'discover', mode: 'journeys', journeyId: loc.journeyId, nodeId: loc.nodeId },
			loc.label,
		),
	});
	discoverView = mountDiscoverView(feedHost, {
		onShowArtistInLibrary: (name) => { void showArtistInLibrary(name); },
		// Feed ↔ Archived and the genre/label filters are history entries the
		// view applies itself; it reports the target state before reloading.
		onNavigate: (next) => recordNavigation({ kind: 'discover', mode: 'feed', archived: next.archived, genre: next.genre, label: next.label }),
		onPlay: async (req) => {
			try {
				shell.notePlaybackOrigin();
				await player.playFeedSpotify(req.sourceTrackId, {
					title: req.title,
					artist: req.artist,
					artists: req.artists,
					coverUrl: req.coverUrl,
					durationSec: req.durationSec,
				});
			} catch (err) {
				// Region-unavailable track (confirmed via market probe): flag it in
				// feed.db, dim it, and skip ahead — not a generic playback failure.
				if (err instanceof player.SpotifyTrackUnavailableError) {
					discoverView?.markUnavailable(req.itemId, req.sourceTrackId);
					return;
				}
				showToast('Playback failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
			}
		},
		onTogglePause: () => { player.togglePause().catch(() => {}); },
		onOpenOrganize: (trackIds) => { void openOrganizeForTracks(trackIds); },
		onOpenOrganizeDeferred: (session) => { void openOrganizeForFeedPromotion(session); },
		onStartJourney: (seed) => startJourneyFromSeed(seed),
		onToast: (msg, kind, sub) => showToast(msg, { kind, sub }),
		onTotalChange: (totalCount) => {
			setTagCountsSignal((prev) => ({ ...prev, discover: totalCount }));
		},
		isCurrentlyPlaying: (sourceTrackId) => {
			const s = player.getState();
			return !!s.current
				&& s.current.source === 'spotify'
				&& s.current.sourceTrackId === sourceTrackId
				&& (s.playing || s.loading);
		},
		listenThresholdSec: () => uiSettingsSignal().discoverListenThresholdSec,
	});
	// Natural end of a feed-played track hands control back to the feed:
	// next album track, else the next playable feed item.
	player.setFeedAdvanceHandler(() => { discoverView?.playNext(); });
	// Play-history capture — one observer over the player store plus the
	// lifecycle taps. The context provider answers "where was this play
	// launched from" for the play_event context columns; snapshot semantics
	// (read at play start) live in the tracker.
	setPlayContextProvider(() => {
		const view = shell.activeView();
		if (view === 'discover') return { type: 'feed', id: null };
		if (view === 'interested' || view === 'basket') return { type: 'tag', id: view };
		const jit = shell.currentJit();
		if (jit) return { type: 'search', id: jit.query ?? null };
		const playlistId = shell.currentPlaylistId();
		if (playlistId) return { type: 'playlist', id: playlistId };
		return { type: 'all', id: shell.activeSource() };
	});
	initPlayTracker();
	// Drive the feed's now-playing accent from the player. Only Spotify-sourced
	// playback maps onto feed items (the feed plays via playFeedSpotify); local/
	// Tidal playback clears it. Reading st.current keeps this reactive.
	player.subscribe((st) => {
		const id = st.current && st.current.source === 'spotify' ? st.current.sourceTrackId : null;
		discoverView?.setNowPlaying(id);
	});
	// Separate subscription for the "listened" gate — reads position so it fires
	// at the player's poll rate (50ms Spotify / 20Hz local), feeding the 25s
	// clean-playback timer. Kept apart from the now-playing-accent subscription
	// above so that one keeps firing only on track change, not every tick.
	player.subscribe((st) => {
		discoverView?.notePlayback(st.position, st.playing);
	});
}
function mountSyncRegion(): void {
	const syncViewHost = document.getElementById('sync-view');
	if (!syncViewHost) return;
	syncView = mountSyncView(syncViewHost, {
		rows: () => computeSyncRowSnapshots(),
		running: () => syncState.running(),
		onSyncNow: () => { void runSpotifySync(); },
	});
}

// Registry of lazy regions. `mounted` flips on first open; discover self-
// loads inside its mount (ensureLoaded), so it skips the first-open refresh
// to avoid a double feed fetch — the store-backed views load via refresh.
const lazyRegions: Record<'discover' | 'sync' | 'downloads', {
	mounted: boolean;
	selfLoadsOnMount: boolean;
	mount: () => void;
	refresh: () => void;
}> = {
	discover:  { mounted: false, selfLoadsOnMount: true,  mount: mountDiscoverRegion,  refresh: () => discoverView?.refresh() },
	sync:      { mounted: false, selfLoadsOnMount: false, mount: mountSyncRegion,      refresh: () => seedSyncRowsFromPlaylists() },
	downloads: { mounted: false, selfLoadsOnMount: false, mount: mountDownloadsRegion, refresh: () => { void refreshDownloads(); } },
};

// Mount a lazy region on first open; on re-entry pull updates unless the
// caller is restoring a history entry (`refresh: false` — a Back onto
// Discover lands on the feed exactly as it was left, like a browser's
// back-forward cache; a fresh tab click still refreshes).
function ensureRegionMounted(r: 'discover' | 'sync' | 'downloads', opts: { refresh: boolean }): void {
	const e = lazyRegions[r];
	if (!e.mounted) {
		performance.mark(`region:${r}:mount:start`);
		e.mount();
		e.mounted = true;
		performance.measure(`region:${r}:mount`, `region:${r}:mount:start`);
		// First open: mount self-loaded (discover) or load via refresh (others).
		if (!e.selfLoadsOnMount) e.refresh();
		return;
	}
	if (opts.refresh) e.refresh();
}

// ─── Navigation history (browser-style back / forward) ──────────────────────
// Every change of what the main pane shows goes through navigate() — the
// one choke point the per-gesture sequences (tab click, sidebar row,
// omnibar pick, drill-down, agent hand-off…) used to each spell out with
// small differences. It snapshots the leave-time view state onto the
// current entry, pushes the target, then applies it; back/forward re-apply
// an entry WITH its snapshot. The stack is pure data in
// viewmodel/navHistory.ts; this is the orchestration (fetches, scroll,
// region mounts) the shell comment reserves for callers.

const SOURCE_LABELS: Record<SourceTab, string> = { spotify: 'Spotify', tidal: 'Tidal', rekordbox: 'Rekordbox' };
const SIDEBAR_STEP_COALESCE_MS = 800;

// Title text for a tracks scope — the filter-bar title and the history
// labels share it. null ⇔ the source root (the title slot hides).
function scopeTitle(scope: TracksScope): string | null {
	switch (scope.type) {
		case 'all': return null;
		case 'jit': return scope.jit.name;
		case 'folder': {
			// Folder scope (Rekordbox tree) — the full ancestry as the title,
			// mirroring how a selected playlist labels the tracklist.
			const f = library.rekordboxTree().folders.find((x) => x.id === scope.id);
			return f ? [...rekordboxAncestorNames(scope.id), f.name].join(' / ') : null;
		}
		case 'playlist': {
			// Rekordbox playlists carry a folder ancestry — show the full
			// `Folder / Sub / Playlist` breadcrumb. Flat sources (Spotify /
			// Tidal / Curator-local) have no chain, so just the name.
			const p = library.getPlaylist(scope.id);
			if (p) return p.source === 'rekordbox' ? [...rekordboxAncestorNames(scope.id), p.name].join(' / ') : p.name;
			const smart = library.rekordboxTree().playlists.find((x) => x.id === scope.id);
			return smart ? smart.name : null;
		}
	}
}

function smartPlaylistName(id: string): string | null {
	const p = library.getPlaylist(id) ?? library.rekordboxTree().playlists.find((x) => x.id === id);
	return p?.isSmart ? p.name : null;
}

function locationLabel(loc: NavLocation): string {
	switch (loc.kind) {
		case 'tracks': return scopeTitle(loc.scope) ?? SOURCE_LABELS[loc.source];
		case 'tag': return loc.view === 'interested' ? 'Interested' : 'Basket';
		case 'sync': return 'Sync';
		case 'downloads': return 'Downloads';
		case 'discover':
			switch (loc.mode) {
				case 'feed': return ['Discover', loc.archived ? 'Archived' : null, loc.genre, loc.label].filter(Boolean).join(' · ');
				case 'journeys': return loc.journeyId ? 'Journey' : 'Journeys';
				case 'agent-results': return 'Agent results';
			}
	}
}

// Display label for an entry. Library scopes re-derive from the live
// catalog (a renamed playlist shows its new name); journey / agent entries
// keep the title captured when they were recorded (a lookup otherwise).
function entryLabel(e: NavEntry): string {
	return e.location.kind === 'discover' && e.location.mode !== 'feed' ? e.label : locationLabel(e.location);
}

function currentTracksScope(): TracksScope {
	const jit = shell.currentJit();
	if (jit) return { type: 'jit', jit };
	const pid = shell.currentPlaylistId();
	if (pid) return { type: 'playlist', id: pid };
	const fid = shell.currentFolderId();
	if (fid) return { type: 'folder', id: fid };
	return { type: 'all' };
}

function feedLocation(): NavLocation {
	const f = discoverView?.getNavState() ?? { archived: false, genre: null, label: null };
	return { kind: 'discover', mode: 'feed', archived: f.archived, genre: f.genre, label: f.label };
}

// Where Discover currently stands (mode + sub-state) — what a Discover tab
// click re-enters and what the now-playing chip jumps back to.
function discoverLocation(): NavLocation {
	switch (currentDiscoverMode) {
		case 'journeys': {
			const j = journeyView?.getLocation() ?? null;
			return { kind: 'discover', mode: 'journeys', journeyId: j?.journeyId ?? null, nodeId: j?.nodeId ?? null };
		}
		case 'agent-results': {
			const rs = agentResultView?.current();
			if (rs) return { kind: 'discover', mode: 'agent-results', resultSetId: rs.id };
			return feedLocation();
		}
		default:
			return feedLocation();
	}
}

function currentLocation(): NavLocation {
	const view = shell.activeView();
	switch (view) {
		case 'interested':
		case 'basket': return { kind: 'tag', view };
		case 'sync': return { kind: 'sync' };
		case 'downloads': return { kind: 'downloads' };
		case 'discover': return discoverLocation();
		default: return { kind: 'tracks', source: shell.activeSource(), scope: currentTracksScope() };
	}
}

// The scope a source-tab click lands on: the scope already showing when
// that source IS the active tracks view (a JIT drops to the root — the tab
// has always been the "dismiss the search" gesture), else whatever the tab
// was showing when it was left (its per-source slot: playlist, folder,
// search or root).
function sourceTabScope(src: SourceTab): TracksScope {
	if (src === shell.activeSource() && shell.activeView() === 'tracks') {
		const cur = currentTracksScope();
		return cur.type === 'jit' ? { type: 'all' } : cur;
	}
	return state.sourceSlots.get(src)?.scope ?? { type: 'all' };
}

// Leave-time snapshot of the view the pane shows right now.
function captureRestore(): NavRestore {
	const r: NavRestore = {};
	if (shell.showsTracksLayout()) {
		r.scrollTop = mainTrackList?.getScrollTop() ?? 0;
		const first = mainTrackList?.getFirstVisibleIndex() ?? -1;
		r.anchorTrackId = first >= 0 ? getMainTracks()[first]?.id ?? null : null;
		r.selectedTrackIds = [...getSelectedTrackIds()];
		r.selectionAnchor = getSelectionAnchor();
		r.sort = { column: state.sortColumn, dir: state.sortDir };
		r.tracksFilter = state.tracksFilter;
		r.filterText = mainFilterText;
	} else if (shell.activeView() === 'discover' && currentDiscoverMode === 'feed') {
		r.scrollTop = discoverView?.getScrollTop() ?? 0;
	}
	return r;
}

// Re-apply a tracks entry's snapshot once its list has rendered.
function applyTracksRestore(r: NavRestore): void {
	if (r.filterText !== undefined && r.filterText !== mainFilterText) setTracklistFilterText(r.filterText);
	if (r.selectedTrackIds) {
		const present = new Set(getMainTracks().map((t) => t.id));
		const ids = r.selectedTrackIds.filter((id) => present.has(id));
		const anchor = r.selectionAnchor && present.has(r.selectionAnchor) ? r.selectionAnchor : ids[0] ?? null;
		setTrackSelection(ids, anchor);
	}
	if (r.scrollTop != null) mainTrackList?.setScrollTop(r.scrollTop);
	// A list that changed under the entry (rows added/removed upstream, a
	// different row mode or grouping) puts the raw offset on different rows —
	// re-aim at the anchor track when it isn't the one at the top.
	if (r.anchorTrackId && mainTrackList) {
		const top = mainTrackList.getTracks()[mainTrackList.getFirstVisibleIndex()];
		if (top?.id !== r.anchorTrackId) mainTrackList.scrollToTrack(r.anchorTrackId, 'start');
	}
}

// Does the scope still exist? Folders live in the lazy rekordbox tree, so
// load it before deciding.
async function resolveTracksScope(scope: TracksScope): Promise<boolean> {
	switch (scope.type) {
		case 'all':
		case 'jit': return true;
		case 'playlist':
			return !!library.getPlaylist(scope.id)
				|| library.rekordboxTree().playlists.some((p) => p.id === scope.id);
		case 'folder':
			if (!rekordboxTreeLoaded) await ensureRekordboxTree();
			return library.rekordboxTree().folders.some((f) => f.id === scope.id);
	}
}

// Monotonic apply counter: a navigation that gets overtaken (rapid
// back/back/forward) must not restore ITS snapshot onto the list the
// newer one rendered. renderTracks has its own guard for the fetch.
let navApplySeq = 0;

async function applyTracksLocation(loc: Extract<NavLocation, { kind: 'tracks' }>, restore: NavRestore | null): Promise<boolean> {
	const seq = ++navApplySeq;
	if (!(await resolveTracksScope(loc.scope))) return false;
	if (seq !== navApplySeq) return true;
	const targetKey = locationKey(loc);
	const moved = locationKey(currentLocation()) !== targetKey;
	const sourceChanged = shell.activeSource() !== loc.source;
	if (sourceChanged) {
		// Per-source slot: pull the destination's remembered playlist +
		// selection. The explicit scope below overrides the playlist; the
		// selection survives when it's the same place (a plain tab click).
		shell.openSource(loc.source);
		restoreSourceState(loc.source);
	}
	const scopeChanged = locationKey({ kind: 'tracks', source: loc.source, scope: currentTracksScope() }) !== targetKey;
	if (scopeChanged && !restore?.selectedTrackIds) clearTrackSelection();
	applyTracksScope(loc.scope);
	// Sort: the entry's own on traversal; otherwise per-scope memory for
	// playlists / folders, Match order for similarity searches, and the
	// global sort (minus a leftover Match) at the root.
	if (restore?.sort) {
		state.sortColumn = restore.sort.column as SortColumn;
		state.sortDir = restore.sort.dir;
	} else if (moved) {
		const s = loc.scope;
		if (s.type === 'playlist' || s.type === 'folder') {
			applyStoredOrDefaultSort(s.id);
		} else if (s.type === 'jit' && hasSimilarTerm(s.jit.query)) {
			state.sortColumn = 'match';
			state.sortDir = 'desc';
		} else if (state.sortColumn === 'match') {
			state.sortColumn = 'bpm';
			state.sortDir = 'asc';
		}
	}
	if (restore?.tracksFilter) state.tracksFilter = restore.tracksFilter as typeof state.tracksFilter;
	else if (moved) state.tracksFilter = 'all';
	mainTrackList?.setSort({ column: state.sortColumn, dir: state.sortDir });
	syncMatchColumn();
	// Smart-playlist watermark: up for a smart scope, down for anything
	// else (it used to linger until the next full refresh).
	const smart = loc.scope.type === 'playlist' ? smartPlaylistName(loc.scope.id) : null;
	if (!smart && shell.emptyState()?.kind === 'watermark') shell.setEmptyState(null);
	shell.openView('tracks');
	if (smart) {
		tracksData.setAll([]);
		mainTracksUnfiltered = [];
		mainTrackList?.update([]);
		showSmartPlaylistWatermark(smart);
		persistUiState();
		return true;
	}
	// A source switch re-reads auth / playlists / counts (the tab-click
	// contract); within a source only the list changes.
	if (sourceChanged) await refreshAll(); else await renderTracks();
	if (seq !== navApplySeq) return true;
	if (restore) applyTracksRestore(restore);
	else if (moved) restoreCurrentAnchor();
	// Persist AFTER the list landed so the per-playlist anchor is captured
	// from the rows actually on screen.
	persistUiState();
	return true;
}

async function applyTagLocation(loc: Extract<NavLocation, { kind: 'tag' }>, restore: NavRestore | null): Promise<boolean> {
	const seq = ++navApplySeq;
	const moved = locationKey(currentLocation()) !== locationKey(loc);
	if (moved && !restore?.selectedTrackIds) clearTrackSelection();
	// Tag views are global — no playlist / folder / JIT underneath. The
	// per-source slot keeps the tab's playlist (captureSourceState skips
	// these views), so the sort + anchor memory can't leak onto it anymore.
	shell.clearScope();
	if (shell.emptyState()?.kind === 'watermark') shell.setEmptyState(null);
	if (restore?.sort) {
		state.sortColumn = restore.sort.column as SortColumn;
		state.sortDir = restore.sort.dir;
	} else if (state.sortColumn === 'match') {
		state.sortColumn = 'bpm';
		state.sortDir = 'asc';
	}
	if (restore?.tracksFilter) state.tracksFilter = restore.tracksFilter as typeof state.tracksFilter;
	mainTrackList?.setSort({ column: state.sortColumn, dir: state.sortDir });
	syncMatchColumn();
	shell.openView(loc.view);
	await renderTracks();
	if (seq !== navApplySeq) return true;
	if (restore) applyTracksRestore(restore);
	return true;
}

async function applyDiscoverLocation(loc: Extract<NavLocation, { kind: 'discover' }>, restore: NavRestore | null, refresh: boolean): Promise<boolean> {
	const seq = ++navApplySeq;
	const moved = locationKey(currentLocation()) !== locationKey(loc);
	// Resolve anything that can be gone BEFORE flipping the region, so a
	// dead entry leaves no half-applied state behind.
	let resultSet: AgentResultSet | null = null;
	if (loc.mode === 'agent-results') {
		resultSet = agentResultSetsSeen.get(loc.resultSetId) ?? await agentApi.getResultSet(loc.resultSetId);
		if (seq !== navApplySeq) return true;
		if (!resultSet) return false;
	}
	ensureRegionMounted('discover', { refresh: false });
	shell.openView('discover');
	switch (loc.mode) {
		case 'feed':
			setDiscoverMode('feed');
			// A fresh entry / tab click refreshes (the tab-click contract); a
			// traversal onto the state the feed already shows restores it as-is.
			discoverView?.applyNavState({ archived: loc.archived, genre: loc.genre, label: loc.label }, { reload: refresh || moved });
			if (!refresh && !moved && restore?.scrollTop != null) discoverView?.setScrollTop(restore.scrollTop);
			return true;
		case 'journeys': {
			setDiscoverMode('journeys');
			if (!loc.journeyId) { journeyView?.showList(); return true; }
			const ok = await journeyView?.openAt(loc.journeyId, loc.nodeId);
			return ok ?? false;
		}
		case 'agent-results':
			setDiscoverMode('agent-results');
			agentResultView?.show(resultSet!);
			return true;
	}
}

// Apply a location to the UI. Returns false when its target no longer
// exists (the caller drops the entry). `refresh` = pull updates for the
// lazy regions (a fresh navigation or tab click); traversal passes false
// so Back lands on the view exactly as it was left.
async function applyLocation(loc: NavLocation, restore: NavRestore | null, opts: { refresh: boolean }): Promise<boolean> {
	// Remember the tracks view being left — per-playlist anchor + per-source
	// slot — before any scope mutation.
	if (shell.activeView() === 'tracks') {
		captureCurrentAnchor();
		captureSourceState();
	}
	switch (loc.kind) {
		case 'tracks': return applyTracksLocation(loc, restore);
		case 'tag': return applyTagLocation(loc, restore);
		case 'sync':
			ensureRegionMounted('sync', { refresh: opts.refresh });
			shell.openView('sync');
			return true;
		case 'downloads':
			ensureRegionMounted('downloads', { refresh: opts.refresh });
			shell.openView('downloads');
			return true;
		case 'discover': return applyDiscoverLocation(loc, restore, opts.refresh);
	}
}

// Gesture hints for the NEXT navigate / recordNavigation call, set by the
// handler that triggers it synchronously (the sidebar ↑/↓ commands, the
// Start-Journey flow) and consumed on read.
let pendingNavGesture: NavGesture | null = null;
let pendingRecordMode: 'push' | 'replace' | null = null;

function newEntry(loc: NavLocation, label?: string, gesture: NavGesture | null = null, parentId: number | null = null): NavEntry {
	return makeEntry(loc, label ?? locationLabel(loc), { gesture, parentId });
}

interface NavigateOpts {
	mode?: 'push' | 'replace';
	label?: string;
	// A drill-down: the new entry becomes a CHILD of the current one (the
	// breadcrumb shows the chain; "drill back up" traverses to it). Tabs,
	// sidebar rows and searches are roots.
	drill?: boolean;
}

// Record the current view's snapshot and stack `loc` as the new entry.
// Navigating to the location already shown replaces (no duplicate); a run
// of sidebar steps coalesces into one entry.
function recordEntry(loc: NavLocation, opts: NavigateOpts = {}): void {
	const gesture = pendingNavGesture;
	pendingNavGesture = null;
	navHistory.updateCurrentRestore(captureRestore());
	let mode = opts.mode ?? pendingRecordMode ?? 'push';
	pendingRecordMode = null;
	const cur = navHistory.current();
	if (mode === 'push' && gesture === 'sidebar-step' && cur?.gesture === 'sidebar-step' && Date.now() - cur.createdAt < SIDEBAR_STEP_COALESCE_MS) {
		mode = 'replace';
	}
	const entry = newEntry(loc, opts.label, gesture, opts.drill && mode === 'push' ? cur?.id ?? null : null);
	if (mode === 'push') navHistory.push(entry); else navHistory.replace(entry);
}

// THE navigation entry point: record, then apply.
async function navigate(loc: NavLocation, opts: NavigateOpts = {}): Promise<void> {
	recordEntry(loc, opts);
	await applyLocation(loc, null, { refresh: true });
}

// Tab click: activate the tab's OWN history where it was left and show its
// current entry with its snapshot — like switching browser tabs, nothing is
// recorded. A tab with no history yet is seeded with `initial`. Clicking
// the tab that's already active: a search drops to the source root (the tab
// has always been the "dismiss the search" gesture), Discover refreshes its
// feed, everything else is a no-op.
async function switchToTab(tab: NavTab, initial: () => NavLocation): Promise<void> {
	if (navHistory.activeTab() === tab) {
		const cur = navHistory.current();
		if (tab === 'discover' && cur) await applyLocation(cur.location, null, { refresh: true });
		else if (shell.activeView() === 'tracks' && shell.currentJit()) await navigate({ kind: 'tracks', source: shell.activeSource(), scope: { type: 'all' } });
		return;
	}
	navHistory.updateCurrentRestore(captureRestore());
	let entry = navHistory.activateTab(tab);
	while (entry) {
		if (await applyLocation(entry.location, entry.restore, { refresh: true })) return;
		// The tab's current entry died (deleted playlist…) — drop it and show
		// what the tab has left, else start it afresh.
		const at = navHistory.locate(entry.id);
		if (at) navHistory.dropAt(at.tab, at.index);
		showToast('No longer available', { sub: entryLabel(entry), kind: 'info', durationMs: 2500 });
		entry = navHistory.activateTab(tab);
	}
	await navigate(initial());
}

// The open scope changed identity without moving (a JIT got pinned or
// renamed): keep its entry's location in step so breadcrumb labels read
// the new name, and repaint the title.
function syncCurrentEntryLocation(): void {
	const cur = navHistory.current();
	if (cur) {
		const loc = currentLocation();
		navHistory.replace({ ...cur, location: loc, label: locationLabel(loc) });
	}
	paintScopeTitle();
}

// Paint the scope title as a breadcrumb: the current entry's drill-down
// ancestors (buttons — "drill back up" is a targeted traversal), then the
// scope's own title. A root scope paints the plain title; the source root
// with no ancestors hides the slot, as before.
function paintScopeTitle(): void {
	const titleEl = document.getElementById('playlist-title');
	if (!titleEl) return;
	const view = shell.activeView();
	const jitNow = shell.currentJit();
	const text = view === 'interested' ? 'Interested'
		: view === 'basket' ? 'Basket'
			: scopeTitle(currentTracksScope());
	const cur = navHistory.current();
	const chain = navHistory.ancestors();
	titleEl.replaceChildren();
	if (text === null && chain.length === 0) {
		titleEl.hidden = true;
		return;
	}
	titleEl.hidden = false;
	for (const a of chain) {
		const label = entryLabel(a);
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'scope-crumb';
		b.textContent = label;
		b.title = `Back up to ${label}`;
		b.addEventListener('click', (e) => { e.preventDefault(); void traverseToEntry(a.id); });
		titleEl.append(b);
		const sep = document.createElement('span');
		sep.className = 'scope-crumb-sep';
		sep.textContent = '›';
		titleEl.append(sep);
	}
	const here = document.createElement('span');
	here.className = 'scope-crumb is-current';
	here.textContent = text ?? (cur ? locationLabel(cur.location) : '');
	titleEl.append(here);
	// Artist scope — the closest thing to an artist page: the name plus a
	// row of provider links (direct where the library knows the provider's
	// artist id, a search otherwise). Async: the text lands first, the
	// links follow.
	const scopedArtistId = artistIdOfJit(jitNow);
	if (jitNow && scopedArtistId) void renderArtistScopeLinks(titleEl, scopedArtistId, jitNow.name.replace(/^Artist: /, ''));
}

// Breadcrumb click: a targeted traversal to an ancestor entry — its tab is
// activated with the pointer on it (Forward then walks back down the
// chain), and the ancestor's snapshot is restored like a Back. The parent
// may live on another tab (an artist drilled from Pinned). ancestors() only
// lists entries still on a stack, so the id always resolves.
async function traverseToEntry(id: number): Promise<void> {
	const at = navHistory.locate(id);
	if (!at) return;
	const fromTab = navHistory.activeTab();
	const fromIndex = fromTab ? stackOf(navHistory.state(), fromTab)?.index ?? 0 : 0;
	if (at.tab === fromTab && at.index === fromIndex) return;
	const entry = stackOf(navHistory.state(), at.tab)?.entries[at.index];
	if (!entry) return;
	navHistory.updateCurrentRestore(captureRestore());
	navHistory.activateTab(at.tab);
	navHistory.setIndex(at.tab, at.index);
	if (await applyLocation(entry.location, entry.restore, { refresh: false })) return;
	navHistory.dropAt(at.tab, at.index);
	showToast('No longer available', { sub: entryLabel(entry), kind: 'info', durationMs: 2500 });
	// Back to where the click happened.
	if (fromTab) {
		navHistory.activateTab(fromTab);
		navHistory.setIndex(fromTab, at.tab === fromTab && at.index < fromIndex ? fromIndex - 1 : fromIndex);
	}
}

// A surface that moves itself (Discover's feed toolbar, a journey hop)
// reports where it is about to land — called BEFORE it applies the change,
// so the snapshot still describes the view being left.
function recordNavigation(loc: NavLocation, label?: string): void {
	recordEntry(loc, { label });
}

// Back / forward within the active tab's stack. Dead entries (a deleted
// playlist, a pruned result set) are dropped and the traversal keeps going
// in the same direction; if nothing in that direction is reachable the
// pointer stays put.
async function traverseHistory(delta: -1 | 1): Promise<void> {
	const tab = navHistory.activeTab();
	const start = tab ? stackOf(navHistory.state(), tab) : null;
	if (!tab || !start) return;
	const origin = start.index;
	let idx = origin + delta;
	if (idx < 0 || idx >= start.entries.length) return;
	navHistory.updateCurrentRestore(captureRestore());
	let droppedBelow = 0;
	for (;;) {
		const st = stackOf(navHistory.state(), tab);
		if (!st || idx < 0 || idx >= st.entries.length) break;
		const entry = st.entries[idx]!;
		navHistory.setIndex(tab, idx);
		if (await applyLocation(entry.location, entry.restore, { refresh: false })) return;
		navHistory.dropAt(tab, idx);
		showToast('No longer available', { sub: entryLabel(entry), kind: 'info', durationMs: 2500 });
		// Going back, the drop sits below the origin (which shifts down by
		// one); going forward the next entry slides into `idx`.
		if (delta < 0) { idx -= 1; droppedBelow += 1; }
	}
	navHistory.setIndex(tab, origin - droppedBelow);
}

function goBack(): void { void traverseHistory(-1); }
function goForward(): void { void traverseHistory(1); }

// ─── Agent dock (app-level) ─────────────────────────────────────────────
// The agent panel docks as the third .app grid column so it's available on
// EVERY tab, capturing the current view as context; result sets and view
// commands navigate the Discover region regardless of where they were asked.

const AGENT_DOCK_KEY = 'curator.agent-panel-open';
let setAgentDockOpen: (open: boolean) => void = () => {};

function toggleAgentDock(): void {
	const host = document.getElementById('agent-dock-host');
	if (host) setAgentDockOpen(host.hidden);
}

// Snapshot of where the user is standing, attached to each agent message —
// the model scopes ambiguous asks ("show me tracks") to it, while explicit
// references ("in my library") override it (see core's SYSTEM_PROMPT rules).
function captureAgentViewContext(): AgentViewContext {
	const view = shell.activeView();
	if (view === 'discover') {
		const filters = discoverView?.getFilters();
		return { view, discover: { mode: currentDiscoverMode, ...(filters ?? {}) } };
	}
	const ctx: AgentViewContext = { view };
	if (view === 'tracks') {
		ctx.source = shell.activeSource();
		const plId = shell.currentPlaylistId();
		if (plId) {
			const pl = library.getPlaylist(plId);
			if (pl) ctx.playlist = { id: pl.id, name: pl.name, source: pl.source };
		} else if (shell.currentFolderId()) {
			ctx.folderName = 'a playlist folder';
		}
	}
	return ctx;
}

// Result sets the agent handed over this session, by id — the traversal
// applier shows them from here before falling back to the IPC lookup.
const agentResultSetsSeen = new Map<string, AgentResultSet>();

function showAgentResultSet(rs: AgentResultSet): void {
	agentResultSetsSeen.set(rs.id, rs);
	void navigate({ kind: 'discover', mode: 'agent-results', resultSetId: rs.id }, { label: rs.title });
}

function applyAgentViewCommand(cmd: AgentViewCommand): void {
	if (cmd.type !== 'set-feed-filters') return;
	// Omitted field = leave that filter alone; null = clear it.
	const cur = discoverView?.getNavState() ?? { archived: false, genre: null, label: null };
	void navigate({
		kind: 'discover',
		mode: 'feed',
		archived: cur.archived,
		genre: 'genre' in cmd ? cmd.genre ?? null : cur.genre,
		label: 'label' in cmd ? cmd.label ?? null : cur.label,
	});
}

function mountAgentDock(): void {
	const host = document.getElementById('agent-dock-host');
	if (!host) return;
	// Fixed right-edge handle — the toggle that exists on every tab.
	const handle = document.createElement('button');
	handle.className = 'agent-dock-handle';
	handle.textContent = '✦ AGENT';
	handle.title = 'Toggle the agent panel';
	document.body.append(handle);
	setAgentDockOpen = (open: boolean): void => {
		host.hidden = !open;
		handle.classList.toggle('is-open', open);
		try { localStorage.setItem(AGENT_DOCK_KEY, open ? '1' : '0'); } catch { /* private mode */ }
	};
	handle.addEventListener('click', () => toggleAgentDock());
	agentPanel = mountAgentPanel(host, {
		onToast: (msg, kind, sub) => showToast(msg, { kind, sub }),
		onResultSet: (rs) => showAgentResultSet(rs),
		onViewCommand: (cmd) => applyAgentViewCommand(cmd),
		getViewContext: () => captureAgentViewContext(),
	});
	setAgentDockOpen(localStorage.getItem(AGENT_DOCK_KEY) === '1');
}

// App-wide "Start Journey" entry point (track context menus, feed cards):
// jump to Discover in Journeys mode and create the journey from the seed.
function startJourneyFromSeed(seed: JourneySeed): void {
	void (async () => {
		// Land on the journey list first (an entry of its own), then let the
		// JourneyView report the created journey's node — which REPLACES
		// that list entry so Back from the new journey returns to where the
		// seed came from, not to an empty list the user never looked at.
		await navigate({ kind: 'discover', mode: 'journeys', journeyId: null, nodeId: null });
		pendingRecordMode = 'replace';
		try { await journeyView?.startFromSeed(seed); }
		finally { pendingRecordMode = null; }
	})();
}

// Populate syncRows from the known-playlists cache so the table shows a
// stable list whenever the sync view is visible, not just during a sync.
// During a sync, the event stream overwrites individual rows in place; this
// only fills empty slots so we never trample fresh data.
function seedSyncRowsFromPlaylists(): void {
	if (syncState.running()) return;
	syncState.clearRows();
	for (const p of library.allPlaylists()) {
		if (p.source !== 'spotify') continue; // the Sync view is Spotify-only; Tidal syncs via its background path
		syncState.upsertRow(p.id, {
			playlistId: p.id,
			name: p.name,
			source: p.source,
			mark: p.mark,
			state: p.syncStatus === 'synced' ? 'synced' : 'pending',
			trackCount: p.trackCount ?? undefined,
		});
	}
}

// renderSyncView retired — see components/SyncView.tsx. The component
// mounts into #sync-view in boot() and re-renders reactively from the
// data/sync.ts store via computeSyncRowSnapshots().

// ─── Refresh all UI from server ───────────────────────────────────────────

// Repaints the Interested + Basket count badges in the top-nav. Called from
// refreshAll on boot/refresh and after any tag mutation so the numbers stay
// honest without a full refreshAll round-trip.
async function refreshTagCounts(): Promise<void> {
	try {
		const counts = await window.api['tags:counts']();
		setTagCountsSignal((prev) => ({
			...prev, // preserve downloads/discover — updated by their own paths
			interested: counts[SYSTEM_TAG_INTERESTED] ?? 0,
			basket: counts[SYSTEM_TAG_BASKET] ?? 0,
		}));
	} catch (err) {
		tagsLog.error('counts fetch failed', err);
	}
}

async function refreshAll(): Promise<void> {
	// Artist counts move with the library; refetch only when the folder is
	// open (its rows are what the user is looking at).
	if (artistsExpanded()) void loadArtists();
	// Releases change with syncs / the background album fill — the next
	// grouped render refetches the summaries it shows.
	albums.invalidate();
	const [auth, playlists, sourceCounts] = await Promise.all([
		window.api['auth:status'](),
		window.api['playlists:list'](),
		// Cheap COUNT GROUP BY — renderEmptyState reads the local count to
		// decide whether the Rekordbox tab still needs its onboarding panel
		// (no rekordbox library AND no files) or falls through to the table.
		window.api['tracks:source-counts'](),
		// Watched library folders feed Settings → Library and the omnibar's
		// Rekordbox pill gate — fetch alongside the rest.
		refreshLibraryFolders(),
		refreshTagCounts(),
		// User-tag definitions feed the omnibar's `#tag` autocomplete, the
		// player chip row, and the track-list "tags" column. Rekordbox sync
		// can add/rename tags, so refresh after every refreshAll — same
		// cadence as the tag-counts repaint above.
		tagsStore.loadTagDefinitions(true),
	]);
	library.setPlaylists(playlists);
	library.setAuth(auth);
	library.setSourceCounts(sourceCounts);
	// Keep the Organize catalog (playlists + folder ancestry) warm in the
	// background — after setAuth, since the ownedByMe mapping reads auth ids.
	refreshOrganizeCatalog();
	const forActive = playlists.filter((p) => p.source === shell.activeSource());
	renderEmptyState(auth, forActive.length > 0);
	// Synchronous paints first — these read entirely from the state we just
	// populated, so they finish in ~5ms and the sidebar / top-right are on
	// screen before the still-pending async IPCs (tracks, sync-status)
	// resolve. The sidebar repaints reactively off the library.setPlaylists /
	// setAuth ticks above.
	await Promise.all([
		renderTopRight(auth),
		renderTracks(),
	]);
	// Once we know Spotify is connected, pre-load the Web Playback SDK in
	// the background. Without this the first dblclick races against SDK
	// boot and misses Chromium's user-gesture window for EME activation —
	// the symptom is "track plays 1-2s then 500s on license; Space resumes".
	if (auth.spotify.connected) void player.prewarmSpotify();
	// Lazy-load the Rekordbox tree only once we're on the tab that shows it.
	// On a Spotify/Tidal session this never fires, so boot and tab switches
	// skip the heavy `rekordbox:tree` IPC entirely.
	if (sourceNeedsRekordboxTree(shell.activeSource())) void ensureRekordboxTree();
}

// Lightweight refresh of playlist metadata for the Sync view during an active
// sync. Doesn't touch the rest of the UI to avoid flicker.
async function refreshPlaylistsForSyncView(): Promise<void> {
	const playlists = await window.api['playlists:list']();
	// SyncView snapshots join playlist timestamps via library.getPlaylist —
	// reactive through the library tick, so this refresh repaints them.
	library.setPlaylists(playlists);
	// Keep the rb tree's sidebar badges in step — membership writes (Organize
	// modal, sidebar drop) update the same playlist table the tree was read
	// from, and the tree cache doesn't otherwise refetch.
	library.patchRekordboxCounts(playlists);
	// Same table feeds the Organize catalog — refresh it too (debounced, so
	// per-playlist sync transitions coalesce into one fetch after the burst).
	refreshOrganizeCatalog();
}

// ─── UI zoom (Ctrl/Cmd + = / - / 0) ─────────────────────────────────────────
// Browser-style zoom shortcuts. Persists the level so the next session opens
// at the same scale. Listens at the window level so it works regardless of
// where focus is (search input, etc.) — preventDefault keeps
// the shortcut from inserting a literal +/- into a focused field.

const ZOOM_PERSIST_KEY = 'curator.zoom.v1';

// Chromium-native zoom (Ctrl + / - / 0). Persists across sessions. The
// counter-zoom on the topframe (so its chrome stays at 100% regardless
// of body zoom) is applied INSIDE TopFrame via a createEffect on the
// zoomLevelSignal — main.ts just keeps the signal in sync with whatever
// Chromium reports.
function wireZoom(): void {
	try {
		const raw = localStorage.getItem(ZOOM_PERSIST_KEY);
		if (raw != null) {
			const n = Number(raw);
			if (Number.isFinite(n)) window.api.zoom.set(n);
		}
	} catch (err) {
		log.for('zoom').warn('restore failed', undefined, err);
	}
	setZoomLevelSignal(window.api.zoom.get());

	const after = (): void => {
		try { localStorage.setItem(ZOOM_PERSIST_KEY, String(window.api.zoom.get())); }
		catch { /* */ }
		setZoomLevelSignal(window.api.zoom.get());
	};

	window.addEventListener('keydown', (e) => {
		if (isModalOpen()) return;
		if (!(e.ctrlKey || e.metaKey)) return;
		if (e.key === '+' || e.key === '=') {
			e.preventDefault();
			window.api.zoom.in();
			after();
		} else if (e.key === '-') {
			e.preventDefault();
			window.api.zoom.out();
			after();
		} else if (e.key === '0') {
			e.preventDefault();
			window.api.zoom.reset();
			after();
		}
	});
}

// ─── Settings modal ────────────────────────────────────────────────────────
// New home for the Spotify/Tidal connection + Sync controls that used to
// live in the old topbar's right-hand `.src-actions` slot. Opens via the
// gear button in the top-frame user cluster.
//
// The modal shell + tabs + open/close lifecycle moved into the
// SettingsModal Solid component (layouts/SettingsModal.tsx). The
// per-panel body painters (renderSettingsConnections,
// renderSettingsRekordbox, renderSettingsPlayer, renderSettingsUI) live
// in features/settings.ts (F3.1) and are fed through onTabActivate when
// a tab becomes active. main.ts keeps these open/close entry points
// because boot() owns the mounted SettingsModalHandle.

function openSettingsModal(tab: SettingsTab = 'connections'): void {
	settingsModal?.open(tab);
}

function closeSettingsModal(): void {
	settingsModal?.close();
}

// (handleSettingsTabActivate / handleSettingsClose moved to
// features/settings.ts — F3.1; wired into mountSettingsModal in boot().)

// (renderSettingsConnections + pushAllSourceSyncSettingsToCore + the
// Rekordbox settings panel/persistence moved to features/settings.ts — F3.1)

// Rekordbox sidebar-tree expanded state — persisted across sessions;
// written by expandRbAncestors + the sidebar chevron toggle, restored
// into the rekordboxExpanded signal in boot().
const REKORDBOX_EXPANDED_KEY = 'curator.rekordbox-expanded.v1';

function loadRekordboxExpanded(): Set<string> {
	try {
		const raw = localStorage.getItem(REKORDBOX_EXPANDED_KEY);
		if (!raw) return new Set();
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'));
	} catch { /* corrupt storage — fall through to empty set */ }
	return new Set();
}

function saveRekordboxExpanded(s: Set<string>): void {
	try { localStorage.setItem(REKORDBOX_EXPANDED_KEY, JSON.stringify([...s])); }
	catch (err) { rbLog.warn('persist expanded failed', undefined, err); }
}

// ─── Pinned searches — persisted folder-expansion + list loader ──────────────
const PINNED_EXPANDED_KEY = 'curator.pinned-expanded.v1';
function loadPinnedExpanded(): boolean {
	// Default open ('0' is the only collapsed sentinel) so the folder shows its
	// contents the moment the user pins something.
	try { return localStorage.getItem(PINNED_EXPANDED_KEY) !== '0'; }
	catch { return true; }
}
function savePinnedExpanded(v: boolean): void {
	try { localStorage.setItem(PINNED_EXPANDED_KEY, v ? '1' : '0'); }
	catch (err) { pinnedLog.warn('persist expanded failed', undefined, err); }
}
// ─── Artists folder — persisted expansion + on-demand loader ────────────────
const ARTISTS_EXPANDED_KEY = 'curator.artists-expanded.v1';
const artistsLog = log.for('artists');
function loadArtistsExpanded(): boolean {
	try { return localStorage.getItem(ARTISTS_EXPANDED_KEY) === '1'; }
	catch { return false; }
}
function saveArtistsExpanded(v: boolean): void {
	try { localStorage.setItem(ARTISTS_EXPANDED_KEY, v ? '1' : '0'); }
	catch (err) { artistsLog.warn('persist expanded failed', undefined, err); }
}
// Fetch the rows the folder shows. Sequence-guarded so a slow earlier query
// can't overwrite a newer filter's result.
let artistsLoadSeq = 0;
let artistsSearchTimer: ReturnType<typeof setTimeout> | null = null;
async function loadArtists(): Promise<void> {
	const my = ++artistsLoadSeq;
	setArtistsLoading(true);
	try {
		const q = artistsSearch().trim();
		const rows = await window.api['artists:list']({ search: q || undefined, limit: 200, scope: artistScopeForTab(shell.activeSource()) });
		if (my !== artistsLoadSeq) return;
		setArtistsList(rows);
	} catch (err) {
		artistsLog.error('load failed', err);
	} finally {
		if (my === artistsLoadSeq) setArtistsLoading(false);
	}
}
// The Artists folder counts (and the Suggested merges review) are over the
// active tab's tracks, like the tracklist itself: a provider's source_link
// membership, or rekordbox ∪ local files for the Rekordbox tab.
function artistScopeForTab(src: SourceTab): ArtistScope {
	return { sources: src === 'rekordbox' ? ['rekordbox', 'local'] : [src] };
}
const TAB_LABEL: Record<SourceTab, string> = { spotify: 'Spotify', tidal: 'Tidal', rekordbox: 'Rekordbox' };

// The artist id behind the loaded JIT when it is an "Artist: X" scope — the
// query the chips / drill / folder all build is exactly `artistid={id}`.
function artistIdOfJit(jit: JitPlaylist | null): string | null {
	const m = jit?.query.match(/^artistid=\{([^}]+)\}$/);
	return m?.[1] ?? null;
}
// After a rename/merge: refetch the folder, then the tracklist (credits on
// rows changed) and the sidebar counts follow through the signals.
async function afterArtistMutation(): Promise<void> {
	await loadArtists();
	await renderTracks();
}
// Paint the provider link row into the scope title. Re-checks that the same
// artist scope is still open when the links arrive (the user may have moved
// on) so a slow lookup never decorates the wrong title.
async function renderArtistScopeLinks(titleEl: HTMLElement, artistId: string, name: string): Promise<void> {
	let links: ArtistLink[] = [];
	try { links = await window.api['artists:links'](artistId); } catch { /* links are optional */ }
	if (artistIdOfJit(shell.currentJit()) !== artistId) return;
	// Two paints of the same scope in flight (lazy sync, a refresh) must not
	// stack two link rows.
	titleEl.querySelector('.scope-links')?.remove();
	const row = document.createElement('span');
	row.className = 'scope-links';
	for (const l of artistExternalLinks(name, links)) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'scope-link';
		b.classList.toggle('is-direct', l.direct);
		b.textContent = l.label;
		b.title = l.direct ? `Open ${name} on ${l.label}` : `Search ${l.label} for ${name}`;
		b.addEventListener('click', (e) => { e.preventDefault(); void window.api['shell:open-external'](l.url); });
		row.appendChild(b);
	}
	titleEl.appendChild(row);
}

function showArtistContextMenu(evt: MouseEvent, id: string): void {
	const a = artistsList().find((x) => x.id === id);
	if (!a) return;
	void (async () => {
		let links: ArtistLink[] = [];
		try { links = await window.api['artists:links'](id); } catch { /* optional */ }
		const ext = artistExternalLinks(a.name, links);
		const handlers: Record<string, () => void> = {};
		const items: ContextMenuItem[] = [{ kind: 'header', label: a.name }];
		for (const l of ext) {
			items.push({ kind: 'item', id: `open-${l.id}`, label: l.direct ? `Open on ${l.label}` : `Search ${l.label}` });
			handlers[`open-${l.id}`] = () => { void window.api['shell:open-external'](l.url); };
		}
		items.push({ kind: 'divider' }, { kind: 'item', id: 'rename', label: 'Rename…' }, { kind: 'item', id: 'merge', label: 'Merge into…' }, { kind: 'item', id: 'suggest', label: 'Suggested merges…' });
		handlers['suggest'] = () => artistMergeReview?.open();
		showArtistEditMenu(evt, a, items, handlers);
	})();
}

function showArtistEditMenu(evt: MouseEvent, a: ArtistSummary, items: ContextMenuItem[], extra: Record<string, () => void>): void {
	openContextMenu(items, {
		...extra,
		rename: () => openNamePrompt({
			title: 'Rename artist',
			label: 'Name — every track credited to this artist is rewritten',
			initial: a.name,
			confirmLabel: 'Rename',
			onSubmit: (name) => {
				void (async () => {
					try {
						const res = await window.api['artists:rename'](a.id, name);
						showToast(`Renamed to ${res.artist.name}`, { sub: `${res.tracksRewritten} track${res.tracksRewritten === 1 ? '' : 's'} updated`, kind: 'success' });
						await afterArtistMutation();
					} catch (err) {
						showToast('Rename failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
					}
				})();
			},
		}),
		merge: () => openNamePrompt({
			title: `Merge "${a.name}" into…`,
			label: 'Target artist — its spelling wins; this one becomes an alias',
			confirmLabel: 'Merge',
			onSubmit: (name) => {
				void (async () => {
					try {
						const target = await window.api['artists:resolve'](name);
						if (!target) { showToast('Unknown artist', { sub: `"${name}" is not in your library`, kind: 'error' }); return; }
						if (target.id === a.id) { showToast('Same artist', { sub: 'Nothing to merge', kind: 'info' }); return; }
						const res = await window.api['artists:merge'](target.id, a.id);
						showToast(`Merged into ${res.artist.name}`, { sub: `${res.tracksRewritten} track${res.tracksRewritten === 1 ? '' : 's'} rewritten`, kind: 'success' });
						await afterArtistMutation();
					} catch (err) {
						showToast('Merge failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
					}
				})();
			},
		}),
	}, { at: evt });
}

// Reload the Pinned folder from the backend. The reactive signal re-feeds the
// sidebar snapshot, so the nav repaints itself — no manual bump needed.
async function loadPinnedSearches(): Promise<void> {
	try { setPinnedSearches(await window.api['pinned:list']()); }
	catch (err) { pinnedLog.error('load failed', err); }
}

// ─── Sync-to-Rekordbox modal — persisted checkbox state ─────────────────────
// Separate storage key from RekordboxSettings (which holds the READ-side
// flags). The write-side modal's flags are user-chosen per-sync but should
// stick across opens — defaults match the locked v1 PRD (Metadata + Cues on,
// Beatgrid+phrases + Waveform off+disabled).
const SYNC_TO_RB_FLAGS_KEY = 'curator.sync-to-rekordbox-flags.v1';

function loadSyncToRekordboxFlags(): SyncFlags {
	try {
		const raw = localStorage.getItem(SYNC_TO_RB_FLAGS_KEY);
		if (!raw) return { ...DEFAULT_SYNC_FLAGS };
		const parsed = JSON.parse(raw) as Partial<SyncFlags>;
		return { ...DEFAULT_SYNC_FLAGS, ...parsed };
	} catch {
		return { ...DEFAULT_SYNC_FLAGS };
	}
}

function saveSyncToRekordboxFlags(s: SyncFlags): void {
	try { localStorage.setItem(SYNC_TO_RB_FLAGS_KEY, JSON.stringify(s)); }
	catch (err) { log.for('sync-to-rb-flags').warn('persist failed', undefined, err); }
}

// Pull-side (Sync from Rekordbox) checkbox state — separate key from the push
// flags and the read-side RekordboxSettings; defaults pull everything.
const SYNC_FROM_RB_FLAGS_KEY = 'curator.sync-from-rekordbox-flags.v1';

function loadSyncFromRekordboxFlags(): PullFlags {
	try {
		const raw = localStorage.getItem(SYNC_FROM_RB_FLAGS_KEY);
		if (!raw) return { ...DEFAULT_PULL_FLAGS };
		const parsed = JSON.parse(raw) as Partial<PullFlags>;
		return { ...DEFAULT_PULL_FLAGS, ...parsed };
	} catch {
		return { ...DEFAULT_PULL_FLAGS };
	}
}

function saveSyncFromRekordboxFlags(s: PullFlags): void {
	try { localStorage.setItem(SYNC_FROM_RB_FLAGS_KEY, JSON.stringify(s)); }
	catch (err) { log.for('sync-from-rb-flags').warn('persist failed', undefined, err); }
}

// (auto-analyze settings store moved to features/analysisFlags.ts — shared by
// the Library folders panel and boot(); the unified flags view lives in
// features/analysisFlagsForm.tsx.)

// (Rekordbox settings panel painters, startRekordboxImport, the User
// Interface settings store + visibility memos, and the Player/UI settings
// panels moved to features/settings.ts + features/uiSettings.ts — F3.1)

// ─── Resizable columns + sidebar ──────────────────────────────────────────
// Both kinds of resize follow the same shape: a 6px-wide handle absolutely
// positioned at the right edge of the resizable element, mousedown starts
// a drag, mousemove updates the affected width inline (CSS variable for
// the sidebar, <col> width for the table column), mouseup persists.

const MIN_SIDEBAR_W = 160;
const MAX_SIDEBAR_W = 600;

// Sidebar width persistence — restored on boot. Column widths used to be
// applied here too but moved into the TrackListView mount (passed via
// initialColumnWidths so the table opens at the right size on the first
// paint rather than a flash of the default).
function applyPersistedSidebarWidth(): void {
	const sb = getSidebarW();
	if (typeof sb === 'number') {
		document.documentElement.style.setProperty('--sidebar-w', `${sb}px`);
	}
}

// wireColumnResizing was deleted alongside the static table. Column resize
// handles are created per-instance inside mountTrackList and persist via
// the onColumnResize callback wired in boot().

function wireSidebarResize(): void {
	const sidebar = document.querySelector<HTMLElement>('.sidebar');
	if (!sidebar) return;
	if (sidebar.querySelector('.sidebar-resize-handle')) return;
	const handle = document.createElement('div');
	handle.className = 'sidebar-resize-handle';
	sidebar.appendChild(handle);

	handle.addEventListener('mousedown', (e) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = sidebar.offsetWidth || sidebar.getBoundingClientRect().width;
		document.body.style.cursor = 'col-resize';
		document.body.classList.add('resizing');

		const onMove = (mv: MouseEvent): void => {
			const dx = mv.clientX - startX;
			const w = Math.max(MIN_SIDEBAR_W, Math.min(MAX_SIDEBAR_W, startW + dx));
			document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
		};
		const onUp = (): void => {
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
			document.body.style.cursor = '';
			document.body.classList.remove('resizing');
			setSidebarW(sidebar.offsetWidth);
		};
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	});
}





async function boot(): Promise<void> {
	// First: window-level error capture, so failures during the rest of
	// bootstrap already reach the session log file via the IPC sink.
	installGlobalErrorCapture();
	// Renderer settings restored with a snapshot at this boot: seed
	// localStorage and reload once, so every module-level settings read
	// (ui settings, rekordbox flags, …) sees the restored values. The main
	// process hands the file over exactly once, so the reload is clean.
	try {
		const restored = await backupApi.takePendingRendererSettings();
		if (restored && Object.keys(restored).length > 0) {
			for (const [k, v] of Object.entries(restored)) { try { localStorage.setItem(k, v); } catch { /* quota / disabled storage */ } }
			log.for('backup').info('restored renderer settings — reloading', { keys: Object.keys(restored).length });
			location.reload();
			return;
		}
	} catch (err) {
		log.for('backup').warn('pending renderer settings check failed', { err: String(err) });
	}
	// Diagnostic — when this string appears in the console/log we know the
	// new renderer code is loaded. If it's missing, you're on a stale bundle.
	log.for('boot').info('renderer booted — build:tidal-feedback', { at: new Date().toISOString() });
	// Perf instrumentation (F5). Marks land in the performance timeline;
	// window.__perf() dumps a {name: ms} table for dev inspection. Cheap —
	// a few mark/measure calls, no HUD, no deps.
	performance.mark('boot:start');
	(window as unknown as { __perf?: () => Record<string, number> }).__perf = () =>
		Object.fromEntries(performance.getEntriesByType('measure').map((m) => [m.name, Math.round(m.duration)]));
	// Drive the now-playing equalizer bars from the live loopback FFT. Just
	// subscribes to player state (idles when nothing plays) — safe this early.
	startEqDriver();
	// Feature-module dependency injection (F3.1/F3.2) — the feature modules
	// call back into navigation / sync / library code that still lives in
	// this file. Wire them FIRST so everything below (boot-time settings
	// pushes, modal mount, tab-fallback effect) finds deps in place.
	initUiSettingsFeature({
		// A hidden tab is a forced move onto another tab — a tab switch (the
		// hidden tab keeps its own history for when it's shown again).
		fallbackToSource: (src) => { void switchToTab(src, () => ({ kind: 'tracks', source: src, scope: sourceTabScope(src) })); },
		fallbackToTracks: () => {
			const src = shell.activeSource();
			void switchToTab(src, () => ({ kind: 'tracks', source: src, scope: sourceTabScope(src) }));
		},
	});
	initSettingsFeature({
		closeSettingsModal,
		runSpotifySync,
		runTidalSync: runTidalSyncNow,
		refreshAll,
		updateReorderableState,
		// Library-folders painters now live in features/libraryPanel.ts —
		// forwarded here so settings stays decoupled from that module's init.
		refreshLibraryFolders,
		renderLibraryFoldersModalIfOpen,
		getDeck: () => deck,
		getAutoplayNext: player.getAutoplayNext,
		setAutoplayNext: player.setAutoplayNext,
	});
	initEditTrackFeature({
		// boot() mounts the TrackEditModal below; the getter resolves the
		// handle lazily so init order doesn't matter.
		getModal: () => trackEditModal,
		getMergeDialog: () => mergeTracksDialog,
		renderTracks,
		refreshAll,
		patchTrackRow: (t) => { mainTrackList?.patchOne(t); },
		invalidateTrackCaches: (trackId) => {
			tagsStore.invalidateTrack(trackId);
			analysisStore.invalidate(trackId);
		},
	});
	initLibraryPanelFeature({
		getLibraryScanByFolder: () => state.libraryScanByFolder,
		refreshAll,
		analyzeFolder: (folderId, name) => { void openAnalyzeForScope({ libraryFolderId: folderId }, name); },
	});
	// One deps object feeds both the context-menus feature (playlist / folder /
	// downloads / src-header menus) and the track-command layer (the track-row
	// menus + the shared Remove-from-playlist / Delete-dialog flows).
	const menuDeps: ContextMenusFeatureDeps = {
		getTracksFilter: () => state.tracksFilter,
		setTracksFilter: (filter) => { state.tracksFilter = filter; },
		getSort: () => ({ column: state.sortColumn, dir: state.sortDir }),
		setEnriching: (e) => { setEnriching(e); },
		clearEnrichment,
		renderTracks,
		refreshAll,
		refreshTagCounts,
		refreshPlaylistsForSyncView,
		applyFilterToMainList,
		getMainTracksUnfiltered: () => mainTracksUnfiltered,
		setMainTracksUnfiltered: (tracks) => { mainTracksUnfiltered = tracks; },
		currentPlaylistPositionBase,
		compactCurrentPlaylistPositions,
		getSelectedTrackIds,
		getSelectionAnchor,
		setTrackSelection,
		// Handles resolve lazily — boot() mounts the track list + analyze
		// modal below, after this init runs.
		getMainTrackList: () => mainTrackList,
		getAnalyzeModal: () => analyzeModal,
		openSyncToRekordboxModal,
		openSyncFromRekordboxModal,
		openRatingDialogForTracks,
		removeTracksFromPlaylist: (playlistId, trackIds) => commitPlaylistChanges(playlistId, [], trackIds, { toast: 'always' }),
		openDeleteTracksDialog: (tracks) => new Promise((resolve) => {
			if (!deleteTracksDialog) { resolve(null); return; }
			deleteTracksDialog.open({ tracks, onConfirm: (sources) => resolve(sources), onCancel: () => resolve(null) });
		}),
		// No host → resolve false: a destructive action never proceeds unconfirmed.
		confirm: (opts) => new Promise((resolve) => {
			if (!confirmDialog) { resolve(false); return; }
			confirmDialog.open({ ...opts, onConfirm: () => resolve(true), onCancel: () => resolve(false) });
		}),
		wavConvert: {
			begin: (playlistId, sourceName) => { wavConvertDialog?.begin(playlistId, sourceName); },
			fail: (playlistId, message) => {
				if (wavConvertDialog) wavConvertDialog.handleEvent({ kind: 'failed', runId: '', playlistId, message });
				else showToast('Could not start conversion', { sub: message, kind: 'error', durationMs: 6000 });
			},
			reopenIfActive: () => !!wavConvertDialog?.isRunActive() && wavConvertDialog.reopen(),
		},
		openOrganize: (ids) => { void openOrganizeForTracks(ids); },
		openDownloadsView,
		// Navigate to ▶ / Find Similar land as CHILDREN of the current entry
		// (the breadcrumb's "drill back up" path).
		openPlaylistById: (id) => openPlaylistById(id, { drill: true }),
		enterJitScope: (jit, selectTrackId) => enterJitScope(jit, selectTrackId, { drill: true }),
		cssEscape,
		startJourneyFromTrack: (trackId) => startJourneyFromSeed({ kind: 'library-track', trackId }),
		getPinnedSearches: () => pinnedSearches(),
		unpinSearch: (id) => { void unpinSearch(id); },
		createPlaylistFromPinned: (id) => { void createPlaylistFromPinned(id); },
		openRenameDialog,
	};
	initContextMenusFeature(menuDeps);
	initTrackCommands(menuDeps);
	// Construct the AudioContext early so its ~50-100ms init cost doesn't
	// land on the first user click. Context stays suspended until a play()
	// call resumes it (Chromium autoplay policy is satisfied by that click).
	player.prewarmAudio();
	// Mount the AppShell FIRST. index.html ships only #app-root; every
	// subsequent wireX / mountX / getElementById call in this function
	// assumes the .app-shell skeleton (region hosts + overlay markup)
	// is already in the DOM. Synchronous Solid render — by the time
	// this returns the document is ready to be queried.
	const appRoot = document.getElementById('app-root');
	if (appRoot) {
		appShell = mountAppShell(appRoot);
	} else {
		log.for('boot').error('#app-root not found — bundle/index.html mismatch');
	}
	// Hydrate persisted UI state BEFORE wiring so the top-nav classes + sort
	// header land on the right initial values.
	loadUiState();
	setRekordboxExpanded(loadRekordboxExpanded());
	setPinnedExpanded(loadPinnedExpanded());
	void loadPinnedSearches();
	// Pull rb's cue palette into the renderer cache. Non-blocking — first
	// paint uses the fallback color for ~10 ms until the IPC roundtrip
	// returns. cueColor() / cuePaletteEntries() in cuePalette.ts are the
	// only callers; components import from there, never from rb directly.
	void loadCuePalette();
	// Push the auto-analyze settings to core. Core defaults to disabled;
	// renderer's localStorage is the source of truth across restarts.
	// Fire-and-forget — by the time the first scanner ingest fires this
	// will have landed (IPC is fast, scanner watchers are async).
	void pushAutoAnalyzeToCore(loadAutoAnalyzeSettings());
	// Per-source sync settings: core (app_setting) is canonical; this loads
	// them into the renderer cache and re-pushes so core's scheduler starts
	// each source's poll timer only now that the window is up.
	void pushAllSourceSyncSettingsToCore();
	// Credit format is core-owned (the rekordbox push reads it) — hydrate the
	// display mirror from core before the first tracklist paint settles.
	void hydrateCreditFormatFromCore().then(() => renderTracks());
	// Mount MainPane FIRST — it owns the .main inner DOM (filter bar,
	// search input, sync/dl views, tracks-view
	// host). Every wireX() and renderX() below queries elements by id
	// inside this subtree, so the layout must exist before they run.
	const mainPaneHost = document.getElementById('main-pane-host');
	if (mainPaneHost) {
		mainPane = mountMainPane(mainPaneHost, {
			nav: {
				canBack: navHistory.canBack,
				canForward: navHistory.canForward,
				backLabel: () => { const e = navHistory.backEntry(); return e ? entryLabel(e) : null; },
				forwardLabel: () => { const e = navHistory.forwardEntry(); return e ? entryLabel(e) : null; },
				onBack: goBack,
				onForward: goForward,
			},
			tracklist: {
				groupBy: () => uiSettingsSignal().trackGroupBy,
				rowLines: () => uiSettingsSignal().trackRowLines,
				open: tracklistMenu,
				onGroupClick: (anchor) => openTracklistMenu('group', anchor),
				// One click flips 1 ↔ 2 lines (the layout effect remounts).
				onRowsToggle: () => updateUiSettings((d) => { d.trackRowLines = d.trackRowLines === 1 ? 2 : 1; }),
			},
		});
	}
	// Region derivation — THE single writer of region visibility, body
	// data attributes, and player dock/mode. Mounted as soon as the hosts
	// exist; from here on, view state renders itself (boot restore, tab
	// switches, async repaints all flow through the same derivation).
	regionEffect = mountRegionEffect({
		applyPlayerMode: setCurrentPlayerModeSignal,
		deckPlayerModePref,
	});
	// Dirty-replay for the gated tracks repaint: a render requested while
	// the table's region was inactive runs exactly once on return.
	createEffect(() => {
		if (shell.showsTracksLayout() && tracksRepaintDirty) {
			tracksRepaintDirty = false;
			void renderTracks();
		}
	});
	// Discover / Downloads / Sync regions are LAZY-mounted on first open
	// via ensureRegionMounted() (F5) — see mountDiscoverRegion/etc. above.
	// They no longer mount (or fetch) at boot; the host divs MainPane just
	// rendered stay empty until visited.
	// SettingsModal — Solid component owning the tabbed modal shell.
	// Panel bodies are filled by handleSettingsTabActivate via the
	// existing renderSettings*() functions. Visibility is driven by the
	// component's internal signals — main.ts calls settingsModal.open()
	// / .close() instead of toggling a `hidden` attribute.
	const settingsModalHost = document.getElementById('settings-modal-host');
	if (settingsModalHost) {
		settingsModal = mountSettingsModal(settingsModalHost, {
			onTabActivate: handleSettingsTabActivate,
			onClose: handleSettingsClose,
		});
	}
	// TrackEditModal — Solid component owning the edit-track form shell.
	// openTrackEditor() / saveTrackEditor() (features/editTrack.ts) own the
	// field load + save logic, reaching into the form via the injected handle.
	const trackEditModalHost = document.getElementById('track-edit-modal-host');
	if (trackEditModalHost) {
		trackEditModal = mountTrackEditModal(trackEditModalHost, {
			onSubmit: () => { void saveTrackEditor(); },
			onClose: () => { handleTrackEditorClose(); },
			onResetField: (field) => resetTrackEditorField(field),
			// Artist suggestions from the library's artist table (fold-matched,
			// most-used first) — the same source as the Artists browser.
			searchArtists: (q) => window.api['artists:list']({ search: q, limit: 12 }),
		});
	}

	// RatingDialog — center-screen star picker. Caller (context menu / R
	// shortcut) sets ratingDialogTargetIds before calling open(); the submit
	// callback hands the captured ids off to commitRating() so the IPC + cache
	// patch share their code path with the player's click handler.
	const ratingDialogHost = document.getElementById('rating-dialog-host');
	if (ratingDialogHost) {
		ratingDialog = mountRatingDialog(ratingDialogHost, {
			onSubmit: (value) => {
				const ids = ratingDialogTargetIds;
				ratingDialogTargetIds = [];
				if (ids.length > 0) void commitRating(ids, value);
			},
			onCancel: () => { ratingDialogTargetIds = []; },
		});
	}

	// NamePromptDialog — generic single-input "name this" modal. One instance
	// serves every caller via open(opts); the pinned-search "Create Playlist…"
	// flow is the first user.
	const namePromptHost = document.getElementById('name-prompt-host');
	if (namePromptHost) namePromptDialog = mountNamePromptDialog(namePromptHost);

	// DeleteTracksDialog — the per-source library Delete confirmation
	// (Shift+Delete / "Delete from library…").
	const deleteTracksHost = document.getElementById('delete-tracks-host');
	if (deleteTracksHost) deleteTracksDialog = mountDeleteTracksDialog(deleteTracksHost);

	// ConfirmDialog — generic Curator yes/no modal (first user: plain Delete's
	// Remove-from-playlist confirmation).
	const confirmDialogHost = document.getElementById('confirm-dialog-host');
	if (confirmDialogHost) confirmDialog = mountConfirmDialog(confirmDialogHost);

	// WavConvertDialog — live status of a Convert to WAV run (fed by
	// wireWavConvertEvents).
	const wavConvertHost = document.getElementById('wav-convert-host');
	if (wavConvertHost) {
		wavConvertDialog = mountWavConvertDialog(wavConvertHost, {
			onStop: (runId) => {
				void window.api['wav:cancel'](runId).catch((err) => log.for('wav').error('cancel failed', err));
			},
			onOpenPlaylist: (playlistId) => { void openConvertedPlaylist(playlistId); },
			// The Sync to Rekordbox modal carries the rest: rb-running gate,
			// the "creates N tracks + this playlist" notice, scope flags.
			onImportToRekordbox: async (playlistId) => {
				await refreshAll();
				const name = library.getPlaylist(playlistId)?.name ?? 'Converted playlist';
				void openSyncToRekordboxModal({ kind: 'playlist', ids: [playlistId], displayName: name });
			},
		});
	}

	// Backup progress + restore dialogs (Settings → Backup). The restore
	// dialog hands a request to the danger confirm, which starts the run;
	// progress events then drive the progress dialog (wireBackupEvents).
	const backupProgressHost = document.getElementById('backup-progress-host');
	if (backupProgressHost) {
		backupProgressDialog = mountBackupProgressDialog(backupProgressHost, {
			onStop: (runId) => { void backupApi.cancel(runId).catch((err) => log.for('backup').error('cancel failed', err)); },
			onRelaunch: () => { void backupApi.relaunch(); },
		});
	}
	const backupRestoreHost = document.getElementById('backup-restore-host');
	if (backupRestoreHost) {
		backupRestoreDialog = mountBackupRestoreDialog(backupRestoreHost, {
			onSubmit: async (req, preview) => {
				if (!confirmDialog) return;
				const relaunch = req.sets.some((s) => s === 'core' || s === 'peaks' || s === 'embeddings' || s === 'covers');
				const rb = req.sets.some((s) => s === 'rekordboxDb' || s === 'rekordboxAnalysis');
				const parts: string[] = [];
				if (relaunch) parts.push('Library data is replaced at the next launch (the current files are kept in a pre-restore folder).');
				if (rb) parts.push('Rekordbox files are overwritten now; a copy of its current database is taken first.');
				if (req.sets.includes('tracks')) parts.push(req.tracks?.mode === 'root' ? `Audio files are written under ${req.tracks.root} and the library paths updated.` : 'Audio files are written back to their original locations (identical files are skipped).');
				const ok = await new Promise<boolean>((resolve) => confirmDialog!.open({
					title: 'Restore from this snapshot?',
					message: parts.join(' '),
					note: `Snapshot from ${new Date(preview.createdAt).toLocaleString()}${preview.hostname ? ` on ${preview.hostname}` : ''}.`,
					confirmLabel: 'Restore',
					danger: true,
					onConfirm: () => resolve(true),
					onCancel: () => resolve(false),
				}));
				if (!ok) return;
				backupProgressDialog?.begin('restore');
				try {
					await backupApi.restore(req);
				} catch (err) {
					backupProgressDialog?.handleEvent({ kind: 'failed', runId: '', op: 'restore', message: err instanceof Error ? err.message : String(err) });
				}
			},
		});
	}
	initBackupSettingsFeature({
		confirm: (opts) => new Promise((resolve) => {
			if (!confirmDialog) { resolve(false); return; }
			confirmDialog.open({ ...opts, onConfirm: () => resolve(true), onCancel: () => resolve(false) });
		}),
		openRestore: (snapshot) => { backupRestoreDialog?.open(snapshot); },
		reopenProgress: () => backupProgressDialog?.reopen() ?? false,
	});

	// MergeTracksDialog — the Edit Track save flow's "already linked" offer.
	const mergeTracksHost = document.getElementById('merge-tracks-host');
	if (mergeTracksHost) mergeTracksDialog = mountMergeTracksDialog(mergeTracksHost);
	const artistMergeHost = document.getElementById('artist-merge-host');
	if (artistMergeHost) {
		artistMergeReview = mountArtistMergeReviewDialog(artistMergeHost, {
			load: () => window.api['artists:merge-suggestions'](artistScopeForTab(shell.activeSource())),
			scopeLabel: () => TAB_LABEL[shell.activeSource()],
			merge: async (keepId, dropId) => {
				const res = await window.api['artists:merge'](keepId, dropId);
				showToast(`Merged into ${res.artist.name}`, { sub: `${res.tracksRewritten} track${res.tracksRewritten === 1 ? '' : 's'} rewritten`, kind: 'success' });
				await afterArtistMutation();
			},
			dismiss: (aId, bId) => window.api['artists:dismiss-merge'](aId, bId),
		});
	}

	// MCP confirm modal — approval gate for Claude-initiated writes over the
	// MCP bridge. Main denies on timeout; the modal only ever answers early.
	// Non-gated MCP writes surface as toasts so Claude never mutates silently.
	const mcpConfirmHost = document.getElementById('mcp-confirm-host');
	if (mcpConfirmHost) {
		const mcpConfirmModal = mountMcpConfirmModal(mcpConfirmHost, {
			respond: (requestId, approved, alwaysAllow) => { void window.api['mcp:confirm-response'](requestId, approved, alwaysAllow); },
		});
		window.api.onMcpConfirm((evt) => mcpConfirmModal.push(evt));
		window.api.onMcpNotify(({ message }) => showToast(message, { kind: 'success' }));
	}

	// Organize modal — the unified tag + playlist picker. The dialog owns its
	// own view state; main.ts threads the tagsStore lookups, the playlist
	// membership snapshot, the recommend IPC, the create flows, and the apply
	// path through props. onApply routes by item kind to the same
	// commitTagChanges / commitPlaylistChanges the rest of the app uses, so the
	// tag/playlist write path stays single-source-of-truth.
	const organizeHost = document.getElementById('organize-host');
	if (organizeHost) {
		organizeDialog = mountOrganizeDialog(organizeHost, {
			getItems: () => buildOrganizeItems(),
			// resolveOrganizeId aliases the deferred feed-promotion's provisional
			// id to the real curator id once its first write has promoted — before
			// that it's a no-op, so a normal owned-track open is unaffected.
			getTagsForTrack: (id) => tagsStore.getTagsForTrack(resolveOrganizeId(id)),
			getPlaylistsForTrack: (id) => playlistMembership.get(resolveOrganizeId(id)),
			// Single-track header: reactive row lookup (tracksData.get reads the
			// tick, so the rating stars repaint after commitRating's upsert). A
			// not-yet-promoted provisional id resolves to itself and misses the
			// cache — the dialog falls back to the plain count header. Off-page
			// rows (Discover, now-playing) are filled by ensureTrackCached on open.
			getTrack: (id) => tracksData.get(resolveOrganizeId(id)),
			onSetRating: (trackId, rating) => { void commitRating([trackId], rating); },
			membershipReady: organizeMembershipReady,
			rev: () => tagsRev() + playlistPickerRev(),
			fetchRecommended: async (trackIds) => {
				// A not-yet-promoted provisional id has no history to score — the
				// alias resolves to itself and the backend returns nothing until the
				// first write creates the row.
				const ids = trackIds.map(resolveOrganizeId);
				try {
					const rows = await window.api['organize:recommend'](ids);
					// The modal resolves ids → items (which carry kind); it only
					// needs the id + the "why" reason for the tooltip.
					return rows.map((r) => ({ id: r.id, reason: r.reason }));
				} catch (err) {
					log.for('organize').warn('recommend IPC failed', undefined, err);
					return [];
				}
			},
			onApply: async (item, addIds, removeIds) => {
				// Deferred feed track: the first apply promotes it (pin:false) and
				// swaps the provisional id for the real curator id. Resolve add then
				// remove sequentially so a concurrent pair can't double-promote (a
				// three-state cycle only ever fills one of the two lists anyway).
				try {
					const add = await resolveOrganizeWriteIds(addIds);
					const remove = await resolveOrganizeWriteIds(removeIds);
					if (item.kind === 'tag') await commitTagChanges(item.id, add, remove);
					else await commitPlaylistChanges(item.id, add, remove);
				} catch (err) {
					showToast('Could not add to library', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
				}
			},
			onCreateTag: async (name, trackIds) => {
				try { await createTagAndApply(name, await resolveOrganizeWriteIds(trackIds)); }
				catch (err) { showToast('Could not add to library', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 }); }
			},
			onCreatePlaylist: async (name, trackIds) => {
				try { await createLocalPlaylistAndRefresh(name, await resolveOrganizeWriteIds(trackIds)); }
				catch (err) { showToast('Could not add to library', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 }); }
			},
			onCreateStreamingPlaylist: async (name, trackIds) => {
				try { await createSpotifyPlaylistAndRefresh(name, await resolveOrganizeWriteIds(trackIds)); }
				catch (err) { showToast('Could not add to library', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 }); }
			},
			canCreateStreaming: () => !!library.auth()?.spotify.id,
			claimWindowFocus: () => window.api['window:focus'](),
			onClose: () => {
				// End any deferred feed-promotion session. If it promoted a row but
				// the user left it with zero tags AND zero playlists, roll it back so
				// a cancelled Organize leaves nothing behind. A row with any
				// association stays (it's genuinely organized now).
				const promo = feedPromo;
				feedPromo = null;
				playlistMembership.delete(FEED_PROMO_ID);
				if (promo?.realId) {
					const id = promo.realId;
					const bare = tagsStore.getTagsForTrack(id).length === 0 && (playlistMembership.get(id)?.size ?? 0) === 0;
					if (bare) void promo.rollback(id);
				}
			},
		});
	}

	// AnalyzeModal — user-driven "compute advanced features on these tracks"
	// dialog. The scanner runs the basic pipeline (bpm/key/beatgrid/peaks)
	// automatically; the MusicExtractor-derived scalars (brightness, power,
	// loudness range, punch, dissonance, density) only run via this modal
	// because MusicExtractor adds ~5-15 s per track that we don't want to pay
	// on every scanner-driven enqueue.
	const analyzeModalHost = document.getElementById('analyze-modal-host');
	if (analyzeModalHost) {
		analyzeModal = mountAnalyzeModal(analyzeModalHost, {
			onSubmit: (trackIds, flags) => {
				if (trackIds.length === 0) return;
				// Priority 100 = user-initiated, jumps the scanner backlog.
				// `force: true` re-runs even on tracks already 'done' — the
				// user is deliberately re-analyzing (e.g. adding advanced
				// features, or rebuilding with Overwrite on). Core converts the
				// unified `flags` into the sidecar wire shape; with Overwrite
				// off, existing values are preserved so a re-analyze never
				// clobbers a Rekordbox-sourced grid or cues the user has built.
				// Reset the chip's completed/total counter if this starts a fresh
				// batch (no-op when adding to a run already in flight). Must run
				// before the enqueue so it reads the pre-batch idle state.
				analysisStatus.beginBatch();
				// Reconcile the chip store once the rows land so the
				// completed/total denominator picks up this freshly-queued batch
				// (the per-track `enqueued` events are filtered from the
				// broadcast, so the chip can't learn the new total any other way).
				// The queued-toast waits for the enqueue to land: with the
				// analyzer sidecar disabled the call rejects, and an immediate
				// success toast would lie about work that will never run.
				void window.api['analysis:enqueue'](trackIds, {
					priority: 100,
					force: true,
					analyzeFlags: flags,
				}).then(() => {
					reseedAnalysisStatus();
					const n = trackIds.length;
					const basicCount = [flags.beatgrid, flags.key, flags.segments, flags.peaks].filter(Boolean).length;
					const parts: string[] = [];
					if (basicCount > 0) parts.push(`${basicCount} basic stage${basicCount === 1 ? '' : 's'}`);
					if (flags.advanced) parts.push('advanced features');
					showToast(
						`Analyzing ${n} track${n === 1 ? '' : 's'}`,
						{ sub: `${parts.join(' + ')} queued`, kind: 'info', durationMs: 3500 },
					);
				}).catch((err) => {
					// Strip Electron's "Error invoking remote method '…':" wrapper
					// so the toast shows the human message thrown by core.
					const raw = err instanceof Error ? err.message : String(err);
					const msg = raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
					showToast('Analysis unavailable', { sub: msg, kind: 'error', durationMs: 6000 });
				});
			},
			onClose: () => { /* state cleanup handled inside the modal */ },
		});
	}
	// Sync-to-Rekordbox modal — opened from track/playlist context menus.
	// The component owns its own state machine (idle → in-flight →
	// completed/verify-failed); the host wires onSubmit to the IPC flow
	// and onRestore to the restore-backup RPC.
	const syncToRekordboxModalHost = document.getElementById('sync-to-rekordbox-modal-host');
	if (syncToRekordboxModalHost) {
		syncToRekordboxModal = mountSyncToRekordboxModal(syncToRekordboxModalHost, {
			onSubmit: (target, flags, removeMissingFileIds) => { void submitSyncToRekordbox(target, flags, removeMissingFileIds); },
			onResolve: (target, flags, resolutions) => { startSyncToRekordbox(target, flags, resolutions); },
			// Fresh push (no resolutions — conflicts already settled on the
			// first run); only the listed mass-removal playlists are waived.
			onPushAnyway: (target, flags, rbPlaylistIds) => { startSyncToRekordbox(target, flags, undefined, rbPlaylistIds); },
			onClose: () => {
				// User cancelled before submitting (idle-state Cancel). Tear
				// down the export subscription if anything was hanging.
				syncToRekordboxExportUnsub?.();
				syncToRekordboxExportUnsub = null;
			},
			onRestore: (backupPath) => restoreRekordboxBackup(backupPath),
			loadFlags: () => loadSyncToRekordboxFlags(),
			saveFlags: (flags) => saveSyncToRekordboxFlags(flags),
		});
	}
	// Sync-FROM-Rekordbox modal (pull direction). No verify/restore surface.
	const syncFromRekordboxModalHost = document.getElementById('sync-from-rekordbox-modal-host');
	if (syncFromRekordboxModalHost) {
		syncFromRekordboxModal = mountSyncFromRekordboxModal(syncFromRekordboxModalHost, {
			onSubmit: (target, flags) => { startSyncFromRekordbox(target, flags); },
			onResolve: (target, flags, resolutions) => { startSyncFromRekordbox(target, flags, resolutions); },
			onClose: () => {
				syncFromRekordboxImportUnsub?.();
				syncFromRekordboxImportUnsub = null;
			},
			loadFlags: () => loadSyncFromRekordboxFlags(),
			saveFlags: (flags) => saveSyncFromRekordboxFlags(flags),
		});
	}
	// wireNav / wireWindowControls / wireSettingsButton / wireSoundcloudNoOp /
	// wireLocalTabContextMenu / wirePlayerModeToggle's button binding all
	// moved into the TopFrame layout — see mountTopFrame() below.
	// Track edit modal mounted alongside other modals further down in
	// boot() — backdrop/ESC/Enter-traversal owned by the component.
	wireSyncProgressEvents();
	wireDownloadProgressEvents();
	// Data-layer event ingestion (downloads today; domains migrate in as
	// F2 progresses). Chip painter reacts to the store via the effect below.
	wireDataEvents();
	createRoot(() => { createEffect(() => { renderDownloadsChip(); }); });
	// Source-tab sync tooltip recomputes from the sync store (running /
	// retrying / rows / pointer) — replaces the manual call chain that ran
	// after every sync mutation.
	createRoot(() => { createEffect(() => { refreshSourceSyncTooltipSignal(); }); });
	wireLibraryScanEvents();
	wireAnalysisEvents();
	wireCloudSyncEvents();
	// Drive the analysis-source resolution from the player setting. Runs at
	// boot (applies the persisted choice) and on every toggle — the store
	// re-resolves cached tracks from their stored rb/curator slots and repaints
	// the current one, no re-fetch.
	createRoot(() => { createEffect(() => { analysisStore.setAnalysisSource(uiSettingsSignal().analysisSource); }); });
	// Key-notation toggle (Camelot ↔ musical). The Solid render sites
	// (player, small player, discover) re-render off uiSettingsSignal for
	// free; the vanilla innerHTML tracklist has to be repainted explicitly.
	// `defer` skips the boot run (renderTracks already runs from boot) and
	// scopes the dependency to keyDisplayFormat alone. renderTracks self-gates
	// when the tracks layout is inactive, so no guard needed here.
	// Same for the artist-line format (separator / remix style).
	createRoot(() => { createEffect(on(() => { const u = uiSettingsSignal(); return `${u.keyDisplayFormat}|${u.artistSeparator}|${u.remixStyle}`; }, () => { void renderTracks(); }, { defer: true })); });
	// Artists folder counts follow the active tab — refetch when it changes
	// (only while the folder is open; a closed folder loads on expand).
	createRoot(() => { createEffect(on(() => shell.activeSource(), () => { if (artistsExpanded()) void loadArtists(); }, { defer: true })); });
	// Similarity highlight — push the player's loaded-track snapshot into the
	// feature module (it can't import player.ts itself; see similarity.ts) and
	// repaint the visible window when the highlight inputs actually change.
	// The memo string gates the repaint so an off feature (or an unrelated
	// currentTrack patch, e.g. a rating edit) doesn't rebuild rows for nothing.
	// Rows / Group chips write uiSettings; a different row mode or grouping
	// is table structure (colgroup, header, row heights) → remount, landing
	// on the track that was at the top. The memo dedupes so unrelated UI
	// settings don't remount.
	createRoot(() => {
		const layoutKey = createMemo(() => { const s = uiSettingsSignal(); return `${s.trackRowLines}|${s.trackGroupBy}`; });
		createEffect(on(layoutKey, () => { rebuildMainTrackList(); updateReorderableState(); }, { defer: true }));
		// Album details landed → repaint the album group headers in view.
		createEffect(on(albums.rev, () => mainTrackList?.refreshGroupHeaders(), { defer: true }));
	});
	let lastSimPaintKey = '';
	createRoot(() => { createEffect(() => {
		const ref = player.currentTrack();
		const s = similaritySettingsSignal();
		setSimilarityRefTrack(ref);
		const key = s.enabled && ref
			? `${ref.id}|${ref.bpm}|${ref.keyCamelot}|${ref.label}|${ref.brightness}|${ref.power}|${JSON.stringify(s)}`
			: 'off';
		if (key === lastSimPaintKey) return;
		lastSimPaintKey = key;
		mainTrackList?.repaintVisibleRows();
	}); });
	// (Library folders modal merged into Settings → wireSettingsModal owns it now.)
	wireDownloadsChip();
	wirePlayer();
	// (Player dock + mode for the restored tab are applied by the region
	// effect mounted above — runs before TopFrame mounts, same as before.)
	// Sync Now button moved into SyncView component (onSyncNow callback).
	wireEnrichStopButton();
	wireWavConvertEvents();
	wireBackupEvents();
	wirePinButton();
	wireSidebarToggleButton();
	wireTracklistFilter();
	wireZoom();
	wireOmnibar();
	// Refresh the Rekordbox tree whenever an import completes — keeps the
	// sidebar in sync without depending on the settings panel being open.
	// The settings panel has its own subscription for the progress strip.
	// All events are logged so the user can see import progress in DevTools.
	window.api.onRekordboxEvent((evt) => {
		rbLog.debug('event', { evt });
		if (evt.kind === 'completed') {
			rbLog.info('totals', { totals: evt.totals });
			// refreshRekordboxTree writes library.setRekordboxTree, whose tick
			// repaints the sidebar reactively on both tabs that host the rb
			// tree (Local — appended below library folders — and Rekordbox).
			// Only refetch if the tree is already in memory; if it was never
			// loaded (Spotify/Tidal session), the lazy ensureRekordboxTree picks
			// up the fresh import when the user navigates to a tab that shows it.
			if (rekordboxTreeLoaded) {
				refreshRekordboxTree()
					.catch((err) => rbLog.error('tree refresh failed', err));
			}
			// Also refresh playlists:list — rekordbox playlists land in the
			// same `playlist` table and the renderer's `state.playlistsById`
			// drives the rb-playlist source check in renderTracks(). Re-render
			// the tracks view after the playlist cache is repopulated so a
			// user viewing a rb playlist sees the new track-playlist membership
			// without having to click away and back.
			window.api['playlists:list']().then(async (playlists) => {
				library.setPlaylists(playlists);
				await renderTracks();
			}).catch((err) => rbLog.error('playlists refresh failed', err));
		}
		if (evt.kind === 'failed') {
			rbLog.error('import failed', undefined, { errorKind: evt.errorKind, message: evt.message });
		}
	});
	// Sidebar width restore before the resize handle wires up.
	applyPersistedSidebarWidth();
	wireSidebarResize();
	// Synchronous localStorage read — the region effect (mounted above) fires
	// reactively, so a collapsed sidebar is honored on the first paint.
	shell.hydrate({ sidebarCollapsed: getSidebarCollapsed() });
	// Mount TopFrame — the entire top nav bar (logo, source tabs, state
	// tabs, volume control, analyzer chip, player-mode toggle, omnibar
	// trigger, settings, avatar, window controls). The VolumeControl
	// component is rendered as a JSX child inside TopFrame, so no
	// separate mountVolumeControl call is needed.
	// Agent dock — app-level (third .app grid column + right-edge handle),
	// so the agent is reachable with current-view context from every tab.
	mountAgentDock();
	const topFrameHost = document.getElementById('topframe-host');
	if (topFrameHost) {
		topFrame = mountTopFrame(topFrameHost, {
			activeTabId: shell.activeTabId,
			currentSource: player.currentSource,
			tagCounts: tagCountsSignal,
			// Names are resolved on the backend (analysis:status + the started
			// event), so they're correct even for tracks not in the loaded page
			// (boot backfill). The snapshot maps straight onto the chip props.
			analyzerStatus: () => {
				const s = analysisStatus.snapshot();
				return {
					runningCount: s.runningCount,
					runningTracks: s.runningTracks,
					queuedCount: s.queuedCount,
					completedSession: s.completedSession,
					lastError: s.lastError,
				};
			},
			playerMode: currentPlayerMode,
			visibleSourceTabs: visibleSourceTabsMemo,
			visibleStateTabs:  visibleStateTabsMemo,
			zoomLevel: zoomLevelSignal,
			sourceSyncTooltip: sourceSyncTooltipSignal,
			userInitials: 'GB',
			onSourceClick: (src) => {
				// A tab switch: the tab's own history resumes where it was left;
				// a tab with no history yet opens on its persisted scope.
				void switchToTab(src, () => ({ kind: 'tracks', source: src, scope: sourceTabScope(src) }));
			},
			onSourceContextMenu: (evt, src) => {
				// Each source tab gets its own relevant menu (TopFrame already
				// preventDefault'd + gated on the `contextual` flag).
				if (src === 'spotify') showSpotifyTabMenu(evt);
				else if (src === 'tidal') showTidalTabMenu(evt);
				else if (src === 'rekordbox') showRekordboxTabMenu(evt);
			},
			onSoundcloudClick: () => {
				showToast('Soundcloud — coming soon', { kind: 'info', durationMs: 2000 });
			},
			onViewClick: (view) => {
				// A tab switch (see switchToTab); first visits seed the tab.
				void switchToTab(view, () =>
					view === 'discover' ? discoverLocation()
						: view === 'downloads' ? { kind: 'downloads' }
							: { kind: 'tag', view });
			},
			onOmnibarOpen: () => openOmnibarLazy(),
			onSettingsOpen: () => openSettingsModal(),
			onPlayerModeToggle: () => { togglePlayerModeRequest(); },
			onMinimize: () => { void window.api['window:minimize'](); },
			onToggleMaximize: () => { void window.api['window:toggle-maximize'](); },
			onClose: () => { void window.api['window:close'](); },
		});
	}
	// When the User Interface settings hide the currently-active source or
	// state tab (either via a manual toggle or because a 'when-has' tab's
	// count crossed back to zero), bump to the leftmost remaining visible
	// tab so the strip never shows an orphan-active state. The memos read
	// uiSettingsSignal + tagCountsSignal; this effect tracks both via the
	// visibility sets themselves.
	createRoot(() => {
		createEffect(() => {
			visibleSourceTabsMemo();
			visibleStateTabsMemo();
			applyActiveTabFallback();
		});
	});
	// Mount the PlayerFooter — one Solid root with every player-surface
	// component composed inside (NowPlayingCard, MainWaveformView,
	// MiniWaveMapView, TransportView, CueGridView, plus the loop
	// placeholder). Replaces five separate mountX() calls + their
	// host-id lookups + a fanned-out set of per-component handle vars.
	const playerFooterHost = document.getElementById('player-footer-host');
	if (playerFooterHost) {
		// Restore the persisted zoom index from localStorage. The .v2 key
		// stores the post-prepend index directly; the legacy key stored
		// indices against the old [4,8,16,32] table — shift by +2 to keep
		// the same bar count after the prepend, then rewrite under .v2.
		let initialZoomIdx = BIG_ZOOM_DEFAULT_IDX;
		try {
			const v2 = localStorage.getItem('curator.bigZoomIdx.v2');
			if (v2 != null) {
				const idx = Number.parseInt(v2, 10);
				if (Number.isFinite(idx) && idx >= 0 && idx < BIG_ZOOM_BAR_LEVELS.length) initialZoomIdx = idx;
			} else {
				const legacy = localStorage.getItem('curator.bigZoomIdx');
				if (legacy != null) {
					const idx = Number.parseInt(legacy, 10) + 2;
					if (Number.isFinite(idx) && idx >= 0 && idx < BIG_ZOOM_BAR_LEVELS.length) initialZoomIdx = idx;
					localStorage.removeItem('curator.bigZoomIdx');
				}
			}
		} catch { /* private mode */ }
		// Live copy — onZoomChange keeps it current so MainWaveformView
		// remounts (mode toggles) restore the latest zoom, not boot's.
		let liveZoomIdx = initialZoomIdx;
		// Persisted waveform skin — one shared value across big + mini.
		// Default = rekordbox: the research-backed faithful look
		// (overlap-from-floor + gamma 0.45 + per-track normalize).
		// Legacy keys (curator.bigSkin/miniSkin from the brief split-keys
		// iteration) are honoured on read and then cleaned up.
		const validSkinIds = new Set<SkinId>(SKINS.map((s) => s.id));
		const isValidSkin = (s: string | null | undefined): s is SkinId =>
			s != null && validSkinIds.has(s as SkinId);
		try {
			const stored = localStorage.getItem('curator.skin');
			if (isValidSkin(stored)) {
				setCurrentWaveformSkinSignal(stored);
			} else {
				const legacyBig = localStorage.getItem('curator.bigSkin');
				const legacyMini = localStorage.getItem('curator.miniSkin');
				const legacy = isValidSkin(legacyBig) ? legacyBig
					: isValidSkin(legacyMini) ? legacyMini
					: null;
				if (legacy) {
					setCurrentWaveformSkinSignal(legacy);
					localStorage.setItem('curator.skin', legacy);
				}
				localStorage.removeItem('curator.bigSkin');
				localStorage.removeItem('curator.miniSkin');
			}
		} catch { /* private mode */ }
		// Instantiate the DeckController BEFORE mounting the footer so the
		// footer's callbacks can dispatch into deck methods. The deck's
		// snapTo closes over playerFooter (assigned just after) — that
		// late-binding is fine because snapTo is only called from inside
		// deck.triggerCue / jumpByBeats / loop-wrap, all of which fire on
		// user interaction (after mount) or playback ticks (after first
		// play).
		deck = createDeck({
			snapTo: (positionSec) => playerFooter?.snapTo(positionSec),
		});

		// Controller layer — push the FLX10 mapping to the sidecar at
		// boot and subscribe to controller_event Events. v1 routes all
		// controller actions through the renderer (vs sidecar-direct
		// dispatch) so DeckController's musical-time logic is reused
		// without a Rust port; see planning/tech/controllers-pioneer.md.
		wireControllers({
			getDeck: () => deck,
			togglePlayerMode: () => { togglePlayerModeRequest(); },
			stepTracklistSelection: (delta) => {
				// navigateTracks expects ±1. Quantize any controller
				// delta to a single step per event (rotary encoders
				// emit one tick per detent on the FLX10).
				navigateTracks(delta >= 0 ? 1 : -1);
			},
			playSelectedTrack: () => {
				// Mirrors the Enter-key handler below — first selected
				// row plays into the visible tracklist's queue.
				const selected = getSelectedTrackIds();
				if (selected.size === 0) return;
				const tracks = getMainTracks();
				const firstId = tracks.find((t) => selected.has(t.id))?.id;
				if (!firstId) return;
				const t = tracksData.get(firstId);
				if (!t) return;
				shell.notePlaybackOrigin();
				player.play(t, [...tracks]).catch((err) => {
					if (err instanceof player.TidalNotReadyError) {
						showToast('Tidal playback', { sub: 'Coming soon', kind: 'info' });
					} else {
						showToast('Playback failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
					}
				});
			},
			stepSidebarSelection: (delta) => {
				sidebar?.stepSelection(delta >= 0 ? 1 : -1);
			},
			enterSidebarSelection: () => {
				// Returns 'expanded' | 'collapsed' | 'activated' | 'noop'.
				// 'activated' = a playlist / folder was loaded → switch
				// focus back to tracklist (controllers.ts reads this).
				// Other returns keep cursor in the sidebar.
				return sidebar?.enterSelection() ?? 'noop';
			},
			clearSidebarCursor: () => sidebar?.clearCursor(),
			openOmnibar: () => openOmnibarLazy(),
		});

		// Live-refresh the Settings → Player panel when the connected
		// controller list changes — but only when that tab is the
		// active one (saves a paint when the modal is closed or another
		// tab is open). Reading getConnectedControllers() tracks the
		// signal; the effect re-runs on every change.
		createRoot(() => {
			createEffect(() => {
				const models = getConnectedControllers();
				if (settingsModal?.isOpen() && settingsModal.activeTab() === 'player') {
					void renderSettingsPlayer();
					// Avoid unused-var lint:
					void models;
				}
			});
		});
		playerFooter = mountPlayerFooter(playerFooterHost, {
			getTrack: (id) => tracksData.get(id),
			onFavoriteToggle: null, // wire in a later pass
			onSetRating: (trackId, rating) => { void commitRating([trackId], rating); },
			onArtistClick: (name) => { void showArtistInLibrary(name); },
			onAddTag: (trackId) => { void openOrganizeForTracks([trackId]); },
			onTagContextMenu: (evt, trackId, tagId) => {
				const tag = tagsStore.getTagById(tagId);
				const label = tag?.name ?? 'tag';
				openContextMenu(
					[
						{ kind: 'header', label },
						{
							kind: 'item',
							id: 'remove',
							label: 'Remove',
							iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 6l12 12M18 6 6 18"/></svg>',
						},
					],
					{ remove: () => { void commitTagChanges(tagId, [], [trackId]); } },
					{ at: evt },
				);
			},
			tracksCacheRev: () => tracksData.rev(),
			mode: currentPlayerMode,
			variant: shell.effectiveVariant,
			peaks: currentPeaksSignal,
			beats: currentBeats,
			downbeats: currentDownbeats,
			cues: currentCues,
			segments: currentSegments,
			duration: () => player.getState().duration,
			positionSec: () => player.getState().position,
			isPlaying: () => player.getState().playing,
			beatsAvailable,
			// Getter, not a value: the small↔big mode toggle remounts the
			// MainWaveformView (PlayerFooter's <Show> fork), and each remount
			// re-reads this prop — a snapshot from boot would lose any zoom
			// the user picked since.
			get initialZoomIdx() { return liveZoomIdx; },
			onZoomChange: (idx) => {
				liveZoomIdx = idx;
				try { localStorage.setItem('curator.bigZoomIdx.v2', String(idx)); } catch { /* */ }
			},
			skin: currentWaveformSkin,
			onSkinChange: setWaveformSkin,
			// Scrubber drags are NOT quantized — they bypass the deck and
			// go straight to player.seekBy. This matches Rekordbox / CDJs
			// where quantize only affects cue/loop/beat triggers.
			// markUiAction stamps the click moment so seekLocal can log
			// the click→audio budget. Remove once latency instrumentation
			// is no longer needed (see plan: glistening-gliding-honey.md).
			onSeek: (positionSec) => {
				player.markUiAction('waveform-click');
				const st = player.getState();
				player.seekBy(positionSec - st.position).catch(() => {});
			},
			// Vinyl-scrub: per-source dispatch lives in player.ts.
			// scrubStart pauses (local: sidecar scrub_begin; spotify: pause).
			// scrubMove rate-controls audio (local) or no-ops (streaming).
			// scrubEnd commits final position and optionally resumes play.
			onScrubStart: (targetSec) => {
				player.markUiAction('waveform-drag');
				player.scrubStart(targetSec);
			},
			onScrubMove: (positionSec) => {
				player.scrubMove(positionSec);
			},
			onScrubEnd: (positionSec, resumePlaying) => {
				player.scrubEnd(positionSec, resumePlaying).catch(() => {});
			},
			onCueJump: (positionSec, lengthSec, cueId) => {
				player.markUiAction('cue');
				deck?.triggerCue({ positionSec, lengthSec, cueId });
			},
			onCreateCue: (slot) => { void createCueAtCurrent(slot); },
			onCueContextMenu: (evt, cue) => { openCueContextMenu(evt, cue); },
			// delta is a signed magnitude (±4/±16/±32) — beats when analyzed,
			// else seconds. The buttons are enabled whenever a track is loaded
			// (Spotify too), so this must handle the gridless case.
			onBeatJump: (delta) => performJump(delta),
			activeLoop: deck.activeLoop,
			pendingTrigger: deck.pendingTrigger,
			loopArmed: deck.loopArmed,
			onLoopIn: () => { player.markUiAction('loop-in'); deck?.loopIn(); },
			onLoopOut: () => { player.markUiAction('loop-out'); deck?.loopOut(); },
			onLoopNBeats: (n) => { player.markUiAction('loop-n'); deck?.loopNBeats(n); },
			onHalveLoop: () => { player.markUiAction('loop-half'); deck?.halveLoop(); },
			onDoubleLoop: () => { player.markUiAction('loop-double'); deck?.doubleLoop(); },
		});
	}
	// Floating now-playing chip — wayfinding back to the tab playback was
	// started from when it has the OTHER context class (shell.chipVisible).
	// Mounted once; visibility is memo-driven so it animates in/out without
	// remounting.
	const chipHost = document.getElementById('np-chip-host');
	if (chipHost) {
		mountNowPlayingChip(chipHost, { visible: shell.chipVisible, onJump: jumpToPlayingTrackTab });
	}
	// Mount the Sidebar — owns the section header and both render branches
	// (Spotify/Tidal playlists; the Rekordbox tree + Curator playlists).
	const sidebarHost = document.getElementById('sidebar-host');
	if (sidebarHost) {
		sidebar = mountSidebar(sidebarHost, {
			getSnapshot: getSidebarSnapshot,
			// Every row is a history navigation under the active source tab
			// (the Rekordbox tab hosts Curator-local playlists AND the rekordbox
			// tree, so the tab, not the row kind, decides the source).
			onPlaylistActivate: async (id, isLazySync) => {
				await navigate({ kind: 'tracks', source: shell.activeSource(), scope: { type: 'playlist', id } });
				if (isLazySync) {
					// Route by owning source — the sidebar hosts Spotify AND
					// Tidal playlist rows, and each lazy-syncs via its own engine.
					const src = library.getPlaylist(id)?.source;
					const run = src === 'tidal'
						? window.api['sync:tidal:playlist'](id)
						: window.api['sync:spotify:playlist'](id);
					run
						.then(() => renderTracks())
						.catch((err) => syncLog.error('lazy sync failed', err));
				}
			},
			onRekordboxFolderActivate: (fid) => {
				void navigate({ kind: 'tracks', source: shell.activeSource(), scope: { type: 'folder', id: fid } });
			},
			onRekordboxFolderCaretToggle: (fid) => {
				// Reassign a NEW Set so the rekordboxExpanded signal fires and
				// the sidebar repaints reactively.
				const next = new Set(rekordboxExpanded());
				if (next.has(fid)) next.delete(fid);
				else next.add(fid);
				setRekordboxExpanded(next);
				saveRekordboxExpanded(next);
			},
			onRekordboxFolderContextMenu: (evt, fid) => {
				showRekordboxFolderContextMenu(evt, fid);
			},
			onRekordboxAllTracksActivate: () => {
				// The source root — renderTracks falls back to every track where
				// source = rekordbox.
				void navigate({ kind: 'tracks', source: shell.activeSource(), scope: { type: 'all' } });
			},
			onRekordboxPlaylistActivate: (id) => {
				// Same flow as a regular playlist activation; lazy-sync doesn't
				// apply to Rekordbox playlists (no remote sync concept).
				void navigate({ kind: 'tracks', source: shell.activeSource(), scope: { type: 'playlist', id } });
			},
			onSmartPlaylistActivate: (id) => {
				// Smart playlists take the watermark path inside the applier.
				void navigate({ kind: 'tracks', source: shell.activeSource(), scope: { type: 'playlist', id } });
			},
			onPlaylistContextMenu: (evt, id) => {
				showPlaylistContextMenu(evt, id);
			},
			onPinnedActivate: async (id) => {
				const p = pinnedSearches().find((x) => x.id === id);
				if (!p) return;
				// Restore the sort captured at pin time before the JIT loads so
				// the re-run reflects the ordering the user saved (null → keep
				// whatever sort is active).
				if (p.sortColumn) {
					state.sortColumn = p.sortColumn as SortColumn;
					state.sortDir = (p.sortDir ?? 'asc') as SortDir;
				}
				await enterJitScope({ name: p.name, query: p.query, pinnedId: p.id });
				updatePinButton();
			},
			onPinnedCaretToggle: () => {
				const next = !pinnedExpanded();
				setPinnedExpanded(next);
				savePinnedExpanded(next);
			},
			onPinnedContextMenu: (evt, id) => {
				showPinnedSearchContextMenu(evt, id);
			},
			onArtistActivate: (id, name) => {
				void enterJitScope({ name: `Artist: ${name}`, query: buildExactAttr('artistid', id) });
			},
			onArtistsCaretToggle: () => {
				const next = !artistsExpanded();
				setArtistsExpanded(next);
				saveArtistsExpanded(next);
				if (next) void loadArtists();
			},
			onArtistsSearch: (q) => {
				setArtistsSearch(q);
				if (artistsSearchTimer) clearTimeout(artistsSearchTimer);
				artistsSearchTimer = setTimeout(() => { void loadArtists(); }, 150);
			},
			onArtistContextMenu: (evt, id) => {
				showArtistContextMenu(evt, id);
			},
			onArtistsFolderContextMenu: (evt) => {
				openContextMenu([
					{ kind: 'header', label: 'Artists' },
					{ kind: 'item', id: 'suggest', label: 'Suggested merges…' },
				], { suggest: () => artistMergeReview?.open() }, { at: evt });
			},
			onFavoriteCommit: (id, value) => {
				// Patch the cached row through the reactive library layer so the
				// re-sort kicks in immediately (the tick repaints the sidebar);
				// the patch replaces only this row's object, preserving every
				// other row's reference per the sidebar perf contract. Failure
				// path reverts the same way.
				library.patchPlaylist(id, { isFavorite: value });
				window.api['playlists:set-favorite'](id, value).catch((err) => {
					log.for('sidebar').error('set-favorite failed', err);
					showToast('Star failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
					library.patchPlaylist(id, { isFavorite: !value });
				});
			},
			onTracksDropped: (playlistId, trackIds) => {
				void handleTracksDroppedOnPlaylist(playlistId, trackIds);
			},
		});
	}
	// Mount the main tracks list NOW — before refreshAll calls renderTracks,
	// which will hand the list its first batch of rows via .update(). The
	// handle is needed in place so the sort/highlight/selection callbacks
	// fire cleanly on the very first paint.
	mountMainTrackList();
	// Artists folder — restore its expansion; refreshAll fetches the rows.
	setArtistsExpanded(loadArtistsExpanded());
	await refreshAll();
	performance.measure('boot:interactive', 'boot:start'); // first tracks paint done
	await refreshDownloads();
	// One-time backfill: stamp every existing Spotify playlist with
	// `Added ↓` so the user's library matches Spotify's "Recently added"
	// view they're used to. Runs once per install (gated by a localStorage
	// flag), only touches playlists with no manual sort entry yet. After
	// stamping, re-apply the sort to the currently-restored playlist so
	// the user sees the new default immediately without having to navigate
	// away and back.
	const bootPid = shell.currentPlaylistId();
	const backfillRanForCurrent = !isSpotifyBackfillDone() && bootPid != null
		&& library.getPlaylist(bootPid)?.source === 'spotify'
		&& !hasPlaylistSort(bootPid);
	backfillSpotifyPlaylistSorts();
	if (backfillRanForCurrent && bootPid) {
		applyStoredOrDefaultSort(bootPid);
		void renderTracks();
	}
	// Push the selection restored from localStorage (loadUiState ran before
	// the list mounted, so it parked in pendingSelection) into the freshly-
	// mounted handle. Sort indicator + arrow are already set via the initial
	// sort option passed to mountMainTrackList; the scroll-anchor restore
	// below runs after the first .update().
	if (pendingSelection) {
		const ps = pendingSelection;
		pendingSelection = null;
		setTrackSelection(ps.ids, ps.anchor);
	}
	// Restored from localStorage just above — currentPlaylistId may name a
	// playlist that's now populated. Jump to its saved anchor row if any.
	restoreCurrentAnchor();
	// The restored session is history entry #0 — Back has somewhere to land
	// only once the user navigates away from it.
	navHistory.reset(newEntry(currentLocation()));
}

// Mount the TrackListView into #tracks-view with all the callbacks the
// surrounding app needs: sort changes feed back into renderTracks; column
// resizes persist via ui-settings.ts; selection mirrors into the state
// globals for the keyboard handler + context menus; src-header right-click
// opens the existing context menu logic.
function mountMainTrackList(): void {
	const host = document.getElementById('tracks-view');
	if (!host) return;
	const ui = uiSettingsSignal();
	mountedLayout = `${ui.trackRowLines}|${ui.trackGroupBy}`;
	mainTrackList = mountTrackList(host, [], {
		showHeader: true,
		virtualize: true,
		columns: (mountedColumns = currentVisibleColumns()),
		rowLines: ui.trackRowLines,
		fields: currentVisibleFields(),
		groupBy: ui.trackGroupBy,
		collapsedGroups: collapsedGroupsFor(ui.trackGroupBy),
		// Album group headers read the release's own details (title, album
		// artists, date, label, type) from the albums store; the list asks
		// for the ids it shows and repaints its headers when they land.
		albumInfo: (id) => albums.get(id),
		onNeedAlbums: (ids) => albums.ensure(ids),
		sort: { column: state.sortColumn, dir: state.sortDir },
		resizableColumns: true,
		initialColumnWidths: getAllColumnWidths(),
		onColumnResize: (cls, w) => setColumnWidth(cls, w),
		// Header drag-reorder. The list hands back the order of its VISIBLE
		// columns; splice the hidden ones back into their old slots so
		// showing a column later doesn't jump it to the end. One-line rows
		// only — the two-line layout's paired columns have a fixed order.
		reorderableColumns: ui.trackRowLines === 1,
		onColumnReorder: (layoutOrder) => {
			const visibleOrder = layoutOrder as Column[];
			const full = getColumnOrder(ALL_COLUMNS);
			const visible = new Set(visibleOrder);
			const merged: Column[] = [];
			let vi = 0;
			for (const c of full) {
				if (visible.has(c)) merged.push(visibleOrder[vi++]!);
				else merged.push(c);
			}
			setColumnOrder(merged);
			rebuildMainTrackList();
		},
		// Tag chips for the 'tags' column. Resolver pulls names/colors from
		// the tag-id cache populated alongside each page of tracks (see
		// renderTracks → tagsStore.ensureTracksLoaded). When the cache hasn't
		// been hydrated yet, the resolver returns an empty list and the row
		// re-renders once the batch fetch resolves and bumps the cache.
		tagsForTrack: (trackId) => {
			const ids = tagsStore.getTagsForTrack(trackId);
			if (ids.length === 0) return [];
			const out: { id: string; name: string; color: string | null }[] = [];
			for (const id of ids) {
				const t = tagsStore.getTagById(id);
				if (t && t.kind === 'user') out.push({ id: t.id, name: t.name, color: t.color });
			}
			out.sort((a, b) => a.name.localeCompare(b.name));
			return out;
		},
		// Pinned / Basket are to-get lists of streaming finds — flag the ones
		// that already landed as a local file (downloaded since being pinned),
		// same chip Discover shows. Elsewhere it's noise (Local is all-local).
		inLibraryChip: () => shell.activeView() === 'interested' || shell.activeView() === 'basket',
		onSortChange: (next) => {
			state.sortColumn = next.column;
			state.sortDir = next.dir;
			mainTrackList?.setSort(next);
			updateReorderableState();
			// Persist the sort under the active playlist / folder so opening
			// it again later restores this view. No-op when nothing's open
			// (source-level view) — we don't try to remember per-source.
			const activeId = shell.currentPlaylistId() ?? shell.currentFolderId();
			if (activeId) setPlaylistSort(activeId, { column: next.column, dir: next.dir });
			persistUiState();
			void renderTracks();
		},
		onPlay: (t, all) => {
			shell.notePlaybackOrigin();
			player.play(t, all).catch((err) => {
				if (err instanceof player.TidalNotReadyError) {
					showToast('Tidal playback', { sub: 'Coming soon', kind: 'info' });
				} else {
					showToast('Playback failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
				}
			});
		},
		// Artist chip click → "Artist: X" JIT scope keyed by Curator artist
		// id (exact SQL pushdown; survives renames/merges via aliases).
		onArtistClick: (artistId, name) => {
			void enterJitScope({ name: `Artist: ${name}`, query: buildExactAttr('artistid', artistId) }, undefined, { drill: true });
		},
		// Label / genre / tag click → the same drill scopes the context menu's
		// "Navigate to" offers (exact attr match; a tag drills via its #name).
		onDrillClick: (kind, value) => {
			const query = kind === 'tag' ? `#"${value.replace(/"/g, '')}"` : buildExactAttr(kind, value);
			const title = kind === 'tag' ? 'Tag' : kind === 'label' ? 'Label' : 'Genre';
			void enterJitScope({ name: `${title}: ${value}`, query }, undefined, { drill: true });
		},
		onContextMenu: (evt, t, _all, selectedIds) => {
			// Unified, command-derived track menu. The selection resolves to full
			// Track objects (they carry `sources`, which every command predicate
			// reads); the view tells the curate commands whether to read as
			// "Mark as Interested" or "Unpin".
			const tracks = selectedIds.length > 1
				? selectedIds.map((id) => tracksData.get(id)).filter((x): x is Track => !!x)
				: [t];
			void showTrackMenu(evt, { tracks, view: shell.activeView(), source: shell.activeSource(), playlist: currentEditablePlaylist(), jit: shell.currentJit() });
		},
		onSrcHeaderContextMenu: (evt) => showSrcHeaderContextMenu(evt),
		onHeaderContextMenu: (evt, _col) => showColumnVisibilityMenu(evt),
		onReorder: (newOrder) => { void applyTrackReorder(newOrder); },
		onSelectionChange: () => {
			// The handle is the single source of truth (Phase 4) — nothing
			// to mirror. Persist on change so a refresh restores the same
			// rows (persistUiState reads the selection back off the handle
			// via captureSourceState).
			persistUiState();
		},
	});
}

// ─── Track-list Group chip ──────────────────────────────────────────────────
// The Group chip opens a small radio popup anchored under it; a second click
// closes it. Picks write uiSettings, whose layout effect (boot) remounts the
// list. (The Rows chip is a plain toggle — see mountMainPane.)
const [tracklistMenu, setTracklistMenu] = createSignal<'group' | null>(null);
const GROUP_MENU_LABELS: Record<GroupBy, string> = { none: 'None', artist: 'Artist', album: 'Album', label: 'Label' };

function openTracklistMenu(kind: 'group', anchor: HTMLElement): void {
	if (tracklistMenu() === kind) { dismissContextMenu(); return; }
	const ui = uiSettingsSignal();
	const items: ContextMenuItem[] = [];
	const handlers: Record<string, () => void> = {};
	items.push({ kind: 'header', label: 'Group' });
	for (const g of ['none', 'artist', 'album', 'label'] as const) {
		items.push({ kind: 'radio', id: `group-${g}`, label: GROUP_MENU_LABELS[g], checked: ui.trackGroupBy === g });
		handlers[`group-${g}`] = () => updateUiSettings((d) => { d.trackGroupBy = g; });
	}
	// Bulk collapse — Alt+click on any group header does the same toggle.
	items.push(
		{ kind: 'divider' },
		{ kind: 'item', id: 'collapse-all', label: 'Collapse all', disabled: ui.trackGroupBy === 'none' },
		{ kind: 'item', id: 'expand-all', label: 'Expand all', disabled: ui.trackGroupBy === 'none' },
	);
	handlers['collapse-all'] = () => mainTrackList?.collapseAll();
	handlers['expand-all'] = () => mainTrackList?.expandAll();
	setTracklistMenu(kind);
	openContextMenu(items, handlers, {
		anchor,
		align: 'end',
		variant: 'popup',
		onClose: () => { if (tracklistMenu() === kind) setTracklistMenu(null); },
	});
}

// Show/hide columns context menu — fired on right-click of any non-SRC
// header. Lists every column that's NOT structurally fixed (idx, art, src
// are kept always-visible since the table layout depends on them) with a
// checkmark indicating current state. Toggle persists via ui-settings and
// triggers a full remount so the colgroup/thead get re-built with the new
// set. Cheap — same data, same handle id, just a fresh DOM.
const COLUMN_LABELS: Record<Column, string> = {
	src: 'Source', idx: '#', match: 'Match', art: 'Cover', title: 'Title', artist: 'Artist',
	album: 'Album', rel: 'Released', label: 'Label', genre: 'Genre', bpm: 'BPM', key: 'Key',
	time: 'Time', rating: 'Rating', lra: 'Dyn Range', diss: 'Dissonance', dens: 'Density',
	bright: 'Brightness', power: 'Power', punch: 'Punch', tags: 'Tags',
	added: 'Added', act: 'Actions',
};
// Columns the user can't toggle — they're either structural (the row
// renderer expects them) or visually load-bearing (the table layout
// scaffolding leans on them). Easier to lock these in than to teach the
// component every conditional layout shape.
const COLUMN_LOCKED = new Set<Column>(['idx', 'art', 'title']);

function showColumnVisibilityMenu(evt: MouseEvent): void {
	const checkIcon = (cond: boolean) => `<span class="ctx-menu__check">${cond ? '✓' : ''}</span>`;
	// Match is scope-driven (similarity scopes only), never a user toggle.
	const toggleable = ALL_COLUMNS.filter((c) => !COLUMN_LOCKED.has(c) && c !== 'match');
	const items: ContextMenuItem[] = toggleable.map((c) => ({
		kind: 'item' as const,
		id: c,
		label: COLUMN_LABELS[c] ?? c,
		iconHtml: checkIcon(getColumnVisibility(c)),
	}));
	const handlers: Record<string, () => void> = {};
	for (const c of toggleable) {
		handlers[c] = () => {
			setColumnVisibility(c, !getColumnVisibility(c));
			rebuildMainTrackList();
		};
	}
	items.push({ kind: 'divider' }, { kind: 'item', id: 'reset-order', label: 'Reset column order' });
	handlers['reset-order'] = () => { resetColumnOrder(); rebuildMainTrackList(); };
	openContextMenu(items, handlers, { at: evt });
}

// Persist a drag-reorder back to the DB. Optimistic UI is intentionally
// skipped — local SQLite responds in single-digit ms, so the round-trip
// is invisible. On error we toast and re-render so the user can see the
// list snap back to the canonical order.
async function applyTrackReorder(newOrder: number[]): Promise<void> {
	const reorderTargetPid = shell.currentPlaylistId();
	if (!reorderTargetPid) return;
	try {
		await window.api['playlists:reorder'](reorderTargetPid, newOrder);
		await renderTracks();
	} catch (err) {
		log.for('reorder').error('failed', err);
		showToast('Reorder failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
		await renderTracks();
	}
}

// Wire the filterbox input. Input is debounced lightly so a fast typist
// doesn't trigger a re-filter on every keystroke; Enter applies
// immediately. Escape clears. Up/Down/Ctrl-A pass through to the global
// keyboard handler so the user can move into the list without leaving the
// input first.
function wireTracklistFilter(): void {
	const input = document.getElementById('tracklist-filter') as HTMLInputElement | null;
	const wrap = document.getElementById('tracklist-filter-wrap');
	if (!input) return;
	const fire = (): void => {
		mainFilterText = input.value;
		applyFilterToMainList();
		updateReorderableState();
	};
	input.addEventListener('input', () => {
		if (filterDebounceHandle) clearTimeout(filterDebounceHandle);
		filterDebounceHandle = setTimeout(fire, 80);
	});
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			if (input.value) {
				input.value = '';
				fire();
				e.preventDefault();
			} else {
				input.blur();
			}
		} else if (e.key === 'Enter') {
			if (filterDebounceHandle) { clearTimeout(filterDebounceHandle); filterDebounceHandle = null; }
			fire();
			// Hand focus to the list so Up/Down/Enter immediately drive
			// playback without the user having to click the table first.
			input.blur();
			mainTrackList?.focus();
		}
	});
	// `#tag` autocomplete popover — shared with the omnibar via
	// renderer/tagSuggest.ts. The popover anchors to .filter-bar__filter-wrap
	// (position: relative) so it sits flush below the input. Capture-phase
	// keydown in the factory preempts our Enter/Escape handlers above when
	// the popover is visible, so a tag pick doesn't bubble up to "blur +
	// focus list".
	if (wrap) {
		attachTagSuggest({
			inputEl: input,
			anchorEl: wrap,
			onCommit: () => {
				// Tag insertion happens via the popover, which doesn't fire
				// an `input` event. Run the filter immediately rather than
				// waiting for the next keystroke.
				if (filterDebounceHandle) { clearTimeout(filterDebounceHandle); filterDebounceHandle = null; }
				fire();
			},
		});
	}
}

// Programmatic filterbox write (history traversal restoring an entry's
// filter text) — same effect as typing it: value, mirror, re-filter.
function setTracklistFilterText(text: string): void {
	const input = document.getElementById('tracklist-filter') as HTMLInputElement | null;
	if (input) input.value = text;
	if (filterDebounceHandle) { clearTimeout(filterDebounceHandle); filterDebounceHandle = null; }
	mainFilterText = text;
	applyFilterToMainList();
	updateReorderableState();
}

// ─── Pinned-search button (filter-bar header) ────────────────────────────────
// The pin button only exists for JIT scopes — the named, re-runnable searches
// the omnibar / drill-into produce. It reflects whether the loaded JIT is
// already saved (filled = pinned), and toggles that state on click.
function updatePinButton(): void {
	const btn = document.getElementById('pin-search-btn') as HTMLButtonElement | null;
	if (!btn) return;
	const jit = shell.currentJit();
	if (!jit) {
		btn.hidden = true;
		btn.classList.remove('is-pinned');
		return;
	}
	btn.hidden = false;
	const pinned = jit.pinnedId != null;
	btn.classList.toggle('is-pinned', pinned);
	const label = pinned ? 'Unpin this search' : 'Pin this search';
	btn.title = label;
	btn.setAttribute('aria-label', label);
}

// Delete a pin. If it's the search currently loaded, drop the live JIT's
// pinnedId so the button flips back to outline — the search stays loaded,
// it's just no longer saved.
async function unpinSearch(id: string): Promise<void> {
	const jit = shell.currentJit();
	if (jit?.pinnedId === id) {
		shell.setJit({ name: jit.name, query: jit.query });
		updatePinButton();
	}
	try {
		await window.api['pinned:delete'](id);
	} catch (err) {
		pinnedLog.error('unpin failed', err);
		showToast('Unpin failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
	}
	await loadPinnedSearches();
}

// Pin button click — unpin if already saved, otherwise prompt for a name
// (defaulting to the search's, pre-selected) before saving the pin.
async function togglePinCurrentSearch(): Promise<void> {
	const jit = shell.currentJit();
	if (!jit) return;
	if (jit.pinnedId != null) {
		await unpinSearch(jit.pinnedId);
		return;
	}
	// Capture query + sort now; the name comes from the modal. (The active
	// scope could change while the modal is open — we pin what was loaded.)
	const query = jit.query;
	const sort = { column: state.sortColumn, dir: state.sortDir };
	openNamePrompt({
		title: 'Pin Search',
		label: 'Name',
		initial: jit.name,
		confirmLabel: 'Pin',
		onSubmit: async (name) => {
			try {
				const created = await window.api['pinned:create']({ name, query, sort });
				// If that search is still the loaded scope, stamp it with the new
				// id (button → pinned, nav row → selected) and rename the header
				// to match. Open the folder so the new pin is visible.
				const cur = shell.currentJit();
				if (cur && cur.query === query && cur.pinnedId == null) {
					shell.setJit({ name, query, pinnedId: created.id });
					syncCurrentEntryLocation();
				}
				setPinnedExpanded(true);
				savePinnedExpanded(true);
				updatePinButton();
				await loadPinnedSearches();
			} catch (err) {
				pinnedLog.error('pin failed', err);
				showToast('Pin failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
			}
		},
	});
}

function wirePinButton(): void {
	const btn = document.getElementById('pin-search-btn');
	if (!btn) return;
	btn.addEventListener('click', (e) => { e.preventDefault(); void togglePinCurrentSearch(); });
}

// Shared by the filter-bar button and the inline Ctrl-B handler. The shell
// signal drives the DOM (via regionEffect); persistence mirrors it here so
// the viewmodel stays storage-free.
function toggleSidebarCollapsed(): void {
	shell.toggleSidebar();
	setSidebarCollapsed(shell.sidebarCollapsed());
}

function wireSidebarToggleButton(): void {
	document.getElementById('sidebar-toggle-btn')?.addEventListener('click', toggleSidebarCollapsed);
}

function openNamePrompt(opts: NamePromptOptions): void {
	namePromptDialog?.open(opts);
}

// Name → library artist → "Artist: X" scope. The shared path for every
// surface that only knows a name (Discover cards, now-playing credit line).
// Fold-matched and alias-aware on the core side; a name the library doesn't
// hold just says so.
async function showArtistInLibrary(name: string): Promise<void> {
	try {
		const a = await window.api['artists:resolve'](name);
		if (!a) { showToast('Not in your library', { sub: name, kind: 'info' }); return; }
		// A click on an artist name is a drill-down from wherever it happened
		// (Discover card, now-playing credit) — the breadcrumb leads back there.
		await enterJitScope({ name: `Artist: ${a.name}`, query: buildExactAttr('artistid', a.id) }, undefined, { drill: true });
	} catch (err) {
		showToast('Artist lookup failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
	}
}

// Optimistic in-place rename of a rekordbox-tree row (folder or playlist).
// Only the renamed row gets a fresh object; the rest keep their reference per
// the sidebar perf contract.
function patchRbTreeName(kind: 'folder' | 'playlist', id: string, name: string): void {
	const tree = library.rekordboxTree();
	const ascii = searchFold(name);
	if (kind === 'folder') {
		library.setRekordboxTree({
			folders: tree.folders.map((f) => (f.id === id ? { ...f, name, nameAscii: ascii } : f)),
			playlists: tree.playlists,
		});
	} else {
		library.setRekordboxTree({
			folders: tree.folders,
			playlists: tree.playlists.map((p) => (p.id === id ? { ...p, name, nameAscii: ascii } : p)),
		});
	}
}

// Generic rename — opens the name modal ("Rename" / OK, current name selected)
// and dispatches by kind. Streaming playlists push to the source immediately
// (inside renamePlaylist); rekordbox playlists/folders rename locally and push
// on the next Sync to Rekordbox; pinned searches and local playlists are
// Curator-only.
function openRenameDialog(target: { kind: 'playlist' | 'folder' | 'pinned'; id: string; name: string }): void {
	openNamePrompt({
		title: 'Rename',
		label: 'Name',
		initial: target.name,
		confirmLabel: 'OK',
		onSubmit: async (name) => {
			if (name === target.name) return;
			try {
				if (target.kind === 'pinned') {
					await window.api['pinned:rename'](target.id, name);
					await loadPinnedSearches();
					// Keep the loaded JIT + header label in sync if this pinned
					// search is the active scope.
					const jit = shell.currentJit();
					if (jit?.pinnedId === target.id) {
						shell.setJit({ name, query: jit.query, pinnedId: target.id });
						syncCurrentEntryLocation();
					}
				} else if (target.kind === 'folder') {
					await window.api['playlists:rename-folder'](target.id, name);
					patchRbTreeName('folder', target.id, name);
					showToast('Folder renamed', { kind: 'success' });
				} else {
					// Playlist — source decides the toast + which cache holds the row.
					const pl = library.getPlaylist(target.id)
						?? library.rekordboxTree().playlists.find((p) => p.id === target.id);
					const res = await window.api['playlists:rename'](target.id, name);
					if (pl?.source === 'rekordbox') {
						patchRbTreeName('playlist', target.id, name);
						showToast('Playlist renamed', { kind: 'success' });
					} else {
						library.patchPlaylist(target.id, { name, nameAscii: searchFold(name) });
						showToast(res.pushedToSource ? 'Renamed on source' : 'Renamed', { kind: 'success' });
					}
				}
			} catch (err) {
				log.for('rename').error('failed', err);
				showToast('Rename failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
			}
		},
	});
}

// "Create Playlist…" on a pinned search — materialize its tracks (in the order
// the user sees) into a new editable local playlist. We load the search first
// so getMainTracks() reflects exactly that result set, then prompt for a name
// (defaulting to the search's). The new playlist is a one-shot copy: it does
// not stay linked to the query.
async function createPlaylistFromPinned(id: string): Promise<void> {
	const p = pinnedSearches().find((x) => x.id === id);
	if (!p) return;
	if (shell.currentJit()?.pinnedId !== id) {
		if (p.sortColumn) {
			state.sortColumn = p.sortColumn as SortColumn;
			state.sortDir = (p.sortDir ?? 'asc') as SortDir;
		}
		await enterJitScope({ name: p.name, query: p.query, pinnedId: p.id });
		updatePinButton();
	}
	const ids = getMainTracks().map((t) => t.id);
	if (ids.length === 0) {
		showToast('Nothing to materialize', { sub: `${p.name} — no tracks`, kind: 'info' });
		return;
	}
	openNamePrompt({
		title: 'Create Playlist',
		label: 'Playlist name',
		initial: p.name,
		confirmLabel: 'Create',
		onSubmit: async (name) => {
			try {
				const created = await window.api['playlists:create-local'](name, ids);
				// Reload so the new row appears in the Rekordbox tab's Curator
				// section, then jump there and open it.
				await refreshAll();
				await openPlaylistById(created.id);
				showToast('Playlist created', { sub: `${created.name} · ${ids.length} tracks`, kind: 'success' });
			} catch (err) {
				pinnedLog.error('create playlist failed', err);
				showToast('Create playlist failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
			}
		},
	});
}

function wireEnrichStopButton(): void {
	const btn = document.getElementById('enrich-inline-stop') as HTMLButtonElement | null;
	if (!btn) return;
	btn.addEventListener('click', async () => {
		btn.disabled = true;
		try {
			const e = enriching();
			if (e?.source === 'wav' && e.runId) {
				await window.api['wav:cancel'](e.runId);
				showToast('Stopping conversion…', { sub: 'Finished WAVs are kept', kind: 'info', durationMs: 2500 });
				return;
			}
			await window.api['enrich:cancel']();
			showToast('Stopping…', { sub: 'Cancellation requested', kind: 'info', durationMs: 2000 });
		} catch (err) {
			log.for('enrich').error('cancel failed', err);
		} finally {
			// re-enable after a tick — the actual session-end clearEnrichment()
			// hides the whole pill, so this is just defensive.
			setTimeout(() => { btn.disabled = false; }, 800);
		}
	});
}

// Run the Spotify sync. Wired as the onSyncNow callback for SyncView;
// the component's button is `disabled` while running so re-entry is
// not possible from the UI — the syncRunning guard is defensive only.
// Treat 5xx, 429, and bare-fetch failures as transient — keep retrying.
// 4xx (auth, bad request) surface immediately so the user can fix them.
// Heuristic on Error.message because the Spotify client throws plain
// strings; if we ever add typed errors we'd switch to instanceof checks.
const TRANSIENT_PATTERNS = [
	/spotify (50\d|429)\b/i,         // 500/502/503/504/429 from the API
	/fetch failed/i,                 // undici/Node 18+ offline / DNS
	/network/i,                      // various network-layer messages
	/timeout/i,
	/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|ENETUNREACH|EAI_AGAIN/i,
];
function isTransientSyncError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

// Cancel-aware sleep. Resolves either when the delay elapses OR when the
// stop flag flips. Lets the retry loop break out of a 15s wait the
// instant the user presses Stop, instead of finishing the timer first.
function sleepWithStopCheck(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const tickMs = 250;
		const deadline = Date.now() + ms;
		const tick = (): void => {
			if (syncState.stopRequested()) return resolve();
			if (Date.now() >= deadline) return resolve();
			setTimeout(tick, tickMs);
		};
		tick();
	});
}

const SPOTIFY_RETRY_DELAY_MS = 15_000;

async function runSpotifySync(opts: { force?: boolean } = {}): Promise<void> {
	if (syncState.running() || syncState.retrying()) return;
	// Fresh retry session — clear any leftover stop request from the prior
	// run so we don't immediately bail out of the first attempt.
	syncState.setStopRequested(false);

	let plan: Awaited<ReturnType<typeof window.api['sync:spotify:plan']>>;
	let deleteRemoved = false;
	try {
		// Plan-and-confirm. Single roundtrip to Spotify lists what's about
		// to change; deletions require explicit user confirmation so we
		// never reap playlists silently. We do this OUTSIDE the retry loop
		// — if planning itself fails on connection, we'll enter the retry
		// loop and re-plan on each attempt instead.
		plan = await window.api['sync:spotify:plan']();
		if (plan.toRemove.length > 0) {
			const names = plan.toRemove.map((p) => `• ${p.name}`).join('\n');
			const message = `${plan.toRemove.length} playlist(s) are no longer in your Spotify library:\n\n${names}\n\nRemove them from Curator too?`;
			deleteRemoved = window.confirm(message);
		}
	} catch (err) {
		if (!isTransientSyncError(err)) {
			syncLog.error('plan failed', err);
			showToast('Sync failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
			return;
		}
		// Plan failed transiently — fall through into the retry loop with
		// neutral defaults. The run-loop attempt will re-plan implicitly
		// inside the next IPC call (server diff happens server-side).
		plan = { toAdd: 0, toUpdate: 0, toRemove: [] };
	}

	const startSub = opts.force
		? `Full resync — every playlist will be re-fetched${deleteRemoved ? `, ${plan.toRemove.length} to remove` : ''}`
		: `${plan.toAdd} new, ${plan.toUpdate} changed${deleteRemoved ? `, ${plan.toRemove.length} to remove` : ''}`;
	showToast(opts.force ? 'Resyncing Spotify entirely…' : 'Syncing Spotify…', {
		sub: startSub,
		kind: 'info',
		durationMs: 2200,
	});

	// Retry loop. Each iteration attempts the IPC call once. Success →
	// break. Transient failure → flip into retrying state, sleep, try
	// again (idempotent thanks to snapshot_id short-circuit). Real
	// failure → surface immediately. Stop pressed → bail with a notice.
	while (true) {
		try {
			const res = await window.api['sync:spotify:run']({ deleteRemoved, force: opts.force });
			// Clear retrying state on success — the tooltip drops back to
			// the normal "X unchanged, Y updated" view, button reverts.
			// (Tooltip recomputes via the boot effect on every store change.)
			syncState.setRetrying(false);
			void renderSettingsConnections();
			showToast(opts.force ? 'Spotify resync complete' : 'Spotify sync complete', {
				sub: `${res.playlists} playlists · ${res.tracksUpserted.toLocaleString()} tracks${res.removed ? ` · ${res.removed} removed` : ''}`,
				kind: 'success',
				durationMs: 4000,
			});
			await refreshAll();
			return;
		} catch (err) {
			if (syncState.stopRequested()) {
				// User pressed Stop after the attempt started but before
				// it returned — treat as a clean cancel, no error toast.
				syncState.setRetrying(false);
				void renderSettingsConnections();
				showToast('Sync stopped', { sub: 'Will resume on the next manual sync', kind: 'info' });
				return;
			}
			if (!isTransientSyncError(err)) {
				syncState.setRetrying(false);
				void renderSettingsConnections();
				syncLog.error('failed', err);
				showToast('Sync failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
				return;
			}
			// Transient — enter (or stay in) retrying state and wait.
			syncState.setRetrying(true);
			void renderSettingsConnections();
			syncLog.warn('transient failure, retrying', undefined, err);
			await sleepWithStopCheck(SPOTIFY_RETRY_DELAY_MS);
			if (syncState.stopRequested()) {
				syncState.setRetrying(false);
				void renderSettingsConnections();
				showToast('Sync stopped', { sub: 'Will resume on the next manual sync', kind: 'info' });
				return;
			}
			// Loop back for another attempt.
		}
	}
}

// Download progress lands in a separate stream so it doesn't tangle with the
// enrichment indicator. For now: toast the start/done/error, log percent
// updates. A dedicated progress UI is a follow-up.
// ─── Downloads view + chip ─────────────────────────────────────────────────
// Mirrors the backend queue. Topbar chip is the persistent indicator; the
// Downloads view is the reactive components/DownloadsView.tsx component
// (mounted in boot()).

function renderDownloadsChip(): void {
	const chip = document.getElementById('downloads-chip');
	const pctEl = document.getElementById('downloads-chip-pct');
	const countsEl = document.getElementById('downloads-chip-counts');
	// Reading the store inside the boot effect makes this painter reactive
	// — every queue event repaints the chip without manual call chains.
	const s = downloads.summary();
	// Downloads tab count badge — same source of truth as the chip.
	// FUNCTIONAL update: this runs inside a createEffect, so reading
	// tagCountsSignal here would make the effect track its own write and
	// loop. The updater form writes without reading.
	setTagCountsSignal((prev) => ({ ...prev, downloads: s.total }));
	if (!chip || !pctEl || !countsEl) return;
	if (s.total === 0) {
		chip.hidden = true;
		return;
	}
	chip.hidden = false;
	pctEl.textContent = `${s.overallPct}%`;
	const errs = s.error > 0 ? ` · ${s.error} err` : '';
	const completed = s.done + s.skipped;
	countsEl.textContent = `${completed}/${s.total}${errs}`;
	const allDone = completed === s.total && s.error === 0;
	const allFinished = completed + s.error === s.total;
	const dataState = allDone ? 'done' : (s.downloading > 0 || s.pending > 0) ? 'active' : (allFinished && s.error > 0) ? 'errors' : 'idle';
	chip.setAttribute('data-state', dataState);
}

// Opens the Downloads view. Used by both the topbar chip click and by the
// "Download FLAC" context-menu action. (The tab highlight derives from
// shell.activeTabId in TopFrame — nothing to toggle by hand.)
function openDownloadsView(): void {
	void switchToTab('downloads', () => ({ kind: 'downloads' }));
}

async function refreshDownloads(): Promise<void> {
	// Store refresh; the chip + DownloadsView repaint reactively (the
	// chip's effect in boot tracks downloads.summary()).
	await downloads.refresh();
}

// ─── Player wiring ─────────────────────────────────────────────────────────
// Spotify/Tidal playback. The player module owns the SDK lifecycle; here we
// wire the transport buttons, the now-playing card, the scrubber position,
// and the global keyboard shortcuts (Space/Enter/Left/Right). Double-click
// on a row is wired via the tbody delegation up in wireTbodyDelegationOnce.
// Loaded once per current-track change. The beatgrid + cues drive the
// transport's bar-jump buttons and the scrubber's cue marker rendering;
// peaks are reserved for the upcoming waveform widget but cached now so
// the small-player rebuild can read them without a fresh disk hit.
// CurrentAnalysis, currentAnalysis, analysisLoadingFor, and the
// loadAnalysisFor function all moved into stores/analysisStore.ts. Reads
// go through analysisStore.getCurrentAnalysis(); loads auto-trigger on
// player track change.

// `cueColor()` moved into apps/desktop/src/renderer/cuePalette.ts — the
// rb sidecar is now the single source of truth for the (id → hex) map.
// Imported at the top of this file alongside `loadCuePalette` /
// `cuePaletteEntries`.



// (bigCuePage, repaintBigCueGrid moved into components/CueGridView.tsx.
// Page state lives inside the component; cue rendering reacts to the
// currentCues signal in main.ts.)

// Snap an arbitrary position to the nearest beat. Duplicates the
// deck/controller.ts helper because the deck doesn't expose it — same
// shape, kept local so a future shared music-utils module can absorb
// both call sites in one move.
function nearestBeatTime(beats: Float32Array, t: number): number {
	if (beats.length === 0) return t;
	if (t <= beats[0]!) return beats[0]!;
	if (t >= beats[beats.length - 1]!) return beats[beats.length - 1]!;
	let lo = 0, hi = beats.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (beats[mid]! <= t) lo = mid; else hi = mid - 1;
	}
	const before = beats[lo]!;
	const after = beats[lo + 1]!;
	return (t - before) <= (after - t) ? before : after;
}

// Create a hot cue (point or loop) at the requested pad slot.
//   - If a loop is currently active, capture it as a loop cue (the user
//     manually chose those bounds — don't snap them again).
//   - Otherwise, drop a point cue at the current playhead; snap to the
//     nearest beat when quantize is on, matching cue-trigger semantics.
async function createCueAtCurrent(slot: number): Promise<void> {
	const st = player.getState();
	const trackId = st.current?.trackId;
	if (!trackId) return;
	const loop = deck?.activeLoop() ?? null;
	let positionSec: number;
	let lengthSec: number | null;
	if (loop) {
		positionSec = loop.inSec;
		lengthSec = Math.max(0, loop.outSec - loop.inSec);
	} else {
		positionSec = st.position;
		const quantize = deck?.quantizeOn() ?? false;
		const beats = analysisStore.getCurrentAnalysis()?.beats;
		if (quantize && beats && beats.length > 1) {
			positionSec = nearestBeatTime(beats, positionSec);
		}
		lengthSec = null;
	}
	try {
		await window.api['cue:upsert']({
			trackId, slot, kind: 'hot',
			positionSec, lengthSec,
			color: null, name: null,
		});
		await analysisStore.refreshCues(trackId);
		refreshCurrentCues();
	} catch (err) {
		log.for('cue').error('create failed', err);
		showToast('Failed to set cue', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
	}
}

// Right-click menu for an already-set cue pad. Rename / pick a colour /
// delete. Color swatches come from the rb sidecar via cuePaletteEntries()
// — `entry.id` is the opaque token Curator stores and rb interprets; this
// file never names a specific color or knows what one looks like. The 16
// palette entries render as a 4×4 swatch matrix (color names live in cell
// tooltips); "No color" keeps its labeled row above the grid since it's a
// clear action, not a hue.
function openCueContextMenu(evt: MouseEvent, cue: CueData): void {
	const trackId = player.getState().current?.trackId;
	if (!trackId) return;
	const label = cue.name ?? (cue.lengthSec && cue.lengthSec > 0 ? 'loop cue' : 'cue');
	const palette = cuePaletteEntries();
	const items: ContextMenuItem[] = [
		{ kind: 'header', label },
		{
			kind: 'item', id: 'rename', label: 'Rename…',
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
		},
		{ kind: 'divider' },
		{
			kind: 'item', id: 'color:none', label: 'No color',
			iconHtml: '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;border:1px solid currentColor;margin-right:6px;vertical-align:middle"></span>',
		},
		{
			kind: 'swatch-grid',
			columns: 4,
			cells: palette.map((e) => ({
				id: `color:${e.id}`,
				hex: e.hex,
				label: e.label,
				selected: cue.color === e.id,
			})),
		},
		{ kind: 'divider' },
		{
			kind: 'item', id: 'delete', label: 'Delete', danger: true,
			iconHtml: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 6l12 12M18 6 6 18"/></svg>',
		},
	];
	const setColor = async (next: string | null): Promise<void> => {
		await window.api['cue:update'](cue.id, { color: next });
		await analysisStore.refreshCues(trackId);
		refreshCurrentCues();
	};
	const handlers: Record<string, () => Promise<void>> = {
		rename: async () => {
			const next = window.prompt('Rename cue', cue.name ?? '');
			if (next == null) return;
			const trimmed = next.trim();
			const value = trimmed.length === 0 ? null : trimmed;
			if (value === (cue.name ?? null)) return;
			await window.api['cue:update'](cue.id, { name: value });
			await analysisStore.refreshCues(trackId);
			refreshCurrentCues();
		},
		delete: async () => {
			await window.api['cue:delete'](cue.id);
			await analysisStore.refreshCues(trackId);
			refreshCurrentCues();
		},
		'color:none': () => setColor(null),
	};
	for (const e of palette) {
		handlers[`color:${e.id}`] = () => setColor(e.id);
	}
	openContextMenu(items, handlers, { at: evt });
}





// Beat-jump / cue-trigger / loop logic moved into deck/controller.ts —
// the DeckController owns musical-time scheduling (quantize, loop wrap,
// beat math) above the transport-level player module. The host (this
// file) just instantiates the deck and forwards UI callbacks to it.
// See [[curator-deck-engine-layering]] for the layering rationale.

// Push current beatgrid availability into the signal that TransportView
// reads. Replaces the previous DOM-querying applyJumpButtonAvailability —
// the component owns the buttons now and reacts to the signal.
function refreshBeatsAvailable(): void {
	const a = analysisStore.getCurrentAnalysis();
	setBeatsAvailable(!!(a?.beats && a.beats.length > 1));
}

// PeaksSource, PeaksTier, decodeCpk, currentPeaks, peaksLoadingFor, and
// loadPeaksFor all moved into stores/analysisStore.ts. PeaksTier is
// re-imported above as a type-only import so the waveform painters keep
// their signatures.

// Player mode is fully derived now: the region effect computes the applied
// mode (deck preference gated by shell.bigPlayerAllowed) and writes both the
// body attribute and currentPlayerMode. main.ts only owns the PREFERENCE —
// the toggle below mutates + persists it and the derivation does the rest.

// Small/big is a convention of the local deck player — the streaming
// transport is a different player entirely, so the toggle only applies while
// the deck is the effective variant (shell.bigPlayerAllowed ⇔ the PLAYING
// track runs on the local backend, tab-context fallback when idle). Every
// toggle entry point (TopFrame button, controller VIEW button) routes
// through here so the gate is in one place.
function togglePlayerModeRequest(): void {
	if (shell.playerPresence() === 'hidden') {
		showToast('Nothing is playing yet — the player appears with the first track', { kind: 'info', durationMs: 2200 });
		return;
	}
	if (!shell.bigPlayerAllowed()) {
		showToast('Big player is for local playback — streaming uses its own player', { kind: 'info', durationMs: 2200 });
		return;
	}
	setDeckPlayerModePref(currentPlayerMode() === 'small' ? 'big' : 'small');
}

// Stored deck-player preference — seeds the pref signal at boot; the toggle
// keeps localStorage in sync so the choice survives restart.
function storedDeckPlayerMode(): 'small' | 'big' {
	let stored: string | null = null;
	try { stored = localStorage.getItem('curator.playerMode'); } catch { /* private mode */ }
	return stored === 'big' ? 'big' : 'small';
}

function setDeckPlayerModePref(mode: 'small' | 'big'): void {
	setDeckPlayerModePrefSignal(mode);
	try { localStorage.setItem('curator.playerMode', mode); } catch { /* private mode */ }
}

// ─── Cross-context playback chip ──────────────────────────────────────────
// The docked player always shows the right surface for the PLAYING track
// (variant → dock derive from it in the shell), so foreign playback no
// longer folds the player away. The floating chip is pure wayfinding: it
// appears when playback was started from a tab with the OTHER context class
// (shell.chipVisible, from the origin shell.notePlaybackOrigin captured at
// play time) and clicking it navigates back to that tab.
function jumpToPlayingTrackTab(): void {
	const origin = shell.playbackOrigin();
	if (!origin) return;
	// Same shape as the TopFrame tab clicks — a tab switch to the origin tab,
	// which resumes its own history where it was left.
	switch (origin.view) {
		case 'interested':
		case 'basket': {
			const view = origin.view;
			void switchToTab(view, () => ({ kind: 'tag', view }));
			return;
		}
		case 'discover':
			void switchToTab('discover', () => discoverLocation());
			return;
		case 'sync':
		case 'downloads': {
			const kind = origin.view;
			void switchToTab(kind, () => ({ kind }));
			return;
		}
		default: {
			const source = origin.source;
			void switchToTab(source, () => ({ kind: 'tracks', source, scope: sourceTabScope(source) }));
		}
	}
}

// All big-mode rAF state (bigWaveRaf, bigWaveLastPaintAt, lastStatePos,
// etc.), beat-grid DOM pools, zoom constants, and the cue DOM cache
// moved into components/MainWaveformView.tsx. Per-instance now —
// multiple decks can run their own rAF tick without colliding.


function wirePlayer(): void {
	// (#t-play, #t-prev, #t-next, and the jump buttons moved into the
	// TransportView Solid component — mounted from boot() into
	// #transport-host. The renderPlayer subscription below no longer
	// touches them; the component subscribes to the player store directly
	// for the play-icon swap, and reads a beatsAvailable signal for the
	// jump buttons' disabled state.)
	//
	// All static DOM lookups (#t-bar / #t-fill / #t-pos / #t-dur / np-* /
	// vol-*) used to live here. Every one of those surfaces is now
	// owned by a Solid component (MainWaveformView / NowPlayingCard /
	// VolumeControl). wirePlayer keeps only the cross-cutting wiring:
	// now-playing row indicator, analysisStore listeners, keyboard
	// shortcuts.
	// Now-playing indicator — swap row index for the equalizer GIF on
	// whatever track is *actively playing*. Gated on st.playing so the
	// indicator clears on pause (and re-appears on resume). setNowPlaying
	// TrackId also re-walks the DOM so live transitions (next/prev/stop)
	// flip the class on already-painted rows.
	player.subscribe((st) => {
		setNowPlayingTrackId(st.playing && st.current ? st.current.trackId : null);
	});
	// Track-change tap. The analysisStore auto-kicks analysis + peaks
	// loads via its own player.subscribe (see stores/analysisStore.ts) —
	// we just need to refresh the things that depend on "which track is
	// current" but DON'T require the new track's analysis to be loaded.
	//
	// Deliberately NOT calling renderScrubberWaveform / renderMiniWavemap
	// here. With the per-trackId store, getCurrentPeaks() returns null
	// during the post-track-change load gap, and a paint with null clears
	// the canvas — causing a visible blank flash between tracks. Instead:
	//   • Big mode: the rAF tick keeps painting the still-cached old
	//     track's peaks until the new track's peaks land (the tick reads
	//     `getCurrentPeaks()` per frame; once new peaks land it paints
	//     them automatically).
	//   • Small mode: onPeaksLoaded fires once the new track's peaks are
	//     ready and that listener calls renderScrubberWaveform.
	//
	// Cue repaint is also deferred to the analysis-loaded listener so the
	// scrubber cues don't snap to whole-track positions during the gap
	// (the rAF tick in big mode paints them with viewport coords anyway).
	let lastAnalysisTrackId: string | null = null;
	player.subscribe((st) => {
		const id = st.current?.trackId ?? null;
		if (id === lastAnalysisTrackId) return;
		lastAnalysisTrackId = id;
		refreshBeatsAvailable();
	});
	// Mirror the playing track's layout class into the shell — THE fact all
	// player chrome (variant → dock → big gate, presence) derives from.
	// Reads only st.current, so it re-fires on track change, not every
	// position tick; the signal's own equality check means downstream memos
	// only recompute on an actual local ↔ streaming flip (or load/stop).
	// Origin clearing on full stop lives inside shell.setPlayingLayout.
	player.subscribe((st) => {
		shell.setPlayingLayout(st.current ? (st.current.source === 'local' ? 'local' : 'streaming') : null);
	});
	// Beatgrid provider for the player: playLocal pushes the current
	// grid into the audio sidecar right after each load (engine-side
	// beat jumps compute against it). Provider indirection because
	// player.ts can't import analysisStore (import cycle).
	player.setBeatgridProvider(() => analysisStore.getCurrentAnalysis()?.beats ?? null);
	// Repaint hooks for the analysisStore. Filter to the current track so
	// a stale load (user already skipped) doesn't trample the visible paint.
	analysisStore.onAnalysisLoaded((trackId) => {
		if (trackId !== analysisStore.getCurrentTrackId()) return;
		refreshBeatsAvailable();
		refreshCurrentCues();
		refreshCurrentBeats();
		refreshCurrentDownbeats();
		refreshCurrentSegments();
		// Late-arriving grid (fresh analysis, rb ↔ curator source flip):
		// re-push the sidecar's copy. The load-time push in playLocal only
		// covers analysis that was already cached when playback started.
		if (player.getState().current?.source === 'local') {
			player.setNativeBeatgrid(analysisStore.getCurrentAnalysis()?.beats ?? null);
		}
	});
	analysisStore.onPeaksLoaded((trackId) => {
		if (trackId !== analysisStore.getCurrentTrackId()) return;
		refreshCurrentPeaks();
	});
	// (Duration-watcher's repaintScrubberCues + window-resize repaint both
	// moved into MainWaveformView. The component's cue-row memo reads
	// duration via accessor — recomputes whenever duration changes. The
	// resize listener inside the component re-buckets the small-mode SVG.)

	// (Play/prev/next click handlers + beat-jump button handlers moved
	// into TransportView. The component dispatches jumps back via the
	// onBeatJump callback wired in boot() → jumpByBeats.)

	// (Click-to-seek on the main scrubber bar and the mini-wavemap both
	// live inside their respective Solid components — MainWaveformView
	// and MiniWaveMapView.)

	// Global keyboard shortcuts. Suppressed when a text input is focused so
	// the user can type freely in the sidebar search / edit-track modal.
	//
	// Scoping rule:
	// • Space (play/pause) stays global — handy from any tab.
	// • Arrows + Enter + Ctrl-arrows are scoped to "music-source" tabs
	//   (Spotify/Tidal/Local) where a single track list is the focus. In
	//   other views (Sync, Downloads, etc.) plain arrow keys
	//   keep their default scrolling behaviour.
	//
	// Keyboard focus mode:
	// • 'tracklist' (default) — arrows nav the tracks list; ←/→ seek
	//   the player.
	// • 'sidebar' — arrows nav the playlist tree; ↑/↓ also activate the
	//   row so the tracklist updates in step; ←/→ collapse/expand the
	//   cursored rb-folder.
	// Tab toggles between the two. The body[data-kbd-focus="sidebar"]
	// attr drives the focused-cursor styling in style.css.
	let kbdFocus: 'tracklist' | 'sidebar' = 'tracklist';
	const setKbdFocus = (mode: 'tracklist' | 'sidebar'): void => {
		if (mode === kbdFocus) return;
		kbdFocus = mode;
		if (mode === 'sidebar') {
			document.body.setAttribute('data-kbd-focus', 'sidebar');
			sidebar?.ensureCursor();
		} else {
			document.body.removeAttribute('data-kbd-focus');
			sidebar?.clearCursor();
		}
	};
	// Click-to-focus: pointerdown inside .sidebar grabs keyboard focus
	// for the tree; clicking anywhere else returns it to the tracklist.
	// Mirrors native focus semantics so users don't need to Tab away
	// after clicking back into the list.
	document.addEventListener('pointerdown', (evt) => {
		const target = evt.target as HTMLElement | null;
		if (!target) return;
		setKbdFocus(target.closest('.sidebar') ? 'sidebar' : 'tracklist');
	}, true);
	// Neutralize the browser's native Ctrl/Cmd+A ("select all page text")
	// everywhere except inside a real text field. In a desktop-style UI that
	// gesture just highlights the whole chrome and reads as a bug. Capture
	// phase + its own listener so it fires regardless of modal state and only
	// kills the DEFAULT action — the tracklist's select-all command still runs
	// on the bubble-phase handler below and does the in-list selection.
	window.addEventListener('keydown', (evt) => {
		if (!(evt.ctrlKey || evt.metaKey) || (evt.key !== 'a' && evt.key !== 'A')) return;
		const t = evt.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		evt.preventDefault();
	}, true);
	// Right-click on the player's track area opens the playing track's context
	// menu. Both player layouts are covered: the small-mode strip (.sp — used
	// for streaming/feed playback) and the big-mode NowPlayingCard (.now-playing
	// — the DJ deck the Rekordbox tab docks). Excludes buttons (transport /
	// rating / favorite) and the big card's user-tag chips (.np-user-tag has its
	// own remove-tag menu — don't hijack it). Two playback origins, in order:
	//   1. Discover feed — the handle self-gates, acting only when a feed track
	//      is what's playing, and returns true once it shows its menu.
	//   2. Library Streaming/Local — when no feed track is playing, the player's
	//      own snapshot (player.currentTrack(), null for feed plays) IS the
	//      playing library row; surface the same unified track menu the tracklist
	//      rows use. Prefer the live cache row (fresh rating / re-analysis edits),
	//      falling back to the snapshot when the row has left the visible cache.
	document.addEventListener('contextmenu', (evt) => {
		const target = evt.target as HTMLElement | null;
		if (!target || !target.closest('.sp, .now-playing')) return;
		if (target.closest('button') || target.closest('.np-user-tag')) return;
		if (discoverView?.openPlayingTrackMenu(evt)) return;
		const cur = player.getState().current;
		const track = cur ? (tracksData.get(cur.trackId) ?? player.currentTrack()) : null;
		if (!track || !cur) return;
		evt.preventDefault();
		// The menu's tab context follows the playing backend: a local file
		// belongs to the Rekordbox tab (the DJ-side library), a stream to its
		// provider's tab.
		const source: SourceTab = cur.source === 'local' ? 'rekordbox' : cur.source;
		void showTrackMenu(evt, { tracks: [track], view: 'tracks', source });
	}, true);
	// Command registry — single source of truth for the keyboard shortcuts
	// below. Each command's run() body is the exact inline logic the if-else
	// chain used to hold (including every evt.preventDefault() — the registry
	// never auto-preventDefaults, because some paths intentionally fall through
	// to the browser default). The handler at the bottom keeps only the
	// structural guards (Ctrl-F filterbox focus, the inText short-circuit) and
	// then delegates to commands.dispatchKey.
	//
	// Scope/precedence is encoded in each command's `when`:
	// • 'player.togglePause' (Space) has no view gate — it fires globally,
	//   before the music-source check, matching the original ordering.
	// • Everything else requires isMusicSourceView().
	// • Sidebar-context commands gate on kbdFocus === 'sidebar'; tracklist-
	//   context commands gate on kbdFocus !== 'sidebar'. The two contexts are
	//   mutually exclusive, so the sidebar branch is fully handled before any
	//   tracklist command is reachable — same precedence as the old return-
	//   early sidebar branch.
	const commands = new CommandRegistry();
	// History back / forward — registered FIRST so Alt+←/→ beat the sidebar
	// and player arrow commands below (first match wins), and ungated: the
	// arrows work from every view. The keydown handler also routes these
	// two chords around its typing guard so they fire inside the filterbox
	// like a browser's.
	commands.register({
		id: 'nav.back',
		title: 'Back',
		keys: ['Alt+ArrowLeft'],
		run: (evt) => { evt.preventDefault(); goBack(); },
	});
	commands.register({
		id: 'nav.forward',
		title: 'Forward',
		keys: ['Alt+ArrowRight'],
		run: (evt) => { evt.preventDefault(); goForward(); },
	});
	const musicSource = (): boolean => isMusicSourceView();
	const inSidebar = (): boolean => isMusicSourceView() && kbdFocus === 'sidebar';
	const inTracklist = (): boolean => isMusicSourceView() && kbdFocus !== 'sidebar';
	// R/T/P/E (rate/tag/playlist/edit) also fire in the Pinned (Interested)
	// tag view — it renders the same tracklist, so the curation shortcuts
	// carry over. Navigation/Delete/select-all stay scoped to source views
	// (inTracklist): in Pinned, removing a row is "Unpin", a context-menu
	// action — neither Remove-from-playlist nor a library delete.
	const inCurationList = (): boolean =>
		(isMusicSourceView() || shell.activeView() === 'interested') && kbdFocus !== 'sidebar';

	// Current selection as a track-command context — the bridge the keyboard
	// shortcuts use to share gating + behavior with the right-click menu. Tracks
	// are taken in visible order so a multi-action reads top-to-bottom.
	const trackCtx = (): TrackSelectionContext => {
		const sel = getSelectedTrackIds();
		return { tracks: getMainTracks().filter((t) => sel.has(t.id)), view: shell.activeView(), source: shell.activeSource(), playlist: currentEditablePlaylist(), jit: shell.currentJit() };
	};

	// The old check was `evt.key === ' ' || evt.code === 'Space'` with no
	// modifier gate, so every Space variant toggled playback (and was
	// preventDefault'd). Cover them all so behaviour is unchanged.
	commands.register({
		id: 'player.togglePause',
		title: 'Play / pause',
		keys: ['Space', 'Mod+Space', 'Shift+Space', 'Alt+Space', 'Mod+Shift+Space', 'Mod+Alt+Space', 'Shift+Alt+Space', 'Mod+Shift+Alt+Space'],
		run: (evt) => {
			evt.preventDefault();
			player.togglePause().catch(() => {});
		},
	});

	// Tab toggles keyboard focus between the tracklist and the
	// playlist tree. Shift+Tab does the same (two-way toggle —
	// there's nowhere else to go). When returning to the
	// tracklist, anchor focus on a row the user can actually act
	// on with the next arrow keypress: the first-in-order selected
	// row if any selection exists, otherwise the topmost visible
	// row (selecting it so subsequent arrows move from there).
	// Ctrl/Cmd+Tab is reserved for window/tab cycling (the old branch did
	// `if (mod) return`), so the Tab specs deliberately exclude Mod but cover
	// the other modifier variants the old branch fell through on.
	commands.register({
		id: 'focus.toggle',
		title: 'Toggle sidebar / tracklist focus',
		keys: ['Tab', 'Shift+Tab', 'Alt+Tab', 'Shift+Alt+Tab'],
		when: musicSource,
		run: (evt) => {
			evt.preventDefault();
			const next = kbdFocus === 'sidebar' ? 'tracklist' : 'sidebar';
			setKbdFocus(next);
			if (next === 'tracklist') anchorTracklistFocus();
		},
	});

	// When the sidebar holds keyboard focus, route arrows + Enter
	// there instead of the tracklist. Escape returns focus to the
	// tracklist (familiar "leave the side panel" gesture).
	//
	// The old sidebar branch matched arrows/Enter/Escape on `evt.key` ALONE,
	// ignoring modifiers (then returned), so e.g. Shift+ArrowUp stepped the
	// tree just like a plain ArrowUp. Spell out every modifier variant here so
	// the registry's exact-modifier matching reproduces that — otherwise
	// Mod/Shift/Alt+Arrow in sidebar mode would fall through to nothing.
	commands.register({
		id: 'sidebar.escape',
		title: 'Sidebar: return focus to tracklist',
		keys: ['Escape', 'Mod+Escape', 'Shift+Escape', 'Alt+Escape'],
		when: inSidebar,
		run: (evt) => {
			evt.preventDefault();
			setKbdFocus('tracklist');
		},
	});
	commands.register({
		id: 'sidebar.up',
		title: 'Sidebar: previous row',
		keys: ['ArrowUp', 'Mod+ArrowUp', 'Shift+ArrowUp', 'Alt+ArrowUp'],
		when: inSidebar,
		run: (evt) => {
			evt.preventDefault();
			sidebar?.stepSelection(-1);
			// Stepping navigates on every press — a run of steps coalesces
			// into one history entry (the hint is consumed synchronously by
			// the row handler's navigate call).
			pendingNavGesture = 'sidebar-step';
			sidebar?.activateCursor();
			pendingNavGesture = null;
		},
	});
	commands.register({
		id: 'sidebar.down',
		title: 'Sidebar: next row',
		keys: ['ArrowDown', 'Mod+ArrowDown', 'Shift+ArrowDown', 'Alt+ArrowDown'],
		when: inSidebar,
		run: (evt) => {
			evt.preventDefault();
			sidebar?.stepSelection(1);
			pendingNavGesture = 'sidebar-step';
			sidebar?.activateCursor();
			pendingNavGesture = null;
		},
	});
	// (Alt+←/→ belong to history back/forward — see nav.back / nav.forward.)
	commands.register({
		id: 'sidebar.collapse',
		title: 'Sidebar: collapse',
		keys: ['ArrowLeft', 'Mod+ArrowLeft', 'Shift+ArrowLeft'],
		when: inSidebar,
		run: (evt) => {
			evt.preventDefault();
			sidebar?.setExpand(false);
		},
	});
	commands.register({
		id: 'sidebar.expand',
		title: 'Sidebar: expand',
		keys: ['ArrowRight', 'Mod+ArrowRight', 'Shift+ArrowRight'],
		when: inSidebar,
		run: (evt) => {
			evt.preventDefault();
			sidebar?.setExpand(true);
		},
	});
	commands.register({
		id: 'sidebar.enter',
		title: 'Sidebar: activate row',
		keys: ['Enter', 'Mod+Enter', 'Shift+Enter', 'Alt+Enter'],
		when: inSidebar,
		run: (evt) => {
			evt.preventDefault();
			// Enter mirrors the controller path: toggles rb-folder
			// expansion, activates anything else. (Arrows already
			// activated on the way here.)
			sidebar?.enterSelection();
		},
	});

	// `R` opens the rating dialog for the current tracklist selection (keyboard
	// only — the menu no longer carries a Rate item). Bare letter — no modifier —
	// because the bigger keyboard handler short-circuits while typing in an
	// input/textarea. Non-Mod modifier variants are spelled out so the registry's
	// exact matching reproduces the old `!mod` gate (Shift+R / Alt+R fired too).
	commands.register({
		id: 'tracks.rate',
		title: 'Rate selected tracks',
		keys: ['r', 'Shift+r', 'Alt+r', 'Shift+Alt+r'],
		when: () => inCurationList() && trackCtx().tracks.length > 0,
		run: (evt) => {
			evt.preventDefault();
			openRatingDialogForTracks(trackCtx().tracks.map((t) => t.id));
		},
	});

	// `O` opens the unified Organize modal (tags + playlists) for the current
	// selection. Delegates to the `organize` track command so the shortcut and
	// the menu "Organize…" item share one definition. Bare letter — the `inText`
	// guard above prevents firing while typing in the filterbox. `T`/`P` also
	// map here so the old muscle memory still lands on the merged surface.
	commands.register({
		id: 'tracks.organize',
		title: 'Organize selected tracks (tags + playlists)',
		keys: ['o', 'Shift+o', 'Alt+o', 'Shift+Alt+o', 't', 'Shift+t', 'Alt+t', 'Shift+Alt+t', 'p', 'Shift+p', 'Alt+p', 'Shift+Alt+p'],
		when: () => inCurationList() && trackCommandAvailable('organize', trackCtx()),
		run: (evt) => { if (runTrackCommand('organize', trackCtx())) evt.preventDefault(); },
	});

	// Ctrl-A → select every loaded track in the list. selectAll is silent
	// on the component side (no onSelectionChange), so persist explicitly
	// so the next view switch restores the same selection. The old check was
	// `mod && (key === 'a' || 'A')` — gated on Mod presence but not Shift/Alt,
	// so Mod+Shift+A fired it too; cover those variants here.
	// `E` edits the single selected track — delegates to the `edit` command,
	// whose `single` predicate is the no-op-for-0-or-2+ gate.
	commands.register({
		id: 'tracks.edit',
			title: 'Edit selected track',
			keys: ['e'],
			when: () => inCurationList() && trackCommandAvailable('edit', trackCtx()),
			run: (evt) => { if (runTrackCommand('edit', trackCtx())) evt.preventDefault(); },
		});

		// Plain Delete/Backspace removes the selection from the playlist on
		// screen (Curator confirm dialog, then Undo toast). Inert anywhere that isn't a real
		// playlist — All tracks, folders, search scopes — so the key can never
		// reach a library delete by accident. Registered before tracks.delete;
		// the registry matches modifiers exactly, so Shift+Delete skips it.
		commands.register({
			id: 'tracks.removeFromPlaylist',
			title: 'Remove selected tracks from the current playlist',
			keys: ['Delete', 'Backspace'],
			when: () => inTracklist() && trackCommandAvailable('remove-from-playlist', trackCtx()),
			run: (evt) => { if (runTrackCommand('remove-from-playlist', trackCtx())) evt.preventDefault(); },
		});

		// Shift+Delete/Shift+Backspace opens the per-source library Delete
		// dialog (moved off plain Delete after an accidental delete on
		// 2026-10-05 stripped three tracks from rekordbox and Spotify).
		commands.register({
			id: 'tracks.delete',
			title: 'Delete selected tracks from the library',
			keys: ['Shift+Delete', 'Shift+Backspace'],
			when: () => inTracklist() && trackCommandAvailable('delete', trackCtx()),
			run: (evt) => { if (runTrackCommand('delete', trackCtx())) evt.preventDefault(); },
		});

		commands.register({
			id: 'tracks.selectAll',
		title: 'Select all tracks',
		keys: ['Mod+a', 'Mod+Shift+a', 'Mod+Alt+a', 'Mod+Shift+Alt+a'],
		when: inTracklist,
		run: (evt) => {
			evt.preventDefault();
			const tracks = getMainTracks();
			if (tracks.length === 0) return;
			const ids = tracks.map((t) => t.id);
			mainTrackList?.selectAll();
			const anchor = getSelectionAnchor();
			if (!anchor || !ids.includes(anchor)) {
				mainTrackList?.setSelectionAnchor(ids[0] ?? null);
			}
			persistUiState();
		},
	});

	// Enter plays the first selected track. The old tracklist branch matched
	// `evt.key === 'Enter'` with no modifier gate, so every Enter variant lands
	// here — spell them out for the registry's exact-modifier matching.
	commands.register({
		id: 'tracks.playSelected',
		title: 'Play first selected track',
		keys: ['Enter', 'Mod+Enter', 'Shift+Enter', 'Alt+Enter'],
		when: inTracklist,
		run: (evt) => {
			// Play the first selected track. If nothing is selected, do nothing
			// — Enter shouldn't be a "play random track" gesture.
			const selected = getSelectedTrackIds();
			if (selected.size === 0) return;
			const tracks = getMainTracks();
			const firstId = tracks.find((t) => selected.has(t.id))?.id;
			if (!firstId) return;
			const t = tracksData.get(firstId);
			if (!t) return;
			evt.preventDefault();
			shell.notePlaybackOrigin();
			player.play(t, [...tracks]).catch((err) => {
				if (err instanceof player.TidalNotReadyError) {
					showToast('Tidal playback', { sub: 'Coming soon', kind: 'info' });
				} else {
					showToast('Playback failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
				}
			});
		},
	});

	// ↑/↓: the old branch always preventDefault'd, then cascaded on modifiers
	// — Mod wins (nudge volume), else Shift (extend selection), else navigate.
	// One command per physical key matching every modifier variant reproduces
	// that exact precedence (e.g. Mod+Shift+↑ nudges volume; Alt+↑ navigates).
	const navOrSelect = (evt: KeyboardEvent, dir: -1 | 1): void => {
		const mod = evt.ctrlKey || evt.metaKey;
		evt.preventDefault();
		if (mod) player.nudgeVolume(dir === -1 ? +0.05 : -0.05).catch(() => {});
		else if (evt.shiftKey) extendSelectionByOne(dir);
		else navigateTracks(dir);
	};
	commands.register({
		id: 'tracks.arrowUp',
		title: 'Previous track / nudge volume up / extend up',
		keys: ['ArrowUp', 'Mod+ArrowUp', 'Shift+ArrowUp', 'Alt+ArrowUp'],
		when: inTracklist,
		run: (evt) => navOrSelect(evt, -1),
	});
	commands.register({
		id: 'tracks.arrowDown',
		title: 'Next track / nudge volume down / extend down',
		keys: ['ArrowDown', 'Mod+ArrowDown', 'Shift+ArrowDown', 'Alt+ArrowDown'],
		when: inTracklist,
		run: (evt) => navOrSelect(evt, +1),
	});

	// Mod+↑/↓ volume nudge, GLOBAL fallback. In the tracklist/sidebar the
	// view-scoped arrow commands above claim these keys (and Mod+↑/↓ there
	// already nudges volume / steps the tree); registered after them, these
	// fire only when no view-scoped command matched — so volume control works
	// from Discover and every other non-tracklist tab too. (Plain/Shift/Alt
	// arrows stay tracklist-only — selection/seek have no meaning off it.)
	commands.register({
		id: 'player.volumeUp',
		title: 'Nudge volume up',
		keys: ['Mod+ArrowUp'],
		run: (evt) => { evt.preventDefault(); player.nudgeVolume(+0.05).catch(() => {}); },
	});
	commands.register({
		id: 'player.volumeDown',
		title: 'Nudge volume down',
		keys: ['Mod+ArrowDown'],
		run: (evt) => { evt.preventDefault(); player.nudgeVolume(-0.05).catch(() => {}); },
	});

	// ←/→: Mod → 10s coarse seek; otherwise beat/bar jumps via the deck.
	// Alt → 1 beat, Shift → 4 bars (16 beats), plain → 1 bar (4 beats).
	// Sub-beat phase is preserved by deck.jumpByBeats so jumps stay musically
	// in pocket regardless of where in the beat the playhead sits. One
	// command per direction covering every variant: plain → 4 beats, Shift →
	// 16, Mod → 10 s seek. (The Alt variant — a 1-beat nudge — was retired
	// when Alt+←/→ became history back/forward.)
	const seekOrJump = (evt: KeyboardEvent): void => {
		if (!player.getState().current) return;
		const dir = evt.key === 'ArrowLeft' ? -1 : 1;
		const mod = evt.ctrlKey || evt.metaKey;
		if (mod) {
			evt.preventDefault();
			player.seekBy(dir * 10).catch(() => {});
			return;
		}
		if (!deck) return;
		const beats = evt.shiftKey ? 16 : 4;
		evt.preventDefault();
		player.markUiAction(evt.shiftKey ? 'bar-jump-4' : 'bar-jump-1');
		deck.jumpByBeats(dir * beats);
	};
	commands.register({
		id: 'player.seekLeft',
		title: 'Seek / jump backward',
		keys: ['ArrowLeft', 'Mod+ArrowLeft', 'Shift+ArrowLeft'],
		when: inTracklist,
		run: seekOrJump,
	});
	commands.register({
		id: 'player.seekRight',
		title: 'Seek / jump forward',
		keys: ['ArrowRight', 'Mod+ArrowRight', 'Shift+ArrowRight'],
		when: inTracklist,
		run: seekOrJump,
	});

	// Jump / Jumpx4, GLOBAL fallback. The tracklist's ←/→ commands above own
	// these keys in the analyzed-local DJ workflow (4/16 beats + 10s Mod
	// seek); registered after them, these fire only in other tabs (Discover,
	// Interested, …). plain → Jump (4), Shift → Jumpx4 (16); Mod → 10s coarse
	// seek (parity). performJump picks beats vs seconds, so a Spotify track
	// played from Discover jumps in seconds. (Alt's Jumpx16 went to history
	// back/forward; JUMP_MAGS[2] stays reachable from controllers.)
	const globalJump = (evt: KeyboardEvent, dir: -1 | 1): void => {
		if (!player.getState().current) return;
		evt.preventDefault();
		if (evt.ctrlKey || evt.metaKey) { player.seekBy(dir * 10).catch(() => {}); return; }
		performJump(dir * JUMP_MAGS[evt.shiftKey ? 1 : 0]);
	};
	commands.register({
		id: 'player.jumpLeft',
		title: 'Jump backward (global)',
		keys: ['ArrowLeft', 'Mod+ArrowLeft', 'Shift+ArrowLeft'],
		run: (evt) => globalJump(evt, -1),
	});
	commands.register({
		id: 'player.jumpRight',
		title: 'Jump forward (global)',
		keys: ['ArrowRight', 'Mod+ArrowRight', 'Shift+ArrowRight'],
		run: (evt) => globalJump(evt, 1),
	});

	// Mouse side buttons (X1 / X2) — the browser back/forward gesture.
	document.addEventListener('mouseup', (evt) => {
		if (evt.button !== 3 && evt.button !== 4) return;
		if (isModalOpen()) return;
		evt.preventDefault();
		if (evt.button === 3) goBack(); else goForward();
	});

	document.addEventListener('keydown', (evt) => {
		// A modal/overlay owns the keyboard while it's open — the main-view
		// command dispatcher (player / tracklist / nav) stands down so a bare
		// Space / arrow / `e` / `Del` / `Shift+Del` can't leak past the dialog to the surface
		// beneath it. The modal's own capture-phase handlers still run first.
		if (isModalOpen()) return;
		const target = evt.target as HTMLElement | null;
		const tag = target?.tagName;
		const inText = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable;
		const mod = evt.ctrlKey || evt.metaKey;

		// Ctrl-F → focus the filterbox. Bypasses the INPUT/TEXTAREA early-
		// return because the user explicitly asked for it to be global within
		// any tracks-layout tab — sources, playlists, pinned searches, AND the
		// Interested/Basket tag views (all show the same filter-bar + table).
		// Gated on showsTracksLayout() rather than isMusicSourceView() so the
		// tag views (activeView 'interested'/'basket', not 'tracks') aren't
		// excluded; sync/downloads/discover have no filterbox and stay out. We
		// still skip when inside the omnibar / modal inputs — those have their
		// own typing context that Ctrl-F shouldn't yank focus out of. Stays
		// inline (not a command) because it runs BEFORE the `if (inText) return`
		// guard that gates every command.
		if (mod && (evt.key === 'f' || evt.key === 'F')) {
			if (!shell.showsTracksLayout()) return;
			// Allow Ctrl-F to do its native browser-find inside any modal
			// input. The tracklist filterbox itself is
			// a fine target — re-focusing it is harmless.
			if (inText && target?.id !== 'tracklist-filter') return;
			const input = document.getElementById('tracklist-filter') as HTMLInputElement | null;
			if (!input) return;
			evt.preventDefault();
			input.focus();
			input.select();
			return;
		}

		// Ctrl-B → toggle the sidebar. Inline like Ctrl-F: must run before the
		// inText guard so it works while typing in the filterbox.
		if (mod && (evt.key === 'b' || evt.key === 'B')) {
			evt.preventDefault();
			toggleSidebarCollapsed();
			return;
		}

		// Alt+←/→ → history back/forward, even while typing in the filterbox
		// (a browser navigates from inside a text field too; Alt+arrow has no
		// editing meaning). Routed through the registry so the command stays
		// the single definition.
		if (evt.altKey && !mod && !evt.shiftKey && (evt.key === 'ArrowLeft' || evt.key === 'ArrowRight')) {
			evt.preventDefault();
			commands.run(evt.key === 'ArrowLeft' ? 'nav.back' : 'nav.forward');
			return;
		}

		if (inText) return;

		commands.dispatchKey(evt);
	});
}

// Extend the current selection range by one row in `delta` direction.
// Mirrors the standard Shift+Up/Down behaviour from Finder / Explorer:
//   - If no anchor, anchor the current single selection (or the first row).
//   - The "lead" is the row at the far edge of the selection in the direction
//     of travel. Move lead by one; new selection = inclusive [anchor..lead].
//   - Scrolls the new lead into view.
function extendSelectionByOne(delta: -1 | 1): void {
	const tracks = getMainTracks();
	if (tracks.length === 0) return;
	const ids = tracks.map((t) => t.id);

	// Ensure an anchor — sticky across keystrokes once set.
	const selected = getSelectedTrackIds();
	let anchorId = getSelectionAnchor();
	if (!anchorId || !ids.includes(anchorId)) {
		const firstSel = ids.find((id) => selected.has(id)) ?? ids[0]!;
		anchorId = firstSel;
		mainTrackList?.setSelectionAnchor(anchorId);
	}
	const aIdx = ids.indexOf(anchorId);

	// Lead = farthest selected row in direction of travel, or anchor if
	// no selection has been extended yet.
	let leadIdx = aIdx;
	for (const id of selected) {
		const i = ids.indexOf(id);
		if (i < 0) continue;
		leadIdx = delta > 0 ? Math.max(leadIdx, i) : Math.min(leadIdx, i);
	}
	const nextLead = clamp(leadIdx + delta, 0, ids.length - 1);
	const leadId = ids[nextLead]!;

	mainTrackList?.setSelectionRange(anchorId, leadId);
	persistUiState();
	mainTrackList?.scrollToIndex(nextLead);
}

function wireDownloadsChip(): void {
	// Only the topbar chip stays here. The dl-toolbar buttons (Open Folder,
	// Verify, Clear Completed, Clear All) are now props passed into the
	// DownloadsView component — see mountDownloadsView() in boot().
	const chip = document.getElementById('downloads-chip');
	if (chip) {
		chip.addEventListener('click', openDownloadsView);
	}
}

// Run verify + show a summary dialog. Backend updates each affected job to
// state='error' / 'verification_failed' so the rows reflect findings even
// before the dialog closes.
async function runVerifyDownloads(): Promise<void> {
	const btn = document.getElementById('dl-verify-btn') as HTMLButtonElement | null;
	if (btn) btn.disabled = true;
	try {
		showToast('Verifying downloads…', { kind: 'info', durationMs: 1500 });
		const res = await window.api['tidal:download:verify']();
		await refreshDownloads();
		// Header counters
		const counters = [
			`Total in queue: ${res.total}`,
			`OK: ${res.ok}`,
			res.missing         ? `Missing on disk: ${res.missing}` : null,
			res.sizeMismatch    ? `Size mismatch: ${res.sizeMismatch}` : null,
			res.corrupt         ? `Corrupt: ${res.corrupt}` : null,
			res.neverDownloaded ? `Never downloaded: ${res.neverDownloaded}` : null,
			res.inProgress      ? `In progress (skipped): ${res.inProgress}` : null,
		].filter(Boolean) as string[];
		// Per-track problems — cap the listing so very long failures don't
		// blow up the native alert. The full set is also visible in the
		// Downloads view rows.
		let body = counters.join('\n');
		if (res.problems.length) {
			const maxShown = 20;
			const shown = res.problems.slice(0, maxShown);
			const rest = res.problems.length - shown.length;
			body += `\n\nProblems:\n• ${shown.join('\n• ')}`;
			if (rest > 0) body += `\n…and ${rest} more.`;
		}
		const hasFailures = res.problems.length > 0;
		window.alert(`Verify complete\n\n${body}${hasFailures ? '\n\nRows marked as errors — use Retry / Sync with Tidal to recover.' : ''}`);
	} catch (err) {
		showToast('Verify failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
	} finally {
		if (btn) btn.disabled = false;
	}
}

// wireDownloadQueueEvents retired — data/events.ts ingests the queue
// stream into the downloads store; the chip + DownloadsView react.

function wireDownloadProgressEvents(): void {
	window.api.onDownloadProgress((p) => {
		if (p.stage === 'streaming' && typeof p.pct === 'number') {
			// Per-segment progress — debug keeps the stream DevTools-only.
			downloadLog.debug('progress', { pct: p.pct, currentSegment: p.currentSegment, totalSegments: p.totalSegments });
		}
		if (p.stage === 'done') {
			downloadLog.info('complete', { outputPath: p.outputPath, bytes: p.bytes });
		}
		if (p.stage === 'error') {
			downloadLog.error('error', p.error);
		}
	});
}

function wireSyncProgressEvents(): void {
	window.api.onSyncProgress((p) => {
		// Tidal events route to their own indicator and never touch the
		// Spotify machinery below — syncState's running/retrying flags gate
		// SyncView rows + the retry loop, and both providers can be syncing
		// at once (manual Tidal run during a Spotify auto-tick).
		if (p.source === 'tidal') {
			if (p.stage === 'starting') {
				setTidalSyncProgress({ current: null });
			} else if ((p.stage === 'playlist-tracks' || p.stage === 'playlist-skipped') && p.currentPlaylist) {
				setTidalSyncProgress({
					current: { name: p.currentPlaylist.name, index: p.currentPlaylist.index, total: p.currentPlaylist.total },
				});
				// Playlist rows land in the DB as the sync walks them — refresh
				// the sidebar's playlist join so new rows appear progressively.
				refreshPlaylistsForSyncView().catch(() => {});
			} else if (p.stage === 'done' || p.stage === 'error') {
				setTidalSyncProgress(null);
				refreshPlaylistsForSyncView().catch(() => {});
			}
			return;
		}

		// Sync runs in the BACKGROUND now — no view takeover. The source-tab
		// "breathing rectangle" + tooltip surfaces progress without yanking
		// the user out of the track list they're working in. Users who want
		// the detailed table can navigate to the Sync view manually via the
		// header SYNC button (the SyncView component is still mounted; we
		// just no longer auto-switch to it).

		// Connection-lost retry recovered — any progress event arriving while
		// we're in the retrying state is proof the server responded. Flip
		// the flag off immediately so the tooltip drops "Connection lost"
		// and the Settings button swaps Stop → Sync now without waiting for
		// the IPC promise to resolve.
		const wasRetrying = syncState.retrying();
		if (wasRetrying && p.stage !== 'error') {
			syncState.setRetrying(false);
			void renderSettingsConnections();
		}

		// Self-heal the running flag from the stream itself: a renderer
		// reload mid-sync (HMR, Ctrl+R) loses the running flag and the
		// 'starting' stage won't re-fire — but any non-terminal progress
		// event is proof a sync is in flight. Without this the breathing
		// indicator stays dark until the sync ends.
		if (p.stage !== 'done' && p.stage !== 'error') {
			syncState.setRunning(true);
		}

		if (p.stage === 'starting') {
			syncState.setRunning(true);
			syncState.setCurrentSpotify(null);
			// Fresh sync: reset every non-error row to 'pending' so the user
			// sees rows transition cleanly as the sync walks them. Retry
			// attempt: PRESERVE the prior attempt's accumulated state —
			// otherwise the breathing rectangle's tooltip would lose every
			// "synced" / "skipped" the user already saw and the sync would
			// look like it had restarted from zero.
			if (!wasRetrying) {
				syncState.patchRows((r) => {
					if (r.state !== 'error') r.state = 'pending';
				});
			}
		}

		// Key rows by playlistId when we have it so the in-place updates
		// land on the preloaded rows instead of creating duplicates.
		const rowKey = (cp: { id: string | null; name: string; index: number }) =>
			cp.id ?? `__sync_${cp.index}_${cp.name}`;

		// 'playlists-listing' has no playlist name yet — just shows we're listing
		if (p.stage === 'playlist-tracks' || p.stage === 'liked-songs') {
			if (p.currentPlaylist) {
				// mark all earlier rows as synced (skipped rows already final)
				syncState.patchRows((r) => {
					if (r.state === 'syncing') r.state = 'synced';
				});
				const key = rowKey(p.currentPlaylist);
				const existing = syncState.getRow(key);
				syncState.upsertRow(key, {
					playlistId: p.currentPlaylist.id ?? null,
					name: p.currentPlaylist.name,
					source: 'Spotify',
					mark: existing?.mark ?? null,
					state: 'syncing',
					trackCount: existing?.trackCount,
				});
				// Stash current pointer for the source-tab tooltip.
				syncState.setCurrentSpotify({
					name: p.currentPlaylist.name,
					index: p.currentPlaylist.index,
					total: p.currentPlaylist.total,
				});
			}
		}

		// On every per-playlist transition, refresh DB dates in the background
		// (best-effort) so Remote Updated / Last Synced columns stay current.
		if (p.stage === 'playlist-tracks' || p.stage === 'playlist-skipped' || p.stage === 'liked-songs') {
			refreshPlaylistsForSyncView().catch(() => {});
		}

		// Snapshot-id match → playlist unchanged; record + render in skipped state
		if (p.stage === 'playlist-skipped' && p.currentPlaylist) {
			// flush any in-flight 'syncing' row to 'synced'
			syncState.patchRows((r) => {
				if (r.state === 'syncing') r.state = 'synced';
			});
			const key = rowKey(p.currentPlaylist);
			const existing = syncState.getRow(key);
			// Don't downgrade a row that was 'synced' earlier this session —
			// matters on retry attempts. After a mid-sync failure we picked
			// up at the next attempt; playlists we already fetched will now
			// snapshot-match and report 'skipped'. Demoting them would make
			// the "Y updated playlists" tooltip count drop spuriously.
			// Also skip the "Scanning: X of Y" pointer update for these
			// rows — they're already done from the prior attempt, so the
			// counter should jump straight to the next not-yet-done
			// playlist instead of churning through done ones.
			if (existing?.state === 'synced') {
				// no-op: state stays 'synced', tooltip pointer stays put
			} else {
				syncState.upsertRow(key, {
					playlistId: p.currentPlaylist.id ?? null,
					name: p.currentPlaylist.name,
					source: 'Spotify',
					mark: existing?.mark ?? null,
					state: 'skipped',
					trackCount: existing?.trackCount,
				});
				syncState.setCurrentSpotify({
					name: p.currentPlaylist.name,
					index: p.currentPlaylist.index,
					total: p.currentPlaylist.total,
				});
			}
		}

		if (p.stage === 'enriching' && p.enrichment) {
			handleEnrichmentEvent(p.enrichment);

			// Sync overlay also keeps a synthetic row updated, in case the user
			// switches to the Sync tab during enrichment.
			const key = '__beatport__';
			syncState.upsertRow(key, {
				playlistId: null,
				name: `Beatport: ${p.enrichment.trackTitle ?? '…'}`,
				source: 'Beatport',
				mark: null,
				state: 'syncing',
				trackCount: p.enrichment.total,
				tracksDone: p.enrichment.index,
			});
			syncState.patchRows((r, k) => {
				if (k !== key && r.state === 'syncing') r.state = 'synced';
			});
		}

		if (p.stage === 'done') {
			syncState.patchRows((r) => {
				if (r.state === 'syncing') r.state = 'synced';
			});
			syncState.setRunning(false);
			syncState.setCurrentSpotify(null);
			clearEnrichment();
		}
		if (p.stage === 'error') {
			syncState.patchRows((r) => {
				if (r.state === 'syncing') r.state = 'error';
			});
			syncState.setRunning(false);
			syncState.setCurrentSpotify(null);
			clearEnrichment();
		}
		// (SyncView rows + source-tab tooltip recompute reactively.)
	});
}

boot().catch((e) => {
	log.for('boot').error('boot failed', e);
});
