// Sidebar — playlist + folder navigation (Phase 3.C). The largest
// extraction yet: subsumes renderPlaylists, renderRekordboxTreeHtml,
// wirePlaylistsDelegationOnce, onStarClick, effectiveFavorite, plus
// the section-header rendering. Sidebar-local playlist filtering was
// removed — global discovery is the omnibar's job.
//
// Render flow:
//   • The component takes a single `getSnapshot()` pull function that
//     reads every sidebar input (playlistsById, rekordboxTree,
//     currentPlaylistId, currentFolderId, enriching, rekordboxExpanded).
//     Each of those reads is itself reactive — shell
//     signals, library tick getters, and the enriching / rekordboxExpanded
//     signals — so calling getSnapshot() inside a createMemo makes the memo
//     recompute whenever any input changes. No manual revision tick.
//
// Internal state owned by the component (local, not in main.ts):
//   • pendingFavorites — optimistic visual state for star clicks. 1-sec
//     debounce; cancelling click within window is a no-op. After the
//     timer fires we call props.onFavoriteCommit which persists via the
//     backend and updates main.ts's state.
//
// FLIP animation on favorite reorder is omitted in this initial port —
// star clicks now reorder immediately. Polish if/when needed.

import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import type { Playlist, PlaylistFolder, PinnedSearch, ArtistSummary } from '@curator/shared';
import { hasTrackDragPayload, readTrackDragPayload } from '../dnd.js';
import type { SourceTab } from '../viewmodel/shell.js';

// Synthetic nav-row id for the Rekordbox "All tracks" pseudo-row. Not a real
// playlist/folder — selecting it clears both scopes so renderTracks() falls
// back to the source-level (every rekordbox track) view.
export const RB_ALL_ID = '__rb-all__';

// Synthetic nav-row id for the "Pinned" folder header. Like RB_ALL_ID it's not
// a real entity — clicking its caret toggles the folder; its children are the
// saved pinned searches.
export const PINNED_FOLDER_ID = '__pinned-folder__';

// Synthetic nav-row id for the "Artists" folder header — the library's artist
// entities, source-independent, so it leads every tab. Children are the
// artist rows main.ts fetched (top-N by track count, or a filter's matches).
export const ARTISTS_FOLDER_ID = '__artists-folder__';

const STAR_SVG = (): JSX.Element => (
	<svg class="pl-star__icon" width="11" height="11" viewBox="0 0 24 24" stroke-linejoin="round">
		<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/>
	</svg>
);

// Small pushpin glyph for pinned-search rows (matches the filter-bar pin).
const PIN_SVG = (): JSX.Element => (
	<svg class="pl-pin__icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
		<path d="M9 4v6l-2 3h10l-2-3V4"/>
		<path d="M8 4h8"/>
		<path d="M12 16v5"/>
	</svg>
);

export interface SidebarSnapshot {
	activeSource: SourceTab;
	playlists: Playlist[];                 // ALL playlists (any source)
	rekordboxTree: { folders: PlaylistFolder[]; playlists: Playlist[] };
	currentPlaylistId: string | null;
	currentFolderId: string | null;
	enriching: { playlistId: string; source: 'beatport' | 'tidal' | 'wav' } | null;
	rekordboxExpanded: ReadonlySet<string>;
	// True while the lazy rekordbox tree fetch is in flight — show "Loading…"
	// instead of the "not imported" hint, since an empty tree is ambiguous until
	// the fetch resolves.
	rekordboxLoading: boolean;
	// Saved pinned searches (the "Pinned" folder under "All tracks"). Each is a
	// named, re-runnable query — selecting one loads it as a JIT scope.
	pinnedSearches: PinnedSearch[];
	// The active pinned search's id (the loaded JIT's pinnedId), or null.
	currentPinnedId: string | null;
	// Expand/collapse state of the Pinned folder.
	pinnedExpanded: boolean;
	// Artists folder: the rows to show (already narrowed by `artistsSearch`
	// on the core side), its expansion, the filter text, and the artist id
	// of the loaded "Artist: X" JIT scope (row highlight).
	artists: ArtistSummary[];
	artistsExpanded: boolean;
	artistsSearch: string;
	artistsLoading: boolean;
	currentArtistId: string | null;
	// Connected streaming account ids — gate which streaming playlists accept
	// a track drop (only playlists the user owns can push adds upstream; same
	// rule as the Organize modal's ownedByMe). Null when disconnected.
	spotifyMeId: string | null;
	tidalMeId: string | null;
}

/// Returned by `enterSelection()` so callers (the controller layer) can
/// decide whether to keep focus in the sidebar (folder toggle) or hand
/// it back to the tracklist (playlist activated). 'noop' means there
/// was no cursor or no eligible action.
export type SidebarEnterResult = 'expanded' | 'collapsed' | 'activated' | 'noop';

