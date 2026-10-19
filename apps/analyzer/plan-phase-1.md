# Audio Analysis Extensions — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace short-window loudness with EBUR128, promote `dissonance` + `spectral_complexity` to columns, and trigger a one-shot full re-analysis of existing tracks via an `ANALYZER_VERSION` bump.

**Architecture:** Four new nullable columns on `track_analysis`; swap one Essentia algorithm in `worker.py`; widen the `AnalyzeResult` dataclass + TS type; persist the new fields in `queue.persistResult`; add a version-mismatch scan at `AnalysisQueue` construction that enqueues stale rows at priority 0.

**Tech Stack:** Python (Essentia in `.venv-wsl`), TypeScript (Drizzle + better-sqlite3), JSON-RPC stdio bridge.

**Spec:** [apps/analyzer/design.md](design.md). This plan implements Phase 1 only (one of four). Phases 2–4 get their own plans after this lands.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/shared/src/schema.ts` | Modify | Drizzle column definitions for 4 new `track_analysis` columns |
| `apps/core/src/db/migrate.ts` | Modify | DDL (for fresh installs) + idempotent ALTER TABLE statements (for existing DBs) |
| `apps/analyzer/src/curator_analyzer/__init__.py` | Modify | Bump `ANALYZER_VERSION` to `"2.0.0"` |
| `apps/analyzer/src/curator_analyzer/worker.py` | Modify | Swap `Loudness()` for `LoudnessEBUR128`; harvest `dissonance` + `spectral_complexity`; widen `AnalyzeResult` dataclass |
| `apps/core/src/analyzer/sidecar.ts` | Modify | Widen `AnalyzeResult` TS type to match the Python dataclass |
| `apps/core/src/analyzer/queue.ts` | Modify | Persist the new columns in `persistResult`; add version-mismatch backfill in `hydrate` |
| `scripts/smoke-ebur128.py` | Create | One-shot script that drives the sidecar on a sample track and asserts new fields are present |

No new modules. No new tables. No new IPC channels.

---

## Task 1: Schema — add columns for EBUR128 + promoted scalars

**Files:**
- Modify: `packages/shared/src/schema.ts` (the `track_analysis` table, around line 440–459)
- Modify: `apps/core/src/db/migrate.ts` (DDL block + `ALTER_MIGRATIONS` array)

- [ ] **Step 1: Add columns to the Drizzle schema**

In `packages/shared/src/schema.ts`, find the `trackAnalysis` table declaration. Update the column block to add four new fields and update the comment on `loudnessLufs`. The block currently ends with `featuresJson` on the line before `duration` — keep that ordering, slot new columns in just before `featuresJson`:

```ts
export const trackAnalysis = sqliteTable('track_analysis', {
	trackId: text('track_id')
		.primaryKey()
		.references(() => track.id, { onDelete: 'cascade' }),
	bpm: real('bpm'),
	beatgrid: blob('beatgrid', { mode: 'buffer' }),
	downbeats: blob('downbeats', { mode: 'buffer' }),
	keyCamelot: text('key_camelot'),
	keyStrength: real('key_strength'),
	energy: real('energy'),
	brightness: real('brightness'),
	danceability: real('danceability'),
	dynamicComplexity: real('dynamic_complexity'),
	// EBUR128 integrated loudness (LUFS). Previously held an unrelated short-
	// window dB value computed via Essentia's `Loudness()`; the analyzer 2.0.0
	// rewrite repurposes this column to integrated LUFS. Existing rows with the
	// old semantics are re-analyzed automatically via Path A backfill on first
	// boot after the version bump.
	loudnessLufs: real('loudness_lufs'),
	loudnessRangeLu: real('loudness_range_lu'),
	truePeakDb: real('true_peak_db'),
	dissonance: real('dissonance'),
	spectralComplexity: real('spectral_complexity'),
	featuresJson: text('features_json', { mode: 'json' }).$type<Record<string, unknown> | null>(),
	duration: real('duration'),
	analyzerVersion: text('analyzer_version').notNull(),
	analyzedAt: integer('analyzed_at', { mode: 'timestamp_ms' }).notNull(),
});
```

- [ ] **Step 2: Add the same columns to the fresh-install DDL**

In `apps/core/src/db/migrate.ts`, find the `CREATE TABLE IF NOT EXISTS track_analysis (...)` block. Add the four new columns to its body, just before `features_json`:

```sql
CREATE TABLE IF NOT EXISTS track_analysis (
	track_id TEXT PRIMARY KEY REFERENCES track(id) ON DELETE CASCADE,
	bpm REAL,
	beatgrid BLOB,
	downbeats BLOB,
	key_camelot TEXT,
	key_strength REAL,
	energy REAL,
	brightness REAL,
	danceability REAL,
	dynamic_complexity REAL,
	loudness_lufs REAL,
	loudness_range_lu REAL,
	true_peak_db REAL,
	dissonance REAL,
	spectral_complexity REAL,
	features_json TEXT,
	duration REAL,
	analyzer_version TEXT NOT NULL,
	analyzed_at INTEGER NOT NULL
);
```

- [ ] **Step 3: Add idempotent ALTER TABLE statements for existing DBs**

Still in `apps/core/src/db/migrate.ts`, append to the `ALTER_MIGRATIONS` string array (after the final `UPDATE rekordbox_link ... WHERE rb_updated_at_seen IS NULL` entry):

```ts
	// EBUR128 + promoted MusicExtractor scalars (analyzer 2.0.0). All
	// nullable — Path A backfill repopulates existing rows.
	`ALTER TABLE track_analysis ADD COLUMN loudness_range_lu REAL`,
	`ALTER TABLE track_analysis ADD COLUMN true_peak_db REAL`,
	`ALTER TABLE track_analysis ADD COLUMN dissonance REAL`,
	`ALTER TABLE track_analysis ADD COLUMN spectral_complexity REAL`,
