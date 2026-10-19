"""Rekordbox sidecar entry point. Stdio JSON-RPC, one in-flight scan at a time.

Mirrors apps/analyzer/src/curator_analyzer/main.py architecturally but with
the simpler "single worker" shape — pyrekordbox is fast for scalar reads and
the ANLZ pass is disk-bound, so multi-process workers don't buy anything.

Protocol (one JSON object per line):

    Node → sidecar:
      Read-side:
        {"id": 1, "method": "open",     "params": {"dbPath": "...", "key": "..." }}
        {"id": 2, "method": "scan",     "params": {"watermarks": {...}, "scopes": [...], "peaksDir": "..."}}
        {"id": 3, "method": "detect"}                                     # OS-aware db-path probe + running check
        {"id": 4, "method": "cancel"}                                     # best-effort scan cancel
      Write-side (sync TO rekordbox — see writer.py, verifier.py, backup.py):
        {"id": 5, "method": "backup",          "params": {"dbPath": "..."}}
        {"id": 6, "method": "open_for_write",  "params": {"dbPath": "...", "key": "..."}}
        {"id": 7, "method": "apply_write_batch","params": {"ops": [...]}}
        {"id": 8, "method": "commit_and_close","params": {"writtenRbContentIds": [...]}}
        {"id": 9, "method": "verify",          "params": {"dbPath": "...", "key": "...", "expectedWrites": [...]}}
        {"id": 10, "method": "list_backups",   "params": {"dbDir": "..."}}
        {"id": 15, "method": "list_stale_relations", "params": {"dbPath": "...", "key": "..."}}  # → {"stale": [{"rbContentId", "fields": [artist|album|label|genre], "myTags": [name]}]} — tombstoned relations / MyTag memberships per content
        {"id": 11, "method": "clear_backups",  "params": {"dbDir": "..."}}
        {"id": 12, "method": "restore_backup", "params": {"backupPath": "...", "dbPath": "..."}}
      Palette (static, no db needed):
        {"id": 13, "method": "list_cue_palette"}
      {"id": 14, "method": "shutdown"}

    sidecar → Node (line-delimited):
      Read events + results as before; write methods return `{"result": {...}}`.
      Before its result, apply_write_batch streams
        {"id": 7, "event": "progress", "done": i, "total": n}
      (throttled in writer.apply_batch; a "Sync updates" batch can be
      thousands of ops), and commit_and_close streams
        {"id": 8, "event": "heartbeat"}
      every 10 s. Both re-arm Node's per-RPC timeout. Additive to protocol 1:
      an older host treats the progress frames as unsubscribed events.

Cancellation is best-effort: a cancel flag is checked between rows, not
mid-pyrekordbox call. The scan returns the watermarks it managed to reach
before the cancel, so the importer can persist them.
"""

from __future__ import annotations

import json
import shutil
import sys
import threading
import traceback
from typing import Any, Optional

# Force UTF-8 stdio BEFORE anything reads or writes a frame. The Node host
# encodes/decodes all three pipes as UTF-8, and the dev venv honours the
# PYTHONIOENCODING=utf-8 the host injects — but the PyInstaller bootloader
# initializes Python ignoring PYTHON* env vars, so the FROZEN sidecar falls
# back to the console codepage (cp1252 on Windows). Two prod-only failures
# dev can't reproduce, both from that fallback:
#   • stdout/stderr ENCODE: any non-Latin-1 char in a delta event or a
#     diagnostic ('ğ' in a title, the U+FFFD our sanitizer emits) raises
#     UnicodeEncodeError('charmap') and kills the whole pass.
#   • stdin DECODE: write-batch params (artist/title/album/comment/playlist
#     names) arrive as UTF-8 bytes but get decoded as cp1252, silently
#     mojibake-ing every non-ASCII char before it's written to rekordbox
#     (e.g. 'André' → 'AndrÃ©', compounding a layer per push cycle). This is
#     the nastier one — no crash, just corruption landing in master.db.
# reconfigure() is deterministic in both runtimes. stderr uses
# backslashreplace so a diagnostic can never throw; stdin/stdout stay strict
# so a genuinely malformed frame surfaces rather than corrupting silently.
for _stream, _errors in ((sys.stdin, "strict"), (sys.stdout, "strict"), (sys.stderr, "backslashreplace")):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors=_errors)

