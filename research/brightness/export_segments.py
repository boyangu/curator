#!/usr/bin/env python3
"""Pick the BREAKDOWN and DROP windows per track from RB phrase segments (READ-ONLY).

Tests the curator's "hidden gem" hypothesis: the timbre of the beatless/melodic
breakdown (RB label 'Down', or song-form 'Verse'/'Bridge') may drive perceived
brightness even in high-power tracks; the 'Chorus' is the drop (high energy).

For each tagged local track we select the LONGEST breakdown segment and the LONGEST
drop segment from track_analysis.rb_segments_json, and emit a CSV that extract_segments.py
feeds to MusicExtractor (windowed per segment). Brightness/power labels joined in.

Writes c:\\tmp\\segments_windows.csv.
"""
from __future__ import annotations
import csv, json, os, sqlite3, sys

DB = r"C:\Users\guy\AppData\Roaming\Curator\curator.db"
OUT = r"C:\tmp\segments_windows.csv"
BRIGHT_CSV = r"C:\tmp\brightness_dataset.csv"
POWER_CSV = r"C:\tmp\power_dataset.csv"

BREAK_LABELS = {"Down", "Bridge", "Verse 1", "Verse 2", "Verse 3", "Verse 4", "Verse 5", "Verse 6"}
DROP_LABELS = {"Chorus 1", "Chorus 2", "Chorus"}


def win_to_wsl(p: str) -> str:
    if len(p) > 1 and p[1] == ":":
        return f"/mnt/{p[0].lower()}{p[2:]}".replace("\\", "/")
    return p.replace("\\", "/")


def labels(path):
    out = {}
    if os.path.exists(path):
        with open(path, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                out[r["track_id"]] = (r["label"], r["primary_artist"], r["win_path"])
    return out


def longest(segs, allowed):
    best, blen = None, 0.0
    for s in segs:
        if s.get("label") in allowed:
            ln = float(s["endSec"]) - float(s["startSec"])
            if ln > blen:
                blen, best = ln, s
    return best


def main() -> int:
    bright, power = labels(BRIGHT_CSV), labels(POWER_CSV)
    keep = set(bright) | set(power)
    db = sqlite3.connect(f"file:{DB.replace(os.sep,'/')}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    rows = []
    n_break = n_drop = 0
    for r in db.execute("SELECT track_id, rb_segments_json FROM track_analysis WHERE rb_segments_json IS NOT NULL"):
        tid = r["track_id"]
        if tid not in keep:
            continue
        try:
            segs = json.loads(r["rb_segments_json"])
        except Exception:
            continue
        if not segs:
            continue
        brk = longest(segs, BREAK_LABELS)
        drp = longest(segs, DROP_LABELS)
        # path/artist from whichever label set has the track
        meta = bright.get(tid) or power.get(tid)
        win = meta[2]
        artist = meta[1]
        row = {
            "track_id": tid, "primary_artist": artist,
            "win_path": win, "wsl_path": win_to_wsl(win),
            "bright": bright.get(tid, ("",))[0], "power": power.get(tid, ("",))[0],
            "n_segments": len(segs),
            "break_label": brk["label"] if brk else "", "break_start": brk["startSec"] if brk else "",
            "break_end": brk["endSec"] if brk else "",
            "drop_label": drp["label"] if drp else "", "drop_start": drp["startSec"] if drp else "",
            "drop_end": drp["endSec"] if drp else "",
        }
        rows.append(row)
        n_break += int(brk is not None); n_drop += int(drp is not None)
    db.close()

    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    print(f"tracks: {len(rows)}  with breakdown: {n_break}  with drop: {n_drop}")
    print(f"-> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
