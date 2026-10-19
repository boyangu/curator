"""Post-write verification — runs against a temp snapshot of the
just-committed master.db, NOT the live file.

Snapshotting first means:
  - We never hold an open SQLAlchemy session on master.db while the user
    might be about to relaunch rekordbox. The verify pass can't lock the
    real file.
  - PRAGMA integrity_check inside a fresh handle catches corruption
    that the active writer session might have masked.

Two checks per verify run:
  1. PRAGMA integrity_check + PRAGMA quick_check on the snapshot. Cheap.
     Catches structural corruption — torn writes, page checksum
     failures, broken indexes.
  2. Per-row diff against the writes the Node side claimed to make.
     Reads each row back and compares field values. Catches write-side
     bugs ("we wrote the wrong Title") that integrity_check wouldn't.

The two checks complement each other; the plan calls for both. Either
failing marks the sync as verification-failed and surfaces the
restore-or-leave modal upstream.
"""

from __future__ import annotations

import shutil
import sys
from typing import Any, Optional

from sqlalchemy import text

from .reader import open_db, snapshot_db_to_temp


def _pragma_check(db: Any) -> Optional[str]:
    """Run PRAGMA quick_check on the open snapshot session.

    quick_check is page-level corruption detection — torn writes, broken
    checksums, structurally invalid pages — and runs in seconds even on
    an 80MB SQLCipher master.db. We previously also ran integrity_check
    (which adds index/UNIQUE validation), but that takes 30s–2min on
    encrypted DBs and the extra coverage isn't worth the latency: a
    write that corrupts an index also corrupts the page that holds it,
    so quick_check catches the failure modes we actually see from a
    botched commit.

    Returns None on success, or a human-readable error string on failure.
    SQLAlchemy's `session.execute(text("PRAGMA ..."))` returns a cursor
    yielding one row with one column ("ok" or an error message).
    """
    try:
        result = db.session.execute(text("PRAGMA quick_check")).fetchall()
    except Exception as exc:  # noqa: BLE001
        return f"PRAGMA quick_check raised: {type(exc).__name__}: {exc}"
    rows = [str(r[0]) for r in result] if result else []
    if rows != ["ok"]:
        return f"PRAGMA quick_check failed: {'; '.join(rows) or '(no rows)'}"
    return None


def _verify_track_metadata(db: Any, op: dict[str, Any]) -> Optional[str]:
    """Read the DjmdContent row back and compare to the fields we wrote.

    Same diff rules as writer._set_if_changed: None ≡ "" for nullable
    text columns. Relationship fields (ArtistName/AlbumName/LabelName)
    are read off the joined row's `.Name`, which pyrekordbox surfaces
    via the relationship attribute.
    """
    cid = op["rb_content_id"]
    row = db.get_content(ID=cid)  # PK lookup returns row or None
    if row is None:
        return f"track {cid}: row missing after write"

    def matches(actual, expected) -> bool:
        if actual == expected:
            return True
        if (actual is None and expected == "") or (actual == "" and expected is None):
            return True
        return False

    from .writer import _sanitize_strings

    # A relation row rekordbox has tombstoned (rb_local_deleted=1) is
    # invisible in its UI, so for verification it counts as NO value even
    # though the relationship still resolves a Name. Without this the
    # writer's old tombstone binding verified clean (see writer.py's
    # lookup-or-create header).
    def rel_name(attr: str) -> Optional[str]:
        rel = getattr(row, attr, None)
        if rel is None or bool(getattr(rel, "rb_local_deleted", 0)):
            return None
        return getattr(rel, "Name", None)

    fields = op.get("fields") or {}
    for fname, expected in fields.items():
        # The writer scrubs lone surrogates → U+FFFD before storing (see
        # writer._sanitize_strings), so the read-back value is scrubbed too.
        # Compare against the scrubbed `expected` — otherwise a correctly-
        # written-but-scrubbed string (e.g. a title Node handed us with a lone
        # surrogate) false-fails verification and triggers a spurious
        # restore-or-leave prompt. No-op for clean strings and non-strings.
        expected = _sanitize_strings(expected)
        if fname == "Title":
            actual = getattr(row, "Title", None)
        elif fname == "ArtistName":
            actual = rel_name("Artist")
        elif fname == "AlbumName":
            actual = rel_name("Album")
        elif fname == "LabelName":
            actual = rel_name("Label")
        elif fname == "GenreName":
            actual = rel_name("Genre")
        elif fname == "Rating":
            actual = getattr(row, "Rating", None)
        elif fname == "Comment":
            actual = getattr(row, "Commnt", None)
        elif fname == "Color":
            # Stored as ColorID; compare in name space (what the op carried).
            from .reader import _COLOR_ID_TO_NAME
            actual = _COLOR_ID_TO_NAME.get(int(getattr(row, "ColorID", 0) or 0))
            # Unknown palette names are skipped by the writer, not written —
            # mirror that here by accepting any value when the expected name
            # isn't one the writer could have written.
            from .writer import _COLOR_NAME_TO_ID
            if expected and expected not in _COLOR_NAME_TO_ID:
                continue
        else:
            continue
        if not matches(actual, expected):
            return f"track {cid}: {fname} expected {expected!r}, got {actual!r}"
    return None