# Apply pyrekordbox monkey-patches BEFORE any sibling module imports —
# reader/writer/verifier all import pyrekordbox at module load, which bakes
# the parse-time Struct definitions into `pyrekordbox.anlz.structs`. Our
# patches mutate those structs in place; running them first means every
# downstream import sees the relaxed parser. See _pyrekordbox_patches.py
# for the catalogue (today: PQT2.u1 Const relaxed for RB7 compatibility).
from ._pyrekordbox_patches import apply_pyrekordbox_patches
apply_pyrekordbox_patches()

from . import backup as backup_mod
from . import palette as palette_mod
from . import writer as writer_mod
from . import verifier as verifier_mod
from . import reader as reader_mod
from .reader import (
    detect_default_db_path,
    is_rekordbox_running,
    open_db,
    scan,
    snapshot_db_to_temp,
)


# `temp_dir` is the snapshot directory we copied master.db (+ wal/shm) into
# for the current open(). The actual db file lives at f"{temp_dir}/master.db".
# We delete the whole dir when reopening or shutting down — see
# `_close_current_db()`. A single-slot model means we never accumulate
# snapshots even if open() is called repeatedly.
#
# `mode` distinguishes a read-side `open` (which uses a temp snapshot) from
# a write-side `open_for_write` (which opens the real master.db). The
# cleanup logic in `_close_current_db` only rmtrees temp_dir when mode is
# "read" — there's no temp dir for write opens.
_db_state: dict[str, Any] = {
    "db": None,
    "path": None,
    "temp_dir": None,
    "mode": None,  # "read" | "write" | None
}
_cancel_flag = threading.Event()
_scan_lock = threading.Lock()

# Wire-format version of the JSON-RPC protocol documented above. The Node
# host (apps/core/src/rekordbox/sidecar.ts) refuses to talk to a sidecar
# announcing a different protocol.
PROTOCOL_VERSION = 1


# Serializes stdout frames. Scans already write from a worker thread (the
# dispatch loop stays on main), and the commit heartbeat below adds another
# writer — without the lock two threads can interleave mid-line and corrupt
# a frame.
_write_lock = threading.Lock()


def _write(payload: dict[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False, default=_jsonable)
    with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _jsonable(obj: Any) -> Any:
    try:
        import numpy as np
        if isinstance(obj, np.generic):
            return obj.item()
    except Exception:
        pass
    raise TypeError(f"not JSON-serializable: {type(obj).__name__}")


def _classify(exc: BaseException) -> str:
    msg = str(exc).lower()
    if "sqlcipher" in msg or "encryption" in msg or "key" in msg:
        return "key"
    if "no such file" in msg or "open" in msg:
        return "db_missing"
    if "lock" in msg:
        return "db_locked"
    return "internal"


def _rollback_quietly(db: Any) -> None:
    """Reset a session after a failed commit. Without this the session is
    left pending-rollback and every later statement (a retry, the close
    path's bookkeeping) raises PendingRollbackError instead of the real
    problem. Best-effort: a rollback failure means the session is already
    unusable, which the caller is reporting anyway."""
    try:
        db.session.rollback()
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"rollback after failed commit also failed: {exc}\n")


def _close_current_db() -> None:
    """Tear down the in-process db handle AND its temp snapshot directory.

    Safe to call when nothing is open (no-op). Used by `_handle_open` /
    `_handle_open_for_write` to drop a prior session before opening a
    new one, and by `main()`'s finally on sidecar shutdown.

    `temp_dir` only exists for read-side opens; write opens go against
    the real master.db so there's nothing to rmtree. The branch keeps
    the read-side guarantee ("the snapshot dir always gets cleaned up")
    while letting write opens close cheaply.
    """
    db = _db_state.get("db")
    if db is not None and _db_state.get("mode") == "write":
        # A write session closing without a successful commit (reopen,
        # shutdown, crash in the loop) drops its staged rows — undo the
        # share/ copies and XML nodes those rows owned. No-op after a
        # commit: writer's after_commit hook has already forgotten them.
        # Roll back FIRST: the compensators ask the DB which rows survived,
        # and an open transaction would still show the doomed ones.
        _rollback_quietly(db)
        writer_mod.discard_uncommitted_side_effects(db)
    if db is not None:
        try: db.close()
        except Exception: pass
    temp_dir = _db_state.get("temp_dir")
    if temp_dir:
        shutil.rmtree(temp_dir, ignore_errors=True)
    _db_state["db"] = None
    _db_state["path"] = None
    _db_state["temp_dir"] = None
    _db_state["mode"] = None


