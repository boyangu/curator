"""Probe what pyrekordbox actually exposes on this install for cues + ANLZ.

The Rekordbox sidecar has been emitting 0 cues + 0 waveforms across 4717
linked tracks. Most likely the method names we're trying (`get_cue`,
`get_djmd_cue`, `get_hot_cue_banklist_cue`) don't match this version of
pyrekordbox, and the `get_anlz_paths` lookup is returning nothing.

Usage:  python scripts/probe-pyrekordbox.py
Set REKORDBOX_DB env to override the auto-detect path.
"""
import os
import sys
import traceback

from pyrekordbox import Rekordbox6Database

DB_PATH = os.environ.get(
    "REKORDBOX_DB",
    os.path.join(os.environ.get("APPDATA", ""), "Pioneer", "rekordbox", "master.db"),
)


def main() -> int:
    print(f"db: {DB_PATH}")
    print(f"exists: {os.path.exists(DB_PATH)}\n")

    db = Rekordbox6Database(DB_PATH)

    print("── cue-related methods on db ────────────────")
    for name in sorted(dir(db)):
        if "cue" in name.lower():
            print(f"  {name}")

    print("\n── anlz-related methods on db ───────────────")
    for name in sorted(dir(db)):
        if "anlz" in name.lower() or "wave" in name.lower():
            print(f"  {name}")

    print("\n── total content ────────────────────────────")
    contents = list(db.get_content())
    print(f"  {len(contents)} tracks")

    if contents:
        # Pick the first track that has a file path on disk.
        sample = contents[0]
        print(f"\n── sample track ─────────────────────────────")
        print(f"  ID={sample.ID}  Title={sample.Title}  FolderPath={getattr(sample, 'FolderPath', None)}")

    # Try every candidate cue method.
    for name in ("get_cue", "get_djmd_cue", "get_hot_cue_banklist_cue"):
        if not hasattr(db, name):
            print(f"\n── {name}: NOT ON db ─────────────────────")
            continue
        meth = getattr(db, name)
        print(f"\n── {name} ───────────────────────────────────")
        # Try zero-arg call first.
        try:
            rows = list(meth())
            print(f"  zero-arg ok: {len(rows)} rows")
            if rows:
                r = rows[0]
                print(f"  first row attrs: {[a for a in dir(r) if not a.startswith('_')][:20]}")
        except TypeError as exc:
            print(f"  zero-arg TypeError: {exc} (likely needs args)")
        except Exception as exc:
            print(f"  zero-arg failed: {type(exc).__name__}: {exc}")

        # Try per-content if zero-arg didn't yield rows.
        if contents:
            try:
                rows = list(meth(content=contents[0]))
                print(f"  content= ok: {len(rows)} rows")
            except Exception as exc:
                print(f"  content= failed: {type(exc).__name__}: {exc}")

    # ANLZ probe on the sample.
    if contents:
        print("\n── get_anlz_paths(content=sample) ───────────")
        try:
            paths = db.get_anlz_paths(content=contents[0])
            print(f"  returned: {paths!r}")
            if isinstance(paths, dict):
                for k, v in paths.items():
                    print(f"    {k}: {v}  exists={os.path.exists(v) if v else False}")
            elif paths:
                for p in paths:
                    print(f"    {p}  exists={os.path.exists(p) if p else False}")
        except Exception as exc:
            print(f"  failed: {type(exc).__name__}: {exc}")
            traceback.print_exc()

    # Try the table-mapper approach (direct SQLAlchemy).
    print("\n── direct DjmdCue table (via SQLAlchemy) ────")
    try:
        from pyrekordbox.db6.tables import DjmdCue
        n = db.session.query(DjmdCue).count()
        print(f"  DjmdCue row count: {n}")
        if n > 0:
            row = db.session.query(DjmdCue).first()
            print(f"  first row attrs: {[a for a in dir(row) if not a.startswith('_') and a == a.lower()][:30]}")
            for a in ("ID", "ContentID", "InMsec", "OutMsec", "Kind", "ColorTableInfo", "Comment", "rb_local_usn"):
                if hasattr(row, a):
                    print(f"    {a} = {getattr(row, a)!r}")
    except Exception as exc:
        print(f"  failed: {type(exc).__name__}: {exc}")
        traceback.print_exc()

    # ANLZ parse probe — we need to confirm AnlzFile.parse_file actually exists.
    if contents:
        print("\n── AnlzFile API ─────────────────────────────")
        try:
            from pyrekordbox.anlz import AnlzFile
            print(f"  AnlzFile cls methods: {[m for m in dir(AnlzFile) if 'parse' in m.lower() or m == '__init__']}")
            paths = db.get_anlz_paths(content=contents[0])
            dat_path = paths.get('DAT') if isinstance(paths, dict) else None
            if dat_path:
                # Try classmethod first
                try:
                    a = AnlzFile.parse_file(str(dat_path))
                    print(f"  parse_file() ok — tags: {list(a.tags.keys()) if hasattr(a, 'tags') else 'no tags attr'}")
                except AttributeError:
                    print("  AnlzFile.parse_file does NOT exist")
                except Exception as exc:
                    print(f"  parse_file failed: {type(exc).__name__}: {exc}")
                # Try plain ctor
                try:
                    a = AnlzFile(str(dat_path))
                    print(f"  AnlzFile(path) ok — tags: {list(a.tags.keys()) if hasattr(a, 'tags') else 'no tags attr'}")
                except Exception as exc:
                    print(f"  AnlzFile(path) failed: {type(exc).__name__}: {exc}")
                # Try db.read_anlz_file (saw it in the method list)
                try:
                    a = db.read_anlz_file(str(dat_path))
                    print(f"  db.read_anlz_file ok — tags: {list(a.tags.keys()) if hasattr(a, 'tags') else 'no tags attr'}")
                except Exception as exc:
                    print(f"  db.read_anlz_file failed: {type(exc).__name__}: {exc}")
                # Try db.read_anlz_files (plural)
                try:
                    res = db.read_anlz_files(contents[0])
                    print(f"  db.read_anlz_files ok — type={type(res).__name__}")
                    if isinstance(res, dict):
                        for k, v in res.items():
                            tagk = list(v.tags.keys()) if hasattr(v, 'tags') else 'no tags'
                            print(f"    {k}: tags={tagk}")
                except Exception as exc:
                    print(f"  db.read_anlz_files failed: {type(exc).__name__}: {exc}")
        except Exception as exc:
            print(f"  probe failed: {type(exc).__name__}: {exc}")
            traceback.print_exc()

    return 0


if __name__ == "__main__":
    sys.exit(main())
