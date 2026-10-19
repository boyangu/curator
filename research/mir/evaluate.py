#!/usr/bin/env python3
"""Phase 0 — score each embedding as a "sounds like" retriever against labels the
user curated themselves (all read from c:/tmp/mir, produced by export_dataset.py).

For every model, cosine kNN over the 1,200-track pool (each track is a seed;
the other 1,199 are candidates), scored against:
  playlists  mAP of the seed's rekordbox co-members (lift = mAP / random)
  tags       per-tag P@10 over the user's own tags, macro-averaged (lift vs base rate)
  sets       rank of the next track actually played in a DJ set (MRR, R@50, median rank)
  prep       same for consecutive plays in prep sessions (weaker signal)
  genre/label/artist   P@10 same value (sanity: the model hears scenes)
  bright/power         mean |delta| of top-10 vs random pairs (lower = closer)
Variants: raw cosine and mean-centred cosine (removes the shared direction that
foundation-model embeddings carry, often a free retrieval win).
Baselines: random, metadata one-hot (genre+label+artists), scalars (bpm, brightness, power).
"""
from __future__ import annotations

import csv, json, os, sys
from collections import defaultdict

import numpy as np

OUT = os.environ.get("MIR_OUT", r"C:\tmp\mir")
K = 10
RNG = np.random.default_rng(0)
MODEL_FILES = {"mert-v2-fullsong": "vec_mert-v2-fullsong.npz", "muq-mulan-large": "vec_muq-mulan-large.npz",
               "clap": "vec_clap.npz", "effnet-discogs": "vec_effnet.npz"}
BUCKET_TAGS = {"b1", "b0", "d1", "d2", "p0", "p1", "p2", "p3", "p4", "p5", "!"}


def l2n(x):
    return x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-12)


def sims_from_vectors(X, centred):
    X = X.astype(np.float64)
    if centred:
        X = X - X.mean(axis=0, keepdims=True)
    X = l2n(X)
    S = X @ X.T
    np.fill_diagonal(S, -np.inf)
    return S


def ranks_of(S):
    """order[i] = candidate indices sorted best-first; pos[i, j] = rank of j for seed i (0 = best)."""
    order = np.argsort(-S, axis=1)
    pos = np.empty_like(order)
    rows = np.arange(S.shape[0])[:, None]
    pos[rows, order] = np.arange(S.shape[1])[None, :]
    return order, pos


def average_precision(pos_row, rel):
    p = np.sort(pos_row[rel])
    return float(np.mean(np.arange(1, len(p) + 1) / (p + 1))) if len(p) else np.nan


def score(S, ctx):
    order, pos = ranks_of(S)
    top = order[:, :K]
    out = {}
    aps = [average_precision(pos[i], np.array([j for j in m if j != i]))
           for m in ctx["playlists"] for i in m]
    out["playlist_mAP"] = float(np.nanmean(aps))
    tag_lifts, per_tag = [], {}
    for tag, members in ctx["tags"].items():
        mem = np.zeros(len(S), bool)
        mem[members] = True
        p10 = float(np.mean([mem[top[i]].mean() for i in members]))
        lift = p10 / ((len(members) - 1) / (len(S) - 1))
        per_tag[tag] = lift
        if tag not in BUCKET_TAGS:
            tag_lifts.append(lift)
    out["tag_lift"] = float(np.mean(tag_lifts))
    out["per_tag"] = per_tag
    for name in ("set", "prep"):
        r = np.array([pos[a, b] for a, b in ctx[f"{name}_pairs"]], dtype=float)
        out[f"{name}_MRR"] = float(np.mean(1 / (r + 1)))
        out[f"{name}_R@50"] = float(np.mean(r < 50))
        out[f"{name}_median_rank"] = float(np.median(r))
    for field in ("genre", "label"):
        vals = ctx[field]
        idx = [i for i in range(len(S)) if vals[i]]
        out[f"{field}_P@10"] = float(np.mean([np.mean([vals[j] == vals[i] for j in top[i]]) for i in idx]))
    arts = ctx["artists"]
    out["artist_P@10"] = float(np.mean([np.mean([bool(arts[i] & arts[j]) for j in top[i]])
                                        for i in range(len(S)) if arts[i]]))
    for field in ("brightness", "power", "bpm"):
        v = ctx[field]
        ok = ~np.isnan(v)
        d = np.abs(v[top] - v[:, None])
        out[f"{field}_dK"] = float(np.nanmean(d[ok]))
    return out


def load_ctx():
    rows = list(csv.DictReader(open(os.path.join(OUT, "dataset.csv"), encoding="utf-8")))
    labels = json.load(open(os.path.join(OUT, "labels.json"), encoding="utf-8"))
    return rows, labels


