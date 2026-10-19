// Shell view model — the single logical representation of renderer
// navigation + chrome state (planning/tech/frontend-architecture.md, F1).
//
// Rules of the layer:
//   • This module owns the PRIMITIVE facts (signals) and their DERIVED
//     views (memos). It touches no DOM and imports nothing from views.
//   • Transitions below are the ONLY mutators. Orchestration concerns
//     (scroll capture, repaints, persistence side-effects) stay with the
//     callers — a transition records what the UI state IS, not what work
//     a navigation triggers.
//   • Everything downstream derives: region visibility, body attributes,
//     player dock/presence/mode all flow from these signals through the
//     region effect (views/regionEffect.ts). Nothing else may write those
//     DOM facts — that invariant is what kills the stale-async-writer bug
//     class, and scripts/check-renderer-boundaries.mjs enforces it.

import { createMemo, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';

// The source tabs in the top strip. Rekordbox is the DJ-side library: the
// rekordbox collection plus local files not in rekordbox yet (there is no
// separate Local tab; `local` is a track source, not a tab).
export type SourceTab = 'spotify' | 'tidal' | 'rekordbox';
export type ActiveView = 'tracks' | 'sync' | 'downloads' | 'interested' | 'basket' | 'discover';

// Which MainPane region a view renders into. Tag views (interested /
// basket) reuse the tracks-table region with a tag-filtered fetch.
export type Region = 'tracks' | 'sync' | 'downloads' | 'discover';

// JIT playlist — a transient track set defined by a query-grammar string
// (see renderer/query.ts). Powers omnibar Shift+Enter "load all results
// into the tracklist" and the track-context-menu "Drill into ▶" actions.
// Mutually exclusive with currentPlaylistId / currentFolderId / the
// Interested+Basket tag views. Not persisted.
export interface JitPlaylist {
	name: string;
	query: string;
	// Set when this JIT scope was loaded from — or just pinned as — a saved
	// pinned search (its pinned_search.id). Drives the filter-bar pin button's
	// "already pinned" state and the Pinned nav row's selected highlight.
	// Absent for transient JITs (omnibar Shift+Enter, drill-into ▶).
	pinnedId?: string;
}

// Empty-state slot content for the tracks region: onboarding/connect
// panels and the smart-playlist watermark. The PAINTER owns the html +
// button wiring; this model only records that the slot is occupied —
// which is what the region effect needs to swap table ↔ panel.
export interface EmptyStateContent {
	kind: 'onboarding' | 'watermark';
	source: string;
}

// The PLAYING track's layout class — 'local' for local-file audio, 'streaming'
// for Spotify/Tidal. This is the BACKEND driving the audio, not the tab it was
// started from (a downloaded Spotify track plays on the local backend). Every
// piece of player chrome derives from this one fact. Mirrored from the player
// by main.ts on track change; lives here (not read off the player module) so
// the chrome memos stay pure derivations and the region effect remains the
// single DOM writer. Null ⇔ nothing has been loaded yet.
export type PlayingLayout = 'local' | 'streaming';

// A tab's context class — the streaming catalogs (Spotify / Tidal / the
// Discover feed) vs the DJ-prep surfaces (Rekordbox / tag views).
export type TabContext = 'dj' | 'streaming';

// The tab playback was STARTED from, captured at play time by
// notePlaybackOrigin(). Not derivable from the playing track's backend: a
// downloaded Spotify track played from the Spotify tab runs on the local
// backend but still belongs to the streaming tab the user started it from.
// Queue auto-advance deliberately does not re-capture — the origin sticks
// until the user starts something new. Drives ONLY the cross-context chip
// (wayfinding back to where playback started); the docked player itself
// always follows the playing track, never the origin.
export interface PlaybackOrigin {
	source: SourceTab;
	view: ActiveView;
}

const [activeSource, setActiveSourceRaw] = createSignal<SourceTab>('spotify');
const [activeView, setActiveViewRaw] = createSignal<ActiveView>('tracks');
const [currentPlaylistId, setCurrentPlaylistIdRaw] = createSignal<string | null>(null);
const [currentFolderId, setCurrentFolderIdRaw] = createSignal<string | null>(null);
const [currentJit, setCurrentJitRaw] = createSignal<JitPlaylist | null>(null);
const [emptyState, setEmptyStateRaw] = createSignal<EmptyStateContent | null>(null);
const [playingLayout, setPlayingLayoutRaw] = createSignal<PlayingLayout | null>(null);
const [playbackOrigin, setPlaybackOriginRaw] = createSignal<PlaybackOrigin | null>(null);
const [sidebarCollapsed, setSidebarCollapsedRaw] = createSignal(false);

const region: Accessor<Region> = createMemo(() => {
	switch (activeView()) {
		case 'sync': return 'sync';
		case 'downloads': return 'downloads';
		case 'discover': return 'discover';
		default: return 'tracks'; // tracks + tag views
	}
});

const showsTracksLayout: Accessor<boolean> = createMemo(() => region() === 'tracks');

// ── Player-chrome derivations (pure) ───────────────────────────────────────
// One rule, stated once: the docked player is always the right surface for
// the PLAYING track. The variant (deck strip vs streaming transport) follows
// the track's backend; the dock edge and the big-mode gate both derive from
// the variant; presence only asks "is anything loaded". The current tab
// matters in exactly two places — the idle fallback and the cross-context
// chip. Before this model, variant / dock / chip each answered to a
// different authority (backend vs current tab vs play-time origin) and
// disagreed in reachable states (omnibar cross-source plays, pinned/JIT
// scopes, tag views, downloaded Spotify tracks). Pure functions so the rules
// unit-test without the Solid runtime; the memos below feed them signals.

export function deriveTabContext(s: { view: ActiveView; source: SourceTab }): TabContext {
	// Discover is streaming regardless of source; tag views (interested /
	// basket) fall through to the latent source tab — only the idle fallback
	// and the chip comparison ever consult this, so the latent source never
	// decides anything user-visible while a track is playing.
	return s.view === 'discover' || s.source === 'spotify' || s.source === 'tidal' ? 'streaming' : 'dj';
}

// Which player the strip renders: the deck strip ('local') or the
// Spotify-style transport ('streaming'). The playing track's backend decides.
// The tab only breaks the tie when nothing is loaded — and the strip is
// hidden then; the fallback exists so the dock edge and mode gate stay
// deterministic while invisible.
export function deriveEffectiveVariant(s: {
	playing: PlayingLayout | null;
	source: SourceTab;
	view: ActiveView;
}): PlayingLayout {
	if (s.playing != null) return s.playing;
	return deriveTabContext(s) === 'streaming' ? 'streaming' : 'local';
}

// Which edge the player docks to: the streaming transport parks at the
// bottom like the streaming apps users know; the deck strip sits under the
// topframe where big mode lives. A pure function of the variant — the two
// must never disagree again (a deck strip docked at the bottom edge was
// reachable when dock and variant answered to different authorities).
export function derivePlayerDock(variant: PlayingLayout): 'top' | 'bottom' {
	return variant === 'streaming' ? 'bottom' : 'top';
}

// Big mode enlarges the deck player; the streaming transport has nothing to
// enlarge. Gate on the VARIANT, not the dock edge or the tab: a downloaded
// Spotify track played from the Spotify tab runs on the local backend, and
// big mode is legitimately available for it.
export function deriveBigPlayerAllowed(variant: PlayingLayout): boolean {
	return variant === 'local';
}

// The strip exists only once something has been loaded. 'hidden' is strictly
// the boot state: pause and natural end-of-queue keep the player's current
// track (and therefore the layout mirror) set, so the strip parks on the
// finished track rather than vanishing.
export function derivePlayerPresence(playing: PlayingLayout | null): 'hidden' | 'dock' {
	return playing != null ? 'dock' : 'hidden';
}

// Cross-context chip: playback was started from a tab with the OTHER context
// class than the one being browsed. Pure wayfinding — the docked player
// stays up (it already shows the right surface for the track); the chip is
// the "take me back to where this started" button.
export function deriveChipVisible(s: {
	playing: PlayingLayout | null;
	origin: PlaybackOrigin | null;
	source: SourceTab;
	view: ActiveView;
}): boolean {
	if (s.playing == null || s.origin == null) return false;
	return deriveTabContext(s.origin) !== deriveTabContext(s);
}

// The playingLayout subscription is track-change-cheap by construction: the
// signal only notifies on an actual local ↔ streaming flip (or load/stop),
// so browsing-time track changes within one backend never re-run these memos
// or the region effect observing them.
const effectiveVariant: Accessor<PlayingLayout> = createMemo(() =>
	deriveEffectiveVariant({ playing: playingLayout(), source: activeSource(), view: activeView() }));
const playerDock: Accessor<'top' | 'bottom'> = createMemo(() => derivePlayerDock(effectiveVariant()));
const bigPlayerAllowed: Accessor<boolean> = createMemo(() => deriveBigPlayerAllowed(effectiveVariant()));
const playerPresence: Accessor<'hidden' | 'dock'> = createMemo(() => derivePlayerPresence(playingLayout()));
const chipVisible: Accessor<boolean> = createMemo(() =>
	deriveChipVisible({ playing: playingLayout(), origin: playbackOrigin(), source: activeSource(), view: activeView() }));

// The single "which tab is active" identity for the topframe strip — the
// standard one-active-tab metaphor across BOTH groups. activeSource (catalog
// being browsed) and activeView (content/region) stay independent because
// the renderer reads each with distinct meaning; this only unifies the
// highlight. A source tab is active exactly while we're in a tracks-like
// view (activeView === 'tracks'); otherwise the active state tab wins. So
// entering Discover no longer leaves the previously-browsed source lit.
const activeTabId: Accessor<string> = createMemo(() =>
	activeView() === 'tracks' ? activeSource() : activeView(),
);

export const shell = {
	// ── Reads (signals/memos — subscribe anywhere) ─────────────────────
	activeSource,
	activeView,
	activeTabId,
	currentPlaylistId,
	currentFolderId,
	currentJit,
	emptyState,
	region,
	showsTracksLayout,
	effectiveVariant,
	playerDock,
	bigPlayerAllowed,
	playerPresence,
	chipVisible,
	playbackOrigin,
	sidebarCollapsed,

	// ── Transitions (the only mutators) ────────────────────────────────
	openView(view: ActiveView): void {
		setActiveViewRaw(view);
	},
	// Mirror the playing track's layout class (main.ts feeds it from the
	// player on track change) — THE fact all player chrome derives from.
	// Null ⇔ nothing loaded; the origin is cleared with it (a stopped
	// playback has nothing to point back to).
	setPlayingLayout(layout: PlayingLayout | null): void {
		setPlayingLayoutRaw(layout);
		if (layout === null) setPlaybackOriginRaw(null);
	},
	// Stamp the active tab as the playback origin. Called right before every
	// user-initiated player.play(...) so the cross-context chip reacts to
	// the click, not to the backend's first state event.
	notePlaybackOrigin(): void {
		setPlaybackOriginRaw({ source: activeSource(), view: activeView() });
	},
	openSource(src: SourceTab): void {
		setActiveSourceRaw(src);
	},
	// Playlist / folder / JIT scope are mutually exclusive — setting one
	// clears the others, in the model rather than at every call site.
	setPlaylist(id: string | null): void {
		setCurrentPlaylistIdRaw(id);
		if (id !== null) {
			setCurrentFolderIdRaw(null);
			setCurrentJitRaw(null);
		}
	},
	setFolder(id: string | null): void {
		setCurrentFolderIdRaw(id);
		if (id !== null) {
			setCurrentPlaylistIdRaw(null);
			setCurrentJitRaw(null);
		}
	},
	setJit(jit: JitPlaylist | null): void {
		setCurrentJitRaw(jit);
		if (jit !== null) {
			setCurrentPlaylistIdRaw(null);
			setCurrentFolderIdRaw(null);
		}
	},
	// Source-level "all tracks": no playlist, folder, or JIT. One transition
	// so a navigation to the root can't leave a sibling scope lingering (a
	// rekordbox folder used to survive setPlaylist(null) and leak its
	// breadcrumb onto the next source tab).
	clearScope(): void {
		setCurrentPlaylistIdRaw(null);
		setCurrentFolderIdRaw(null);
		setCurrentJitRaw(null);
	},
	setEmptyState(content: EmptyStateContent | null): void {
		setEmptyStateRaw(content);
	},
	toggleSidebar(): void {
		setSidebarCollapsedRaw((v) => !v);
	},
	// Boot-time hydration from persisted UI state. Not a user transition —
	// callers pass only what survived the session.
	hydrate(persisted: { activeSource?: SourceTab; sidebarCollapsed?: boolean }): void {
		if (persisted.activeSource) setActiveSourceRaw(persisted.activeSource);
		if (persisted.sidebarCollapsed !== undefined) setSidebarCollapsedRaw(persisted.sidebarCollapsed);
	},
};
