// UI-settings feature store — localStorage persistence, the uiSettings
// signal, and the TopFrame tab-visibility memos. Extracted verbatim from
// main.ts (F3.1). The navigation fallbacks still live in main.ts (they go
// through the navigation-history choke point) and are injected once from
// boot() via initUiSettingsFeature — this module never imports main.ts.

import { createSignal, createMemo } from 'solid-js';
import type { SourceTabId, StateTab as StateTabId } from '../layouts/TopFrame.jsx';
import { shell, type SourceTab } from '../viewmodel/shell.js';
import { log } from '../data/log.js';
import { GROUP_BY_VALUES, type GroupBy, type RowLines } from '../trackGroups.js';
import type { ArtistCreditFormat, ArtistSeparator, RemixStyle } from '@curator/shared';

// applyActiveTabFallback needs to bump navigation + repaint the track
// list when the active tab disappears from the visible set. Those still
// live in main.ts; injected from boot() before the fallback effect mounts.
export interface UiSettingsFeatureDeps {
	// Forced navigations: the tab the user was on got hidden, so the view
	// has to move somewhere visible. Both REPLACE the current history entry
	// rather than pushing one — the user didn't go anywhere, their place
	// stopped existing.
	fallbackToSource(src: SourceTab): void;
	fallbackToTracks(): void;
}

let deps: UiSettingsFeatureDeps;

export function initUiSettingsFeature(d: UiSettingsFeatureDeps): void {
	deps = d;
}

// Tag-count badges for the TopFrame state tabs. Lives here (moved from
// main.ts — F3.1) because visibleStateTabsMemo folds the live counts into
// state-tab visibility at module scope; main.ts keeps writing it from
// refreshTagCounts + the downloads chip painter.
export const [tagCountsSignal, setTagCountsSignal] = createSignal<{ interested: number; basket: number; downloads: number; discover: number }>({ interested: 0, basket: 0, downloads: 0, discover: 0 });

// ─── User Interface settings ─────────────────────────────────────────────────
// Drives which tabs are visible in the TopFrame strip. Two pieces:
//   • sourceTabs — straight on/off checkboxes (Spotify, Tidal, Soundcloud,
//     Rekordbox). Soundcloud lives here even though it's not a real
//     activeSource yet, so the user can hide the "coming soon" placeholder.
//   • Three state tabs (Pinned Tracks / Downloads / Basket), each with a
//     visible-checkbox plus a 2-mode radio: 'always' or 'when-has'. The
//     persisted mode is preserved even when the checkbox is off, so
//     re-enabling restores the user's last choice.
//
// Persisted under curator.ui-settings.v2; missing fields fall back to
// DEFAULT_UI_SETTINGS (everything visible, mode 'always') which preserves
// the historical show-everything behaviour. Mutations push through
// uiSettingsSignal; TopFrame's visibleSourceTabs + visibleStateTabs memos
// derive off it. An effect bumps activeSource / activeView to the first
// visible tab when the current one disappears.

export type StateTabMode = 'always' | 'when-has';
export interface StateTabPref {
	visible: boolean;
	mode:    StateTabMode;
}
// Which analysis source the player/waveform displays for tracks that carry
// both a Rekordbox-imported and a Curator-computed grid/segments/key. Default
// 'rekordbox' keeps rb's imported grids as the shown source of truth; flipping
// to 'curator' shows Curator's own analysis. Both are always stored — this only
// chooses what's displayed (see analysisStore.resolveEntry).
export type AnalysisSourcePref = 'rekordbox' | 'curator';

// How musical keys are rendered everywhere (player, tracklist, discover,
// omnibar). 'camelot' shows the Mixed-In-Key wheel notation (8A); 'musical'
// shows the note name (Am). The colour is identical either way — only the
// label changes. Single source of truth read by music-utils.resolveKeyChip.
export type KeyDisplayFormat = 'camelot' | 'musical';