```

The existing migrate loop swallows "duplicate column" errors, so re-running is safe.

- [ ] **Step 4: Rebuild the Node-ABI better-sqlite3 and run the migration**

Run from repo root:

```
pnpm rebuild:node
pnpm db:migrate
```

Expected output: `migrating ./curator.db` then `done`, no traceback. (The `[migrate] merged ... duplicate track row(s)` line may or may not appear; it's the unrelated ISRC dedup.)

- [ ] **Step 5: Verify the schema landed**

Run from repo root:

```
sqlite3 ./curator.db "PRAGMA table_info(track_analysis);"
```

Expected: a list of columns ending with `loudness_range_lu`, `true_peak_db`, `dissonance`, `spectral_complexity` (after `loudness_lufs`, possibly interleaved with `features_json`/`duration` depending on which path created the row).

- [ ] **Step 6: Commit**

```
git add packages/shared/src/schema.ts apps/core/src/db/migrate.ts
git commit -m "feat(analyzer): add EBUR128 + scalar columns to track_analysis"
```

---

## Task 2: Bump ANALYZER_VERSION

**Files:**
- Modify: `apps/analyzer/src/curator_analyzer/__init__.py`

- [ ] **Step 1: Replace the version string**

The file currently reads:

```python
"""Curator analyzer sidecar — see main.py for the entry point."""

ANALYZER_VERSION = "0.1.0"
```

Change to:

```python
"""Curator analyzer sidecar — see main.py for the entry point."""

