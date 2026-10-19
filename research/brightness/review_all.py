#!/usr/bin/env python3
"""Consolidated review of every brightness 'lens' we've tested:
  H1 spectral SHAPE (V/U scoop), H2 TEXTURE (hammering/transient), TIMBRE (MFCC envelope),
  WARMTH (spectral tilt / warm-cold), CLARITY (spectral contrast), HARMONY (key/chord/chroma).

For each lens: standalone leave-artist-out Ridge ρ. Plus a redundancy matrix (correlation
between lenses' predictions — are they the same axis or complementary?), the combined ρ,
and references (full 187-feature model, centroid baseline). Writes c:\\tmp\\brightness_lenses.md.

Preliminary: if c:\\tmp\\hpss.jsonl exists, also report the HPSS percussive-ratio (texture
refinement) on whatever subset has been extracted so far.
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

from analyze import load, augment_harmonic, feature_cols

EB = {k: f"lowlevel.spectral_energyband_{k}.mean" for k in ("low", "middle_low", "middle_high", "high")}
REPORT = r"C:\tmp\brightness_lenses.md"
HPSS = r"C:\tmp\hpss.jsonl"


def main() -> int:
    df = augment_harmonic(load())
    y = df["label"].to_numpy(dtype=float)
    groups = df["primary_artist"].fillna("").to_numpy()
    groups = np.array([g if g else f"__solo_{i}" for i, g in enumerate(groups)])
    gkf = GroupKFold(n_splits=min(5, len(set(groups))))

    lo, ml, mh, hi = (df[EB[k]].to_numpy(float) for k in ("low", "middle_low", "middle_high", "high"))
    tot = lo + ml + mh + hi + 1e-12
    df["eng.extremes_share"] = (lo + hi) / tot
    df["eng.mid_share"] = (ml + mh) / tot

    LENS = {
        "H1 shape (V/U scoop)": ["eng.extremes_share", "eng.mid_share",
            "lowlevel.barkbands_spread.mean", "lowlevel.erbbands_spread.mean",
            "lowlevel.barkbands_kurtosis.mean", "lowlevel.melbands_kurtosis.mean"],
        "H2 texture (hammering)": ["lowlevel.spectral_flux.mean", "lowlevel.melbands_crest.mean",
            "lowlevel.barkbands_crest.mean", "lowlevel.pitch_salience.stdev",
            "lowlevel.zerocrossingrate.mean", "lowlevel.spectral_complexity.stdev"],
        "Timbre (MFCC/GFCC)": [f"lowlevel.mfcc.mean.{i}" for i in range(1, 9)] +
            [f"lowlevel.gfcc.mean.{i}" for i in range(1, 9)],
        "Warmth (spectral tilt)": ["lowlevel.spectral_centroid.mean", "lowlevel.spectral_rolloff.mean",
            EB["low"], EB["middle_low"], EB["middle_high"], EB["high"], "lowlevel.mfcc.mean.1"],
        "Clarity (spectral contrast)": ["lowlevel.spectral_contrast_coeffs.mean.1",
            "lowlevel.spectral_contrast_coeffs.mean.2", "lowlevel.spectral_contrast_coeffs.mean.3",
            "tonal.hpcp_crest.mean"],
        "Harmony (key/chord/chroma)": ["tonal.hpcp_entropy.mean", "lowlevel.dissonance.mean",
            "tonal.chords_changes_rate", "harm.key_strength", "harm.phrygian_flat2",
            "harm.modal_brightness", "harm.major_third_ratio"],
    }

    def fit_block(cols):
        cols = [c for c in cols if c in df.columns]
        X = df[cols].to_numpy(dtype=float).copy()
        X[~np.isfinite(X)] = np.nan
        pipe = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=5.0))
        pred = cross_val_predict(pipe, X, y, cv=gkf, groups=groups, n_jobs=1)
        return pred, spearmanr(y, pred).correlation

    preds, rhos = {}, {}
    for name, cols in LENS.items():
        p, r = fit_block(cols)
        preds[name], rhos[name] = p, r

    # references
    allfeats = feature_cols(df)
    p_all, r_all = fit_block(allfeats)
    _, r_cen = fit_block(["lowlevel.spectral_centroid.mean"])
    p_union, r_union = fit_block(sum(LENS.values(), []))

    # ---- print + report ----
    L = ["# Brightness — review of all lenses (leave-artist-out, n=%d)\n" % len(df)]
    L.append("## Standalone predictive power (Spearman ρ vs your tag)\n")
    L.append("| lens | ρ |\n|---|---|")
    for name in sorted(rhos, key=lambda k: -rhos[k]):
        L.append(f"| {name} | {rhos[name]:.3f} |")
    L.append(f"| — all 6 lenses combined | {r_union:.3f} |")
    L.append(f"| — full 187-feature model (ref) | {r_all:.3f} |")
    L.append(f"| — centroid only (today's metric) | {r_cen:.3f} |")
    L.append("")

    names = list(LENS.keys())
    L.append("## Redundancy matrix — corr between lenses' predictions\n")
    L.append("(1.0 = identical axis; lower = complementary)\n")
    L.append("| | " + " | ".join(n.split(" ")[0] for n in names) + " |")
    L.append("|" + "---|" * (len(names) + 1))
    for a in names:
        row = [f"{spearmanr(preds[a], preds[b]).correlation:.2f}" for b in names]
        L.append(f"| {a.split(' ')[0]} | " + " | ".join(row) + " |")
    L.append("")

    print("\n".join(L))

    # ---- HPSS texture refinement (preliminary, partial sample) ----
    if os.path.exists(HPSS):
        pr = {}
        for line in open(HPSS, encoding="utf-8"):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("_ok"):
                pr[r["track_id"]] = r["perc_ratio"]
        sub = df[df["track_id"].isin(pr)]
        if len(sub) > 50:
            rr = spearmanr(sub["track_id"].map(pr), sub["label"]).correlation
            note = (f"\n## HPSS percussive ratio (texture refinement) — PRELIMINARY n={len(sub)}\n"
                    f"perc_ratio vs label: ρ={rr:+.3f}  (expect <0: more percussive → darker)")
            print(note)
            L.append(note)

    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    print(f"\n-> {REPORT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
