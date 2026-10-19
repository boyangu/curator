#!/usr/bin/env python3
"""Does the HPSS percussive ratio sharpen H2 (hammering) beyond the crest/flux proxies?

Merges perc_ratio (c:\\tmp\\hpss.jsonl) into the full feature table by track_id and reports:
 - perc_ratio's own Spearman with the label (expect <0: more percussive -> darker),
 - the H2 'hammering' block ρ with vs without perc_ratio (leave-artist-out).
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

from analyze import load

HPSS = os.environ.get("HPSS_OUT", r"C:\tmp\hpss.jsonl")
H2 = ["lowlevel.spectral_flux.mean", "lowlevel.melbands_crest.mean",
      "lowlevel.barkbands_crest.mean", "lowlevel.pitch_salience.stdev",
      "lowlevel.zerocrossingrate.mean"]


def main() -> int:
    df = load()
    pr = {}
    for line in open(HPSS, encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("_ok"):
            pr[r["track_id"]] = r["perc_ratio"]
    df = df[df["track_id"].isin(pr)].copy()
    df["eng.perc_ratio"] = df["track_id"].map(pr)
    y = df["label"].to_numpy(dtype=float)
    groups = df["primary_artist"].fillna("").to_numpy()
    groups = np.array([g if g else f"__solo_{i}" for i, g in enumerate(groups)])
    gkf = GroupKFold(n_splits=min(5, len(set(groups))))
    print(f"n={len(df)} (tracks with HPSS)\n")

    r = spearmanr(df["eng.perc_ratio"], y).correlation
    print(f"perc_ratio vs label: rho={r:+.3f}  (expect <0: more percussive -> darker)\n")

    def block(cols, name):
        X = df[cols].to_numpy(dtype=float).copy()
        X[~np.isfinite(X)] = np.nan
        pipe = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=5.0))
        pred = cross_val_predict(pipe, X, y, cv=gkf, groups=groups, n_jobs=1)
        print(f"  {name:<34} rho={spearmanr(y, pred).correlation:.3f}")

    print("leave-artist-out Ridge:")
    block(H2, "H2 proxies only")
    block(H2 + ["eng.perc_ratio"], "H2 proxies + HPSS perc_ratio")
    block(["eng.perc_ratio"], "HPSS perc_ratio alone")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