export interface SidebarNavHandle {
	/// Move the keyboard/controller cursor by `delta` rows (typically ±1).
	/// If no cursor is set yet, seeds to the first visible row. Scrolls
	/// the new cursor row into view.
	stepSelection: (delta: number) => void;
	/// Activate / toggle the row under the cursor. For an rb-folder this
	/// expands or collapses; for any playlist or library folder this
	/// fires the corresponding activate callback (same path as a mouse
	/// click on the row). No-op when no cursor is set.
	enterSelection: () => SidebarEnterResult;
	/// Activate the row under the cursor — always loads (never toggles).
	/// For an rb-folder, this fires onRekordboxFolderActivate (aggregate
	/// view). The keyboard "step-and-update-tracklist" path uses this so
	/// arrow-stepping over a folder doesn't expand/collapse it.
	activateCursor: () => SidebarEnterResult;
	/// Expand (true) or collapse (false) the cursored rb-folder. No-op
	/// when the cursor isn't on an rb-folder, or when the folder is
	/// already in the target state. Returns true if it changed.
	setExpand: (expand: boolean) => boolean;
	/// Seed the cursor if it's null — lands on the currently-active
	/// playlist/folder row if visible, otherwise the first row. No-op
	/// when the cursor is already set.
	ensureCursor: () => void;
	/// Clear the cursor — used when focus leaves the sidebar so the
	/// visual cursor disappears.
	clearCursor: () => void;
}

export interface SidebarProps {
	getSnapshot: () => SidebarSnapshot;
	/// Receives the nav handle once the component mounts. Same pattern
	/// as MainWaveformView's `setSnapTo` — captures the imperative API
	/// out of the Solid component without leaking internals.
	setNavHandle?: (handle: SidebarNavHandle) => void;
	// Playlist row click (spotify/tidal, or a Curator-local playlist on the
	// Rekordbox tab). isLazySync = the row had status='pending'/'error';
	// main.ts kicks a single-playlist sync.
	onPlaylistActivate: (playlistId: string, isLazySync: boolean) => void;
	// Rekordbox folder body click (activates the aggregate-of-descendants
	// view). Caret click is separate — see onRekordboxFolderCaretToggle.
	onRekordboxFolderActivate: (folderId: string) => void;
	// Rekordbox folder caret click — toggles expansion. main.ts reassigns
	// the rekordboxExpanded signal, whose change repaints the sidebar.
	onRekordboxFolderCaretToggle: (folderId: string) => void;
	// Right-click on a rb-folder row. v1 surface is just "Sync to
	// Rekordbox…" (the folder-scoped peer of the rb-playlist menu).
	onRekordboxFolderContextMenu: (evt: MouseEvent, folderId: string) => void;
	// Rekordbox "All tracks" pseudo-row click — clears playlist/folder scope
	// so the tracklist shows every track in the Rekordbox source.
	onRekordboxAllTracksActivate: () => void;
	// Rekordbox playlist (non-smart) row click. Same as a normal playlist
	// activation but main.ts knows the source type via the playlist row.
	onRekordboxPlaylistActivate: (playlistId: string) => void;
	// Smart rekordbox playlist click — shows the "coming soon" watermark.
	onSmartPlaylistActivate: (playlistId: string, name: string) => void;
	// Right-click on a playlist row (spotify/tidal/rb-playlist).
	onPlaylistContextMenu: (evt: MouseEvent, playlistId: string) => void;
	// Pinned-search row click — loads the saved query as a JIT scope.
	onPinnedActivate: (id: string) => void;
	// Pinned folder caret click — toggles the folder's expansion.
	onPinnedCaretToggle: () => void;
	// Right-click on a pinned-search row — "Create Playlist…" / "Unpin".
	onPinnedContextMenu: (evt: MouseEvent, id: string) => void;
	// Artists folder: row click → "Artist: X" scope; caret toggles; the
	// filter box re-queries; right-click → Rename… / Merge into….
	onArtistActivate: (id: string, name: string) => void;
	onArtistsCaretToggle: () => void;
	onArtistsSearch: (q: string) => void;
	onArtistContextMenu: (evt: MouseEvent, id: string) => void;
	// Right-click on the Artists folder header — "Suggested merges…".
	onArtistsFolderContextMenu: (evt: MouseEvent) => void;
	// Favorite commit — called after the 1-sec debounce. main.ts patches
	// the row through the reactive library layer, whose tick repaints the
	// sidebar. Failure path: main.ts reverts the same way; the component
	// clears the local pending entry on the next render.
	onFavoriteCommit: (playlistId: string, value: boolean) => void;
	// Track rows dropped on a playlist row. main.ts routes this through the
	// same add path the Organize modal uses (membership diff → bulk add IPC).
	onTracksDropped: (playlistId: string, trackIds: string[]) => void;
}

export interface SidebarHandle {
	destroy(): void;
	/// Controller / keyboard nav — see SidebarNavHandle. Methods are
	/// no-ops if the nav handle hasn't bound yet (very early in mount).
	stepSelection(delta: number): void;
	enterSelection(): SidebarEnterResult;
	activateCursor(): SidebarEnterResult;
	setExpand(expand: boolean): boolean;
	ensureCursor(): void;
	clearCursor(): void;
}

const escapeHtml = (s: string): string =>
	s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// Source-color for the enrichment "working" pulse ring on playlist rows.
function sourceColor(src: 'beatport' | 'tidal' | 'wav'): string {
	return src === 'beatport' ? 'oklch(0.82 0.18 60)' : src === 'wav' ? 'oklch(0.80 0.12 230)' : 'var(--fg)';
}

