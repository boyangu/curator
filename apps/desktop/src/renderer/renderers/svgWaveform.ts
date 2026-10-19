// SVG waveform painter — three render models (overlap / stacked /
// ableton) selected by the WaveformStyle passed in. Drawn as an <svg>
// tree inside the host's `.wave-inner` (or the host itself if no inner
// is present). Discrete pixel-wide columns instead of an interpolated
// polygon — each bucket is a rectangle, so transient detail (claps,
// hats) reads cleanly the way it does in Rekordbox's own waveform
// widget.
//
// Used by the mini-wavemap component only (per-track, paints once on
// peaks load). The main scrubber — in both player modes — uses the
// parallel canvas painter (paintWaveformOntoCanvas in canvasWaveform.ts)
// that draws into a persistent canvas on every rAF tick. The two painters
// share the WaveformStyle config so the same skin (Rekordbox / Serato /
// Ableton / Curator) produces a consistent look across both rendering
// paths.

import type { PeaksTier } from '../stores/analysisStore.js';
import { getPerTrackNorm, type WaveformStyle } from './waveformStyles.js';

// Visual tuning knobs that aren't part of the per-skin style — these
// govern bucket count vs. host pixel width and the inner gutter that
// keeps painted columns away from the sunken border.
//
//  MIN_BUCKETS — floor on the bucket count when the host width hasn't
//                resolved yet (initial paint into a hidden container).
//  BAR_H       — max bar height as % of the wave-inner content area.
//  TOP_PAD     — gutter above the floor at the very bottom of the
//                inner area.
export const MIN_BUCKETS = 200;
export const BAR_H = 94;
export const TOP_PAD = 2;

export interface WaveViewport { start: number; end: number }

