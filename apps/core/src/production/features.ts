// The feature surface of the production profile and the learned probe: one
// list naming every scalar read off a ProductionMeasurements row (plus the
// Audiobox axes), with the direction that counts as a defect. The profile
// reports cohort percentiles and one-sided deviations from it; the probe
// (model.ts) fits weights over the same vector, so the two never disagree
// about what a feature is.
//
// Direction semantics drive the wording, not the maths: `either` features
// get a note in both directions (louder / quieter), `low` features only when
// they sit under the cohort (a PLR well above it is not a problem), `high`
// features only when above.

import type { ProductionMeasurements } from '@curator/shared/schema';

export type DefectDirection = 'low' | 'high' | 'either';

export interface ProductionFeatureDef {
	key: string;
	label: string;
	unit: string;
	defect: DefectDirection;
	get: (m: ProductionMeasurements) => number | null;
	// Wording per direction, filled with the signed dB/unit delta.
	noteHigh?: string;
	noteLow?: string;
}

const n = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const PRODUCTION_FEATURES: readonly ProductionFeatureDef[] = [
	{ key: 'lufs_i', label: 'Loudness', unit: 'LUFS', defect: 'either', get: (m) => n(m.lufs_i),
		noteHigh: 'Louder than comparable masters', noteLow: 'Quieter than comparable masters' },
	{ key: 'plr', label: 'Peak to loudness', unit: 'dB', defect: 'low', get: (m) => n(m.plr),
		noteLow: 'Less headroom between peaks and loudness: harder limiting than its peers' },
	{ key: 'lra', label: 'Loudness range', unit: 'LU', defect: 'either', get: (m) => n(m.lra),
		noteHigh: 'Wider loudness swings between sections', noteLow: 'Flatter loudness across sections' },
	{ key: 'crest_st_p50', label: 'Short-term crest', unit: 'dB', defect: 'low', get: (m) => n(m.crest_st_p50),
		noteLow: 'Transients sit closer to the average level: compression or limiting is shaving them' },
	{ key: 'noise_floor_db', label: 'Noise floor', unit: 'dBFS', defect: 'high', get: (m) => n(m.noise_floor_db),
		noteHigh: 'Quiet passages carry more noise than comparable tracks' },
	{ key: 'band_sub', label: 'Sub 20–60 Hz', unit: 'dB', defect: 'either', get: (m) => n(m.bands_db?.sub),
		noteHigh: 'More sub energy than comparable tracks', noteLow: 'Thin sub: less 20–60 Hz than comparable tracks' },
	{ key: 'band_bass', label: 'Bass 60–150 Hz', unit: 'dB', defect: 'either', get: (m) => n(m.bands_db?.bass),
		noteHigh: 'Bass-heavy against its peers', noteLow: 'Light in the bass against its peers' },
	{ key: 'band_lowmid', label: 'Low-mids 150–400 Hz', unit: 'dB', defect: 'either', get: (m) => n(m.bands_db?.lowmid),
		noteHigh: 'Low-mid build-up (mud) above comparable masters', noteLow: 'Scooped low-mids against comparable masters' },
	{ key: 'band_mid', label: 'Mids 400 Hz–2 kHz', unit: 'dB', defect: 'either', get: (m) => n(m.bands_db?.mid),
		noteHigh: 'Mid-forward against its peers', noteLow: 'Hollow mids against its peers' },
	{ key: 'band_himid', label: 'Upper mids 2–6 kHz', unit: 'dB', defect: 'either', get: (m) => n(m.bands_db?.himid),
		noteHigh: 'Harsh region (2–6 kHz) above comparable masters', noteLow: 'Soft upper mids against comparable masters' },
	{ key: 'band_high', label: 'Highs 6–16 kHz', unit: 'dB', defect: 'either', get: (m) => n(m.bands_db?.high),
		noteHigh: 'Brighter top end than its peers', noteLow: 'Duller top end than its peers' },
	{ key: 'tilt_db_oct', label: 'Spectral tilt', unit: 'dB/oct', defect: 'either', get: (m) => n(m.tilt_db_oct),
		noteHigh: 'Flatter (brighter) spectral slope than its peers', noteLow: 'Steeper (darker) spectral slope than its peers' },
	{ key: 'width_low', label: 'Width below 150 Hz', unit: 'dB', defect: 'high', get: (m) => n(m.width_db?.low),
		noteHigh: 'More side energy in the low end than comparable masters' },
	{ key: 'width_mid', label: 'Width 150 Hz–2 kHz', unit: 'dB', defect: 'either', get: (m) => n(m.width_db?.mid),
		noteHigh: 'Wider midrange image than its peers', noteLow: 'Narrower midrange image than its peers' },
	{ key: 'width_high', label: 'Width above 2 kHz', unit: 'dB', defect: 'either', get: (m) => n(m.width_db?.high),
		noteHigh: 'Wider top end than its peers', noteLow: 'Narrower top end than its peers' },
	{ key: 'sub_corr', label: 'Sub correlation', unit: '', defect: 'low', get: (m) => n(m.sub_corr),
		noteLow: 'Low end less mono than comparable masters' },
	{ key: 'kick_punch_db', label: 'Kick punch', unit: 'dB', defect: 'low', get: (m) => n(m.kick_punch_db),
		noteLow: 'Kick transients weaker than comparable tracks: the limiter may be shaving them' },
	{ key: 'sub_under_kick_db', label: 'Sub under kick', unit: 'dB', defect: 'low', get: (m) => n(m.sub_under_kick_db),
		noteLow: 'The sub does not sit under the kick as clearly as in comparable tracks' },
	{ key: 'cutoff_hz', label: 'Bandwidth', unit: 'Hz', defect: 'low', get: (m) => n(m.cutoff_hz),
		noteLow: 'Narrower bandwidth than comparable files' },
];

// Audiobox Aesthetics axes appended to the probe's vector; only PQ gets a
// cohort note in the profile.
export const AUDIOBOX_FEATURE_KEYS = ['abx_ce', 'abx_cu', 'abx_pc', 'abx_pq'] as const;

export const PROBE_FEATURE_KEYS: readonly string[] = [
	...PRODUCTION_FEATURES.map((f) => f.key),
	...AUDIOBOX_FEATURE_KEYS,
];

// The probe's input row: measurement features then the four Audiobox axes
// (null where unknown; the model imputes with the library median).
export function probeVector(m: ProductionMeasurements | null, audiobox: ArrayLike<number> | null): (number | null)[] {
	const out: (number | null)[] = PRODUCTION_FEATURES.map((f) => (m ? f.get(m) : null));
	for (let i = 0; i < 4; i++) out.push(audiobox && audiobox.length >= 4 ? n(audiobox[i]) : null);
	return out;
}
