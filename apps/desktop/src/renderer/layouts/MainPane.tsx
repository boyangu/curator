// MainPane — the `.main` view container (Phase 3.D). Owns the filter
// bar, the per-tab empty-state slot, the sync / downloads views,
// and the tracks-view host.
//
// Conservative scope: this is a structural extraction only. Every inner
// element keeps its existing id (#playlist-title, #enrich-inline,
// #sync-list, #dl-list, #tracks-view, …)
// so the procedural render code in main.ts that targets those ids
// continues to work unchanged. Future sub-phases can carve individual
// views (filter bar, sync view, downloads view) into proper
// reactive Solid components without re-touching the layout.
//
// Why this step matters: index.html now drops from a 240-line wall of
// markup to a tiny shell with just the shared overlays + per-region
// hosts (#topframe-host, #sidebar-host, #player-footer-host,
// #main-pane-host). It also makes the eventual `mountAppShell(root)` a
// trivial composition of four mounts plus the shared overlay markup.

import { render } from 'solid-js/web';
import { Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { GroupBy, RowLines } from '../trackGroups.js';

export interface MainPaneHandle {
	destroy(): void;
}

// Back / forward over the navigation history (viewmodel/navHistory.ts).
// Accessors so the buttons re-derive from the stack signals; the handlers
// are main.ts's traversal orchestration.
export interface MainPaneNavProps {
	canBack: Accessor<boolean>;
	canForward: Accessor<boolean>;
	// Label of the entry each arrow would land on, for the tooltip.
	backLabel: Accessor<string | null>;
	forwardLabel: Accessor<string | null>;
	onBack: () => void;
	onForward: () => void;
}

// Track-list layout chips before the filter box. Group opens a context
// menu (main.ts) anchored to the chip; `open` says when it's up
// (aria-expanded + the pressed look). Rows is a plain two-state toggle.
export interface MainPaneTracklistProps {
	groupBy: Accessor<GroupBy>;
	rowLines: Accessor<RowLines>;
	open: Accessor<'group' | null>;
	onGroupClick: (anchor: HTMLElement) => void;
	onRowsToggle: () => void;
	// "This device" chip: the account's tracks this device has no source of
	// (remote rows) and whether they are hidden. Only offered once there are
	// any (or while hiding, so it can always be turned off again).
	remoteCount: Accessor<number>;
	hideRemote: Accessor<boolean>;
	onHideRemoteToggle: () => void;
}

export interface MainPaneProps {
	nav: MainPaneNavProps;
	tracklist: MainPaneTracklistProps;
}

const GROUP_LABELS: Record<GroupBy, string> = { none: 'None', artist: 'Artist', album: 'Album', label: 'Label' };

function remoteChipTitle(n: number, hiding: boolean): string {
	const count = n > 0 ? `${n.toLocaleString()} ${n === 1 ? 'track' : 'tracks'}` : 'tracks';
	return hiding
		? `Showing only tracks on this device — click to also show the ${count} your other devices hold`
		: `Show only tracks on this device — hides the ${count} only your other devices hold`;
}

export function MainPane(props: MainPaneProps) {
	const backTitle = (): string => (props.nav.backLabel() ? `Back to ${props.nav.backLabel()} (Alt+←)` : 'Back (Alt+←)');
	const forwardTitle = (): string => (props.nav.forwardLabel() ? `Forward to ${props.nav.forwardLabel()} (Alt+→)` : 'Forward (Alt+→)');
	return (
		<>
			<div class="filter-bar">
				{/* Sidebar collapse toggle — Ctrl-B does the same; wired in
				    main.ts via wireSidebarToggleButton(). */}
				<button class="icon-btn sidebar-toggle-btn" id="sidebar-toggle-btn" type="button" title="Toggle side-bar (CTRL-B)" aria-label="Toggle side-bar (CTRL-B)">
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
						<rect x="3" y="4" width="18" height="16" rx="2"/>
						<path d="M9 4v16"/>
					</svg>
				</button>
				{/* Browser-style history arrows. Disabled at either end of the
				    stack; the tooltip names the entry the click would land on. */}
				<div class="nav-arrows">
					<button class="icon-btn nav-btn" type="button" disabled={!props.nav.canBack()} title={backTitle()} aria-label={backTitle()} onClick={() => props.nav.onBack()}>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
							<path d="M15 18l-6-6 6-6"/>
						</svg>
					</button>
					<button class="icon-btn nav-btn" type="button" disabled={!props.nav.canForward()} title={forwardTitle()} aria-label={forwardTitle()} onClick={() => props.nav.onForward()}>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
							<path d="M9 18l6-6-6-6"/>
						</svg>
					</button>
				</div>
				<div class="playlist-title" id="playlist-title" hidden></div>
				{/* Pin-this-search toggle. Shown only when a JIT search is loaded
				    (renderTracks → updatePinButton toggles `hidden` + `is-pinned`).
				    Clicking pins/unpins the current search; wired in main.ts via
				    wirePinButton(). */}
				<button class="icon-btn pin-search-btn" id="pin-search-btn" type="button" hidden title="Pin this search" aria-label="Pin this search">
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
						<path d="M9 4v6l-2 3h10l-2-3V4"/>
						<path d="M8 4h8"/>
						<path d="M12 16v5"/>
					</svg>
				</button>
				{/* Inline enrichment indicator. Shown only when the currently-open
				    playlist is the one being enriched/synced; positioned next to
				    the playlist title rather than stretched over the track table. */}
				<div class="enrich-inline" id="enrich-inline" hidden>
					<span class="enrich-inline__pulse"></span>
					<span class="enrich-inline__label" id="enrich-inline-label">0 / 0</span>
					<button class="enrich-inline__stop" id="enrich-inline-stop" type="button" title="Stop">
						<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10"/></svg>
					</button>
				</div>
				{/* Tracklist filterbox. Same grammar as the omnibar (see
				    renderer/query.ts): freetext, `attr:val` / `attr={val}`,
				    `bpm<120` / `120<=bpm<=122`, `#tag`, AND/OR/parens.
				    Applied client-side over the loaded list so keystrokes
				    are instant. Ctrl-F focuses it from anywhere in a
				    music-source tab. The wrap is the positioned anchor
				    for the shared `#tag` autocomplete popover (see
				    renderer/tagSuggest.ts). */}
				<div class="tl-chips">
					<button
						type="button"
						class="tl-chip"
						classList={{ 'is-active': props.tracklist.groupBy() !== 'none', 'is-open': props.tracklist.open() === 'group' }}
						aria-haspopup="menu"
						aria-expanded={props.tracklist.open() === 'group' ? 'true' : 'false'}
						aria-label={`Group: ${GROUP_LABELS[props.tracklist.groupBy()]}`}
						onClick={(e) => props.tracklist.onGroupClick(e.currentTarget)}
					>
						<svg class="tl-chip__icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 3.5h10M2 7h10M2 10.5h10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
						<span class="tl-chip__label">Group</span>
						<Show when={props.tracklist.groupBy() !== 'none'}>
							<span class="tl-chip__value">{GROUP_LABELS[props.tracklist.groupBy()]}</span>
						</Show>
					</button>
					<Show when={props.tracklist.remoteCount() > 0 || props.tracklist.hideRemote()}>
						<button
							type="button"
							class="tl-chip"
							classList={{ 'is-active': props.tracklist.hideRemote() }}
							aria-pressed={props.tracklist.hideRemote() ? 'true' : 'false'}
							title={remoteChipTitle(props.tracklist.remoteCount(), props.tracklist.hideRemote())}
							onClick={() => props.tracklist.onHideRemoteToggle()}
						>
							<svg class="tl-chip__icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="2.5" width="10" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 11.5h4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
							<span class="tl-chip__label">This device</span>
						</button>
					</Show>
					{/* Row mode toggle — the player-size button's idiom: a borderless
					    icon showing the CURRENT mode (one slim line per row vs two
					    lines per row); one click flips it. */}
					<button
						type="button"
						class="tl-mode-btn"
						title={props.tracklist.rowLines() === 1 ? '1 line per track — click for 2 lines' : '2 lines per track — click for 1 line'}
						aria-label={props.tracklist.rowLines() === 1 ? 'Rows: 1 line. Switch to 2 lines' : 'Rows: 2 lines. Switch to 1 line'}
						onClick={() => props.tracklist.onRowsToggle()}
					>
						<Show
							when={props.tracklist.rowLines() === 2}
							fallback={
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<rect x="3" y="4" width="18" height="16" rx="1"/>
									<line x1="3" y1="9.33" x2="21" y2="9.33"/>
									<line x1="3" y1="14.67" x2="21" y2="14.67"/>
									<line x1="6" y1="6.67" x2="14" y2="6.67"/>
									<line x1="6" y1="12" x2="14" y2="12"/>
									<line x1="6" y1="17.33" x2="14" y2="17.33"/>
								</svg>
							}
						>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<rect x="3" y="4" width="18" height="16" rx="1"/>
								<line x1="3" y1="12" x2="21" y2="12"/>
								<line x1="6" y1="7" x2="18" y2="7"/>
								<line x1="6" y1="9.5" x2="12" y2="9.5"/>
								<line x1="6" y1="15" x2="18" y2="15"/>
								<line x1="6" y1="17.5" x2="12" y2="17.5"/>
							</svg>
						</Show>
					</button>
				</div>
				<div class="filter-bar__filter-wrap" id="tracklist-filter-wrap">
					<input
						id="tracklist-filter"
						class="filter-bar__filter"
						type="search"
						placeholder="Filter — artist:foo bpm<124 #tag …  (⌘K → Syntax for help)"
						spellcheck={false}
						autocomplete="off"
					/>
				</div>
			</div>

			{/* Per-tab empty state — replaced contextually by JS */}
			<div class="tab-empty" id="tab-empty" hidden></div>

			{/* Discover view — host for the DiscoverView component. Filled by
			    mountDiscoverView(...) in main.ts/boot(). setActiveView('discover')
			    toggles the `hidden` attribute; the feed list, cards and actions
			    are painted by the Solid component. */}
			<div class="discover-view" id="discover-view" hidden></div>

			{/* Sync view — host for the SyncView component. Filled by
			    mountSyncView(...) in main.ts/boot() with reactive rows +
			    running signals. Opens via header SYNC button; visibility is
			    toggled externally via setActiveView('sync'). */}
			<div class="sync-view" id="sync-view" hidden></div>

			{/* Downloads view — host for the DownloadsView component. Filled
			    by mountDownloadsView(...) in main.ts/boot() with reactive
			    jobs + summary signals. setActiveView('downloads') toggles
			    the `hidden` attribute on this host; the inner toolbar and
			    list are painted by the Solid component. */}
			<div class="dl-view" id="dl-view" hidden></div>

			{/* Tracks view — host for the TrackListView component. Filled by
			    mountTrackList(...) in main.ts/boot(). The component owns the
			    entire table, including <colgroup>/<thead>/<tbody>, sort
			    headers, column-resize handles, and event delegation. Per-
			    instance state means a future split-deck layout can mount
			    multiple lists into different hosts without collision. */}
			<div class="table-wrap" id="tracks-view"></div>
		</>
	);
}

export function mountMainPane(host: HTMLElement, props: MainPaneProps): MainPaneHandle {
	const dispose = render(() => <MainPane {...props} />, host);
	return { destroy: dispose };
}
