#!/usr/bin/env python3
"""Phase 3 — model the user's perceptual brightness from extracted Essentia features.

Reads c:\\tmp\\brightness_features.jsonl (append-only, from extract_features.py — works
on PARTIAL data for an early read) and answers: is there "underlying math" that
reproduces the user's b1/b0/d1/d2 (continuous 0-3) judgments better than the current
spectral-centroid baseline?

Target is CONTINUOUS (half-steps), so this is a regression problem. We evaluate every
model with GroupKFold grouped by primary artist (leave-artist-out) so the score reflects
generalization to NEW tracks, not memorized artists. Metrics: Spearman rho (rank
agreement with the user), MAE on the 0-3 scale, and "within +/-0.5 / +/-1.0" hit-rate.

Runs in a venv with: scikit-learn, pandas, numpy, scipy  (xgboost optional).
    python analyze.py
Writes c:\\tmp\\brightness_report.md.
"""
from __future__ import annotations
import json, os, sys
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
from sklearn.svm import SVR

FEATURES = os.environ.get("BRIGHTNESS_FEATURES", r"C:\tmp\brightness_features.jsonl")
REPORT = os.environ.get("BRIGHTNESS_REPORT", r"C:\tmp\brightness_report.md")
META = {"track_id", "label", "label_name", "primary_artist", "key_camelot",
        "cur_brightness", "_ok", "_err", "_secs"}
N_SPLITS = 5
BASELINE_FEAT = "lowlevel.spectral_centroid.mean"


