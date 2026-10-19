// Track-similarity feature — decides which cells of a tracklist row light up
// because their value "neighbours" the currently loaded track. Five
// dimensions: BPM (±range), key (Camelot wheel, graded like rekordbox's
// Traffic Light), label (same label), brightness and power (±range on the
// learned 0-3 scores).
//
// Lives in its own module (like now-playing.ts) to avoid a circular dep:
// track-list.ts reads the reference track + settings at row-construction
// time, while main.ts owns pushing the player's currentTrack snapshot in via
// setSimilarityRefTrack and repainting the visible window on change. This
// module never imports player.ts or main.ts.

import { createSignal } from 'solid-js';
import type { Track } from '@curator/shared';
import { log } from '../data/log.js';

// ─── Settings ────────────────────────────────────────────────────────────────

// Key range semantics follow rekordbox's Traffic Light preference exactly
// (Preferences > View > Traffic Light, v6.5.2+). For a loaded 8A:
//   0 "Same key"      → 8A
//   1 "Related key 1" → + 8B            (relative major/minor)
//   2 "Related key 2" → + 7A, 9A        (±1 on the wheel, same letter)
//   3 "Related key 3" → + 7B, 9B        (±1 on the wheel, other letter)
// Note it's a graded EXPANSION, not "N steps around the wheel" — rekordbox
// never highlights ±2 numbers.
export type KeyRelatedLevel = 0 | 1 | 2 | 3;

// Brightness/power tolerance on the 0-3 learned-score scale. Three levels
// exposed as Tight/Medium/Wide in the settings panel.
export type MetricRange = 0.25 | 0.5 | 1;

export interface SimilaritySettings {
	enabled: boolean;                                     // master switch
	bpm:        { enabled: boolean; range: number };      // ±range BPM, 1..10
	key:        { enabled: boolean; level: KeyRelatedLevel };
	brightness: { enabled: boolean; range: MetricRange };
	power:      { enabled: boolean; range: MetricRange };
	label:      { enabled: boolean };
}

const SIMILARITY_SETTINGS_KEY = 'curator.similarity-settings.v1';

// Master off by default (opt-in feature); every dimension pre-enabled so the
// first flip of the master switch lights up something useful immediately.
const DEFAULT_SIMILARITY_SETTINGS: SimilaritySettings = {
	enabled: false,
	bpm:        { enabled: true, range: 3 },
	key:        { enabled: true, level: 2 },
	brightness: { enabled: true, range: 0.5 },
	power:      { enabled: true, range: 0.5 },
	label:      { enabled: true },
};

const clampBpmRange = (v: unknown): number => {
	const n = Math.round(Number(v));
	return Number.isFinite(n) && n >= 1 && n <= 10 ? n : DEFAULT_SIMILARITY_SETTINGS.bpm.range;
};
const sanitizeLevel = (v: unknown): KeyRelatedLevel =>
	v === 0 || v === 1 || v === 2 || v === 3 ? v : DEFAULT_SIMILARITY_SETTINGS.key.level;
const sanitizeRange = (v: unknown): MetricRange =>
	v === 0.25 || v === 0.5 || v === 1 ? v : 0.5;

function loadSimilaritySettings(): SimilaritySettings {
	try {
		const raw = localStorage.getItem(SIMILARITY_SETTINGS_KEY);
		if (!raw) return cloneSettings(DEFAULT_SIMILARITY_SETTINGS);
		const p = JSON.parse(raw) as Partial<SimilaritySettings>;
		return {
			enabled: p.enabled === true,
			bpm:        { enabled: p.bpm?.enabled !== false,        range: clampBpmRange(p.bpm?.range) },
			key:        { enabled: p.key?.enabled !== false,        level: sanitizeLevel(p.key?.level) },
			brightness: { enabled: p.brightness?.enabled !== false, range: sanitizeRange(p.brightness?.range) },
			power:      { enabled: p.power?.enabled !== false,      range: sanitizeRange(p.power?.range) },
			label:      { enabled: p.label?.enabled !== false },
		};
	} catch {
		return cloneSettings(DEFAULT_SIMILARITY_SETTINGS);
	}
}

function cloneSettings(s: SimilaritySettings): SimilaritySettings {
	return {
		enabled: s.enabled,
		bpm: { ...s.bpm },
		key: { ...s.key },
		brightness: { ...s.brightness },
		power: { ...s.power },
		label: { ...s.label },
	};
}

function saveSimilaritySettings(s: SimilaritySettings): void {
	try { localStorage.setItem(SIMILARITY_SETTINGS_KEY, JSON.stringify(s)); }
	catch (err) { log.for('similarity-settings').warn('persist failed', undefined, err); }
}

const [similaritySettingsSignal, setSimilaritySettingsSignal] = createSignal<SimilaritySettings>(loadSimilaritySettings());
export { similaritySettingsSignal };

export function updateSimilaritySettings(mutator: (draft: SimilaritySettings) => void): void {
	const next = cloneSettings(similaritySettingsSignal());
	mutator(next);
	setSimilaritySettingsSignal(next);
	saveSimilaritySettings(next);
}

// ─── Reference track ─────────────────────────────────────────────────────────
// The player's full-Track snapshot of what's loaded (playing OR paused —
// player.currentTrack survives pause and only clears at end-of-queue). main.ts
// pushes it in from an effect; row construction reads it synchronously.

let refTrack: Track | null = null;

