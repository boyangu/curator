// Phrase-lane colour ramp.
//
// The waveform painter draws a thin lane along the bottom of the canvas
// showing each structural segment as a coloured rectangle with its label.
// Colour encodes intensity along a single-hue ramp per waveform skin —
// drop / chorus phrases light up with a reserved saturated accent;
// intros / outros sit dark; everything else interpolates between.
//
// Why a static label→position table:
//   The analyzer writes a per-segment `energy` field (0..1). Rekordbox's
//   PSSI ingestion does not. To keep the lane consistent across both
//   sources without inventing per-label energies for rb, we map labels
//   straight to a [0..1] position on the ramp here. The position covers
//   both vocabularies — analyzer's lowercase energy-arc labels and
//   rekordbox's TitleCase phrase labels (high / mid / low mood).
//
// Ramp position semantics:
//   - 0.00..0.25 → dark end (intros, outros, breakdowns)
//   - 0.25..0.75 → mid (verses, builds, bridges)
//   - 0.75..0.99 → upper mid (final builds, sub-drops)
//   - >= PEAK    → saturated accent (drops, choruses) — single colour
//                  per skin, reserved for the highlight.

import type { SegmentLabel } from '@curator/shared';

// Energy >= this triggers the accent colour. Matches the design HTML
// (Phrase Palettes.html line 173: `const PEAK = 0.90`).
export const PHRASE_PEAK = 0.90;

// OKLCH triple — kept as a plain tuple so it composes into a literal
// `oklch(L C H)` string at paint time without allocations.
export type OklchTriple = { l: number; c: number; h: number };

export interface PhraseRamp {
	// Two ramp endpoints — linear interpolation in L and C between them
	// at the segment's mapped position. Hue stays fixed (single-hue ramp,
	// per the design's "lane never turns into a rainbow" rule).
	lo: OklchTriple;
	hi: OklchTriple;
	// Single saturated colour for peak phrases. Independent hue from
	// lo/hi — e.g. the RGB scheme's lane is neutral grey with a cyan
	// accent (no greyscale lift will hit cyan).
	accent: OklchTriple;
}

// Per-label ramp position. Values are mood-aware where rb vocabulary
// repeats labels across moods (e.g. "Outro" appears in mood=2 and mood=3
// with the same semantic — short tail of the track).
//
// Analyzer (lowercase): intro/build/drop/breakdown/main/outro/unknown.
// Rekordbox (TitleCase): the PSSI phrase names per mood category.
const LABEL_ENERGY: Record<SegmentLabel, number> = {
	// Analyzer — energy-arc.
	intro: 0.16,
	breakdown: 0.22,
	main: 0.55,
	build: 0.72,
	drop: 1.00,
	outro: 0.18,
	unknown: 0.30,
	// Rekordbox high-mood (1) — "Up" climbs toward the chorus, which is
	// the energy peak. Intros and outros bookend low.
	'Intro 1': 0.16,
	'Intro 2': 0.22,
	'Up 1': 0.45,
	'Up 2': 0.62,
	'Up 3': 0.80,
	Down: 0.30,
	'Chorus 1': 1.00,
	'Chorus 2': 1.00,
	'Outro 1': 0.20,
	'Outro 2': 0.18,
	// Rekordbox mid-mood (2) + low-mood (3) — song-form vocabulary.
	// Chorus is the peak; verses sit mid; intro/outro bookend low.
	Intro: 0.18,
	Outro: 0.18,
	'Verse 1': 0.45,
	'Verse 2': 0.50,
	'Verse 3': 0.55,
	'Verse 4': 0.55,
	'Verse 5': 0.55,
	'Verse 6': 0.55,
	Bridge: 0.40,
	Chorus: 1.00,
};

export function rampPosition(label: SegmentLabel): number {
	return LABEL_ENERGY[label] ?? 0.30;
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function fmt(o: OklchTriple): string {
	return `oklch(${o.l.toFixed(3)} ${o.c.toFixed(3)} ${o.h})`;
}

export interface PhraseColour {
	css: string;
	// Luminance hint (the L coord of the resolved oklch). >0.62 means
	// the fill is light enough that black text reads better than white.
	// Mirrors the Phrase Palettes.html `dark = col.L > 0.62` switch.
	lightness: number;
}

export function rampColorFor(label: SegmentLabel, ramp: PhraseRamp): PhraseColour {
	const e = rampPosition(label);
	if (e >= PHRASE_PEAK) {
		return { css: fmt(ramp.accent), lightness: ramp.accent.l };
	}
	const t = Math.max(0, Math.min(1, e / PHRASE_PEAK));
	const l = lerp(ramp.lo.l, ramp.hi.l, t);
	const c = lerp(ramp.lo.c, ramp.hi.c, t);
	return { css: fmt({ l, c, h: ramp.lo.h }), lightness: l };
}
