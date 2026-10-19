#!/usr/bin/env python3
"""Test the reframe: 'warm = my bright, cold = my dark'.

Warmth (audio) = low-mid bodied, gentle highs, rounded/tonal timbre.
Coldness = harsh/thin/bright highs, noisy/metallic timbre.
If the user's brightness axis is really warmth, then WARM features should correlate
POSITIVELY with the (bright=high) label — including raw spectral centroid correlating
NEGATIVELY (more treble = colder = darker), which we already observed.

Reports: signed correlations of warmth/tilt + timbre features, how much warmth alone
explains (leave-artist-out), and whether warmth is the SAME axis as our top feature
(spectral contrast) or adds something.
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
TILT = ["lowlevel.spectral_centroid.mean", "lowlevel.spectral_rolloff.mean",
        EB["low"], EB["middle_low"], EB["middle_high"], EB["high"]]
TIMBRE = [f"lowlevel.mfcc.mean.{i}" for i in range(1, 5)] + \
         [f"lowlevel.gfcc.mean.{i}" for i in range(1, 5)]
CONTRAST = ["lowlevel.spectral_contrast_coeffs.mean.1", "lowlevel.spectral_contrast_coeffs.mean.2"]


def main() -> int:
    df = load()
    y = df["label"].to_numpy(dtype=float)
    groups = df["primary_artist"].fillna("").to_numpy()
    groups = np.array([g if g else f"__solo_{i}" for i, g in enumerate(groups)])
    gkf = GroupKFold(n_splits=min(5, len(set(groups))))

    lo, ml, mh, hi = (df[EB[k]].to_numpy(float) for k in ("low", "middle_low", "middle_high", "high"))
    # warmth = low-mid body vs high "air/harshness"
    df["eng.warmth"] = np.log((lo + ml + 1e-9) / (mh + hi + 1e-9))
    print("warmth index (log low-mid / high):")
    print(f"  eng.warmth                vs label  rho={spearmanr(df['eng.warmth'], y).correlation:+.3f}  "
          "(expect >0: warmer -> brighter)\n")

    print("warm/cold proxies — signed Spearman (warm features expect >0; cold/harsh <0):")
    for c, note in [("lowlevel.spectral_centroid.mean", "treble center (cold)"),
                    ("lowlevel.spectral_rolloff.mean", "rolloff (cold)"),
                    (EB["high"], "high-band energy (cold)"),
                    (EB["middle_low"], "low-mid body (warm)"),
                    ("lowlevel.dissonance.mean", "dissonance (cold/harsh)"),
                    ("lowlevel.melbands_flatness_db.mean", "noise-flatness (cold)"),
                    ("lowlevel.mfcc.mean.1", "MFCC1 envelope tilt"),
                    ("lowlevel.mfcc.mean.2", "MFCC2 envelope tilt")]:
        if c in df.columns:
            r = spearmanr(df[c], y, nan_policy="omit").correlation
            print(f"  {c:<40} rho={r:+.3f}   {note}")

    def block(cols, name):
        cols = [c for c in cols if c in df.columns]
        X = df[cols].to_numpy(dtype=float).copy()
        X[~np.isfinite(X)] = np.nan
        pipe = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=5.0))
        pred = cross_val_predict(pipe, X, y, cv=gkf, groups=groups, n_jobs=1)
        rho = spearmanr(y, pred).correlation
        print(f"  {name:<34} rho={rho:.3f}")
        return pred

    print("\nhow much each lens explains alone (leave-artist-out Ridge):")
    p_tilt = block(TILT + ["eng.warmth"], "warmth/spectral-tilt only")
    p_timb = block(TIMBRE, "timbre (MFCC/GFCC envelope) only")
    p_warm = block(TILT + TIMBRE + ["eng.warmth"], "warmth + timbre combined")
    p_con = block(CONTRAST, "spectral-contrast only (our top)")
    block(TILT + TIMBRE + CONTRAST + ["eng.warmth"], "warmth + timbre + contrast")

    # Is warmth the SAME axis as spectral contrast, or additional?
    print(f"\noverlap: corr(warmth+timbre pred, contrast pred) = "
          f"{spearmanr(p_warm, p_con).correlation:+.3f}  "
          "(high = same axis; moderate = complementary)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
