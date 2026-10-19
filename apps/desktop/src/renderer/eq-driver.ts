// Live now-playing equalizer driver.
//
// The `.now-playing-eq` bars (the playing-track index cell + the now-playing
// chip) are CSS-keyframe fakes by default. While something plays, this drives
// them from real audio: it sets --np-eq-1..N + an `eq-live` class on <html>,
// and the CSS bars read the vars (see style.css). Only one track plays at a
// time, so every eq instance reads the same vars and stays in sync.
//
// Two signal sources, by backend:
//   - local files: the audio engine's own output peaks (player state peakL/R,
//     ~20 Hz). They come from the Rust mix bus, so they follow output-device
//     switches automatically and don't depend on the OS volume slider.
//   - streaming (Spotify/Tidal): the system-loopback FFT (spectrum.ts) — the
//     engine never sees that audio. The capture re-arms itself on device
//     changes (spectrum.followOutputDeviceChanges).
//
// Never frozen: if the live signal reads as silence for SILENT_MS while
// playback runs (a capture still bound to an old device, a refused grant, a
// genuinely silent intro), we drop `eq-live` so the keyframe animation takes
// over instead of flat stubs, and pick the live signal back up as soon as it
// returns. Subscribes to the shared ticker ONLY while playing; on pause the
// heights freeze, and when nothing is loaded `eq-live` is dropped.

import * as player from './player.js';
import { onFrame } from './ticker.js';
import { followOutputDeviceChanges, readBands } from './spectrum.js';

const BANDS = 4;
const FLOOR = 18; // min bar height (%), so idle bars never fully collapse
const EMA = 0.5;  // per-frame smoothing toward the new level
const SILENCE = 0.02;
const SILENT_MS = 2000;
const levels = new Array<number>(BANDS).fill(0);
let silentSince: number | null = null;

// Local backend: one loudness level for the whole mix, spread over the bars
// with slow per-bar wobble (distinct rates + phases) so they read as a meter
// rather than four identical columns. Loudness is the real signal; the shape
// across bars is decorative — the engine reports levels, not a spectrum.
const WOBBLE_HZ = [0.83, 1.17, 0.97, 1.39];
const WOBBLE_PHASE = [0, 1.9, 3.7, 5.3];
let localLevel = 0;
function localBands(now: number): number[] {
	const s = player.getState();
	const peak = Math.max(s.peakL, s.peakR);
	localLevel += (peak - localLevel) * 0.35;
	// Mastered music peaks high (0.5-1.0 pre-volume); stretch the top of the
	// range so beats visibly pump instead of pinning the bars.
	const loud = Math.min(1, Math.max(0, (localLevel - 0.12) / 0.8));
	const t = now / 1000;
	return WOBBLE_HZ.map((hz, b) => loud * (0.6 + 0.4 * (0.5 + 0.5 * Math.sin(2 * Math.PI * hz * t + WOBBLE_PHASE[b]!))));
}

function tick(now: number): void {
	const root = document.documentElement;
	const local = player.getState().current?.source === 'local';
	const bands = local ? localBands(now) : readBands(BANDS);
	if (!bands) { root.classList.remove('eq-live'); return; }
	if (Math.max(...bands) < SILENCE) {
		silentSince ??= now;
		if (now - silentSince > SILENT_MS) { root.classList.remove('eq-live'); return; }
	} else {
		silentSince = null;
	}
	for (let b = 0; b < BANDS; b++) {
		levels[b]! += (bands[b]! - levels[b]!) * EMA;
		const h = FLOOR + levels[b]! * (100 - FLOOR);
		root.style.setProperty(`--np-eq-${b + 1}`, `${h.toFixed(1)}%`);
	}
	root.classList.add('eq-live');
}

// Wire once at boot. Subscribes/unsubscribes the frame loop on play/pause so the
// shared ticker stays idle when nothing is playing.
export function startEqDriver(): void {
	followOutputDeviceChanges();
	let unframe: (() => void) | null = null;
	player.subscribe((s) => {
		if (s.playing && s.current) {
			if (!unframe) { silentSince = null; unframe = onFrame(tick); }
		} else {
			if (unframe) { unframe(); unframe = null; } // freeze: stop updating heights
			if (!s.current) document.documentElement.classList.remove('eq-live');
		}
	});
}
