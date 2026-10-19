"""Single-track analysis pipeline.

One call to `analyze(...)` runs the full Essentia chain end-to-end for one
audio file:

  1. Decode → MonoLoader (resamples to 44.1 kHz)
  1b. Print → Chromaprinter over the first 120 s (cross-device identity)
  2. Rhythm  → RhythmExtractor2013 (BPM + beats + confidence)
  3. Down    → BeatTrackerMultiFeature (downbeats; runs separately because
               RhythmExtractor2013 doesn't expose phase)
  4. Key     → KeyExtractor (Krumhansl/Temperley/EDMA — we use EDMA for the
               electronic-music tilt)
  5. Feat    → MusicExtractor (scalar danceability/energy/etc.)
  6. Peaks   → 3-band biquad + decimate → .cpk file on disk

Each pipeline stage can call `emit(stage, pct)` to push a progress event
back to the master process. Stages also emit `partial` records as soon as
their data is available — the queue forwards these to the renderer so the
UI can paint BPM/key seconds before the full result lands.

Workers are spawned as child processes (multiprocessing.Pool); Essentia is
imported lazily inside the worker so the master process boot stays fast.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from dataclasses import dataclass, asdict, field
from typing import Any, Callable, Optional

import numpy as np

from . import ANALYZER_VERSION
from . import scoring
from .peaks import compute_peaks, compute_peaks_stereo, write_cpk_pair


@dataclass
class AnalyzeRequest:
    track_id: str
    path: str
    out_peaks_lo_path: str
    out_peaks_hi_path: str
    # Per-call analyzer tuning. Empty dict = use defaults. Currently
    # recognized keys:
    #   - 'rhythm_method': 'multifeature' (default) | 'degara'
    #       'multifeature' is the robust-but-slow path (best across genres);
    #       'degara' is ~2x faster with a small accuracy hit on non-4/4
    #       material.
    #   - 'features': list[str] of advanced feature keys to compute
    #       (see ADVANCED_FEATURE_KEYS below). MusicExtractor is the source
    #       of all of them and is all-or-nothing in Essentia, so if ANY key
    #       in this list is recognised we run ME once and write all six.
    #       Empty list / missing = skip MusicExtractor entirely (the fast
    #       default for scanner-driven auto-analyses).
    #   - 'skip_beatgrid' / 'skip_key' / 'skip_segments' / 'skip_peaks' /
    #       'skip_fingerprint': bool; leave that stage out of this pass.
    # Future-proof shape: unrecognised keys are ignored, so the renderer
    # can ship new override knobs ahead of worker support landing.
    options: dict[str, Any] = field(default_factory=dict)


# Feature keys the user can request via options['features']. All six come
# from MusicExtractor's pool; the worker runs ME if any are requested and
# writes the resulting scalars into the matching AnalyzeResult fields.
# Keys mirror the AnalyzeResult field names (the product-side labels), not
# Essentia's internal pool keys.
ADVANCED_FEATURE_KEYS: frozenset[str] = frozenset({
    "brightness",
    "power",
    "dynamic_complexity",
    "loudness_range_lu",
    "dissonance",
    "density",
})


@dataclass
class AnalyzeResult:
    track_id: str
    duration: float
    bpm: Optional[float]
    beatgrid: list[float]
    downbeats: list[float]
    key_camelot: Optional[str]
    key_strength: Optional[float]
    # `brightness` is no longer the raw spectral centroid — it's the curator-aligned
    # learned score (scoring.brightness_power); `power` is the new energy/density score.
    # Both come from one MusicExtractor pass via scoring.py; see
    # research/brightness/BRIGHTNESS_CALCULATION.md.
    brightness: Optional[float]
    power: Optional[float]
    # `density` is Essentia's `lowlevel.spectral_complexity.mean`. The semantic
    # mapping is set in product terms, not Essentia's — see the column comments
    # in packages/shared/src/schema.ts. (Essentia's `rhythm.danceability` is no
    # longer surfaced as a product scalar, but it's still computed inside the
    # MusicExtractor pass and consumed by the brightness/power learned models.)
    dynamic_complexity: Optional[float]
    loudness_range_lu: Optional[float]
    dissonance: Optional[float]
    density: Optional[float]
    # Stage 6 — structural segmentation. `segments` is the full labelled array
    # (intro/build/drop/breakdown/main/outro, plus 'unknown' for low-confidence
    # boundaries). The five derived scalars are mirrored onto `track` for
    # sort/filter; *_count fields are 0 (not None) when the stage ran cleanly
    # but found nothing labelled. None across the board only when the stage
    # itself failed to produce a result.
    segments: list[dict[str, Any]] = field(default_factory=list)
    intro_length_sec: Optional[float] = None
    outro_length_sec: Optional[float] = None
    first_drop_sec: Optional[float] = None
    drop_count: Optional[int] = None
    breakdown_count: Optional[int] = None
    # Chromaprint of the first 120 s (the AcoustID window) as the base64
    # string the library emits, plus the integer duration AcoustID lookups
    # take alongside it. Both None when the stage was skipped
    # (skip_fingerprint) or failed — the TS side writes source_link only
    # when a fingerprint was actually produced.
    fingerprint: Optional[str] = None
    fingerprint_duration_sec: Optional[int] = None
    features: dict[str, Any] = field(default_factory=dict)
    peaks_lo_path: str = ""
    peaks_hi_path: str = ""
    analyzer_version: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# Krumhansl key → Camelot Wheel. Lookup keyed on "<pitch> <scale>" from
# Essentia's KeyExtractor output. We pre-build the table so the conversion
# is O(1) at runtime.
_KEY_TO_CAMELOT: dict[str, str] = {
    # Major (B side of the wheel)
    "B major":  "1B", "F# major": "2B", "Db major": "3B", "Ab major": "4B",
    "Eb major": "5B", "Bb major": "6B", "F major":  "7B", "C major":  "8B",
    "G major":  "9B", "D major":  "10B", "A major": "11B", "E major": "12B",
    # Minor (A side)
    "G# minor": "1A", "D# minor": "2A", "A# minor": "3A", "F minor":  "4A",
    "C minor":  "5A", "G minor":  "6A", "D minor":  "7A", "A minor":  "8A",
    "E minor":  "9A", "B minor":  "10A", "F# minor": "11A", "C# minor": "12A",
    # Sharp/flat aliases Essentia sometimes emits
    "C# major": "3B", "D# major": "4B", "G# major": "9B", "Ab minor": "1A",
    "Eb minor": "2A", "Bb minor": "3A", "Db minor": "12A",
}


def _key_to_camelot(pitch: str, scale: str) -> Optional[str]:
    return _KEY_TO_CAMELOT.get(f"{pitch} {scale}")


# ──────────────────────────────────────────────────────────────────────────────
# Stage 6 — structural segmentation
#
# Detects intro/build/drop/breakdown/main/outro regions from the novelty curve
# of mel-band spectral frames, snapped to the downbeat grid. Algorithm follows
# apps/analyzer/design.md (NoveltyCurve + BeatsLoudness + rule-based labelling)
# with one studio-curation tweak: segments whose detection confidence is below
# `_SEGMENT_CONFIDENCE_THRESHOLD` get demoted to label='unknown' so derived
# scalars (drop_count, breakdown_count, first_drop_sec) stay honest. The
# intro/outro positional labels are unconditional — track start/end are
# definitionally known.

_SEGMENT_CONFIDENCE_THRESHOLD = 0.5


def _compute_novelty(audio: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
    """Compute novelty curve over mel-band spectral frames.

    Returns (novelty_array, hop_sec). novelty[i] is the change-detection
    score for frame i; hop_sec converts frame index → seconds for boundary
    placement before downbeat snap."""
    from essentia.standard import FrameGenerator, Windowing, Spectrum, MelBands, NoveltyCurve

    frame_size = 2048
    hop_size = 1024
    hop_sec = hop_size / sr
    frame_rate = sr / hop_size

    w = Windowing(type='hann')
    spec = Spectrum()
    mel = MelBands(numberBands=40, sampleRate=sr,
                   lowFrequencyBound=27.5, highFrequencyBound=16000.0)

    rows: list[np.ndarray] = []
    for frame in FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size, startFromZero=True):
        rows.append(np.asarray(mel(spec(w(frame))), dtype=np.float32))
    if not rows:
        return np.array([], dtype=np.float32), hop_sec

    mel_matrix = np.stack(rows, axis=0)
    nc = NoveltyCurve(frameRate=frame_rate)
    novelty = np.asarray(nc(mel_matrix), dtype=np.float32)
    return novelty, hop_sec


def _peak_pick(novelty: np.ndarray, hop_sec: float, z_threshold: float = 1.0) -> list[tuple[float, float]]:
    """Returns list of (time_sec, z_score) for local maxima above z_threshold.

    Z-scoring against the track's own novelty mean/std makes the threshold
    self-tuning across loud/quiet masters; tracks with low novelty contrast
    surface fewer boundaries (which is the correct behaviour — a track with
    no structural changes shouldn't be force-segmented)."""
    if novelty.size < 3:
        return []
    mean = float(novelty.mean())
    std = float(novelty.std()) + 1e-9
    z = (novelty - mean) / std
    peaks: list[tuple[float, float]] = []
    for i in range(1, len(z) - 1):
        if z[i] > z[i - 1] and z[i] > z[i + 1] and z[i] > z_threshold:
            peaks.append((float(i * hop_sec), float(z[i])))
    return peaks


def _snap_to_downbeat(t: float, downbeats: list[float]) -> float:
    """Nearest-downbeat snap. Falls through when downbeats is empty (degenerate
    case — analyzer returned no rhythm; better to keep the raw boundary than
    drop it)."""
    if not downbeats:
        return t
    return float(min(downbeats, key=lambda d: abs(d - t)))


def _filter_close_boundaries(
    boundaries_with_z: list[tuple[float, float]],
    bpm: float,
    min_bars: float = 8.0,
    high_z_threshold: float = 3.0,
) -> list[tuple[float, float]]:
    """Drop boundaries less than `min_bars` apart unless the later boundary's
    z-score is so high (>= high_z_threshold) that we accept the rapid change
    anyway. Prevents the rule labeller from splitting a long section just
    because the spectral content wobbled mid-segment."""
    if not boundaries_with_z or bpm <= 0:
        return boundaries_with_z
    beats_per_bar = 4
    bar_dur = (60.0 / bpm) * beats_per_bar
    min_gap = bar_dur * min_bars

    sorted_b = sorted(boundaries_with_z, key=lambda x: x[0])
    result: list[tuple[float, float]] = [sorted_b[0]]
    for t, z in sorted_b[1:]:
        if t - result[-1][0] < min_gap and z < high_z_threshold:
            continue
        result.append((t, z))
    return result


def _build_segments(
    boundaries_with_z: list[tuple[float, float]],
    duration: float,
    beats: list[float],
    beat_loudness: np.ndarray,
) -> list[dict[str, Any]]:
    """Construct raw segment records from boundary points. Track start (0.0)
    and end (duration) are implicit boundaries that open the first segment
    and close the last; novelty z-score isn't available there, so we mark the
    track-start segment's confidence as 1.0 (intro is positional, unconditional)
    and the others inherit their *opening* boundary's z-score."""
    # Deduplicate boundary times so a downbeat snap collision doesn't create
    # a zero-length segment.
    seen: set[float] = set()
    uniq: list[tuple[float, float]] = []
    for t, z in sorted(boundaries_with_z, key=lambda x: x[0]):
        if t in seen or t <= 0.0 or t >= duration:
            continue
        seen.add(t)
        uniq.append((t, z))

    times = [0.0] + [b[0] for b in uniq] + [duration]
    z_at: dict[float, float] = {b[0]: b[1] for b in uniq}

    beats_arr = np.asarray(beats, dtype=np.float32) if beats else np.array([], dtype=np.float32)
    loud_arr = np.asarray(beat_loudness, dtype=np.float32) if beat_loudness is not None else np.array([], dtype=np.float32)
    max_loud = float(loud_arr.max()) if loud_arr.size else 0.0

    segments: list[dict[str, Any]] = []
    for i in range(len(times) - 1):
        start = times[i]
        end = times[i + 1]

        if beats_arr.size and loud_arr.size and max_loud > 0:
            mask = (beats_arr >= start) & (beats_arr < end)
            indices = np.where(mask)[0]
            valid = indices[indices < loud_arr.size]
            energy = float(loud_arr[valid].mean()) / max_loud if valid.size else 0.0
        else:
            energy = 0.0
        energy = max(0.0, min(1.0, energy))

        if start == 0.0:
            # Track-start boundary has no novelty signal — but intro is a
            # positional label and not subject to confidence gating, so 1.0
            # is the honest value here.
            confidence = 1.0
        else:
            z = z_at.get(start, 0.0)
            # Map z=1 → 0.0, z=3 → 1.0 (linear; saturates outside).
            confidence = max(0.0, min(1.0, (z - 1.0) / 2.0))

        segments.append({
            'startSec': float(start),
            'endSec': float(end),
            'label': 'main',
            'source': 'analyzer',
            'confidence': float(confidence),
            'energy': float(energy),
        })
    return segments


def _label_segments(segments: list[dict[str, Any]], bpm: float) -> list[dict[str, Any]]:
    """Rule-based labelling per design.md:
      - First/last segments are positional: intro / outro.
      - Drop = mean energy >= p80 AND length >= 8 bars (rule from design.md).
      - Breakdown = lowest-energy 'main' segment in the middle third.
      - Build = 'main' segment preceding a drop with rising energy.
      - Else: 'main'."""
    if not segments:
        return segments

    segments[0]['label'] = 'intro'
    if len(segments) > 1:
        segments[-1]['label'] = 'outro'
    if len(segments) <= 2:
        return segments

    energies = np.array([s['energy'] for s in segments], dtype=np.float32)
    p80 = float(np.percentile(energies, 80))
    bar_dur = (60.0 / bpm) * 4 if bpm > 0 else 2.0  # ~120 BPM fallback
    min_drop_length = 8 * bar_dur

    for s in segments[1:-1]:
        length = s['endSec'] - s['startSec']
        if s['energy'] >= p80 and length >= min_drop_length:
            s['label'] = 'drop'

    n = len(segments)
    middle = segments[n // 3: max(n // 3 + 1, (2 * n) // 3)]
    main_middle = [s for s in middle if s['label'] == 'main']
    if main_middle:
        lowest = min(main_middle, key=lambda s: s['energy'])
        lowest['label'] = 'breakdown'

    for i in range(len(segments) - 1):
        cur = segments[i]
        nxt = segments[i + 1]
        if nxt['label'] == 'drop' and cur['label'] == 'main' and cur['energy'] < nxt['energy']:
            cur['label'] = 'build'

    return segments


def _confidence_gate(segments: list[dict[str, Any]], threshold: float = _SEGMENT_CONFIDENCE_THRESHOLD) -> list[dict[str, Any]]:
    """Demote labels below confidence threshold to 'unknown'. intro/outro are
    positional — never demoted (the track start/end is always known, even if
    the novelty signal at the *adjacent* boundary is weak)."""
    for s in segments:
        if s['label'] in ('intro', 'outro'):
            continue
        if s['confidence'] < threshold:
            s['label'] = 'unknown'
    return segments


def _derive_segment_scalars(segments: list[dict[str, Any]]) -> dict[str, Any]:
    """Five mirror-to-track scalars from the labelled segment array. Length
    fields fall back to None when the corresponding label is absent; the
    count fields are 0 (not None) when the stage ran but found nothing —
    `None` is reserved for the not-analyzed state."""
    intro = next((s for s in segments if s['label'] == 'intro'), None)
    outro = next((s for s in reversed(segments) if s['label'] == 'outro'), None)
    drops = [s for s in segments if s['label'] == 'drop']
    breakdowns = [s for s in segments if s['label'] == 'breakdown']
    return {
        'intro_length_sec': float(intro['endSec'] - intro['startSec']) if intro else None,
        'outro_length_sec': float(outro['endSec'] - outro['startSec']) if outro else None,
        'first_drop_sec': float(drops[0]['startSec']) if drops else None,
        'drop_count': len(drops),
        'breakdown_count': len(breakdowns),
    }


def _segment(audio: np.ndarray, sr: int, beats: list[float], downbeats: list[float], bpm: float) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Orchestrator for Stage 6. Returns (segments, derived_scalars).

    Failure mode is best-effort: any sub-step that raises produces an empty
    segment array and None-valued scalars. The stage is wrapped in a try
    at the call site (analyze()), so an exception here does not fail the
    whole analysis."""
    novelty, hop_sec = _compute_novelty(audio, sr)
    if novelty.size == 0:
        return [], {
            'intro_length_sec': None,
            'outro_length_sec': None,
            'first_drop_sec': None,
            'drop_count': 0,
            'breakdown_count': 0,
        }

    # Per-beat loudness for energy labelling. BeatsLoudness can be picky on
    # very short tracks or empty beat lists; fail soft.
    beat_loudness = np.array([], dtype=np.float32)
    if beats:
        try:
            from essentia.standard import BeatsLoudness
            bl = BeatsLoudness(sampleRate=sr, beats=list(beats))
            loud, _ = bl(audio)
            beat_loudness = np.asarray(loud, dtype=np.float32)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"[analyzer] BeatsLoudness failed: {exc}\n")

    raw_peaks = _peak_pick(novelty, hop_sec)
    snapped = [(_snap_to_downbeat(t, downbeats), z) for (t, z) in raw_peaks]
    filtered = _filter_close_boundaries(snapped, bpm)

    duration = float(audio.size / sr)
    raw_segments = _build_segments(filtered, duration, beats, beat_loudness)
    labelled = _label_segments(raw_segments, bpm)
    gated = _confidence_gate(labelled)
    scalars = _derive_segment_scalars(gated)
    return gated, scalars


# ──────────────────────────────────────────────────────────────────────────────
# Essentia is imported inside the worker (not at module load) so the master
# process startup stays cheap. The first analyze call in a worker pays ~1.5s
# of Essentia/Numpy import; subsequent calls in that worker reuse the loaded
# module.
_essentia_loaded = False


def _ensure_essentia() -> None:
    global _essentia_loaded
    if _essentia_loaded:
        return
    # Side-effect import; cached on the module table.
    import essentia.standard  # noqa: F401
    _essentia_loaded = True


def analyze(req: AnalyzeRequest, emit: Callable[[str, str, Optional[float]], None]) -> AnalyzeResult:
    """Run the full analysis chain. `emit(event, stage, pct)` reports progress.

    `event` is one of:
      - 'progress' → {stage, pct}
      - 'partial'  → handled by emitting partial results from the caller
    """
    _ensure_essentia()
    from essentia.standard import (
        MonoLoader,
        RhythmExtractor2013,
        BeatTrackerMultiFeature,
        KeyExtractor,
        MusicExtractor,
    )

    emit("progress", "decode", 0.0)
    # 44.1 kHz is Essentia's default and matches what most music is mastered
    # at. Resampling here means downstream stages don't need to care about
    # the source rate.
    loader = MonoLoader(filename=req.path, sampleRate=44100)
    audio = loader()
    if audio.size == 0:
        raise RuntimeError("empty audio after decode")
    sr = 44100
    duration = float(audio.size / sr)

    # Fingerprint stage — runs on the mono decode every other stage shares,
    # so it costs ~0.1 s on top of a decode we already paid for. 120 s is
    # the AcoustID window: it keeps the print comparable with the public
    # database and with any other device's copy of the same recording (a
    # re-encode or tag rewrite prints the same; a different edit doesn't),
    # and lands at 2.6-3.3 KB instead of the full-track variant's tens of KB.
    # Best-effort like the structure stage: a failure here leaves the fields
    # None and must not fail the job — grid/key/peaks are the load-bearing
    # outputs, and the queue re-tries missing prints in its own backfill.
    fingerprint: Optional[str] = None
    fingerprint_duration_sec: Optional[int] = None
    if not bool(req.options.get("skip_fingerprint")):
        emit("progress", "fingerprint", 0.05)
        try:
            from essentia.standard import Chromaprinter
            fp = str(Chromaprinter(sampleRate=sr, maxLength=120)(audio))
            if fp:
                fingerprint = fp
                fingerprint_duration_sec = int(round(audio.size / sr))
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"[analyzer] fingerprint stage failed: {exc}\n")

    emit("progress", "beatgrid", 0.10)
    # Beatgrid stage. Two ways to avoid running RhythmExtractor2013:
    #   1. prior_beatgrid + prior_bpm passed in (user has existing data and
    #      did NOT opt to override) → use those values.
    #   2. skip_beatgrid passed in (user's auto-analyze sub-flag for
    #      Beatgrid is off) → return empty arrays + bpm=0.0. The TS-side
    #      persistResult's preserveBpm + preserveBeatgrid guards see the
    #      empty payload and leave the existing row untouched.
    # If neither: run RhythmExtractor2013 (~2-3s/track) — the slowest stage
    # in the basic pipeline.
    prior_beatgrid = req.options.get("prior_beatgrid")
    prior_bpm = req.options.get("prior_bpm")
    prior_downbeats = req.options.get("prior_downbeats")
    skip_beatgrid = bool(req.options.get("skip_beatgrid"))
    if prior_beatgrid and prior_bpm is not None:
        beats_list = [float(b) for b in prior_beatgrid]
        bpm = float(prior_bpm)
        emit("partial", "beatgrid", {"source": "prior"})
    elif skip_beatgrid:
        # AnalyzeResult.bpm is Optional[float]; persistResult writes None
        # as a SQL NULL which the preserve guards then never overwrite a
        # real value with.
        beats_list = []
        bpm = None  # type: ignore[assignment]
        emit("partial", "beatgrid", {"source": "skipped"})
    else:
        # RhythmExtractor2013 returns (bpm, beats, beats_confidence, _, beats_intervals).
        # 'multifeature' is the most robust across genres at the cost of ~2-3s/track;
        # 'degara' is ~2x faster with a small accuracy hit on non-4/4 material.
        # Honoured per-call via options['rhythm_method'] so a future "re-analyze
        # with…" UI can opt into either without a code change.
        rhythm_method = str(req.options.get("rhythm_method") or "multifeature")
        rhythm = RhythmExtractor2013(method=rhythm_method)
        bpm, beats, beats_conf, _, _ = rhythm(audio)
        bpm = float(bpm)
        beats_list = [float(b) for b in beats]
        emit("partial", "beatgrid", None)

    emit("progress", "downbeats", 0.35)
    # BeatTrackerMultiFeature gives finer-grained beat phase; we treat every
    # 4th beat as a downbeat if no explicit downbeat detector is available.
    # Essentia has no first-party downbeat detector in 2.1b6; the 4-beat
    # heuristic is fine for 4/4 dance music and degrades gracefully on others.
    # Prior-downbeat path: if the queue passed them in (rb has actual downbeat
    # marks from PQTZ, more accurate than our 4-beat heuristic), use them.
    if prior_downbeats:
        downbeats = [float(b) for b in prior_downbeats]
    else:
        downbeats = beats_list[::4]

    emit("progress", "key", 0.45)
    # Key stage. Same two skip-paths as beatgrid:
    #   1. prior_key passed in → use it.
    #   2. skip_key passed in → return empty + strength=0. TS preserveKey
    #      guard discards.
    # Otherwise: run KeyExtractor (~0.5-1s/track).
    prior_key = req.options.get("prior_key")
    prior_key_strength = req.options.get("prior_key_strength")
    skip_key = bool(req.options.get("skip_key"))
    if prior_key:
        key_camelot = str(prior_key)
        key_strength = float(prior_key_strength) if prior_key_strength is not None else 0.0
        emit("partial", "key", {"source": "prior"})
    elif skip_key:
        key_camelot = None
        key_strength = None  # type: ignore[assignment]
        emit("partial", "key", {"source": "skipped"})
    else:
        key_extractor = KeyExtractor(profileType="edma")
        key_pitch, key_scale, key_strength = key_extractor(audio)
        key_camelot = _key_to_camelot(str(key_pitch), str(key_scale))
        emit("partial", "key", None)

    # Default: MusicExtractor does NOT run. It's the swiss-army feature
    # dumper and costs 5-15s per track + a second file decode — way too
    # heavy for the scanner-driven auto-analyse path that's expected to
    # chew through tens of thousands of tracks in the background.
    # User opts in per-track via the Analyze window, which sends
    # `options.features = ['dissonance', ...]`. Any recognised feature key
    # triggers ME (it's all-or-nothing in Essentia); we then surface every
    # ME-derived scalar in the result and let persistResult decide what to
    # write.
    requested_features = set(req.options.get("features") or [])
    run_music_extractor = bool(requested_features & ADVANCED_FEATURE_KEYS)

    features: dict[str, Any] = {}
    brightness: Optional[float] = None
    power: Optional[float] = None
    dynamic_complexity: Optional[float] = None
    dissonance: Optional[float] = None
    density: Optional[float] = None
    loudness_range_lu: Optional[float] = None

    if run_music_extractor:
        emit("progress", "features", 0.55)
        try:
            me = MusicExtractor(
                lowlevelFrameSize=2048, lowlevelHopSize=1024,
                rhythmStats=["mean"], tonalStats=["mean"], lowlevelStats=["mean"],
            )
            pool, _ = me(req.path)
            features = _flatten_pool(pool)
            # Curator-aligned brightness + power from the learned formulas (scoring.py).
            # These read the full pool (incl. mfcc/gfcc/hpcp/contrast arrays + harmonic
            # features), so we pass the pool object, not the scalar-only `features`.
            # brightness here REPLACES the old raw spectral-centroid value.
            brightness, power = scoring.brightness_power(pool)
        except Exception as exc:  # noqa: BLE001
            # MusicExtractor can fail on edge-case files (tiny, malformed);
            # not fatal — peaks + beatgrid + key are the load-bearing
            # outputs of the basic pipeline.
            sys.stderr.write(f"[analyzer] MusicExtractor failed: {exc}\n")
            features = {}

        # Essentia names retained as the *source* keys (this is what
        # MusicExtractor emits); we re-bind them to the product names on
        # the dataclass below. (rhythm.danceability is still in the pool for
        # the brightness/power models — it's just no longer surfaced.)
        dynamic_complexity = features.get("lowlevel.dynamic_complexity")
        dissonance = features.get("lowlevel.dissonance.mean")
        density = features.get("lowlevel.spectral_complexity.mean")
        # MusicExtractor already runs EBU R128 internally (see its stderr
        # line "Compute md5 audio hash, codec, length, and EBU 128
        # loudness") and leaves the integrated/range scalars in the pool.
        # Reading them here is free — much cheaper than running
        # LoudnessEBUR128 separately, which duplicated 2-5s of work and
        # allocated a 100 MB fake-stereo array per track. The integrated
        # LUFS scalar is in the pool too as
        # `lowlevel.loudness_ebu128.integrated` if a future surface wants
        # it back.
        loudness_range_lu = features.get("lowlevel.loudness_ebu128.loudness_range")

    # Stage 6 — structural segmentation. Best-effort: a failure here doesn't
    # fail the whole job, we just persist empty segments + None scalars.
    # _classify_error maps any escaping exception to errorKind='structure'
    # on the queue side.
    #
    # Skip-segments gate: when the dispatch came with skip_segments=true
    # (track already has segments and the user hasn't ticked
    # overrideSegments), bail out entirely — the novelty curve + peak
    # picking + labelling stages are ~1-3s/track and we'd just throw the
    # output away on the TS side (preserveSegments guard). The empty
    # arrays returned here trigger the persistResult atomic-group rule
    # which leaves the prior values intact.
    emit("progress", "structure", 0.65)
    segments: list[dict[str, Any]] = []
    seg_scalars: dict[str, Any] = {
        "intro_length_sec": None,
        "outro_length_sec": None,
        "first_drop_sec": None,
        "drop_count": None,
        "breakdown_count": None,
    }
    skip_segments = bool(req.options.get("skip_segments"))
    # Segments depend on beats + bpm. When the beatgrid stage was skipped
    # (skip_beatgrid sub-flag, or a missing prior on a fresh track) we
    # have neither, so the segment stage can't meaningfully run. Force-
    # skip in that case to avoid feeding `bpm=None` to _label_segments,
    # which would crash on the `bpm > 0` check.
    if not skip_segments and (bpm is None or not beats_list):
        skip_segments = True
    if skip_segments:
        emit("partial", "structure", {"source": "skipped"})
    else:
        try:
            segments, seg_scalars = _segment(audio, sr, beats_list, downbeats, bpm)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"[analyzer] structure stage failed: {exc}\n")
            # Keep going — peaks + the rest still ship.

    emit("progress", "peaks", 0.75)
    # Skip-peaks gate: when the track already has .cpk files and the user
    # hasn't ticked the Waveform override, the queue passes skip_peaks=true so
    # we leave the existing waveform untouched (saves the decode + band pass).
    # The existing files at out_peaks_*_path stay valid, so the result still
    # reports their paths below.
    if bool(req.options.get("skip_peaks")):
        emit("partial", "peaks", {"source": "skipped"})
    else:
        # Stereo peaks: the band pipeline runs per channel so the big-wave
        # painter can draw top=left / bottom=right. We load the file a second
        # time as stereo (the analysis stages above all run on the resampled
        # mono `audio` and must keep doing so). AudioLoader doesn't resample,
        # so we Resample each channel to `sr` to match the mono pipeline's
        # grid. Any failure — mono source, decoder hiccup — falls back to the
        # mono `audio` we already have, which renders the classic mirror.
        bundle = None
        try:
            from essentia.standard import AudioLoader, Resample
            stereo, in_sr, n_ch, _md5, _br, _codec = AudioLoader(filename=req.path)()
            if n_ch >= 2 and stereo.ndim == 2 and stereo.shape[1] >= 2:
                left = np.ascontiguousarray(stereo[:, 0], dtype=np.float32)
                right = np.ascontiguousarray(stereo[:, 1], dtype=np.float32)
                if int(in_sr) != sr:
                    rs_l = Resample(inputSampleRate=int(in_sr), outputSampleRate=sr)
                    rs_r = Resample(inputSampleRate=int(in_sr), outputSampleRate=sr)
                    left = rs_l(left)
                    right = rs_r(right)
                bundle = compute_peaks_stereo(left, right, sr)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"[analyzer] stereo peaks load failed, using mono: {exc}\n")
        if bundle is None:
            bundle = compute_peaks(np.asarray(audio, dtype=np.float32), sr)
        # The two peaks files live in sibling directories (peaks/lo/, peaks/hi/);
        # mkdir both up front so write_cpk_pair only does the atomic rename dance.
        os.makedirs(os.path.dirname(req.out_peaks_lo_path), exist_ok=True)
        os.makedirs(os.path.dirname(req.out_peaks_hi_path), exist_ok=True)
        write_cpk_pair(req.out_peaks_lo_path, req.out_peaks_hi_path, bundle)
    emit("progress", "done", 1.0)

    return AnalyzeResult(
        track_id=req.track_id,
        duration=duration,
        bpm=bpm,
        beatgrid=beats_list,
        downbeats=downbeats,
        key_camelot=key_camelot,
        key_strength=float(key_strength) if key_strength is not None else None,
        brightness=_maybe_float(brightness),
        power=_maybe_float(power),
        dynamic_complexity=_maybe_float(dynamic_complexity),
        loudness_range_lu=_maybe_float(loudness_range_lu),
        dissonance=_maybe_float(dissonance),
        density=_maybe_float(density),
        segments=segments,
        intro_length_sec=seg_scalars.get("intro_length_sec"),
        outro_length_sec=seg_scalars.get("outro_length_sec"),
        first_drop_sec=seg_scalars.get("first_drop_sec"),
        drop_count=seg_scalars.get("drop_count"),
        breakdown_count=seg_scalars.get("breakdown_count"),
        fingerprint=fingerprint,
        fingerprint_duration_sec=fingerprint_duration_sec,
        features=features,
        peaks_lo_path=req.out_peaks_lo_path,
        peaks_hi_path=req.out_peaks_hi_path,
        analyzer_version=ANALYZER_VERSION,
    )


def _maybe_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _flatten_pool(pool: Any) -> dict[str, Any]:
    """Essentia's Pool → flat dict[str, JSON-able]. Skips array values to keep
    the persisted JSON small; the renderer only reads the scalar surface."""
    out: dict[str, Any] = {}
    for name in pool.descriptorNames():
        try:
            v = pool[name]
        except Exception:
            continue
        if hasattr(v, "tolist"):
            # numpy array — skip; we don't need the per-frame features in
            # features_json (they'd balloon the row).
            continue
        if isinstance(v, (int, float, str, bool)):
            out[name] = v
    return out


# Worker-pool entry point. We marshal a single request, run analyze(), and
# return either the success result or an error dict. Exceptions are caught
# and serialized so the master never sees an unhandled traceback.
def worker_entrypoint(req_dict: dict[str, Any]) -> dict[str, Any]:
    req = AnalyzeRequest(**req_dict)

    progress_events: list[dict[str, Any]] = []

    def emit(event: str, stage: str, pct: Optional[float]) -> None:
        # Buffer events; the master process flushes them between job dispatch
        # cycles. We can't directly write to stdout from a worker (Pool
        # multiplexes that), so we ship them back in the result envelope.
        progress_events.append({"event": event, "stage": stage, "pct": pct})

    try:
        result = analyze(req, emit)
        return {"ok": True, "result": result.to_dict(), "events": progress_events}
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "error": {
                "kind": _classify_error(exc),
                "message": str(exc),
                "traceback": traceback.format_exc(),
            },
            "events": progress_events,
        }


def _classify_error(exc: BaseException) -> str:
    msg = str(exc).lower()
    if "decode" in msg or "loader" in msg or "open" in msg:
        return "decode"
    if "rhythm" in msg or "beat" in msg:
        return "beatgrid"
    if "key" in msg:
        return "key"
    if "novelty" in msg or "segment" in msg or "structure" in msg:
        return "structure"
    if "peak" in msg or "filter" in msg:
        return "peaks"
    return "internal"
