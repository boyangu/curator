#!/usr/bin/env python3
"""Phase 1 — export the brightness-labeled dataset from curator.db (READ-ONLY).

The user hand-labels tracks with an ordinal brightness scale via tags:
    b1 (brightest) > b0 > d1 > d2 (darkest)
Adjacent double-tags are *half-steps* (b1+b0 == "b0.5", a track between b1 and b0),
confirmed by the user. There are no non-adjacent combinations in the data, so the
label is a clean continuous ordinal on [0, 3]:

    b1=3.0  b1+b0=2.5  b0=2.0  b0+d1=1.5  d1=1.0  d1+d2=0.5  d2=0.0

Output CSV (c:\\tmp\\brightness_dataset.csv) is the input to extract_features.py.
Strictly read-only; never writes to curator.db.
"""
from __future__ import annotations
import csv, json, os, sqlite3, sys
from collections import defaultdict

DB_WIN = os.environ.get("CURATOR_DB_URL", r"C:\Users\guy\AppData\Roaming\Curator\curator.db")
OUT = os.environ.get("BRIGHTNESS_DATASET", r"C:\tmp\brightness_dataset.csv")

ORDER = ["b1", "b0", "d1", "d2"]            # brightest -> darkest
VALUE = {"b1": 3.0, "b0": 2.0, "d1": 1.0, "d2": 0.0}  # single-tag values; pairs averaged


def win_to_wsl(p: str) -> str:
    # C:\foo\bar -> /mnt/c/foo/bar   (matches the analyzer's JSON-RPC boundary xlate)
    if len(p) > 1 and p[1] == ":":
        return f"/mnt/{p[0].lower()}{p[2:]}".replace("\\", "/")
    return p.replace("\\", "/")


def db_path_for_runtime() -> str:
    # Allow running under WSL (db lives on /mnt/c) or Windows.
    if sys.platform != "win32" and DB_WIN[1:3] == ":\\":
        return win_to_wsl(DB_WIN)
    return DB_WIN


def main() -> int:
    path = db_path_for_runtime()
    uri = f"file:{path.replace(os.sep, '/')}?mode=ro"
    db = sqlite3.connect(uri, uri=True)
    db.row_factory = sqlite3.Row

    # brightness-tag set per track
    tags: dict[str, set[str]] = defaultdict(set)
    for r in db.execute(
        """SELECT tt.track_id AS tid, tg.name AS name
           FROM track_tag tt JOIN tag tg ON tg.id = tt.tag_id
           WHERE tg.name IN ('b1','b0','d1','d2')"""
    ):
        tags[r["tid"]].add(r["name"])

    # local file path (pick the first local link if several), current brightness, key
    meta: dict[str, sqlite3.Row] = {}
    for r in db.execute(
        """SELECT t.id AS tid, t.title AS title, t.artists AS artists,
                  t.brightness AS cur_brightness,
                  ta.key_camelot AS key_camelot, ta.key_strength AS key_strength,
                  (SELECT sl.file_path FROM source_link sl
                     WHERE sl.track_id = t.id AND sl.source='local' AND sl.file_path IS NOT NULL
                     ORDER BY sl.fetched_at LIMIT 1) AS file_path
           FROM track t LEFT JOIN track_analysis ta ON ta.track_id = t.id
           WHERE t.id IN (%s)""" % ",".join("?" * len(tags)),
        list(tags.keys()),
    ):
        meta[r["tid"]] = r

    rows_out = []
    dropped_span = dropped_nofile = dropped_missing = 0
    for tid, tagset in tags.items():
        idx = sorted(ORDER.index(x) for x in tagset)
        if idx[-1] - idx[0] > 1:          # non-adjacent contradiction — defensive (none in data)
            dropped_span += 1
            continue
        label = sum(VALUE[x] for x in tagset) / len(tagset)  # singles -> value; adjacent pair -> half-step
        label_name = "+".join(sorted(tagset, key=ORDER.index))
        m = meta.get(tid)
        if not m or not m["file_path"]:
            dropped_nofile += 1
            continue
        win = m["file_path"]
        wsl = win_to_wsl(win)
        probe = wsl if sys.platform != "win32" else win
        if not os.path.exists(probe):
            dropped_missing += 1
            continue
        try:
            artists = json.loads(m["artists"]) if m["artists"] else []
            primary = artists[0]["name"] if artists else ""
        except Exception:
            primary = ""
        rows_out.append({
            "track_id": tid,
            "label": f"{label:.1f}",
            "label_name": label_name,
            "primary_artist": primary,
            "title": m["title"],
            "win_path": win,
            "wsl_path": wsl,
            "cur_brightness": m["cur_brightness"] if m["cur_brightness"] is not None else "",
            "key_camelot": m["key_camelot"] or "",
            "key_strength": m["key_strength"] if m["key_strength"] is not None else "",
        })
    db.close()

    os.makedirs(os.path.dirname(OUT) if sys.platform == "win32" else win_to_wsl(os.path.dirname(OUT)), exist_ok=True)
    out_path = OUT if sys.platform == "win32" else win_to_wsl(OUT)
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows_out[0].keys()))
        w.writeheader()
        w.writerows(rows_out)

    # summary
    from collections import Counter
    dist = Counter(r["label"] for r in rows_out)
    print(f"wrote {len(rows_out)} rows -> {out_path}")
    print(f"dropped: span>1={dropped_span} no_local_file={dropped_nofile} file_missing={dropped_missing}")
    print("label distribution:")
    for k in sorted(dist, key=float, reverse=True):
        print(f"  {k:>4}  n={dist[k]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
