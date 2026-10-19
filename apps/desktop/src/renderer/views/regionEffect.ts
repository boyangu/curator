// Region derivation — THE single writer of view-region visibility, body
// data attributes, and player chrome (planning/tech/frontend-architecture.md
// F1). Everything here derives from the shell view model; no other code
// in the renderer may write these DOM facts. That single-writer invariant
// is what makes stale async repaints structurally unable to mis-render a
// region — there is nothing for them to overwrite.
//
// Mounted once from boot() AFTER MainPane has rendered the region hosts.
// Lives in views/ (not viewmodel/) because it is exactly the boundary
// where logical state becomes DOM.

import { createEffect, createRoot } from 'solid-js';
import { shell } from '../viewmodel/shell.js';
import { createPlayerDockTransition } from './playerDockTransition.js';

export interface RegionEffectOptions {
	// Applied-mode hand-off into the player wiring — the effect decides WHAT
	// (preference gated by the big-mode allowance) and writes the body
	// attribute; main.ts owns the signal MainWaveformView's paint dispatch
	// reads.
	applyPlayerMode: (mode: 'small' | 'big') => void;
	// Deck-player big/small preference, persisted by the toggle path. A
	// reactive accessor so a toggle re-derives the applied mode through this
	// effect instead of an imperative call-through.
	deckPlayerModePref: () => 'small' | 'big';
}

export interface RegionEffectHandle {
	dispose(): void;
}

export function mountRegionEffect(opts: RegionEffectOptions): RegionEffectHandle {
	return createRoot((dispose) => {
		// Dock/presence choreographer — animates the strip between edges (and
		// in from hidden) around the attribute commits below. It writes only
		// element styles and a throwaway ghost node, never body attributes,
		// so this file remains the single writer the boundary check enforces.
		const dockTransition = createPlayerDockTransition();
		const hosts = {
			tracks: document.getElementById('tracks-view'),
			sync: document.getElementById('sync-view'),
			downloads: document.getElementById('dl-view'),
			discover: document.getElementById('discover-view'),
			empty: document.getElementById('tab-empty'),
		};

		createEffect(() => {
			const region = shell.region();
			const view = shell.activeView();
			// Empty-state panel (onboarding / smart-playlist watermark)
			// belongs only to the source-bound tracks view, and occupies the
			// table's slot — table and panel are mutually exclusive.
			const emptyActive = shell.emptyState() !== null && view === 'tracks';

			if (hosts.tracks) hosts.tracks.hidden = region !== 'tracks' || emptyActive;
			if (hosts.empty) hosts.empty.hidden = !emptyActive;
			if (hosts.sync) hosts.sync.hidden = region !== 'sync';
			if (hosts.downloads) hosts.downloads.hidden = region !== 'downloads';
			if (hosts.discover) hosts.discover.hidden = region !== 'discover';

			// Body attribute drives the CSS side (sidebar collapse, filter-bar
			// visibility, grid areas) — same contract as before, one writer now.
			document.body.setAttribute('data-view', view);
		});

		// User-toggled sidebar collapse (button / Ctrl-B) — zeroes the sidebar
		// grid track via CSS without touching the persisted width.
		createEffect(() => {
			document.body.toggleAttribute('data-sidebar-collapsed', shell.sidebarCollapsed());
		});

		// Player chrome — dock edge + presence (hidden until a first load).
		// Both are pure shell derivations of the playing track's layout; this
		// effect is their only path into the DOM. The choreographer wraps the
		// commit so edge flips and the first unfold run the one-beat push.
		createEffect(() => {
			const dock = shell.playerDock();
			const presence = shell.playerPresence();
			dockTransition.apply({ dock, presence }, () => {
				document.body.dataset.playerDock = dock;
				document.body.dataset.playerPresence = presence;
			});
		});

		// Applied player mode: the stored deck preference wherever big mode
		// is allowed (deck variant), forced small elsewhere — WITHOUT
		// clobbering the stored preference, so returning to a deck context
		// restores the user's last choice.
		createEffect(() => {
			const mode = shell.bigPlayerAllowed() ? opts.deckPlayerModePref() : 'small';
			document.body.dataset.playerMode = mode;
			opts.applyPlayerMode(mode);
		});

		return {
			dispose: () => {
				dockTransition.dispose();
				dispose();
			},
		};
	});
}
