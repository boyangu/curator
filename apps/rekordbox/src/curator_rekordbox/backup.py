"""Backup management for master.db — copy, list, clear.

Each backup is a sibling file next to master.db, named
`master_{ISO-timestamp}.db` (colons replaced by hyphens so the name is
filename-safe on every platform). SQLite sidecar files (-wal, -shm,
-journal) that exist at backup time are copied alongside the renamed
file so a restore is a consistent point-in-time swap, not a torn
partial.

The regex used for listing + clearing matches EXACTLY this name shape.
Rekordbox's own `master.db.bak` rotations and any other files in the
directory are intentionally not touched — Clear is a destructive
operation and "delete only what we created" is the safety contract.
"""

from __future__ import annotations

import os
import re
import shutil
import sys
from datetime import datetime, timezone
from typing import Any


# `master_2026-06-04T14-32-15.db` — ISO 8601 with colons → hyphens so the
# name is valid on Windows (Windows can't have `:` in filenames).
_BACKUP_NAME_RE = re.compile(r"^master_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.db$")
_SIDECAR_SUFFIXES = ("-wal", "-shm", "-journal")


def _iso_filename_safe(dt: datetime) -> str:
    """ISO 8601 timestamp with `:` → `-` so it's safe as a filename
    component on Windows. Drops sub-second precision (not useful for
    user-visible backup naming, and complicates the listing regex)."""
    return dt.strftime("%Y-%m-%dT%H-%M-%S")


