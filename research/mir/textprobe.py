#!/usr/bin/env python3
"""Phase 0 — zero-shot naming check (research question 3): do plain-words prompts,
embedded by a text-capable model, retrieve the tracks the user tagged that way?

For each (prompt, user tag) pair: rank the sample by cosine(text, track) and
report precision@50 and its lift over the tag's base rate. Runs the production
engine's text tower (CPU is fine — text is tiny).
"""
from __future__ import annotations

import json, os, sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "apps", "mir", "src"))
from curator_mir.engine import Engine  # noqa: E402
from curator_mir.pooling import from_b64  # noqa: E402

OUT = os.environ.get("MIR_OUT", r"C:\tmp\mir")
PROBES = [  # prompt -> the user's own tag it should retrieve
    ("electronic music with prominent vocals and singing", "vocal"),
    ("piano melody, piano chords", "piano+"),
    ("dark hypnotic repetitive techno", "hypnotic"),
    ("driving energetic techno", "techno"),
    ("melodic emotional synth music", "melodic"),
    ("dreamy ethereal ambient pads", "dreamy"),
    ("groovy house music", "house"),
    ("warm soft mellow electronic", "warm"),
    ("uplifting euphoric anthem", "uplift"),
    ("funky groove with bass guitar", "funky"),
    ("minimal techno", "minimal"),
    ("broken beat, glitchy synth", "broken synth"),
]


def main() -> int:
    model = sys.argv[1] if len(sys.argv) > 1 else "muq-mulan-large"
    z = np.load(os.path.join(OUT, f"vec_{model}.npz"))
    ids = list(z["ids"])
    X = z["vecs"].astype(np.float64)
    X /= np.linalg.norm(X, axis=1, keepdims=True)
    labels = json.load(open(os.path.join(OUT, "labels.json"), encoding="utf-8"))
    tags = {t: set(v) for t, v in labels["tags"].items()}
    eng = Engine(device="cpu")
    res = eng.text_embed(model, [p for p, _ in PROBES])
    print(f"model {model}, {len(ids)} tracks; precision@50 per prompt (lift = P / base rate)")
    lifts = []
    for (prompt, tag), b in zip(PROBES, res["vecs"]):
        t = from_b64(b).astype(np.float64)
        t /= np.linalg.norm(t)
        order = np.argsort(-(X @ t))[:50]
        has = np.array([tag in tags.get(i, ()) for i in ids])
        if has.sum() < 10:
            continue
        p = has[order].mean()
        lift = p / has.mean()
        lifts.append(lift)
        print(f"  {tag:>14}  base {has.mean():.3f}  P@50 {p:.2f}  lift {lift:.2f}   <- {prompt!r}")
    print(f"  mean lift {np.mean(lifts):.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