ANALYZER_VERSION = "2.0.0"
```

- [ ] **Step 2: Commit**

```
git add apps/analyzer/src/curator_analyzer/__init__.py
git commit -m "feat(analyzer): bump version to 2.0.0"
```

The commit is intentionally separate from the worker.py changes — the version bump is the single trigger for Path A backfill (Task 7), and isolating it makes the rollback story simple.

---

## Task 3: Swap `Loudness()` for `LoudnessEBUR128` + `TruePeakDetector` in worker.py

**Files:**
- Modify: `apps/analyzer/src/curator_analyzer/worker.py`

**Background:** Essentia's `LoudnessEBUR128` returns four streams: `(momentary[], shortTerm[], integrated, loudnessRange)`. The integrated and loudnessRange are scalars; the first two are per-frame arrays we don't keep. `LoudnessEBUR128` expects stereo input as an (N, 2) array; we duplicate our mono signal across both channels — for a mono input this is correctness-equivalent to the EBU R128 K-weighted measurement and saves a second decode.

- [ ] **Step 1: Update the Essentia import**

In `apps/analyzer/src/curator_analyzer/worker.py`, find the import block inside `analyze()` (around lines 117–124):

```python
    from essentia.standard import (
        MonoLoader,
        RhythmExtractor2013,
        BeatTrackerMultiFeature,
        KeyExtractor,
        MusicExtractor,
        Loudness,
    )
```

Replace `Loudness,` with `LoudnessEBUR128,` and add `TruePeakDetector,`:

```python
    from essentia.standard import (
        MonoLoader,
        RhythmExtractor2013,
        BeatTrackerMultiFeature,
        KeyExtractor,
        MusicExtractor,
        LoudnessEBUR128,
        TruePeakDetector,
    )
```

- [ ] **Step 2: Replace the loudness computation block**

Find this block in `analyze()` (currently around lines 183–187):

```python
    # Integrated loudness — Essentia exposes EBU R128 via the `Loudness` algo
    # for short windows; the integrated value lives in MusicExtractor under
    # different keys depending on version, so we compute it directly.
    try:
        loudness_lufs = float(Loudness()(audio))
    except Exception:
        loudness_lufs = None
```

Replace with:

```python
    # EBU R128 integrated loudness + loudness range + true peak. Mono input
    # is duplicated into a fake-stereo (N, 2) signal — K-weighting is per-channel
    # and re-summed, so duplicating is mathematically equivalent to running EBU
    # R128 on a real stereo signal whose channels are identical (which is what
    # mono playback amounts to). Saves a second AudioLoader decode pass.
    loudness_lufs: Optional[float] = None
    loudness_range_lu: Optional[float] = None
    true_peak_db: Optional[float] = None
    try:
        stereo = np.column_stack([audio, audio]).astype(np.float32)
        ebur128 = LoudnessEBUR128(sampleRate=sr)
        _momentary, _short, integrated, lra = ebur128(stereo)
        loudness_lufs = float(integrated)
        loudness_range_lu = float(lra)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"[analyzer] LoudnessEBUR128 failed: {exc}\n")
    try:
        peaks_loc, peaks_lvl = TruePeakDetector(sampleRate=sr)(audio)
        if len(peaks_lvl) > 0:
            # dBTP = 20 * log10(peak_linear). Essentia returns linear amplitudes.
            true_peak_db = float(20.0 * np.log10(max(float(np.max(peaks_lvl)), 1e-12)))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"[analyzer] TruePeakDetector failed: {exc}\n")
```

- [ ] **Step 3: Widen the `AnalyzeResult` dataclass**

Find the `AnalyzeResult` dataclass near the top of the file (around lines 47–64). Add three fields after `loudness_lufs`:

```python
@dataclass
class AnalyzeResult:
    track_id: str
    duration: float
    bpm: Optional[float]
    beatgrid: list[float]
    downbeats: list[float]
    key_camelot: Optional[str]
    key_strength: Optional[float]
    energy: Optional[float]
    brightness: Optional[float]
    danceability: Optional[float]
    dynamic_complexity: Optional[float]
    loudness_lufs: Optional[float]
    loudness_range_lu: Optional[float]
    true_peak_db: Optional[float]
    dissonance: Optional[float]
    spectral_complexity: Optional[float]
    features: dict[str, Any]
    peaks_lo_path: str
    peaks_hi_path: str
    analyzer_version: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