// Flat-row entry for controller / keyboard navigation. The order matches
// the visible render order — sidebar's stepSelection walks this list.
interface NavRow {
	id: string;
	kind: 'playlist' | 'rb-folder' | 'rb-playlist' | 'rb-smart' | 'rb-all' | 'pinned-folder' | 'pinned' | 'artists-folder' | 'artist';
	// For rb-folder rows — current expand state at memo time (used by
	// enterSelection to know which side to toggle to).
	expanded?: boolean;
}

export function Sidebar(props: SidebarProps) {
	// Optimistic favorite state. Key = playlist/folder id, value = the
	// target favorite state that will be committed when the timer fires.
	// Sub-second re-click within the window cancels (clears the entry).
	const [pendingFavorites, setPendingFavorites] = createSignal<Map<string, { target: boolean; timer: number }>>(new Map());
	// Controller / keyboard cursor — id of the currently-highlighted
	// nav row. Null = no cursor (cleared on focus leaving the pane).
	const [cursorId, setCursorId] = createSignal<string | null>(null);

	function effectiveFavorite(id: string, persisted: boolean): boolean {
		const pending = pendingFavorites().get(id);
		return pending ? pending.target : persisted;
	}

	function handleStarClick(evt: MouseEvent, id: string, persisted: boolean): void {
		evt.stopPropagation();
		const existing = pendingFavorites().get(id);
		const currentVisual = existing ? existing.target : persisted;
		const target = !currentVisual;

		// Visual flip is automatic — the next read of effectiveFavorite()
		// inside the reactive render picks up the new pending entry.
		const next = new Map(pendingFavorites());
		if (existing) {
			clearTimeout(existing.timer);
			next.delete(id);
		}
		setPendingFavorites(next);

		// If the new target matches persisted, we're CANCELLING — nothing to
		// schedule. (The clearTimeout + delete above already covered it.)
		if (target === persisted) return;

		const timer = window.setTimeout(() => {
			const cur = pendingFavorites();
			const entry = cur.get(id);
			if (!entry) return;
			const cleared = new Map(cur);
			cleared.delete(id);
			setPendingFavorites(cleared);
			props.onFavoriteCommit(id, entry.target);
		}, 1000);

		const withNew = new Map(next);
		withNew.set(id, { target, timer });
		setPendingFavorites(withNew);
	}

	// Clear any in-flight favorite timers on destroy.
	onCleanup(() => {
		for (const entry of pendingFavorites().values()) clearTimeout(entry.timer);
	});

	// Snapshot memo — getSnapshot()'s reads are all reactive (shell signals,
	// library tick getters, the enriching / rekordboxExpanded signals), so
	// this recomputes whenever any sidebar input changes.
	const snap = createMemo(() => {
		return props.getSnapshot();
	});

	// ─── Track drop targets ────────────────────────────────────────────
	// Playlist rows accept dragged track rows (payload gated by the custom
	// MIME type — see dnd.ts). Write-eligibility mirrors the Organize
	// modal: local + rekordbox always (non-smart), streaming only when the
	// connected account owns the playlist. Ineligible rows never
	// preventDefault, so the cursor shows the native no-drop affordance.
	const [dropHoverId, setDropHoverId] = createSignal<string | null>(null);
	const canDropOn = (p: Playlist): boolean => {
		if (p.isSmart) return false;
		if (p.source === 'spotify') return !!snap().spotifyMeId && p.ownerId === snap().spotifyMeId;
		if (p.source === 'tidal') return !!snap().tidalMeId && p.ownerId === snap().tidalMeId;
		return true;
	};
	const onRowDragOver = (evt: DragEvent, p: Playlist): void => {
		if (!canDropOn(p) || !hasTrackDragPayload(evt.dataTransfer)) return;
		evt.preventDefault();
		if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'copy';
		setDropHoverId(p.id);
	};
	const onRowDragLeave = (evt: DragEvent): void => {
		// dragleave also fires when crossing into the row's own children —
		// only clear when the cursor genuinely left the row.
		const related = evt.relatedTarget as Node | null;
		if (related && (evt.currentTarget as HTMLElement).contains(related)) return;
		setDropHoverId(null);
	};
	const onRowDrop = (evt: DragEvent, p: Playlist): void => {
		setDropHoverId(null);
		if (!canDropOn(p)) return;
		const ids = readTrackDragPayload(evt.dataTransfer);
		if (!ids || ids.length === 0) return;
		evt.preventDefault();
		props.onTracksDropped(p.id, ids);
	};

	// Sorted views derived from the snapshot. Star-favorited rows float
	// to the top; everything else keeps the upstream order.
	const sortedPlaylists = createMemo(() => {
		const s = snap();
		return s.playlists
			.filter((p) => p.source === s.activeSource)
			.slice()
			.sort((a, b) => Number(effectiveFavorite(b.id, b.isFavorite)) - Number(effectiveFavorite(a.id, a.isFavorite)));
	});
	// Curator-local playlists — pinned-search snapshots, Convert-to-WAV "[WAV]"
	// playlists awaiting their rekordbox sync, Organize creates. They have no
	// rekordbox identity (yet), so the Rekordbox tab lists them in their own
	// "Curator" section after the tree.
	const curatorPlaylists = createMemo(() => {
		const s = snap();
		return s.playlists
			.filter((p) => p.source === 'local')
			.slice()
			.sort((a, b) => Number(effectiveFavorite(b.id, b.isFavorite)) - Number(effectiveFavorite(a.id, a.isFavorite)));
	});

	const navLabel = (): string => 'Playlists';
	const navCount = (): string => {
		const s = snap();
		if (s.activeSource === 'rekordbox') return String(s.rekordboxTree.playlists.length + curatorPlaylists().length);
		return String(sortedPlaylists().length);
	};

	// Aggregate track count for an rb folder (recursive sum of descendant
	// playlists). Computed per-render off the snapshot — small trees so the
	// repeat cost is irrelevant.
	const aggregateForFolder = (folderId: string, foldersByParent: Map<string | null, PlaylistFolder[]>, playlistsByParent: Map<string | null, Playlist[]>, cache: Map<string, number>): number => {
		const cached = cache.get(folderId);
		if (cached !== undefined) return cached;
		let total = 0;
		for (const p of playlistsByParent.get(folderId) ?? []) total += p.trackCount ?? 0;
		for (const f of foldersByParent.get(folderId) ?? []) total += aggregateForFolder(f.id, foldersByParent, playlistsByParent, cache);
		cache.set(folderId, total);
		return total;
	};

	// Walk the rb tree in render order, appending nav rows. Folders come
	// first (matching RekordboxNode's <For> ordering), then playlists at
	// each level. Recurses into expanded folders only — collapsed
	// folders' descendants are not navigable until expanded.
	const pushRbSubtree = (
		out: NavRow[],
		parentId: string | null,
		idx: { foldersByParent: Map<string | null, PlaylistFolder[]>; playlistsByParent: Map<string | null, Playlist[]> },
		expanded: ReadonlySet<string>,
	): void => {
		for (const f of idx.foldersByParent.get(parentId) ?? []) {
			const isExpanded = expanded.has(f.id);
			out.push({ id: f.id, kind: 'rb-folder', expanded: isExpanded });
			if (isExpanded) {
				pushRbSubtree(out, f.id, idx, expanded);
			}
		}
		for (const p of idx.playlistsByParent.get(parentId) ?? []) {
			out.push({ id: p.id, kind: p.isSmart ? 'rb-smart' : 'rb-playlist' });
		}
	};

	// Rekordbox tree indexing — orphan-rescue + recursive render.
	const rbIndex = createMemo(() => {
		const s = snap();
		const { folders, playlists } = s.rekordboxTree;
		const folderIds = new Set(folders.map((f) => f.id));
		const foldersByParent = new Map<string | null, PlaylistFolder[]>();
		for (const f of folders) {
			let p = f.parentFolderId ?? null;
			if (p !== null && !folderIds.has(p)) p = null;
			if (!foldersByParent.has(p)) foldersByParent.set(p, []);
			foldersByParent.get(p)!.push(f);
		}
		const playlistsByParent = new Map<string | null, Playlist[]>();
		for (const p of playlists) {
			let par = p.parentFolderId ?? null;
			if (par !== null && !folderIds.has(par)) par = null;
			if (!playlistsByParent.has(par)) playlistsByParent.set(par, []);
			playlistsByParent.get(par)!.push(p);
		}
		const aggCache = new Map<string, number>();
		return { foldersByParent, playlistsByParent, aggCache, totalFolders: folders.length, totalPlaylists: playlists.length };
	});

	// Flat list of navigable rows in render order. Driven from the same
	// snapshot + sorting + tree traversal the JSX uses, so the cursor
	// always points to a row that's actually painted. Re-computed on
	// every snapshot/expansion/source change; cheap relative to the
	// render itself.
	const navRows = createMemo<NavRow[]>(() => {
		const s = snap();
		const rows: NavRow[] = [];
		// Artists folder leads every tab; children only when expanded.
		rows.push({ id: ARTISTS_FOLDER_ID, kind: 'artists-folder', expanded: s.artistsExpanded });
		if (s.artistsExpanded) {
			for (const a of s.artists) rows.push({ id: a.id, kind: 'artist' });
		}
		if (s.activeSource === 'rekordbox') {
			// "All tracks" leads the rekordbox tab — only when a library exists.
			if (rbIndex().totalFolders + rbIndex().totalPlaylists > 0) {
				rows.push({ id: RB_ALL_ID, kind: 'rb-all' });
			}
			// Pinned searches sit directly under "All tracks". The folder header
			// is navigable even when collapsed; children only when expanded.
			if (s.pinnedSearches.length > 0) {
				rows.push({ id: PINNED_FOLDER_ID, kind: 'pinned-folder', expanded: s.pinnedExpanded });
				if (s.pinnedExpanded) {
					for (const p of s.pinnedSearches) rows.push({ id: p.id, kind: 'pinned' });
				}
			}
			pushRbSubtree(rows, null, rbIndex(), s.rekordboxExpanded);
			// The Curator section follows the tree (matches paint order).
			for (const p of curatorPlaylists()) {
				rows.push({ id: p.id, kind: 'playlist' });
			}
		} else {
			for (const p of sortedPlaylists()) {
				rows.push({ id: p.id, kind: 'playlist' });
			}
		}
		return rows;
	});

	// Reactivity note: every per-row predicate (expanded / active /
	// starred / aggCount) is an accessor, NOT a captured value. Solid
	// component bodies and <For> callbacks run once; captured locals
	// would freeze the first snapshot and a caret click (which reassigns
	// the rekordboxExpanded signal) would never repaint. The accessors are
	// re-read inside JSX expressions where Solid tracks them.
	const RekordboxNode = (nodeProps: { parentId: string | null; depth: number }): JSX.Element => {
		const subFolders = () => rbIndex().foldersByParent.get(nodeProps.parentId) ?? [];
		const subPlaylists = () => rbIndex().playlistsByParent.get(nodeProps.parentId) ?? [];
		return (
			<>
				<For each={subFolders()}>
					{(f) => {
						const expanded = () => snap().rekordboxExpanded.has(f.id);
						const active = () => snap().currentFolderId === f.id;
						const aggCount = () => {
							const idx = rbIndex();
							return aggregateForFolder(f.id, idx.foldersByParent, idx.playlistsByParent, idx.aggCache);
						};
						return (
							<>
								<button
									class="playlist playlist--rb-folder"
									classList={{ active: active(), cursor: isCursor(f.id) }}
									data-kind="rb-folder"
									data-rb-folder-id={f.id}
									data-nav-id={f.id}
									style={{ '--pl-depth': nodeProps.depth }}
									onClick={(e) => {
										const isCaret = !!(e.target as HTMLElement).closest('[data-act="caret"]');
										if (isCaret) {
											props.onRekordboxFolderCaretToggle(f.id);
										} else {
											props.onRekordboxFolderActivate(f.id);
										}
									}}
									onContextMenu={(e) => {
										e.preventDefault();
										props.onRekordboxFolderContextMenu(e, f.id);
									}}
								>
									<span class="pl-caret" classList={{ collapsed: !expanded() }} data-act="caret">
										{expanded() ? '▾' : '▸'}
									</span>
									<span class="pl-name">{f.name}</span>
									<span class="pl-count">{aggCount().toLocaleString()}</span>
								</button>
								<Show when={expanded()}>
									<RekordboxNode parentId={f.id} depth={nodeProps.depth + 1} />
								</Show>
							</>
						);
					}}
				</For>
				<For each={subPlaylists()}>
					{(p) => {
						const active = () => snap().currentPlaylistId === p.id;
						const starred = () => effectiveFavorite(p.id, p.isFavorite);
						const smart = p.isSmart === true;
						const countText = smart ? '·' : (p.trackCount ?? 0).toLocaleString();
						return (
							<button
								class="playlist playlist--rb-playlist"
								classList={{ active: active(), 'is-starred': starred(), 'is-smart': smart, cursor: isCursor(p.id), 'drop-hover': dropHoverId() === p.id }}
								data-id={p.id}
								data-kind="rb-playlist"
								data-rb-smart={smart ? '1' : undefined}
								data-nav-id={p.id}
								style={{ '--pl-depth': nodeProps.depth }}
								title={smart ? `${p.name} (smart playlist — coming soon)` : p.name}
								onDragOver={(e) => onRowDragOver(e, p)}
								onDragLeave={onRowDragLeave}
								onDrop={(e) => onRowDrop(e, p)}
								onClick={() => {
									if (smart) props.onSmartPlaylistActivate(p.id, p.name);
									else props.onRekordboxPlaylistActivate(p.id);
								}}
								onContextMenu={(e) => {
									// rb-playlist context menu: routes through the same
									// onPlaylistContextMenu callback as streaming playlists.
									// main.ts's showPlaylistContextMenu gates Spotify-only
									// items (sync from Spotify, hybrid Tidal) on source, so
									// rb playlists only get items applicable to them — in
									// v1 that's the Sync to Rekordbox… entry.
									e.preventDefault();
									if (smart) return; // smart playlists have no membership to push
									props.onPlaylistContextMenu(e, p.id);
								}}
							>
								<span
									class="pl-star"
									classList={{ starred: starred() }}
									data-act="star"
									aria-label="Star playlist"
									onClick={(e) => handleStarClick(e, p.id, p.isFavorite)}
								>{STAR_SVG()}</span>
								<span class="pl-name">{p.name}</span>
								<span class="pl-count">{countText}</span>
							</button>
						);
					}}
				</For>
			</>
		);
	};

	// ─── Controller / keyboard nav handle ─────────────────────────────
	// Exposed via the setNavHandle prop callback so mountSidebar can
	// surface stepSelection / enterSelection on SidebarHandle. Pure
	// imperative — no JSX side; the visual cursor is a classList
	// binding below.
	const findRowIndex = (id: string | null): number =>
		id == null ? -1 : navRows().findIndex((r) => r.id === id);

	const scrollCursorIntoView = (id: string): void => {
		// Defer one rAF so the new classList has painted before the
		// scroll math runs. Cheap: rAF is plenty fast here.
		requestAnimationFrame(() => {
			const root = document.querySelector('.sidebar .playlists');
			if (!root) return;
			const el = root.querySelector<HTMLElement>(`[data-nav-id="${CSS.escape(id)}"]`);
			el?.scrollIntoView({ block: 'nearest' });
		});
	};

	if (props.setNavHandle) {
		props.setNavHandle({
			stepSelection: (delta: number) => {
				const rows = navRows();
				if (rows.length === 0) return;
				let next: number;
				const cur = findRowIndex(cursorId());
				if (cur < 0) {
					// No cursor yet — land on the first or last row
					// depending on the step direction so the first
					// scroll-up wrap feels natural.
					next = delta >= 0 ? 0 : rows.length - 1;
				} else {
					next = Math.max(0, Math.min(rows.length - 1, cur + (delta >= 0 ? 1 : -1)));
				}
				const id = rows[next]!.id;
				setCursorId(id);
				scrollCursorIntoView(id);
			},
			enterSelection: (): SidebarEnterResult => {
				const id = cursorId();
				if (id == null) return 'noop';
				const row = navRows().find((r) => r.id === id);
				if (!row) return 'noop';
				switch (row.kind) {
					case 'rb-all':
						props.onRekordboxAllTracksActivate();
						return 'activated';
					case 'rb-folder':
						props.onRekordboxFolderCaretToggle(id);
						// rb tree expand state is held in the snapshot;
						// re-read via navRows for the new state.
						return row.expanded ? 'collapsed' : 'expanded';
					case 'rb-playlist':
						props.onRekordboxPlaylistActivate(id);
						return 'activated';
					case 'rb-smart': {
						// Smart playlists watermark a toast in main.ts.
						// We don't have the name here without an extra
						// snapshot lookup — pass the id and let the
						// handler resolve.
						const smart = snap().rekordboxTree.playlists.find((p) => p.id === id);
						props.onSmartPlaylistActivate(id, smart?.name ?? '');
						return 'activated';
					}
					case 'playlist': {
						const p = snap().playlists.find((pp) => pp.id === id);
						const lazy = p ? (p.syncStatus === 'pending' || p.syncStatus === 'error') : false;
						props.onPlaylistActivate(id, lazy);
						return 'activated';
					}
					case 'pinned-folder':
						props.onPinnedCaretToggle();
						return row.expanded ? 'collapsed' : 'expanded';
					case 'artists-folder':
						props.onArtistsCaretToggle();
						return row.expanded ? 'collapsed' : 'expanded';
					case 'artist': {
						const a = snap().artists.find((x) => x.id === id);
						props.onArtistActivate(id, a?.name ?? '');
						return 'activated';
					}
					case 'pinned':
						props.onPinnedActivate(id);
						return 'activated';
				}
			},
			// Keyboard "step-and-update-tracklist" path. Same as
			// enterSelection but for rb-folder rows it loads the
			// aggregate view instead of toggling expansion — that
			// way ArrowDown stepping doesn't collapse the tree under
			// you.
			activateCursor: (): SidebarEnterResult => {
				const id = cursorId();
				if (id == null) return 'noop';
				const row = navRows().find((r) => r.id === id);
				if (!row) return 'noop';
				switch (row.kind) {
					case 'rb-all':
						props.onRekordboxAllTracksActivate();
						return 'activated';
					case 'rb-folder':
						props.onRekordboxFolderActivate(id);
						return 'activated';
					case 'rb-playlist':
						props.onRekordboxPlaylistActivate(id);
						return 'activated';
					case 'rb-smart': {
						const smart = snap().rekordboxTree.playlists.find((p) => p.id === id);
						props.onSmartPlaylistActivate(id, smart?.name ?? '');
						return 'activated';
					}
					case 'playlist': {
						const p = snap().playlists.find((pp) => pp.id === id);
						const lazy = p ? (p.syncStatus === 'pending' || p.syncStatus === 'error') : false;
						props.onPlaylistActivate(id, lazy);
						return 'activated';
					}
					case 'pinned-folder':
						// No tracklist behind a folder header — toggle it instead
						// so the "load" key still does something sensible.
						props.onPinnedCaretToggle();
						return row.expanded ? 'collapsed' : 'expanded';
					case 'artists-folder':
						props.onArtistsCaretToggle();
						return row.expanded ? 'collapsed' : 'expanded';
					case 'artist': {
						const a = snap().artists.find((x) => x.id === id);
						props.onArtistActivate(id, a?.name ?? '');
						return 'activated';
					}
					case 'pinned':
						props.onPinnedActivate(id);
						return 'activated';
				}
			},
			setExpand: (expand: boolean): boolean => {
				const id = cursorId();
				if (id == null) return false;
				const row = navRows().find((r) => r.id === id);
				if (!row || row.kind !== 'rb-folder') return false;
				if (expand === !!row.expanded) return false;
				props.onRekordboxFolderCaretToggle(id);
				return true;
			},
			ensureCursor: () => {
				if (cursorId() !== null) return;
				const rows = navRows();
				if (rows.length === 0) return;
				// Prefer the currently-active playlist/folder row if
				// it's visible — feels right when the user Tabs into
				// the tree after loading something via the omnibar.
				const s = snap();
				const activeId = s.currentPlaylistId ?? s.currentFolderId;
				const idx = activeId ? rows.findIndex((r) => r.id === activeId) : -1;
				const id = rows[idx >= 0 ? idx : 0]!.id;
				setCursorId(id);
				scrollCursorIntoView(id);
			},
			clearCursor: () => setCursorId(null),
		});
	}

	// If the cursor points to a row that's no longer visible (snapshot
	// changed, folder collapsed under it, source switched), drop it so
	// the next stepSelection re-seeds at the top. Cheap reactive sync.
	createMemo(() => {
		const id = cursorId();
		if (id == null) return;
		if (!navRows().some((r) => r.id === id)) {
			setCursorId(null);
		}
	});

	const isCursor = (id: string): boolean => cursorId() === id;

	// Renders into <aside class="sidebar" id="sidebar-host"> (defined in
	// AppShell.tsx). Returning a Fragment keeps the host as the direct
	// grid child of .app so grid-area + flex column + overflow:hidden
	// apply correctly and .playlists can scroll.
	return (
		<>
			<div class="nav-section">
				<div class="nav-label"><span>{navLabel()}</span><span class="count">{navCount()}</span></div>
			</div>

			<div class="playlists">
				{/* Artists — the library's artist entities (source-independent,
				    so it leads every tab). Header toggles; expanded shows a
				    filter box + rows (top by track count, or the filter's
				    matches — narrowed on the core side, never 17k rows here).
				    Click → "Artist: X" scope; right-click → rename / merge. */}
				<button
					class="playlist playlist--artists-folder"
					classList={{ cursor: isCursor(ARTISTS_FOLDER_ID) }}
					data-kind="artists-folder"
					data-nav-id={ARTISTS_FOLDER_ID}
					style={{ '--pl-depth': 0 }}
					onClick={() => props.onArtistsCaretToggle()}
					onContextMenu={(e) => { e.preventDefault(); props.onArtistsFolderContextMenu(e); }}
				>
					<span class="pl-caret" classList={{ collapsed: !snap().artistsExpanded }} data-act="caret">
						{snap().artistsExpanded ? '▾' : '▸'}
					</span>
					<span class="pl-name">Artists</span>
					<span class="pl-count" title="Counts are this tab's tracks">{snap().activeSource === 'rekordbox' ? 'Rekordbox' : snap().activeSource === 'tidal' ? 'Tidal' : 'Spotify'}</span>
				</button>
				<Show when={snap().artistsExpanded}>
					<input
						class="pl-filter"
						type="search"
						placeholder="Filter artists…"
						value={snap().artistsSearch}
						onInput={(e) => props.onArtistsSearch(e.currentTarget.value)}
						onKeyDown={(e) => e.stopPropagation()}
					/>
					<Show when={snap().artists.length === 0 && !snap().artistsLoading}>
						<div class="pl-empty-hint">{snap().artistsSearch ? 'No artists match.' : 'No artists yet.'}</div>
					</Show>
					<For each={snap().artists}>
						{(a) => (
							<button
								class="playlist playlist--artist"
								classList={{ active: snap().currentArtistId === a.id, cursor: isCursor(a.id) }}
								data-id={a.id}
								data-kind="artist"
								data-nav-id={a.id}
								style={{ '--pl-depth': 1 }}
								title={a.name}
								onClick={() => props.onArtistActivate(a.id, a.name)}
								onContextMenu={(e) => {
									e.preventDefault();
									props.onArtistContextMenu(e, a.id);
								}}
							>
								<span class="pl-pin"></span>
								<span class="pl-name">{a.name}</span>
								<span class="pl-count">{a.trackCount.toLocaleString()}</span>
							</button>
						)}
					</For>
					<div class="pl-section-divider"></div>
				</Show>
				<Show when={snap().activeSource === 'rekordbox'}>
					<Show
						when={rbIndex().totalFolders + rbIndex().totalPlaylists > 0}
						fallback={
							<Show
								when={snap().rekordboxLoading}
								fallback={
									<div class="pl-empty-hint">
										No Rekordbox library imported yet.<br/>
										Open Settings → Rekordbox to read your library.
									</div>
								}
							>
								<div class="pl-empty-hint">Loading…</div>
							</Show>
						}
					>
						{(() => {
							const active = () => snap().currentPlaylistId === null && snap().currentFolderId === null;
							return (
								<button
									class="playlist playlist--rb-all"
									classList={{ active: active(), cursor: isCursor(RB_ALL_ID) }}
									data-kind="rb-all"
									data-nav-id={RB_ALL_ID}
									style={{ '--pl-depth': 0 }}
									onClick={() => props.onRekordboxAllTracksActivate()}
								>
									<span class="pl-name">All tracks</span>
									<span class="pl-count"></span>
								</button>
							);
						})()}
						{/* Pinned searches — saved omnibar/drill queries, under "All
						    tracks". The folder header toggles expansion (no aggregate
						    view behind it); each child re-runs its query as a JIT scope. */}
						<Show when={snap().pinnedSearches.length > 0}>
							{(() => {
								const expanded = () => snap().pinnedExpanded;
								return (
									<>
										<button
											class="playlist playlist--pinned-folder"
											classList={{ cursor: isCursor(PINNED_FOLDER_ID) }}
											data-kind="pinned-folder"
											data-nav-id={PINNED_FOLDER_ID}
											style={{ '--pl-depth': 0 }}
											onClick={() => props.onPinnedCaretToggle()}
										>
											<span class="pl-caret" classList={{ collapsed: !expanded() }} data-act="caret">
												{expanded() ? '▾' : '▸'}
											</span>
											<span class="pl-name">Pinned</span>
											<span class="pl-count">{snap().pinnedSearches.length.toLocaleString()}</span>
										</button>
										<Show when={expanded()}>
											<For each={snap().pinnedSearches}>
												{(p) => {
													const active = () => snap().currentPinnedId === p.id;
													return (
														<button
															class="playlist playlist--pinned"
															classList={{ active: active(), cursor: isCursor(p.id) }}
															data-id={p.id}
															data-kind="pinned"
															data-nav-id={p.id}
															style={{ '--pl-depth': 1 }}
															title={p.name}
															onClick={() => props.onPinnedActivate(p.id)}
															onContextMenu={(e) => {
																e.preventDefault();
																props.onPinnedContextMenu(e, p.id);
															}}
														>
															<span class="pl-pin">{PIN_SVG()}</span>
															<span class="pl-name">{p.name}</span>
															<span class="pl-count"></span>
														</button>
													);
												}}
											</For>
										</Show>
									</>
								);
							})()}
						</Show>
						<RekordboxNode parentId={null} depth={0} />
					</Show>
					{/* Curator-local playlists — pinned-search snapshots, Convert-to-WAV
					    "[WAV]" playlists awaiting their rekordbox sync, Organize creates.
					    No rekordbox identity (yet), so they sit after the tree in their own
					    section; hidden when there are none. Shown whether or not a
					    rekordbox library has been read. */}
					<Show when={curatorPlaylists().length > 0}>
						<div class="pl-section-divider"></div>
						<div class="pl-section-label">Curator · {curatorPlaylists().length}</div>
						<For each={curatorPlaylists()}>
							{(p) => {
								const active = () => snap().currentPlaylistId === p.id;
								return (
									<button
										class="playlist playlist--local"
										classList={{ active: active(), cursor: isCursor(p.id), 'drop-hover': dropHoverId() === p.id }}
										data-id={p.id}
										data-kind="playlist"
										data-nav-id={p.id}
										title={p.name}
										onDragOver={(e) => onRowDragOver(e, p)}
										onDragLeave={onRowDragLeave}
										onDrop={(e) => onRowDrop(e, p)}
										onClick={() => props.onPlaylistActivate(p.id, false)}
										onContextMenu={(e) => {
											e.preventDefault();
											props.onPlaylistContextMenu(e, p.id);
										}}
									>
										<span class="pl-name">{p.name}</span>
										<span class="pl-count">{(p.trackCount ?? 0).toLocaleString()}</span>
									</button>
								);
							}}
						</For>
					</Show>
				</Show>

				<Show when={snap().activeSource === 'spotify' || snap().activeSource === 'tidal'}>
					<For each={sortedPlaylists()}>
						{(p) => {
							const working = snap().enriching?.playlistId === p.id;
							const starred = effectiveFavorite(p.id, p.isFavorite);
							const active = snap().currentPlaylistId === p.id;
							return (
								<button
									class="playlist"
									classList={{ active, 'is-starred': starred, cursor: isCursor(p.id), 'drop-hover': dropHoverId() === p.id }}
									data-id={p.id}
									data-kind="playlist"
									data-nav-id={p.id}
									data-status={p.syncStatus}
									data-working={working ? '1' : undefined}
									style={working ? { '--src-color': sourceColor(snap().enriching!.source) } : undefined}
									onDragOver={(e) => onRowDragOver(e, p)}
									onDragLeave={onRowDragLeave}
									onDrop={(e) => onRowDrop(e, p)}
									onClick={() => {
										const lazy = p.syncStatus === 'pending' || p.syncStatus === 'error';
										props.onPlaylistActivate(p.id, lazy);
									}}
									onContextMenu={(e) => {
										e.preventDefault();
										props.onPlaylistContextMenu(e, p.id);
									}}
								>
									<span
										class="pl-star"
										classList={{ starred }}
										data-act="star"
										aria-label="Star playlist"
										onClick={(e) => handleStarClick(e, p.id, p.isFavorite)}
									>{STAR_SVG()}</span>
									<span class="pl-mark">{p.mark ?? ''}</span>
									<span class="pl-name">{p.name}</span>
									<span class="pl-count">{(p.trackCount ?? 0).toLocaleString()}</span>
								</button>
							);
						}}
					</For>
				</Show>
			</div>
		</>
	);
}

export function mountSidebar(host: HTMLElement, props: SidebarProps): SidebarHandle {
	let nav: SidebarNavHandle | null = null;
	const dispose = render(() => (
		<Sidebar
			{...props}
			setNavHandle={(h) => {
				nav = h;
				props.setNavHandle?.(h);
			}}
		/>
	), host);
	return {
		destroy: dispose,
		stepSelection: (delta) => nav?.stepSelection(delta),
		enterSelection: () => nav?.enterSelection() ?? 'noop',
		activateCursor: () => nav?.activateCursor() ?? 'noop',
		setExpand: (expand) => nav?.setExpand(expand) ?? false,
		ensureCursor: () => nav?.ensureCursor(),
		clearCursor: () => nav?.clearCursor(),
	};
}
