// Renderer-side controller integration.
//
// The Rust audio sidecar owns USB-MIDI device I/O for connected Pioneer
// controllers (PRD: controllers-pioneer). This module ties that into
// the renderer's existing musical-time + transport machinery:
//
//   1. Pushes the active mapping(s) to the sidecar at boot AND on every
//      sidecar_ready event (covers initial boot + crash respawn).
//   2. Subscribes to controller_event Events and dispatches each typed
//      action to the appropriate DeckController / player method.
//   3. Pushes track cue lists to the sidecar on analysis-loaded so the
//      sidecar's LED renderer can light hot-cue pads accurately.
//   4. Tracks SHIFT modifier state for any UI hint that wants it.
//
// What this module does NOT do (yet):
//   - Browse / back navigation dispatch (needs tracklist + sidebar
//     hooks that aren't surfaced today; follow-up chunk).
//   - The Settings → Player → Controllers panel UI.

import { createSignal, type Accessor } from 'solid-js';
import { FLX10_MAPPING } from '@curator/shared';
import type { ControllerEventAction } from '../ipc.js';
import type { DeckController } from './deck/controller.js';
import * as player from './player.js';
import * as analysisStore from './stores/analysisStore.js';
import { isOmnibarOpen, stepOmnibarSelection, pickOmnibarSelection } from './omnibar.js';
import { log as appLog } from './data/log.js';

// Controller input/event traffic is per-event chatty — debug keeps it
// DevTools-only instead of flooding the session log file.
const slog = appLog.for('controllers');

// SHIFT held — reactive so UI can show a modifier-held indicator.
const [shiftHeld, setShiftHeld] = createSignal<boolean>(false);
export const isShiftHeld: Accessor<boolean> = shiftHeld;

// Connected controller models (e.g. ['DDJ-FLX10']) — reactive for the
// Settings → Player → Controllers panel.
const [connectedModels, setConnectedModels] = createSignal<string[]>([]);
export const getConnectedControllers: Accessor<string[]> = connectedModels;

// Focused pane — drives controller browse / back behaviour per PRD
// navigation table. 'tracklist' is the default since the app boots
// into a tracklist view.
const [focusedPane, setFocusedPane] = createSignal<'tracklist' | 'side'>('tracklist');
export const getFocusedPane: Accessor<'tracklist' | 'side'> = focusedPane;

export interface ControllerWiring {
	// Caller's DeckController. Exposed as a getter so we don't capture
	// the value at wire time (deck is created late in boot).
	getDeck: () => DeckController | null;
	// Toggle the player footer's small/big mode for the VIEW button.
	togglePlayerMode: () => void;
	// Tracklist nav — main.ts owns selection state, we just call these.
	stepTracklistSelection: (delta: number) => void;
	playSelectedTrack: () => void;
	// Sidebar nav — wired via the Sidebar component's nav handle.
	stepSidebarSelection: (delta: number) => void;
	// Activate / toggle the row under the sidebar cursor. The string
	// return tells us whether the user activated a playlist (return
	// focus to the tracklist) or just toggled a folder (stay in
	// sidebar). Mirrors SidebarEnterResult.
	enterSidebarSelection: () => 'expanded' | 'collapsed' | 'activated' | 'noop';
	// Clear the sidebar cursor — used when focus leaves the side pane
	// so the visual cursor disappears.
	clearSidebarCursor: () => void;
	// Omnibar — main.ts hands its `openOmnibar` directly.
	openOmnibar: () => void;
}

/**
 * Wire the renderer's controller path. Call once at boot, after the
 * DeckController has been created. Returns an unsubscribe handle.
 *
 * Idempotent — calling twice is a bug (double-dispatches). The handle
 * is kept by main.ts for HMR teardown.
 */
export function wireControllers(opts: ControllerWiring): () => void {
	const log = (msg: string, data?: unknown): void => {
		if (data !== undefined) slog.debug(msg, { data });
		else slog.debug(msg);
	};

	// Push the FLX10 mapping at the earliest opportunity. We do this
	// unconditionally at wire time AND on every sidecar_ready event —
	// the boot push catches the case where the sidecar is already up
	// before this subscriber lands; the sidecar_ready push catches
	// respawn after crash. Either RPC is a no-op if duplicate.
	void pushMapping(log);

	const unsubAudio = window.api.onAudioEvent((evt) => {
		switch (evt.event) {
			case 'sidecar_ready':
				log('sidecar_ready — re-pushing mapping');
				void pushMapping(log);
				void pushCurrentCues(log);
				void pushTrackLoaded(player.getState().current != null, log);
				break;

			case 'controller_connected':
				log(`controller connected: ${evt.model}${evt.firmware ? ` fw=${evt.firmware}` : ''}`);
				setConnectedModels((prev) => (prev.includes(evt.model) ? prev : [...prev, evt.model]));
				void pushCurrentCues(log);
				void pushTrackLoaded(player.getState().current != null, log);
				break;

			case 'controller_disconnected':
				log(`controller disconnected: ${evt.model}`);
				setConnectedModels((prev) => prev.filter((m) => m !== evt.model));
				break;

			case 'controller_event':
				dispatchAction(evt.action, opts, log);
				break;

			// state_changed / ended are handled by player.ts's subscriber.
			default:
				break;
		}
	});

	// Push cue list to sidecar each time analysis (which includes cues)
	// finishes loading for a track.
	const unsubAnalysis = analysisStore.onAnalysisLoaded((trackId) => {
		if (trackId !== analysisStore.getCurrentTrackId()) return;
		void pushCurrentCues(log);
	});

	// Track-load flag — flip whenever the playing track changes.
	let lastCurrentId: string | null = null;
	const unsubPlayer = player.subscribe((s) => {
		const id = s.current?.trackId ?? null;
		if (id !== lastCurrentId) {
			lastCurrentId = id;
			void pushTrackLoaded(id != null, log);
		}
	});

	return () => {
		unsubAudio();
		unsubAnalysis();
		unsubPlayer();
	};
}

