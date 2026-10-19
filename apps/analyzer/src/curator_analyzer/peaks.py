"""Multi-band waveform peaks for the Curator UI.

We take a PCM float32 signal at 44.1 kHz, filter it through three biquad
band-passes (low / mid / high), rectify, and decimate to N samples per second
of audio. Each band's samples are scaled to uint8 (0..255) — that's enough
visual resolution for any DJ-style waveform display and gives us a tight
on-disk footprint (~300 bytes per second of audio per band per channel).

Stereo: when given separate L/R channels we run the band pipeline twice (once
per channel) and write a `.cpk` v2 file carrying both. The big-wave painter
renders top=left / bottom=right from that; mono files (and rekordbox imports)
render the classic mirrored look. See apps/core/src/analyzer/cpk.ts for the
on-disk format (v1 mono / v2 mono-or-stereo). Keep the two implementations in
sync; round-tripping via `encodePeaks` ↔ Node's `decodePeaks` is part of the
analyzer test plan.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

import numpy as np
from scipy.signal import butter, sosfilt

# Band-pass corner frequencies (Hz). Loosely mirrors the Pioneer 3-band
# split: sub/bass below ~250, mids 250..2500, highs above ~2500. Exact
# boundaries don't matter much visually — what matters is that each band
# captures a perceptually-distinct slice.
LOW_BAND = (20.0, 250.0)
MID_BAND = (250.0, 2500.0)
HIGH_BAND = (2500.0, 16000.0)

# 100 samples/sec — agreed-upon resolution (Rekordbox uses 150, Mixxx ~50-100;
# 100 lands in the middle and gives 1 px per 10 ms at the detail zoom). See
# the architecture doc.
DETAIL_SAMPLES_PER_SEC = 100

# Strip / low-res resolution. 20/sec — fine enough to look honest as a
# placeholder behind the high-res buffer in the deck overview (rendered
# at ~1500 px wide; 5-min track at 20/sec = 6000 samples ≈ 4 samples/px),
# small enough that a 5-min track is ~6 KB per file → cheap to keep many
# in OS page cache. Written to a separate file from the detail so the
# renderer can fetch it without paying for the high-res.
OVERVIEW_SAMPLES_PER_SEC = 20


@dataclass
class ChannelPeaks:
    """One channel's decimated bands at both resolutions.

    Each band carries two metrics per time-slice: the max-abs PEAK (the
    waveform outline) and the RMS (the loudness "body" the Ableton/DAW skin
    fills inside the outline). Both are uint8 on the same 0..255 scale.
    """
    detail_low: np.ndarray  # uint8[N] — peak
    detail_mid: np.ndarray
    detail_high: np.ndarray
    overview_low: np.ndarray
    overview_mid: np.ndarray
    overview_high: np.ndarray
    detail_rms_low: np.ndarray  # uint8[N] — rms
    detail_rms_mid: np.ndarray
    detail_rms_high: np.ndarray
    overview_rms_low: np.ndarray
    overview_rms_mid: np.ndarray
    overview_rms_high: np.ndarray


@dataclass
class PeakBundle:
    samples_per_sec: int
    # Channel 0 = mono signal, or the left channel when stereo.
    left: ChannelPeaks
    # Right channel — None for mono bundles.
    right: ChannelPeaks | None = None

    @property
    def num_channels(self) -> int:
        return 2 if self.right is not None else 1


def _butter_bandpass(lo: float, hi: float, sr: int) -> np.ndarray:
    # 4th-order Butterworth as second-order sections — numerically stable
    # for steep cutoffs at our sample rates. Order 4 is overkill for visual
    # peak detection but keeps adjacent bands from bleeding into each other.
    nyq = sr * 0.5
    return butter(4, [lo / nyq, min(hi / nyq, 0.999999)], btype="band", output="sos")


def _rectify_and_decimate(signal: np.ndarray, sr: int, samples_per_sec: int) -> np.ndarray:
    """Take max-abs over each window of (sr / samples_per_sec) samples → uint8.

    Max-abs (rather than RMS) is what Rekordbox/Traktor do — it preserves
    transient peaks that disappear in an RMS window. For visual fidelity
    on percussive content this matters; for vocal/sustained content the
    difference is invisible.
    """
    win = max(1, sr // samples_per_sec)
    # Trim to a whole number of windows so the reshape works.
    n_full = (signal.size // win) * win
    if n_full == 0:
        return np.zeros(0, dtype=np.uint8)
    windowed = np.abs(signal[:n_full]).reshape(-1, win)
    peaks = windowed.max(axis=1)
    # Normalize against the global maximum of all three bands at the caller —
    # here we just clip to [0,1] and scale to byte. Caller is expected to
    # pre-normalize the input signal to a sane range (Essentia's MonoLoader
    # returns float32 in [-1, 1] for ReplayGain'd or peak-normalized inputs).
    peaks = np.clip(peaks, 0.0, 1.0)
    return (peaks * 255.0).astype(np.uint8)


def _rms_decimate(signal: np.ndarray, sr: int, samples_per_sec: int) -> np.ndarray:
    """Take RMS (sqrt of mean-square) over each window → uint8.

    Same windowing as `_rectify_and_decimate`, but RMS instead of max-abs:
    this is the loudness "body" the Ableton/DAW skin draws inside the peak
    outline. RMS is always ≤ peak for the same window, so the body nests
    within the silhouette.
    """
    win = max(1, sr // samples_per_sec)
    n_full = (signal.size // win) * win
    if n_full == 0:
        return np.zeros(0, dtype=np.uint8)
    windowed = signal[:n_full].astype(np.float32, copy=False).reshape(-1, win)
    rms = np.sqrt(np.mean(windowed * windowed, axis=1))
    rms = np.clip(rms, 0.0, 1.0)
    return (rms * 255.0).astype(np.uint8)


def _compute_channel(signal: np.ndarray, sample_rate: int) -> ChannelPeaks:
    """Run the three-band filter+rectify+decimate pipeline for one channel.

    `signal` is a 1-D float32 array of audio in [-1, 1] at sample_rate.
    Returns detail (DETAIL_SAMPLES_PER_SEC/sec) + overview
    (OVERVIEW_SAMPLES_PER_SEC/sec) per band.
    """
    if signal.ndim != 1:
        raise ValueError(f"expected 1-D channel signal, got shape {signal.shape}")
    if signal.dtype != np.float32:
        signal = signal.astype(np.float32, copy=False)

    sos_low = _butter_bandpass(*LOW_BAND, sample_rate)
    sos_mid = _butter_bandpass(*MID_BAND, sample_rate)
    sos_high = _butter_bandpass(*HIGH_BAND, sample_rate)

    # Forward-only filter (sosfilt rather than sosfiltfilt) — phase distortion
    # is irrelevant for amplitude peaks, and forward-only is 2× faster.
    low = sosfilt(sos_low, signal)
    mid = sosfilt(sos_mid, signal)
    high = sosfilt(sos_high, signal)

    # Detail (100/sec) — what the zoomed-in waveform widget reads.
    d_low = _rectify_and_decimate(low, sample_rate, DETAIL_SAMPLES_PER_SEC)
    d_mid = _rectify_and_decimate(mid, sample_rate, DETAIL_SAMPLES_PER_SEC)
    d_high = _rectify_and_decimate(high, sample_rate, DETAIL_SAMPLES_PER_SEC)

    # Overview (10/sec) — strip view. We re-decimate the original filtered
    # bands rather than down-sampling the detail buffer; cheaper to keep the
    # full-resolution band lying around once than to re-filter.
    o_low = _rectify_and_decimate(low, sample_rate, OVERVIEW_SAMPLES_PER_SEC)
    o_mid = _rectify_and_decimate(mid, sample_rate, OVERVIEW_SAMPLES_PER_SEC)
    o_high = _rectify_and_decimate(high, sample_rate, OVERVIEW_SAMPLES_PER_SEC)

    # RMS body — same filtered bands, same two resolutions, RMS instead of peak.
    dr_low = _rms_decimate(low, sample_rate, DETAIL_SAMPLES_PER_SEC)
    dr_mid = _rms_decimate(mid, sample_rate, DETAIL_SAMPLES_PER_SEC)
    dr_high = _rms_decimate(high, sample_rate, DETAIL_SAMPLES_PER_SEC)
    or_low = _rms_decimate(low, sample_rate, OVERVIEW_SAMPLES_PER_SEC)
    or_mid = _rms_decimate(mid, sample_rate, OVERVIEW_SAMPLES_PER_SEC)
    or_high = _rms_decimate(high, sample_rate, OVERVIEW_SAMPLES_PER_SEC)

    return ChannelPeaks(
        detail_low=d_low, detail_mid=d_mid, detail_high=d_high,
        overview_low=o_low, overview_mid=o_mid, overview_high=o_high,
        detail_rms_low=dr_low, detail_rms_mid=dr_mid, detail_rms_high=dr_high,
        overview_rms_low=or_low, overview_rms_mid=or_mid, overview_rms_high=or_high,
    )


def compute_peaks(signal: np.ndarray, sample_rate: int) -> PeakBundle:
    """Mono peak bundle. `signal` is a 1-D float32 array in [-1, 1]."""
    return PeakBundle(
        samples_per_sec=DETAIL_SAMPLES_PER_SEC,
        left=_compute_channel(signal, sample_rate),
    )


def compute_peaks_stereo(left: np.ndarray, right: np.ndarray, sample_rate: int) -> PeakBundle:
    """Stereo peak bundle — runs the band pipeline once per channel.

    `left`/`right` are 1-D float32 arrays in [-1, 1] at sample_rate. The two
    channels are decimated independently so the renderer can draw top=left /
    bottom=right. Bands are NOT cross-normalized here (each channel scales to
    its own 0..255), matching the per-channel rectify; the renderer's per-track
    normalization already handles loudness scaling across the pair.
    """
    return PeakBundle(
        samples_per_sec=DETAIL_SAMPLES_PER_SEC,
        left=_compute_channel(left, sample_rate),
        right=_compute_channel(right, sample_rate),
    )


# ──────────────────────────────────────────────────────────────────────────────
# .cpk encoder — keep in sync with apps/core/src/analyzer/cpk.ts.

CPK_MAGIC = b"CURPEAKS"
# v3 carries num_channels (1 mono / 2 stereo) AND two metrics per band
# (peak + rms). The metric count is implied by the version (v1/v2 → 1, v3 → 2);
# the header is byte-identical to v2. Node's decodePeaks still reads v1/v2.
CPK_VERSION = 3
CPK_NUM_BANDS = 3
CPK_NUM_METRICS = 2  # peak, rms
CPK_HEADER_SIZE_V3 = 21

# One channel = a peak triplet + an rms triplet, each (low, mid, high).
Triplet = tuple[np.ndarray, np.ndarray, np.ndarray]


def _write_cpk(
    path: str,
    samples_per_sec: int,
    left_peak: Triplet,
    left_rms: Triplet,
    right_peak: Triplet | None,
    right_rms: Triplet | None,
) -> None:
    """Serialize one resolution's bands into a `.cpk` v3 file.

    Atomic write matters because the file is read concurrently — the worker
    pool can be regenerating a track's peaks while the renderer is reading
    the old version. A half-written file would crash the renderer. We write
    to <path>.tmp and rename when complete.

    The .cpk header always carries both detail_count and overview_count
    fields. For these per-resolution files we set the unused field to 0:
    the per-file `samples_per_sec` field disambiguates which resolution it is.
    Body is channel-major per sample, metric-major within channel (see cpk.ts):
      mono   = [pk_lo,pk_mid,pk_hi, rms_lo,rms_mid,rms_hi, …]
      stereo = L[pk…, rms…] R[pk…, rms…]
    """
    pl_low, pl_mid, pl_high = left_peak
    count = pl_low.size
    bands = (pl_mid, pl_high, *left_rms)
    if any(b.size != count for b in bands):
        raise ValueError("all left bands (peak + rms) must be equal length")
    num_channels = 2 if right_peak is not None else 1
    if right_peak is not None:
        assert right_rms is not None
        if any(b.size != count for b in (*right_peak, *right_rms)):
            raise ValueError("right bands must match left length")

    header = struct.pack(
        "<8sBBBHII",
        CPK_MAGIC,
        CPK_VERSION,
        CPK_NUM_BANDS,
        num_channels,
        samples_per_sec,
        count,     # detail_count
        0,         # overview_count (unused in the split layout)
    )

    stride = CPK_NUM_BANDS * CPK_NUM_METRICS * num_channels  # 6 (mono) | 12 (stereo)
    interleaved = np.empty(count * stride, dtype=np.uint8)
    # channel 0: peak [0,1,2], rms [3,4,5]
    interleaved[0::stride] = left_peak[0]
    interleaved[1::stride] = left_peak[1]
    interleaved[2::stride] = left_peak[2]
    interleaved[3::stride] = left_rms[0]
    interleaved[4::stride] = left_rms[1]
    interleaved[5::stride] = left_rms[2]
    if right_peak is not None and right_rms is not None:
        # channel 1: peak [6,7,8], rms [9,10,11]
        interleaved[6::stride] = right_peak[0]
        interleaved[7::stride] = right_peak[1]
        interleaved[8::stride] = right_peak[2]
        interleaved[9::stride] = right_rms[0]
        interleaved[10::stride] = right_rms[1]
        interleaved[11::stride] = right_rms[2]

    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(header)
        f.write(interleaved.tobytes())
    import os
    os.replace(tmp, path)


def write_cpk_pair(lo_path: str, hi_path: str, bundle: PeakBundle) -> None:
    """Write the two-tier peaks files: overview (low-res) + detail (high-res).

    Both writes are atomic; if one fails the other still lands. Callers
    treat the pair as "best effort consistent" — a missing high-res file
    just means the renderer falls back to the low-res only, which it would
    do anyway during the progressive-load window. Stereo bundles write both
    channels; mono bundles write one. Each band carries peak + rms.
    """
    lc = bundle.left
    rc = bundle.right
    _write_cpk(
        lo_path, OVERVIEW_SAMPLES_PER_SEC,
        (lc.overview_low, lc.overview_mid, lc.overview_high),
        (lc.overview_rms_low, lc.overview_rms_mid, lc.overview_rms_high),
        (rc.overview_low, rc.overview_mid, rc.overview_high) if rc else None,
        (rc.overview_rms_low, rc.overview_rms_mid, rc.overview_rms_high) if rc else None,
    )
    _write_cpk(
        hi_path, bundle.samples_per_sec,
        (lc.detail_low, lc.detail_mid, lc.detail_high),
        (lc.detail_rms_low, lc.detail_rms_mid, lc.detail_rms_high),
        (rc.detail_low, rc.detail_mid, rc.detail_high) if rc else None,
        (rc.detail_rms_low, rc.detail_rms_mid, rc.detail_rms_high) if rc else None,
    )
