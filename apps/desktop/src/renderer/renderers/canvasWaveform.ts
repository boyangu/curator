// Canvas waveform painter — three render models (overlap / stacked /
// ableton) selected by the WaveformStyle the caller passes in. Used by
// MainWaveformView in both player modes: full phrase geometry in the big
// deck, the compact profile in the small strip (see phraseGeometry).
// Only the mini-wavemap uses the SVG painter in svgWaveform.ts.
//
// Render models:
//   • overlap — each band is drawn as one filled polygon spanning floor
//     up to its smooth peak curve (or mirrored around the bar-area
//     center when `style.mirror`). Polygons painted in `paintOrder`
//     (default bass → mid → treble). When `style.overlapBlendColor` is
//     set, an opaque min(bass, mid) polygon in that colour is painted
//     just before treble — Rekordbox's painter's-algorithm overlap
//     (pre-baked brown, no alpha). Smooth quadratic Bezier curves
//     between adjacent bucket peaks remove the column-bar texture and
//     produce a continuous silhouette like Rekordbox / Serato.
//   • stacked — bass at floor, mid above bass, treble above mid; each
//     band is a single filled polygon bounded by two smooth peak
//     curves (its top and the band-below's top). Used by the 'curator'
//     preset; same smoothing approach as overlap.
//   • ableton — three bands collapsed to one envelope, painted as a
//     centred peak silhouette with a darker inner fill (RMS-ish).
//   • spectrum — per-column colour mix. Band amplitudes are linearly
//     combined with the band base RGB colours, then normalized so the
//     brightest channel reaches 1.0 (Mixxx algorithm). Height is
//     max(L, M, H). Mirrored around the midline. With clean RGB
//     primaries as band anchors, the hue circle is fully covered —
//     primaries for single-band columns, secondaries (yellow/cyan/
//     magenta) for two-band columns, near-white for all three.
//
// Sub-pixel scrolling:
//   Buckets are anchored to absolute sample positions, not pinned to
//   integer pixel columns:  bucket b covers samples [b·sPP, (b+1)·sPP].
//   Where sPP = samples-per-pixel for the current zoom. As the viewport
//   scrolls by sub-sample amounts, each bucket's contents stay identical
//   — only its on-screen x position changes. We paint at the FRACTIONAL
//   pixel position `b - vpStartSample/sPP` so the canvas anti-aliases
//   sub-pixel shifts into smooth motion instead of brightness migrating
//   between fixed pixel columns frame-to-frame.

import type { SegmentRecord } from '@curator/shared';
import type { PeaksTier } from '../stores/analysisStore.js';
import { BAR_H, TOP_PAD, type WaveViewport } from './svgWaveform.js';
import { getPerTrackNorm, type WaveformStyle } from './waveformStyles.js';
import { rampColorFor } from './phraseRamp.js';

// Reserved vertical bands above and below the waveform bars.
//   • Top — phrase-boundary triangles point downward into the wave.
//     Red, rekordbox-style — matches Phrase Palettes.html boundary cue.
//   • Bottom — phrase lane: one filled rectangle per segment, label
//     centred, oklch ramp per skin.
// Both bands are always reserved (constant geometry) so the bar area
// doesn't reflow when segments load asynchronously after the first paint.
//
// Two profiles, picked once per view instance and never switched while
// mounted: `full` for the big deck (~150px of wave), `compact` for the
// 44px small-player strip, where the full 24px of bands would leave ~4px
// of bars. Compact keeps a 5px triangle band so the DOM downbeat markers
// (7×5, top-anchored) still have a home above the bar peaks, and a 5px
// lane for the segment colour blocks — too thin for the 9.5px labels, so
// those are off. The lane height doubles as the click hit-test band in
// MainWaveformView, which is why it travels on this object instead of
// being re-derived there.
export interface PhraseGeometry {
	triangleH: number;
	laneH: number;
	triangleHalfW: number;
	triangleTipY: number;
	labels: boolean;
}
const PHRASE_GEOMETRY_FULL: PhraseGeometry = { triangleH: 10, laneH: 14, triangleHalfW: 5, triangleTipY: 9, labels: true };
const PHRASE_GEOMETRY_COMPACT: PhraseGeometry = { triangleH: 5, laneH: 5, triangleHalfW: 3, triangleTipY: 4, labels: false };
export function phraseGeometry(compact: boolean): PhraseGeometry {
	return compact ? PHRASE_GEOMETRY_COMPACT : PHRASE_GEOMETRY_FULL;
}
const PHRASE_BOUNDARY_COLOR = '#ff3b30';
const PHRASE_LANE_LABEL_FONT = '600 9.5px "IBM Plex Mono", ui-monospace, monospace';
const PHRASE_LANE_LABEL_MIN_W = 28; // px — below this, omit the label
const PHRASE_LANE_LABEL_LEFT_PAD = 4; // px — inset from segment's left edge