```

- [ ] **Step 4: Verify the file still parses**

Run from repo root (or inside WSL — either is fine, this is a pure syntax check):

```
python -c "import ast; ast.parse(open('apps/analyzer/src/curator_analyzer/worker.py').read()); print('ok')"
```

Expected: `ok`. Note: this is `python` from the host shell, not the WSL venv — we only need a parser, not the imports.

- [ ] **Step 5: Commit**

```
git add apps/analyzer/src/curator_analyzer/worker.py
git commit -m "feat(analyzer): swap Loudness for LoudnessEBUR128 + add true peak"
```

(The dataclass also gained `dissonance` + `spectral_complexity` fields; they'll get their values in Task 4. Committing now keeps Task 3 as a coherent "loudness rewrite" change.)

---

## Task 4: Harvest `dissonance` + `spectral_complexity` from MusicExtractor

**Files:**
- Modify: `apps/analyzer/src/curator_analyzer/worker.py`

**Background:** `MusicExtractor` already computes these scalars during the existing `features` stage; we currently dump them into `features_json` but don't promote to columns. The flattening in `_flatten_pool` keeps them as scalars (it skips arrays). We just need to read them out of the `features` dict and pass them through.

- [ ] **Step 1: Read the scalars out of `features` in `analyze()`**

Find the block that extracts scalars from the features pool (around lines 176–179):

```python
    energy = features.get("lowlevel.average_loudness")
    brightness = features.get("lowlevel.spectral_centroid.mean")
    danceability = features.get("rhythm.danceability")
    dynamic_complexity = features.get("lowlevel.dynamic_complexity")
```

Add two more reads immediately after:

```python
    energy = features.get("lowlevel.average_loudness")
    brightness = features.get("lowlevel.spectral_centroid.mean")
    danceability = features.get("rhythm.danceability")
    dynamic_complexity = features.get("lowlevel.dynamic_complexity")
    dissonance = features.get("lowlevel.dissonance.mean")
    spectral_complexity = features.get("lowlevel.spectral_complexity.mean")
```

- [ ] **Step 2: Pass them through to `AnalyzeResult`**

Find the `return AnalyzeResult(...)` at the bottom of `analyze()` (around lines 198–215). Add the two new fields, slotting them between `loudness_lufs` (which becomes `true_peak_db` after Task 3) and `features`:

```python
    return AnalyzeResult(
        track_id=req.track_id,
        duration=duration,
        bpm=bpm,
        beatgrid=beats_list,
        downbeats=downbeats,
        key_camelot=key_camelot,
        key_strength=float(key_strength) if key_strength is not None else None,
        energy=_maybe_float(energy),
        brightness=_maybe_float(brightness),
        danceability=_maybe_float(danceability),
        dynamic_complexity=_maybe_float(dynamic_complexity),
        loudness_lufs=loudness_lufs,
        loudness_range_lu=loudness_range_lu,
        true_peak_db=true_peak_db,
        dissonance=_maybe_float(dissonance),
        spectral_complexity=_maybe_float(spectral_complexity),
        features=features,
        peaks_lo_path=req.out_peaks_lo_path,
        peaks_hi_path=req.out_peaks_hi_path,
        analyzer_version=ANALYZER_VERSION,
    )