def _handle_open(req_id: int, params: dict[str, Any]) -> None:
    db_path = params.get("dbPath")
    key = params.get("key")
    if not db_path:
        _write({"id": req_id, "error": {"kind": "internal", "message": "missing dbPath"}})
        return

    # Drop any prior session + its snapshot first so we never hold two
    # snapshots simultaneously.
    _close_current_db()

    # Snapshot master.db so the reader can't contend with a running
    # rekordbox writer (and so we never hold an open handle on the
    # user's real master.db). `db_dir` on the open call points back at
    # the original directory so pyrekordbox still resolves share/ ANLZ
    # and masterPlaylists6.xml from there.
    try:
        snap_db_path, temp_dir, original_dir = snapshot_db_to_temp(db_path)
    except Exception as exc:  # noqa: BLE001
        _write({"id": req_id, "error": {"kind": _classify(exc), "message": f"snapshot failed: {exc}"}})
        return

    try:
        db = open_db(snap_db_path, key, db_dir=original_dir)
    except Exception as exc:  # noqa: BLE001
        # Open failed — we still hold the temp snapshot. Clean it up
        # immediately so a bad-key/missing-file error doesn't leak a copy.
        shutil.rmtree(temp_dir, ignore_errors=True)
        _write({"id": req_id, "error": {"kind": _classify(exc), "message": str(exc)}})
        return

    _db_state["db"] = db
    _db_state["path"] = db_path
    _db_state["temp_dir"] = temp_dir
    _db_state["mode"] = "read"
    _write({"id": req_id, "result": {"ok": True, "path": db_path}})


# ──────────────────────────────────────────────────────────────────────────────
# Write-side handlers — see writer.py / verifier.py / backup.py for the
# actual mechanics. These all reject when called against the wrong open
# mode, so a misbehaving client can't e.g. apply_write_batch to a
# read-side snapshot (which would write into the temp dir and discard
# everything on close — silent-broken).

def _handle_backup(req_id: int, params: dict[str, Any]) -> None:
    db_path = params.get("dbPath")
    if not db_path:
        _write({"id": req_id, "error": {"kind": "internal", "message": "missing dbPath"}})
        return
    try:
        result = backup_mod.backup_master_db(db_path)
    except Exception as exc:  # noqa: BLE001
        _write({"id": req_id, "error": {"kind": _classify(exc), "message": str(exc)}})
        return
    _write({"id": req_id, "result": result})


# djmdProperty.DBVersion is the master.db *schema generation* — NOT the
# rekordbox application version. Rekordbox 6 and 7 share the same encrypted
# db6 schema (which is exactly why one pyrekordbox db6 module + the PQT2 ANLZ
# patch in _pyrekordbox_patches serves both), so both report "6000". A future
# rekordbox that restructures tables would bump this marker, and writing by PK
# into a shifted schema is the silent-corruption case — so we allowlist the
# generations we've actually exercised and refuse anything else, fail-closed.
#
# (An earlier version of this gate parsed the leading digits of DBVersion as an
# app "major" and checked it against (6, 7); that mistook "6000" for major 6000
# and refused every real library.)
SUPPORTED_RB_DB_SCHEMA_VERSIONS = ("6000",)


def _check_db_version_for_write(db: Any) -> Optional[str]:
    """Return an error message when the opened master.db announces a schema
    generation this writer hasn't been validated against; None when ok.

    Failing to read djmdProperty.DBVersion at all means we're NOT looking at a
    rekordbox 6/7 master.db and is treated as a refusal too — this guard
    protects writes, so it fails closed.
    """
    try:
        from sqlalchemy import text
        raw = db.session.execute(text("SELECT DBVersion FROM djmdProperty LIMIT 1")).scalar()
    except Exception as exc:  # noqa: BLE001
        return f"could not read djmdProperty.DBVersion ({exc}) — not a rekordbox 6/7 master.db?"
    version = str(raw or "").strip()
    if not version:
        return "djmdProperty.DBVersion is empty — refusing to write to an unidentified master.db"
    if version not in SUPPORTED_RB_DB_SCHEMA_VERSIONS:
        supported = ", ".join(SUPPORTED_RB_DB_SCHEMA_VERSIONS)
        return (
            f"rekordbox DB schema version {version!r} is not supported for writes "
            f"(validated against: {supported}). Refusing rather than "
            f"risking corruption of Pioneer's database."
        )
    return None


