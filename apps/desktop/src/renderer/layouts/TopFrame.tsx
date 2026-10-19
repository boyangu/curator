// TopFrame — the full-width top navigation bar (Phase 3.B). Owns the
// Curator logo, source tabs, state tabs, volume control slot, analyzer
// status chip, player-mode toggle, omnibar trigger, settings button,
// avatar, and the custom window controls.
//
// All reactivity flows through Accessor props. main.ts maintains the
// signals (active source/view, tag counts, analyzer state, player mode,
// zoom level) and wires callbacks back for navigation, window controls,
// and modal opens. Replaces six wireX() functions in main.ts (wireNav,
// wireWindowControls, wireSettingsButton, wireSoundcloudNoOp,
// wireLocalTabContextMenu, wirePlayerModeToggle's button binding) plus
// renderTopNav/renderAnalysisChip/applyChromeAntiZoom.

import { For, Show, createEffect } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { VolumeControl } from '../components/VolumeControl.jsx';
import { VUMeter } from '../components/VUMeter.jsx';
import type { SourceTab } from '../viewmodel/shell.js';

// Includes 'soundcloud' for visibility-toggle purposes only — soundcloud is
// not a real activeSource (no backend wired), but it lives in the tab strip
// and the User Interface settings panel lets the user hide it like any other.
export type SourceTabId = SourceTab | 'soundcloud';
export type StateTab = 'interested' | 'basket' | 'downloads' | 'discover';

// Source tab metadata. Soundcloud is a special "disabled" entry — the
// design includes the tab but no backend hooks up to it yet, so clicking
// it shows the "coming soon" toast and does not change activeSource.
interface SourceTabDef {
	id: SourceTab | 'soundcloud';
	label: string;
	disabled?: boolean;
	contextual?: boolean;  // accepts right-click context menu
	// True when playback can originate from this tab's backend — gates the
	// per-tab "now playing" marker (driven by currentSource). Spotify + the
	// Rekordbox/local file backend only for now; Tidal has no backend yet.
	sourceCapable?: boolean;
	iconSvg: () => JSX.Element;
}
const SOURCE_TABS: SourceTabDef[] = [
	{ id: 'spotify',    label: 'Spotify', contextual: true, sourceCapable: true, iconSvg: () => (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
			<rect x="4" y="9" width="3" height="6" rx="0.4"/>
			<rect x="10.5" y="5" width="3" height="14" rx="0.4"/>
			<rect x="17" y="11" width="3" height="2" rx="0.4"/>
		</svg>
	) },
	{ id: 'tidal',      label: 'Tidal', contextual: true, iconSvg: () => (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
			<polygon points="6,9 9,12 6,15 3,12"/>
			<polygon points="12,9 15,12 12,15 9,12"/>
			<polygon points="18,9 21,12 18,15 15,12"/>
			<polygon points="12,15 15,18 12,21 9,18"/>
		</svg>
	) },
	{ id: 'soundcloud', label: 'Soundcloud', disabled: true, iconSvg: () => (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
			<path d="M7 18a4 4 0 0 1-.4-7.96A6 6 0 0 1 18.5 11a3.5 3.5 0 0 1-.5 7H7Z"/>
		</svg>
	) },
	{ id: 'rekordbox',  label: 'Rekordbox', contextual: true, sourceCapable: true, iconSvg: () => (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
			<circle cx="12" cy="12" r="9"/>
			<circle cx="12" cy="12" r="3"/>
			<circle cx="12" cy="12" r="0.6" fill="currentColor"/>
		</svg>
	) },
];