def _verify_cues(db: Any, op: dict[str, Any]) -> Optional[str]:
    """Confirm every cue the writer claimed to write is present in rb.

    Per-cue structural check: for each cue in `op["cues"]`, locate at
    least one matching DjmdCue row by (InMsec, Kind). We don't require
    the dual-row pattern in the check itself — rb auto-creates extra
    rows (e.g. memory cues at track-start) that aren't part of our op,
    and a strict count compare would flag those as failures.

    What we DO catch: a cue the writer claimed to insert but isn't
    actually in master.db post-commit (write dropped or rolled back).
    """
    from pyrekordbox.db6.tables import DjmdCue  # type: ignore
    from .reader import _HOT_KIND_TO_SLOT
    _SLOT_TO_HOT_KIND = {slot: kind for kind, slot in _HOT_KIND_TO_SLOT.items()}

    cid = op["rb_content_id"]
    rows = list(db.session.query(DjmdCue).filter_by(ContentID=str(cid)).all())
    # Index by (InMsec, Kind) for fast lookup. Multiple rows per key are
    # expected (dual-row pattern); we only need to confirm presence.
    present: set[tuple[int, int]] = set(
        (int(r.InMsec or 0), int(r.Kind or 0)) for r in rows
    )

    missing: list[str] = []
    for c in op.get("cues") or []:
        in_ms = int(round(float(c.get("position_sec", 0.0)) * 1000.0))
        kind_str = c.get("kind", "hot")
        if kind_str == "hot":
            slot = int(c.get("slot", 0))
            kind_val = _SLOT_TO_HOT_KIND.get(slot)
            if kind_val is None:
                # Writer would've skipped this with a stderr warning;
                # don't flag it here either.
                continue
        else:
            kind_val = 0
        if (in_ms, kind_val) not in present:
            missing.append(f"InMsec={in_ms} Kind={kind_val}")

    if missing:
        return f"cues {cid}: {len(missing)} cue(s) missing post-commit: {'; '.join(missing[:5])}"
    return None


def _verify_tags(db: Any, op: dict[str, Any]) -> Optional[str]:
    """Confirm the DjmdSongMyTag membership matches the tag IDs we
    claimed to write."""
    from pyrekordbox.db6.tables import DjmdMyTag, DjmdSongMyTag  # type: ignore
    cid = op["rb_content_id"]
    rows = list(db.session.query(DjmdSongMyTag).filter_by(ContentID=str(cid)).all())
    actual_tag_ids = {str(r.MyTagID) for r in rows}
    expected_tag_ids = {str(t) for t in op.get("rb_tag_ids") or []}
    if actual_tag_ids != expected_tag_ids:
        missing = expected_tag_ids - actual_tag_ids
        extra = actual_tag_ids - expected_tag_ids
        return f"tags {cid}: missing={sorted(missing)} extra={sorted(extra)}"
    # A membership row is only visible if its MyTag row is live — the writer
    # revives tombstoned tags it references, so a dead one here is a failure.
    dead = []
    for tag_id in sorted(expected_tag_ids):
        tag_row = db.session.get(DjmdMyTag, tag_id) if hasattr(db.session, "get") else None
        if tag_row is None or bool(getattr(tag_row, "rb_local_deleted", 0)):
            dead.append(tag_id)
    if dead:
        return f"tags {cid}: MyTag rows missing or tombstoned={dead}"
    return None


