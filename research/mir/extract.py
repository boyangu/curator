#!/usr/bin/env python3
"""Phase 0 — embed the bake-off sample with the PRODUCTION engine (apps/mir).

Research runs through curator_mir itself, not a parallel implementation, so the
numbers in FINDINGS.md describe exactly the vectors the app will store (the
brightness spike's lesson: train/serve parity or the results don't transfer).

Resumable: per-model npz checkpoints in c:/tmp/mir (vec_<model>.npz with ids +
vecs) and one timings.jsonl line per track. Reads audio only.

Run with the apps/mir env, e.g.:
  ../../apps/mir/.venv-xpu/Scripts/python.exe extract.py --device xpu
"""
from __future__ import annotations

import argparse, csv, json, os, sys, time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "apps", "mir", "src"))
from curator_mir.engine import Engine  # noqa: E402
from curator_mir.pooling import from_b64  # noqa: E402

OUT = os.environ.get("MIR_OUT", r"C:\tmp\mir")
ALL = ["mert-v2-fullsong", "muq-mulan-large", "clap"]


def load(model: str):
    p = os.path.join(OUT, f"vec_{model}.npz")
    if not os.path.exists(p):
        return [], []
    z = np.load(p)
    return list(z["ids"]), list(z["vecs"])


def save(model: str, ids, vecs) -> None:
    tmp = os.path.join(OUT, f"vec_{model}.tmp.npz")
    np.savez(tmp, ids=np.array(ids), vecs=np.array(vecs, dtype=np.float32))
    os.replace(tmp, os.path.join(OUT, f"vec_{model}.npz"))


def free_ram_gb() -> float:
    """Available physical memory (Windows). Models live in shared iGPU memory
    too, so the guard below keeps a long research run from swapping the
    user's machine while they work."""
    import ctypes

    class MS(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong),
                    ("avail", ctypes.c_ulonglong), ("tp", ctypes.c_ulonglong), ("ap", ctypes.c_ulonglong),
                    ("tv", ctypes.c_ulonglong), ("av", ctypes.c_ulonglong), ("ext", ctypes.c_ulonglong)]
    ms = MS()
    ms.len = ctypes.sizeof(MS)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
    return ms.avail / 2**30


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=",".join(ALL))
    ap.add_argument("--device", default="auto")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--min-free-gb", type=float, default=3.0)
    args = ap.parse_args()
    rows = list(csv.DictReader(open(os.path.join(OUT, "dataset.csv"), encoding="utf-8")))
    log = open(os.path.join(OUT, "timings.jsonl"), "a", encoding="utf-8")
    # One model per pass (max_loaded=1): three resident models took 12 GB plus
    # shared iGPU memory and pushed the machine to 0.3 GB free.
    for model in args.models.split(","):
        ids, vecs = load(model)
        done = set(ids)
        todo = [r for r in rows if r["track_id"] not in done][: args.limit or None]
        eng = Engine(device=args.device, max_loaded=1)
        print(f"[{model}] device={eng.device} done={len(done)} todo={len(todo)}", flush=True)
        t_start, ok, err = time.time(), 0, 0
        for i, r in enumerate(todo, 1):
            while free_ram_gb() < args.min_free_gb:
                print(f"  low memory ({free_ram_gb():.1f} GB free), pausing 30 s", flush=True)
                time.sleep(30)
            tid = r["track_id"]
            try:
                res = eng.analyze(r["path"], [model])
                e = next(iter(res["embeddings"].values()))
                ids.append(tid)
                vecs.append(from_b64(e["vec"]))
                log.write(json.dumps({"track_id": tid, "model": model, "duration": res["duration"],
                                      "decodeMs": res["decodeMs"], "ms": e["ms"]}) + "\n")
                ok += 1
            except Exception as exc:  # noqa: BLE001 — record and keep going
                log.write(json.dumps({"track_id": tid, "model": model, "error": f"{type(exc).__name__}: {exc}"}) + "\n")
                err += 1
            if i % 25 == 0 or i == len(todo):
                save(model, ids, vecs)
                log.flush()
                rate = (time.time() - t_start) / i
                print(f"  [{model}] {i}/{len(todo)} ok={ok} err={err} {rate:.1f}s/track "
                      f"eta {rate * (len(todo) - i) / 60:.0f} min, free {free_ram_gb():.1f} GB", flush=True)
        del eng
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