```

- [ ] **Step 3: Verify parse**

```
python -c "import ast; ast.parse(open('apps/analyzer/src/curator_analyzer/worker.py').read()); print('ok')"
```

Expected: `ok`.

- [ ] **Step 4: Commit**

```
git add apps/analyzer/src/curator_analyzer/worker.py
git commit -m "feat(analyzer): promote dissonance + spectral_complexity to columns"
```

---

## Task 5: Widen the TS `AnalyzeResult` type

**Files:**
- Modify: `apps/core/src/analyzer/sidecar.ts`

- [ ] **Step 1: Update the `AnalyzeResult` interface**

Find the interface around lines 71–88. Add the four new fields after `loudness_lufs`:

```ts
export interface AnalyzeResult {
	track_id: string;
	duration: number;
	bpm: number | null;
	beatgrid: number[];
	downbeats: number[];
	key_camelot: string | null;
	key_strength: number | null;
	energy: number | null;
	brightness: number | null;
	danceability: number | null;
	dynamic_complexity: number | null;
	loudness_lufs: number | null;
	loudness_range_lu: number | null;
	true_peak_db: number | null;
	dissonance: number | null;
	spectral_complexity: number | null;
	features: Record<string, unknown>;
	peaks_lo_path: string;
	peaks_hi_path: string;
	analyzer_version: string;
}
```

- [ ] **Step 2: Run typecheck — expect failures in `queue.ts`**

Run from repo root:

```
pnpm typecheck
```

Expected: TS errors in `apps/core/src/analyzer/queue.ts` (the `persistResult` function builds `NewTrackAnalysis` rows without the new fields). Those failures are Task 6's job to fix; don't commit yet.

---

## Task 6: Persist new columns in `queue.persistResult`

**Files:**
- Modify: `apps/core/src/analyzer/queue.ts`

- [ ] **Step 1: Add the new fields to the `row` literal**

Find the `persistResult` method around line 318. Update the `row` object literal:

```ts
		const row: NewTrackAnalysis = {
			trackId: result.track_id,
			bpm: result.bpm,
			beatgrid: toFloat32Buffer(result.beatgrid),
			downbeats: toFloat32Buffer(result.downbeats),
			keyCamelot: result.key_camelot,
			keyStrength: result.key_strength,
			energy: result.energy,
			brightness: result.brightness,
			danceability: result.danceability,
			dynamicComplexity: result.dynamic_complexity,
			loudnessLufs: result.loudness_lufs,
			loudnessRangeLu: result.loudness_range_lu,
			truePeakDb: result.true_peak_db,
			dissonance: result.dissonance,
			spectralComplexity: result.spectral_complexity,
			featuresJson: result.features,
			duration: result.duration,
			analyzerVersion: result.analyzer_version,
			analyzedAt: new Date(),
		};
```

- [ ] **Step 2: Mirror the new fields in the `onConflictDoUpdate.set` block**

Still in `persistResult`, update the UPSERT's `set` block:

```ts
		this.db.insert(trackAnalysis)
			.values(row)
			.onConflictDoUpdate({
				target: trackAnalysis.trackId,
				set: {
					bpm: row.bpm,
					beatgrid: row.beatgrid,
					downbeats: row.downbeats,
					keyCamelot: row.keyCamelot,
					keyStrength: row.keyStrength,
					energy: row.energy,
					brightness: row.brightness,
					danceability: row.danceability,
					dynamicComplexity: row.dynamicComplexity,
					loudnessLufs: row.loudnessLufs,
					loudnessRangeLu: row.loudnessRangeLu,
					truePeakDb: row.truePeakDb,
					dissonance: row.dissonance,
					spectralComplexity: row.spectralComplexity,
					featuresJson: row.featuresJson,
					duration: row.duration,
					analyzerVersion: row.analyzerVersion,
					analyzedAt: row.analyzedAt,
				},
			})
			.run();
