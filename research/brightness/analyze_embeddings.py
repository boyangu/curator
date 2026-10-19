#!/usr/bin/env python3
"""Evaluate Discogs-EffNet embeddings two ways (research venv: sklearn/numpy/pandas):

  A. RECO DEMO — cosine neighbours for a few seed tracks, printed with title/tags so you
     can eyeball whether "similar" feels right (the only real test for reco quality).
  B. LIFT TEST — does the embedding beat / add to the 204-feature brightness & power
     models (leave-artist-out)? Gates whether the TF dependency is worth shipping.
"""
from __future__ import annotations
import csv, os
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge

from analyze import load, augment_harmonic, feature_cols

EMB = r"C:\tmp\embeddings.npz"
DATASET = r"C:\tmp\brightness_dataset.csv"


def main() -> int:
    z = np.load(EMB, allow_pickle=True)
    ids = list(z["track_id"]); E = np.asarray(z["emb"], dtype=np.float32)
    idx = {t: i for i, t in enumerate(ids)}
    En = E / (np.linalg.norm(E, axis=1, keepdims=True) + 1e-9)
    meta = {}
    for r in csv.DictReader(open(DATASET, newline="", encoding="utf-8")):
        meta[r["track_id"]] = (r["primary_artist"], r["title"], r["label_name"])
    print(f"embeddings: {len(ids)} tracks, dim={E.shape[1]}\n")

    # ── A. RECO DEMO ──────────────────────────────────────────────────────
    print("== reco demo: 5 nearest neighbours (cosine) for sample seeds ==")
    seeds = ids[:: max(1, len(ids) // 6)][:6]
    for s in seeds:
        i = idx[s]
        sim = En @ En[i]
        order = np.argsort(-sim)
        a, t, lb = meta.get(s, ("", "", ""))
        print(f"\nSEED [{lb}] {a[:24]} - {t[:42]}")
        shown = 0
        for j in order:
            if ids[j] == s:
                continue
            aa, tt, ll = meta.get(ids[j], ("", "", ""))
            print(f"   {sim[j]:.3f} [{ll:<8}] {aa[:24]} - {tt[:42]}")
            shown += 1
            if shown >= 5:
                break

    # ── B. LIFT TEST ──────────────────────────────────────────────────────
    df = augment_harmonic(load())
    feats = [c for c in feature_cols(df) if c != "label"]
    labels = {}
    for fn, key in ((r"C:\tmp\brightness_dataset.csv", "bright"), (r"C:\tmp\power_dataset.csv", "power")):
        m = {}
        for r in csv.DictReader(open(fn, newline="", encoding="utf-8")):
            m[r["track_id"]] = (float(r["label"]), r["primary_artist"])
        labels[key] = m

    print("\n\n== lift test (leave-artist-out Ridge) ==")
    for target in ("bright", "power"):
        lab = labels[target]
        common = [t for t in ids if t in lab and t in set(df["track_id"])]
        d = df[df["track_id"].isin(common)].set_index("track_id").loc[common]
        y = np.array([lab[t][0] for t in common])
        g = np.array([lab[t][1] or f"__s{k}" for k, t in enumerate(common)])
        Xf = d[feats].to_numpy(float); Xf[~np.isfinite(Xf)] = np.nan
        Xe = np.array([En[idx[t]] for t in common])
        gkf = GroupKFold(n_splits=5)

        def rho(X):
            pipe = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=10.0))
            return spearmanr(y, cross_val_predict(pipe, X, y, cv=gkf, groups=g, n_jobs=1)).correlation

        rf = rho(Xf); re = rho(Xe); rfe = rho(np.hstack([Xf, Xe]))
        print(f"  {target:7} n={len(common):<4} features={rf:.3f}  embedding={re:.3f}  "
              f"features+embedding={rfe:.3f}  (Δ {rfe-rf:+.3f})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
