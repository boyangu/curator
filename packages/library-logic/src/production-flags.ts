// Integrity flags over the production-stage scalars that live on `track`
// (prod_cutoff_hz, prod_clip_pct, prod_sub_corr, prod_plr, prod_lufs). These
// are absolute facts about the file, never cohort-relative, and deliberately
// kept out of any blended score: a fake-lossless FLAC is a defect whatever its
// tonal balance looks like. Shared by the core profile and the renderer's list
// badge so both read the same thresholds.

export type ProductionFlagKind = 'transcode' | 'clipping' | 'overs' | 'stereo_sub' | 'crushed' | 'phase';
export type ProductionFlagSeverity = 'warn' | 'bad';

export interface ProductionFlag {
	kind: ProductionFlagKind;
	severity: ProductionFlagSeverity;
	label: string;   // short, for a badge
	detail: string;  // one sentence, for a tooltip or the profile
}

export interface ProductionFlagInput {
	prodCutoffHz?: number | null;
	prodCutoffDepthDb?: number | null; // only the profile has it; the list falls back to the cutoff alone
	prodClipPct?: number | null;
	prodSubCorr?: number | null;
	prodPlr?: number | null;
	prodLufs?: number | null;
	prodTruePeak?: number | null;      // derivable as lufs + plr when absent
	phaseCorr?: number | null;
	stereoSource?: boolean | null;
}

// Tunable in one place. Rationale per line:
export const PRODUCTION_THRESHOLDS = {
	// A lowpass wall below this is a lossy encoder's; 320 kbps MP3 sits at
	// ~19.5-20 kHz, 128 kbps at 16 kHz. Lossless masters roll off gradually.
	transcodeWarnHz: 20500,
	transcodeBadHz: 17500,
	// Flat full-scale runs. 0.01 % is a few hundred samples on a 6-minute
	// track (limiter overshoot); 0.1 % is audible crackle.
	clipWarnPct: 0.01,
	clipBadPct: 0.1,
	// Inter-sample peaks above 0 dBTP distort on consumer DACs and lossy
	// re-encodes; above +1 it is already on the file.
	oversWarnDbtp: 0.0,
	oversBadDbtp: 1.0,
	// Correlation below 120 Hz: club systems sum the sub to mono, so side
	// energy there cancels. 0.5 is wide; below 0 is actively cancelling.
	subCorrWarn: 0.5,
	subCorrBad: 0.0,
	// Peak-to-loudness ratio: modern club masters sit around 8-11 dB; under 7
	// the limiter has taken the transients, under 5.5 the drums are gone.
	plrWarnDb: 7.0,
	plrBadDb: 5.5,
	// Full-band correlation below zero = the channels are out of phase.
	phaseBad: 0.0,
} as const;

export function productionFlags(t: ProductionFlagInput): ProductionFlag[] {
	const T = PRODUCTION_THRESHOLDS;
	const out: ProductionFlag[] = [];
	const cutoff = t.prodCutoffHz;
	if (cutoff != null && cutoff < T.transcodeWarnHz && (t.prodCutoffDepthDb == null || t.prodCutoffDepthDb >= 15)) {
		const khz = (cutoff / 1000).toFixed(1);
		out.push({
			kind: 'transcode', severity: cutoff < T.transcodeBadHz ? 'bad' : 'warn', label: `Lossy ${khz}k`,
			detail: `Spectrum ends in a wall at ${khz} kHz${t.prodCutoffDepthDb != null ? ` (${Math.round(t.prodCutoffDepthDb)} dB)` : ''}: the file was encoded lossy at some point.`,
		});
	}
	const clip = t.prodClipPct;
	if (clip != null && clip >= T.clipWarnPct) {
		out.push({
			kind: 'clipping', severity: clip >= T.clipBadPct ? 'bad' : 'warn', label: 'Clipping',
			detail: `${clip.toFixed(clip < 0.1 ? 3 : 2)} % of samples sit in flat full-scale runs — the master clips.`,
		});
	}
	const tp = t.prodTruePeak ?? (t.prodLufs != null && t.prodPlr != null ? t.prodLufs + t.prodPlr : null);
	if (tp != null && tp > T.oversWarnDbtp) {
		out.push({
			kind: 'overs', severity: tp > T.oversBadDbtp ? 'bad' : 'warn', label: `+${tp.toFixed(1)} dBTP`,
			detail: `True peak reaches ${tp.toFixed(1)} dBTP: inter-sample overs will distort on playback and re-encodes.`,
		});
	}
	const sub = t.prodSubCorr;
	if (sub != null && t.stereoSource !== false && sub < T.subCorrWarn) {
		out.push({
			kind: 'stereo_sub', severity: sub < T.subCorrBad ? 'bad' : 'warn', label: 'Stereo sub',
			detail: `Left/right correlation below 120 Hz is ${sub.toFixed(2)}: the low end is not mono and will thin out on a club system.`,
		});
	}
	const plr = t.prodPlr;
	if (plr != null && plr < T.plrWarnDb) {
		out.push({
			kind: 'crushed', severity: plr < T.plrBadDb ? 'bad' : 'warn', label: 'Crushed',
			detail: `Peak-to-loudness ratio is ${plr.toFixed(1)} dB: the limiter has flattened the transients.`,
		});
	}
	const ph = t.phaseCorr;
	if (ph != null && t.stereoSource !== false && ph < T.phaseBad) {
		out.push({ kind: 'phase', severity: 'bad', label: 'Out of phase', detail: `Full-band left/right correlation is ${ph.toFixed(2)}: the channels partly cancel in mono.` });
	}
	return out;
}

export function worstProductionSeverity(flags: ProductionFlag[]): ProductionFlagSeverity | null {
	if (flags.some((f) => f.severity === 'bad')) return 'bad';
	if (flags.length > 0) return 'warn';
	return null;
}