def build_ctx(ids, rows, labels):
    ix = {t: i for i, t in enumerate(ids)}
    by = {r["track_id"]: r for r in rows}
    f = lambda k: np.array([float(by[t][k]) if by[t][k] not in ("", None) else np.nan for t in ids])
    tag_members = defaultdict(list)
    for t, names in labels["tags"].items():
        if t in ix:
            for n in names:
                tag_members[n].append(ix[t])
    return {
        "playlists": [[ix[t] for t in p["members"] if t in ix] for p in labels["playlists"].values()],
        "tags": {k: v for k, v in tag_members.items() if len(v) >= 20},
        "set_pairs": [(ix[a], ix[b]) for a, b in labels["set_pairs"] if a in ix and b in ix],
        "prep_pairs": [(ix[a], ix[b]) for a, b in labels["prep_pairs"] if a in ix and b in ix],
        "genre": [by[t]["genre"].strip().lower() for t in ids],
        "label": [by[t]["label"].strip().lower() for t in ids],
        "artists": [set(labels["artists"].get(t, [])) for t in ids],
        # Some tracks still carry pre-2.3 'brightness' (raw spectral centroid,
        # hundreds) instead of the 0-3 learned score: treat as missing.
        "brightness": np.where(f("brightness") > 3.5, np.nan, f("brightness")),
        "power": np.where(f("power") > 5.5, np.nan, f("power")), "bpm": f("bpm"),
    }


def metadata_sims(ids, ctx):
    cols = {}
    feats = []
    for i in range(len(ids)):
        keys = [f"g:{ctx['genre'][i]}"] if ctx["genre"][i] else []
        keys += [f"l:{ctx['label'][i]}"] if ctx["label"][i] else []
        keys += [f"a:{a}" for a in ctx["artists"][i]]
        feats.append([cols.setdefault(k, len(cols)) for k in keys])
    X = np.zeros((len(ids), max(1, len(cols))))
    for i, fs in enumerate(feats):
        X[i, fs] = 1.0
    return sims_from_vectors(X, centred=False)


def scalar_sims(ctx):
    Z = np.stack([ctx["bpm"], ctx["brightness"], ctx["power"]], axis=1)
    Z = np.where(np.isnan(Z), np.nanmean(Z, axis=0), Z)
    Z = (Z - Z.mean(0)) / np.maximum(Z.std(0), 1e-9)
    D = np.sqrt(((Z[:, None, :] - Z[None, :, :]) ** 2).sum(-1))
    S = -D
    np.fill_diagonal(S, -np.inf)
    return S


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=",".join(MODEL_FILES), help="subset to evaluate (intersection of their tracks)")
    args = ap.parse_args()
    wanted = set(args.models.split(","))
    rows, labels = load_ctx()
    vecs = {}
    for name, fn in MODEL_FILES.items():
        if name not in wanted:
            continue
        p = os.path.join(OUT, fn)
        if os.path.exists(p):
            z = np.load(p)
            vecs[name] = dict(zip(list(z["ids"]), z["vecs"]))
    if not vecs:
        print("no vectors yet")
        return 1
    ids = sorted(set.intersection(*[set(v) for v in vecs.values()]))
    print(f"models: {list(vecs)}; tracks in all: {len(ids)}")
    ctx = build_ctx(ids, rows, labels)
    print(f"eval: {len(ctx['playlists'])} playlists, {len(ctx['tags'])} tags(>=20), "
          f"{len(ctx['set_pairs'])} set pairs, {len(ctx['prep_pairs'])} prep pairs")
    mats = {n: np.stack([v[t] for t in ids]) for n, v in vecs.items()}
    runs = {"random": RNG.random((len(ids), len(ids))), "metadata": metadata_sims(ids, ctx),
            "scalars(bpm,bright,power)": scalar_sims(ctx)}
    for n, X in mats.items():
        runs[n] = sims_from_vectors(X, centred=False)
        runs[n + " (centred)"] = sims_from_vectors(X, centred=True)
    def centred_unit(n):
        X = mats[n] - mats[n].mean(0)
        return l2n(X)
    for combo in (("mert-v2-fullsong", "muq-mulan-large"), ("mert-v2-fullsong", "clap"),
                  ("mert-v2-fullsong", "muq-mulan-large", "clap")):
        if all(c in mats for c in combo):
            runs["+".join(c.split("-")[0] for c in combo) + " (centred concat)"] = \
                sims_from_vectors(np.hstack([centred_unit(c) for c in combo]), centred=False)
    results = {}
    for n, S in runs.items():
        S = S.astype(np.float64)
        np.fill_diagonal(S, -np.inf)
        results[n] = score(S, ctx)
    cols = ["playlist_mAP", "tag_lift", "set_MRR", "set_R@50", "set_median_rank", "prep_MRR",
            "genre_P@10", "label_P@10", "artist_P@10", "brightness_dK", "power_dK", "bpm_dK"]
    print("\n" + f"{'run':38}" + "".join(f"{c:>14}" for c in cols))
    for n, r in results.items():
        print(f"{n:38}" + "".join(f"{r[c]:14.4f}" for c in cols))
    tags = sorted(ctx["tags"], key=lambda t: -len(ctx["tags"][t]))[:24]
    print("\nper-tag P@10 lift (top tags by size):")
    print(f"{'run':38}" + "".join(f"{t[:9]:>10}" for t in tags))
    for n, r in results.items():
        print(f"{n:38}" + "".join(f"{r['per_tag'][t]:10.2f}" for t in tags))
    json.dump(results, open(os.path.join(OUT, "results.json"), "w"), indent=1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
