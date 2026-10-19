// DeckController — owns musical-time logic above the player backend.
//
// Architectural layer (see memory: curator-deck-engine-layering):
//
//   UI components → DeckController → player.ts → Spotify SDK / <audio> / Tidal SDK
//
// player.ts dispatches to whichever backend owns the current track and
// exposes a transport-level API (play/pause/seekBy). DeckController sits
// above that and exposes a *musical* API: triggerCue, jumpByBeats,
// setLoop, setQuantize. Anything that reasons about beats, bars, loops,
// or tempo belongs here — UI components stay backend-agnostic.
//
// Single-deck for now; deck-shaped so a future multi-deck rig is just
// `createDeck(...)` called twice with different player instances (which
// in turn requires the backend split player.ts hasn't done yet).
//
// ─── Quantize semantics ────────────────────────────────────────────────────
//
// Rekordbox-style: when quantize is ON and playback is playing, a
// triggerCue() call DEFERS the seek to the next beat boundary instead of
// firing immediately. Beat-jump buttons are the exception — they're
// inherently beat-indexed and always snap to a beat regardless of the
// quantize toggle. Generic scrubber seeks (waveform clicks, keyboard
// nudge) are NOT quantized.
//
// Precision floor: the scheduler watches player.state.position which
// updates on the Spotify poll tick (50ms in player.ts). A deferred
// trigger fires on the first tick where position >= triggerAt. Worst-
// case timing error = the poll interval. Local <audio> updates faster
// (timeupdate ~250ms but currentTime is read live) so we read
// player.state.position which is rebroadcast on each emit.
//
// ─── Loops ─────────────────────────────────────────────────────────────────
//
// setLoop(in, out) registers a region. While active, the scheduler tick
// detects position >= out and issues seekBy(in - position). This is a
// poll-based wrap — there will be an audible seam (~50ms on local, more
// on Spotify because of seek latency). Sample-accurate loops require
// Web Audio API on local; deferred per the engine-layering memory.

import { createSignal, createRoot, createEffect, type Accessor } from 'solid-js';
import * as player from '../player.js';
import * as analysisStore from '../stores/analysisStore.js';
import { computeBeatJumpTarget } from './beatmath.js';

export interface LoopRegion {
	inSec: number;
	outSec: number;
	// Optional reference back to the cue this loop came from — used so a
	// second click on the same cue can toggle the loop off without the
	// host having to track that state itself.
	sourceCueId?: string;
}

export interface DeckController {
	// Quantize ─────────────────────────────────────────────────────────────
	quantizeOn: Accessor<boolean>;
	setQuantize(on: boolean): void;
	toggleQuantize(): void;

	// Pending cue trigger — true between the click and the deferred fire.
	// UI can read this to flash the cue button so the user sees the click
	// landed. Carries the positionSec so a UI can match it to the cue.
	pendingTrigger: Accessor<number | null>;

	// Active loop region (null when no loop). Reactive — UI paints from
	// this signal.
	activeLoop: Accessor<LoopRegion | null>;

	// Armed-but-not-yet-active loop-in candidate, in seconds. Set by
	// loopIn() and cleared on loopOut() activation, exitLoop(), or a
	// successful triggerCue/loopNBeats. UI shows the "in" button in
	// a primed state while this is non-null so the user can see the
	// click landed.
	loopArmed: Accessor<number | null>;

	// Musical actions ──────────────────────────────────────────────────────

	// Seek to positionSec. If quantize is ON and we're playing, defer the
	// seek to the next beat boundary. If the cue has lengthSec > 0, also
	// activate the loop region [positionSec, positionSec + lengthSec].
	// Clicking the same loop-cue twice toggles the loop OFF and clears
	// any pending trigger for that cue.
	triggerCue(opts: { positionSec: number; lengthSec?: number | null; cueId?: string }): void;

	// Beat-indexed seek. Always snap-target (never deferred) because the
	// target IS a beat. No-op when no beatgrid is loaded.
	jumpByBeats(deltaBeats: number): void;

