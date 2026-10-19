#!/usr/bin/env python3
"""Phase 2 — Essentia feature extraction over the brightness-labeled dataset.

Runs in the analyzer's WSL venv (.venv-wsl: essentia + numpy). Reads
c:\\tmp\\brightness_dataset.csv (from export_dataset.py), runs MusicExtractor on each
track's audio, and writes a rich per-track feature vector to an append-only JSONL
checkpoint (c:\\tmp\\brightness_features.jsonl) so a long run survives a crash/resume.

We deliberately extract a WIDER vector than the production analyzer's scalar-only
_flatten_pool: all numeric lowlevel/tonal/rhythm scalars (mean AND stdev) PLUS the
MFCC (timbre) and HPCP (chroma/harmony) mean vectors, which _flatten_pool drops.
Modeling (Phase 3, separate venv) reads this JSONL with pandas.

Usage (under WSL):
    .venv-wsl/bin/python extract_features.py [--sample N] [--workers K]
--sample N  : stratified subset (~N total across the 7 label bins) for a fast trial.
--workers K : parallel MusicExtractor processes (default: cpu_count-2).
Re-running resumes: track_ids already in the JSONL are skipped.
"""
from __future__ import annotations
import argparse, csv, json, os, sys, time
from collections import defaultdict
from multiprocessing import Pool, cpu_count

DATASET = os.environ.get("BRIGHTNESS_DATASET", "/mnt/c/tmp/brightness_dataset.csv")
OUT = os.environ.get("BRIGHTNESS_FEATURES", "/mnt/c/tmp/brightness_features.jsonl")

# MusicExtractor array descriptors worth flattening (others are kept as scalars).
# These are the timbre (mfcc) + harmony (hpcp) vectors the researcher flagged and
# which the production _flatten_pool discards.
ARRAY_KEYS = (
    "lowlevel.mfcc.mean",
    "lowlevel.gfcc.mean",
    "tonal.hpcp.mean",
    "lowlevel.spectral_contrast_coeffs.mean",
)


def _flatten(pool) -> dict:
    """Essentia Pool -> flat dict. Keep numeric scalars; flatten whitelisted 1-D
    arrays into name_0..name_k; drop everything else (matrices, strings, long arrays)."""
    out: dict[str, float] = {}
    for name in pool.descriptorNames():
        try:
            v = pool[name]
        except Exception:
            continue
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[name] = float(v)
            continue
        if hasattr(v, "tolist"):
            if name in ARRAY_KEYS and getattr(v, "ndim", 99) == 1:
                for i, x in enumerate(v.tolist()):
                    out[f"{name}.{i}"] = float(x)
            # else: matrix / non-whitelisted array -> skip
    return out


def _engineered(f: dict) -> dict:
    """Perceptually-motivated derived features (brightness ~ treble share)."""
    e = {}
    lo = f.get("lowlevel.spectral_energyband_low.mean")
    mid = f.get("lowlevel.spectral_energyband_middle_low.mean", 0.0) + \
          f.get("lowlevel.spectral_energyband_middle_high.mean", 0.0)
    hi = f.get("lowlevel.spectral_energyband_high.mean")
    if lo is not None and hi is not None:
        tot = (lo or 0) + (mid or 0) + (hi or 0)
        if tot > 0:
            e["eng.treble_share"] = hi / tot
            e["eng.bass_share"] = lo / tot
    cen = f.get("lowlevel.spectral_centroid.mean")
    rol = f.get("lowlevel.spectral_rolloff.mean")
    if cen and rol:
        e["eng.rolloff_minus_centroid"] = rol - cen
    return e


# Worker-global extractor (built once per process).
_ME = None


def _get_me():
    global _ME
    if _ME is None:
        import essentia
        essentia.log.infoActive = False
        essentia.log.warningActive = False
        from essentia.standard import MusicExtractor
        # Same frame/hop as the production analyzer (worker.py:553); add 'stdev'
        # so we capture per-feature variance, not just the mean.
        _ME = MusicExtractor(
            lowlevelFrameSize=2048, lowlevelHopSize=1024,
            rhythmStats=["mean"], tonalStats=["mean"], lowlevelStats=["mean", "stdev"],
        )
    return _ME


def _extract_one(row: dict) -> dict:
    path = row["wsl_path"]
    t0 = time.time()
    try:
        me = _get_me()
        pool, _ = me(path)
        feats = _flatten(pool)
        feats.update(_engineered(feats))
        feats["track_id"] = row["track_id"]
        feats["label"] = float(row["label"])
        feats["label_name"] = row["label_name"]
        feats["primary_artist"] = row["primary_artist"]
        feats["key_camelot"] = row["key_camelot"]
        feats["cur_brightness"] = float(row["cur_brightness"]) if row["cur_brightness"] else None
        feats["_ok"] = True
        feats["_secs"] = round(time.time() - t0, 2)
        return feats
    except Exception as exc:  # noqa: BLE001
        return {"track_id": row["track_id"], "_ok": False, "_err": f"{type(exc).__name__}: {exc}"}


def _stratified(rows: list[dict], n: int) -> list[dict]:
    by = defaultdict(list)
    for r in rows:
        by[r["label"]].append(r)
    per = max(1, n // max(1, len(by)))
    out = []
    for lab, items in by.items():
        out.extend(items[:per])
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=0)
    ap.add_argument("--workers", type=int, default=max(1, cpu_count() - 2))
    args = ap.parse_args()

    with open(DATASET, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if args.sample:
        rows = _stratified(rows, args.sample)

    done: set[str] = set()
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            for line in f:
                try:
                    done.add(json.loads(line)["track_id"])
                except Exception:
                    pass
    todo = [r for r in rows if r["track_id"] not in done]
    print(f"dataset={len(rows)} already_done={len(done)} todo={len(todo)} workers={args.workers}", flush=True)
    if not todo:
        print("nothing to do")
        return 0

    n_ok = n_err = 0
    t_start = time.time()
    with open(OUT, "a", encoding="utf-8") as out, Pool(args.workers) as pool:
        for i, feats in enumerate(pool.imap_unordered(_extract_one, todo, chunksize=1), 1):
            out.write(json.dumps(feats, ensure_ascii=False) + "\n")
            out.flush()
            if feats.get("_ok"):
                n_ok += 1
            else:
                n_err += 1
                print(f"  ERR {feats['track_id']}: {feats.get('_err')}", flush=True)
            if i % 50 == 0 or i == len(todo):
                rate = i / (time.time() - t_start)
                eta = (len(todo) - i) / rate if rate else 0
                print(f"  {i}/{len(todo)} ok={n_ok} err={n_err} {rate:.1f}/s eta={eta/60:.1f}m", flush=True)
    print(f"done: ok={n_ok} err={n_err} -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
