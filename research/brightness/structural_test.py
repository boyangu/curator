#!/usr/bin/env python3
"""Test whether ARRANGEMENT STRUCTURE (bubbled up from RB phrase segments) predicts the
curator's brightness / power — e.g. "3 breakdowns of 2/2/4 bars" as a feature.

Pure metadata: reads rb_segments_json + bpm from curator.db (read-only), derives track-level
structural descriptors (counts, bar-lengths, energy-share, arrangement density), and scores
them leave-artist-out for both targets. Also tests whether structure ADDS to the whole-track
audio model. No audio re-analysis — runs instantly, no CPU contention with extraction.
"""
from __future__ import annotations
import csv, json, os, sqlite3
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge

from analyze import load, feature_cols

DB = r"C:\Users\guy\AppData\Roaming\Curator\curator.db"
BREAK = {"Down", "Bridge", *(f"Verse {i}" for i in range(1, 7))}
DROP = {"Chorus 1", "Chorus 2", "Chorus"}
BUILD = {"Up 1", "Up 2", "Up 3"}
INTRO = {"Intro", "Intro 1", "Intro 2"}
OUTRO = {"Outro", "Outro 1", "Outro 2"}


def labels(path):
    out = {}
    if os.path.exists(path):
        for r in csv.DictReader(open(path, newline="", encoding="utf-8")):
            out[r["track_id"]] = (float(r["label"]), r["primary_artist"])
    return out


def structural(segs, bpm):
    """Bubble segment list -> structural feature dict. bars = sec * bpm / 240."""
    def bars(s):
        d = float(s["endSec"]) - float(s["startSec"])
        return d * bpm / 240.0 if bpm and bpm > 0 else d / 2.0  # fallback ~2s/bar
    by = {"break": [], "drop": [], "build": [], "intro": [], "outro": []}
    for s in segs:
        lab = s.get("label", "")
        grp = ("break" if lab in BREAK else "drop" if lab in DROP else "build" if lab in BUILD
               else "intro" if lab in INTRO else "outro" if lab in OUTRO else None)
        if grp:
            by[grp].append(bars(s))
    total_dur = max((float(s["endSec"]) for s in segs), default=0.0)
    total_bars = total_dur * bpm / 240.0 if bpm and bpm > 0 else total_dur / 2.0
    f = {}
    for g, arr in by.items():
        f[f"n_{g}"] = len(arr)
        f[f"{g}_bars_total"] = float(sum(arr))
        f[f"{g}_bars_max"] = float(max(arr)) if arr else 0.0
        f[f"{g}_bars_mean"] = float(np.mean(arr)) if arr else 0.0
    f["break_n_short"] = sum(1 for b in by["break"] if b <= 4)     # short breakdowns (<=4 bars)
    f["break_n_long"] = sum(1 for b in by["break"] if b >= 16)     # long euphoric breakdowns
    f["break_bars_std"] = float(np.std(by["break"])) if len(by["break"]) > 1 else 0.0
    f["n_total"] = len(segs)
    f["seg_per_min"] = len(segs) / (total_dur / 60.0) if total_dur > 0 else 0.0
    low = f["break_bars_total"] + f["intro_bars_total"] + f["outro_bars_total"]
    high = f["drop_bars_total"] + f["build_bars_total"]
    f["low_energy_share"] = low / (low + high + 1e-9)
    f["break_to_drop"] = f["break_bars_total"] / (f["drop_bars_total"] + 1e-9)
    return f


def main() -> int:
    bright, power = labels(r"C:\tmp\brightness_dataset.csv"), labels(r"C:\tmp\power_dataset.csv")
    keep = set(bright) | set(power)
    db = sqlite3.connect(f"file:{DB.replace(os.sep,'/')}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    rows = []
    for r in db.execute("SELECT track_id, rb_segments_json, bpm FROM track_analysis WHERE rb_segments_json IS NOT NULL"):
        if r["track_id"] not in keep:
            continue
        try:
            segs = json.loads(r["rb_segments_json"])
        except Exception:
            continue
        if not segs:
            continue
        feat = structural(segs, r["bpm"])
        feat["track_id"] = r["track_id"]
        rows.append(feat)
    db.close()
    sdf = pd.DataFrame(rows).set_index("track_id")
    scols = list(sdf.columns)
    print(f"tracks with structure: {len(sdf)}  | structural features: {len(scols)}\n")

    def run(target_map, tname):
        ids = [t for t in sdf.index if t in target_map]
        d = sdf.loc[ids].copy()
        y = np.array([target_map[t][0] for t in ids])
        g = np.array([target_map[t][1] or f"__s{i}" for i, t in enumerate(ids)])
        gkf = GroupKFold(n_splits=5)
        X = d[scols].to_numpy(float).copy(); X[~np.isfinite(X)] = np.nan
        pipe = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=10.0))
        rho = spearmanr(y, cross_val_predict(pipe, X, y, cv=gkf, groups=g, n_jobs=1)).correlation
        print(f"== {tname}: structure-only ρ = {rho:.3f}  (n={len(ids)}) ==")
        cor = sorted(((c, spearmanr(d[c], y, nan_policy='omit').correlation) for c in scols),
                     key=lambda t: abs(t[1] if t[1] == t[1] else 0), reverse=True)
        for c, rc in cor[:10]:
            print(f"    {c:<22} {rc:+.3f}")
        return ids, y, g

    bids, by, bg = run(bright, "BRIGHTNESS")
    print()
    run(power, "POWER")

    # does structure ADD to the whole-track audio model for brightness?
    whole = load()
    wf = feature_cols(whole)
    m = whole.set_index("track_id")
    common = [t for t in bids if t in m.index]
    A = m.loc[common, wf].to_numpy(float).copy(); A[~np.isfinite(A)] = np.nan
    S = sdf.loc[common, scols].to_numpy(float).copy(); S[~np.isfinite(S)] = np.nan
    y = np.array([bright[t][0] for t in common])
    g = np.array([bright[t][1] or f"__s{i}" for i, t in enumerate(common)])
    gkf = GroupKFold(n_splits=5)
    pipe = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=10.0))
    r_audio = spearmanr(y, cross_val_predict(pipe, A, y, cv=gkf, groups=g, n_jobs=1)).correlation
    r_both = spearmanr(y, cross_val_predict(pipe, np.hstack([A, S]), y, cv=gkf, groups=g, n_jobs=1)).correlation
    print(f"\nBRIGHTNESS: whole-audio ρ={r_audio:.3f}  +structure ρ={r_both:.3f}  (Δ {r_both-r_audio:+.3f})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
