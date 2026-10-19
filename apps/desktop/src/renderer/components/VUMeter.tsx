// VUMeter — stereo LED meter in the topframe's user cluster. Sits to the
// left of VolumeControl. Two horizontal rows (L on top, R on bottom),
// each 16 LED segments wide, total ~95px wide.
//
// Data path:
//   Rust audio callback → per-channel max-abs of post-volume output
//   → reporter atomic swap @ 20Hz → state_changed { peak_l, peak_r }
//   → playerStore.peakL / peakR → this component (rAF-smoothed EMA
//      below → per-LED opacity).
//
// Smoothing + rendering:
//   - rAF loop maintains a symmetric exponential moving average of the
//     raw 20Hz tick value (SMOOTH_ALPHA controls strength). This makes
//     the bar read as a level instead of as raw 50ms-window transients.
//   - Each LED's lit-ness is a continuous 0..1 opacity (not binary), so
//     the bar's edge fades smoothly between segments as the smoothed
//     level rises or falls. The CSS pseudo-element overlay consumes
//     the inline `--lit-amount` variable.
//
// Level → segment count: log scale (2.25dB per segment, full scale at
// peak=1.0, floor at -36dB). Log mapping matches mixing-desk convention
// so the gap between LEDs reads as perceptually uniform.

import { For, createSignal, onCleanup, onMount } from 'solid-js';
import { render } from 'solid-js/web';
import * as player from '../player.js';
import { onFrame } from '../ticker.js';
import { readLevel } from '../spectrum.js';

const SEGMENTS = 16;
// 10 green + 4 orange + 2 red — matches a hardware mixer's classic LED
// ladder.
const GREEN_END = 10;  // indices 0..9 green
const ORANGE_END = 14; // indices 10..13 orange; 14..15 red
const FLOOR_DB = -36;
const DB_PER_SEGMENT = -FLOOR_DB / SEGMENTS; // 2.25 dB

// EMA mixing factor per rAF frame. 1.0 = no smoothing (raw value);
// 0.05 = very heavy averaging. 0.15 → ~100ms time constant at 60Hz,
// which feels averaged without lagging the music perceptibly.
const SMOOTH_ALPHA = 0.15;

// Convert linear peak [0..1+] to a FRACTIONAL segment count [0..SEGMENTS].
// The fractional part drives the top-edge LED's partial opacity for the
// "transition" effect — without it the bar would still snap segment-by-
// segment, just at a slower cadence.
function peakToContinuousSegs(peak: number): number {
	if (peak <= 0) return 0;
	const db = 20 * Math.log10(Math.max(peak, 1e-9));
	if (db <= FLOOR_DB) return 0;
	const lit = (db - FLOOR_DB) / DB_PER_SEGMENT;
	return Math.max(0, Math.min(SEGMENTS, lit));
}

function zoneFor(i: number): 'green' | 'orange' | 'red' {
	if (i < GREEN_END) return 'green';
	if (i < ORANGE_END) return 'orange';
	return 'red';
}

function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function VUMeter() {
	const pstate = player.getState();

	// Smoothed per-channel peaks driven by the shared frame ticker. Signals
	// (not store fields) so the 60Hz writes don't pollute the global
	// playerStore — only this component re-renders on each frame.
	const [smoothedL, setSmoothedL] = createSignal(0);
	const [smoothedR, setSmoothedR] = createSignal(0);
	let offFrame: (() => void) | null = null;

	const tick = (): void => {
		// When paused, the sidecar stops emitting peak updates so peakL/peakR
		// retain their last value. Drive the EMA toward 0 in that case so
		// the bar decays to silence rather than freezing at the last live
		// value. (Asymmetric "snap to 0 on pause" was tried and felt jarring;
		// letting the EMA decay reads as a natural fade.)
		let liveL = 0, liveR = 0;
		const cur = pstate.current;
		if (pstate.playing && cur) {
			if (cur.source === 'local') {
				liveL = pstate.peakL;
				liveR = pstate.peakR;
			} else {
				// Streaming (Spotify; future Tidal) has no Rust peaks — derive the
				// level from the system loopback (the OS mixer). It's a mono mix on
				// Windows (Chromium duplicates it across channels), so both rows show
				// the same level. null until the loopback grant lands.
				const lv = readLevel();
				if (lv !== null) { liveL = lv; liveR = lv; }
			}
		}
		setSmoothedL((s) => SMOOTH_ALPHA * liveL + (1 - SMOOTH_ALPHA) * s);
		setSmoothedR((s) => SMOOTH_ALPHA * liveR + (1 - SMOOTH_ALPHA) * s);
	};

	onMount(() => { offFrame = onFrame(tick); });
	onCleanup(() => { offFrame?.(); offFrame = null; });

	// Fractional "how many LEDs are lit" — full segments + a fractional
	// top-edge segment. Per-LED opacity = clamp(value - i, 0, 1).
	const segValueL = (): number => peakToContinuousSegs(smoothedL());
	const segValueR = (): number => peakToContinuousSegs(smoothedR());

	const segIndices = Array.from({ length: SEGMENTS }, (_, i) => i);

	return (
		<div class="vu-meter" title="Output level (L / R)" aria-label="VU meter">
			<div class="vu-row">
				<For each={segIndices}>{(i) => (
					<span
						class="vu-seg"
						data-zone={zoneFor(i)}
						style={{ '--lit-amount': clamp01(segValueL() - i) }}
					/>
				)}</For>
			</div>
			<div class="vu-row">
				<For each={segIndices}>{(i) => (
					<span
						class="vu-seg"
						data-zone={zoneFor(i)}
						style={{ '--lit-amount': clamp01(segValueR() - i) }}
					/>
				)}</For>
			</div>
		</div>
	);
}

export interface VUMeterHandle {
	destroy(): void;
}

export function mountVUMeter(host: HTMLElement): VUMeterHandle {
	const dispose = render(() => <VUMeter />, host);
	return { destroy: dispose };
}