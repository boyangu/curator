#!/usr/bin/env python3
"""Does POWER help predict BRIGHTNESS? Test on tracks tagged with BOTH.

Three readings:
 1. audio-only brightness model (the reference).
 2. + TRUE power tag as a feature  -> upper bound: does knowing power add brightness info
    beyond audio? (Not deployable — at inference you don't have the human power tag.)
 3. + PREDICTED power (out-of-fold, from audio) -> the deployable version; if it doesn't
    beat audio-only, power-from-audio is redundant (the brightness model already has those
    signals).
Also reports the direct brightness<->power correlation and the joint distribution.
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
from xgboost import XGBRegressor

from analyze import augment_harmonic, feature_cols

FEATURE_FILES = [r"C:\tmp\brightness_features.jsonl", r"C:\tmp\power_delta_features.jsonl"]
BRIGHT_CSV = r"C:\tmp\brightness_dataset.csv"
POWER_CSV = r"C:\tmp\power_dataset.csv"


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


def labels(path):
    out = {}
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            out[r["track_id"]] = float(r["label"])
    return out


def main() -> int:
    df = load_features()
    bl, pl = labels(BRIGHT_CSV), labels(POWER_CSV)
    both = [t for t in df["track_id"] if t in bl and t in pl]
    df = df[df["track_id"].isin(both)].copy()
    df["bright"] = df["track_id"].map(bl)
    df["power"] = df["track_id"].map(pl)
    df = augment_harmonic(df)
    print(f"tracks with BOTH brightness & power tags: {len(df)}")

    print(f"\ndirect corr(brightness, power) = {spearmanr(df['bright'], df['power']).correlation:+.3f}")
    print("mean POWER by brightness bin (your priors: bright avoids P5, dark avoids low P):")
    for b in sorted(df["bright"].unique(), reverse=True):
        s = df[df["bright"] == b]["power"]
        print(f"  bright={b:>3}  n={len(s):<4} mean_power={s.mean():.2f}  range[{s.min():.0f}-{s.max():.0f}]")

    feats = feature_cols(df)  # excludes bright/power (not in META)? ensure excluded below
    feats = [c for c in feats if c not in ("bright", "power")]
    y = df["bright"].to_numpy(float)
    groups = df["primary_artist"].fillna("").to_numpy()
    groups = np.array([g if g else f"__solo_{i}" for i, g in enumerate(groups)])
    gkf = GroupKFold(n_splits=min(5, len(set(groups))))

    def mk():
        return make_pipeline(SimpleImputer(strategy="median"),
                             XGBRegressor(n_estimators=500, max_depth=4, learning_rate=0.05,
                                          subsample=0.8, colsample_bytree=0.6, n_jobs=-1, random_state=0))

    def rho(X):
        X = X.copy(); X[~np.isfinite(X)] = np.nan
        return spearmanr(y, cross_val_predict(mk(), X, y, cv=gkf, groups=groups, n_jobs=1)).correlation

    Xa = df[feats].to_numpy(float)
    r_audio = rho(Xa)
    # + TRUE power
    r_true = rho(np.column_stack([Xa, df["power"].to_numpy(float)]))
    # + PREDICTED power (out-of-fold from audio), same folds
    pwr_pred = cross_val_predict(mk(), np.nan_to_num(Xa, nan=np.nanmedian(Xa)),
                                 df["power"].to_numpy(float), cv=gkf, groups=groups, n_jobs=1)
    r_pred = rho(np.column_stack([Xa, pwr_pred]))

    print("\nBRIGHTNESS model (leave-artist-out):")
    print(f"  audio only                       rho={r_audio:.3f}")
    print(f"  + TRUE power tag (upper bound)    rho={r_true:.3f}   (Δ {r_true-r_audio:+.3f})")
    print(f"  + PREDICTED power (deployable)    rho={r_pred:.3f}   (Δ {r_pred-r_audio:+.3f})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