// Memory horizon of the envelope walker (applies to any band whose
// release is enabled) — how far left of the visible viewport we pre-roll
// so the walker enters the visible region with the correct off-screen
// tail state. Beyond ~3 s, even the slowest practical release (0.4/s)
// decays below ~1.6 %, so the seed value no longer matters.
const ENVELOPE_WARMUP_SEC = 3.0;
// Hard cap so the loop is bounded at extreme zooms (1-bar deep zoom
// at 60 BPM is the tightest practical case).
const ENVELOPE_WARMUP_MAX_BUCKETS = 8000;

// Darker shade of `baseColor` for the inner Ableton fill. Multiplies
// each RGB channel by `factor` ∈ [0,1]. Cheap parse — only called per
// paint, not per pixel.
function darken(baseColor: string, factor: number): string {
	if (baseColor.startsWith('#') && baseColor.length === 7) {
		const r = Math.round(parseInt(baseColor.slice(1, 3), 16) * factor);
		const g = Math.round(parseInt(baseColor.slice(3, 5), 16) * factor);
		const b = Math.round(parseInt(baseColor.slice(5, 7), 16) * factor);
		return `rgb(${r},${g},${b})`;
	}
	return baseColor;
}

// Parse a #RRGGBB hex string into 0..1 channels. Used by the spectrum
// painter to mix band base colours per column. Called once per band per
// paint, not per pixel. Falls back to white on malformed input rather
// than throwing (visual feedback that the skin is mis-configured).
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

// Smooth quadratic-Bezier polyline through (xs[i], ys[i]) for i =
// fromIdx ... toIdx inclusive, with step +1 (forward) or -1 (backward).
// Used by the overlap/stacked painters to trace each band's peak curve
// as a continuous silhouette rather than discrete column bars.
//
// Technique: the path is a C1-continuous curve passing through the
// midpoint between each adjacent pair of peaks, with the peak itself
// acting as the control point. So:
//   lineTo  start point
//   lineTo  midpoint(p_0, p_1)
//   quad    p_1 control, midpoint(p_1, p_2) endpoint
//   quad    p_2 control, midpoint(p_2, p_3) endpoint
//   ...
//   quad    p_{N-2} control, midpoint(p_{N-2}, p_{N-1}) endpoint
//   lineTo  end point
// Tiny overshoot at sharp peaks is intentional — it looks natural and
// is what produces the silhouette feel rather than a hard skyline.
//
// Caller must have an open path with a current point; this function
// only emits `lineTo`/`quadraticCurveTo` calls.
function smoothLineTo(
	ctx: CanvasRenderingContext2D,
	xs: Float32Array,
	ys: Float32Array,
	fromIdx: number,
	toIdx: number,
	step: 1 | -1,
	useSmooth: boolean,
): void {
	const count = (step === 1 ? toIdx - fromIdx : fromIdx - toIdx) + 1;
	if (!useSmooth) {
		// Crisp polyline — straight lineTo at every bucket peak so
		// transient sharpness survives into the rendered silhouette.
		// Used when the band's *SmoothWindow ≤ 1.
		for (let k = 0; k < count; k++) {
			const idx = fromIdx + k * step;
			ctx.lineTo(xs[idx]!, ys[idx]!);
		}
		return;
	}
	ctx.lineTo(xs[fromIdx]!, ys[fromIdx]!);
	if (count === 1) return;
	if (count === 2) {
		ctx.lineTo(xs[toIdx]!, ys[toIdx]!);
		return;
	}
	const i1 = fromIdx + step;
	ctx.lineTo((xs[fromIdx]! + xs[i1]!) / 2, (ys[fromIdx]! + ys[i1]!) / 2);
	for (let k = 1; k <= count - 2; k++) {
		const pi = fromIdx + k * step;
		const piNext = pi + step;
		ctx.quadraticCurveTo(
			xs[pi]!,
			ys[pi]!,
			(xs[pi]! + xs[piNext]!) / 2,
			(ys[pi]! + ys[piNext]!) / 2,
		);
	}
	ctx.lineTo(xs[toIdx]!, ys[toIdx]!);
}

export interface PhraseOverlay {
	segments: SegmentRecord[] | null;
	duration: number;
	geometry: PhraseGeometry;
}