export function paintWaveformInto(
	bar: HTMLElement,
	tier: PeaksTier | null,
	style: WaveformStyle,
	viewport?: WaveViewport,
): void {
	const inner = bar.querySelector<HTMLElement>('.wave-inner') ?? bar;
	const old = inner.querySelector('svg.t-waveform');
	if (old) old.remove();
	if (!tier || tier.low.length === 0) return;

	// Sample window. With no viewport: the whole track. With a viewport:
	// the viewport's fraction range — which CAN extend past [0,1] in
	// big-mode zoomed views when the first-beat anchor sits less than
	// half-window from a track edge. Per-bucket bounds check handles
	// those out-of-range columns by leaving them blank.
	const totalN = tier.low.length;
	const vpStart = viewport ? viewport.start : 0;
	const vpEnd = viewport ? viewport.end : 1;
	const barWidthPx = Math.max(MIN_BUCKETS, Math.round(inner.getBoundingClientRect().width || MIN_BUCKETS));
	const buckets = barWidthPx;
	const peakL = new Float32Array(buckets);
	const peakM = new Float32Array(buckets);
	const peakH = new Float32Array(buckets);

	// Resolve render model up front for the switch below.
	const renderMode = style.miniRenderModel ?? style.renderModel;
	// Per-bucket aggregation = arithmetic mean of the tier samples in
	// the bucket's range. Matches the canvas painter's aggregation
	// (same kernel across both views). Trades transient spikiness for
	// a smooth envelope that reads consistently regardless of the
	// render model in use.
	const span = vpEnd - vpStart;
	for (let i = 0; i < buckets; i++) {
		const bStartFrac = vpStart + (i / buckets) * span;
		const bEndFrac = vpStart + ((i + 1) / buckets) * span;
		if (bEndFrac <= 0 || bStartFrac >= 1) continue;
		const start = Math.max(0, Math.floor(bStartFrac * totalN));
		const end = Math.min(totalN, Math.max(start + 1, Math.floor(bEndFrac * totalN)));
		let lSum = 0, mSum = 0, hSum = 0;
		const count = Math.max(1, end - start);
		for (let j = start; j < end; j++) {
			lSum += tier.low[j]!;
			mSum += tier.mid[j]!;
			hSum += tier.high[j]!;
		}
		peakL[i] = lSum / count;
		peakM[i] = mSum / count;
		peakH[i] = hSum / count;
	}

	// Map .cpk channels to bass / mid / treble per producer.
	// • Essentia: tier.low IS the bass amplitude.
	// • Rekordbox: tier.high empirically holds the bass signal (red
	//   bit-field × height in PWV5). Swap L↔H.
	const bassAmp = tier.source === 'rekordbox' ? peakH : peakL;
	const midAmp  = peakM;
	const treAmp  = tier.source === 'rekordbox' ? peakL : peakH;

	// Per-band symmetric box smooth. Window ≤ 1 bypasses entirely so a
	// transient-heavy band (typically treble) stays sharp at every zoom.
	const smooth = (band: Float32Array, window: number): Float32Array => {
		if (window < 2) return band;
		const out = new Float32Array(band.length);
		const half = Math.floor(window / 2);
		for (let i = 0; i < band.length; i++) {
			let sum = 0, count = 0;
			for (let k = -half; k <= half; k++) {
				const j = i + k;
				if (j < 0 || j >= band.length) continue;
				sum += band[j]!;
				count++;
			}
			out[i] = sum / count;
		}
		return out;
	};
	// L↔H swap happened above, so bassAmp/midAmp/treAmp are already in
	// display-band terms — pass the matching window directly.
	const smB = smooth(bassAmp, style.bassSmoothWindow);
	const smM = smooth(midAmp, style.midSmoothWindow);
	const smT = smooth(treAmp, style.trebleSmoothWindow);

	const FLOOR = 100 - TOP_PAD;
	const ref = style.normalize === 'perTrack' ? getPerTrackNorm(tier) : style.fixedRef;
	const norm = (v: number, gain: number): number =>
		Math.pow(Math.min(1, v / ref), style.gamma) * BAR_H * gain;

	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('class', 't-waveform');
	svg.setAttribute('viewBox', `0 0 ${buckets} 100`);
	svg.setAttribute('preserveAspectRatio', 'none');

	const appendPath = (d: string, color: string): void => {
		if (!d) return;
		const path = document.createElementNS(ns, 'path');
		path.setAttribute('d', d);
		path.setAttribute('fill', color);
		path.setAttribute('shape-rendering', 'crispEdges');
		svg.appendChild(path);
	};

	// SVG painter respects the skin's `miniRenderModel` override when
	// set so a skin can run e.g. overlap on the big canvas painter
	// (alpha-blended palette) but stacked-thirds on the mini-wavemap
	// (per-band vertical slots). `renderMode` was resolved above the
	// aggregation step so MAX/MEAN selection could happen there.
	switch (renderMode) {
		case 'overlap': {
			// Painter-order overlap. Each band paints from floor up to its
			// own amplitude, in the order configured by `paintOrder`
			// (default bass → mid → treble; rekordbox overrides to
			// mid → bass → treble).
			const order = style.paintOrder ?? ['bass', 'mid', 'treble'];
			const paths: Record<'bass' | 'mid' | 'treble', string[]> = {
				bass: [],
				mid: [],
				treble: [],
			};
			for (let i = 0; i < buckets; i++) {
				const bH = norm(smB[i]!, style.bassGain);
				const mH = norm(smM[i]!, style.midGain);
				const tH = norm(smT[i]!, style.trebleGain);
				if (bH > 0) paths.bass.push(`M${i} ${(FLOOR - bH).toFixed(2)}h1V${FLOOR.toFixed(2)}h-1Z`);
				if (mH > 0) paths.mid.push(`M${i} ${(FLOOR - mH).toFixed(2)}h1V${FLOOR.toFixed(2)}h-1Z`);
				if (tH > 0) paths.treble.push(`M${i} ${(FLOOR - tH).toFixed(2)}h1V${FLOOR.toFixed(2)}h-1Z`);
			}
			for (const band of order) {
				const color = band === 'bass' ? style.bassColor
					: band === 'mid' ? style.midColor
					: style.trebleColor;
				appendPath(paths[band].join(''), color);
			}
			break;
		}
		case 'stacked': {
			// Stack order: first entry sits at floor, last on top.
			// Default ['bass','mid','treble']; curator overrides.
			//
			// This painter is mini-map-only, so `miniBandGains` (when set)
			// overrides the shared per-band gains — RB's preview waveform
			// uses different band weights (.49/.32/.25) than its detail
			// wave, and the detail gains live in bassGain/midGain/trebleGain.
			const order = style.stackOrder ?? ['bass', 'mid', 'treble'];
			const bandAmps: Record<'bass' | 'mid' | 'treble', Float32Array> = {
				bass: smB, mid: smM, treble: smT,
			};
			const [gB, gM, gT] = style.miniBandGains ?? [style.bassGain, style.midGain, style.trebleGain];
			const bandGains: Record<'bass' | 'mid' | 'treble', number> = {
				bass: gB, mid: gM, treble: gT,
			};
			const bandColors: Record<'bass' | 'mid' | 'treble', string> = {
				bass: style.bassColor, mid: style.midColor, treble: style.trebleColor,
			};
			const paths: Record<'bass' | 'mid' | 'treble', string[]> = {
				bass: [], mid: [], treble: [],
			};
			for (let i = 0; i < buckets; i++) {
				let cum = FLOOR;
				for (const band of order) {
					const h = norm(bandAmps[band][i]!, bandGains[band]);
					if (h > 0) {
						paths[band].push(`M${i} ${(cum - h).toFixed(2)}h1V${cum.toFixed(2)}h-1Z`);
					}
					cum -= h;
				}
			}
			for (const band of order) {
				appendPath(paths[band].join(''), bandColors[band]);
			}
			break;
		}
		case 'spectrum': {
			// Per-column colour mix with max-channel normalize (Mixxx
			// algorithm). See canvasWaveform.ts header. Height = max(L,M,H),
			// mirrored around the midline. One <rect> per column.
			const midY = FLOOR - BAR_H / 2;
			const low = parseHexRgb(style.bassColor);
			const mid = parseHexRgb(style.midColor);
			const hi  = parseHexRgb(style.trebleColor);
			for (let i = 0; i < buckets; i++) {
				const lG = Math.pow(Math.min(1, smB[i]! / ref), style.gamma) * style.bassGain;
				const mG = Math.pow(Math.min(1, smM[i]! / ref), style.gamma) * style.midGain;
				const hG = Math.pow(Math.min(1, smT[i]! / ref), style.gamma) * style.trebleGain;
				let rC = lG * low.r + mG * mid.r + hG * hi.r;
				let gC = lG * low.g + mG * mid.g + hG * hi.g;
				let bC = lG * low.b + mG * mid.b + hG * hi.b;
				const maxC = Math.max(rC, gC, bC);
				if (maxC <= 0) continue;
				const inv = 1 / maxC;
				rC *= inv; gC *= inv; bC *= inv;
				const totalAmp = Math.min(1, Math.max(lG, mG, hG));
				const h = totalAmp * BAR_H;
				if (h <= 0) continue;
				const rect = document.createElementNS(ns, 'rect');
				rect.setAttribute('x', String(i));
				rect.setAttribute('y', (midY - h / 2).toFixed(2));
				rect.setAttribute('width', '1');
				rect.setAttribute('height', h.toFixed(2));
				rect.setAttribute('fill', `rgb(${(rC * 255) | 0},${(gC * 255) | 0},${(bC * 255) | 0})`);
				rect.setAttribute('shape-rendering', 'crispEdges');
				svg.appendChild(rect);
			}
			break;
		}
		case 'stacked-thirds': {
			// Mini-wavemap layout where each band gets its own vertical
			// slot — bass at the floor, mid stacked above bass, treble
			// stacked above mid.
			//
			// NO normalization: raw band amplitudes drive the slot fill
			// directly. Values are clamped to [0, 1] then gamma-curved
			// then scaled to slot height. If the analyzer produces
			// values much smaller than 1.0 across the board, the wave
			// reads low against the slot ceilings — which is the
			// honest picture of what's in the signal. No auto-fitting
			// to make bands look loud when they aren't.
			//
			// Per-band gains and band-colour alphas are also ignored
			// here (see prior commit comments) — slot height is the
			// only knob.
			const heights = style.miniBandHeights ?? [1 / 3, 1 / 3, 1 / 3];
			const [bassFrac, midFrac, trebFrac] = heights;
			const bassSlot = BAR_H * bassFrac;
			const midSlot = BAR_H * midFrac;
			const trebSlot = BAR_H * trebFrac;
			const bassFloor = FLOOR;
			const midFloor = FLOOR - bassSlot;
			const trebFloor = FLOOR - bassSlot - midSlot;
			const bassPath: string[] = [];
			const midPath: string[] = [];
			const trePath: string[] = [];
			for (let i = 0; i < buckets; i++) {
				const bH = Math.pow(Math.min(1, smB[i]!), style.gamma) * bassSlot;
				const mH = Math.pow(Math.min(1, smM[i]!), style.gamma) * midSlot;
				const tH = Math.pow(Math.min(1, smT[i]!), style.gamma) * trebSlot;
				if (bH > 0) bassPath.push(`M${i} ${(bassFloor - bH).toFixed(2)}h1V${bassFloor.toFixed(2)}h-1Z`);
				if (mH > 0) midPath.push(`M${i} ${(midFloor - mH).toFixed(2)}h1V${midFloor.toFixed(2)}h-1Z`);
				if (tH > 0) trePath.push(`M${i} ${(trebFloor - tH).toFixed(2)}h1V${trebFloor.toFixed(2)}h-1Z`);
			}
			appendPath(bassPath.join(''), stripAlpha(style.bassColor));
			appendPath(midPath.join(''),  stripAlpha(style.midColor));
			appendPath(trePath.join(''),  stripAlpha(style.trebleColor));
			break;
		}
		case 'nested-envelope': {
			// Three nested centred (Ableton-style) envelopes painted
			// back-to-front. Each successive layer subtracts one band
			// from the previous, so layers nest by construction (the
			// inner layer's amplitude is always ≤ the outer's):
			//   1. dark grey  → ALL bands   (bass + mid + treble)
			//   2. grey       → ALL − bass  (mid + treble)
			//   3. light grey → ALL − bass − mid  (treble only)
			// Skin's bassColor / midColor / trebleColor supply the three
			// grey steps directly.
			const midY = FLOOR - BAR_H / 2;
			const darkColor  = stripAlpha(style.bassColor);
			const greyColor  = stripAlpha(style.midColor);
			const lightColor = stripAlpha(style.trebleColor);
			// Mini-only painter — miniBandGains (when set) overrides the
			// shared gains, which may be budgeted for the big view's
			// stacked rendering.
			const [gB, gM, gT] = style.miniBandGains ?? [style.bassGain, style.midGain, style.trebleGain];
			const allPath: string[] = [];
			const mhPath: string[] = [];
			const tPath: string[] = [];
			for (let i = 0; i < buckets; i++) {
				const bAmp = smB[i]!;
				const mAmp = smM[i]!;
				const tAmp = smT[i]!;
				const allH = norm(bAmp + mAmp + tAmp, gB) / 2;
				const mhH  = norm(mAmp + tAmp,        gM) / 2;
				const tH   = norm(tAmp,               gT) / 2;
				if (allH > 0) allPath.push(`M${i} ${(midY - allH).toFixed(2)}h1v${(allH * 2).toFixed(2)}h-1Z`);
				if (mhH > 0)  mhPath.push(`M${i} ${(midY - mhH).toFixed(2)}h1v${(mhH * 2).toFixed(2)}h-1Z`);
				if (tH > 0)   tPath.push(`M${i} ${(midY - tH).toFixed(2)}h1v${(tH * 2).toFixed(2)}h-1Z`);
			}
			appendPath(allPath.join(''), darkColor);
			appendPath(mhPath.join(''),  greyColor);
			appendPath(tPath.join(''),   lightColor);
			break;
		}
		case 'ableton': {
			// Centred single-colour envelope: peak silhouette mirrored
			// around the midline, with a darker inner ("RMS") fill.
			const midY = FLOOR - BAR_H / 2;
			const peakColor = style.bassColor;
			const rmsColor = darken(peakColor, 0.55);
			const peakPath: string[] = [];
			const rmsPath: string[] = [];
			const rmsFrac = style.abletonRmsFraction;
			for (let i = 0; i < buckets; i++) {
				const sum = smB[i]! + smM[i]! + smT[i]!;
				const h = norm(sum, style.bassGain) / 2; // half-height per side
				if (h > 0) {
					peakPath.push(`M${i} ${(midY - h).toFixed(2)}h1v${(h * 2).toFixed(2)}h-1Z`);
					const ih = h * rmsFrac;
					rmsPath.push(`M${i} ${(midY - ih).toFixed(2)}h1v${(ih * 2).toFixed(2)}h-1Z`);
				}
			}
			appendPath(peakPath.join(''), peakColor);
			appendPath(rmsPath.join(''),  rmsColor);
			break;
		}
	}

	inner.insertBefore(svg, inner.firstChild);
}