	// Loop management — for callers that want to set/clear a loop directly
	// without going through triggerCue (e.g. future loop in/out buttons).
	setLoop(region: LoopRegion): void;
	exitLoop(): void;

	// Manual loop placement (IN/OUT buttons).
	//   loopIn(): mark current playback position as the loop's start
	//     candidate. Exits any active loop first so a new region can be
	//     defined cleanly. Quantize snaps the in-point to the nearest
	//     beat when enabled.
	//   loopOut(): if a loop-in candidate is armed AND its position is
	//     before current playback position, activate the loop from
	//     [armed_in, current_pos]. Quantize snaps the out-point.
	//     No-op when nothing is armed or the out would be ≤ in.
	loopIn(): void;
	loopOut(): void;

	// N-beat loop from current position (e.g. the "4" button creates a
	// 4-beat loop). Doubles as an EXIT: if a loop is already active,
	// calling loopNBeats(n) just exits the active loop regardless of n.
	// No-op when no beatgrid is loaded (can't compute beat length).
	loopNBeats(n: number): void;

	// Halve / double the active loop's length. Loop-in stays put; out
	// moves to in + length × {0.5, 2}. No-op when no loop is active or
	// when the resulting region would be degenerate.
	halveLoop(): void;
	doubleLoop(): void;

	// Lifecycle ────────────────────────────────────────────────────────────
	destroy(): void;
}

const QUANTIZE_LS_KEY = 'curator.quantize';

function loadQuantize(): boolean {
	try {
		const v = localStorage.getItem(QUANTIZE_LS_KEY);
		if (v === '0') return false;
		if (v === '1') return true;
	} catch { /* private mode */ }
	return true; // default ON
}

// Binary-search the beatgrid for the largest index whose beat time is
// <= pos. Returns -1 when pos is before the first beat. Same shape as
// the inline search that used to live in main.ts:jumpByBeats.
function beatIndexAtOrBefore(beats: Float32Array, pos: number): number {
	if (beats.length === 0 || pos < beats[0]!) return -1;
	let lo = 0, hi = beats.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >>> 1;
		if (beats[mid]! <= pos) lo = mid; else hi = mid - 1;
	}
	return lo;
}

// Time of the next beat strictly after pos. Returns null when pos is
// past the last beat (no future beat to wait for — fire immediately).
function nextBeatAfter(beats: Float32Array, pos: number): number | null {
	const idx = beatIndexAtOrBefore(beats, pos);
	const nextIdx = idx + 1;
	if (nextIdx >= beats.length) return null;
	return beats[nextIdx]!;
}

// Snap an arbitrary time to the closest beat in the grid. Used when the
// quantize trigger fires — both the trigger MOMENT (= next beat) and the
// landing POSITION need to be beat-aligned so the music re-enters in
// phase. Without this, an off-beat cue (manual placement or imported
// from a source with imprecise positions) gets us a clean trigger but
// an out-of-phase landing.
function nearestBeat(beats: Float32Array, t: number): number {
	if (beats.length === 0) return t;
	if (t <= beats[0]!) return beats[0]!;
	if (t >= beats[beats.length - 1]!) return beats[beats.length - 1]!;
	const idx = beatIndexAtOrBefore(beats, t);
	const before = beats[idx]!;
	const after  = beats[idx + 1]!;
	return (t - before) <= (after - t) ? before : after;
}

export interface CreateDeckOptions {
	// Host can supply a snap callback (typically MainWaveformView's
	// snapTo) so the played-position overlay does a hard cut on
	// programmatic seeks. Optional — deck works without it, the overlay
	// just animates between positions instead.
	snapTo?: (positionSec: number) => void;
}