def _handle_open_for_write(req_id: int, params: dict[str, Any]) -> None:
    """Open master.db for writes — no snapshot, the real file.

    Mirrors `_handle_open`'s lifecycle (close any prior session first,
    capture the open in `_db_state`) but with no temp dir and
    `mode='write'`. Subsequent apply_write_batch / commit_and_close
    calls operate on this session.
    """
    db_path = params.get("dbPath")
    key = params.get("key")
    if not db_path:
        _write({"id": req_id, "error": {"kind": "internal", "message": "missing dbPath"}})
        return

    _close_current_db()

    try:
        # No db_dir override needed — write opens use the real master.db,
        # which lives in its real directory with share/ + masterPlaylists6.xml
        # next to it. pyrekordbox's default behavior is correct here.
        db = open_db(db_path, key)
    except Exception as exc:  # noqa: BLE001
        _write({"id": req_id, "error": {"kind": _classify(exc), "message": str(exc)}})
        return

    # Version gate BEFORE the session is exposed to write RPCs. Read-side
    # opens stay ungated — reading a future schema degrades to per-row
    # errors, but writing into one by PK is how you corrupt a library.
    version_error = _check_db_version_for_write(db)
    if version_error:
        try:
            db.close()
        except Exception:  # noqa: BLE001
            pass
        _write({"id": req_id, "error": {"kind": "unsupported_rb_version", "message": version_error}})
        return

    _db_state["db"] = db
    _db_state["path"] = db_path
    _db_state["temp_dir"] = None
    _db_state["mode"] = "write"
    _write({"id": req_id, "result": {"ok": True, "path": db_path}})


def _require_write_session(req_id: int) -> bool:
    """Guard for write RPCs. Emits an error frame + returns False when
    the current session is missing or open in read mode. Returns True
    when we're ready to write."""
    if _db_state.get("mode") != "write" or _db_state.get("db") is None:
        _write({"id": req_id, "error": {
            "kind": "internal",
            "message": "open_for_write() must be called before write operations",
        }})
        return False
    return True


def _handle_apply_write_batch(req_id: int, params: dict[str, Any]) -> None:
    if not _require_write_session(req_id):
        return
    db = _db_state["db"]
    ops = params.get("ops") or []

    # Progress frames ride the request id (Node routes them to this call's
    # sink and re-arms its timeout); writer.apply_batch throttles the cadence.
    def _progress(done: int, total: int) -> None:
        _write({"id": req_id, "event": "progress", "done": done, "total": total})

    try:
        results = writer_mod.apply_batch(db, ops, on_progress=_progress)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(traceback.format_exc())
        _write({"id": req_id, "error": {"kind": _classify(exc), "message": str(exc)}})
        return
    _write({"id": req_id, "result": {"results": results}})


