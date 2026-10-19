#!/usr/bin/env python3
"""Verify the analyzer's scoring.py reproduces the research features/scores EXACTLY.

WSL-only (numpy + essentia + stdlib). For N sample tracks:
  - run scoring.build_vector on a fresh MusicExtractor pass,
  - compare its flatten+engineered features to the stored research jsonl (same logic,
    same MusicExtractor → must be identical, modulo float),
  - compare scoring.harmonic to an INLINE copy of research analyze.augment_harmonic
    (the source of truth the weights were fit on),
  - compare end-to-end brightness/power scores (research-ref vs analyzer).
PASS = every max|Δ| tiny.
"""
from __future__ import annotations
import json, os, sys
import numpy as np

sys.path.insert(0, os.environ.get("CURATOR_ANALYZER_SRC", os.path.join(os.path.dirname(__file__), "..", "..", "apps", "analyzer", "src")))
from curator_analyzer import scoring
from essentia.standard import MusicExtractor

DATASET = "/mnt/c/tmp/brightness_dataset.csv"
FEATURES = "/mnt/c/tmp/brightness_features.jsonl"
N = 12

# --- inline copy of research analyze.augment_harmonic (per-row body) = source of truth ---
KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
LOF = np.array([0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5], dtype=float)


def ref_harm(row: dict) -> dict:
    hcols = [f"tonal.hpcp.mean.{i}" for i in range(36)]
    cols = ["harm.modal_brightness", "harm.mode_major", "harm.key_strength",
            "harm.major_third_ratio", "harm.lydian_sharp4", "harm.phrygian_flat2",
            "harm.nat7_vs_flat7", "harm.bright_degrees", "harm.dark_degrees"] + [f"harm.deg_{i}" for i in range(12)]
    if not all(c in row for c in hcols):
        return {c: float("nan") for c in cols}
    h = np.array([row[c] for c in hcols], dtype=float)
    if not np.isfinite(h).all() or h.sum() <= 0:
        return {c: float("nan") for c in cols}
    ch = h.reshape(12, 3).sum(axis=1); ch = ch / (ch.sum() + 1e-9)
    chn = ch - ch.mean()
    br, bs, bm = 0, -2.0, True
    for r in range(12):
        for prof, mj in ((KS_MAJOR, True), (KS_MINOR, False)):
            p = np.roll(prof, r); p = p - p.mean()
            sc = float((chn * p).sum() / (np.sqrt((chn ** 2).sum() * (p ** 2).sum()) + 1e-9))
            if sc > bs:
                bs, br, bm = sc, r, mj
    rel = np.roll(ch, -br)
    o = {"harm.modal_brightness": float((rel * LOF).sum()), "harm.mode_major": 1.0 if bm else 0.0,
         "harm.key_strength": bs, "harm.major_third_ratio": float(rel[4] / (rel[4] + rel[3] + 1e-9)),
         "harm.lydian_sharp4": float(rel[6]), "harm.phrygian_flat2": float(rel[1]),
         "harm.nat7_vs_flat7": float(rel[11] / (rel[11] + rel[10] + 1e-9)),
         "harm.bright_degrees": float(rel[[2, 4, 6, 9, 11]].sum()), "harm.dark_degrees": float(rel[[1, 3, 8, 10]].sum())}
    for i in range(12):
        o[f"harm.deg_{i}"] = float(rel[i])
    return o


def model_score(model, feats):
    acc = float(model["intercept"])
    for i, nm in enumerate(model["features"]):
        x = feats.get(nm)
        if x is None or not np.isfinite(x):
            x = model["impute_median"][i]
        s = model["std"][i]
        if s:
            acc += model["coef"][i] * ((x - model["mean"][i]) / s)
    return acc


def main() -> int:
    bm = json.load(open("/mnt/c/tmp/brightness_model.json", encoding="utf-8"))
    pm = json.load(open("/mnt/c/tmp/power_model.json", encoding="utf-8"))
    feat_by_id = {}
    for line in open(FEATURES, encoding="utf-8"):
        r = json.loads(line)
        if r.get("_ok"):
            feat_by_id[r["track_id"]] = r
    import csv
    rows = list(csv.DictReader(open(DATASET, newline="", encoding="utf-8")))

    me = MusicExtractor(lowlevelFrameSize=2048, lowlevelHopSize=1024,
                        rhythmStats=["mean"], tonalStats=["mean"], lowlevelStats=["mean", "stdev"])
    max_feat = max_harm = max_b = max_p = 0.0
    n = 0
    for row in rows:
        if n >= N:
            break
        tid, path = row["track_id"], row["wsl_path"]
        if tid not in feat_by_id or not os.path.exists(path):
            continue
        ref = feat_by_id[tid]
        pool, _ = me(path)
        wv = scoring.build_vector(pool)
        # flatten+engineered diff vs stored jsonl
        shared = [k for k in ref if not k.startswith("_") and k in wv and isinstance(ref[k], (int, float))]
        fdiff = max((abs(ref[k] - wv[k]) for k in shared if np.isfinite(ref[k]) and np.isfinite(wv[k])), default=0.0)
        # harm: scoring vs inline reference (from the SAME stored hpcp)
        rh = ref_harm(ref); wh = {k: wv.get(k) for k in rh}
        hdiff = max((abs(rh[k] - wh[k]) for k in rh if np.isfinite(rh[k]) and wh[k] is not None and np.isfinite(wh[k])), default=0.0)
        # scores: reference (stored feats + ref harm) vs analyzer
        refv = dict(ref); refv.update(rh)
        b_ref, p_ref = model_score(bm, refv), model_score(pm, refv)
        b_w, p_w = scoring.brightness_power(pool)
        max_feat = max(max_feat, fdiff); max_harm = max(max_harm, hdiff)
        max_b = max(max_b, abs(b_ref - b_w)); max_p = max(max_p, abs(p_ref - p_w))
        print(f"{tid[:12]:<13} featΔ={fdiff:.2e} harmΔ={hdiff:.2e}  bright {b_ref:.3f}/{b_w:.3f}  power {p_ref:.3f}/{p_w:.3f}")
        n += 1
    ok = max(max_feat, max_harm, max_b, max_p) < 1e-3
    print(f"\nmax Δ: feat={max_feat:.2e} harm={max_harm:.2e} bright={max_b:.2e} power={max_p:.2e}  "
          f"-> {'PORT FAITHFUL' if ok else 'MISMATCH'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
