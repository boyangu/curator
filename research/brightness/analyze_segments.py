#!/usr/bin/env python3
"""Does BREAKDOWN / DROP section timbre predict brightness beyond the whole-track mean?

Tests the curator's hidden-gem hypothesis directly. Merges whole-track features with the
per-segment features (brk.* breakdown, drp.* drop) and compares leave-artist-out ρ for:
  whole-track | breakdown-only | drop-only | whole+sections | whole+section-contrasts.
Also reports key section-feature correlations and the breakdown-vs-drop contrast signal.
"""
from __future__ import annotations
import json, os
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge

from analyze import load, feature_cols  # load() reads BRIGHTNESS_FEATURES (whole-track)

SEG = r"C:\tmp\segment_features.jsonl"
KEY = ["lowlevel.spectral_contrast_coeffs.mean.1", "lowlevel.spectral_centroid.mean",
       "lowlevel.dissonance.mean", "tonal.hpcp_entropy.mean", "eng.treble_share",
       "lowlevel.pitch_salience.stdev", "rhythm.onset_rate"]


def read_seg():
    rows = []
    for line in open(SEG, encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("_ok"):
            rows.append(r)
    return pd.DataFrame(rows)


def main() -> int:
    whole = load()
    wfeats = [c for c in feature_cols(whole)]
    seg = read_seg()
    df = whole.merge(seg, on="track_id", suffixes=("", "_seg"), how="inner")
    df["y"] = df["bright"].astype(float)
    y = df["y"].to_numpy()
    groups = df["primary_artist"].fillna("").to_numpy()
    groups = np.array([g if g else f"__s{i}" for i, g in enumerate(groups)])
    gkf = GroupKFold(n_splits=min(5, len(set(groups))))
    brk = [c for c in df.columns if c.startswith("brk.")]
    drp = [c for c in df.columns if c.startswith("drp.")]
    print(f"merged tracks: {len(df)}  | whole feats {len(wfeats)}  brk {len(brk)}  drp {len(drp)}")
    print(f"has breakdown: {int(df['_has_break'].sum())}  has drop: {int(df['_has_drop'].sum())}\n")

    # section-vs-whole contrasts on key features
    for f in KEY:
        for pre in ("brk.", "drp."):
            if pre + f not in df.columns:
                df[pre + f] = np.nan
        df[f"con.{f}"] = df["brk." + f] - df["drp." + f]   # breakdown minus drop

    def rho(cols, name):
        cols = [c for c in cols if c in df.columns]
        X = df[cols].to_numpy(dtype=float).copy(); X[~np.isfinite(X)] = np.nan
        pipe = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=10.0))
        pred = cross_val_predict(pipe, X, y, cv=gkf, groups=groups, n_jobs=1)
        r = spearmanr(y, pred).correlation
        print(f"  {name:<34} rho={r:.3f}")
        return r

    print("BRIGHTNESS models (leave-artist-out):")
    r_whole = rho(wfeats, "whole-track (baseline)")
    rho(brk, "breakdown only")
    rho(drp, "drop only")
    rho(wfeats + brk + drp, "whole + breakdown + drop")
    rho(wfeats + [f"con.{f}" for f in KEY], "whole + section contrasts")
    rho(brk + drp, "breakdown + drop only")

    print("\nKey feature correlations with brightness (whole vs breakdown vs drop):")
    for f in KEY:
        rw = spearmanr(df[f], y, nan_policy="omit").correlation if f in df.columns else float("nan")
        rb = spearmanr(df["brk." + f], y, nan_policy="omit").correlation
        rd = spearmanr(df["drp." + f], y, nan_policy="omit").correlation
        print(f"  {f:<42} whole={rw:+.3f}  break={rb:+.3f}  drop={rd:+.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