def _handle_commit_and_close(req_id: int, params: dict[str, Any]) -> None:
    """Commit the staged writes, read back the post-commit
    djmdContent.updated_at for every track the Node side claims to have
    written, then close the session. The baselines are returned so the
    exporter can advance `rekordboxLink.rbUpdatedAtSeen` — without that,
    the next read pass would see "rb changed" and roll our writes back.

    pyrekordbox.commit() raises RuntimeError if rekordbox is running
    (see db6/database.py:418-422). We classify that as `db_locked`.
    """
    if not _require_write_session(req_id):
        return
    db = _db_state["db"]
    written_ids = list(params.get("writtenRbContentIds") or [])

    # Heartbeat while the commit runs. Big libraries can spend minutes in
    # SQLCipher flushes + masterPlaylists6.xml rewrites; without a liveness
    # signal the Node side's RPC timeout can't tell "slow" from "hung" and
    # may report failure for a commit that later succeeds — desyncing the
    # rb_updated_at_seen baselines. Node resets its timeout per heartbeat.
    # No progress frames: db.commit() is one pyrekordbox call with no hook
    # to report through, so the exporter brackets it as phase 'commit' 0/1.
    hb_stop = threading.Event()

    def _heartbeat() -> None:
        while not hb_stop.wait(10.0):
            _write({"id": req_id, "event": "heartbeat"})

    hb_thread = threading.Thread(target=_heartbeat, daemon=True)
    hb_thread.start()

    try:
        try:
            db.commit()  # auto-bumps rb_local_usn for every changed row
        except RuntimeError as exc:
            # Most likely "Rekordbox is running" — surface as db_locked so
            # the Node side can paint the right error message. Roll back so
            # the session isn't left pending-rollback — a retry (or the
            # close path) would otherwise hit PendingRollbackError instead
            # of the real problem.
            _rollback_quietly(db)
            # The rollback dropped every staged row, so the share/ copies
            # and XML nodes content_create/playlist_create made for them
            # are orphans now.
            writer_mod.discard_uncommitted_side_effects(db)
            _write({"id": req_id, "error": {"kind": "db_locked", "message": str(exc)}})
            return
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(traceback.format_exc())
            _rollback_quietly(db)
            # No-op when the DB transaction itself landed and only
            # pyrekordbox's later XML save raised (after_commit already
            # cleared the list) — committed rows keep their files.
            writer_mod.discard_uncommitted_side_effects(db)
            _write({"id": req_id, "error": {"kind": _classify(exc), "message": str(exc)}})
            return
    finally:
        hb_stop.set()

    # Post-commit read-back of updated_at for the written tracks.
    # We read from the same session before closing it; the values are
    # whatever the commit just stamped.
    baselines: dict[str, Optional[int]] = {}
    for cid in written_ids:
        try:
            row = db.get_content(ID=str(cid))  # PK lookup returns row or None
            if row is None:
                baselines[cid] = None
                continue
            ts = getattr(row, "updated_at", None)
            baselines[cid] = int(ts.timestamp() * 1000) if ts is not None else None
        except Exception:
            baselines[cid] = None

    # Close so the verify pass (which snapshot+opens the real db) can
    # run without contending with our writer.
    _close_current_db()
    _write({"id": req_id, "result": {"baselines": baselines}})


def _handle_verify(req_id: int, params: dict[str, Any]) -> None:
    db_path = params.get("dbPath")
    key = params.get("key")
    expected = list(params.get("expectedWrites") or [])
    if not db_path:
        _write({"id": req_id, "error": {"kind": "internal", "message": "missing dbPath"}})
        return
    try:
        result = verifier_mod.verify(db_path, key, expected)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(traceback.format_exc())
        _write({"id": req_id, "error": {"kind": _classify(exc), "message": str(exc)}})
        return
    _write({"id": req_id, "result": result})


def _handle_list_stale_relations(req_id: int, params: dict[str, Any]) -> None:
    db_path = params.get("dbPath")
    key = params.get("key")
    if not db_path:
        _write({"id": req_id, "error": {"kind": "internal", "message": "missing dbPath"}})
        return
    try:
        stale = reader_mod.list_stale_relations(db_path, key)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(traceback.format_exc())
        _write({"id": req_id, "error": {"kind": _classify(exc), "message": str(exc)}})
        return
    _write({"id": req_id, "result": {"stale": stale}})


def _handle_list_backups(req_id: int, params: dict[str, Any]) -> None:
    db_dir = params.get("dbDir")
    if not db_dir:
        _write({"id": req_id, "error": {"kind": "internal", "message": "missing dbDir"}})
        return
    try:
        result = backup_mod.list_backups(db_dir)
    except Exception as exc:  # noqa: BLE001
        _write({"id": req_id, "error": {"kind": _classify(exc), "message": str(exc)}})
        return
    _write({"id": req_id, "result": {"backups": result}})


def _handle_clear_backups(req_id: int, params: dict[str, Any]) -> None:
    db_dir = params.get("dbDir")
    if not db_dir:
        _write({"id": req_id, "error": {"kind": "internal", "message": "missing dbDir"}})
        return
    try:
        result = backup_mod.clear_backups(db_dir)
    except Exception as exc:  # noqa: BLE001
        _write({"id": req_id, "error": {"kind": _classify(exc), "message": str(exc)}})
        return
    _write({"id": req_id, "result": result})


