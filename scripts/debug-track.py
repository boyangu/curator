"""One-shot DB probe: given a trackId, dumps everything Curator knows about
it across track / source_link / rekordbox_link / track_analysis / cue.

Usage: python scripts/debug-track.py <trackId>
"""
import os
import sqlite3
import sys
from pprint import pp


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python scripts/debug-track.py <trackId>")
        return 1
    track_id = sys.argv[1]

    db_path = os.path.join(os.environ.get("APPDATA", ""), "Curator", "curator.db")
    print(f"db: {db_path}\n")

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    def fetch_one(sql, *params):
        row = conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def fetch_all(sql, *params):
        return [dict(r) for r in conn.execute(sql, params).fetchall()]

    print("── track ─────────────────────────────────────")
    pp(fetch_one("SELECT id, title, artists, bpm, key_camelot, state FROM track WHERE id = ?", track_id))

    print("\n── source_link cols ─────────────────────────")
    pp([dict(r) for r in conn.execute("PRAGMA table_info(source_link)").fetchall()])

    print("\n── source_link rows ─────────────────────────")
    pp(fetch_all("SELECT * FROM source_link WHERE track_id = ?", track_id))

    print("\n── search by title ('Muzik') ────────────────")
    pp(fetch_all(
        "SELECT id, title, artists FROM track WHERE title LIKE '%Muzik%' OR artists LIKE '%nderholm%' LIMIT 10"
    ))

    print("\n── rekordbox_link ───────────────────────────")
    pp(fetch_one(
        "SELECT rb_content_id, rb_local_usn, rb_file_path, imported_at FROM rekordbox_link WHERE track_id = ?",
        track_id,
    ))

    print("\n── track_analysis ───────────────────────────")
    pp(fetch_one(
        "SELECT track_id, bpm, key_camelot, analyzer_version, "
        "length(beatgrid) AS beatgrid_bytes, length(downbeats) AS downbeats_bytes, "
        "analyzed_at FROM track_analysis WHERE track_id = ?",
        track_id,
    ))

    print("\n── cue ──────────────────────────────────────")
    pp(fetch_all(
        "SELECT slot, kind, position_sec, length_sec, color, name FROM cue WHERE track_id = ? ORDER BY slot",
        track_id,
    ))

    print("\n── watermarks ───────────────────────────────")
    pp(fetch_all("SELECT * FROM rekordbox_sync_watermark"))

    print("\n── totals ───────────────────────────────────")
    pp(fetch_one(
        "SELECT "
        "(SELECT COUNT(*) FROM rekordbox_link)   AS rekordbox_link_total, "
        "(SELECT COUNT(*) FROM track_analysis)   AS track_analysis_total, "
        "(SELECT COUNT(*) FROM cue)              AS cue_total, "
        "(SELECT COUNT(*) FROM track_analysis WHERE analyzer_version='rekordbox') AS analysis_from_rb"
    ))

    return 0


if __name__ == "__main__":
    sys.exit(main())
