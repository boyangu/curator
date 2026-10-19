// Waveform style presets — visual "skins" for the big waveform and
// mini-wavemap. Both painters (canvasWaveform + svgWaveform) consume
// a WaveformStyle to decide colours, render model, amplitude curve,
// normalization, and optional bass-envelope smoothing.
//
// The four presets here are calibrated against the reference apps:
//   • Rekordbox — matches Beat Link's reverse-engineered CDJ renderer
//     (deepsymmetry.org). Detail wave: opaque painter's algorithm
//     mirrored around a center axis — blue bass and amber mid drawn
//     opaque, their overlap overdrawn with a pre-baked brown blend
//     (no alpha compositing), white treble always last. Per-band scale
//     factors low ×0.4 / mid ×0.3 / high ×0.06 (normalized to gains
//     1.0 / 0.75 / 0.15 here) — the tiny treble factor is what makes
//     white read as thin transient caps. Mini map: RB's preview is a
//     bottom-up STACKED bar chart with its own weights (.49/.32/.25),
//     not a shrunken detail wave — `miniRenderModel` + `miniBandGains`.
//   • Traktor — spectrum heat-map: per-column colour mix. The band
//     amplitudes drive separate RGB channels (bass→R, mid→G,
//     treble→B by default), normalized so the brightest channel
//     reaches 1.0 (Mixxx algorithm). With RGB primaries as the band
//     anchors, the hue circle is fully covered: single-band columns
//     read as primaries, two-band columns as secondaries (yellow/
//     cyan/magenta), all-three as near-white. Height is max(L, M, H),
//     mirrored around the midline. Each column is independent —
//     per-band `*SmoothWindow: 1` and no envelopes keeps hue
//     transitions crisp at every zoom level.
//   • Ableton — single colour, centred peak silhouette with a darker
//     RMS-ish fill. Total energy across all three bands collapses to
//     one envelope; designed for visual analysis, not band reading.
//   • Curator — our opinionated default. Stacked silver render: dark
//     bass mass at the floor, a thin grey mid band riding its top edge,
//     a thinner white treble band riding the grey. Mid/treble gains
//     held low so they read as small vibrations on the bass silhouette
//     rather than full-height layers.
//
// Per-track normalization stores a scalar in a WeakMap keyed on the
// PeaksTier object — computed once on first paint, reused after.

import type { PeaksTier } from '../stores/analysisStore.js';
import type { PhraseRamp } from './phraseRamp.js';

export type RenderModel = 'overlap' | 'stacked' | 'ableton' | 'spectrum' | 'stacked-thirds' | 'tri-line-rows' | 'nested-envelope';
export type NormalizeMode = 'fixed' | 'perTrack';
export type SkinId = 'rekordbox' | 'ableton' | 'curator' | 'traktor' | 'traktor-uv';