def _handle_restore_backup(req_id: int, params: dict[str, Any]) -> None:
    backup_path = params.get("backupPath")
    db_path = params.get("dbPath")
    if not backup_path or not db_path:
        _write({"id": req_id, "error": {"kind": "internal", "message": "missing backupPath or dbPath"}})
        return
    # Sanity: if a write session is open against the same db_path, close
    # it first so the file-level swap doesn't race a live session.
    if _db_state.get("mode") == "write":
        _close_current_db()
    try:
        backup_mod.restore_backup(backup_path, db_path)
    except Exception as exc:  # noqa: BLE001
        _write({"id": req_id, "error": {"kind": _classify(exc), "message": str(exc)}})
        return
    _write({"id": req_id, "result": {"ok": True}})


def _handle_list_cue_palette(req_id: int) -> None:
    # Static read — no db open required. The palette module owns every fact
    # about rb's cue color encoding; everything above this RPC sees opaque
    # `cti:N` ids and renderable hex strings.
    _write({"id": req_id, "result": {"entries": palette_mod.list_cue_palette()}})


def _handle_detect(req_id: int) -> None:
    path = detect_default_db_path()
    _write({
        "id": req_id,
        "result": {
            "dbPath": path,
            "running": is_rekordbox_running(),
        },
    })


def _handle_scan(req_id: int, params: dict[str, Any]) -> None:
    db = _db_state.get("db")
    if not db:
        _write({"id": req_id, "error": {"kind": "internal", "message": "open() must be called before scan()"}})
        return
    if not _scan_lock.acquire(blocking=False):
        _write({"id": req_id, "error": {"kind": "internal", "message": "another scan is already in flight"}})
        return
    try:
        _cancel_flag.clear()
        watermarks = dict(params.get("watermarks") or {})
        scopes = params.get("scopes") or ["metadata", "analysis"]
        peaks_dir = params.get("peaksDir")
        # When true, the waveform pass bypasses the per-row .cpk freshness
        # gate so beatgrid events fire for every linked track regardless of
        # whether the .cpk on disk is current. Used by the "Sync grids from
        # Rekordbox" remediation flow — the Node importer also bypasses LMW
        # on the beatgrid write when this is set.
        force_refresh_grids = bool(params.get("forceRefreshGrids", False))
        # Scoped "Sync from Rekordbox" targeting. When present, the reader
        # restricts every pass to these ids (playlist ids expand to their
        # member content ids) and ignores the USN watermark for targeted
        # rows. Absent → whole-library incremental (the normal read sync).
        target_content_ids = params.get("targetContentIds")
        target_playlist_ids = params.get("targetPlaylistIds")

        def emit(event: str, row: dict[str, Any]) -> None:
            _write({"id": req_id, "event": event, "row": row} if event != "progress"
                   else {"id": req_id, "event": event, **row})

        # Heartbeat while the scan runs — same pattern as commit_and_close.
        # Scans routinely outlive the Node side's default 30s RPC timeout
        # (a forced ANLZ re-read alone takes minutes on a few thousand
        # tracks), and some sections are silent for long stretches (big
        # upfront table fetches before the first progress frame). Node
        # re-arms the pending timeout per heartbeat, so "slow" never reads
        # as "hung" while a genuinely dead sidecar still times out.
        hb_stop = threading.Event()

        def _heartbeat() -> None:
            while not hb_stop.wait(10.0):
                _write({"id": req_id, "event": "heartbeat"})

        hb_thread = threading.Thread(target=_heartbeat, daemon=True)
        hb_thread.start()

        try:
            new_marks = scan(
                db=db,
                watermarks=watermarks,
                scopes=scopes,
                peaks_dir=peaks_dir,
                emit=emit,
                is_cancelled=_cancel_flag.is_set,
                force_refresh_grids=force_refresh_grids,
                target_content_ids=target_content_ids,
                target_playlist_ids=target_playlist_ids,
            )
            cancelled = _cancel_flag.is_set()
            _write({"id": req_id, "result": {"watermarks": new_marks, "cancelled": cancelled}})
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(traceback.format_exc())
            _write({"id": req_id, "error": {"kind": _classify(exc), "message": str(exc)}})
        finally:
            hb_stop.set()
            hb_thread.join(timeout=1.0)
    finally:
        _scan_lock.release()