```

- [ ] **Step 3: Run typecheck**

```
pnpm typecheck
```

Expected: clean (no errors).

- [ ] **Step 4: Commit**

```
git add apps/core/src/analyzer/sidecar.ts apps/core/src/analyzer/queue.ts
git commit -m "feat(analyzer): persist EBUR128 + dissonance + spectral_complexity"
```

---

## Task 7: Path A backfill — re-queue tracks with stale analyzer_version

**Files:**
- Modify: `apps/core/src/analyzer/queue.ts`

**Background:** The `hydrate()` method already runs at construction time and resets `running → queued` for crash recovery. We add a second sweep there that finds every `track_analysis` row whose `analyzer_version !== '2.0.0'` (read from the analyzer's actual exported constant — but Node can't read the Python constant, so we hardcode the expected version here and treat any mismatch as stale). For each match, we ensure an `analysis_job` row exists in `queued` state at priority 0.

Why hardcode the version on the Node side instead of asking the sidecar? The version bump is the single source of truth for "the schema/output shape changed." If we lived-queried the sidecar's version we'd have a startup ordering dependency (queue can't backfill until sidecar reports version), and the sidecar might be permanently broken (Python import error) — we still want to be able to drain the existing queue. Hardcoding the expected version in `queue.ts` ties the bump to the file every developer already touches when changing the schema.

- [ ] **Step 1: Add the expected-version constant**

Near the top of `apps/core/src/analyzer/queue.ts`, just below the imports, add:

```ts
// The analyzer version this Node code is paired with. Tracks whose
// `track_analysis.analyzer_version` differs are considered stale on boot and
// re-queued for full re-analysis at priority 0 (Path A backfill in design.md).
// Bump this in lockstep with `apps/analyzer/src/curator_analyzer/__init__.py`
// when changing the analyzer's output shape.
const EXPECTED_ANALYZER_VERSION = '2.0.0';
```

- [ ] **Step 2: Extend the `hydrate()` method with the stale-version sweep**

Find the existing `hydrate()` method (around lines 83–89):

```ts
	private hydrate(): void {
		this.db
			.update(analysisJob)
			.set({ state: 'queued', startedAt: null })
			.where(eq(analysisJob.state, 'running'))
			.run();
	}
```

Replace with:

```ts
	private hydrate(): void {
		this.db
			.update(analysisJob)
			.set({ state: 'queued', startedAt: null })
			.where(eq(analysisJob.state, 'running'))
			.run();
		this.backfillStaleVersionTracks();
	}

	// Path A backfill — find every track_analysis row whose analyzer_version
	// doesn't match EXPECTED_ANALYZER_VERSION and ensure an analysis_job row
	// exists in `queued` state. Done as a single transaction so concurrent
	// renderer queries don't see a half-written batch. Priority 0 so explicit
	// user-driven re-analyses (priority 100) still preempt.
	private backfillStaleVersionTracks(): void {
		const stale = this.db
			.select({ trackId: trackAnalysis.trackId })
			.from(trackAnalysis)
			.where(ne(trackAnalysis.analyzerVersion, EXPECTED_ANALYZER_VERSION))
			.all();
		if (stale.length === 0) return;

		const now = Date.now();
		const existing = this.db
			.select({ trackId: analysisJob.trackId, state: analysisJob.state })
			.from(analysisJob)
			.where(inArray(analysisJob.trackId, stale.map((r) => r.trackId)))
			.all();
		const existingMap = new Map(existing.map((r) => [r.trackId, r.state] as const));

		let enqueued = 0;
		for (const { trackId } of stale) {
			const cur = existingMap.get(trackId);
			if (cur === 'queued' || cur === 'running') continue;
			if (!cur) {
				const row: NewAnalysisJob = {
					trackId,
					state: 'queued',
					priority: 0,
					error: null,
					errorKind: null,
					enqueuedAt: new Date(now),
					startedAt: null,
					finishedAt: null,
				};
				this.db.insert(analysisJob).values(row).run();
			} else {
				// 'done' | 'error' | 'skipped' — flip to queued at priority 0.
				this.db.update(analysisJob)
					.set({
						state: 'queued',
						priority: 0,
						error: null,
						errorKind: null,
						enqueuedAt: new Date(now),
						startedAt: null,
						finishedAt: null,
					})
					.where(eq(analysisJob.trackId, trackId))
					.run();
			}
			enqueued++;
		}
		if (enqueued > 0) {
			console.log(`[analyzer-queue] Path A backfill: enqueued ${enqueued} track(s) stale at analyzer_version != '${EXPECTED_ANALYZER_VERSION}'`);
		}
	}
```

- [ ] **Step 3: Add the `ne` import**

The file currently imports `and, asc, desc, eq, inArray` from `drizzle-orm`. Add `ne`:

```ts
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
```

- [ ] **Step 4: Run typecheck**

```
pnpm typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```
git add apps/core/src/analyzer/queue.ts
git commit -m "feat(analyzer): Path A backfill — re-queue tracks with stale analyzer_version"
```

