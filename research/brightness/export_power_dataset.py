#!/usr/bin/env python3
"""Export the POWER-labeled dataset (p0..p5) from curator.db (READ-ONLY).

POWER = energy/intensity (BPM drives it but also density of bass/drums/percussion/synths).
Ordinal p0 (lowest) .. p5 (highest); adjacent double-tags are half-steps (p3+p4 = p3.5),
same convention the user uses for brightness. Continuous 0-5 target.

Writes:
  c:\\tmp\\power_dataset.csv        — all power-tagged local tracks (label + paths)
  c:\\tmp\\power_delta.csv          — only those NOT already in brightness_features.jsonl
                                      (the just-these tracks to extract features for)
"""
from __future__ import annotations
import csv, json, os, sqlite3, sys
from collections import defaultdict

DB_WIN = os.environ.get("CURATOR_DB_URL", r"C:\Users\guy\AppData\Roaming\Curator\curator.db")
OUT = r"C:\tmp\power_dataset.csv"
DELTA = r"C:\tmp\power_delta.csv"
EXTRACTED = r"C:\tmp\brightness_features.jsonl"   # already-extracted track_ids to skip

P = ["p0", "p1", "p2", "p3", "p4", "p5"]
VALUE = {p: float(i) for i, p in enumerate(P)}    # p0=0 .. p5=5; pairs averaged -> half-steps


def win_to_wsl(p: str) -> str:
    if len(p) > 1 and p[1] == ":":
        return f"/mnt/{p[0].lower()}{p[2:]}".replace("\\", "/")
    return p.replace("\\", "/")


def main() -> int:
    db = sqlite3.connect(f"file:{DB_WIN.replace(os.sep,'/')}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    tags = defaultdict(set)
    for r in db.execute("""SELECT tt.track_id tid, tg.name name FROM track_tag tt
                           JOIN tag tg ON tg.id=tt.tag_id WHERE tg.name IN ('p0','p1','p2','p3','p4','p5')"""):
        tags[r["tid"]].add(r["name"])
    meta = {}
    for r in db.execute("""SELECT t.id tid, t.title title, t.artists artists,
              (SELECT sl.file_path FROM source_link sl WHERE sl.track_id=t.id AND sl.source='local'
               AND sl.file_path IS NOT NULL ORDER BY sl.fetched_at LIMIT 1) file_path
            FROM track t WHERE t.id IN (%s)""" % ",".join("?" * len(tags)), list(tags.keys())):
        meta[r["tid"]] = r
    db.close()

    extracted = set()
    if os.path.exists(EXTRACTED):
        for line in open(EXTRACTED, encoding="utf-8"):
            try:
                d = json.loads(line)
                if d.get("_ok"):
                    extracted.add(d["track_id"])
            except Exception:
                pass

    rows = []
    drop_span = drop_file = 0
    for tid, s in tags.items():
        idx = sorted(P.index(x) for x in s)
        if idx[-1] - idx[0] > 1:
            drop_span += 1
            continue
        m = meta.get(tid)
        if not m or not m["file_path"]:
            drop_file += 1
            continue
        win = m["file_path"]
        try:
            arts = json.loads(m["artists"]) if m["artists"] else []
            primary = arts[0]["name"] if arts else ""
        except Exception:
            primary = ""
        rows.append({"track_id": tid, "label": f"{sum(VALUE[x] for x in s)/len(s):.1f}",
                     "label_name": "+".join(sorted(s, key=P.index)), "primary_artist": primary,
                     "title": m["title"], "win_path": win, "wsl_path": win_to_wsl(win),
                     "cur_brightness": "", "key_camelot": "", "key_strength": ""})

    fields = list(rows[0].keys())
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(rows)
    delta = [r for r in rows if r["track_id"] not in extracted]
    with open(DELTA, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(delta)

    from collections import Counter
    dist = Counter(r["label"] for r in rows)
    print(f"power tracks: {len(rows)}  (dropped span>1={drop_span}, no_file={drop_file})")
    print(f"already extracted: {len(rows)-len(delta)}  delta to extract: {len(delta)}")
    print("label dist:", {k: dist[k] for k in sorted(dist, key=float)})
    print(f"-> {OUT}\n-> {DELTA}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