export interface UISettings {
	sourceTabs: Record<SourceTabId, boolean>;
	pinned:    StateTabPref;
	downloads: StateTabPref;
	basket:    StateTabPref;
	analysisSource: AnalysisSourcePref;
	keyDisplayFormat: KeyDisplayFormat;
	// Seconds the playhead must reach before a Discover track counts as
	// "listened" and flips to played. See DiscoverView's listen gate.
	discoverListenThresholdSec: number;
	// Artist line rendering (tracklist, player, discover, omnibar): the
	// separator between contributing artists and how a remixer credit is
	// appended. Display only — see @curator/shared artist-credit.ts.
	artistSeparator: ArtistSeparator;
	remixStyle: RemixStyle;
	// Track list layout (the toolbar's Rows / Group chips): one 30px line
	// per track (every column, scrolls sideways) or two 52px lines with
	// paired columns; and the field rows are grouped under.
	trackRowLines: RowLines;
	trackGroupBy: GroupBy;
}

const UI_SETTINGS_KEY = 'curator.ui-settings.v2';
const DEFAULT_UI_SETTINGS: UISettings = {
	sourceTabs: { spotify: true, tidal: true, soundcloud: true, rekordbox: true },
	pinned:    { visible: true, mode: 'always' },
	downloads: { visible: true, mode: 'always' },
	basket:    { visible: true, mode: 'always' },
	analysisSource: 'rekordbox',
	keyDisplayFormat: 'camelot',
	discoverListenThresholdSec: 5,
	artistSeparator: ',',
	remixStyle: 'parenthesis',
	trackRowLines: 2,
	trackGroupBy: 'none',
};

// Only the tabs that exist today: a persisted key for a retired tab (the old
// Local tab) must not leak into the visible set.
function sanitizeSourceTabs(raw: unknown): Record<SourceTabId, boolean> {
	const out = { ...DEFAULT_UI_SETTINGS.sourceTabs };
	if (raw && typeof raw === 'object') {
		for (const k of Object.keys(out) as SourceTabId[]) {
			const v = (raw as Record<string, unknown>)[k];
			if (typeof v === 'boolean') out[k] = v;
		}
	}
	return out;
}

function loadUiSettings(): UISettings {
	try {
		const raw = localStorage.getItem(UI_SETTINGS_KEY);
		if (!raw) return cloneUiSettings(DEFAULT_UI_SETTINGS);
		const parsed = JSON.parse(raw) as Partial<UISettings>;
		return {
			sourceTabs: sanitizeSourceTabs(parsed.sourceTabs),
			pinned:    sanitizePref(parsed.pinned)    ?? { ...DEFAULT_UI_SETTINGS.pinned },
			downloads: sanitizePref(parsed.downloads) ?? { ...DEFAULT_UI_SETTINGS.downloads },
			basket:    sanitizePref(parsed.basket)    ?? { ...DEFAULT_UI_SETTINGS.basket },
			analysisSource: parsed.analysisSource === 'curator' ? 'curator' : 'rekordbox',
			keyDisplayFormat: parsed.keyDisplayFormat === 'musical' ? 'musical' : 'camelot',
			discoverListenThresholdSec: sanitizeThreshold(parsed.discoverListenThresholdSec),
			artistSeparator: parsed.artistSeparator === '/' || parsed.artistSeparator === ';' ? parsed.artistSeparator : ',',
			remixStyle: parsed.remixStyle === 'dash' ? 'dash' : 'parenthesis',
			trackRowLines: parsed.trackRowLines === 1 ? 1 : 2,
			trackGroupBy: (GROUP_BY_VALUES as readonly unknown[]).includes(parsed.trackGroupBy) ? parsed.trackGroupBy! : 'none',
		};
	} catch {
		return cloneUiSettings(DEFAULT_UI_SETTINGS);
	}
}

function cloneUiSettings(s: UISettings): UISettings {
	return {
		sourceTabs: { ...s.sourceTabs },
		pinned:    { ...s.pinned },
		downloads: { ...s.downloads },
		basket:    { ...s.basket },
		analysisSource: s.analysisSource,
		keyDisplayFormat: s.keyDisplayFormat,
		discoverListenThresholdSec: s.discoverListenThresholdSec,
		artistSeparator: s.artistSeparator,
		remixStyle: s.remixStyle,
		trackRowLines: s.trackRowLines,
		trackGroupBy: s.trackGroupBy,
	};
}

