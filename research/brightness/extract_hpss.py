#!/usr/bin/env python3
"""Compute a 'hammering vs sustained' number — the HPSS percussive energy ratio —
to sharpen H2 (darker = percussive/transient, brighter = continuous/airy).

Median-filter HPSS (Fitzgerald 2010): on the magnitude spectrogram, median-filter along
TIME -> harmonic component (sustained tones smear horizontally), along FREQUENCY ->
percussive component (transients smear vertically). Soft-mask and report the percussive
fraction of energy. High = hammering; low = airy/continuous.

Runs in .venv-wsl (essentia for robust decode + numpy/scipy). Writes
c:\\tmp\\hpss.jsonl {track_id, label, primary_artist, perc_ratio}.
"""
from __future__ import annotations
import argparse, csv, json, os
from collections import defaultdict
from multiprocessing import Pool, cpu_count

DATASET = os.environ.get("BRIGHTNESS_DATASET", "/mnt/c/tmp/brightness_dataset.csv")
OUT = os.environ.get("HPSS_OUT", "/mnt/c/tmp/hpss.jsonl")
SR = 44100
NPERSEG, HOP = 2048, 1024
KERNEL = 17     # median-filter span (frames for harmonic, bins for percussive)

_loader = None


def _load_audio(path):
    global _loader
    import essentia
    essentia.log.infoActive = False
    essentia.log.warningActive = False
    from essentia.standard import MonoLoader
    return MonoLoader(filename=path, sampleRate=SR)()


def _one(row: dict) -> dict:
    import numpy as np
    from scipy.signal import stft
    from scipy.ndimage import median_filter
    try:
        audio = _load_audio(row["wsl_path"])
        if audio.size < NPERSEG * 4:
            return {"track_id": row["track_id"], "_ok": False, "_err": "too short"}
        _, _, Z = stft(audio, fs=SR, nperseg=NPERSEG, noverlap=NPERSEG - HOP, boundary=None)
        S = np.abs(Z).astype(np.float32)              # (freq, time)
        H = median_filter(S, size=(1, KERNEL))        # smear along time -> harmonic
        P = median_filter(S, size=(KERNEL, 1))        # smear along freq -> percussive
        H2 = H * H; P2 = P * P
        denom = H2 + P2 + 1e-9
        Mp = P2 / denom                               # soft percussive mask
        S2 = S * S
        perc_ratio = float((Mp * S2).sum() / (S2.sum() + 1e-9))
        return {"track_id": row["track_id"], "label": float(row["label"]),
                "primary_artist": row["primary_artist"], "perc_ratio": perc_ratio, "_ok": True}
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
        with open(OUT, encoding="utf-8") as f:
            for line in f:
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
