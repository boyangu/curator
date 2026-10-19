#!/usr/bin/env python3
"""Phase 0 — export the bake-off sample + evaluation labels from curator.db (READ-ONLY).

Sample: local tracks whose file exists (no WAV-derived copies), built so every
evaluation signal has members inside the sample —
  * every local track played in a rekordbox DJ set (play_session.kind='set'),
    so consecutive-play pairs survive sampling;
  * then a seeded random fill from tracks carrying user tags or rekordbox
    playlist membership, up to --n.
Labels (all restricted to the sample):
  * tags: the user's own vocabulary (kind='user'; system tags excluded);
  * playlists: rekordbox playlists, 5..300 members in-sample (bigger ones are
    library-wide buckets, not curation);
  * set_pairs / prep_pairs: consecutive plays inside set / prep sessions;
  * meta: artist ids, label, genre, bpm, key, brightness, power.
Writes c:/tmp/mir/dataset.csv + c:/tmp/mir/labels.json. Never writes the DB.
"""
from __future__ import annotations

import argparse, csv, json, os, random, sqlite3
from collections import defaultdict

DB = os.environ.get("CURATOR_DB", r"C:\Users\guy\AppData\Roaming\Curator\curator.db")
OUT = os.environ.get("MIR_OUT", r"C:\tmp\mir")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1200)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--labels-only", action="store_true",
                    help="keep the existing dataset.csv sample (vectors are keyed to it); rewrite labels.json only")
    args = ap.parse_args()
    db = sqlite3.connect(f"file:{DB.replace(os.sep, '/')}?mode=ro", uri=True)
    q = lambda s, *a: db.execute(s, a).fetchall()

    local = {}
    for tid, path in q("""SELECT t.id, MIN(sl.file_path) FROM track t
            JOIN source_link sl ON sl.track_id = t.id AND sl.source = 'local' AND sl.file_path IS NOT NULL
            WHERE t.deleted_at IS NULL AND t.derived_from_track_id IS NULL GROUP BY t.id"""):
        if os.path.exists(path):
            local[tid] = path
    print(f"local tracks with a file: {len(local)}")

    def pairs(kind: str) -> list[tuple[str, str]]:
        out, by = [], defaultdict(list)
        for sid, no, tid in q("""SELECT e.session_id, e.track_no, e.track_id FROM play_event e
                JOIN play_session s ON s.id = e.session_id WHERE s.kind = ? AND e.track_id IS NOT NULL
                ORDER BY e.session_id, e.track_no, e.played_at""", kind):
            by[sid].append(tid)
        for seq in by.values():
            out += [(a, b) for a, b in zip(seq, seq[1:]) if a != b]
        return out

    set_pairs_all, prep_pairs_all = pairs("set"), pairs("prep")
    rng = random.Random(args.seed)
    must = sorted({t for p in set_pairs_all for t in p if t in local})
    tagged = {t for (t,) in q("""SELECT DISTINCT tt.track_id FROM track_tag tt JOIN tag g ON g.id = tt.tag_id
                                 WHERE g.kind = 'user'""")}
    in_rb = {t for (t,) in q("""SELECT DISTINCT pt.track_id FROM playlist_track pt JOIN playlist p ON p.id = pt.playlist_id
                                WHERE p.source = 'rekordbox'""")}
    pool = sorted(t for t in local if (t in tagged or t in in_rb) and t not in set(must))
    rng.shuffle(pool)
    sample = must + pool[:max(0, args.n - len(must))]
    if args.labels_only:
        with open(os.path.join(OUT, "dataset.csv"), encoding="utf-8") as f:
            sample = [r["track_id"] for r in csv.DictReader(f)]
    S = set(sample)
    print(f"sample: {len(sample)} ({len(must)} from DJ sets)")

    meta = {}
    for r in q(f"""SELECT id, title, artists, label, genre, bpm, key_camelot, brightness, power, duration
                  FROM track WHERE id IN ({','.join('?' * len(sample))})""", *sample):
        tid, title, artists, label, genre, bpm, key, bright, power, dur = r
        try:
            names = [a["name"] for a in json.loads(artists or "[]")]
        except Exception:
            names = []
        meta[tid] = dict(title=title or "", artists=" & ".join(names), label=label or "", genre=genre or "",
                         bpm=bpm or "", key=key or "", brightness="" if bright is None else bright,
                         power="" if power is None else power, duration=dur or "")
    artist_ids = defaultdict(list)
    for tid, aid in q(f"""SELECT track_id, artist_id FROM track_artist WHERE (role IS NULL OR role <> 'remixer')
                         AND track_id IN ({','.join('?' * len(sample))})""", *sample):
        artist_ids[tid].append(aid)

    tags = defaultdict(list)
    for tid, name in q("""SELECT tt.track_id, g.name FROM track_tag tt JOIN tag g ON g.id = tt.tag_id
                          WHERE g.kind = 'user'"""):
        if tid in S:
            tags[tid].append(name)
    playlists = {}
    for pid, name in q("SELECT id, name FROM playlist WHERE source = 'rekordbox'"):
        members = sorted({t for (t,) in q("SELECT track_id FROM playlist_track WHERE playlist_id = ?", pid) if t in S})
        total = q("SELECT COUNT(DISTINCT track_id) FROM playlist_track WHERE playlist_id = ?", pid)[0][0]
        if 5 <= len(members) and total <= 300:
            playlists[pid] = {"name": name, "members": members, "total": total}

    os.makedirs(OUT, exist_ok=True)
    if not args.labels_only:
        with open(os.path.join(OUT, "dataset.csv"), "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["track_id", "path", "title", "artists", "label", "genre", "bpm", "key",
                                              "brightness", "power", "duration"])
            w.writeheader()
            for tid in sample:
                w.writerow({"track_id": tid, "path": local[tid], **meta.get(tid, {})})
    labels = {
        "tags": tags, "artists": artist_ids, "playlists": playlists,
        "set_pairs": [p for p in set_pairs_all if p[0] in S and p[1] in S],
        "prep_pairs": [p for p in prep_pairs_all if p[0] in S and p[1] in S],
    }
    with open(os.path.join(OUT, "labels.json"), "w", encoding="utf-8") as f:
        json.dump(labels, f)
    print(f"tags on {len(tags)} tracks; {len(playlists)} rb playlists; "
          f"{len(labels['set_pairs'])} set pairs; {len(labels['prep_pairs'])} prep pairs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
