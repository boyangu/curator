#!/usr/bin/env python3
"""Test: does trimming intro/outro before feature extraction align features with the
curator's label better? Re-extracts the 187 features over the track's CENTRAL window only
(skip up to 30s or 15% per end — typical DJ intro/outro), via MusicExtractor startTime/
endTime. Compare vs full-track on the SAME tracks (analyze_core_ab.py).

Runs in .venv-wsl. Writes c:\\tmp\\core_features.jsonl. Stratified sample by default.
"""
from __future__ import annotations
import argparse, csv, json, os, time
from collections import defaultdict
from multiprocessing import Pool, cpu_count

from extract_features import _flatten, _engineered  # reuse identical flattening

DATASET = os.environ.get("BRIGHTNESS_DATASET", "/mnt/c/tmp/brightness_dataset.csv")
OUT = os.environ.get("CORE_FEATURES", "/mnt/c/tmp/core_features.jsonl")
SR = 44100
MAX_TRIM = 30.0      # seconds to drop per end (cap)
FRAC_TRIM = 0.15     # or this fraction of duration, whichever is smaller
MIN_DUR_TO_TRIM = 90.0  # don't trim very short tracks


def _duration(path) -> float:
    from essentia.standard import MetadataReader
    try:
        meta = MetadataReader(filename=path)()
        # MetadataReader returns (...; duration is field index 8)
        dur = float(meta[8])
        return dur if dur > 0 else 0.0
    except Exception:
        return 0.0


def _one(row: dict) -> dict:
    import essentia
    essentia.log.infoActive = False
    essentia.log.warningActive = False
    from essentia.standard import MusicExtractor
    path = row["wsl_path"]
    t0 = time.time()
    try:
        dur = _duration(path)
        if dur >= MIN_DUR_TO_TRIM:
            trim = min(MAX_TRIM, FRAC_TRIM * dur)
            start, end = trim, dur - trim
        else:
            start, end = 0.0, 0.0  # 0/0 -> MusicExtractor analyzes whole file
        me = MusicExtractor(startTime=start, endTime=end if end > 0 else 1e6,
                            lowlevelFrameSize=2048, lowlevelHopSize=1024,
                            rhythmStats=["mean"], tonalStats=["mean"], lowlevelStats=["mean", "stdev"])
        pool, _ = me(path)
        feats = _flatten(pool)
        feats.update(_engineered(feats))
        feats.update({"track_id": row["track_id"], "label": float(row["label"]),
                      "label_name": row["label_name"], "primary_artist": row["primary_artist"],
                      "key_camelot": row["key_camelot"], "cur_brightness": None,
                      "_ok": True, "_secs": round(time.time() - t0, 2),
                      "_trimmed": dur >= MIN_DUR_TO_TRIM, "_dur": round(dur, 1)})
        return feats
    except Exception as exc:  # noqa: BLE001
        return {"track_id": row["track_id"], "_ok": False, "_err": f"{type(exc).__name__}: {exc}"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=600)
    ap.add_argument("--workers", type=int, default=max(1, cpu_count() - 2))
    args = ap.parse_args()
    with open(DATASET, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if args.sample:
        by = defaultdict(list)
        for r in rows:
            by[r["label"]].append(r)
        per = max(1, args.sample // len(by))
        rows = [r for items in by.values() for r in items[:per]]
    done = set()
    if os.path.exists(OUT):
        for line in open(OUT, encoding="utf-8"):
            try:
                done.add(json.loads(line)["track_id"])
            except Exception:
                pass
    todo = [r for r in rows if r["track_id"] not in done]
    print(f"sample={len(rows)} todo={len(todo)} workers={args.workers}", flush=True)
    ok = err = 0
    with open(OUT, "a", encoding="utf-8") as out, Pool(args.workers) as pool:
        for i, r in enumerate(pool.imap_unordered(_one, todo, chunksize=1), 1):
            out.write(json.dumps(r, ensure_ascii=False) + "\n"); out.flush()
            ok += int(r.get("_ok", False)); err += int(not r.get("_ok", False))
            if i % 100 == 0 or i == len(todo):
                print(f"  {i}/{len(todo)} ok={ok} err={err}", flush=True)
    print(f"done ok={ok} err={err} -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
