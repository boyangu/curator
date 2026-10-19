#!/usr/bin/env python3
"""Backfill the new brightness + power scores onto tracks already advanced-analyzed.

Targets track_analysis rows with brightness NOT NULL and analyzer_version != 'rekordbox'
(the Curator-analyzed set; the rekordbox dual-source slot is left untouched). For each,
recompute brightness + power with the verified scoring pipeline (one MusicExtractor pass)
and UPDATE only those two columns + bump analyzer_version→2.3.0. Equivalent to a targeted
advanced re-analyze, minus the wasteful beatgrid/key/peaks rerun.

DIRECT WRITE to the live curator.db — the desktop app MUST be closed (WAL write lock).
Workers compute; the main process writes transactionally. Resumable (skips rows already
at 2.3.0 with power set).

Run in WSL (.venv-wsl). DB at /mnt/c/.../curator.db.
"""
from __future__ import annotations
import os, sys, time
from multiprocessing import Pool, cpu_count

# Run from WSL: the analyzer source and the library DB come from the
# environment, never from a hardcoded machine path.
sys.path.insert(0, os.environ.get("CURATOR_ANALYZER_SRC", os.path.join(os.path.dirname(__file__), "..", "..", "apps", "analyzer", "src")))

DB = os.environ["CURATOR_DB"]  # e.g. /mnt/c/Users/<you>/AppData/Roaming/Curator/curator.db
TARGET_VERSION = "2.3.0"


def win_to_wsl(p: str) -> str:
    if len(p) > 1 and p[1] == ":":
        return f"/mnt/{p[0].lower()}{p[2:]}".replace("\\", "/")
    return p.replace("\\", "/")


def _compute(item: tuple[str, str]) -> tuple:
    track_id, wsl_path = item
    try:
        import essentia
        essentia.log.infoActive = False
        essentia.log.warningActive = False
        from essentia.standard import MusicExtractor
        from curator_analyzer import scoring
        if not os.path.exists(wsl_path):
            return (track_id, None, None, False, "missing_file")
        me = MusicExtractor(lowlevelFrameSize=2048, lowlevelHopSize=1024,
                            rhythmStats=["mean"], tonalStats=["mean"], lowlevelStats=["mean", "stdev"])
        pool, _ = me(wsl_path)
        b, p = scoring.brightness_power(pool)
        return (track_id, b, p, True, None)
    except Exception as exc:  # noqa: BLE001
        return (track_id, None, None, False, f"{type(exc).__name__}: {exc}")


def main() -> int:
    import sqlite3
    workers = int(os.environ.get("WORKERS", max(1, cpu_count() - 1)))
    # read targets
    ro = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    ro.row_factory = sqlite3.Row
    rows = ro.execute("""
        SELECT ta.track_id AS tid,
               (SELECT sl.file_path FROM source_link sl
                  WHERE sl.track_id = ta.track_id AND sl.source='local' AND sl.file_path IS NOT NULL
                  ORDER BY sl.fetched_at LIMIT 1) AS path
        FROM track_analysis ta
        WHERE ta.brightness IS NOT NULL AND ta.analyzer_version != 'rekordbox'
          AND NOT (ta.analyzer_version = ? AND ta.power IS NOT NULL)
    """, (TARGET_VERSION,)).fetchall()
    ro.close()
    targets = [(r["tid"], win_to_wsl(r["path"])) for r in rows if r["path"]]
    print(f"targets: {len(targets)} (workers={workers})", flush=True)
    if not targets:
        print("nothing to do")
        return 0

    # write connection (fails if app holds the lock)
    w = sqlite3.connect(DB, timeout=30)
    w.execute("PRAGMA busy_timeout=30000")
    upd_ta = "UPDATE track_analysis SET brightness=?, power=?, analyzer_version=?, analyzed_at=? WHERE track_id=?"
    upd_tr = "UPDATE track SET brightness=?, power=? WHERE id=?"

    ok = err = 0
    t0 = time.time()
    pending = 0
    with Pool(workers) as pool:
        for i, (tid, b, p, good, errmsg) in enumerate(pool.imap_unordered(_compute, targets, chunksize=1), 1):
            if good and b is not None and p is not None:
                now = int(time.time() * 1000)
                w.execute(upd_ta, (b, p, TARGET_VERSION, now, tid))
                w.execute(upd_tr, (b, p, tid))
                ok += 1; pending += 1
                if pending >= 50:
                    w.commit(); pending = 0
            else:
                err += 1
                print(f"  ERR {tid}: {errmsg}", flush=True)
            if i % 50 == 0 or i == len(targets):
                w.commit(); pending = 0
                rate = i / (time.time() - t0)
                print(f"  {i}/{len(targets)} ok={ok} err={err} {rate:.2f}/s eta={(len(targets)-i)/rate/60:.1f}m", flush=True)
    w.commit()
    w.close()
    print(f"done: ok={ok} err={err}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
