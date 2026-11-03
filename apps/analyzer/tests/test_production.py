"""Production stage on synthetic masters: each detector must light up on the
defect it is for and stay quiet on the clean reference."""

import numpy as np
import pytest
from scipy import signal

from curator_analyzer.production import compute_production

SR = 44100
SEGS = [{"startSec": 0, "endSec": 12, "label": "intro"}, {"startSec": 12, "endSec": 30, "label": "drop"}]


def master(dur=30.0, bpm=128.0, clip=False, lowpass=None, stereo_sub=False, seed=0):
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    t = np.arange(n) / SR
    period = 60.0 / bpm
    beats = np.arange(0, dur, period)
    kick = np.zeros(n)
    for b in beats:
        i = int(b * SR)
        tt = np.arange(min(int(0.25 * SR), n - i)) / SR
        kick[i:i + len(tt)] += np.sin(2 * np.pi * (55 + 80 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 12)
    bass = 0.3 * np.sin(2 * np.pi * 55 * t) * (np.sin(2 * np.pi * t / period * 0.5) > 0)
    hat = rng.normal(0, 0.05, n) * (np.sin(2 * np.pi * t / (period / 2)) > 0.9)
    pad = 0.1 * np.sin(2 * np.pi * 440 * t) + 0.08 * np.sin(2 * np.pi * 660 * t)
    mix = 0.6 * kick + bass + hat + pad
    left = mix + rng.normal(0, 0.005, n)
    right = mix + rng.normal(0, 0.005, n)
    if stereo_sub:
        left = left + 0.5 * np.sin(2 * np.pi * 50 * t)
        right = right - 0.5 * np.sin(2 * np.pi * 50 * t)
    if lowpass:
        sos = signal.butter(16, lowpass / (SR / 2), output="sos")
        left, right = signal.sosfilt(sos, left), signal.sosfilt(sos, right)
    g = 0.9 / np.max(np.abs(np.concatenate([left, right])))
    left, right = left * g, right * g
    if clip:
        left, right = np.clip(left * 3, -1, 1), np.clip(right * 3, -1, 1)
    return left.astype(np.float32), right.astype(np.float32), list(beats)


@pytest.fixture(scope="module")
def clean():
    l, r, beats = master()
    return compute_production(l, r, SR, beats=beats, segments=SEGS)


def test_clean_reference(clean):
    assert clean["clip_pct"] == 0.0
    assert clean["true_peak_dbtp"] < 0.0
    assert clean["cutoff_hz"] == SR / 2
    assert clean["sub_corr"] > 0.99 and clean["phase_corr"] > 0.99
    assert clean["width_db"]["low"] < -30
    assert clean["kick_punch_db"] > 6 and clean["sub_under_kick_db"] > 3
    assert -20 < clean["lufs_i"] < -5
    assert [s["label"] for s in clean["sections"]] == ["intro", "drop"]
    assert clean["sections"][1]["lufs"] == pytest.approx(clean["lufs_i"], abs=1.5)


def test_clipping_detected(clean):
    l, r, beats = master(clip=True)
    out = compute_production(l, r, SR, beats=beats)
    assert out["clip_pct"] > 1.0
    assert out["true_peak_dbtp"] > 0.0
    assert out["crest_db"] < clean["crest_db"] - 4
    assert out["plr"] < clean["plr"] - 4


def test_transcode_cliff_detected(clean):
    l, r, beats = master(lowpass=16000)
    out = compute_production(l, r, SR, beats=beats)
    assert 15000 <= out["cutoff_hz"] <= 17500
    assert out["cutoff_depth_db"] >= 15
    assert clean["cutoff_depth_db"] == 0.0


def test_stereo_sub_detected(clean):
    l, r, beats = master(stereo_sub=True)
    out = compute_production(l, r, SR, beats=beats)
    assert out["sub_corr"] < 0.0
    assert out["width_db"]["low"] > clean["width_db"]["low"] + 20


def test_mono_source_and_no_beats():
    l, _, _ = master(dur=6.0)
    out = compute_production(l, l, SR, beats=None, segments=None, stereo_source=False)
    assert out["stereo_source"] is False
    assert out["sub_corr"] == 1.0
    assert out["kick_punch_db"] is None and out["sub_under_kick_db"] is None
    assert out["sections"] == []


def test_too_short_rejected():
    with pytest.raises(ValueError):
        compute_production(np.zeros(100, np.float32), np.zeros(100, np.float32), SR)
