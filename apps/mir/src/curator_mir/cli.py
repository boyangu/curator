"""Command line for using the engine outside Curator (batch runs, other apps).

  curator-mir capabilities
  curator-mir embed a.flac b.mp3 --model mert-v2-fullsong --out vectors.npz
  curator-mir text "rolling acid bassline" --model muq-mulan-large
  curator-mir serve            # the stdio JSON-RPC sidecar (same as python -m curator_mir.main)
"""

from __future__ import annotations

import argparse
import json
import sys

from .registry import DEFAULT_MODEL, MODELS


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="curator-mir")
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "xpu", "cuda"])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("capabilities")
    e = sub.add_parser("embed", help="embed audio files")
    e.add_argument("files", nargs="+")
    e.add_argument("--model", action="append", choices=sorted(MODELS))
    e.add_argument("--out", help="write ids/paths + one vector array per model to this .npz")
    t = sub.add_parser("text", help="embed text prompts (text-capable models only)")
    t.add_argument("texts", nargs="+")
    t.add_argument("--model", default="muq-mulan-large", choices=sorted(k for k, s in MODELS.items() if s.text))
    sub.add_parser("serve", help="run the stdio JSON-RPC sidecar")
    args = ap.parse_args(argv)

    if args.cmd == "serve":
        from .main import main as serve
        serve()
        return 0

    import numpy as np

    from .engine import Engine
    from .pooling import from_b64

    eng = Engine(device=args.device)
    if args.cmd == "capabilities":
        print(json.dumps(eng.capabilities(), indent=2))
        return 0
    if args.cmd == "text":
        res = eng.text_embed(args.model, args.texts)
        for text, vec in zip(args.texts, res["vecs"]):
            v = from_b64(vec)
            print(f"{res['modelId']}  dim={v.shape[0]}  {text!r}")
        return 0

    models = args.model or [DEFAULT_MODEL]
    out: dict[str, list] = {m: [] for m in models}
    ok_files = []
    for path in args.files:
        try:
            res = eng.analyze(path, models)
        except Exception as exc:  # noqa: BLE001 — report and continue with the next file
            print(f"ERR {path}: {type(exc).__name__}: {exc}", file=sys.stderr)
            continue
        ok_files.append(path)
        for emb in res["embeddings"].values():
            out[emb["model"]].append(from_b64(emb["vec"]))
        timing = ", ".join(f"{e['model']} {e['ms']} ms" for e in res["embeddings"].values())
        print(f"{path}: {res['duration']:.0f} s audio; {timing}")
    if args.out and ok_files:
        np.savez(args.out, files=np.array(ok_files),
                 **{m.replace("-", "_"): np.stack(v) for m, v in out.items() if v})
        print(f"wrote {args.out}")
    return 0 if ok_files else 1