// The artist-line format every credit renderer reads. Reactive when read
// inside a Solid scope; the vanilla tracklist reads it per row build and
// is repainted by main.ts when it changes.
export function artistCreditFormat(): ArtistCreditFormat {
	const s = uiSettingsSignal();
	return { separator: s.artistSeparator, remixStyle: s.remixStyle };
}

// Clamp the listen threshold to the same 5–120s range the Settings input
// exposes; fall back to the default for non-numeric / out-of-range stored values.
function sanitizeThreshold(v: unknown): number {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n) || n < 5 || n > 120) return DEFAULT_UI_SETTINGS.discoverListenThresholdSec;
	return n;
}

function sanitizePref(v: unknown): StateTabPref | null {
	if (!v || typeof v !== 'object') return null;
	const o = v as Partial<StateTabPref>;
	const mode: StateTabMode = o.mode === 'when-has' ? 'when-has' : 'always';
	return { visible: o.visible !== false, mode };
}

function saveUiSettings(s: UISettings): void {
	try { localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(s)); }
	catch (err) { log.for('ui-settings').warn('persist failed', undefined, err); }
}

const [uiSettingsSignal, setUiSettingsSignal] = createSignal<UISettings>(loadUiSettings());
export { uiSettingsSignal };

export function updateUiSettings(mutator: (draft: UISettings) => void): void {
	const next = cloneUiSettings(uiSettingsSignal());
	mutator(next);
	setUiSettingsSignal(next);
	saveUiSettings(next);
}

// Derived visibility sets used by TopFrame. State-tab visibility folds in
// the live tag counts so 'when-has' flips when the count crosses zero.
export const visibleSourceTabsMemo = createMemo<ReadonlySet<SourceTabId>>(() => {
	const s = uiSettingsSignal().sourceTabs;
	const out = new Set<SourceTabId>();
	(Object.keys(s) as SourceTabId[]).forEach((id) => { if (s[id]) out.add(id); });
	return out;
});

export const visibleStateTabsMemo = createMemo<ReadonlySet<StateTabId>>(() => {
	const ui = uiSettingsSignal();
	const counts = tagCountsSignal();
	const out = new Set<StateTabId>();
	const visible = (p: StateTabPref, count: number): boolean =>
		p.visible && (p.mode === 'always' || count > 0);
	if (visible(ui.pinned,    counts.interested)) out.add('interested');
	if (visible(ui.downloads, counts.downloads))  out.add('downloads');
	if (visible(ui.basket,    counts.basket))     out.add('basket');
	// Discover is always visible — it's a primary surface, not a count-
	// driven workflow tab. (UI-settings toggle can come later.)
	out.add('discover');
	return out;
});

// Active-tab fallback. When the current activeSource or state activeView
// drops out of the visible set, bump to the first visible alternative so
// the strip never shows an orphan-active state. Source order matches
// SOURCE_TABS in TopFrame (spotify, tidal, soundcloud, rekordbox);
// 'soundcloud' is intentionally skipped because it isn't a real source.
const SOURCE_ORDER: SourceTabId[] = ['spotify', 'tidal', 'soundcloud', 'rekordbox'];

export function applyActiveTabFallback(): void {
	const sources = visibleSourceTabsMemo();
	if (!sources.has(shell.activeSource())) {
		const next = SOURCE_ORDER.find((id) => id !== 'soundcloud' && sources.has(id)) as SourceTab | undefined;
		if (next && next !== shell.activeSource()) deps.fallbackToSource(next);
	}
	const states = visibleStateTabsMemo();
	const isStateView = shell.activeView() === 'interested' || shell.activeView() === 'basket' || shell.activeView() === 'downloads';
	if (isStateView && !states.has(shell.activeView() as StateTabId)) {
		// No fallback within the state strip — drop back to the source-bound
		// tracks view, which always has a home regardless of UI settings.
		deps.fallbackToTracks();
	}
}

export type StateTabKey = 'pinned' | 'downloads' | 'basket';