export function paintWaveformOntoCanvas(
	inner: HTMLElement,
	tier: PeaksTier,
	viewport: WaveViewport,
	style: WaveformStyle,
	overlay?: PhraseOverlay,
): void {
	let canvas = inner.querySelector<HTMLCanvasElement>('canvas.t-canvas');
	if (!canvas) {
		canvas = document.createElement('canvas');
		canvas.className = 't-canvas';
		inner.insertBefore(canvas, inner.firstChild);
	}
	const rect = inner.getBoundingClientRect();
	const cssW = Math.max(1, Math.round(rect.width));
	const cssH = Math.max(1, Math.round(rect.height));
	const dpr = window.devicePixelRatio || 1;
	const devW = Math.round(cssW * dpr);
	const devH = Math.round(cssH * dpr);
	if (canvas.width !== devW || canvas.height !== devH) {
		canvas.width = devW;
		canvas.height = devH;
		canvas.style.width = `${cssW}px`;
		canvas.style.height = `${cssH}px`;
	}
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, cssW, cssH);

	// Aggregate per bucket — see file header for the anchoring model.
	const totalN = tier.low.length;
	const vpStartSample = viewport.start * totalN;
	const vpEndSample = viewport.end * totalN;
	const sPP = (vpEndSample - vpStartSample) / cssW;
	if (sPP <= 0) return;

	// Warm-up buckets to the LEFT of the visible viewport so the
	// envelope walkers enter the visible region with the correct tail
	// from off-screen content. Triggered if ANY band has an envelope
	// enabled — the warmup horizon (3 s) covers the slowest practical
	// release, so faster releases on mid/treble are also handled.
	const secPerBucket = tier.samplesPerSec > 0 ? sPP / tier.samplesPerSec : 0;
	const anyEnvelope = (
		style.bassEnvelopeReleasePerSec != null
		|| style.midEnvelopeReleasePerSec != null
		|| style.trebleEnvelopeReleasePerSec != null
	) && secPerBucket > 0;
	const warmupBuckets = anyEnvelope
		? Math.min(ENVELOPE_WARMUP_MAX_BUCKETS, Math.ceil(ENVELOPE_WARMUP_SEC / secPerBucket))
		: 0;
	// Extend by ±1 on each side so the smoothing kernel and the
	// fractional-x paint never visibly clip the leading/trailing edges.
	const firstBucket = Math.floor(vpStartSample / sPP) - 1 - warmupBuckets;
	const lastBucket = Math.ceil(vpEndSample / sPP) + 1;
	const buckets = lastBucket - firstBucket + 1;

	// Symmetric box smooth, per-band window — same kernel as the SVG
	// path. Windows ≤ 1 bypass entirely so adjacent buckets stay raw
	// (useful for transient-heavy bands like treble).
	const smooth = (band: Float32Array, window: number): Float32Array => {
		if (window < 2) return band;
		const out = new Float32Array(band.length);
		const half = Math.floor(window / 2);
		for (let i = 0; i < band.length; i++) {
			let sum = 0, c = 0;
			for (let k = -half; k <= half; k++) {
				const j = i + k;
				if (j < 0 || j >= band.length) continue;
				sum += band[j]!;
				c++;
			}
			out[i] = sum / c;
		}
		return out;
	};
	// Asymmetric envelopes per band — fast attack, slow exponential
	// release. Each band is independent so e.g. SKIN_CURATOR runs a long
	// bass tail (~0.85 s half-life), moderate mid (~0.5 s), fast treble
	// (~0.36 s) — matches the natural decay of low → high frequencies.
	// `null` on a band leaves it raw (no walker).
	const applyEnvelope = (band: Float32Array, releasePerSec: number | null): Float32Array => {
		if (releasePerSec == null || secPerBucket <= 0) return band;
		const decay = Math.pow(releasePerSec, secPerBucket);
		const env = new Float32Array(band.length);
		let v = 0;
		for (let i = 0; i < band.length; i++) {
			const s = band[i]!;
			v = s > v ? s : v * decay;
			env[i] = v;
		}
		return env;
	};
	// Channel→band mapping happens AFTER smoothing, so window choice should
	// think in tier.{low,mid,high} terms — but the skin author thinks in
	// display bands. Apply the display-band window to the corresponding tier
	// channel: bass window → low (Essentia) or high (Rekordbox); treble the
	// other. Same for both channels (shared style).
	const lowWindow = tier.source === 'rekordbox' ? style.trebleSmoothWindow : style.bassSmoothWindow;
	const highWindow = tier.source === 'rekordbox' ? style.bassSmoothWindow : style.trebleSmoothWindow;

	// Per-channel pipeline: aggregate viewport buckets → smooth → channel→
	// display-band map → envelope. Run once per channel so a stereo tier can
	// paint top=left / bottom=right. Returns processed display bands.
	type ProcBands = { bass: Float32Array; mid: Float32Array; treble: Float32Array };
	const processChannel = (src: { low: Uint8Array; mid: Uint8Array; high: Uint8Array }): ProcBands => {
		const peakL = new Float32Array(buckets);
		const peakM = new Float32Array(buckets);
		const peakH = new Float32Array(buckets);
		for (let bi = 0; bi < buckets; bi++) {
			const b = firstBucket + bi;
			const sStartF = b * sPP;
			const sEndF = (b + 1) * sPP;
			const cStartF = Math.max(0, sStartF);
			const cEndF = Math.min(totalN, sEndF);
			if (cEndF <= cStartF) continue;
			const sStart = Math.floor(cStartF);
			const sEnd = Math.min(totalN, Math.ceil(cEndF));
			let lSum = 0, mSum = 0, hSum = 0, wSum = 0;
			for (let j = sStart; j < sEnd; j++) {
				const w = Math.min(j + 1, cEndF) - Math.max(j, cStartF);
				if (w <= 0) continue;
				lSum += src.low[j]! * w;
				mSum += src.mid[j]! * w;
				hSum += src.high[j]! * w;
				wSum += w;
			}
			if (wSum > 0) {
				peakL[bi] = lSum / wSum;
				peakM[bi] = mSum / wSum;
				peakH[bi] = hSum / wSum;
			}
		}
		const smL = smooth(peakL, lowWindow);
		const smM = smooth(peakM, style.midSmoothWindow);
		const smH = smooth(peakH, highWindow);
		// Channel → display-band mapping (must match the SVG painter):
		//   • Essentia: tier.low IS the bass amplitude — direct mapping.
		//   • Rekordbox: tier.high empirically holds the bass signal (red
		//     bit-field × height in PWV5). Swap L↔H.
		const bassRaw = tier.source === 'rekordbox' ? smH : smL;
		const midRaw = smM;
		const treRaw = tier.source === 'rekordbox' ? smL : smH;
		return {
			bass: applyEnvelope(bassRaw, style.bassEnvelopeReleasePerSec),
			mid: applyEnvelope(midRaw, style.midEnvelopeReleasePerSec),
			treble: applyEnvelope(treRaw, style.trebleEnvelopeReleasePerSec),
		};
	};

	// Stereo split: process both channels and draw top=left / bottom=right.
	// Mono tiers (v1 .cpk, rekordbox imports) reuse the single channel for
	// both halves, which renders exactly the classic mirrored look.
	const leftBands = processChannel({ low: tier.low, mid: tier.mid, high: tier.high });
	const stereoSplit = tier.channels === 2 && tier.right != null;
	const rightBands = stereoSplit ? processChannel(tier.right!) : leftBands;

	// RMS bands — only the Ableton skin draws a loudness body, and only when
	// the tier carries real rms (v3 .cpk). Skip the extra per-channel pipeline
	// for every other skin / older file. Mono reuses one channel for both
	// halves, matching the peak split above.
	const wantRms = style.renderModel === 'ableton' && tier.rms != null;
	const rmsLeftBands = wantRms ? processChannel(tier.rms!) : null;
	const rmsRightBands = wantRms
		? (stereoSplit && tier.rightRms ? processChannel(tier.rightRms) : rmsLeftBands)
		: null;

	// Reserve top + bottom bands for triangles and the phrase lane. The
	// bar area shrinks into the middle slice; floor sits just above the
	// lane, ceiling just below the triangle row. Geometry stays constant
	// across paints — segments loading in late doesn't reflow the bars.
	const innerTop = overlay ? overlay.geometry.triangleH : 0;
	const innerBottom = cssH - (overlay ? overlay.geometry.laneH : 0);
	const innerH = Math.max(1, innerBottom - innerTop);
	const barH_px = (BAR_H / 100) * innerH;
	const topPad_px = (TOP_PAD / 100) * innerH;
	const floor_px = innerBottom - topPad_px;
	// Normalization reference: fixed scalar or per-track max. Per-track
	// makes quiet tracks fill the same visual envelope as loud ones —
	// the design move from Pioneer's pre-baked PWV4 image.
	const ref = style.normalize === 'perTrack' ? getPerTrackNorm(tier) : style.fixedRef;
	const norm = (v: number, gain: number): number =>
		Math.pow(Math.min(1, v / ref), style.gamma) * barH_px * gain;

	// Fractional pixel offset of bucket `firstBucket` relative to the
	// viewport's left edge. xPx for bucket bi = xBase + bi.
	const xBase = firstBucket - vpStartSample / sPP;

	// Center axis of the bar area — the split line for stereo (left above,
	// right below) and the mirror axis for the mono mirrored skins.
	const centerY = floor_px - barH_px / 2;

	switch (style.renderModel) {
		case 'overlap': {
			// Smooth-Bezier polygon per band, painted in `paintOrder`
			// (default bass → mid → treble). Floor-up by default; when
			// `style.mirror` each polygon is symmetric around the bar-area
			// center line (RB detail look). When `style.overlapBlendColor`
			// is set, an opaque min(bass, mid) polygon paints just before
			// treble — RB's pre-baked overlap brown. Painting bass then
			// mid opaque first means the taller band keeps the region
			// above the overlap, exactly Beat Link's per-column branch.
			const startBi = Math.max(0, Math.floor(-xBase) - 1);
			const endBi = Math.min(buckets, Math.ceil(cssW - xBase) + 1);
			const N = endBi - startBi;
			if (N < 2) break;
			const xs = new Float32Array(N);
			const bassHL = new Float32Array(N), midHL = new Float32Array(N), trebHL = new Float32Array(N);
			const bassHR = new Float32Array(N), midHR = new Float32Array(N), trebHR = new Float32Array(N);
			for (let j = 0; j < N; j++) {
				const bi = startBi + j;
				xs[j] = xBase + bi;
				bassHL[j] = norm(leftBands.bass[bi]!, style.bassGain);
				midHL[j] = norm(leftBands.mid[bi]!, style.midGain);
				trebHL[j] = norm(leftBands.treble[bi]!, style.trebleGain);
				bassHR[j] = norm(rightBands.bass[bi]!, style.bassGain);
				midHR[j] = norm(rightBands.mid[bi]!, style.midGain);
				trebHR[j] = norm(rightBands.treble[bi]!, style.trebleGain);
			}
			// Mirrored skins and any stereo tier draw around the center axis;
			// a non-mirror mono skin draws floor-up. In center-split mode the
			// top edge is the left channel (height halved so the pair fills the
			// same envelope a full mono mirror would), the bottom edge is the
			// right channel — identical when mono (left===right).
			const useCenterSplit = style.mirror === true || stereoSplit;
			const paintBand = (hsL: Float32Array, hsR: Float32Array, color: string, useSmooth: boolean): void => {
				ctx.fillStyle = color;
				ctx.beginPath();
				if (useCenterSplit) {
					const yTop = new Float32Array(N);
					const yBot = new Float32Array(N);
					for (let j = 0; j < N; j++) {
						yTop[j] = centerY - hsL[j]! / 2;
						yBot[j] = centerY + hsR[j]! / 2;
					}
					ctx.moveTo(xs[0]!, yTop[0]!);
					smoothLineTo(ctx, xs, yTop, 0, N - 1, 1, useSmooth);
					smoothLineTo(ctx, xs, yBot, N - 1, 0, -1, useSmooth);
				} else {
					const ys = new Float32Array(N);
					for (let j = 0; j < N; j++) ys[j] = floor_px - hsL[j]!;
					ctx.moveTo(xs[0]!, floor_px);
					smoothLineTo(ctx, xs, ys, 0, N - 1, 1, useSmooth);
					ctx.lineTo(xs[N - 1]!, floor_px);
				}
				ctx.closePath();
				ctx.fill();
			};
			const bandHL = { bass: bassHL, mid: midHL, treble: trebHL } as const;
			const bandHR = { bass: bassHR, mid: midHR, treble: trebHR } as const;
			const bandColor = { bass: style.bassColor, mid: style.midColor, treble: style.trebleColor } as const;
			const bandSmooth = {
				bass: style.bassSmoothWindow > 1,
				mid: style.midSmoothWindow > 1,
				treble: style.trebleSmoothWindow > 1,
			} as const;
			const order = style.paintOrder ?? ['bass', 'mid', 'treble'];
			const blend = style.overlapBlendColor;
			for (const band of order) {
				if (band === 'treble' && blend) {
					const minHL = new Float32Array(N), minHR = new Float32Array(N);
					for (let j = 0; j < N; j++) {
						minHL[j] = Math.min(bassHL[j]!, midHL[j]!);
						minHR[j] = Math.min(bassHR[j]!, midHR[j]!);
					}
					paintBand(minHL, minHR, blend, bandSmooth.bass || bandSmooth.mid);
				}
				paintBand(bandHL[band], bandHR[band], bandColor[band], bandSmooth[band]);
			}
			break;
		}
		case 'stacked': {
			// Smooth-Bezier polygons stacked vertically. The order is
			// configurable via `style.stackOrder` (first entry sits on the
			// floor, last forms the silhouette peak). Default is
			// ['bass','mid','treble']; curator overrides to
			// ['treble','mid','bass'] for Rekordbox-style bass-on-top.
			//
			// Each band's polygon is bounded below by the previous band's
			// peak curve (or floor for the first band) and above by its
			// own peak curve. Adjacent bands share the boundary curve so
			// they meet without visible seams.
			const startBi = Math.max(0, Math.floor(-xBase) - 1);
			const endBi = Math.min(buckets, Math.ceil(cssW - xBase) + 1);
			const N = endBi - startBi;
			if (N < 2) break;
			const order = style.stackOrder ?? ['bass', 'mid', 'treble'];
			const gainOf = { bass: style.bassGain, mid: style.midGain, treble: style.trebleGain } as const;
			const colorOf = { bass: style.bassColor, mid: style.midColor, treble: style.trebleColor } as const;
			const smoothOf = {
				bass: style.bassSmoothWindow > 1,
				mid: style.midSmoothWindow > 1,
				treble: style.trebleSmoothWindow > 1,
			} as const;
			const xs = new Float32Array(N);
			for (let j = 0; j < N; j++) xs[j] = xBase + (startBi + j);

			// One stacked half: bands accumulated from `baseline` in `dir`
			// (-1 = upward / left channel, +1 = downward / right). `scale`
			// halves the per-channel height in stereo so the two halves fill
			// the same envelope a mono floor-up stack would. tops[band] is the
			// far edge of that band's region; the first band's near edge is the
			// baseline, each subsequent band's near edge is the prior far edge.
			const drawHalf = (bands: ProcBands, baseline: number, dir: 1 | -1, scale: number): void => {
				const tops: Record<'bass' | 'mid' | 'treble', Float32Array> = {
					bass: new Float32Array(N),
					mid: new Float32Array(N),
					treble: new Float32Array(N),
				};
				for (let j = 0; j < N; j++) {
					const bi = startBi + j;
					let cum = baseline;
					for (const band of order) {
						cum += dir * norm(bands[band][bi]!, gainOf[band]) * scale;
						tops[band][j] = cum;
					}
				}
				let prevBand: 'bass' | 'mid' | 'treble' | null = null;
				for (const band of order) {
					ctx.fillStyle = colorOf[band];
					ctx.beginPath();
					if (prevBand === null) {
						ctx.moveTo(xs[0]!, baseline);
						smoothLineTo(ctx, xs, tops[band], 0, N - 1, 1, smoothOf[band]);
						ctx.lineTo(xs[N - 1]!, baseline);
					} else {
						const prevTop = tops[prevBand];
						ctx.moveTo(xs[0]!, prevTop[0]!);
						smoothLineTo(ctx, xs, tops[band], 0, N - 1, 1, smoothOf[band]);
						smoothLineTo(ctx, xs, prevTop, N - 1, 0, -1, smoothOf[prevBand]);
					}
					ctx.closePath();
					ctx.fill();
					prevBand = band;
				}
			};
			if (stereoSplit) {
				// Center-anchored: left channel stacks up, right stacks down.
				drawHalf(leftBands, centerY, -1, 0.5);
				drawHalf(rightBands, centerY, 1, 0.5);
			} else {
				// Mono — classic floor-up stack (the curator default look).
				drawHalf(leftBands, floor_px, -1, 1);
			}
			break;
		}
		case 'spectrum': {
			// Per-column colour mix: linear-combine band base colours by
			// gamma-curved band amplitudes, then normalize so the brightest
			// channel = 1.0 (Mixxx algorithm). With RGB primaries as the
			// band anchors the channels decouple, so the resulting hue
			// directly encodes which bands are firing. Height is max(L,M,H).
			const midY_sp = centerY;
			const low = parseHexRgb(style.bassColor);
			const mid = parseHexRgb(style.midColor);
			const hi  = parseHexRgb(style.trebleColor);
			// Per-column hue + height for one channel. Height is the full
			// centred span (max bar height); each half draws h/2 so a mono
			// pair (top===bottom) reproduces the classic centred rect exactly.
			const colH = (bands: ProcBands, bi: number): { css: string; h: number } | null => {
				const lG = Math.pow(Math.min(1, bands.bass[bi]!   / ref), style.gamma) * style.bassGain;
				const mG = Math.pow(Math.min(1, bands.mid[bi]!    / ref), style.gamma) * style.midGain;
				const hG = Math.pow(Math.min(1, bands.treble[bi]! / ref), style.gamma) * style.trebleGain;
				let rC = lG * low.r + mG * mid.r + hG * hi.r;
				let gC = lG * low.g + mG * mid.g + hG * hi.g;
				let bC = lG * low.b + mG * mid.b + hG * hi.b;
				const maxC = Math.max(rC, gC, bC);
				if (maxC <= 0) return null;
				const inv = 1 / maxC;
				rC *= inv; gC *= inv; bC *= inv;
				const totalAmp = Math.min(1, Math.max(lG, mG, hG));
				const h = totalAmp * barH_px;
				if (h <= 0) return null;
				return { css: `rgb(${(rC * 255) | 0},${(gC * 255) | 0},${(bC * 255) | 0})`, h };
			};
			for (let bi = 0; bi < buckets; bi++) {
				const x = xBase + bi;
				if (x <= -1 || x >= cssW) continue;
				const l = colH(leftBands, bi);
				if (l) { ctx.fillStyle = l.css; ctx.fillRect(x, midY_sp - l.h / 2, 1, l.h / 2); }
				const r = stereoSplit ? colH(rightBands, bi) : l;
				if (r) { ctx.fillStyle = r.css; ctx.fillRect(x, midY_sp, 1, r.h / 2); }
			}
			break;
		}
		case 'tri-line-rows': {
			// Three equal-height rows stacked vertically — highs on top,
			// mids middle, lows at the bottom. Each band is drawn as a
			// stroked polyline (no fill) within its row: baseline at the
			// row's bottom edge, amplitude rising toward the row's top.
			//
			// Per-band stroke colour comes from the skin. Smoothing follows
			// the same `*SmoothWindow` rule as the other painters — window
			// ≤ 1 falls back to crisp lineTo segments.
			const startBi = Math.max(0, Math.floor(-xBase) - 1);
			const endBi = Math.min(buckets, Math.ceil(cssW - xBase) + 1);
			const N = endBi - startBi;
			if (N < 2) break;
			const rowH = barH_px / 3;
			const innerBarTop = floor_px - barH_px;
			// Row floors (bottom edge of each row), top → bottom = treble,
			// mid, bass. Matches the user-stated order "highs, mids, lows".
			const trebFloor = innerBarTop + rowH;
			const midFloor  = innerBarTop + rowH * 2;
			const bassFloor = innerBarTop + rowH * 3;
			const xs = new Float32Array(N);
			const bassY = new Float32Array(N);
			const midY  = new Float32Array(N);
			const trebY = new Float32Array(N);
			// Each band normalized into its OWN row height — gamma + gain
			// still apply but the visual scale is row-bound, not the full
			// bar height. This keeps per-row contrast consistent regardless
			// of which band dominates the track.
			const rowNorm = (v: number, gain: number): number =>
				Math.pow(Math.min(1, v / ref), style.gamma) * rowH * gain;
			for (let j = 0; j < N; j++) {
				const bi = startBi + j;
				xs[j] = xBase + bi;
				bassY[j] = bassFloor - rowNorm(leftBands.bass[bi]!, style.bassGain);
				midY[j]  = midFloor  - rowNorm(leftBands.mid[bi]!,  style.midGain);
				trebY[j] = trebFloor - rowNorm(leftBands.treble[bi]!,  style.trebleGain);
			}
			const stroke = (ys: Float32Array, color: string, useSmooth: boolean): void => {
				ctx.strokeStyle = color;
				ctx.lineWidth = 1;
				ctx.lineJoin = 'round';
				ctx.lineCap = 'round';
				ctx.beginPath();
				ctx.moveTo(xs[0]!, ys[0]!);
				smoothLineTo(ctx, xs, ys, 0, N - 1, 1, useSmooth);
				ctx.stroke();
			};
			stroke(trebY, style.trebleColor, style.trebleSmoothWindow > 1);
			stroke(midY,  style.midColor,    style.midSmoothWindow    > 1);
			stroke(bassY, style.bassColor,   style.bassSmoothWindow   > 1);
			break;
		}
		case 'ableton': {
			// Centred peak silhouette + darker inner RMS body — the DAW look
			// (Audacity-style two-tone). The outer silhouette is the peak
			// outline; the inner darker fill is the RMS loudness. When the tier
			// carries real rms (v3 .cpk) the body is true RMS; otherwise it
			// falls back to a fraction of the peak (the old faked look).
			const midY = centerY;
			const peakColor = style.bassColor;
			const rmsColor = darken(peakColor, 0.55);
			// Sum the three bands into one envelope per channel. Each band is
			// already normalized by `ref`; the sum can exceed 1.0 at dense
			// transients — we clamp inside `norm` via Math.min. `norm(...)/2`
			// is the half-height per side, so a mono pair (top===bottom)
			// reproduces the classic centred silhouette exactly; stereo draws
			// the left sum above and the right sum below.
			const sumAt = (bands: ProcBands, bi: number): number =>
				bands.bass[bi]! + bands.mid[bi]! + bands.treble[bi]!;
			const peakH = (bands: ProcBands, bi: number): number =>
				norm(sumAt(bands, bi), style.bassGain) / 2;
			// RMS body height for a channel: real rms when present (clamped
			// under the peak outline so it always nests inside), else the
			// faked peak×fraction fallback.
			const rmsFrac = style.abletonRmsFraction;
			const bodyH = (peakBands: ProcBands, rmsBands: ProcBands | null, bi: number): number => {
				const ph = peakH(peakBands, bi);
				if (rmsBands) return Math.min(ph, norm(sumAt(rmsBands, bi), style.bassGain) / 2);
				return ph * rmsFrac;
			};
			ctx.fillStyle = peakColor;
			for (let bi = 0; bi < buckets; bi++) {
				const x = xBase + bi;
				if (x <= -1 || x >= cssW) continue;
				const hL = peakH(leftBands, bi);
				const hR = stereoSplit ? peakH(rightBands, bi) : hL;
				if (hL > 0) ctx.fillRect(x, midY - hL, 1, hL);
				if (hR > 0) ctx.fillRect(x, midY, 1, hR);
			}
			ctx.fillStyle = rmsColor;
			for (let bi = 0; bi < buckets; bi++) {
				const x = xBase + bi;
				if (x <= -1 || x >= cssW) continue;
				const hL = bodyH(leftBands, rmsLeftBands, bi);
				const hR = stereoSplit ? bodyH(rightBands, rmsRightBands, bi) : hL;
				if (hL > 0) ctx.fillRect(x, midY - hL, 1, hL);
				if (hR > 0) ctx.fillRect(x, midY, 1, hR);
			}
			break;
		}
	}

	// ─── Phrase overlay ────────────────────────────────────────────────
	// Triangles + lane both live in viewport coords. Map each segment's
	// (startSec, endSec) → (start, end) viewport fractions → pixel x's.
	// Segments fully outside the viewport are culled; partial overlaps
	// clip cleanly because we draw with the canvas's default no-clip and
	// then ctx.save/clip just for the lane label.
	if (overlay) {
		const geom = overlay.geometry;
		const segs = overlay.segments;
		const dur = overlay.duration;
		const vpStartSec = viewport.start * dur;
		const vpEndSec   = viewport.end   * dur;
		const vpSpanSec  = Math.max(1e-9, vpEndSec - vpStartSec);

		// 1. Phrase lane band — always painted, even when no segments,
		// so the geometry stays reserved (a thin dark strip beneath the
		// waveform when nothing's there).
		ctx.fillStyle = '#0a0a0b';
		ctx.fillRect(0, cssH - geom.laneH, cssW, geom.laneH);

		if (segs && segs.length > 0 && dur > 0) {
			ctx.font = PHRASE_LANE_LABEL_FONT;
			ctx.textBaseline = 'middle';
			ctx.textAlign = 'left';
			const laneTop = cssH - geom.laneH;
			const laneCenterY = laneTop + geom.laneH / 2;

			for (const seg of segs) {
				if (seg.endSec <= vpStartSec || seg.startSec >= vpEndSec) continue;
				const xStart = ((seg.startSec - vpStartSec) / vpSpanSec) * cssW;
				const xEnd   = ((seg.endSec   - vpStartSec) / vpSpanSec) * cssW;
				const xLeft  = Math.max(0, xStart);
				const xRight = Math.min(cssW, xEnd);
				const w = xRight - xLeft;
				if (w <= 0) continue;

				const colour = rampColorFor(seg.label, style.phraseRamp);
				ctx.fillStyle = colour.css;
				ctx.fillRect(xLeft, laneTop, w, geom.laneH);

				// Hairline divider on the left edge of every segment except
				// when it's flush with the canvas left (i.e. the first
				// visible segment starts off-screen and we clipped to 0).
				if (xStart >= 0) {
					ctx.fillStyle = 'rgba(0,0,0,0.45)';
					ctx.fillRect(Math.round(xStart), laneTop, 1, geom.laneH);
				}

				// Label anchored at the segment's true left edge with a
				// small inset. Hidden entirely when xStart is off-screen
				// (segment has scrolled partially off the left) — we don't
				// "sticky" the label to the visible portion, the anchor
				// disappears with the segment start. Also skip the narrow
				// case so a sliver poking in from the right doesn't draw
				// a clipped label. Off entirely in the compact profile (the
				// 5px lane can't hold the 9.5px type).
				if (geom.labels && xStart >= 0 && w >= PHRASE_LANE_LABEL_MIN_W) {
					ctx.fillStyle = colour.lightness > 0.62 ? '#0a0a0b' : 'rgba(239,239,242,0.92)';
					ctx.save();
					ctx.beginPath();
					ctx.rect(xStart, laneTop, xRight - xStart, geom.laneH);
					ctx.clip();
					ctx.fillText(seg.label.toUpperCase(), xStart + PHRASE_LANE_LABEL_LEFT_PAD, laneCenterY + 0.5);
					ctx.restore();
				}
			}

			// 2. Phrase-boundary triangles + downward tick. Drawn last so
			// they sit above the bar area. The FIRST segment never gets a
			// marker — its `startSec` is the track start by definition,
			// not a phrase transition. The earlier `startSec <= 0` guard
			// missed this for rb-PSSI sources where the first phrase's
			// start is encoded as the pickup-inclusive beat (e.g. beats[1]
			// = 0.94s on a track with a 2-beat pickup) instead of exact 0.
			// Skip i=0 unconditionally; keep the `<= 0` guard as a defence
			// against malformed mid-track segments with bad startSec.
			ctx.fillStyle = PHRASE_BOUNDARY_COLOR;
			for (let i = 1; i < segs.length; i++) {
				const seg = segs[i]!;
				if (seg.startSec <= 0) continue;
				if (seg.startSec < vpStartSec || seg.startSec > vpEndSec) continue;
				const x = ((seg.startSec - vpStartSec) / vpSpanSec) * cssW;
				ctx.beginPath();
				ctx.moveTo(x - geom.triangleHalfW, 0);
				ctx.lineTo(x + geom.triangleHalfW, 0);
				ctx.lineTo(x, geom.triangleTipY);
				ctx.closePath();
				ctx.fill();
				// Short vertical tick continuing the triangle's spine
				// down into the upper half of the bar area — matches the
				// Phrase Palettes.html reference (`fillRect(x, 0, 1, H*0.5)`).
				ctx.fillRect(Math.round(x) - 0.5, 0, 1, innerH * 0.5);
			}
		}
	}
}

export function clearWaveCanvas(inner: HTMLElement): void {
	const canvas = inner.querySelector<HTMLCanvasElement>('canvas.t-canvas');
	if (!canvas) return;
	const ctx = canvas.getContext('2d');
	if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}
