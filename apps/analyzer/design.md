# Audio analysis extensions — design

**Date:** 2026-05-26
**Scope:** Extend the Essentia-based offline analyzer with structural segmentation, suggested cues/loops, EBUR128 loudness, additional MusicExtractor scalars, and an opt-in TensorFlow tier (voice / mood / danceability) with per-model lifecycle.
**Status:** Phase 1–2A **shipped** (analyzer 2.3.0): structural segmentation, suggested cues, EBUR128 loudness, dissonance/density columns, and learned brightness/power scores are live (see [research/brightness/](../../research/brightness/)). Remaining: the opt-in TensorFlow tier (voice/mood/danceability) — still design-only. The text below is the original design document.

## Goals

1. Detect labelled segments (intro/build/drop/breakdown/main/outro) on every analysed track.
2. Produce non-destructive cue and loop suggestions, separate from user-applied cues.
3. Replace the existing short-window loudness measurement with EBUR128 (integrated LUFS + LRA + true peak).
4. Promote dissonance and spectral complexity from the MusicExtractor blob into queryable columns.
5. Add a TensorFlow tier behind per-model user opt-in: voice/instrumental (frame-level curve), arousal/valence mood, and TF-based danceability. Models download on demand.

Out of scope: waveform overlays, suggestions UI panel, vocal-aware autoplay/transition logic. Those follow once the data is available.

## Schema changes — `packages/shared/src/schema.ts`

### `track_analysis` mutations

| Column | Type | Notes |
|---|---|---|
| `loudness_lufs` | `real` (repurposed) | Now EBUR128 integrated LUFS, not short-window loudness |
| `loudness_range_lu` | `real` (new) | EBUR128 LRA |
| `true_peak_db` | `real` (new) | dBTP |
| `dissonance` | `real` (new) | promoted from MusicExtractor |
| `spectral_complexity` | `real` (new) | promoted from MusicExtractor |
| `segments_json` | `text mode:json` (new) | `SegmentRecord[]` |
| `suggested_cues_json` | `text mode:json` (new) | `SuggestedCueRecord[]` |
| `voice_curve` | `blob` (new) | Packed Float32 LE, vocal probability sampled at `voice_curve_hz` |
| `voice_curve_hz` | `real` (new) | sample rate of the curve (default 2.0 = every 500ms) |
| `mood_arousal` | `real` (new) | TF arousal (energy/intensity axis, 0–1) |
| `mood_valence` | `real` (new) | TF valence (happy/sad axis, 0–1) |
| `danceability` | `real` (existing, source widened) | When TF on: TF-model output; else MusicExtractor heuristic |
| `tf_version` | `text` (new, nullable) | null = TF tier never ran for this row |

`ANALYZER_VERSION` bumps from current to `"2.0.0"`. On core boot, rows with mismatched `analyzer_version` are enqueued at priority `0` for re-analysis (Path A backfill below).

### New table — `analyzer_model`

Persistent state for the per-model lifecycle (download, ready, error). One row per logical model.

```ts
export const ANALYZER_MODEL_STATES = ['not_downloaded', 'downloading', 'ready', 'error'] as const;

export const analyzerModel = sqliteTable('analyzer_model', {
  key: text('key').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  state: text('state', { enum: ANALYZER_MODEL_STATES }).notNull().default('not_downloaded'),
  downloadPct: integer('download_pct').notNull().default(0),
  filesSha256: text('files_sha256', { mode: 'json' }).$type<string[] | null>(),
  filePaths:   text('file_paths',   { mode: 'json' }).$type<string[] | null>(),
  sizeBytes:   integer('size_bytes'),
  downloadedAt: integer('downloaded_at', { mode: 'timestamp_ms' }),
  error: text('error'),
});
```

State is reset at boot: any row in `downloading` is reset to `not_downloaded` (next toggle re-fetches; partial `.pb.part` files cleaned up).

### `analysis_job` mutation

Add columns to support TF-only partial backfill (Path B):