export interface WaveformStyle {
	id: SkinId;
	label: string;
	// Band colours.
	bassColor: string;
	midColor: string;
	trebleColor: string;
	// In 'ableton' mode the bands collapse to one envelope rendered in
	// `bassColor`; mid/treble colours are unused.
	renderModel: RenderModel;
	// Power-curve compression on the [0..1] normalized amplitude. <1
	// lifts quiet sections; 1.0 = linear. Pioneer is ~0.4.
	gamma: number;
	// 'fixed' divides by `fixedRef` (matches SVG painter's historical
	// 510-max approach). 'perTrack' divides by the per-track max bass
	// amplitude, lifting quiet tracks to the same visual scale as loud
	// ones — the design move from Pioneer's pre-baked PWV4.
	normalize: NormalizeMode;
	fixedRef: number;
	// Post-normalize visual gain. Bass = 1.0 unless the model already
	// suppresses bass. Mid/treble can be boosted when the bass envelope
	// (or render model) eats their stacked headroom.
	bassGain: number;
	midGain: number;
	trebleGain: number;
	// Symmetric box-filter window in buckets, per band. 0/1 = no
	// smoothing on that band. Treble usually wants the smallest window
	// (or zero) to preserve transient sharpness; bass usually tolerates
	// the most smoothing (envelope already shapes its silhouette).
	bassSmoothWindow: number;
	midSmoothWindow: number;
	trebleSmoothWindow: number;
	// Asymmetric per-band envelopes (fast attack, slow exponential
	// release). Each value is a per-second decay factor in (0, 1):
	// e.g. 0.4 → tail halves in ~0.85 s; 0.18 → halves in ~0.4 s. `null`
	// disables that band's envelope. Bass is typically the slowest
	// (longest tail), treble the fastest — matches natural acoustic
	// decay. Only the canvas painter applies these; the SVG painter
	// ignores them (SVG path is one-shot, not scrolled).
	bassEnvelopeReleasePerSec: number | null;
	midEnvelopeReleasePerSec: number | null;
	trebleEnvelopeReleasePerSec: number | null;
	// Ableton centred mode draws above AND below midline; this fraction
	// of the bar height is reserved for the inner ("RMS") fill. Ignored
	// for overlap/stacked.
	abletonRmsFraction: number;
	// Phrase-lane ramp. Single-hue lo↔hi interpolation plus a reserved
	// saturated accent for peak phrases (drop / chorus). Pulled verbatim
	// from the four scheme panels in planning/ux/phases-segments.zip →
	// `tidaldl/project/Phrase Palettes.html`. The mapping label → ramp
	// position lives in phraseRamp.ts (one table covers both analyzer
	// and rekordbox vocabularies).
	phraseRamp: PhraseRamp;
	// Band paint order for the 'overlap' render model. Defaults to
	// ['bass','mid','treble'] (bass painted first, treble drawn last on
	// top). Ignored by other render models.
	paintOrder?: readonly ('bass' | 'mid' | 'treble')[];
	// Opaque blend colour painted over the bass∩mid overlap — height
	// min(bass, mid) per column — just before treble, in the 'overlap'
	// render model. Rekordbox's renderer fakes band overlap this way
	// (pre-computed brown, no alpha compositing). Unset = plain
	// painter's-algorithm overlap (whatever alpha the band colours carry).
	overlapBlendColor?: string;
	// Mirror the 'overlap' render model around the bar-area center line
	// (RB detail-waveform look) instead of drawing floor-up. Canvas
	// painter only — the SVG painter is mini-map-only and RB's preview
	// is bottom-anchored, not mirrored.
	mirror?: boolean;
	// Per-band gain override for the SVG (mini-map) painter ('stacked'
	// and 'nested-envelope' models): [bass, mid, treble]. The mini often
	// needs different weights than the big view — RB's preview uses
	// .49/.32/.25 vs its detail factors; curator's nested-envelope mini
	// keeps full-scale gains while the big stacked view budgets them.
	// Unset = use the shared bassGain/midGain/trebleGain.
	miniBandGains?: readonly [number, number, number];
	// Band stack order for the 'stacked' render model — first entry sits
	// at the floor, last at the top of the silhouette. Defaults to
	// ['bass','mid','treble'] (bass mass at the floor, treble tips on top).
	stackOrder?: readonly ('bass' | 'mid' | 'treble')[];
	// Optional override of the render model for the SVG painter only
	// (mini-wavemap + small-mode big-wave). Lets a skin run one model
	// on the big-wave canvas painter and a different one on the SVG
	// painter — e.g. overlap on the big wave for alpha-blended palette
	// behaviour, stacked-thirds on the mini for per-band slot rendering.
	// When unset the SVG painter falls back to `renderModel`.
	miniRenderModel?: RenderModel;
	// Vertical slot fractions per band [bass, mid, treble] in the
	// 'stacked-thirds' render model. Each band's polygon is rendered
	// inside a slot sized to `BAR_H * fraction`, normalized against
	// that band's own max amplitude over the visible region. Sum
	// should be ≤ 1.0. Defaults to [1/3, 1/3, 1/3].
	miniBandHeights?: readonly [number, number, number];
}

