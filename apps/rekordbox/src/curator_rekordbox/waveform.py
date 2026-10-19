"""Convert Rekordbox ANLZ waveform data into Curator's .cpk format.

Rekordbox stores waveforms in companion files alongside the audio:
  - ANLZ0000.DAT — older 4-bit colour waveform
  - ANLZ0000.EXT — newer "color detail" waveform (3-band)

pyrekordbox.AnlzFile parses both and exposes them as numpy arrays. We
decimate them to Curator's two-tier layout (20 Hz overview + 100 Hz detail)
and write `.cpk` files identical to what the Essentia analyzer produces, so
the renderer's loader doesn't have to special-case the source.

Format reference: apps/core/src/analyzer/cpk.ts. Same magic + same header.
"""

from __future__ import annotations

import os
import struct
from typing import Optional

import numpy as np

# Mirror apps/analyzer/peaks.py constants.
CPK_MAGIC = b"CURPEAKS"
CPK_VERSION = 1
CPK_NUM_BANDS = 3
DETAIL_SAMPLES_PER_SEC = 100
OVERVIEW_SAMPLES_PER_SEC = 20


def _resample_uint8(src: np.ndarray, src_rate_hz: float, dst_rate_hz: float, dst_len: int) -> np.ndarray:
    """Linearly interpolate src (any length, [0, 255] range) onto dst_len bins.

    We could do exact min/max decimation like the analyzer, but the input
    is already peak-decimated by Rekordbox — linear is the right reduction
    here. Output is uint8 in [0, 255].
    """
    if src.size == 0 or dst_len == 0:
        return np.zeros(dst_len, dtype=np.uint8)
    # Map dst-bin centres onto src-bin indices.
    src_xs = np.linspace(0, src.size - 1, dst_len)
    floor = src_xs.astype(np.int64)
    ceil = np.minimum(floor + 1, src.size - 1)
    frac = src_xs - floor
    out = src[floor] * (1.0 - frac) + src[ceil] * frac
    return np.clip(out, 0, 255).astype(np.uint8)


def _write_cpk(path: str, samples_per_sec: int, low: np.ndarray, mid: np.ndarray, high: np.ndarray) -> None:
    """Same packing as apps/analyzer/peaks.py:_write_cpk."""
    count = low.size
    if mid.size != count or high.size != count:
        raise ValueError("bands must be equal length")

    header = struct.pack(
        "<8sBBHII",
        CPK_MAGIC, CPK_VERSION, CPK_NUM_BANDS,
        samples_per_sec, count, 0,  # overview_count=0 in the split layout
    )

    interleaved = np.empty(count * CPK_NUM_BANDS, dtype=np.uint8)
    interleaved[0::3] = low
    interleaved[1::3] = mid
    interleaved[2::3] = high

    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(header)
        f.write(interleaved.tobytes())
    os.replace(tmp, path)


def write_cpk_pair_from_rekordbox(
    lo_path: str,
    hi_path: str,
    duration_sec: float,
    waveform_bands: tuple[np.ndarray, np.ndarray, np.ndarray],
    src_rate_hz: float,
) -> None:
    """Resample 3-band waveform from Rekordbox sample rate → 20/100 Hz .cpk pair.

    `waveform_bands` is (low, mid, high) — three 1-D uint8-range arrays at
    src_rate_hz samples/sec (Rekordbox's detailed colour waveform is 150
    half-frames per sec → ~150 Hz; preview is much lower).

    `duration_sec` is the canonical track duration we use to pick the
    output length (in case the rekordbox arrays are slightly under/over).
    """
    low, mid, high = waveform_bands
    if duration_sec <= 0 or low.size == 0:
        # Nothing meaningful to write; skip both files. Importer treats
        # missing files as "no waveform from rekordbox" and falls back to
        # the analyzer's output (or leaves the row pending).
        return

    os.makedirs(os.path.dirname(lo_path), exist_ok=True)
    os.makedirs(os.path.dirname(hi_path), exist_ok=True)

    detail_len = int(round(duration_sec * DETAIL_SAMPLES_PER_SEC))
    overview_len = int(round(duration_sec * OVERVIEW_SAMPLES_PER_SEC))

    d_low  = _resample_uint8(low,  src_rate_hz, DETAIL_SAMPLES_PER_SEC, detail_len)
    d_mid  = _resample_uint8(mid,  src_rate_hz, DETAIL_SAMPLES_PER_SEC, detail_len)
    d_high = _resample_uint8(high, src_rate_hz, DETAIL_SAMPLES_PER_SEC, detail_len)

    o_low  = _resample_uint8(low,  src_rate_hz, OVERVIEW_SAMPLES_PER_SEC, overview_len)
    o_mid  = _resample_uint8(mid,  src_rate_hz, OVERVIEW_SAMPLES_PER_SEC, overview_len)
    o_high = _resample_uint8(high, src_rate_hz, OVERVIEW_SAMPLES_PER_SEC, overview_len)

    _write_cpk(lo_path, OVERVIEW_SAMPLES_PER_SEC, o_low, o_mid, o_high)
    _write_cpk(hi_path, DETAIL_SAMPLES_PER_SEC,   d_low, d_mid, d_high)


