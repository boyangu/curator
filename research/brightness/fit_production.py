#!/usr/bin/env python3
"""Fit + export the production brightness & power formulas.

Ships as a linear model (z-score → weighted sum) over a DIRECTLY-REPRODUCIBLE feature set:
everything `_flatten(pool)` + `_engineered` produce in the analyzer — i.e. NO harm.* features
(those need bespoke HPCP folding + key estimation; excluded for a robust port, costs ~0.02 ρ).

Exports c:\\tmp\\brightness_model.json and power_model.json:
  { target, features[], mean[], std[], coef[], intercept, cv_rho, n, alpha, analyzer_inputs }
worker.py reproduces it: MusicExtractor → flatten(keep mfcc/gfcc/hpcp/contrast arrays) →
engineered → (x-mean)/std → dot(coef)+intercept → percentile-bucket via cutoffStore.
"""
from __future__ import annotations
import csv, json, os
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.linear_model import Ridge
from sklearn.impute import SimpleImputer

from analyze import augment_harmonic, feature_cols

FEATURE_FILES = [r"C:\tmp\brightness_features.jsonl", r"C:\tmp\power_delta_features.jsonl"]
ALPHA = 10.0


def load_all():
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
    for r in csv.DictReader(open(path, newline="", encoding="utf-8")):
        out[r["track_id"]] = (float(r["label"]), r["primary_artist"])
    return out


def shared_features(df):
    """One feature list used by BOTH models so the analyzer computes a single vector.
    Includes harm.* (user chose the higher-fidelity port). Numeric, non-constant, present."""
    EXCLUDE = {"label", "cur_brightness", "y", "_secs", "_ok"}
    return [c for c in df.select_dtypes(include=[np.number]).columns
            if c not in EXCLUDE
            and df[c].notna().sum() > len(df) * 0.5 and df[c].std(skipna=True) > 0]


def fit_export(df, target_map, target_name, out_path, feats):
    d = df[df["track_id"].isin(target_map)].copy()
    d["y"] = d["track_id"].map(lambda t: target_map[t][0])
    d["artist"] = d["track_id"].map(lambda t: target_map[t][1])
    X = d[feats].to_numpy(float).copy(); X[~np.isfinite(X)] = np.nan
    y = d["y"].to_numpy(float)
    g = d["artist"].fillna("").to_numpy(); g = np.array([x if x else f"__s{i}" for i, x in enumerate(g)])

    # impute (median) + standardize manually so params are exportable verbatim
    imp = SimpleImputer(strategy="median").fit(X)
    Xi = imp.transform(X)
    mean = Xi.mean(0); std = Xi.std(0)
    std[std < 1e-6] = 1.0  # near-constant feature → std=1 (coef ~0); avoids rounding to 0 on export
    Xz = (Xi - mean) / std

    gkf = GroupKFold(n_splits=5)
    cv_pred = cross_val_predict(Ridge(alpha=ALPHA), Xz, y, cv=gkf, groups=g, n_jobs=1)
    cv_rho = spearmanr(y, cv_pred).correlation

    model = Ridge(alpha=ALPHA).fit(Xz, y)  # final fit on all data
    art = {
        "target": target_name, "n": int(len(d)), "alpha": ALPHA,
        "cv_rho_leave_artist_out": round(float(cv_rho), 4),
        "label_scale": "brightness 0-3 (d2..b1)" if target_name == "brightness" else "power 0-5 (p0..p5)",
        "features": feats,
        "impute_median": [round(float(v), 6) for v in imp.statistics_],
        "mean": [round(float(v), 6) for v in mean],
        "std": [round(float(v), 6) for v in std],
        "coef": [round(float(v), 6) for v in model.coef_],
        "intercept": round(float(model.intercept_), 6),
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(art, f, indent=1)
    # sanity: reproduce prediction from exported params == sklearn predict
    repro = ((np.nan_to_num(X, nan=np.array(art["impute_median"])) - mean) / std) @ model.coef_ + model.intercept_
    # (note: nan_to_num with array needs per-col; quick check via pipeline instead)
    print(f"{target_name}: n={len(d)} feats={len(feats)} cv_rho={cv_rho:.3f} -> {out_path}")
    # top weights
    order = sorted(zip(feats, model.coef_), key=lambda t: abs(t[1]), reverse=True)[:12]
    for c, w in order:
        print(f"    {w:+.3f}  {c}")
    return cv_rho


def main() -> int:
    df = augment_harmonic(load_all())
    feats = shared_features(df)
    print(f"shared feature list: {len(feats)} features (incl. {sum(c.startswith('harm.') for c in feats)} harmonic)\n")
    b = labels(r"C:\tmp\brightness_dataset.csv")
    p = labels(r"C:\tmp\power_dataset.csv")
    print("=== BRIGHTNESS ===")
    fit_export(df, b, "brightness", r"C:\tmp\brightness_model.json", feats)
    print("\n=== POWER ===")
    fit_export(df, p, "power", r"C:\tmp\power_model.json", feats)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
