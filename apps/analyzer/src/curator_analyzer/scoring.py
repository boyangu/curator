"""Curator-aligned brightness & power scoring.

Replaces the old single-number brightness (mean spectral centroid) with learned linear
formulas fit to the curator's own b1/b0/d1/d2 and p0-p5 tags. Each model is a
median-impute → z-score → weighted-sum over features read from one MusicExtractor pass
(the same pass the analyzer already runs for advanced features). See
research/brightness/{FINDINGS,BRIGHTNESS_CALCULATION}.md.

CRITICAL: the feature builder here must reproduce the research extraction EXACTLY
(research/brightness/{extract_features,analyze}.py) — the model weights were fit on those
features. The flatten/engineered/harmonic logic below mirrors those scripts verbatim;
scoring.verify (research/brightness/verify_scoring.py) checks the reproduction.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

import numpy as np

_DATA = Path(__file__).resolve().parent / "data"

# Arrays kept (flattened to name.i) — mirrors research extract_features.ARRAY_KEYS.
ARRAY_KEYS = (
    "lowlevel.mfcc.mean",
    "lowlevel.gfcc.mean",
    "tonal.hpcp.mean",
    "lowlevel.spectral_contrast_coeffs.mean",
)

# Krumhansl-Kessler key profiles + line-of-fifths brightness weights — mirrors
# research analyze.augment_harmonic verbatim.
KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
LOF_WEIGHT = np.array([0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5], dtype=float)
MAJ3, MIN3, AUG4, B7, NAT7, B2 = 4, 3, 6, 10, 11, 1


def flatten(pool: Any) -> dict[str, float]:
    """Pool → flat dict. Keep numeric scalars; flatten whitelisted 1-D arrays to name.i.
    Mirrors research extract_features._flatten."""
    out: dict[str, float] = {}
    for name in pool.descriptorNames():
        try:
            v = pool[name]
        except Exception:
            continue
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[name] = float(v)
            continue
        if hasattr(v, "tolist"):
            if name in ARRAY_KEYS and getattr(v, "ndim", 99) == 1:
                for i, x in enumerate(v.tolist()):
                    out[f"{name}.{i}"] = float(x)
    return out


def engineered(f: dict[str, float]) -> dict[str, float]:
    """Mirrors research extract_features._engineered."""
    e: dict[str, float] = {}
    lo = f.get("lowlevel.spectral_energyband_low.mean")
    mid = f.get("lowlevel.spectral_energyband_middle_low.mean", 0.0) + \
        f.get("lowlevel.spectral_energyband_middle_high.mean", 0.0)
    hi = f.get("lowlevel.spectral_energyband_high.mean")
    if lo is not None and hi is not None:
        tot = (lo or 0) + (mid or 0) + (hi or 0)
        if tot > 0:
            e["eng.treble_share"] = hi / tot
            e["eng.bass_share"] = lo / tot
    cen = f.get("lowlevel.spectral_centroid.mean")
    rol = f.get("lowlevel.spectral_rolloff.mean")
    if cen and rol:
        e["eng.rolloff_minus_centroid"] = rol - cen
    return e


def harmonic(f: dict[str, float]) -> dict[str, float]:
    """Tonic-relative chroma + modal-brightness features from the 36-bin HPCP.
    Mirrors research analyze.augment_harmonic (per-row body) verbatim."""
    hcols = [f"tonal.hpcp.mean.{i}" for i in range(36)]
    cols = ["harm.modal_brightness", "harm.mode_major", "harm.key_strength",
            "harm.major_third_ratio", "harm.lydian_sharp4", "harm.phrygian_flat2",
            "harm.nat7_vs_flat7", "harm.bright_degrees", "harm.dark_degrees"] + \
        [f"harm.deg_{i}" for i in range(12)]
    if not all(c in f for c in hcols):
        return {c: float("nan") for c in cols}
    row = np.array([f[c] for c in hcols], dtype=float)
    if not np.isfinite(row).all() or row.sum() <= 0:
        return {c: float("nan") for c in cols}
    ch = row.reshape(12, 3).sum(axis=1)
    ch = ch / (ch.sum() + 1e-9)
    chn = ch - ch.mean()
    best_r, best_score, best_major = 0, -2.0, True
    for r in range(12):
        for prof, is_maj in ((KS_MAJOR, True), (KS_MINOR, False)):
            p = np.roll(prof, r)
            p = p - p.mean()
            denom = np.sqrt((chn ** 2).sum() * (p ** 2).sum()) + 1e-9
            score = float((chn * p).sum() / denom)
            if score > best_score:
                best_score, best_r, best_major = score, r, is_maj
    rel = np.roll(ch, -best_r)
    out = {
        "harm.modal_brightness": float((rel * LOF_WEIGHT).sum()),
        "harm.mode_major": 1.0 if best_major else 0.0,
        "harm.key_strength": best_score,
        "harm.major_third_ratio": float(rel[MAJ3] / (rel[MAJ3] + rel[MIN3] + 1e-9)),
        "harm.lydian_sharp4": float(rel[AUG4]),
        "harm.phrygian_flat2": float(rel[B2]),
        "harm.nat7_vs_flat7": float(rel[NAT7] / (rel[NAT7] + rel[B7] + 1e-9)),
        "harm.bright_degrees": float(rel[[2, 4, 6, 9, 11]].sum()),
        "harm.dark_degrees": float(rel[[1, 3, 8, 10]].sum()),
    }
    for i in range(12):
        out[f"harm.deg_{i}"] = float(rel[i])
    return out


def build_vector(pool: Any) -> dict[str, float]:
    """The full feature dict the models score over (flatten + engineered + harmonic)."""
    f = flatten(pool)
    f.update(engineered(f))
    f.update(harmonic(f))
    return f


_MODELS: dict[str, dict] = {}


def _load(name: str) -> Optional[dict]:
    if name not in _MODELS:
        path = _DATA / f"{name}_model.json"
        try:
            with open(path, encoding="utf-8") as fh:
                _MODELS[name] = json.load(fh)
        except Exception:
            _MODELS[name] = None  # type: ignore[assignment]
    return _MODELS[name]


def score(model: dict, feats: dict[str, float]) -> Optional[float]:
    """median-impute → z-score → weighted sum + intercept."""
    names = model["features"]
    med, mean, std, coef = model["impute_median"], model["mean"], model["std"], model["coef"]
    acc = float(model["intercept"])
    for i, name in enumerate(names):
        x = feats.get(name)
        if x is None or not np.isfinite(x):
            x = med[i]
        s = std[i]
        if s:
            acc += coef[i] * ((x - mean[i]) / s)
    return acc


def brightness_power(pool: Any) -> tuple[Optional[float], Optional[float]]:
    """Compute (brightness, power) from a MusicExtractor pool. Returns (None, None) if
    the models aren't bundled (degrades to no scores rather than crashing analysis)."""
    bm, pm = _load("brightness"), _load("power")
    if bm is None and pm is None:
        return None, None
    feats = build_vector(pool)
    b = score(bm, feats) if bm else None
    p = score(pm, feats) if pm else None
    return b, p