def _verify_playlist_merge(db: Any, op: dict[str, Any]) -> Optional[str]:
    """Confirm a targeted membership merge landed: removed ids gone, added
    ids present, and (when order was pushed) the known members in that
    relative order. Members Curator doesn't manage are explicitly NOT
    asserted — the whole point is that the merge leaves them untouched."""
    from pyrekordbox.db6.tables import DjmdSongPlaylist  # type: ignore
    pid = op["rb_playlist_id"]
    playlist = db.get_playlist(ID=pid)  # PK lookup returns row or None
    if playlist is None:
        return f"playlist {pid}: row missing after write"

    if "name" in op and op["name"] is not None:
        actual_name = getattr(playlist, "Name", None)
        if actual_name != op["name"]:
            return f"playlist {pid}: Name expected {op['name']!r}, got {actual_name!r}"

    rows = list(
        db.session.query(DjmdSongPlaylist)
        .filter_by(PlaylistID=str(pid))
        .order_by(DjmdSongPlaylist.TrackNo)
        .all()
    )
    actual_ids = [str(r.ContentID) for r in rows]
    actual_set = set(actual_ids)

    for cid in (str(x) for x in (op.get("remove") or [])):
        if cid in actual_set:
            return f"playlist {pid}: content {cid} expected removed, still present"
    for entry in (op.get("add") or []):
        cid = str(entry["rb_content_id"])
        if cid not in actual_set:
            return f"playlist {pid}: content {cid} expected added, missing"

    order = op.get("order")
    if order is not None:
        want_set = {str(x) for x in order if str(x) in actual_set}
        want = [str(x) for x in order if str(x) in actual_set]
        got = [cid for cid in actual_ids if cid in want_set]
        if got != want:
            # Concise, actionable summary — these playlists can hold 1000+
            # tracks, so never dump the full id arrays into the message.
            from collections import Counter
            dups = {c: n for c, n in Counter(got).items() if n > 1}
            if dups:
                sample = ", ".join(f"{c}×{n}" for c, n in list(dups.items())[:3])
                more = "" if len(dups) <= 3 else f" (+{len(dups) - 3} more)"
                return f"playlist {pid}: {len(dups)} duplicate track row(s): {sample}{more}"
            # Same membership, different sequence — report first divergence.
            for i, (g, w) in enumerate(zip(got, want)):
                if g != w:
                    return f"playlist {pid}: order mismatch at position {i + 1} (expected {w}, got {g})"
            return f"playlist {pid}: order length mismatch (expected {len(want)}, got {len(got)})"
    return None


def _verify_content_delete(db: Any, op: dict[str, Any]) -> Optional[str]:
    """Confirm the DjmdContent row is gone-or-tombstoned. A missing row
    passes too — deleted harder than we asked for is still deleted (rb
    itself may hard-remove flagged rows during its own maintenance)."""
    cid = op["rb_content_id"]
    row = db.get_content(ID=cid)
    if row is None:
        return None
    if not bool(getattr(row, "rb_local_deleted", 0)):
        return f"content {cid}: expected rb_local_deleted, row still live"
    return None


def _verify_content_create(db: Any, op: dict[str, Any]) -> Optional[str]:
    """Confirm a created/revived content row: live, at the normalised
    FolderPath, typed WAV for .wav files, and — when analysis was copied —
    pointing at a DAT that exists under share/ and whose PPTH names this
    file. PPTH is accepted in either form rekordbox writes: the full
    FolderPath, or rekordbox 7's "?/<file name>" (see anlz_copy)."""
    from pathlib import Path
    from . import anlz_copy
    from .writer import normalize_folder_path

    cid = op["rb_content_id"]
    row = db.get_content(ID=str(cid))
    if row is None:
        return f"content {cid}: row missing after create"
    if bool(getattr(row, "rb_local_deleted", 0)):
        return f"content {cid}: row is soft-deleted after create"
    expected_path = normalize_folder_path(op["path"])
    actual_path = getattr(row, "FolderPath", None)
    if actual_path != expected_path:
        return f"content {cid}: FolderPath expected {expected_path!r}, got {actual_path!r}"
    if expected_path.lower().endswith(".wav") and int(getattr(row, "FileType", 0) or 0) != 11:
        return f"content {cid}: FileType expected 11 (WAV), got {getattr(row, 'FileType', None)!r}"
    if op.get("anlz_copied"):
        rel = getattr(row, "AnalysisDataPath", None)
        if not rel:
            return f"content {cid}: AnalysisDataPath empty but analysis was copied"
        dat = Path(db.share_directory) / rel.strip("/\\")
        if not dat.is_file():
            return f"content {cid}: ANLZ DAT missing at {dat}"
        ppth = anlz_copy.read_ppth(dat.read_bytes())
        if not anlz_copy.ppth_matches(ppth, actual_path):
            return f"content {cid}: ANLZ PPTH {ppth!r} doesn't match FolderPath {actual_path!r}"
    return None


