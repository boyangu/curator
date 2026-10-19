#!/usr/bin/env python3
"""Test the low-end-contamination hypothesis CHEAPLY (before any HTDemucs work).

Hypothesis (from the stem-separation proposal): kick/sub-bass muddies pitch detection,
so harmonic features computed on a cleaned low-end predict the user's brightness better.
The free test: recompute HPCP (chroma) two ways on a stratified sample and compare —
  full-band   : spectral peaks from ~40 Hz up (what MusicExtractor effectively uses)
  band-limited: same peaks but masked below 200 Hz (kick/sub fundamentals excluded)
Only the LOW cutoff differs, so any change is attributable to low-end contamination.

Runs in .venv-wsl (essentia). Writes c:\\tmp\\hpcp_ab.jsonl with both 36-bin HPCP means
per track; analyze_hpcp_ab.py (research venv) compares predictive power.
"""
from __future__ import annotations
import argparse, csv, json, os
from collections import defaultdict
from multiprocessing import Pool, cpu_count

DATASET = os.environ.get("BRIGHTNESS_DATASET", "/mnt/c/tmp/brightness_dataset.csv")
OUT = os.environ.get("HPCP_AB", "/mnt/c/tmp/hpcp_ab.jsonl")
SR = 44100
FRAME, HOP = 4096, 2048
HPF_HZ = 200.0          # band-limited low cutoff
FULL_HZ = 40.0          # full-band low cutoff
MAXF = 5000.0

_chain = None


def _get_chain():
    global _chain
    if _chain is None:
        import essentia
        essentia.log.infoActive = False
        essentia.log.warningActive = False
        from essentia.standard import MonoLoader, Windowing, Spectrum, SpectralPeaks, HPCP
        _chain = {
            "Loader": MonoLoader,
            "w": Windowing(type="blackmanharris62"),
            "spec": Spectrum(),
            "peaks": SpectralPeaks(sampleRate=SR, minFrequency=FULL_HZ, maxFrequency=MAXF,
                                   magnitudeThreshold=1e-5, orderBy="magnitude"),
            "hpcp": HPCP(size=36, sampleRate=SR, minFrequency=FULL_HZ, maxFrequency=MAXF,
                         referenceFrequency=440.0),
        }
    return _chain


def _one(row: dict) -> dict:
    import numpy as np
    from essentia.standard import FrameGenerator
    try:
        c = _get_chain()
        audio = c["Loader"](filename=row["wsl_path"], sampleRate=SR)()
        full = np.zeros(36); hpf = np.zeros(36); nf = 0
        for frame in FrameGenerator(audio, frameSize=FRAME, hopSize=HOP, startFromZero=True):
            mag = c["spec"](c["w"](frame))
            freqs, mags = c["peaks"](mag)
            if len(freqs) == 0:
                continue
            full += c["hpcp"](freqs, mags)
            # band-limited: drop peaks below HPF_HZ
            keep = freqs >= HPF_HZ
            if keep.any():
                hpf += c["hpcp"](freqs[keep], mags[keep])
            nf += 1
        if nf == 0:
            return {"track_id": row["track_id"], "_ok": False, "_err": "no frames"}
        full /= nf; hpf /= nf
        out = {"track_id": row["track_id"], "label": float(row["label"]),
               "primary_artist": row["primary_artist"], "_ok": True}
        for i in range(36):
            out[f"full.{i}"] = float(full[i])
            out[f"hpf.{i}"] = float(hpf[i])
        return out
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