def _handle_cancel(req_id: Optional[int]) -> None:
    _cancel_flag.set()
    if req_id is not None:
        _write({"id": req_id, "result": {"ok": True}})


def _dispatch(msg: dict[str, Any]) -> None:
    method = msg.get("method")
    req_id = msg.get("id")
    params = msg.get("params") or {}
    if method == "open":
        _handle_open(req_id, params)
    elif method == "scan":
        # Scans can run for minutes — dispatch on a thread so subsequent
        # cancel requests on the main loop can flip the flag.
        threading.Thread(target=_handle_scan, args=(req_id, params), daemon=True).start()
    elif method == "detect":
        _handle_detect(req_id)
    elif method == "cancel":
        _handle_cancel(req_id)
    elif method == "backup":
        _handle_backup(req_id, params)
    elif method == "open_for_write":
        _handle_open_for_write(req_id, params)
    elif method == "apply_write_batch":
        # Kept on the dispatch thread — there's no cancel signal to service
        # mid-call, and the write session isn't thread-safe. A big batch can
        # run tens of seconds; it streams progress frames (which also keep
        # Node's RPC timeout armed) instead of going silent.
        _handle_apply_write_batch(req_id, params)
    elif method == "commit_and_close":
        _handle_commit_and_close(req_id, params)
    elif method == "verify":
        _handle_verify(req_id, params)
    elif method == "list_backups":
        _handle_list_backups(req_id, params)
    elif method == "list_stale_relations":
        _handle_list_stale_relations(req_id, params)
    elif method == "clear_backups":
        _handle_clear_backups(req_id, params)
    elif method == "restore_backup":
        _handle_restore_backup(req_id, params)
    elif method == "list_cue_palette":
        _handle_list_cue_palette(req_id)
    elif method == "shutdown":
        sys.exit(0)
    else:
        _write({"id": req_id, "error": {"kind": "internal", "message": f"unknown method {method!r}"}})


def main() -> None:
    # Silence pyrekordbox's per-tag noise. Its ANLZ parser logs a WARNING
    # for every unknown tag (PVB2, PVDI, etc — Pioneer-internal markers we
    # don't read anyway), and across 5000+ tracks that's tens of thousands
    # of lines in the dev terminal. Bumped to ERROR so real parse failures
    # (corrupt files, library version drift) still surface.
    import logging
    logging.getLogger("pyrekordbox.anlz.file").setLevel(logging.ERROR)
    # On every commit pyrekordbox loops over ALL playlists and logs a WARNING
    # for any that aren't in the legacy masterPlaylists6.xml manifest (rekordbox
    # 7 doesn't keep that XML fully mirrored with the DB). We write the DB
    # directly and don't depend on the XML, so these are pure noise — dozens of
    # lines per sync. Bumped to ERROR so genuine db6 failures still surface.
    logging.getLogger("pyrekordbox.db6.database").setLevel(logging.ERROR)

    # Stderr banner — main process captures this and prints it, so we can
    # confirm at a glance which sidecar build is actually running. (After a
    # code edit, restart the dev server and look for this line to verify
    # the new module loaded; otherwise the Python module cache still holds
    # the previously-imported reader.py.)
    from . import REKORDBOX_ADAPTER_VERSION
    sys.stderr.write(f"sidecar v{REKORDBOX_ADAPTER_VERSION} ready\n")
    sys.stderr.flush()
    # Hello handshake — FIRST stdout frame, before any request is read. The
    # Node host validates name + protocol so a stale bundled binary (or the
    # wrong executable) is caught at spawn instead of failing on the first
    # real RPC with a confusing error.
    _write({
        "event": "hello",
        "name": "curator-rekordbox",
        "version": REKORDBOX_ADAPTER_VERSION,
        "protocol": PROTOCOL_VERSION,
    })
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as exc:
                _write({"id": None, "error": {"kind": "internal", "message": f"bad json: {exc}"}})
                continue
            try:
                _dispatch(msg)
            except SystemExit:
                raise
            except Exception as exc:  # noqa: BLE001
                _write({"id": msg.get("id"), "error": {"kind": "internal", "message": str(exc)}})
    finally:
        # Closes the db handle AND deletes the temp snapshot dir — the
        # "finally clause to avoid garbage" guarantee for the snapshot
        # lives here so a crash mid-loop still cleans up.
        _close_current_db()


if __name__ == "__main__":
    main()