function dispatchAction(
	action: ControllerEventAction,
	opts: ControllerWiring,
	log: (msg: string, data?: unknown) => void,
): void {
	const deck = opts.getDeck();
	switch (action.kind) {
		// ─── Renderer-bound ───────────────────────────────────────────
		case 'shift':
			setShiftHeld(action.held);
			break;

		case 'view':
			opts.togglePlayerMode();
			break;

		case 'browse': {
			// One MIDI message per rotary detent. Each event → one
			// selection step in whichever surface owns input right now:
			// omnibar (when open, overrides everything) > focused pane.
			const step = action.delta >= 0 ? 1 : -1;
			if (isOmnibarOpen()) {
				stepOmnibarSelection(step);
			} else if (focusedPane() === 'tracklist') {
				opts.stepTracklistSelection(step);
			} else {
				opts.stepSidebarSelection(step);
			}
			break;
		}

		case 'browse_press':
			// Per PRD navigation table:
			//   omnibar open → activate highlighted result (overrides
			//     pane focus — typing a query and hitting BROWSE-press
			//     loads that result into the deck without touching mouse)
			//   tracklist focus → play selected track
			//   side-pane focus → expand/collapse folder OR enter playlist;
			//     entering a playlist flips focus back to the tracklist
			//     so the next BROWSE rotate moves rows again.
			if (isOmnibarOpen()) {
				pickOmnibarSelection();
			} else if (focusedPane() === 'tracklist') {
				opts.playSelectedTrack();
			} else {
				const result = opts.enterSidebarSelection();
				if (result === 'activated') {
					setFocusedPane('tracklist');
					opts.clearSidebarCursor();
				}
				// 'expanded' / 'collapsed' / 'noop' all keep the user
				// in the side pane with the cursor where it was.
			}
			break;

		case 'back':
			// Per PRD: plain BACK in tracklist → focus side pane; plain
			// BACK in side pane → open omnibar. SHIFT+BACK always opens
			// omnibar. The Rust mapping emits the SAME 'back' action
			// kind for both physical messages (note 0x65 plain, 0x66
			// shifted) so we read isShiftHeld() to disambiguate.
			if (isShiftHeld()) {
				opts.openOmnibar();
			} else if (focusedPane() === 'tracklist') {
				setFocusedPane('side');
			} else {
				opts.openOmnibar();
			}
			break;

		case 'unmapped':
			log(`unmapped raw=[${action.raw.join(', ')}]`);
			break;

		// ─── Audio-affecting → DeckController + player ────────────────
		case 'play_pause':
			player.markUiAction('controller-play');
			void player.togglePause().catch(() => {});
			break;

		case 'cue_trigger': {
			const cue = analysisStore
				.getCurrentAnalysis()
				?.cues.find((c) => c.slot === action.slot);
			if (!cue) {
				log(`cue_trigger slot=${action.slot} but no cue at that slot`);
				break;
			}
			player.markUiAction('controller-cue');
			deck?.triggerCue({
				positionSec: cue.positionSec,
				lengthSec: cue.lengthSec ?? null,
				cueId: cue.id,
			});
			break;
		}

		case 'beat_jump':
			player.markUiAction('controller-beat-jump');
			deck?.jumpByBeats(action.delta);
			break;

		case 'loop_in':
			player.markUiAction('controller-loop-in');
			deck?.loopIn();
			break;

		case 'loop_out':
			player.markUiAction('controller-loop-out');
			deck?.loopOut();
			break;

		case 'loop_n_beats':
			player.markUiAction('controller-loop-n');
			deck?.loopNBeats(action.n);
			break;

		case 'loop_halve':
			player.markUiAction('controller-loop-half');
			deck?.halveLoop();
			break;

		case 'loop_double':
			player.markUiAction('controller-loop-double');
			deck?.doubleLoop();
			break;
	}
}

async function pushMapping(log: (msg: string, data?: unknown) => void): Promise<void> {
	try {
		await window.api['audio:rpc']('controller_set_mapping', {
			device: FLX10_MAPPING.device,
			mapping_json: FLX10_MAPPING,
		});
	} catch (err) {
		log('controller_set_mapping failed', err);
	}
}

async function pushCurrentCues(log: (msg: string, data?: unknown) => void): Promise<void> {
	const cues = analysisStore.getCurrentAnalysis()?.cues ?? [];
	const payload = cues.map((c) => ({
		slot: c.slot,
		position_sec: c.positionSec,
		length_sec: c.lengthSec ?? null,
		color: c.color ?? null,
	}));
	try {
		await window.api['audio:rpc']('controller_set_cues', { cues: payload });
	} catch (err) {
		log('controller_set_cues failed', err);
	}
}

async function pushTrackLoaded(
	loaded: boolean,
	log: (msg: string, data?: unknown) => void,
): Promise<void> {
	try {
		await window.api['audio:rpc']('controller_set_track_loaded', { loaded });
	} catch (err) {
		log('controller_set_track_loaded failed', err);
	}
}
