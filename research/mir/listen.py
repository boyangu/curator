#!/usr/bin/env python3
"""Phase 0 — ears check. For 10 deterministic seeds (one per common genre, all
user-tagged), list the top-8 neighbours under each model so the user can judge
"does this sound alike?" by listening. Writes c:/tmp/mir/listen.md.
"""
from __future__ import annotations

import csv, json, os

import numpy as np

OUT = os.environ.get("MIR_OUT", r"C:\tmp\mir")
MODELS = ["mert-v2-fullsong", "muq-mulan-large", "clap", "effnet"]


def main() -> int:
    rows = {r["track_id"]: r for r in csv.DictReader(open(os.path.join(OUT, "dataset.csv"), encoding="utf-8"))}
    tags = json.load(open(os.path.join(OUT, "labels.json"), encoding="utf-8"))["tags"]
    mats = {}
    for m in MODELS:
        p = os.path.join(OUT, f"vec_{m}.npz")
        if os.path.exists(p):
            z = np.load(p)
            X = z["vecs"].astype(np.float64)
            X -= X.mean(0)
            X /= np.linalg.norm(X, axis=1, keepdims=True)
            mats[m] = (list(z["ids"]), X)
    common = sorted(set.intersection(*[set(ids) for ids, _ in mats.values()]))
    by_genre: dict[str, str] = {}
    for tid in common:
        g = rows[tid]["genre"]
        if g and tid in tags and len(tags[tid]) >= 3 and g not in by_genre:
            by_genre[g] = tid
    seeds = list(by_genre.values())[:10]
    fmt = lambda t: f"{rows[t]['artists']} — {rows[t]['title']} · {rows[t]['genre'] or '?'} · {rows[t]['bpm'] or '?'} BPM · {', '.join(tags.get(t, [])[:5])}"
    out = ["# Listening sheet — nearest neighbours per model (mean-centred cosine)", ""]
    for s in seeds:
        out += [f"## {fmt(s)}", ""]
        for m, (ids, X) in mats.items():
            ix = {t: i for i, t in enumerate(ids)}
            sims = X @ X[ix[s]]
            order = [ids[j] for j in np.argsort(-sims) if ids[j] != s and ids[j] in rows][:8]
            out += [f"**{m}**", ""] + [f"{k + 1}. {fmt(t)}" for k, t in enumerate(order)] + [""]
    open(os.path.join(OUT, "listen.md"), "w", encoding="utf-8").write("\n".join(out))
    print(f"wrote {os.path.join(OUT, 'listen.md')} ({len(seeds)} seeds, models: {list(mats)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