// Same darkening helper as in canvasWaveform.ts. Keep both painters
// independent — they import the same style, not the same code.
function darken(baseColor: string, factor: number): string {
	if (baseColor.startsWith('#') && baseColor.length === 7) {
		const r = Math.round(parseInt(baseColor.slice(1, 3), 16) * factor);
		const g = Math.round(parseInt(baseColor.slice(3, 5), 16) * factor);
		const b = Math.round(parseInt(baseColor.slice(5, 7), 16) * factor);
		return `rgb(${r},${g},${b})`;
	}
	return baseColor;
}

// Drop a trailing alpha pair from a `#RRGGBBAA` colour and return
// `#RRGGBB`. Used by stacked-thirds where each band sits in its own
// slot over a black background — the overlap-tuned alpha would just
// dim the band against black, making it read as faded. `#RRGGBB` and
// any other length pass through unchanged.
function stripAlpha(hex: string): string {
	return hex.length === 9 && hex.startsWith('#') ? hex.slice(0, 7) : hex;
}

// Parse #RRGGBB to 0..1 channels for the spectrum painter's per-column
// colour mix. Called once per band per paint.
function parseHexRgb(hex: string): { r: number; g: number; b: number } {
	if (hex.startsWith('#') && hex.length === 7) {
		return {
			r: parseInt(hex.slice(1, 3), 16) / 255,
			g: parseInt(hex.slice(3, 5), 16) / 255,
			b: parseInt(hex.slice(5, 7), 16) / 255,
		};
	}
	return { r: 1, g: 1, b: 1 };
}
