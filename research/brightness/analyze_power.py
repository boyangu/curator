#!/usr/bin/env python3
"""Model the user's POWER (p0..p5, continuous 0-5) from audio features.

Reuses the already-extracted brightness features + a 581-track delta (power-only tracks),
attaches power labels from power_dataset.csv, and fits the same leave-artist-out pipeline.
Baseline = BPM only (tests the user's "it's not only BPM, but BPM drives it" claim).

Reads c:\\tmp\\brightness_features.jsonl + c:\\tmp\\power_delta_features.jsonl + power_dataset.csv.
"""
from __future__ import annotations
import csv, json, os
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge
from sklearn.ensemble import RandomForestRegressor
from xgboost import XGBRegressor

from analyze import augment_harmonic, feature_cols

FEATURE_FILES = [r"C:\tmp\brightness_features.jsonl", r"C:\tmp\power_delta_features.jsonl"]
POWER_CSV = r"C:\tmp\power_dataset.csv"
REPORT = r"C:\tmp\power_report.md"
BPM = "rhythm.bpm"


def load_features():
    seen, rows = set(), []
    for fp in FEATURE_FILES:
        if not os.path.exists(fp):
            continue
        for line in open(fp, encoding="utf-8"):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("_ok") and r["track_id"] not in seen:
                seen.add(r["track_id"]); rows.append(r)
    return pd.DataFrame(rows)


def main() -> int:
    df = load_features()
    # attach power labels + artist (overwrite brightness label/artist with power dataset's)
    lab, art = {}, {}
    with open(POWER_CSV, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            lab[r["track_id"]] = float(r["label"]); art[r["track_id"]] = r["primary_artist"]
    df = df[df["track_id"].isin(lab)].copy()
    df["label"] = df["track_id"].map(lab)
    df["primary_artist"] = df["track_id"].map(art)
    df = augment_harmonic(df)
    print(f"power tracks with features: {len(df)}")

    feats = feature_cols(df)
    X = df[feats].to_numpy(dtype=float).copy(); X[~np.isfinite(X)] = np.nan
    y = df["label"].to_numpy(dtype=float)
    groups = df["primary_artist"].fillna("").to_numpy()
    groups = np.array([g if g else f"__solo_{i}" for i, g in enumerate(groups)])
    gkf = GroupKFold(n_splits=min(5, len(set(groups))))

    def run(cols_or_X, name, kind="ridge"):
        Xm = cols_or_X if isinstance(cols_or_X, np.ndarray) else df[cols_or_X].to_numpy(float).copy()
        Xm[~np.isfinite(Xm)] = np.nan
        if kind == "ridge":
            pipe = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=10.0))
        elif kind == "rf":
            pipe = make_pipeline(SimpleImputer(strategy="median"),
                                 RandomForestRegressor(n_estimators=400, n_jobs=-1, random_state=0))
        else:
            pipe = make_pipeline(SimpleImputer(strategy="median"),
                                 XGBRegressor(n_estimators=500, max_depth=4, learning_rate=0.05,
                                              subsample=0.8, colsample_bytree=0.6, n_jobs=-1, random_state=0))
        pred = cross_val_predict(pipe, Xm, y, cv=gkf, groups=groups, n_jobs=1)
        rho = spearmanr(y, pred).correlation; mae = float(np.mean(np.abs(y - pred)))
        print(f"  {name:<28} rho={rho:.3f}  mae={mae:.3f}")
        return pred

    print("\nPOWER models (leave-artist-out, 0-5 scale):")
    if BPM in df.columns:
        run([BPM], "baseline: BPM only")
    run(X, "Ridge (all features)")
    run(X, "RandomForest", "rf")
    run(X, "XGBoost", "xgb")

    # what drives power — top correlations
    corr = []
    for c in feats:
        v = df[c].to_numpy(float); m = np.isfinite(v)
        if m.sum() > len(df) * 0.5:
            r = spearmanr(v[m], y[m]).correlation
            if r is not None and np.isfinite(r):
                corr.append((c, r))
    corr.sort(key=lambda t: abs(t[1]), reverse=True)
    print("\nTop features for POWER (|Spearman|):")
    for c, r in corr[:20]:
        print(f"  {c:<44} {r:+.3f}")
    if BPM in df.columns:
        print(f"\n  (for reference) {BPM}: {spearmanr(df[BPM], y, nan_policy='omit').correlation:+.3f}")

    with open(REPORT, "w", encoding="utf-8") as f:
        f.write(f"# POWER model — n={len(df)}\n\nTop features:\n")
        f.write("\n".join(f"- {c}: {r:+.3f}" for c, r in corr[:30]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