interface StateTabDef {
	id: StateTab;
	label: string;
	state: string; // CSS data-state attribute
	iconSvg: () => JSX.Element;
}
const STATE_TABS: StateTabDef[] = [
	{ id: 'discover', label: 'Discover', state: 'discover', iconSvg: () => (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
			<circle cx="12" cy="12" r="9"/>
			<polygon points="14.8,9.2 12.8,12.8 9.2,14.8 11.2,11.2" fill="currentColor" stroke="none"/>
		</svg>
	) },
	{ id: 'interested', label: 'Pinned', state: 'pinned', iconSvg: () => (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
			<g transform="rotate(45 12 12)">
				<path d="M9.5 2.5h5v4h-5z"/>
				<path d="M7.5 6.5h9v7h-9z"/>
				<line x1="12" y1="13.5" x2="12" y2="22"/>
			</g>
		</svg>
	) },
	{ id: 'basket', label: 'Basket', state: 'basket', iconSvg: () => (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
			<rect x="2.5" y="8" width="19" height="3.5" rx="0.6"/>
			<path d="M4 11.5 5.6 20.2A2 2 0 0 0 7.6 21.8H16.4A2 2 0 0 0 18.4 20.2L20 11.5"/>
			<line x1="12" y1="2.5" x2="12" y2="8"/>
			<line x1="9" y1="14" x2="9" y2="18.5"/>
			<line x1="12" y1="14" x2="12" y2="18.5"/>
			<line x1="15" y1="14" x2="15" y2="18.5"/>
		</svg>
	) },
	{ id: 'downloads', label: 'Downloads', state: 'downloads', iconSvg: () => (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
			<path d="M16.5 15.5a4.5 4.5 0 1 0-1-8.9 6 6 0 0 0-11.5 2A4 4 0 0 0 5.5 16.5h2.5"/>
			<path d="M12 11.5v9.5"/>
			<path d="m8 17.5 4 4 4-4"/>
		</svg>
	) },
];

