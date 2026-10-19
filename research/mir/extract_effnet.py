#!/usr/bin/env python3
"""Phase 0 baseline — Discogs-EffNet (the June brightness-spike embedding) on the
same bake-off sample, so FINDINGS can say how far the 2026 models move past it.

Runs under WSL in apps/analyzer/.venv-wsl-tf (essentia-tensorflow), same model
file and pooling as research/brightness/extract_embeddings.py: 16 kHz mono,
PartitionedCall:1 (1280-d), mean over patches. Resumable; reads audio only.
"""
from __future__ import annotations

import csv, os, time

import numpy as np

OUT = os.environ.get("MIR_OUT", "/mnt/c/tmp/mir")
MODEL = os.environ.get("EFFNET_MODEL", "/mnt/c/tmp/models/discogs-effnet-bs64-1.pb")


def wsl(p: str) -> str:
    p = p.replace(chr(92), "/")
    return f"/mnt/{p[0].lower()}{p[2:]}" if len(p) > 1 and p[1] == ":" else p


def main() -> int:
    import essentia
    essentia.log.infoActive = False
    essentia.log.warningActive = False
    from essentia.standard import MonoLoader, TensorflowPredictEffnetDiscogs
    model = TensorflowPredictEffnetDiscogs(graphFilename=MODEL, output="PartitionedCall:1")
    rows = list(csv.DictReader(open(os.path.join(OUT, "dataset.csv"), encoding="utf-8")))
    out = os.path.join(OUT, "vec_effnet.npz")
    ids, vecs = ([], [])
    if os.path.exists(out):
        z = np.load(out)
        ids, vecs = list(z["ids"]), list(z["vecs"])
    done = set(ids)
    todo = [r for r in rows if r["track_id"] not in done]
    print(f"done={len(done)} todo={len(todo)}", flush=True)
    t0 = time.time()
    for i, r in enumerate(todo, 1):
        try:
            audio = MonoLoader(filename=wsl(r["path"]), sampleRate=16000, resampleQuality=4)()
            ids.append(r["track_id"])
            vecs.append(np.asarray(model(audio), dtype=np.float32).mean(axis=0))
        except Exception as exc:  # noqa: BLE001
            print(f"  ERR {r['track_id']}: {type(exc).__name__}: {exc}", flush=True)
        if i % 50 == 0 or i == len(todo):
            np.savez(out + ".tmp.npz", ids=np.array(ids), vecs=np.array(vecs, dtype=np.float32))
            os.replace(out + ".tmp.npz", out)
            print(f"  {i}/{len(todo)} {(time.time() - t0) / i:.1f}s/track", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
