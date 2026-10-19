#!/usr/bin/env python3
"""Extract Discogs-EffNet embeddings (music-neighborhood vectors) per track.

Two payoffs from one pass (the v2 gate):
  1. recommendation engine — cosine similarity over these vectors → "similar tracks",
  2. a candidate feature to test whether embeddings lift brightness past the 0.667 ceiling.

EffNet wants 16 kHz mono; the embedding is the mean over the model's patch outputs
(1280-dim). Runs in .venv-wsl-tf (essentia-tensorflow). Writes c:\\tmp\\embeddings.npz
(track_id[], emb[N,1280]) + a parallel csv of ids for joins.

Usage: .venv-wsl-tf/bin/python extract_embeddings.py [--sample N] [--all]
"""
from __future__ import annotations
import argparse, csv, json, os, sys
from collections import defaultdict
import numpy as np

DATASET = os.environ.get("BRIGHTNESS_DATASET", "/mnt/c/tmp/brightness_dataset.csv")
MODEL = os.environ.get("EFFNET_MODEL", "/mnt/c/tmp/models/discogs-effnet-bs64-1.pb")
OUT = os.environ.get("EMBEDDINGS_OUT", "/mnt/c/tmp/embeddings.npz")
SR = 16000


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=800)
    args = ap.parse_args()

    import essentia
    essentia.log.infoActive = False
    essentia.log.warningActive = False
    from essentia.standard import MonoLoader, TensorflowPredictEffnetDiscogs
    # output="PartitionedCall:1" = the 1280-d embedding layer (":0" = genre logits).
    model = TensorflowPredictEffnetDiscogs(graphFilename=MODEL, output="PartitionedCall:1")

    with open(DATASET, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if args.sample:
        by = defaultdict(list)
        for r in rows:
            by[r["label"]].append(r)
        per = max(1, args.sample // len(by))
        rows = [r for items in by.values() for r in items[:per]]

    # resume
    done_ids, done_vecs = [], []
    if os.path.exists(OUT):
        z = np.load(OUT, allow_pickle=True)
        done_ids = list(z["track_id"]); done_vecs = list(z["emb"])
    done = set(done_ids)
    todo = [r for r in rows if r["track_id"] not in done]
    print(f"sample={len(rows)} done={len(done)} todo={len(todo)}", flush=True)

    ids, vecs = done_ids, done_vecs
    n_ok = n_err = 0
    for i, r in enumerate(todo, 1):
        path = r["wsl_path"]
        try:
            if not os.path.exists(path):
                n_err += 1; continue
            audio = MonoLoader(filename=path, sampleRate=SR, resampleQuality=4)()
            emb = model(audio)                       # (patches, 1280)
            vec = np.asarray(emb, dtype=np.float32).mean(axis=0)
            ids.append(r["track_id"]); vecs.append(vec); n_ok += 1
        except Exception as exc:  # noqa: BLE001
            n_err += 1
            print(f"  ERR {r['track_id']}: {type(exc).__name__}: {exc}", flush=True)
        if i % 50 == 0 or i == len(todo):
            np.savez(OUT, track_id=np.array(ids), emb=np.array(vecs, dtype=np.float32))
            print(f"  {i}/{len(todo)} ok={n_ok} err={n_err}", flush=True)
    np.savez(OUT, track_id=np.array(ids), emb=np.array(vecs, dtype=np.float32))
    print(f"done ok={n_ok} err={n_err} total={len(ids)} -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