// 0–999 → "123"; 1k+ → "1.2k"; 1M+ → "1.2M". Tiny duplicate of main.ts's
// fmtCount until a shared format-utils module is justified.
function fmtCount(n: number): string {
	if (!Number.isFinite(n) || n < 0) return '—';
	if (n >= 1_000_000) {
		const v = n / 1_000_000;
		return `${v >= 10 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}M`;
	}
	if (n >= 10_000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return n.toLocaleString('en-US');
	return String(n);
}

export interface AnalyzerStatus {
	// Count of tracks currently mid-analysis (capped by the sidecar's worker
	// pool — 4 by default per apps/core/src/analyzer/queue.ts DEFAULT_CONCURRENCY).
	runningCount: number;
	// Display names ("artist — title") for the running tracks, resolved on the
	// backend so they're correct even for rows not in the loaded page.
	runningTracks: string[];
	// Tracks waiting in `state='queued'` from the most recent reconcile.
	// Decremented locally on every `started` event so the value stays close
	// to truth between reconciles.
	queuedCount: number;
	// Terminal events (completed/failed/cancelled) seen since the current
	// batch started — the completed/total numerator for the chip tooltip.
	completedSession: number;
	lastError: { trackId: string; message: string } | null;
}

export interface TopFrameProps {
	// The single active-tab identity across BOTH groups (source + state).
	// Exactly one tab highlights at a time — see shell.activeTabId.
	activeTabId: Accessor<string>;
	// Which source-capable tab the currently-playing audio comes from (the
	// playback backend), or null when stopped/paused. Drives the per-tab
	// "now playing" marker — independent of which tab is active.
	currentSource: Accessor<'spotify' | 'rekordbox' | null>;
	tagCounts: Accessor<{ interested: number; basket: number; downloads: number; discover: number }>;
	analyzerStatus: Accessor<AnalyzerStatus>;
	playerMode: Accessor<'small' | 'big'>;
	// Tab-strip visibility, driven by the User Interface settings panel.
	// Caller computes these from the persisted UISettings + (for state tabs)
	// current tagCounts. A tab missing from the set is omitted from the strip.
	visibleSourceTabs: Accessor<ReadonlySet<SourceTabId>>;
	visibleStateTabs:  Accessor<ReadonlySet<StateTab>>;
	// Chromium zoom level (negative shrinks, positive grows). Used to
	// counter-zoom the topframe so its chrome stays at 100% regardless of
	// the body-zoom level the user has chosen via Ctrl+/-/=.
	zoomLevel: Accessor<number>;
	// Per-source "sync in progress" indicator. When a key is present, that
	// source-tab swaps its icon for a breathing rectangle and renders a
	// custom popover with the `tooltip` text (preferred over the native
	// title attribute because native tooltips don't re-read while visible
	// — content needs to update live as sync progress comes in).
	//
	// `alert=true` flips the rect to its orange variant — used when the
	// source has hit connection trouble and is in the retry loop. Renderer
	// owns clearing entries when sync ends.
	sourceSyncTooltip: Accessor<Partial<Record<SourceTab, { tooltip: string; alert: boolean }>>>;
	// Static UI bits
	userInitials: string;

	// Callbacks
	onSourceClick: (src: SourceTab) => void;
	onSourceContextMenu?: (evt: MouseEvent, src: SourceTab) => void;
	onSoundcloudClick: () => void;
	onViewClick: (view: StateTab) => void;
	onOmnibarOpen: () => void;
	onSettingsOpen: () => void;
	onPlayerModeToggle: () => void;
	onMinimize: () => void;
	onToggleMaximize: () => void;
	onClose: () => void;
}

export function TopFrame(props: TopFrameProps) {
	let rootRef!: HTMLDivElement;

	// Counter-zoom the topframe to keep its content at 100% even when the
	// rest of the UI is scaled. Chromium's zoom factor = 1.2 ^ level; we
	// apply the inverse via the non-standard but Chromium-native `zoom`
	// CSS property. Runs whenever zoomLevel() changes — typically only
	// when the user presses Ctrl + / - / = .
	createEffect(() => {
		if (!rootRef) return;
		const factor = Math.pow(1.2, props.zoomLevel());
		rootRef.style.zoom = String(1 / factor);
	});

	// Derived flag for the analyzer chip — visible whenever there's work in the
	// pipeline (running OR still queued) or a sticky last-error to surface.
	// Including queued means the chip appears the instant the user enqueues, and
	// stays through the gaps between dispatches, instead of only flickering on
	// while a track is actively in a worker slot.
	const chipVisible = (): boolean => {
		const s = props.analyzerStatus();
		return s.runningCount > 0 || s.queuedCount > 0 || s.lastError !== null;
	};
	// No glance number any more — the breathing square alone signals "analysis
	// in progress"; exact running/queued counts live in the hover tooltip.
	// data-state still drives the dot (accent+breathing while active, static red on error).
	const chipDataState = (): string => {
		const s = props.analyzerStatus();
		if (s.runningCount > 0 || s.queuedCount > 0) return s.lastError ? 'errors' : 'active';
		if (s.lastError) return 'errors';
		return 'idle';
	};
	// ── Analyzer tooltip (custom DOM, not the native `title`) ───────────────
	// Native tooltips snapshot their text when shown and never re-read it, so
	// progress wouldn't update mid-hover. We render our own popover (same
	// pattern as the per-source sync tooltip above) and read the reactive
	// snapshot inside it, so completed/total and the running list tick live.
	//   completed = terminal events this batch; total = completed + running +
	//   queued (the whole batch). Running rows are resolved display names.
	const chipCompleted = (): number => props.analyzerStatus().completedSession;
	const chipTotal = (): number => {
		const s = props.analyzerStatus();
		return s.completedSession + s.runningCount + s.queuedCount;
	};
	const chipRunningTracks = (): string[] => props.analyzerStatus().runningTracks;
	const chipParallel = (): number => props.analyzerStatus().runningCount;
	const chipError = (): string | null => props.analyzerStatus().lastError?.message ?? null;

	const handleSourceClick = (def: SourceTabDef) => {
		if (def.disabled) { props.onSoundcloudClick(); return; }
		props.onSourceClick(def.id as SourceTab);
	};
	const handleSourceCtx = (evt: MouseEvent, def: SourceTabDef) => {
		if (!def.contextual || !props.onSourceContextMenu) return;
		evt.preventDefault();
		props.onSourceContextMenu(evt, def.id as SourceTab);
	};

	return (
		<div ref={rootRef} class="topframe" id="mainNav">
			<div class="tf-logo">
				<div class="tf-mark" aria-hidden="true">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
						<rect x="2" y="4" width="9" height="2.4"/>
						<rect x="2" y="10.8" width="13" height="2.4"/>
						<rect x="2" y="17.6" width="20" height="2.4"/>
					</svg>
				</div>
				<div class="tf-wordmark">Curator</div>
			</div>

			<div class="tf-tabs tf-sources">
				<For each={SOURCE_TABS.filter((def) => props.visibleSourceTabs().has(def.id))}>
					{(def) => {
						// Per-tab sync status — null when nothing's syncing.
						// Re-reads on every signal change so live updates
						// inside an already-visible popover work without
						// hover-events.
						const syncStatus = () => def.disabled
							? null
							: props.sourceSyncTooltip()[def.id as SourceTab] ?? null;
						return (
							<button
								class={def.disabled ? 'tf-tab tf-tab--disabled' : 'tf-tab top-nav-item'}
								classList={{
									active: !def.disabled && props.activeTabId() === def.id,
									'tf-tab--has-popover': !!syncStatus(),
								}}
								// Title-attr only for the static fallback labels. The
								// sync popover is a separate DOM element below — needed
								// because the native title tooltip doesn't re-read its
								// content while visible, so live progress updates
								// wouldn't reach the user mid-hover.
								title={syncStatus() ? undefined : (def.disabled ? `${def.label} — coming soon` : def.label)}
								aria-disabled={def.disabled ? 'true' : undefined}
								onClick={() => handleSourceClick(def)}
								onContextMenu={(e) => handleSourceCtx(e, def)}
							>
								<span class="tf-src-mark">
									{syncStatus()
										// Breathing rect: a small filled square with a CSS
										// `pulse-breathe` animation. `--alert` variant flips
										// to orange while the source is in the connection-
										// retry loop. aria-label preserves screen-reader text.
										? <span
											class="tf-src-pulse"
											classList={{ 'tf-src-pulse--alert': syncStatus()!.alert }}
											aria-label={`${def.label} ${syncStatus()!.alert ? 'reconnecting' : 'syncing'}`}
										/>
										: def.iconSvg()}
								</span>
								<span>{def.label}</span>
								{/* Per-tab now-playing marker dropped for now. The
								   view-model still exposes props.currentSource()
								   (the playback-origin tab) — re-add a marker here
								   when we want one. */}
								{syncStatus() && (
									// Reactive popover. CSS shows on .tf-tab:hover.
									// `white-space: pre-line` renders the multi-line
									// tooltip string verbatim. Re-renders whenever the
									// signal value changes, even while visible — that's
									// the whole point of replacing the title attribute.
									<div class="tf-src-tooltip" role="tooltip">
										{syncStatus()!.tooltip}
									</div>
								)}
							</button>
						);
					}}
				</For>
			</div>

			<div class="tf-group-sep" aria-hidden="true"></div>

			<div class="tf-tabs tf-states">
				<For each={STATE_TABS.filter((def) => props.visibleStateTabs().has(def.id))}>
					{(def) => (
						<button
							class="tf-tab top-nav-item"
							classList={{ active: props.activeTabId() === def.id }}
							data-state={def.state}
							title={def.label}
							onClick={() => props.onViewClick(def.id)}
						>
							{def.iconSvg()}
							<span>{def.label}</span>
							<span class="ct">{fmtCount(props.tagCounts()[def.id])}</span>
						</button>
					)}
				</For>
			</div>

			<div class="tf-drag" aria-hidden="true"></div>
			<div class="tf-group-sep" aria-hidden="true"></div>

			<div class="tf-user">
				<VUMeter />
				<VolumeControl />
				<div
					class="analysis-chip"
					data-state={chipDataState()}
					hidden={!chipVisible()}
				>
					<span class="analysis-chip__dot"></span>
					{/* Reactive popover (CSS shows it on .analysis-chip:hover).
					   Re-reads the snapshot while visible — unlike the native
					   title it replaced — so completed/total and the running list
					   update live during analysis. */}
					<div class="analysis-chip__tooltip" role="tooltip">
						<div class="analysis-chip__tt-head">{chipCompleted()} / {chipTotal()} tracks</div>
						<Show when={chipRunningTracks().length > 0}>
							<div class="analysis-chip__tt-list">
								<For each={chipRunningTracks()}>
									{(name) => <div class="analysis-chip__tt-row">{name}</div>}
								</For>
							</div>
						</Show>
						<div class="analysis-chip__tt-foot">running {chipParallel()} in parallel</div>
						<Show when={chipError()}>
							<div class="analysis-chip__tt-err">Last error: {chipError()}</div>
						</Show>
					</div>
				</div>
				<button
					class="tf-icon-btn"
					title="Toggle small / big player"
					aria-label="Toggle player size"
					onClick={() => props.onPlayerModeToggle()}
				>
					<Show
						when={props.playerMode() === 'big'}
						fallback={
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
								<rect x="3" y="8" width="18" height="8" rx="1"/>
								<line x1="6" y1="12" x2="11" y2="12"/>
								<line x1="13" y1="11" x2="13" y2="13"/>
								<line x1="16" y1="11" x2="16" y2="13"/>
								<line x1="18.5" y1="11" x2="18.5" y2="13"/>
							</svg>
						}
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
							<rect x="3" y="4" width="18" height="16" rx="1"/>
							<line x1="6" y1="9" x2="18" y2="9"/>
							<line x1="6" y1="16" x2="11" y2="16"/>
							<line x1="13" y1="15" x2="13" y2="17"/>
							<line x1="16" y1="15" x2="16" y2="17"/>
						</svg>
					</Show>
				</button>
				<button
					class="tf-icon-btn tf-omnibar-btn"
					title="Quick open (⌘K)"
					aria-label="Quick open"
					onClick={() => props.onOmnibarOpen()}
				>
					<span class="kbd kbd--inline">⌘K</span>
				</button>
				<button
					class="tf-icon-btn"
					title="Settings"
					aria-label="Settings"
					onClick={() => props.onSettingsOpen()}
				>
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="3"/>
						<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>
					</svg>
				</button>
				<button class="tf-avatar" title="Account">
					{props.userInitials}
					<span class="av-dot"></span>
				</button>
			</div>

			<div class="tf-group-sep" aria-hidden="true"></div>

			<div class="tf-window">
				<button class="tf-win-btn" title="Minimize" aria-label="Minimize" onClick={() => props.onMinimize()}>
					<svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1">
						<line x1="1" y1="5" x2="9" y2="5"/>
					</svg>
				</button>
				<button class="tf-win-btn" title="Maximize" aria-label="Maximize" onClick={() => props.onToggleMaximize()}>
					<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1">
						<rect x="1.5" y="1.5" width="7" height="7"/>
					</svg>
				</button>
				<button class="tf-win-btn tf-win-btn--close" title="Close" aria-label="Close" onClick={() => props.onClose()}>
					<svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1">
						<line x1="1.5" y1="1.5" x2="8.5" y2="8.5"/>
						<line x1="8.5" y1="1.5" x2="1.5" y2="8.5"/>
					</svg>
				</button>
			</div>
		</div>
	);
}

export interface TopFrameHandle {
	destroy(): void;
}

export function mountTopFrame(host: HTMLElement, props: TopFrameProps): TopFrameHandle {
	const dispose = render(() => <TopFrame {...props} />, host);
	return { destroy: dispose };
}
