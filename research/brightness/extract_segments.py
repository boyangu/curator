#!/usr/bin/env python3
"""Extract MusicExtractor features for each track's BREAKDOWN and DROP windows
(from segments_windows.csv), to test whether section timbre drives brightness.

Runs in .venv-wsl. Features prefixed 'brk.' (breakdown) and 'drp.' (drop). Writes
c:\\tmp\\segment_features.jsonl. Stratified sample on the brightness label by default.
"""
from __future__ import annotations
import argparse, csv, json, os, time
from collections import defaultdict
from multiprocessing import Pool, cpu_count

from extract_features import _flatten, _engineered

DATASET = os.environ.get("SEGMENTS_CSV", "/mnt/c/tmp/segments_windows.csv")
OUT = os.environ.get("SEGMENT_FEATURES", "/mnt/c/tmp/segment_features.jsonl")
MIN_WIN = 5.0  # skip windows shorter than this (MusicExtractor unreliable)


def _seg(path, start, end):
    if start == "" or end == "":
        return None
    a, b = float(start), float(end)
    if b - a < MIN_WIN:
        return None
    import essentia
    essentia.log.infoActive = False
    essentia.log.warningActive = False
    from essentia.standard import MusicExtractor
    me = MusicExtractor(startTime=a, endTime=b, lowlevelFrameSize=2048, lowlevelHopSize=1024,
                        rhythmStats=["mean"], tonalStats=["mean"], lowlevelStats=["mean", "stdev"])
    pool, _ = me(path)
    f = _flatten(pool)
    f.update(_engineered(f))
    return f


def _one(row: dict) -> dict:
    t0 = time.time()
    out = {"track_id": row["track_id"], "primary_artist": row["primary_artist"],
           "bright": row["bright"], "power": row["power"],
           "break_label": row["break_label"], "drop_label": row["drop_label"]}
    try:
        bf = _seg(row["wsl_path"], row["break_start"], row["break_end"])
        df = _seg(row["wsl_path"], row["drop_start"], row["drop_end"])
        for k, v in (bf or {}).items():
            out[f"brk.{k}"] = v
        for k, v in (df or {}).items():
            out[f"drp.{k}"] = v
        out["_has_break"] = bf is not None
        out["_has_drop"] = df is not None
        out["_ok"] = True
        out["_secs"] = round(time.time() - t0, 2)
        return out
    except Exception as exc:  # noqa: BLE001
        return {"track_id": row["track_id"], "_ok": False, "_err": f"{type(exc).__name__}: {exc}"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=700)
    ap.add_argument("--workers", type=int, default=max(1, cpu_count() - 2))
    args = ap.parse_args()
    with open(DATASET, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    rows = [r for r in rows if r["bright"]]  # need a brightness label for the test
    if args.sample:
        by = defaultdict(list)
        for r in rows:
            by[r["bright"]].append(r)
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