def _verify_playlist_create(db: Any, op: dict[str, Any]) -> Optional[str]:
    """Confirm a created playlist row exists, is live, is a plain playlist
    (not a folder/smart list) and carries the requested name."""
    pid = op["rb_playlist_id"]
    playlist = db.get_playlist(ID=str(pid))
    if playlist is None:
        return f"playlist {pid}: row missing after create"
    if bool(getattr(playlist, "rb_local_deleted", 0)):
        return f"playlist {pid}: row is soft-deleted after create"
    attribute = int(getattr(playlist, "Attribute", 0) or 0)
    if attribute != 0:
        return f"playlist {pid}: expected a plain playlist (Attribute 0), got {attribute}"
    if getattr(playlist, "Name", None) != op.get("name"):
        return f"playlist {pid}: Name expected {op.get('name')!r}, got {getattr(playlist, 'Name', None)!r}"
    return None


def verify(
    db_path: str,
    key: Optional[str],
    expected_writes: list[dict[str, Any]],
) -> dict[str, Any]:
    """Verify the just-written master.db.

    Snapshots `db_path` to a temp dir (re-using reader.snapshot_db_to_temp
    so the same try/finally cleanup applies), opens it via pyrekordbox,
    runs PRAGMA checks, then per-row diffs against `expected_writes`.

    `expected_writes` is the same list shape the writer received via
    `apply_batch` — the Node side keeps a record of what it asked for
    and passes it here. That way the verifier doesn't need any
    Curator-side schema awareness; it only knows "rb should now have
    these values."

    Returns:
        {
          "ok": bool,                # True iff all checks passed
          "pragma_error": str|None,  # set if PRAGMA integrity/quick failed
          "failures": [              # per-op failure descriptions
            {"kind": "track", "rb_content_id": "...", "error": "..."},
            ...
          ],
        }
    """
    snap_db_path, temp_dir, original_dir = snapshot_db_to_temp(db_path)
    try:
        db = open_db(snap_db_path, key, db_dir=original_dir)
        try:
            pragma_error = _pragma_check(db)
            failures: list[dict[str, Any]] = []
            if pragma_error is None:
                for op in expected_writes:
                    kind = op.get("kind")
                    # Human-facing label for the failure UI — a playlist's name
                    # beats its raw rb id. None for track-scoped ops (the modal
                    # falls back to the id).
                    label = op.get("name") if kind in ("playlist_merge", "playlist_create") else None
                    try:
                        if kind == "track":
                            err = _verify_track_metadata(db, op)
                            target = op.get("rb_content_id")
                        elif kind == "cues":
                            err = _verify_cues(db, op)
                            target = op.get("rb_content_id")
                        elif kind == "tags":
                            err = _verify_tags(db, op)
                            target = op.get("rb_content_id")
                        elif kind == "playlist_merge":
                            err = _verify_playlist_merge(db, op)
                            target = op.get("rb_playlist_id")
                        elif kind == "content_delete":
                            err = _verify_content_delete(db, op)
                            target = op.get("rb_content_id")
                        elif kind == "content_create":
                            err = _verify_content_create(db, op)
                            target = op.get("rb_content_id")
                        elif kind == "playlist_create":
                            err = _verify_playlist_create(db, op)
                            target = op.get("rb_playlist_id")
                        else:
                            # Forward-compat: unknown kinds skip verification
                            # rather than fail the whole batch — symmetric to
                            # the writer's unknown-kind handling.
                            err = None
                            target = None
                        if err is not None:
                            failures.append({"kind": kind, "target": target, "target_label": label, "error": err})
                    except Exception as exc:  # noqa: BLE001
                        # An exception during a single op's verify is
                        # itself a failure (e.g. row missing → caught
                        # above; but unforeseen errors still get logged).
                        sys.stderr.write(
                            f"verify op {kind!r} raised: {type(exc).__name__}: {exc}\n"
                        )
                        failures.append({
                            "kind": kind,
                            "target": op.get("rb_content_id") or op.get("rb_playlist_id"),
                            "target_label": label,
                            "error": f"{type(exc).__name__}: {exc}",
                        })
            ok = pragma_error is None and not failures
            return {"ok": ok, "pragma_error": pragma_error, "failures": failures}
        finally:
            try: db.close()
            except Exception: pass
    finally:
        # Mirrors the read-side snapshot cleanup pattern — try/finally
        # so a verify crash mid-pass still removes the temp dir.
        shutil.rmtree(temp_dir, ignore_errors=True)
