#!/usr/bin/env python3
"""Find tracks where the model most disagrees with the human brightness tag.

Uses OUT-OF-FOLD predictions (GroupKFold by artist — each track scored by a model
that never saw it) from an ensemble of two different model families (Ridge + XGBoost).
Large |pred - human_label| = candidates for: a mislabel worth re-tagging, a genuinely
ambiguous track, or a model blind spot. These rows pull the learned weights off-true,
so reviewing/cleaning the top ones can both improve the model and surface tagging slips.

Writes c:\\tmp\\brightness_outliers.csv (full ranked list) and prints the worst offenders
in each direction plus a per-bin bias breakdown.
"""
from __future__ import annotations
import csv, os
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge
from xgboost import XGBRegressor

from analyze import load, augment_harmonic, feature_cols

DATASET = os.environ.get("BRIGHTNESS_DATASET", r"C:\tmp\brightness_dataset.csv")
OUT = os.environ.get("BRIGHTNESS_OUTLIERS", r"C:\tmp\brightness_outliers.csv")
VAL2NAME = {3.0: "b1", 2.5: "b1+b0(b0.5)", 2.0: "b0", 1.5: "b0+d1", 1.0: "d1", 0.5: "d1+d2", 0.0: "d2"}


def nearest_label(v: float) -> str:
    keys = sorted(VAL2NAME)
    return VAL2NAME[min(keys, key=lambda k: abs(k - v))]


def main() -> int:
    df = augment_harmonic(load())
    feats = feature_cols(df)
    X = df[feats].to_numpy(dtype=float).copy()
    X[~np.isfinite(X)] = np.nan
    y = df["label"].to_numpy(dtype=float)
    groups = df["primary_artist"].fillna("").to_numpy()
    groups = np.array([g if g else f"__solo_{i}" for i, g in enumerate(groups)])
    gkf = GroupKFold(n_splits=min(5, len(set(groups))))

    ridge = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=10.0))
    xgb = make_pipeline(SimpleImputer(strategy="median"),
                        XGBRegressor(n_estimators=500, max_depth=4, learning_rate=0.05,
                                     subsample=0.8, colsample_bytree=0.6, n_jobs=-1, random_state=0))
    oof_r = cross_val_predict(ridge, X, y, cv=gkf, groups=groups, n_jobs=1)
    oof_x = cross_val_predict(xgb, X, y, cv=gkf, groups=groups, n_jobs=1)
    pred = np.clip((oof_r + oof_x) / 2, 0, 3)
    resid = pred - y                       # >0 model brighter than you; <0 model darker
    agree = np.abs(oof_r - oof_x)          # low = both model families concur on the prediction

    # titles from the dataset export
    titles = {}
    with open(DATASET, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            titles[r["track_id"]] = (r["primary_artist"], r["title"])

    out = pd.DataFrame({
        "track_id": df["track_id"],
        "artist": [titles.get(t, ("", ""))[0] for t in df["track_id"]],
        "title": [titles.get(t, ("", ""))[1] for t in df["track_id"]],
        "your_tag": df["label_name"],
        "your_value": y,
        "model_value": np.round(pred, 2),
        "model_nearest": [nearest_label(v) for v in pred],
        "residual": np.round(resid, 2),
        "abs_residual": np.round(np.abs(resid), 2),
        "model_consensus": np.round(1 - agree / (np.abs(resid) + 1e-9), 2),  # rough: do both families agree
    }).sort_values("abs_residual", ascending=False)
    out.to_csv(OUT, index=False, encoding="utf-8")

    n = len(out)
    off1 = int((out["abs_residual"] > 1.0).sum())
    off15 = int((out["abs_residual"] > 1.5).sum())
    print(f"n={n}  |resid|>1.0: {off1} ({off1/n:.0%})  |resid|>1.5: {off15} ({off15/n:.0%})")
    print(f"full ranked list -> {OUT}\n")

    def show(title, sub):
        print(title)
        for _, r in sub.iterrows():
            print(f"  {r['residual']:+.2f}  you={r['your_tag']:<11} model~{r['model_nearest']:<11} "
                  f"| {r['artist'][:30]} - {r['title'][:42]}")
        print()

    # both families strongly agree the human is off (most credible mislabel candidates)
    cred = out[(out["abs_residual"] > 1.0)].copy()
    show("== model says DARKER than you tagged (you may have over-rated brightness) ==",
         out[out["residual"] < 0].head(15))
    show("== model says BRIGHTER than you tagged (you may have under-rated brightness) ==",
         out[out["residual"] > 0].head(15))

    print("== per-tag bias (mean signed residual; + = model brighter than you on this bin) ==")
    bias = out.groupby("your_tag").agg(n=("residual", "size"),
                                       mean_resid=("residual", "mean"),
                                       mae=("abs_residual", "mean")).sort_values("mean_resid")
    for tag, row in bias.iterrows():
        print(f"  {tag:<12} n={int(row['n']):<4} mean_resid={row['mean_resid']:+.2f}  mae={row['mae']:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