export const SKIN_REKORDBOX: WaveformStyle = {
	id: 'rekordbox',
	label: 'Blue-Orange-White',
	// Beat Link's measured CDJ colours: LOW rgb(32,83,217), MID
	// rgb(242,170,60), HIGH white — all opaque. The bass∩mid overlap is
	// overdrawn with RB's pre-baked brown rgb(169,107,39) via
	// `overlapBlendColor` instead of alpha compositing.
	bassColor: '#2053D9',
	midColor: '#F2AA3C',
	trebleColor: '#FFFFFF',
	renderModel: 'overlap',
	overlapBlendColor: '#A96B27',
	// RB's detail wave is symmetric around a center axis, not floor-up.
	mirror: true,
	gamma: 0.45,
	normalize: 'perTrack',
	fixedRef: 510,
	// RB detail per-band scale factors are low ×0.4 / mid ×0.3 / high
	// ×0.06 — normalized to bass=1.0 that's 0.75 / 0.15. The tiny treble
	// gain is what makes white read as thin bright caps on transients
	// instead of full-height columns.
	bassGain: 1.0,
	midGain: 0.75,
	trebleGain: 0.15,
	bassSmoothWindow: 3,
	midSmoothWindow: 3,
	trebleSmoothWindow: 3,
	bassEnvelopeReleasePerSec: null,
	midEnvelopeReleasePerSec: null,
	trebleEnvelopeReleasePerSec: null,
	abletonRmsFraction: 0.55,
	// Mini map = RB's preview waveform: a bottom-up stacked bar chart
	// (blue base, amber middle, white tips) with its own band weights —
	// cumulative heights low ×0.49 / mid ×0.32 / high ×0.25 per Beat
	// Link's PWV6 preview renderer. Distinct from the mirrored detail
	// model above.
	miniRenderModel: 'stacked',
	miniBandGains: [0.49, 0.32, 0.25],
	// BOW — warm graphite → amber, orange accent (Phrase Palettes scheme 01).
	phraseRamp: {
		lo: { l: 0.275, c: 0.012, h: 62 },
		hi: { l: 0.520, c: 0.034, h: 62 },
		accent: { l: 0.745, c: 0.135, h: 64 },
	},
};

export const SKIN_ABLETON: WaveformStyle = {
	id: 'ableton',
	label: 'Golden',
	// Ableton clips are single-colour; we pick the default audio-clip
	// yellow. Mid/treble unused in 'ableton' render model.
	bassColor: '#E5C100',
	midColor: '#E5C100',
	trebleColor: '#E5C100',
	renderModel: 'ableton',
	gamma: 0.7,
	normalize: 'perTrack',
	fixedRef: 510,
	bassGain: 1.0,
	midGain: 1.0,
	trebleGain: 1.0,
	bassSmoothWindow: 3,
	midSmoothWindow: 3,
	trebleSmoothWindow: 3,
	bassEnvelopeReleasePerSec: null,
	midEnvelopeReleasePerSec: null,
	trebleEnvelopeReleasePerSec: null,
	abletonRmsFraction: 0.55,
	// Monochrome gold — dark bronze → bright gold for the peak
	// (Phrase Palettes scheme 03).
	phraseRamp: {
		lo: { l: 0.290, c: 0.014, h: 82 },
		hi: { l: 0.560, c: 0.058, h: 82 },
		accent: { l: 0.805, c: 0.135, h: 86 },
	},
};