def load() -> pd.DataFrame:
    rows = []
    with open(FEATURES, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("_ok"):
                rows.append(r)
    df = pd.DataFrame(rows)
    # key mode from camelot letter: 'B' = major (brighter), 'A' = minor.
    def mode(c):
        if isinstance(c, str) and c[-1:] in ("A", "B"):
            return 1.0 if c[-1] == "B" else 0.0
        return np.nan
    df["key_mode_major"] = df["key_camelot"].map(mode)
    return df


# Krumhansl-Kessler key profiles (major / minor) for tonic estimation from chroma.
KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
# Line-of-fifths brightness weight per scale degree (semitones from tonic):
# raised degrees (#4 Lydian, nat7) positive; lowered (b2 Phrygian, b3, b6, b7) negative.
LOF_WEIGHT = np.array([0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5], dtype=float)
# Degree groups for ratio features (relative to estimated tonic at index 0).
MAJ3, MIN3, P4, AUG4, B7, NAT7, B2 = 4, 3, 5, 6, 10, 11, 1


def augment_harmonic(df: pd.DataFrame) -> pd.DataFrame:
    """Derive tonic-relative chroma + a music-theory 'modal brightness' from the
    already-extracted 36-bin HPCP. Tonic+mode are estimated per track via Krumhansl
    profile correlation on the time-averaged chroma, so this needs no re-extraction.
    Absolute HPCP reference cancels out — we rotate by the estimated tonic."""
    hcols = [f"tonal.hpcp.mean.{i}" for i in range(36)]
    if not all(c in df.columns for c in hcols):
        print("  (hpcp not present yet — skipping harmonic augmentation)")
        return df
    H = df[hcols].to_numpy(dtype=float)
    new: dict[str, list] = {}
    cols = ["harm.modal_brightness", "harm.mode_major", "harm.key_strength",
            "harm.major_third_ratio", "harm.lydian_sharp4", "harm.phrygian_flat2",
            "harm.nat7_vs_flat7", "harm.bright_degrees", "harm.dark_degrees"] + \
           [f"harm.deg_{i}" for i in range(12)]
    for c in cols:
        new[c] = []

    for row in H:
        if not np.isfinite(row).all() or row.sum() <= 0:
            for c in cols:
                new[c].append(np.nan)
            continue
        ch = row.reshape(12, 3).sum(axis=1)          # 36 -> 12 semitone bins
        ch = ch / (ch.sum() + 1e-9)
        # Krumhansl tonic+mode: best rotation over major & minor profiles.
        best_r, best_score, best_major = 0, -2.0, True
        chn = ch - ch.mean()
        for r in range(12):
            for prof, is_maj in ((KS_MAJOR, True), (KS_MINOR, False)):
                p = np.roll(prof, r)
                p = p - p.mean()
                denom = np.sqrt((chn ** 2).sum() * (p ** 2).sum()) + 1e-9
                score = float((chn * p).sum() / denom)
                if score > best_score:
                    best_score, best_r, best_major = score, r, is_maj
        rel = np.roll(ch, -best_r)                   # rotate so tonic -> index 0
        new["harm.modal_brightness"].append(float((rel * LOF_WEIGHT).sum()))
        new["harm.mode_major"].append(1.0 if best_major else 0.0)
        new["harm.key_strength"].append(best_score)
        new["harm.major_third_ratio"].append(float(rel[MAJ3] / (rel[MAJ3] + rel[MIN3] + 1e-9)))
        new["harm.lydian_sharp4"].append(float(rel[AUG4]))
        new["harm.phrygian_flat2"].append(float(rel[B2]))
        new["harm.nat7_vs_flat7"].append(float(rel[NAT7] / (rel[NAT7] + rel[B7] + 1e-9)))
        bright = rel[[2, 4, 6, 9, 11]].sum()         # 2,3,#4,6,7
        dark = rel[[1, 3, 8, 10]].sum()              # b2,b3,b6,b7
        new["harm.bright_degrees"].append(float(bright))
        new["harm.dark_degrees"].append(float(dark))
        for i in range(12):
            new[f"harm.deg_{i}"].append(float(rel[i]))

    for c in cols:
        df[c] = new[c]
    return df


def feature_cols(df: pd.DataFrame) -> list[str]:
    cols = []
    for c in df.columns:
        if c in META:
            continue
        if not np.issubdtype(df[c].dtype, np.number):
            continue
        if df[c].notna().sum() < len(df) * 0.5:   # drop mostly-missing
            continue
        if df[c].std(skipna=True) == 0:            # drop constant
            continue
        cols.append(c)
    return cols


def evaluate(y_true, y_pred) -> dict:
    rho = spearmanr(y_true, y_pred).correlation
    mae = float(np.mean(np.abs(y_true - y_pred)))
    within_half = float(np.mean(np.abs(y_true - y_pred) <= 0.5))
    within_one = float(np.mean(np.abs(y_true - y_pred) <= 1.0))
    ss_res = float(np.sum((y_true - y_pred) ** 2))
    ss_tot = float(np.sum((y_true - np.mean(y_true)) ** 2))
    r2 = 1 - ss_res / ss_tot if ss_tot else float("nan")
    return {"spearman": rho, "mae": mae, "within_0.5": within_half, "within_1.0": within_one, "r2": r2}


def main() -> int:
    df = load()
    df = augment_harmonic(df)
    n = len(df)
    if n < int(os.environ.get("MIN_ROWS", "50")):
        print(f"only {n} extracted rows so far — run again once more features land.")
        return 0
    feats = feature_cols(df)
    X = df[feats].to_numpy(dtype=float).copy()
    X[~np.isfinite(X)] = np.nan
    y = df["label"].to_numpy(dtype=float)
    # groups: artist (leave-artist-out); empty artist -> unique per-row group
    groups = df["primary_artist"].fillna("").to_numpy()
    groups = np.array([g if g else f"__solo_{i}" for i, g in enumerate(groups)])
    n_groups = len(set(groups))
    splits = min(N_SPLITS, n_groups)
    gkf = GroupKFold(n_splits=splits)

    models = {
        "baseline (centroid only)": ("linear", df[[BASELINE_FEAT]].to_numpy(dtype=float)),
        "Ridge (all features)": ("ridge", X),
        "RandomForest": ("rf", X),
        "GradientBoosting": ("gb", X),
        "SVR (rbf)": ("svr", X),
    }
    try:
        from xgboost import XGBRegressor  # noqa
        models["XGBoost"] = ("xgb", X)
    except Exception:
        pass

    def make(kind):
        if kind in ("linear", "ridge"):
            return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                                 Ridge(alpha=10.0 if kind == "ridge" else 1.0))
        if kind == "rf":
            return make_pipeline(SimpleImputer(strategy="median"),
                                 RandomForestRegressor(n_estimators=400, n_jobs=-1, random_state=0))
        if kind == "gb":
            return make_pipeline(SimpleImputer(strategy="median"),
                                 GradientBoostingRegressor(random_state=0))
        if kind == "svr":
            return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), SVR(C=5.0))
        if kind == "xgb":
            from xgboost import XGBRegressor
            return make_pipeline(SimpleImputer(strategy="median"),
                                 XGBRegressor(n_estimators=500, max_depth=4, learning_rate=0.05,
                                              subsample=0.8, colsample_bytree=0.6, n_jobs=-1, random_state=0))

    results = {}
    for name, (kind, Xm) in models.items():
        pred = cross_val_predict(make(kind), Xm, y, cv=gkf, groups=groups, n_jobs=1)
        results[name] = evaluate(y, pred)
        print(f"{name:28} rho={results[name]['spearman']:.3f} mae={results[name]['mae']:.3f} "
              f"<=0.5={results[name]['within_0.5']:.2f} R2={results[name]['r2']:.3f}", flush=True)

    # Spearman correlation of each feature vs label (with key_mode included)
    corr = []
    for c in feats:
        v = df[c].to_numpy(dtype=float)
        m = np.isfinite(v)
        if m.sum() > n * 0.5:
            rho = spearmanr(v[m], y[m]).correlation
            if rho is not None and np.isfinite(rho):
                corr.append((c, rho))
    corr.sort(key=lambda t: abs(t[1]), reverse=True)

    # Focused readout: how do the engineered harmonic/scale features fare?
    harm = [(c, r) for c, r in corr if c.startswith("harm.")]
    if harm:
        print("\n  harmonic/scale features vs label (Spearman):")
        for c, r in sorted(harm, key=lambda t: abs(t[1]), reverse=True)[:10]:
            print(f"    {c:28} {r:+.3f}", flush=True)
        # Standalone power of harmonic-only block (leave-artist-out).
        hcols2 = [c for c in feats if c.startswith("harm.")]
        if hcols2:
            Xh = df[hcols2].to_numpy(dtype=float).copy()
            Xh[~np.isfinite(Xh)] = np.nan
            ph = cross_val_predict(make("ridge"), Xh, y, cv=gkf, groups=groups, n_jobs=1)
            mh = evaluate(y, ph)
            print(f"    -> harmonic-only Ridge: rho={mh['spearman']:.3f} mae={mh['mae']:.3f}", flush=True)

    # Ridge coefficients on standardized features (interpretable "math")
    ridge = make("ridge").fit(X, y)
    scaler = ridge.named_steps["standardscaler"]
    coefs = ridge.named_steps["ridge"].coef_
    coef_rows = sorted(zip(feats, coefs), key=lambda t: abs(t[1]), reverse=True)

    # RF importance
    rf = make("rf").fit(X, y)
    imp = rf.named_steps["randomforestregressor"].feature_importances_
    imp_rows = sorted(zip(feats, imp), key=lambda t: t[1], reverse=True)

    write_report(df, feats, results, corr, coef_rows, imp_rows, splits, n_groups)
    print(f"\nreport -> {REPORT}")
    return 0


