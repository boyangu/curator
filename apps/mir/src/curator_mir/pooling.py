"""Pooling shared by every adapter.

Each adapter reports its finest-grained vectors as TimedVectors — one row per
frame bin or clip, with its [start, end) in seconds. Per-segment vectors are
derived from those by overlap-weighted means, so segment pooling (and later
stem x segment pooling) is model-agnostic.
"""

from __future__ import annotations

import base64
import math
from dataclasses import dataclass

import numpy as np


@dataclass
class TimedVectors:
    starts: np.ndarray  # (n,) seconds
    ends: np.ndarray    # (n,) seconds
    vecs: np.ndarray    # (n, dim) float32

    @staticmethod
    def concat(parts: list["TimedVectors"]) -> "TimedVectors":
        return TimedVectors(
            np.concatenate([p.starts for p in parts]),
            np.concatenate([p.ends for p in parts]),
            np.concatenate([p.vecs for p in parts]).astype(np.float32, copy=False),
        )


def equal_windows(n_samples: int, sample_rate: int, max_secs: float) -> list[tuple[int, int]]:
    """Split [0, n) into the fewest equal windows no longer than max_secs.

    Equal (not max-then-remainder) so a 6:10 track isn't analysed as 6:00 of
    context plus a 10 s scrap the model has no context for.
    """
    max_len = max(1, int(max_secs * sample_rate))
    if n_samples <= max_len:
        return [(0, n_samples)]
    k = math.ceil(n_samples / max_len)
    edges = np.linspace(0, n_samples, k + 1).round().astype(np.int64)
    return [(int(a), int(b)) for a, b in zip(edges[:-1], edges[1:])]


def bin_frames(frames: np.ndarray, frame_rate: float, offset_secs: float, bin_secs: float = 1.0) -> TimedVectors:
    """Average consecutive frames into bin_secs bins (25 Hz x 1024-d frames for a
    6-minute track are 38 MB; 1 s bins keep segment pooling exact to the second
    at 1/25 of the memory)."""
    per = max(1, int(round(frame_rate * bin_secs)))
    n = frames.shape[0]
    k = max(1, math.ceil(n / per))
    vecs = np.stack([frames[i * per:(i + 1) * per].mean(axis=0) for i in range(k)]).astype(np.float32)
    starts = offset_secs + np.arange(k) * per / frame_rate
    ends = offset_secs + np.minimum((np.arange(k) + 1) * per, n) / frame_rate
    return TimedVectors(starts, ends, vecs)


def l2n(v: np.ndarray, axis: int = -1) -> np.ndarray:
    norm = np.linalg.norm(v, axis=axis, keepdims=True)
    return v / np.maximum(norm, 1e-12)


def pool_segments(tv: TimedVectors, segments: list[dict]) -> list[np.ndarray | None]:
    """Overlap-weighted mean of the timed vectors inside each [startSec, endSec)."""
    out: list[np.ndarray | None] = []
    for seg in segments:
        a, b = float(seg["startSec"]), float(seg["endSec"])
        overlap = np.clip(np.minimum(tv.ends, b) - np.maximum(tv.starts, a), 0.0, None)
        weight = float(overlap.sum())
        out.append(None if weight <= 0 else (tv.vecs * overlap[:, None]).sum(axis=0) / weight)
    return out


def to_b64(vec: np.ndarray) -> str:
    """Float32 little-endian, base64 — the BLOB layout the host stores verbatim."""
    return base64.b64encode(np.asarray(vec, dtype="<f4").tobytes()).decode("ascii")


def from_b64(data: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(data), dtype="<f4")
