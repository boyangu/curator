#!/usr/bin/env python3
"""Fair incremental test: does a SMALL, curated set of section features add to the
whole-track brightness model? (The earlier 'whole + all 374 section feats' overfit on
603 tracks; this avoids that.) All comparisons on the SAME tracks, leave-artist-out.

Curated set = cross-section CONTRASTS (break−drop, which the whole-track mean cannot see)
+ a few absolute breakdown 'gem' features (beatless-ness, warmth, clarity).
"""
from __future__ import annotations
import json
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge

from analyze import load, feature_cols

SEG = r"C:\tmp\segment_features.jsonl"
# features where a section value (or break/drop difference) might add independent signal
CON = ["lowlevel.spectral_contrast_coeffs.mean.1", "lowlevel.dissonance.mean",
       "tonal.hpcp_entropy.mean", "eng.treble_share", "lowlevel.spectral_centroid.mean",
       "lowlevel.pitch_salience.stdev"]
BRK_ABS = ["brk.rhythm.onset_rate", "brk.eng.treble_share",
           "brk.lowlevel.spectral_contrast_coeffs.mean.1", "brk.lowlevel.dissonance.mean"]


def read_seg():
    rows = [json.loads(l) for l in open(SEG, encoding="utf-8") if l.strip()]
    return pd.DataFrame([r for r in rows if r.get("_ok")])


def main() -> int:
    whole = load()
    wf = feature_cols(whole)
    seg = read_seg().drop(columns=["primary_artist", "power"], errors="ignore")
    df = whole.merge(seg, on="track_id", how="inner")
    df["y"] = df["bright"].astype(float)
    y = df["y"].to_numpy()
    g = df["primary_artist"].fillna("").to_numpy()
    g = np.array([x if x else f"__s{i}" for i, x in enumerate(g)])
    gkf = GroupKFold(n_splits=5)

    for f in CON:
        df[f"con.{f}"] = df.get("brk." + f, np.nan) - df.get("drp." + f, np.nan)
    con_cols = [f"con.{f}" for f in CON]
    brk_cols = [c for c in BRK_ABS if c in df.columns]
    curated = con_cols + brk_cols

    def rho(cols, name, alpha=10.0):
        X = df[cols].to_numpy(dtype=float).copy(); X[~np.isfinite(X)] = np.nan
        pipe = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=alpha))
        r = spearmanr(y, cross_val_predict(pipe, X, y, cv=gkf, groups=g, n_jobs=1)).correlation
        print(f"  {name:<42} rho={r:.3f}  ({len(cols)} feats)")
        return r

    print(f"n={len(df)} tracks, leave-artist-out\n")
    base = rho(wf, "whole-track only (baseline)")
    rho(wf + con_cols, "whole + break−drop contrasts (6)")
    rho(wf + brk_cols, "whole + breakdown 'gem' feats (4)")
    rho(wf + curated, "whole + curated sections (10)")
    rho(wf + curated, "whole + curated sections (alpha=40)", alpha=40.0)
    print(f"\nbaseline {base:.3f} — any line beating it by >0.01 means sections add real signal.")

    # individual incremental check: correlation of each curated feature with the
    # RESIDUAL of the whole-track model (signal NOT already explained by audio).
    Xw = df[wf].to_numpy(float).copy(); Xw[~np.isfinite(Xw)] = np.nan
    pipe = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=10.0))
    resid = y - cross_val_predict(pipe, Xw, y, cv=gkf, groups=g, n_jobs=1)
    print("\ncorr of each curated section feature with whole-model RESIDUAL (new signal?):")
    for c in curated:
        rr = spearmanr(df[c], resid, nan_policy="omit").correlation
        print(f"    {c:<46} {rr:+.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