export const SKIN_TRAKTOR: WaveformStyle = {
	id: 'traktor',
	label: 'Heat-Map',
	// Band base colours map to RGB channels: bass→R, mid→G, treble→B.
	// Pure primaries are needed for the algorithm (max-channel
	// normalize) to span the full hue circle: any cross-channel
	// contamination collapses the hue range (e.g. mid+treble both
	// driving blue would lock columns into magenta whenever bass
	// fires). With clean primaries the column hue directly encodes
	// which bands are firing — single → primary, two → secondary
	// (yellow/cyan/magenta), all three → near-white.
	bassColor: '#FF0000',
	midColor: '#00FF00',
	trebleColor: '#0000FF',
	// See canvasWaveform.ts / svgWaveform.ts 'spectrum' case. One
	// mirrored rectangle per column, single colour, height = max(L,M,H).
	renderModel: 'spectrum',
	// Lifts quiet columns so they still get a saturated hue rather
	// than fading toward black.
	gamma: 0.55,
	normalize: 'perTrack',
	fixedRef: 510,
	bassGain: 1.0,
	// Boost mid/treble to compensate for their natural amplitude
	// disadvantage vs bass — otherwise bass-dominant frames swamp the
	// hue computation and most of the track reads as red.
	midGain: 1.3,
	trebleGain: 1.3,
	// Crisp per-column hue transitions — no neighbour averaging on any band.
	bassSmoothWindow: 1,
	midSmoothWindow: 1,
	trebleSmoothWindow: 1,
	// No bass envelope: a lingering bass tail bleeds red into columns
	// that should be reading mid/treble after the kick decays.
	bassEnvelopeReleasePerSec: null,
	midEnvelopeReleasePerSec: null,
	trebleEnvelopeReleasePerSec: null,
	abletonRmsFraction: 0.55,
	// Dark violet → magenta → hot-pink accent. Echoes the mid/treble
	// hot-zone colour the waveform produces when all three bands fire
	// (after hue-normalize the pink-dominant palette lands near magenta).
	phraseRamp: {
		lo: { l: 0.275, c: 0.022, h: 320 },
		hi: { l: 0.510, c: 0.062, h: 322 },
		accent: { l: 0.770, c: 0.155, h: 345 },
	},
};

// Stubbed-but-not-active alternate heat-map palette (Ultraviolet — the
// green/blue/yellow Traktor preset visible in the bottom-left of the
// reference). Reachable through getSkin() but DELIBERATELY not in the
// SKINS array, so it stays out of the picker AND the localStorage
// validator. To activate: append SKIN_TRAKTOR_UV to the SKINS array.
export const SKIN_TRAKTOR_UV: WaveformStyle = {
	id: 'traktor-uv',
	label: 'Heat-Map UV',
	// Electric blue bass, vivid green mid, electric yellow treble.
	// Linear mix: blue+green = cyan, green+yellow = lime, blue+yellow
	// → near-white (B+G+R balanced after hue-normalize), all three →
	// neutral white. Matches the UV preset's hot centres.
	bassColor: '#0080FF',
	midColor: '#00FF40',
	trebleColor: '#FFE800',
	renderModel: 'spectrum',
	gamma: 0.55,
	normalize: 'perTrack',
	fixedRef: 510,
	bassGain: 1.0,
	midGain: 1.3,
	trebleGain: 1.3,
	bassSmoothWindow: 1,
	midSmoothWindow: 1,
	trebleSmoothWindow: 1,
	bassEnvelopeReleasePerSec: null,
	midEnvelopeReleasePerSec: null,
	trebleEnvelopeReleasePerSec: null,
	abletonRmsFraction: 0.55,
	// Deep navy → teal-green → electric-yellow accent. Echoes the
	// peak colour of the UV palette (all three bands summed → white,
	// with yellow as the brightest single contributor).
	phraseRamp: {
		lo: { l: 0.275, c: 0.022, h: 230 },
		hi: { l: 0.510, c: 0.075, h: 165 },
		accent: { l: 0.815, c: 0.165, h: 100 },
	},
};