def write_report(df, feats, results, corr, coef_rows, imp_rows, splits, n_groups):
    n = len(df)
    dist = df["label_name"].value_counts().to_dict()
    L = []
    L.append("# Brightness model — reverse-engineering b1/b0/d1/d2 from audio\n")
    L.append(f"- Extracted tracks: **{n}** | features: **{len(feats)}** | "
             f"artists(groups): {n_groups} | CV: GroupKFold({splits}) leave-artist-out")
    L.append(f"- Target: continuous 0-3 (b1=3 … d2=0); half-steps from adjacent tags.")
    L.append(f"- Label distribution: " + ", ".join(f"{k}={v}" for k, v in
             sorted(dist.items(), key=lambda kv: -kv[1])) + "\n")

    L.append("## Model comparison (out-of-fold, leave-artist-out)\n")
    L.append("| model | Spearman ρ | MAE (0-3) | within ±0.5 | within ±1.0 | R² |")
    L.append("|---|---|---|---|---|---|")
    base = results.get("baseline (centroid only)", {})
    for name, m in results.items():
        L.append(f"| {name} | {m['spearman']:.3f} | {m['mae']:.3f} | "
                 f"{m['within_0.5']:.2f} | {m['within_1.0']:.2f} | {m['r2']:.3f} |")
    L.append("")
    if base:
        best = max((m for k, m in results.items() if k != "baseline (centroid only)"),
                   key=lambda m: m["spearman"], default=None)
        if best:
            L.append(f"> Baseline Spearman ρ = **{base['spearman']:.3f}**; best model ρ = "
                     f"**{best['spearman']:.3f}** "
                     f"(Δ {best['spearman']-base['spearman']:+.3f}).\n")

    L.append("## Top features by |Spearman ρ| with the user's label\n")
    L.append("| feature | ρ |")
    L.append("|---|---|")
    for c, r in corr[:30]:
        L.append(f"| {c} | {r:+.3f} |")
    L.append("")

    L.append("## Interpretable model — Ridge coefficients (standardized features)\n")
    L.append("These weights are the candidate 'underlying math' (applied to z-scored features).\n")
    L.append("| feature | weight |")
    L.append("|---|---|")
    for c, w in coef_rows[:25]:
        L.append(f"| {c} | {w:+.3f} |")
    L.append("")

    L.append("## RandomForest feature importance\n")
    L.append("| feature | importance |")
    L.append("|---|---|")
    for c, w in imp_rows[:25]:
        L.append(f"| {c} | {w:.3f} |")
    L.append("")

    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(L))


if __name__ == "__main__":
    raise SystemExit(main())