def extract_bands_from_anlz(anlz) -> Optional[tuple[tuple[np.ndarray, np.ndarray, np.ndarray], float]]:
    """Pull 3-band uint8-range arrays from a pyrekordbox AnlzFile.

    Preference order:
      1. PWV5 (colour detail, ~150 Hz, 16-bit packed RGB+height)
      2. PWV3 (mono detail, ~150 Hz, 8-bit packed height+colour-index)
      3. PWV4 (colour preview, low-res)

    PWV5's per-sample format (documented in pyrekordbox.anlz.tags):
        bit  f e d c b a 9 8 7 6 5 4 3 2 1 0
            │ red │green│ blue│  height │ 00│
    pyrekordbox's `PWV5AnlzTag.get()` already unpacks this into
    `(heights[0..1], colors[N, 3])` where colours are 0..7 per channel.
    We multiply colour by height to get per-band amplitude, then scale to
    uint8 — the analyzer's .cpk format expects 0..255.

    The renderer treats the three channels as low/mid/high RGB and
    paints them with mix-blend so overlapping colours stack naturally,
    matching how rekordbox renders the colour waveform.

    Returns ((low, mid, high), source_rate_hz) or None if no usable tag.
    """
    def find_tag(key: str):
        getter = getattr(anlz, "get_tag", None)
        if callable(getter):
            try:
                return getter(key)
            except (KeyError, IndexError, StopIteration):
                return None
            except Exception:
                return None
        raw = getattr(anlz, "tags", None)
        if isinstance(raw, dict):
            return raw.get(key)
        if isinstance(raw, list):
            for t in raw:
                if getattr(t, "type", None) == key:
                    return t
        return None

    # 1) PWV5 — preferred. ~150 Hz, full RGB.
    #
    # Decode the 16-bit big-endian entries ourselves rather than going through
    # pyrekordbox's PWV5AnlzTag.get(): that helper shifts the red channel by
    # 12 instead of 13, which doubles the red amplitude and makes every
    # waveform skew red-dominant. We do the bit-extraction directly per the
    # documented layout (also in pyrekordbox/anlz/tags.py):
    #
    #   bit  f e d c b a 9 8 7 6 5 4 3 2 1 0
    #       │ red │green│ blue│  height │ 00│
    #
    # All three colour channels are 3 bits (0..7); height is 5 bits (0..31).
    pwv5 = find_tag("PWV5")
    if pwv5 is not None and hasattr(pwv5, "content"):
        entries = getattr(pwv5.content, "entries", None)
        if entries is not None and len(entries) > 0:
            arr = np.asarray(entries, dtype=np.uint16)
            red    = ((arr >> 13) & 0x07).astype(np.float32)   # 0..7
            green  = ((arr >> 10) & 0x07).astype(np.float32)   # 0..7
            blue   = ((arr >>  7) & 0x07).astype(np.float32)   # 0..7
            height = ((arr >>  2) & 0x1F).astype(np.float32) / 31.0  # 0..1

            # Per-channel amplitude = bit-field × height, scaled to 0..255.
            # The 255/7 factor maps the 3-bit colour onto the uint8 output
            # range; multiplying by height carries the loudness envelope so
            # quiet sections render dim regardless of channel mix.
            #
            # We pack the source bit-fields into the .cpk's three positions
            # in the SAME order Pioneer documents (red→high slot, green→mid,
            # blue→low) — purely to keep the on-disk layout deterministic.
            # We do NOT commit here to which Pioneer channel corresponds to
            # bass/mid/treble (it's not what the channel NAMES suggest, and
            # there's no public spec we can cite). The renderer knows the
            # file is rekordbox-sourced from the `rb_*.cpk` filename and
            # applies the right channel→display-colour mapping at paint
            # time. Keeping that decision off the writer means a visual
            # tweak doesn't require regenerating every cached .cpk.
            scale = 255.0 / 7.0
            high_b = np.clip(red   * height * scale, 0, 255).astype(np.uint8)
            mid_b  = np.clip(green * height * scale, 0, 255).astype(np.uint8)
            low_b  = np.clip(blue  * height * scale, 0, 255).astype(np.uint8)
            return (low_b, mid_b, high_b), 150.0

    # 2) PWV3 — mono detail. Each byte: top 5 bits = height (0..31), low 3
    #    bits = colour index (0..7). Reasonable fallback for older libraries
    #    that don't have a PWV5 tag yet.
    pwv3 = find_tag("PWV3")
    if pwv3 is not None and hasattr(pwv3, "content"):
        entries = getattr(pwv3.content, "entries", None)
        if entries is not None and len(entries) > 0:
            arr = np.asarray(entries, dtype=np.uint8)
            height = ((arr >> 3) & 0x1F).astype(np.float32) / 31.0
            colour_idx = (arr & 0x07).astype(np.int32)
            # Pioneer's PWV3 colour palette (deep-symmetry community-derived):
            # 0=darker blue, 1=lighter blue, 2=cyan, 3=light green,
            # 4=yellow, 5=orange, 6=red, 7=white. Mapped to RGB triplets
            # 0..7 so the same height*colour*scale math reuses PWV5's path.
            palette = np.array([
                [0, 0, 5],  # darker blue
                [0, 2, 7],  # lighter blue
                [0, 5, 7],  # cyan
                [3, 7, 4],  # light green
                [7, 7, 0],  # yellow
                [7, 4, 0],  # orange
                [7, 0, 0],  # red
                [7, 7, 7],  # white
            ], dtype=np.float32)
            cols = palette[colour_idx]
            scale = (255.0 / 7.0)
            high = np.clip(cols[:, 0] * height * scale, 0, 255).astype(np.uint8)
            mid  = np.clip(cols[:, 1] * height * scale, 0, 255).astype(np.uint8)
            low  = np.clip(cols[:, 2] * height * scale, 0, 255).astype(np.uint8)
            return (low, mid, high), 150.0

    return None
