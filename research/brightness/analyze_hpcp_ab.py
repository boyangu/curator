#!/usr/bin/env python3
"""Compare full-band vs band-limited HPCP for predicting brightness (low-end test).

Reads c:\\tmp\\hpcp_ab.jsonl, derives the SAME harmonic features (tonic-relative chroma,
modal brightness, scale-degree energies) from each chroma variant via analyze.augment_harmonic,
and reports harmonic-only leave-artist-out Ridge ρ + key feature correlations for each.
If band-limited beats full-band, low-end contamination is real and worth a cheap fix;
if not, the hypothesis is rejected and HTDemucs is not worth it.
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

from analyze import augment_harmonic

AB = os.environ.get("HPCP_AB", r"C:\tmp\hpcp_ab.jsonl")


def load():
    rows = [json.loads(l) for l in open(AB, encoding="utf-8") if l.strip()]
    return pd.DataFrame([r for r in rows if r.get("_ok")])


def harmonic_features(df, prefix):
    """Rename <prefix>.i -> tonal.hpcp.mean.i, run augment_harmonic, return harm.* cols."""
    sub = df[["track_id", "label", "primary_artist"]].copy()
    for i in range(36):
        sub[f"tonal.hpcp.mean.{i}"] = df[f"{prefix}.{i}"]
    sub = augment_harmonic(sub)
    return sub[[c for c in sub.columns if c.startswith("harm.")]]


def evalblock(name, Xh, y, groups, gkf):
    Xh = Xh.to_numpy(dtype=float).copy()
    Xh[~np.isfinite(Xh)] = np.nan
    pipe = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=10.0))
    pred = cross_val_predict(pipe, Xh, y, cv=gkf, groups=groups, n_jobs=1)
    rho = spearmanr(y, pred).correlation
    mae = float(np.mean(np.abs(y - pred)))
    print(f"  {name:<14} harmonic-only Ridge: rho={rho:.3f}  mae={mae:.3f}")
    return rho


def main() -> int:
    df = load()
    y = df["label"].to_numpy(dtype=float)
    groups = df["primary_artist"].fillna("").to_numpy()
    groups = np.array([g if g else f"__solo_{i}" for i, g in enumerate(groups)])
    gkf = GroupKFold(n_splits=min(5, len(set(groups))))
    print(f"n={len(df)} tracks\n")

    full = harmonic_features(df, "full")
    hpf = harmonic_features(df, "hpf")

    print("Predictive power of harmonic features (leave-artist-out):")
    r_full = evalblock("full-band", full, y, groups, gkf)
    r_hpf = evalblock("band-limited", hpf, y, groups, gkf)
    print(f"\n  Δ(band-limited − full) = {r_hpf - r_full:+.3f}  "
          f"-> {'low-end cleaning HELPS' if r_hpf - r_full > 0.02 else 'no meaningful gain (hypothesis rejected)'}")

    # key single-feature correlations, side by side
    print("\nKey harmonic features — |Spearman| full vs band-limited:")
    for c in ["harm.phrygian_flat2", "harm.key_strength", "harm.major_third_ratio",
              "harm.modal_brightness", "harm.nat7_vs_flat7", "harm.deg_7", "harm.deg_5"]:
        rf = spearmanr(full[c], y, nan_policy="omit").correlation
        rh = spearmanr(hpf[c], y, nan_policy="omit").correlation
        print(f"  {c:<24} full={rf:+.3f}  band-limited={rh:+.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