export const SKIN_CURATOR: WaveformStyle = {
	id: 'curator',
	label: 'Silver',
	// Silver palette — three steps along a neutral grey ramp:
	//   • bass    → dark silver (floor mass in big view; bass envelope in mini)
	//   • mid     → silver       (band riding the bass top edge)
	//   • treble  → bright silver (thin tips riding the mid band; mid+treble core in mini)
	// The 'nested-envelope' mini painter derives a darker "sum" shade by
	// darkening bassColor.
	bassColor: '#6e7378',
	midColor: '#a8adb2',
	trebleColor: '#dde2e7',
	// Big-wave canvas painter stacks the bands: dark bass polygon at the
	// floor, grey mid stacked on its top curve, white treble on top of
	// the mid. Default stack order ['bass','mid','treble'] applies.
	renderModel: 'stacked',
	// Mini-wavemap renders three nested centred (Ableton-style) envelopes:
	// the sum sits underneath as a darker backdrop, bass nests inside it,
	// mid+treble combined forms the bright core on top. Painted back-to-
	// front so the brighter inner layers sit on the darker outer ones.
	// Keeps the pre-stacked full-scale gains via miniBandGains — the
	// budgeted big-view gains below would shrink its inner layers.
	miniRenderModel: 'nested-envelope',
	miniBandGains: [1.0, 1.15, 1.25],
	// Honest signal: noise floor reads as low; lifts only modestly.
	// Matches the calibration on other skins so visual scale isn't a
	// giveaway for analyzer noise.
	gamma: 0.55,
	normalize: 'perTrack',
	fixedRef: 510,
	// Stacked heights are cumulative, so gains are budgeted to keep the
	// worst-case sum ≈ 1.0 of the bar area: the bass mass dominates,
	// mid is a small vibration on its top edge, treble a smaller one
	// on the mid.
	bassGain: 0.7,
	midGain: 0.22,
	trebleGain: 0.12,
	// No smoothing — the stacked edges stay honest to per-bucket peaks.
	// The canvas painter's `smoothLineTo` falls back to plain lineTo at
	// window ≤ 1, so the band boundaries render as crisp polylines.
	bassSmoothWindow: 1,
	midSmoothWindow: 1,
	trebleSmoothWindow: 1,
	// No envelope walkers — raw amplitude only. The visual story is
	// per-band activity over time, not a decaying tail.
	bassEnvelopeReleasePerSec: null,
	midEnvelopeReleasePerSec: null,
	trebleEnvelopeReleasePerSec: null,
	abletonRmsFraction: 0.55,
	// Neutral steel ramp — matches the silver palette of the waveform itself.
	phraseRamp: {
		lo: { l: 0.290, c: 0.005, h: 250 },
		hi: { l: 0.520, c: 0.010, h: 250 },
		accent: { l: 0.780, c: 0.020, h: 250 },
	},
};

export const SKINS: readonly WaveformStyle[] = [
	SKIN_REKORDBOX,
	SKIN_TRAKTOR,
	SKIN_ABLETON,
	SKIN_CURATOR,
];

export function getSkin(id: SkinId): WaveformStyle {
	switch (id) {
		case 'rekordbox':  return SKIN_REKORDBOX;
		case 'traktor':    return SKIN_TRAKTOR;
		case 'traktor-uv': return SKIN_TRAKTOR_UV;
		case 'ableton':    return SKIN_ABLETON;
		case 'curator':    return SKIN_CURATOR;
	}
}

// Per-track normalization cache. Keyed on the PeaksTier object (which
// is replaced atomically when a new track loads), so eviction is
// automatic — once the tier is unreachable, the entry is collected.
// Stores the normalization scalar to divide bass amplitudes by.
const perTrackNormCache = new WeakMap<PeaksTier, number>();

export function getPerTrackNorm(tier: PeaksTier): number {
	const cached = perTrackNormCache.get(tier);
	if (cached !== undefined) return cached;
	// Use the bass channel (post-source-swap for Rekordbox) since bass
	// dominates the visual scale. Find the 99th-percentile-ish max —
	// using the plain max would let one outlier sample shrink the
	// whole track's visual envelope.
	const bassSrc = tier.source === 'rekordbox' ? tier.high : tier.low;
	if (bassSrc.length === 0) {
		perTrackNormCache.set(tier, 255);
		return 255;
	}
	// One-pass max with a floor of 64 (otherwise a near-silent track
	// would render as full-scale noise). Cheap O(N) over the whole
	// tier; runs once per track.
	let max = 0;
	for (let i = 0; i < bassSrc.length; i++) {
		const v = bassSrc[i]!;
		if (v > max) max = v;
	}
	const norm = Math.max(64, max);
	perTrackNormCache.set(tier, norm);
	return norm;
}