export function setSimilarityRefTrack(t: Track | null): void {
	refTrack = t;
}
export function getSimilarityRefTrack(): Track | null {
	return refTrack;
}

// ─── Camelot relation ────────────────────────────────────────────────────────

const CAMELOT_RE = /^(\d{1,2})([AB])$/;

function parseCamelot(key: string): { num: number; mode: 'A' | 'B' } | null {
	const m = CAMELOT_RE.exec(key.trim().toUpperCase());
	if (!m) return null;
	const num = Number(m[1]);
	if (num < 1 || num > 12) return null;
	return { num, mode: m[2] as 'A' | 'B' };
}

// Smallest Traffic Light level at which `other` is highlighted when `ref` is
// loaded (see KeyRelatedLevel), or null when the keys aren't related within
// level 3 (or either key is unparseable).
export function camelotRelation(ref: string, other: string): KeyRelatedLevel | null {
	const a = parseCamelot(ref);
	const b = parseCamelot(other);
	if (!a || !b) return null;
	const d = Math.abs(a.num - b.num);
	const ring = Math.min(d, 12 - d);          // wheel wraps: 12 and 1 are adjacent
	const sameMode = a.mode === b.mode;
	if (ring === 0) return sameMode ? 0 : 1;
	if (ring === 1) return sameMode ? 2 : 3;
	return null;
}

// ─── Matching ────────────────────────────────────────────────────────────────

export type SimilarityDim = 'bpm' | 'key' | 'label' | 'brightness' | 'power';

// Graded closeness, per dimension. The configured range stays the OUTER
// bound (nothing outside it highlights); levels subdivide it into equal
// thirds — e.g. brightness range 0.5: diff ≤ 0.5/3 → level 1 (solid),
// ≤ 2·0.5/3 → level 2, ≤ 0.5 → level 3, each step more transparent. The key
// grade subdivides the same way with the wheel relation as the "diff". Label
// has no gradation (an exact match is level 1 or nothing).
export type SimilarityLevel = 1 | 2 | 3;
export type SimilarityLevels = Partial<Record<SimilarityDim, SimilarityLevel>>;

// The subset of Track the matcher reads — keeps tests free of full Track
// fixtures.
export type SimilarityFields = Pick<Track, 'bpm' | 'keyCamelot' | 'label' | 'brightness' | 'power'>;

// Epsilon absorbs float noise at the boundary — |0.7 - 2.2| computes to
// 1.5000000000000002, which must still count as "within 1.5".
const EPS = 1e-9;

const levelWithin = (a: number | null | undefined, b: number | null | undefined, range: number): SimilarityLevel | null => {
	if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
	const d = Math.abs(a - b);
	if (d <= range / 3 + EPS) return 1;
	if (d <= (2 * range) / 3 + EPS) return 2;
	if (d <= range + EPS) return 3;
	return null;
};

// Labels come from mixed upstreams (Beatport, rekordbox, manual edits) with
// inconsistent casing — compare case-insensitively after trimming. Empty
// strings never match.
const sameLabel = (a: string | null | undefined, b: string | null | undefined): boolean => {
	const an = (a ?? '').trim().toLowerCase();
	const bn = (b ?? '').trim().toLowerCase();
	return an.length > 0 && an === bn;
};

// Pure matcher — which dimensions of `t` neighbour `ref` under `s`, and at
// which closeness level (see SimilarityLevel). The master `enabled` flag is
// NOT consulted here (that's the caller's gate); per-dimension flags are.
export function computeSimilarLevels(t: SimilarityFields, ref: SimilarityFields, s: SimilaritySettings): SimilarityLevels {
	const out: SimilarityLevels = {};
	if (s.bpm.enabled) {
		const l = levelWithin(t.bpm, ref.bpm, s.bpm.range);
		if (l) out.bpm = l;
	}
	if (s.key.enabled && t.keyCamelot && ref.keyCamelot) {
		// Same thirds rule as the numeric dims, with the wheel relation (0..3)
		// as the diff and the configured grade as the range. Only relations
		// within the grade highlight at all (the grade stays the outer bound);
		// e.g. grade 3: same key + relative → level 1, ±1 same letter → 2,
		// ±1 other letter → 3. Grade 0 degenerates to same-key-only, level 1.
		const rel = camelotRelation(ref.keyCamelot, t.keyCamelot);
		if (rel != null) {
			const l = levelWithin(rel, 0, s.key.level);
			if (l) out.key = l;
		}
	}
	if (s.label.enabled && sameLabel(t.label, ref.label)) out.label = 1;
	if (s.brightness.enabled) {
		const l = levelWithin(t.brightness, ref.brightness, s.brightness.range);
		if (l) out.brightness = l;
	}
	if (s.power.enabled) {
		const l = levelWithin(t.power, ref.power, s.power.range);
		if (l) out.power = l;
	}
	return out;
}

const EMPTY_LEVELS: SimilarityLevels = {};

// Row-construction entry point (called by createTrackRow, non-reactive) —
// reads the current settings + reference track and returns the matching
// dimensions (with levels) for `t`. Empty when the feature is off or nothing
// is loaded.
export function similarLevelsFor(t: SimilarityFields): SimilarityLevels {
	const s = similaritySettingsSignal();
	if (!s.enabled || !refTrack) return EMPTY_LEVELS;
	return computeSimilarLevels(t, refTrack, s);
}
