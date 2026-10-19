#!/usr/bin/env python3
"""Show the dark end is recoverable by CALIBRATION, not weighting.

The dark-vs-bright classifier scores AUC ~0.87, so the features carry the signal and the
model *ranks* tracks well (overall Spearman ~0.66). The high d2 residual is MSE
regression compressing the extremes toward the mean. A monotonic calibration of the
model score (isotonic, fit leave-artist-out) — equivalent in spirit to bucketing by
library percentile, which production's cutoffStore already does — stretches the range
back out so the darkest-scoring tracks land at d2.

Compares per-bin mean-residual before vs after leave-artist-out isotonic calibration.
"""
from __future__ import annotations
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge
from sklearn.isotonic import IsotonicRegression
from scipy.stats import spearmanr
from xgboost import XGBRegressor

from analyze import load, augment_harmonic, feature_cols

BINS = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
NAME = {3.0: "b1", 2.5: "b0.5", 2.0: "b0", 1.5: "b0+d1", 1.0: "d1", 0.5: "d1+d2", 0.0: "d2"}


def per_bin(y, pred, label):
    d = pd.DataFrame({"y": y, "resid": pred - y, "abs": np.abs(pred - y)})
    d["bin"] = d["y"].map(NAME)
    g = d.groupby("bin").agg(mean_resid=("resid", "mean"), mae=("abs", "mean"))
    g = g.reindex([NAME[b] for b in sorted(BINS, reverse=True)])
    print(f"\n{label}:")
    for b, r in g.iterrows():
        print(f"  {b:<7} mean_resid={r['mean_resid']:+.2f}  mae={r['mae']:.2f}")


def main() -> int:
    df = augment_harmonic(load())
    feats = feature_cols(df)
    X = df[feats].to_numpy(dtype=float).copy()
    X[~np.isfinite(X)] = np.nan
    y = df["label"].to_numpy(dtype=float)
    groups = df["primary_artist"].fillna("").to_numpy()
    groups = np.array([g if g else f"__solo_{i}" for i, g in enumerate(groups)])
    gkf = GroupKFold(n_splits=min(5, len(set(groups))))

    def mk():
        return make_pipeline(SimpleImputer(strategy="median"),
                             XGBRegressor(n_estimators=500, max_depth=4, learning_rate=0.05,
                                          subsample=0.8, colsample_bytree=0.6, n_jobs=-1, random_state=0))
    raw = np.clip(cross_val_predict(mk(), X, y, cv=gkf, groups=groups, n_jobs=1), 0, 3)

    # Leave-artist-out isotonic calibration: fit isotonic on train folds' raw preds, apply to test.
    cal = np.full(len(y), np.nan)
    for tr, te in gkf.split(X, y, groups):
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=3)
        iso.fit(raw[tr], y[tr])
        cal[te] = iso.transform(raw[te])

    print(f"overall Spearman  raw={spearmanr(y, raw).correlation:.3f}  "
          f"calibrated={spearmanr(y, cal).correlation:.3f}  (rank order unchanged)")
    print(f"overall MAE       raw={np.mean(np.abs(y-raw)):.3f}  calibrated={np.mean(np.abs(y-cal)):.3f}")
    per_bin(y, raw, "RAW regression (per-bin)")
    per_bin(y, cal, "CALIBRATED (isotonic, leave-artist-out)")

    # Practical: of the tracks the user tagged dark (<=d1), how many does the calibrated
    # model rank into the darkest fraction? (percentile bucketing == production cutoffs)
    order = np.argsort(cal)
    dark_true = y <= 1.0
    frac_dark = dark_true.mean()
    darkest_idx = set(order[:int(frac_dark * len(y))].tolist())
    recovered = np.mean([i in darkest_idx for i in np.where(dark_true)[0]])
    print(f"\nbucket-by-percentile: tagging the darkest {frac_dark:.0%} by model score "
          f"recovers {recovered:.0%} of your dark (<=d1) tracks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