export function createDeck(opts: CreateDeckOptions = {}): DeckController {
	const [quantizeOn, setQuantizeOnSignal] = createSignal<boolean>(loadQuantize());
	const [pendingTrigger, setPendingTrigger] = createSignal<number | null>(null);
	const [activeLoop, setActiveLoop] = createSignal<LoopRegion | null>(null);
	const [loopArmed, setLoopArmed] = createSignal<number | null>(null);

	// Pending seek state — set when a trigger is deferred. Re-read on each
	// scheduler tick. Cleared after the seek fires (or when superseded by
	// another trigger or by exitLoop). Only set on streaming backends;
	// local-backend triggers are pushed into the sidecar (see armedLanding).
	let pending: { triggerAt: number; seekTo: number } | null = null;

	// Wall-clock deadline suppressing the scheduler's loop-wrap branch
	// while an engine-side beat jump is in flight — see jumpByBeats for
	// the self-cancel hazard it closes.
	let jumpGuardUntil = 0;

	// Local-backend twin of `pending`. The sidecar owns the actual sample-
	// accurate fire; this is just enough bookkeeping to handle cancel
	// scenarios (quantize-off, pause, manual seek) without needing to
	// query the sidecar. Set when arm_trigger is sent; cleared when the
	// trigger fires (player.onTriggerFired) or any cancel path runs.
	let armedLanding: number | null = null;

	// Deferred native-loop config for the local + quantize + cue+loop
	// path. We cannot push setNativeLoop synchronously like the other
	// paths do — the cursor is OUTSIDE [inSec, outSec) during the
	// quantize wait, so the audio callback's wrap check
	// (source_pos >= out_frames) would yank the cursor back into the
	// loop immediately, well before the cue trigger was meant to fire.
	// Instead we stash the region here and push setNativeLoop at
	// trigger_fired time (or in cancel paths that fire immediately).
	let armedLoopRegion: LoopRegion | null = null;

	function setQuantize(on: boolean): void {
		setQuantizeOnSignal(on);
		try { localStorage.setItem(QUANTIZE_LS_KEY, on ? '1' : '0'); } catch { /* */ }
		if (!on) {
			// Streaming backend: flush the renderer-side pending fire.
			if (pending) flushPending();
			// Local backend: replace the quantized arm with a near-now
			// crossfaded seek. Toggling quantize off mid-arm should feel
			// like "fire it now," not "silently cancel." We DON'T clear
			// armedLanding/armedLoopRegion here — seek_with_xfade arms a
			// new pending_trigger and the audio callback will fire it
			// ~30 ms later; trigger_fired's effect then pushes the
			// deferred loop and clears the rest.
			if (armedLanding != null) {
				player.armNativeTrigger(null);
				void player.seekWithXfade(armedLanding);
			}
		}
	}

	function toggleQuantize(): void { setQuantize(!quantizeOn()); }

	function flushPending(): void {
		if (!pending) return;
		const target = pending.seekTo;
		pending = null;
		setPendingTrigger(null);
		performSeek(target);
	}

	function performSeek(positionSec: number): void {
		const st = player.getState();
		if (!st.current) return;
		// Manual seek invalidates any quantize-armed trigger — the sidecar
		// clears its own state in engine.rs::seek, but the renderer also
		// owns UI flash + the armedLanding bookkeeping. Deferred cue+loop
		// goes too: the loop bounds were tied to the trigger that's now
		// being abandoned.
		if (armedLanding != null) {
			armedLanding = null;
			setPendingTrigger(null);
			if (armedLoopRegion) {
				armedLoopRegion = null;
				setActiveLoop(null);
			}
		}
		if (st.duration > 0) opts.snapTo?.(positionSec);
		player.seekBy(positionSec - st.position).catch(() => {});
	}

	// Single mutator for loop state — keeps the deck signal and the
	// player's native-loop config in lockstep. The native call is a no-op
	// on backends without native looping (Spotify); on the Web Audio local
	// backend it configures source.loop/loopStart/loopEnd so the wrap is
	// sample-accurate. The deck's poll-based scheduler also watches the
	// loop, which is harmless redundancy on local (position never exceeds
	// loopEnd) and the only mechanism on Spotify.
	function applyLoop(region: LoopRegion | null): void {
		setActiveLoop(region);
		player.setNativeLoop(region ? { inSec: region.inSec, outSec: region.outSec } : null);
	}

	function triggerCue(o: { positionSec: number; lengthSec?: number | null; cueId?: string }): void {
		// Toggle-off shortcut: clicking the same loop-cue while it's active
		// exits the loop. Matching is robust against both halves slipping:
		//   - cueId match: clean case, sourceCueId was set at activation.
		//   - position match within MATCH_TOL_SEC: the cue UUID changed (e.g.
		//     a rekordbox re-sync mid-session wiped + reinserted cue rows so
		//     CueData.id no longer equals the activeLoop's sourceCueId) but
		//     the click is obviously the same loop because it lands at the
		//     loop's in-point. Tolerance covers quantize snap drift between
		//     o.positionSec (raw cue position) and cur.inSec (snapped to
		//     nearest beat at activation). 50 ms is shorter than the
		//     fastest plausible beat (1200 BPM ≈ 50 ms/beat) so this never
		//     collapses two distinct cues into one.
		const cur = activeLoop();
		const MATCH_TOL_SEC = 0.05;
		const sameAsActive =
			cur != null &&
			(
				(o.cueId !== undefined && cur.sourceCueId === o.cueId) ||
				Math.abs(cur.inSec - o.positionSec) < MATCH_TOL_SEC
			);
		if (sameAsActive) {
			exitLoop();
			pending = null;
			setPendingTrigger(null);
			// Drop any sidecar-armed trigger so the about-to-be-exited
			// loop isn't re-armed on the next beat. exitLoop already
			// pushed setNativeLoop(null) via applyLoop so the deferred
			// armedLoopRegion stash also goes — clear the slot too.
			if (armedLanding != null) {
				armedLanding = null;
				player.armNativeTrigger(null);
			}
			armedLoopRegion = null;
			return;
		}

		const st = player.getState();
		const isLocal = st.current?.source === 'local';
		const beats = analysisStore.getCurrentAnalysis()?.beats ?? null;
		const shouldQuantize = quantizeOn() && st.playing && beats && beats.length > 1;

		// When quantize is ON, snap BOTH the landing position and the
		// loop's outSec to the nearest beat. The trigger MOMENT is already
		// beat-aligned (we wait for the next beat). Without this, an off-
		// beat cue (manual placement, imperfect import) lands the music
		// out of phase even though the trigger itself was on-beat.
		// When OFF, fire to the cue's exact position — the user explicitly
		// asked for "no quantize" and gets sample-perfect cue jumps.
		const landingSec = (shouldQuantize && beats)
			? nearestBeat(beats, o.positionSec)
			: o.positionSec;
		const loopOutSec = (o.lengthSec && o.lengthSec > 0)
			? ((shouldQuantize && beats)
				? nearestBeat(beats, o.positionSec + o.lengthSec)
				: o.positionSec + o.lengthSec)
			: null;

		// Defer-vs-immediate decision. 150 ms safety margin covers the
		// reporter tick (≤50 ms) + arm_trigger RPC roundtrip (≤30 ms) so
		// the sidecar almost never rejects a future-beat trigger because
		// the cursor caught up. Without this margin, cues whose nextBeat
		// is within ~100 ms strand on the sidecar and have to be rescued
		// by the rejection fallback — which is a hard seek with no
		// crossfade and feels exactly like the "jumps without waiting +
		// click" the user reported.
		const FIRE_NOW_MARGIN_SEC = 0.15;
		const nextBeat = shouldQuantize ? nextBeatAfter(beats!, st.position) : null;
		const willDefer = !!shouldQuantize
			&& nextBeat != null
			&& nextBeat - st.position > FIRE_NOW_MARGIN_SEC;

		const newRegion: LoopRegion | null = loopOutSec != null
			? { inSec: landingSec, outSec: loopOutSec, sourceCueId: o.cueId }
			: null;

		// Loop region setup. On local we ALWAYS defer the native loop
		// regardless of immediate vs. quantized fire, because both paths
		// have a non-zero gap between renderer call and audible cursor
		// jump (quantized: variable, up to a beat; immediate via
		// seek_with_xfade: ~30 ms). The audio callback's wrap check is
		// `source_pos >= out_frames`; the cursor is at the user's
		// playback position which is OUTSIDE [in, out), so pushing the
		// loop synchronously would yank the cursor on the very next
		// callback. Deferring until trigger_fired keeps the cursor
		// playing forward naturally until the seek lands; the loop then
		// engages from inside.
		//
		// Streaming backends keep the existing synchronous applyLoop
		// semantics — set_loop is effectively a no-op on the sidecar
		// when it's not driving the active backend, and the renderer's
		// scheduler handles the wrap.
		if (newRegion) {
			if (isLocal) {
				setActiveLoop(newRegion);
				// Drop any prior sidecar loop so its wrap doesn't fire
				// during the wait. UI signal already reflects the
				// new (deferred) region.
				player.setNativeLoop(null);
				armedLoopRegion = newRegion;
			} else {
				applyLoop(newRegion);
				armedLoopRegion = null;
			}
		} else {
			// Point-cue trigger that isn't a loop — clear any active loop
			// so the user doesn't get pulled back to it after the seek.
			if (cur) applyLoop(null);
			armedLoopRegion = null;
		}

		// pendingTrigger carries the ORIGINAL cue positionSec (not the
		// snapped one) so CueGridView's flash matching by positionSec
		// still recognises the pending cue.
		setPendingTrigger(o.positionSec);

		if (!willDefer) {
			// Immediate-fire path. On local we still route through the
			// sidecar's seek_with_xfade so the seam gets a crossfade —
			// a hard engine.seek here clicks like pause/play (audio →
			// silence → audio = DC discontinuity). ~30 ms latency from
			// RPC to audible jump, imperceptible vs. the click.
			// Streaming backends fall back to performSeek as before
			// (no sample-accurate seek to push down).
			pending = null;
			if (isLocal) {
				player.armNativeTrigger(null);
				armedLanding = landingSec;
				void player.seekWithXfade(landingSec);
			} else {
				armedLanding = null;
				setPendingTrigger(null);
				performSeek(landingSec);
			}
			return;
		}

		if (isLocal) {
			// Quantized deferred fire — push the trigger into the
			// sidecar, audio callback fires sample-accurately at the
			// beat boundary with the crossfade. Renderer learns via
			// player.onTriggerFired and clears UI flash + pushes the
			// deferred loop there.
			//
			// Rejection fallback: sidecar may still say `armed: false`
			// if RPC took longer than the safety margin (rare with
			// 150 ms but possible under load). Re-route through
			// seek_with_xfade so the cue still lands click-free —
			// armedLanding stays set, trigger_fired clears it and
			// pushes armedLoopRegion at the audible moment. Race guards
			// check no later cue press superseded this arm while the
			// RPC was in flight.
			pending = null;
			armedLanding = landingSec;
			const armingFor = landingSec;
			const flashFor = o.positionSec;
			player.armNativeTrigger({ triggerAtSec: nextBeat!, seekToSec: landingSec })
				.then(({ armed }) => {
					if (armed) return;
					if (armedLanding !== armingFor) return;
					if (pendingTrigger() !== flashFor) return;
					void player.seekWithXfade(armingFor);
				});
		} else {
			// Streaming backend (Spotify): no sample-accurate seek to push
			// down — use the existing renderer-poll scheduler.
			armedLanding = null;
			pending = { triggerAt: nextBeat!, seekTo: landingSec };
		}
	}

	// Renderer-computed jump — the pre-sidecar path, kept for streaming
	// backends and the sidecar-disabled fallback. Inherits the staleness
	// caveat the engine path exists to fix: the target comes from the
	// renderer's position view (up to a reporter tick behind the audible
	// cursor), so landings can be off-pocket by that much.
	function rendererJumpByBeats(beats: Float32Array, deltaBeats: number): void {
		const st = player.getState();
		const duration = st.duration > 0 ? st.duration : Number.POSITIVE_INFINITY;
		performSeek(computeBeatJumpTarget(beats, st.position, deltaBeats, duration));
	}

	function jumpByBeats(deltaBeats: number): void {
		const beats = analysisStore.getCurrentAnalysis()?.beats ?? null;
		if (!beats || beats.length < 2) return;
		const st = player.getState();
		if (!st.current) return;
		// Phase-preserving jump (Pioneer CDJ "Beat Jump" semantics):
		// translate the playhead by EXACTLY `deltaBeats` musical beats
		// while keeping the sub-beat offset (the "and", "e", "uh").
		// Inherently beat-indexed, so the quantize toggle never gates it.
		if (st.current.source !== 'local') {
			rendererJumpByBeats(beats, deltaBeats);
			return;
		}
		// Local: the sidecar computes the landing from its authoritative
		// cursor (engine.rs::jump_beats) so the jump is exactly N beats
		// regardless of renderer position staleness, de-clicked by the
		// same 10 ms crossfade cues use — and it translates an active
		// native loop atomically with the playhead.
		//
		// A jump is a manual transport gesture — the engine clobbers any
		// pending cue trigger, so drop the renderer bookkeeping in step
		// (same invalidation performSeek runs) or the cue pad flashes
		// forever.
		if (armedLanding != null) {
			armedLanding = null;
			setPendingTrigger(null);
			if (armedLoopRegion) {
				armedLoopRegion = null;
				setActiveLoop(null);
			}
		}
		// Suppress the scheduler's loop-wrap branch until the armed jump
		// audibly fires (~50 ms pad + xfade after the RPC lands). With a
		// backward loop-move, the activeLoop signal updates on the RPC
		// response while a stale position event can still read past the
		// moved outSec — the wrap branch would performSeek(loop.inSec),
		// and engine.seek clears the pending trigger: the jump silently
		// self-cancels. Timestamp guard instead of a boolean so key-
		// repeat can't strand it; on local the native wrap is the real
		// mechanism and the renderer branch is only redundancy anyway.
		jumpGuardUntil = performance.now() + 300;
		void player.jumpNativeBeats(deltaBeats).then((res) => {
			if (!res) {
				// RPC failed — sidecar disabled or dead. Renderer walk
				// still works (plain seek path), just without the
				// crossfade + staleness guarantees.
				rendererJumpByBeats(beats, deltaBeats);
				return;
			}
			if (!res.jumped) {
				// Engine rejected. With an active loop this is the
				// loop-at-track-edge case — correct result is a no-op
				// (Mixxx semantics). Without one it means the engine has
				// no grid (push failed / raced load): fall back so the
				// gesture still lands.
				if (!activeLoop()) rendererJumpByBeats(beats, deltaBeats);
				return;
			}
			opts.snapTo?.(res.targetSec);
			if (res.loopInSec != null && res.loopOutSec != null) {
				// Signal only — do NOT setNativeLoop: the engine moves its
				// native region itself at fire time, and re-pushing now
				// would race the pending fire (set_loop's wrap check could
				// yank the cursor before the jump trigger consumes).
				setActiveLoop({
					inSec: res.loopInSec,
					outSec: res.loopOutSec,
					sourceCueId: activeLoop()?.sourceCueId,
				});
			}
		});
	}

	function setLoop(region: LoopRegion): void {
		applyLoop(region);
	}

	function exitLoop(): void {
		applyLoop(null);
		setLoopArmed(null);
		// Hard-reset every in-flight cue arm + UI flash. Otherwise a
		// stranded pendingTrigger (e.g. seek_with_xfade hit the end-of-
		// track fallback at engine.rs:767 and never emitted TriggerFired;
		// or a scheduler tick's performSeek cleared armedLanding before
		// the real trigger fired) leaves a blinking cue pad after the
		// user has explicitly asked for the loop to end. Same cleanup
		// the sameAsActive toggle-off path runs at L292-L304.
		pending = null;
		setPendingTrigger(null);
		if (armedLanding != null) {
			armedLanding = null;
			player.armNativeTrigger(null);
		}
		armedLoopRegion = null;
	}

	// Snap helper — same beat-snap rule used everywhere else: snap when
	// quantize is on AND we have a beatgrid; otherwise pass through.
	function maybeSnap(pos: number): number {
		const beats = analysisStore.getCurrentAnalysis()?.beats ?? null;
		if (!quantizeOn() || !beats || beats.length < 2) return pos;
		return nearestBeat(beats, pos);
	}

	function loopIn(): void {
		const st = player.getState();
		if (!st.current) return;
		// Re-arming exits any active loop so the next OUT defines a fresh
		// region rather than mutating the existing one — matches CDJ
		// behaviour where IN during playback starts a new loop cycle.
		if (activeLoop() != null) applyLoop(null);
		setLoopArmed(maybeSnap(st.position));
	}

	function loopOut(): void {
		const armed = loopArmed();
		if (armed == null) return;
		const st = player.getState();
		if (!st.current) return;
		const outSec = maybeSnap(st.position);
		if (outSec <= armed) {
			// Out before in — common when the user clicks OUT immediately
			// after IN. Drop the armed in; user can try again.
			setLoopArmed(null);
			return;
		}
		setLoopArmed(null);
		applyLoop({ inSec: armed, outSec });
	}

	function loopNBeats(n: number): void {
		// Loop active → exit. The "4" button doubles as the exit toggle.
		if (activeLoop() != null) {
			exitLoop();
			return;
		}
		const st = player.getState();
		if (!st.current) return;
		const beats = analysisStore.getCurrentAnalysis()?.beats ?? null;
		if (!beats || beats.length < 2) return;
		// In-point: snap to current beat if quantize is on, else use raw
		// position. Out-point: always n beats forward in the grid (the
		// "N-beat loop" promise — beat-counted not seconds-counted, so
		// it survives variable BPM).
		const inSec = maybeSnap(st.position);
		const inIdxRaw = beatIndexAtOrBefore(beats, inSec);
		const inIdx = inIdxRaw < 0 ? 0 : inIdxRaw;
		const outIdx = inIdx + n;
		if (outIdx >= beats.length) return;
		const outSec = beats[outIdx]!;
		setLoopArmed(null);
		applyLoop({ inSec, outSec });
	}

	function halveLoop(): void {
		const cur = activeLoop();
		if (!cur) return;
		const len = cur.outSec - cur.inSec;
		if (len <= 0) return;
		// Quantize-on: snap the new out-point to the beatgrid so a
		// 4-beat loop halves cleanly to 2 beats etc. instead of landing
		// on an off-grid mid-beat position. Quantize-off: exact halving.
		let newOut = maybeSnap(cur.inSec + len / 2);
		// Floor of 1 ms — anything shorter is unusable in practice and
		// would only stress the audio callback's wrap-detection path.
		// Also covers the case where the snap collapsed onto cur.inSec
		// (loop already shorter than one beat with quantize on).
		if (newOut - cur.inSec < 0.001) return;
		applyLoop({ ...cur, outSec: newOut });
	}

	function doubleLoop(): void {
		const cur = activeLoop();
		if (!cur) return;
		const len = cur.outSec - cur.inSec;
		if (len <= 0) return;
		// Same quantize semantics as halveLoop — keeps powers-of-two
		// beat loops landing on actual beats after each ×2 press.
		const newOut = maybeSnap(cur.inSec + len * 2);
		if (newOut - cur.inSec < 0.001) return;
		applyLoop({ ...cur, outSec: newOut });
	}

	// Scheduler + cancel-path effects — all driven by player state updates
	// so they re-fire on every reporter tick. Three concerns:
	//   1. Streaming-backend deferred trigger that wants to fire on a beat.
	//   2. Active loop region whose `out` has been crossed (streaming
	//      fallback + harmless redundancy on local — the sidecar wraps
	//      first sample-accurately, by the next poll position is already
	//      back inside [in, out)).
	//   3. Local-backend "pause while armed" cancel — drop the sidecar
	//      trigger if playback stopped before it could fire.
	//   4. Local-backend trigger_fired — clear UI flash + snap the
	//      waveform overlay at the audible moment, not the next-poll-
	//      after moment.
	const dispose = createRoot((d) => {
		createEffect(() => {
			const st = player.getState();
			const pos = st.position;
			if (!st.current || !st.playing) {
				// Playback stopped — local-armed trigger can't fire
				// without playback driving the cursor toward triggerAt.
				// Drop it so a future resume doesn't surprise the user.
				// Deferred cue+loop goes too: the loop was tied to a
				// trigger that's now abandoned, dropping it from the
				// UI matches user expectation that paused = nothing
				// armed.
				if (armedLanding != null) {
					armedLanding = null;
					setPendingTrigger(null);
					player.armNativeTrigger(null);
					if (armedLoopRegion) {
						armedLoopRegion = null;
						setActiveLoop(null);
					}
				}
				return;
			}

			// 1) Fire any streaming-backend deferred trigger.
			if (pending && pos >= pending.triggerAt) {
				flushPending();
				return; // next tick will handle loop check at the new position
			}

			// 2) Loop wrap. Only relevant when no trigger is pending — a
			//    pending trigger will reset position anyway. Stands down
			//    while an engine-side beat jump is in flight (a stale
			//    position event vs. a just-moved loop region would make
			//    this performSeek cancel the armed jump — see jumpByBeats).
			const loop = activeLoop();
			if (loop && pos >= loop.outSec && performance.now() >= jumpGuardUntil) {
				// Seek back to the loop's in point. Same path as a normal
				// seek so the waveform overlay snaps cleanly.
				performSeek(loop.inSec);
			}
		});

		// Sidecar fired the armed trigger — clear UI flash, drop the
		// armedLanding bookkeeping, and snap the waveform overlay to the
		// post-jump position (state.position was already updated by
		// player.ts's trigger_fired handler ahead of the tick bump).
		//
		// Cue+loop case: the native loop was deferred (see triggerCue);
		// push it to the sidecar now so subsequent wraps fire on-beat.
		// Worst case the cursor has played ~50 ms past landingSec by the
		// time the RPC arrives, which is fine for any loop longer than
		// that — the wrap just fires one out_frames later than perfect.
		createEffect(() => {
			player.onTriggerFired(); // tracked
			if (armedLanding == null) {
				// A sidecar TriggerFired arrived with no armedLanding —
				// some parallel path (performSeek's wrap branch, pause
				// cancel, an overlapping triggerCue) already cleared the
				// bookkeeping. Clear any stranded UI flash too so the
				// cue pad doesn't keep blinking after its loop landed.
				if (pendingTrigger() != null) setPendingTrigger(null);
				return;
			}
			if (armedLoopRegion) {
				player.setNativeLoop({ inSec: armedLoopRegion.inSec, outSec: armedLoopRegion.outSec });
				armedLoopRegion = null;
			}
			armedLanding = null;
			setPendingTrigger(null);
			opts.snapTo?.(player.getState().position);
		});

		return d;
	});

	return {
		quantizeOn,
		setQuantize,
		toggleQuantize,
		pendingTrigger,
		activeLoop,
		loopArmed,
		triggerCue,
		jumpByBeats,
		setLoop,
		exitLoop,
		loopIn,
		loopOut,
		loopNBeats,
		halveLoop,
		doubleLoop,
		destroy: dispose,
	};
}