---

## Task 8: Smoke verification script

**Files:**
- Create: `scripts/smoke-ebur128.py`

**Background:** The repo already uses `scripts/smoke-*.py` for ad-hoc verification (see `scripts/smoke-moloko-cues.py`). This script drives the analyzer sidecar end-to-end on a single sample track and asserts the new fields are present and finite.

- [ ] **Step 1: Create the smoke script**

Create `scripts/smoke-ebur128.py` with this content:

```python
"""Smoke check: drive the analyzer sidecar on a single track and assert that
the EBUR128 + dissonance + spectral_complexity fields are populated and finite.

Usage:
    python scripts/smoke-ebur128.py "C:/path/to/sample.flac"

The script speaks the sidecar's JSON-RPC protocol directly so it doesn't
require the Node side to be running. Set CURATOR_ANALYZER_PYTHON to override
the python binary used to launch the sidecar (default: WSL venv on Windows,
.venv/bin/python elsewhere).
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: smoke-ebur128.py <audio-file>\n")
        return 2
    audio_path = argv[1]
    if not Path(audio_path).is_file():
        sys.stderr.write(f"not a file: {audio_path}\n")
        return 2

    repo_root = Path(__file__).resolve().parents[1]
    analyzer_dir = repo_root / "apps" / "analyzer"

    # Pick a python binary. On Windows we use the WSL venv via `wsl bash -c`,
    # mirroring how the desktop main spawns the sidecar (getAnalyzerSpec in
    # apps/desktop/src/main/index.ts). On other platforms use the venv.
    override = os.environ.get("CURATOR_ANALYZER_PYTHON")
    use_wsl = sys.platform == "win32" and override is None

    tmp = tempfile.mkdtemp(prefix="curator-smoke-")
    out_lo = str(Path(tmp) / "out-lo.cpk")
    out_hi = str(Path(tmp) / "out-hi.cpk")

    def to_wsl(p: str) -> str:
        # C:/x/y → /mnt/c/x/y
        if len(p) >= 2 and p[1] == ":":
            return f"/mnt/{p[0].lower()}/{p[2:].replace(chr(92), '/').lstrip('/')}"
        return p

    if use_wsl:
        cmd = [
            "wsl", "bash", "-c",
            f"cd {to_wsl(str(analyzer_dir))} && source .venv-wsl/bin/activate && python -m curator_analyzer.main",
        ]
        audio_for_sidecar = to_wsl(audio_path)
        out_lo_for_sidecar = to_wsl(out_lo)
        out_hi_for_sidecar = to_wsl(out_hi)
    else:
        py = override or str(analyzer_dir / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python"))
        cmd = [py, "-m", "curator_analyzer.main"]
        audio_for_sidecar = audio_path
        out_lo_for_sidecar = out_lo
        out_hi_for_sidecar = out_hi

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=sys.stderr,
        text=True,
        bufsize=1,  # line-buffered
        cwd=str(analyzer_dir),
    )
    assert proc.stdin and proc.stdout

    req = {
        "id": 1,
        "method": "analyze",
        "params": {
            "trackId": "smoke-test",
            "path": audio_for_sidecar,
            "outPeaksLoPath": out_lo_for_sidecar,
            "outPeaksHiPath": out_hi_for_sidecar,
        },
    }
    proc.stdin.write(json.dumps(req) + "\n")
    proc.stdin.flush()

    result_frame: dict | None = None
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        frame = json.loads(line)
        if "result" in frame:
            result_frame = frame["result"]
            break
        if "error" in frame:
            sys.stderr.write(f"sidecar error: {frame['error']}\n")
            proc.stdin.write(json.dumps({"method": "shutdown"}) + "\n")
            proc.stdin.flush()
            return 1
        # Otherwise it's a progress/partial event — print one-liner and keep reading.
        print(f"  [{frame.get('event','?')}] {frame.get('stage','?')} {frame.get('pct')}")

    proc.stdin.write(json.dumps({"method": "shutdown"}) + "\n")
    proc.stdin.flush()
    proc.wait(timeout=5)

    if result_frame is None:
        sys.stderr.write("no result frame received\n")
        return 1

    print("\nResult keys:", sorted(result_frame.keys()))
    print(f"  analyzer_version    = {result_frame.get('analyzer_version')}")
    print(f"  loudness_lufs       = {result_frame.get('loudness_lufs')}")
    print(f"  loudness_range_lu   = {result_frame.get('loudness_range_lu')}")
    print(f"  true_peak_db        = {result_frame.get('true_peak_db')}")
    print(f"  dissonance          = {result_frame.get('dissonance')}")
    print(f"  spectral_complexity = {result_frame.get('spectral_complexity')}")

    ok = True
    if result_frame.get("analyzer_version") != "2.0.0":
        sys.stderr.write(f"FAIL: analyzer_version expected '2.0.0', got {result_frame.get('analyzer_version')!r}\n")
        ok = False
    for field in ("loudness_lufs", "loudness_range_lu", "true_peak_db", "dissonance", "spectral_complexity"):
        v = result_frame.get(field)
        if v is None or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
            sys.stderr.write(f"FAIL: {field} is {v!r} (expected finite number)\n")
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

- [ ] **Step 2: Run the smoke against a known-good track**

Pick any FLAC/MP3/WAV from your library. From repo root:

```
python scripts/smoke-ebur128.py "C:/path/to/sample.flac"
```

Expected output: progress lines, then a `Result keys:` block listing the new fields with finite numeric values, then exit code 0. Typical ranges:
- `loudness_lufs` ≈ -25 to -8 (modern masters cluster around -8 to -14)
- `loudness_range_lu` ≈ 1 to 15
- `true_peak_db` ≈ -3 to +2
- `dissonance` ≈ 0.3 to 0.7
- `spectral_complexity` ≈ 2 to 25

Verified against Essentia 2.1-beta6-dev (the version in `apps/analyzer/.venv-wsl`): `LoudnessEBUR128(sampleRate=44100)(stereo_array)` returns `(momentary[], shortTerm[], integrated, loudnessRange)`. If you're on a newer Essentia and the unpack fails, run `help(LoudnessEBUR128)` inside the venv and adjust Task 3 Step 2 to match.

- [ ] **Step 3: Run the smoke through the full app**

```
pnpm rebuild:electron
pnpm dev
```

Watch the dev console. Within seconds of boot you should see:

```
[analyzer-queue] Path A backfill: enqueued N track(s) stale at analyzer_version != '2.0.0'
```

where N is your existing analyzed-track count. The queue will drain in the background at priority 0 — no UI changes are needed for this phase.

- [ ] **Step 4: Verify a backfilled row in SQLite**

After letting the app drain for ~1 minute (one track), close the app and run:

```
sqlite3 ./curator.db "SELECT track_id, analyzer_version, loudness_lufs, loudness_range_lu, true_peak_db, dissonance, spectral_complexity FROM track_analysis WHERE analyzer_version = '2.0.0' LIMIT 3;"
```

Expected: rows with `2.0.0` in `analyzer_version` and finite numbers in all five new columns.

- [ ] **Step 5: Commit the smoke script**

```
git add scripts/smoke-ebur128.py
git commit -m "test(analyzer): smoke check for EBUR128 + scalar columns"
```

---

## Phase 1 done

After Task 8 passes:
- New EBUR128 + scalar columns exist on `track_analysis` and populate on every analyze.
- All existing tracks queue for re-analysis at priority 0 on first boot.
- No UI changes — those land in Phase 2+ when segments/suggestions/voice are surfaced.

**Next phase:** Phase 2 (structure detection + suggested cues + loop candidates) gets its own plan after Phase 1 lands and we've confirmed the EBUR128 swap is solid in practice.
