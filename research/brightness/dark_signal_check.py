#!/usr/bin/env python3
"""Diagnostic: can the audio features separate the user's DARK tracks from BRIGHT at all?

Weighting failed to pull the dark extreme down, which implies either (a) the features
carry no dark-discriminating signal (=> it's set-context, not acoustics), or (b) they
do but regression compresses it. A binary dark-vs-bright classifier settles it: a high
leave-artist-out AUC means the signal exists (and we should model the extremes as a
classification problem / add dark features); an AUC near 0.5 means the audio genuinely
can't tell them apart.

Compares the full feature set vs centroid-only, and lists the strongest single
separators (point-biserial-ish via per-feature AUC).
"""
from __future__ import annotations
import numpy as np
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

from analyze import load, augment_harmonic, feature_cols


def main() -> int:
    df = augment_harmonic(load())
    feats = feature_cols(df)
    y = df["label"].to_numpy(dtype=float)
    # Clear dark vs clear bright; drop the b0+d1 (1.5) middle to avoid blur.
    dark = y <= 1.0          # d1, d1+d2, d2
    bright = y >= 2.0        # b0, b0.5, b1
    keep = dark | bright
    yb = dark[keep].astype(int)   # 1 = dark (the positive class we care about)
    sub = df[keep].reset_index(drop=True)
    X = sub[feats].to_numpy(dtype=float).copy()
    X[~np.isfinite(X)] = np.nan
    groups = sub["primary_artist"].fillna("").to_numpy()
    groups = np.array([g if g else f"__solo_{i}" for i, g in enumerate(groups)])
    gkf = GroupKFold(n_splits=min(5, len(set(groups))))
    print(f"dark={int(yb.sum())} bright={int((1-yb).sum())} features={len(feats)}")

    def auc_of(Xm, return_proba=False):
        clf = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                            LogisticRegression(max_iter=2000, class_weight="balanced"))
        proba = cross_val_predict(clf, Xm, yb, cv=gkf, groups=groups,
                                  method="predict_proba", n_jobs=1)[:, 1]
        auc = roc_auc_score(yb, proba)
        return (auc, proba) if return_proba else auc

    cen = sub[["lowlevel.spectral_centroid.mean"]].to_numpy(dtype=float)
    print(f"\nLeave-artist-out AUC (dark vs bright):")
    print(f"  centroid only : {auc_of(cen):.3f}")
    auc_all, proba = auc_of(X, return_proba=True)
    print(f"  all features  : {auc_all:.3f}   (0.5=no signal, 1.0=perfect)")

    # Decisive: at the threshold that flags the base-rate number of darks, what recall do
    # we get overall and on the TRUE d2 floor specifically?
    yvals = y[keep]
    k = int(yb.sum())
    thresh = np.sort(proba)[::-1][k - 1]
    flagged = proba >= thresh
    recall_dark = np.mean(flagged[yb == 1])
    is_d2 = (yvals == 0.0)
    is_d1d2 = (yvals <= 0.5)
    print(f"  flag darkest {k} by P(dark): recall on all dark(<=d1)={recall_dark:.0%}  "
          f"on d1+d2/d2={np.mean(flagged[is_d1d2]):.0%}  on pure d2={np.mean(flagged[is_d2]):.0%}")

    # strongest single separators by univariate AUC
    rows = []
    for i, c in enumerate(feats):
        v = X[:, i]
        m = np.isfinite(v)
        if m.sum() < len(v) * 0.5:
            continue
        try:
            a = roc_auc_score(yb[m], v[m])
        except Exception:
            continue
        rows.append((c, max(a, 1 - a)))   # direction-agnostic strength
    rows.sort(key=lambda t: t[1], reverse=True)
    print("\nstrongest single features for dark-vs-bright (|AUC|):")
    for c, a in rows[:18]:
        print(f"  {a:.3f}  {c}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