def _parse_backup_timestamp(name: str) -> datetime | None:
    """Inverse of `_iso_filename_safe`. Returns None if the filename
    doesn't match the curator backup shape — used by `list_backups` to
    filter out anything we didn't create."""
    m = _BACKUP_NAME_RE.match(name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y-%m-%dT%H-%M-%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _backup_paths_for(db_path: str, backup_path: str) -> list[tuple[str, str]]:
    """Pairs of (source, destination) for the primary db file + any
    sidecar companions that exist. Sidecars are only copied when present
    at backup time — missing -wal/-shm is normal for a DB not in WAL
    mode or with no active transactions."""
    pairs: list[tuple[str, str]] = [(db_path, backup_path)]
    for suffix in _SIDECAR_SUFFIXES:
        src = db_path + suffix
        if os.path.exists(src):
            pairs.append((src, backup_path + suffix))
    return pairs


def backup_master_db(db_path: str) -> dict[str, Any]:
    """Copy master.db (+ wal/shm/journal companions if present) to a
    timestamped sibling. Returns the backup path + combined size + epoch
    ms so the caller can show the user what just got written.

    The backup is the point-in-time we can roll back to if a subsequent
    sync verification fails. It's never deleted automatically; the user
    clears it via the Settings → Rekordbox panel.

    Raises any OSError from the copy — caller (the `_handle_backup` RPC)
    converts to a wire-friendly error.
    """
    now = datetime.now(timezone.utc)
    stem = _iso_filename_safe(now)
    db_dir = os.path.dirname(os.path.abspath(db_path))
    backup_path = os.path.join(db_dir, f"master_{stem}.db")

    # Defensive: don't silently overwrite an existing backup with the
    # exact same name (would only happen if two syncs ran within the
    # same second — unlikely but cheap to guard against).
    if os.path.exists(backup_path):
        suffix = 1
        while os.path.exists(os.path.join(db_dir, f"master_{stem}_{suffix}.db")):
            suffix += 1
        backup_path = os.path.join(db_dir, f"master_{stem}_{suffix}.db")

    copied: list[str] = []
    try:
        for src, dst in _backup_paths_for(db_path, backup_path):
            shutil.copy2(src, dst)
            copied.append(dst)
    except Exception:
        # Half-written backup is worse than no backup — nuke the partial
        # set so the directory stays clean.
        for p in copied:
            try: os.remove(p)
            except OSError: pass
        raise

    total_bytes = 0
    for p in copied:
        try: total_bytes += os.path.getsize(p)
        except OSError: pass

    sys.stderr.write(f"backup written: {backup_path} ({total_bytes} bytes)\n")
    return {
        "path": backup_path,
        "sizeBytes": total_bytes,
        "takenAtMs": int(now.timestamp() * 1000),
    }


def list_backups(db_dir: str) -> list[dict[str, Any]]:
    """Find every curator-created backup in `db_dir`. Matches on the
    strict `master_{ISO}.db` shape so rekordbox's own `.bak` files and
    anything else the user has in the folder are ignored.

    Size includes the primary + any sidecar companions for that backup
    (so the user-visible total matches what Clear would actually free).
    Sorted newest-first.
    """
    if not os.path.isdir(db_dir):
        return []
    out: list[dict[str, Any]] = []
    try:
        names = os.listdir(db_dir)
    except OSError:
        return []
    for name in names:
        taken = _parse_backup_timestamp(name)
        if taken is None:
            continue
        primary = os.path.join(db_dir, name)
        size = 0
        try: size += os.path.getsize(primary)
        except OSError: continue  # skip if vanished mid-iteration
        for suffix in _SIDECAR_SUFFIXES:
            sidecar = primary + suffix
            if os.path.exists(sidecar):
                try: size += os.path.getsize(sidecar)
                except OSError: pass
        out.append({
            "path": primary,
            "sizeBytes": size,
            "takenAtMs": int(taken.timestamp() * 1000),
        })
    out.sort(key=lambda b: b["takenAtMs"], reverse=True)
    return out


def clear_backups(db_dir: str) -> dict[str, Any]:
    """Delete every curator-created backup (and its sidecars) in
    `db_dir`. Returns `{deleted, freedBytes}` so the UI can confirm the
    action took effect.

    A failure to delete one file (permissions, in-use) doesn't abort the
    whole sweep — we accumulate errors and report the count of what we
    DID delete. The user can retry; nothing is silently left behind that
    a re-run wouldn't catch.
    """
    backups = list_backups(db_dir)
    deleted = 0
    freed_bytes = 0
    for b in backups:
        primary = b["path"]
        size = b["sizeBytes"]
        paths = [primary] + [primary + sx for sx in _SIDECAR_SUFFIXES
                              if os.path.exists(primary + sx)]
        ok = True
        for p in paths:
            try:
                os.remove(p)
            except OSError as exc:
                sys.stderr.write(f"backup clear failed for {p}: {exc}\n")
                ok = False
        if ok:
            deleted += 1
            freed_bytes += size
    sys.stderr.write(f"cleared {deleted} backups ({freed_bytes} bytes)\n")
    return {"deleted": deleted, "freedBytes": freed_bytes}


def restore_backup(backup_path: str, db_path: str) -> None:
    """Swap a backup file back over master.db.

    Called from the verify-failed modal's `Restore previous version`
    button. The caller (Node side) is responsible for ensuring rekordbox
    is not running AND that the writer session has been closed — this
    function does a straight file-level overwrite. Sidecar companions
    (-wal/-shm/-journal) are also restored from the backup set; any
    sidecar that exists on master.db but NOT on the backup gets
    removed so master.db's WAL state matches the backup's exactly.

    Raises OSError on any failure. The Node side surfaces the error to
    the user — partial restore is a "your database may be in an
    inconsistent state" situation that needs human eyes.
    """
    if not os.path.exists(backup_path):
        raise FileNotFoundError(f"backup not found: {backup_path}")
    # Atomic-ish: copy the primary first, then companions. If the
    # primary copy fails, master.db is still intact (we never deleted
    # it). If a companion fails after the primary lands, master.db is
    # consistent with the backup's primary but possibly carries stale
    # WAL data — caller's "inconsistent state" warning covers this.
    shutil.copy2(backup_path, db_path)
    for suffix in _SIDECAR_SUFFIXES:
        backup_sidecar = backup_path + suffix
        master_sidecar = db_path + suffix
        if os.path.exists(backup_sidecar):
            shutil.copy2(backup_sidecar, master_sidecar)
        elif os.path.exists(master_sidecar):
            # Backup didn't have this sidecar but master.db does — remove
            # so the post-restore state matches what the backup captured.
            try: os.remove(master_sidecar)
            except OSError: pass
    sys.stderr.write(f"restored {backup_path} → {db_path}\n")