| Column | Type | Notes |
|---|---|---|
| `kind` | `text enum:['full','tf']` | default `'full'` |
| `models` | `text mode:json` (nullable) | `string[]` of analyzer-model keys, used only when `kind='tf'` |

Dispatch query becomes `state='queued' ORDER BY priority DESC, enqueued_at ASC` with the same shape as today. TF-only jobs filter at dispatch time: `models ⊆ enabledModelKeys`; jobs whose required model has since been disabled are dropped.

### Shared types

```ts
export type SegmentLabel = 'intro' | 'build' | 'drop' | 'breakdown' | 'main' | 'outro' | 'unknown';

export type SegmentRecord = {
  startSec: number;
  endSec: number;
  label: SegmentLabel;
  confidence: number;  // 0–1
  energy: number;      // mean BeatsLoudness in segment, normalized 0–1
};

export type SuggestedCueKind =
  | 'drop' | 'build-start' | 'breakdown-start'
  | 'outro-start' | 'intro-end' | 'loop';

export type SuggestedCueRecord = {
  positionSec: number;
  lengthSec: number | null;   // null/0 = point; >0 = loop region
  kind: SuggestedCueKind;
  confidence: number;          // 0–1
  reason: string;              // human-readable, e.g. "largest BeatsLoudness step at downbeat"
  color?: string;
  name?: string;
};
```

## Analyzer pipeline — `apps/analyzer/src/curator_analyzer/worker.py`

`analyze()` becomes a stage sequence. The existing decode/rhythm/key path is untouched; new stages are additive.

```
 1. decode             (existing)
 2. rhythm             (existing)
 3. key                (existing)
 4. features           (existing — now also harvests dissonance + spectral_complexity)
 5. loudness           (NEW   — LoudnessEBUR128, replaces Loudness())
 6. structure          (NEW   — see below)
 7. suggested_cues     (NEW   — derived from segments + per-beat loudness)
 8. loop_candidates    (NEW   — LoopBpmConfidence over windowed regions)
 9. tf_tier (optional) (NEW   — separate venv, only enabled models)
10. peaks              (existing — 3-band → .cpk)
```

### Stage 6 — structure detection

- Compute `NoveltyCurve` over MFCC frames + `BeatsLoudness` per beat.
- Pick boundary candidates from novelty peaks; quantize each to the nearest downbeat.
- Filter: drop boundaries < 8 bars apart unless novelty z-score is unusually high.
- Label by rule:
  - First segment = `intro`, last = `outro`.
  - Segment with mean `BeatsLoudness` ≥ p80 of track AND ≥ 8 bars = `drop`.
  - Lowest-energy segment in the middle third = `breakdown`.
  - Rising-energy ramp into a `drop` = `build`.
  - Default = `main`.
- Confidence = combined novelty strength + downbeat alignment quality.

### Stage 7 — suggested cues

- `intro-end` = end of first `intro` segment.
- `drop` = start of each `drop` segment.
- `breakdown-start` / `outro-start` = start of those labelled segments.
- All point cues. Confidence inherited from the source segment.

### Stage 8 — loop candidates

- For each 8/16/32-bar window aligned to downbeats inside a non-`drop` segment, score with `LoopBpmConfidence`.
- Keep top N (cap at 4) above a confidence threshold; emit `kind: 'loop'` with `lengthSec = bar_count * beats_per_bar / (bpm/60)`.

### Stage 9 — TF tier

Runs only when at least one model is enabled (and `ready`) for this run. The set of enabled+ready models is read from `analyzer_model` once at queue-dispatch time and passed into `AnalyzeRequest.tf_models: string[]`. The analyzer process trusts that list; it does not re-read DB state.

