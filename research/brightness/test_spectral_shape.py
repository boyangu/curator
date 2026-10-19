#!/usr/bin/env python3
"""Test two perceptual hypotheses against the labels, using already-extracted features:
  H1 (V/U shape): darker = scooped mids / energy at bass+treble extremes; brighter = balanced.
  H2 (hammering): darker = percussive/transient; brighter = continuous/airy.

Reports: engineered V/U features' correlation with the label, the existing features that
proxy each hypothesis, and how much of brightness a small model built ONLY from these two
ideas explains (leave-artist-out). + sign check vs the stated intuition.
"""
from __future__ import annotations
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge

from analyze import load

EB = {k: f"lowlevel.spectral_energyband_{k}.mean" for k in
      ("low", "middle_low", "middle_high", "high")}


def main() -> int:
    df = load()
    y = df["label"].to_numpy(dtype=float)
    groups = df["primary_artist"].fillna("").to_numpy()
    groups = np.array([g if g else f"__solo_{i}" for i, g in enumerate(groups)])
    gkf = GroupKFold(n_splits=min(5, len(set(groups))))

    lo, ml, mh, hi = (df[EB[k]].to_numpy(dtype=float) for k in ("low", "middle_low", "middle_high", "high"))
    mids = ml + mh
    total = lo + mids + hi + 1e-12
    df["eng.vu_ratio"] = (lo + hi) / (mids + 1e-12)
    df["eng.extremes_share"] = (lo + hi) / total
    df["eng.mid_share"] = mids / total
    # curvature: convex (U) if extremes exceed mids on a 3-point [bass, mid, treble] curve
    df["eng.spectral_curvature"] = ((lo + hi) / 2 - mids / 2) / total

    H1 = ["eng.vu_ratio", "eng.extremes_share", "eng.mid_share", "eng.spectral_curvature",
          "lowlevel.barkbands_spread.mean", "lowlevel.erbbands_spread.mean"]
    H2 = ["lowlevel.spectral_flux.mean", "lowlevel.melbands_crest.mean",
          "lowlevel.barkbands_crest.mean", "lowlevel.dynamic_complexity",
          "rhythm.onset_rate", "lowlevel.pitch_salience.stdev",
          "lowlevel.zerocrossingrate.mean"]

    def corr(c):
        if c not in df.columns:
            return None
        v = df[c].to_numpy(dtype=float)
        m = np.isfinite(v)
        return spearmanr(v[m], y[m]).correlation if m.sum() > len(v) * 0.5 else None

    # NOTE: label high = BRIGHT. Hypotheses predict these features are higher for DARK,
    # i.e. expected NEGATIVE rho (except mid_share, which should be POSITIVE = brighter).
    print("== H1: V/U shape (expect rho<0 for V/U-ness; rho>0 for mid_share) ==")
    for c in H1:
        r = corr(c)
        print(f"  {c:<42} rho={r:+.3f}" if r is not None else f"  {c:<42} (missing)")
    print("\n== H2: hammering/transient (expect rho<0 = more transient -> darker) ==")
    for c in H2:
        r = corr(c)
        print(f"  {c:<42} rho={r:+.3f}" if r is not None else f"  {c:<42} (missing)")

    def block_rho(cols, name):
        cols = [c for c in cols if c in df.columns]
        X = df[cols].to_numpy(dtype=float).copy()
        X[~np.isfinite(X)] = np.nan
        pipe = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=5.0))
        pred = cross_val_predict(pipe, X, y, cv=gkf, groups=groups, n_jobs=1)
        print(f"  {name:<28} rho={spearmanr(y, pred).correlation:.3f}")

    print("\n== how much each idea explains alone (leave-artist-out Ridge) ==")
    block_rho(H1, "H1 V/U-shape only")
    block_rho(H2, "H2 hammering only")
    block_rho(H1 + H2, "H1+H2 combined")
    block_rho(["lowlevel.spectral_centroid.mean"], "(ref) centroid only")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
