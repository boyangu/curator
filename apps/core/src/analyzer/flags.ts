// Unified analysis flags — the single source of truth for "what to analyze"
// shared by the manual Analyze modal and the scanner-driven auto-analyze
// (Settings → Library) path. Both surfaces edit an AnalysisFlags object and
// hand it to the pipeline; this module is the one place that translates it
// into the sidecar's AnalyzeOptions wire shape.
//
// Mental model: a checked aspect means "compute Curator's value for this".
// Curator analysis and any Rekordbox-imported values live in SEPARATE schema
// slots (the analyzer only ever writes the Curator slot — see persist.ts
// persistAnalysisResult), so analysis never overwrites Rekordbox data. Which set the
// app *displays* is the global Settings → Analysis source toggle. That's why
// there's no "overwrite" flag here: there's nothing to overwrite across
// sources, only Curator's own slot to (re)compute.
//
// Advanced features are all-or-nothing in Essentia: requesting any one runs a
// single MusicExtractor pass that computes the whole bundle (brightness, power,
// dynamic_complexity, loudness_range_lu, dissonance, density) and persists them
// together. So they collapse to ONE `advanced` toggle rather than per-feature
// checkboxes that would all do the same thing.
import { PRODUCTION_QUALITY_ENABLED } from '@curator/library-logic';
import { type AnalyzeOptions, ADVANCED_FEATURES } from './sidecar.js';

// One checkbox per analysis aspect. The four basic stages are independently
// skippable; `advanced` gates the whole MusicExtractor bundle.
//
// Forward-compatible: persisted JSON is merged onto the DEFAULT_* objects, so
// adding a flag later (or carrying a stale one) doesn't break a stored
// selection.
export interface AnalysisFlags {
	// ─── Basic pipeline ───
	// beatgrid covers BPM + beatgrid + downbeats: the analyzer's
	// RhythmExtractor produces them as a unit, so they share one toggle.
	beatgrid: boolean;
	key: boolean;
	segments: boolean;
	// Waveform peaks (.cpk).
	peaks: boolean;
	// Chromaprint of the first 120 s, written onto the local source_link —
	// the cross-device identity of the file. Rides on the decode every pass
	// pays for (~0.1 s), so it defaults on everywhere.
	fingerprint: boolean;
	// ─── Advanced features (MusicExtractor — slow, +5-15s/track) ───
	// One toggle for the whole learned/Essentia bundle (all 7 scalars).
	advanced: boolean;
	// ─── Production measurements (stereo decode + DSP, +2-7s/track) ───
	// Loudness, true peak, clipping, tonal balance, stereo, transcode cliff,
	// kick measures, per-section rows. Feeds the Production profile and the
	// integrity flags.
	production: boolean;
}

// Auto-analyze of newly-ingested files: a light touch applied to every new
// track. Basics on (cheap + foundational), advanced off (adds 5-15s/track over
// a whole library).
export const DEFAULT_AUTO_FLAGS: AnalysisFlags = {
	beatgrid: true,
	key: true,
	segments: true,
	peaks: true,
	fingerprint: true,
	advanced: false,
	production: false,
};

// Manual Analyze modal: the opt-in surface for the expensive scalars. The
// common case is "add the advanced features to tracks that already have a grid"
// — so the basics default OFF (leave the existing Curator grid/key/segments
// alone; tick one to force a recompute) and advanced defaults ON. The
// selection persists across sessions.
export const DEFAULT_MANUAL_FLAGS: AnalysisFlags = {
	beatgrid: false,
	key: false,
	segments: false,
	peaks: false,
	fingerprint: true,
	advanced: true,
	production: true,
};

// The persisted auto-analyze settings object. `enabled` is the master gate
// for the scanner-driven path (auto-only — it isn't part of AnalysisFlags
// because it has no meaning for a manual one-shot analysis); `flags` is the
// shared selection that both surfaces edit.
export interface AutoAnalyzeSettings {
	enabled: boolean;
	flags: AnalysisFlags;
}

export const DEFAULT_AUTO_ANALYZE_SETTINGS: AutoAnalyzeSettings = {
	enabled: false,
	flags: { ...DEFAULT_AUTO_FLAGS },
};

// How much of the machine the analyzer may take. `workers` is the number
// of analyses running at once — and, because every worker is pinned to one
// thread, also the number of cores the analyzer can occupy — the CPU ceiling.
// (The sidecar is also niced, but under WSL that only orders work inside the
// VM, so on Windows this count is the one real lever.)
// `cpuCount` is read-only context for the UI: the sidecar's view of the
// machine (the WSL VM's allowance on Windows).
export interface AnalyzerResources {
	workers: number;
	cpuCount: number;
}

// Persisted part of AnalyzerResources (app_setting 'analyzer.resources').
export interface AnalyzerResourcesSettings {
	workers: number;
}

// Matches the sidecar's own default: one worker per core minus one for the
// master + the app's main process, capped at 4 so a fresh install stays
// subtle on big machines.
export function defaultAnalyzerWorkers(cpuCount: number): number {
	return Math.max(1, Math.min(cpuCount - 1, 4));
}

export function clampAnalyzerWorkers(workers: number, cpuCount: number): number {
	if (!Number.isFinite(workers)) return defaultAnalyzerWorkers(cpuCount);
	return Math.max(1, Math.min(Math.floor(workers), Math.max(1, cpuCount)));
}

// Translate the user-facing flags into the AnalyzeOptions payload shipped to
// the sidecar for one enqueue:
//   • A checked basic aspect computes fresh and writes the Curator slot —
//     `override_*` makes buildEffectiveOptions skip prior-injection so the
//     worker re-detects rather than reusing the previous Curator value.
//     (beatgrid maps to both override flags since BPM rides with it.)
//   • An unchecked basic aspect becomes `skip_*`. buildEffectiveOptions still
//     injects the prior Curator grid for downstream stages, so an advanced-only
//     or segments-only pass anchors on the existing grid instead of discarding
//     it. The Rekordbox slot is never touched either way.
//   • `advanced` on → request the full ADVANCED_FEATURES list (the worker runs
//     one MusicExtractor pass and returns all seven scalars).
//   • Peaks: checked → rebuild (`overridePeaks`); unchecked → `skipPeaks`.
//   • Fingerprint: unchecked → `skipFingerprint`. There's no override — the
//     print is a pure function of the file, so recomputing it rewrites the
//     same value.
export function analysisFlagsToOptions(f: AnalysisFlags): AnalyzeOptions {
	const opts: AnalyzeOptions = {
		features: f.advanced ? [...ADVANCED_FEATURES] : [],
	};

	if (!f.beatgrid) {
		opts.skipBeatgrid = true;
	} else {
		opts.overrideBeatgrid = true;
		opts.overrideBpm = true;
	}

	if (!f.key) opts.skipKey = true;
	else opts.overrideKey = true;

	if (!f.segments) opts.skipSegments = true;
	else opts.overrideSegments = true;

	if (!f.peaks) opts.skipPeaks = true;
	else opts.overridePeaks = true;

	if (!f.fingerprint) opts.skipFingerprint = true;

	// Gated here as well as in the form: persisted selections (and callers
	// off the UI) may still carry `production: true`.
	if (PRODUCTION_QUALITY_ENABLED && f.production) opts.production = true;

	return opts;
}