- TF runner is a long-lived child process inside `.venv-wsl-tf` (separate from the main worker pool's `.venv-wsl`, because `essentia` and `essentia-tensorflow` cannot co-exist in one env).
- Runner accepts one job per stdin line: `{trackId, path, models: string[]}` → returns the requested outputs.
- Models loaded lazily on first job that requests them; held in memory for the runner's lifetime.
- Models in scope:
  - `voice_instrumental` → Discogs-EffNet voice/instrumental head. Frame-level probability resampled to 2 Hz Float32 LE → `voice_curve` blob.
  - `mood_arousal_valence` → emomusic head → `mood_arousal`, `mood_valence`.
  - `danceability_tf` → MusiCNN danceability head → overwrites `danceability` column.
- On TF crash: main pool continues; the affected row's `tf_version` stays `NULL`; the error surfaces on the analyzer event channel.

### Versioning

- `ANALYZER_VERSION = "2.0.0"` covers the Essentia-side schema change.
- `TF_RUNNER_VERSION = "1.0.0"` is independent. Bumping it (e.g., new model checkpoint) re-queues only TF-only partial jobs.
- `_classify_error` gains kinds: `structure`, `suggested_cues`, `loops`, `tf`.

## TF runner — venv, models, distribution

### venv layout

- `apps/analyzer/.venv-wsl` — existing, `essentia` (no TF).
- `apps/analyzer/.venv-wsl-tf` — new, `essentia-tensorflow` + tensorflow + minimal deps. Created on first download attempt.

### Model catalog — `packages/shared/src/analyzerModels.ts`

Source-of-truth array; not user-editable. Each model owns its files atomically (no cross-model dependency tracking — accept ~90MB duplicated backbone weights for simplicity).

```ts
export type AnalyzerModelFile = { url: string; sha256: string; sizeBytes: number };

export type AnalyzerModelDef = {
  key: 'voice_instrumental' | 'mood_arousal_valence' | 'danceability_tf';
  label: string;
  desc: string;
  columns: string[];           // track_analysis columns populated by this model
  files: AnalyzerModelFile[];  // backbone .pb + head .pb (downloaded atomically)
};

export const ANALYZER_MODELS: readonly AnalyzerModelDef[] = [
  { key: 'voice_instrumental', /* … */ files: [/* effnet base, voice head */] },
  { key: 'mood_arousal_valence', /* … */ },
  { key: 'danceability_tf', /* … */ },
];
```

URLs and SHA256s are pinned at implementation time from Essentia's published model index.

### Lifecycle when a user toggles a model on

```
UI: writes enabled=true → CoreService.setAnalyzerModelEnabled(key, true)
Core: state='downloading' →
      fetch each file → stream to <userData>/analyzer-models/<file>.pb.part →
      emit downloadPct events → verify sha256 → atomic rename →
      when all files present: state='ready' →
      enqueue Path B backfill jobs (TF-only, partial)
```

### Where the files live

`<userData>/analyzer-models/<key>/<file>.pb` — per-user cache, gitignored, SHA-verified on load.

## IPC & service contract

### New `CoreService` methods

```ts
listAnalyzerModels(): Promise<AnalyzerModelRow[]>;
setAnalyzerModelEnabled(key: string, enabled: boolean): Promise<void>;
retryAnalyzerModelDownload(key: string): Promise<void>;
removeAnalyzerModelFile(key: string): Promise<void>;
```

### Existing methods — return-shape changes

- `getTrackAnalysis(trackId)` — widens to include `segments`, `suggestedCues`, `voiceCurve?` (decoded `Float32Array`), `voiceCurveHz?`, `moodArousal?`, `moodValence?`, `loudnessIntegratedLufs`, `loudnessRangeLu`, `truePeakDb`, `dissonance`, `spectralComplexity`. Existing fields unchanged.
- `analyzeTrack(trackId, opts?)` — `opts` gains `models?: string[]`. When set, short-circuits to a TF-only partial run that reads the existing analysis row, re-decodes audio, runs only the requested models, writes only their columns + bumps `tf_version`. No-arg call retains current "full analyze" semantics.

### Analyzer event channel — new kinds

```ts
| { kind: 'model-download-progress'; key: string; pct: number }
| { kind: 'model-download-done';     key: string }
| { kind: 'model-download-error';    key: string; message: string }
```

### Wire-up (lockstep, per CLAUDE.md)

1. Schema + migration — `packages/shared/src/schema.ts` + `apps/core/src/db/migrate.ts`.
2. Backend — methods on `CoreService` in `apps/core/src/service.ts` (extract `apps/core/src/analyzer/models.ts` if it grows).
3. IPC channels — `apps/desktop/src/ipc.ts`.
4. Main-process handlers — `apps/desktop/src/main/handlers.ts`.
5. Preload — `apps/desktop/src/preload/index.ts`.
6. Renderer — `analyzerModelsStore` (SolidJS) + new **Analysis** tab in `SettingsModal.tsx`.

## Backfill & re-analysis behavior

### Path A — `ANALYZER_VERSION` bump → full re-analysis

- On core boot, scan `track_analysis` for `analyzer_version != '2.0.0'` → enqueue at priority `0`.
- Runs the full pipeline (stages 1–8 + 10, plus any enabled TF models in stage 9).
- Existing `analysis_job` queue handles dispatch — no new queue infra.

### Path B — model-toggle → TF-only partial backfill

- Triggered when `setAnalyzerModelEnabled(key, true)` finishes downloading.
- Enqueues `analysis_job` rows with `kind='tf'`, `models=[key]`, priority `-10`.
- Dispatcher invokes `analyzeTrack(trackId, { models: [key] })`:
  - Loads existing analysis row.
  - Re-decodes audio.
  - Runs only the requested TF models.
  - Writes only those columns + bumps `tf_version`.
  - `analyzer_version` stays at `2.0.0`.

### Priority shape (unchanged convention)

| Trigger | Priority |
|---|---|
| User-driven re-analyze | 100 |
| Newly-scanned track | 0 |
| Path A backfill | 0 |
| Path B backfill | -10 |

### Idempotency & crash recovery

- Existing `running → queued` reset on boot covers crash recovery.
- TF-only jobs are idempotent (rewriting same columns is a no-op).
- `downloading` model rows reset to `not_downloaded` on boot; partial `.pb.part` files deleted.

### Dedup between Path A and Path B

When a track has both a Path A row (`kind='full'`) and Path B rows (`kind='tf'`) queued, the dispatcher prefers the full job and drops the redundant TF-only rows for that track on dispatch — the full job will populate all currently-enabled TF columns anyway.

### Toggling off / removing

- Toggle off → stops new TF work for that model; in-flight Path B jobs filtered at dispatch (`models ∩ enabledModels`); existing TF columns untouched.
- `removeAnalyzerModelFile(key)` → deletes `.pb` files, resets state to `not_downloaded`; existing TF columns untouched (data was good when computed; deletion just frees disk).

## Path translation (WSL)

The TF runner lives in `.venv-wsl-tf`. The Windows path → WSL path translation already wrapped at the analyzer-process boundary (`getAnalyzerSpec()` in `apps/desktop/src/main/index.ts`) covers it; no new boundary to introduce.

## Testing strategy

- Per-stage unit tests on synthetic audio fixtures: `segment(audio, beats, downbeats) -> SegmentRecord[]`, suggestion derivation, loop windowing.
- TF tier mocked at the runner-process boundary for non-TF integration tests.
- Schema migration smoke via `pnpm db:migrate`.
- End-to-end smoke: one tracked sample through full pipeline with `voice_instrumental` enabled.

## Phasing (for the implementation plan)

Likely phase split — to be confirmed in the implementation plan:

1. Schema + EBUR128 + dissonance/spectral-complexity promotion + `ANALYZER_VERSION` bump + Path A backfill.
2. Structure stage (segments) + suggested-cues + loop-candidates.
3. TF runner skeleton: `.venv-wsl-tf` bootstrap, model-catalog + download/sha lifecycle, `analyzer_model` table + IPC + Analysis settings tab.
4. TF models wired (voice/instrumental → mood → danceability) + Path B backfill.
