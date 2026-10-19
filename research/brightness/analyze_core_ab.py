#!/usr/bin/env python3
"""Compare full-track vs intro/outro-trimmed (central-window) features for predicting
brightness, on the SAME sample tracks. If trimmed beats full, unrepresentative
intro/outro sections were diluting the features.
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
from xgboost import XGBRegressor

from analyze import augment_harmonic, feature_cols

FULL = r"C:\tmp\brightness_features.jsonl"
CORE = r"C:\tmp\core_features.jsonl"


def read(fp):
    rows = []
    for line in open(fp, encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("_ok"):
            rows.append(r)
    return pd.DataFrame(rows)


def prep(df):
    df = augment_harmonic(df.copy())
    feats = feature_cols(df)
    return df, feats


def evalrho(df, feats, kind):
    X = df[feats].to_numpy(dtype=float).copy(); X[~np.isfinite(X)] = np.nan
    y = df["label"].to_numpy(dtype=float)
    g = df["primary_artist"].fillna("").to_numpy()
    g = np.array([x if x else f"__s{i}" for i, x in enumerate(g)])
    gkf = GroupKFold(n_splits=min(5, len(set(g))))
    if kind == "ridge":
        pipe = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=10.0))
    else:
        pipe = make_pipeline(SimpleImputer(strategy="median"),
                             XGBRegressor(n_estimators=500, max_depth=4, learning_rate=0.05,
                                          subsample=0.8, colsample_bytree=0.6, n_jobs=-1, random_state=0))
    pred = cross_val_predict(pipe, X, y, cv=gkf, groups=g, n_jobs=1)
    return spearmanr(y, pred).correlation, float(np.mean(np.abs(y - pred)))


def main() -> int:
    core = read(CORE)
    full = read(FULL)
    ids = set(core["track_id"]) & set(full["track_id"])
    core = core[core["track_id"].isin(ids)].reset_index(drop=True)
    full = full[full["track_id"].isin(ids)].reset_index(drop=True)
    trimmed = int(core["_trimmed"].sum()) if "_trimmed" in core else 0
    print(f"matched tracks: {len(ids)}  (actually trimmed: {trimmed}; rest too short)\n")

    cd, cf = prep(core)
    fd, ff = prep(full)
    feats = sorted(set(cf) & set(ff))  # identical feature set for a fair A/B

    for kind in ("ridge", "xgb"):
        rf, mf = evalrho(fd, feats, kind)
        rc, mc = evalrho(cd, feats, kind)
        print(f"{kind:6}  full ρ={rf:.3f} (mae {mf:.3f})   core/trimmed ρ={rc:.3f} (mae {mc:.3f})   "
              f"Δ={rc-rf:+.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
