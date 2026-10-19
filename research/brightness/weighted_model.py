#!/usr/bin/env python3
"""Test class-balanced sample weighting to stop the model regressing rare DARK tracks
toward the bright/middle mass.

The label bins are very imbalanced (b0~877 vs d2~47), so an unweighted regressor
minimizes loss by hedging the rare extremes toward the center — that's why d2 tracks
get predicted ~b0. We re-fit with sample weights inversely proportional to bin
frequency (sklearn 'balanced' style) so the dark tail counts as much as the dense
middle, and compare per-bin behavior unweighted vs weighted.

Also diagnostic: if weighting pulls d2 dark, the audio signal exists and the model was
just hedging. If d2 stays bright even when heavily upweighted, the features can't
separate those darks from b0 (i.e., it's set-context, not acoustics).

Manual GroupKFold OOF loop so sample_weight is applied only on each training fold.
"""
from __future__ import annotations
import os
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge
from scipy.stats import spearmanr
from xgboost import XGBRegressor

from analyze import load, augment_harmonic, feature_cols

BINS = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
NAME = {3.0: "b1", 2.5: "b0.5", 2.0: "b0", 1.5: "b0+d1", 1.0: "d1", 0.5: "d1+d2", 0.0: "d2"}


def balanced_weights(y, power: float) -> np.ndarray:
    """w_i ∝ (1 / bin_count)^power, normalized to mean 1. power=0 -> uniform,
    1 -> full inverse-frequency (sklearn 'balanced'), 0.5 -> softened."""
    counts = {b: int((y == b).sum()) for b in BINS}
    w = np.array([(1.0 / counts[v]) ** power for v in y])
    return w * len(y) / w.sum()


def oof(make_pipe, X, y, groups, gkf, w=None):
    pred = np.full(len(y), np.nan)
    for tr, te in gkf.split(X, y, groups):
        pipe = make_pipe()
        step = pipe.steps[-1][0]
        if w is not None:
            pipe.fit(X[tr], y[tr], **{f"{step}__sample_weight": w[tr]})
        else:
            pipe.fit(X[tr], y[tr])
        pred[te] = pipe.predict(X[te])
    return np.clip(pred, 0, 3)


def per_bin(y, pred) -> pd.DataFrame:
    d = pd.DataFrame({"y": y, "resid": pred - y, "abs": np.abs(pred - y)})
    d["bin"] = d["y"].map(NAME)
    g = d.groupby("bin").agg(n=("y", "size"), mean_resid=("resid", "mean"), mae=("abs", "mean"))
    return g.reindex([NAME[b] for b in sorted(BINS, reverse=True)])


def metrics(y, pred):
    return spearmanr(y, pred).correlation, float(np.mean(np.abs(y - pred)))


def main() -> int:
    df = augment_harmonic(load())
    feats = feature_cols(df)
    X = df[feats].to_numpy(dtype=float).copy()
    X[~np.isfinite(X)] = np.nan
    y = df["label"].to_numpy(dtype=float)
    groups = df["primary_artist"].fillna("").to_numpy()
    groups = np.array([g if g else f"__solo_{i}" for i, g in enumerate(groups)])
    gkf = GroupKFold(n_splits=min(5, len(set(groups))))

    def mk_xgb():
        return make_pipeline(SimpleImputer(strategy="median"),
                             XGBRegressor(n_estimators=500, max_depth=4, learning_rate=0.05,
                                          subsample=0.8, colsample_bytree=0.6, n_jobs=-1, random_state=0))

    for power in (0.0, 0.5, 1.0):
        w = None if power == 0 else balanced_weights(y, power)
        pred = oof(mk_xgb, X, y, groups, gkf, w)
        rho, mae = metrics(y, pred)
        tag = "UNWEIGHTED" if power == 0 else f"balanced^{power}"
        print(f"\n=== XGBoost  {tag}   overall rho={rho:.3f} mae={mae:.3f} ===")
        pb = per_bin(y, pred)
        for b, r in pb.iterrows():
            flag = "  <-- dark end" if b in ("d2", "d1+d2", "d1") else ""
            print(f"  {b:<7} n={int(r['n']):<4} mean_resid={r['mean_resid']:+.2f} mae={r['mae']:.2f}{flag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
