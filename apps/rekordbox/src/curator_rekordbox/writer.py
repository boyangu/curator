"""pyrekordbox write surface — mirrors reader.py but mutates the live db.

Architecturally the peer of reader.py:
  reader.py  — opens a snapshot, emits per-row deltas to the Node importer.
  writer.py — opens the real master.db, applies per-row writes from the Node
              exporter, commits once at the end.

The Node side (apps/core/src/rekordbox/exporter.ts) computes WHAT to write;
this module only knows HOW. Every helper does a pre-write diff and skips
field-equal updates so a no-op sync produces no `rb_local_usn` churn — the
LMW gate on the read side reads that USN, so churn-free no-ops are
load-bearing for the bidirectional invariant.

Scope:
  - Metadata: Title, Artist (lookup-or-create), Album (lookup-or-create),
    Label (lookup-or-create), Tags (DjmdSongMyTag membership).
  - Cues: DjmdCue rows for hot + memory cues.
  - Playlist: DjmdPlaylist row + DjmdSongPlaylist membership/order;
    creating a new root playlist (`playlist_create`).
  - Content: soft-delete (`content_delete`); creating a DjmdContent row for
    a local file (`content_create` — "Convert playlist to WAV"), optionally
    COPYING an existing row's ANLZ analysis + artwork onto it
    (anlz_copy.py). Copies only; existing analysis files are never edited.

NON-scope (deferred):
  - Editing beatgrids / phrases / waveforms in place (ANLZ writes).
  - Creating rows for tracks rekordbox should analyse itself beyond leaving
    them unanalysed (Analysed=0) for rekordbox to pick up on first load.

Filesystem side effects (content_create's share/ copies, playlist_create's
in-memory masterPlaylists6.xml node) can't be undone by a SAVEPOINT, so
each registers a compensator — see `_register_undo` — that runs when its op
fails, when the batch-level commit fails, or when the session closes
uncommitted.

The protocol is documented at the top of `apply_write_batch`.
"""

from __future__ import annotations

import os
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Callable, Optional
from uuid import uuid4

from . import anlz_copy
from .reader import _COLOR_ID_TO_NAME, _HOT_KIND_TO_SLOT


# Slot index → DjmdCue.Kind for hot cues (reverse of the read-side map).
_SLOT_TO_HOT_KIND: dict[int, int] = {slot: kind for kind, slot in _HOT_KIND_TO_SLOT.items()}

# Palette name → DjmdContent.ColorID (reverse of the read-side map; None
# stays out so a "no colour" write resolves through the explicit 0 below).
_COLOR_NAME_TO_ID: dict[str, int] = {
    name: cid for cid, name in _COLOR_ID_TO_NAME.items() if name is not None
}


# ──────────────────────────────────────────────────────────────────────────────
# Field setters — small wrappers that diff-then-write so no-op syncs don't
# churn rb_local_usn. The whole "Curator wrote the same value rb already
# has" path needs to leave the row untouched, otherwise every sync bumps
# the USN and the next read pass sees an "rb-changed" delta that wasn't
# really a change.

def _set_if_changed(row: Any, attr: str, new_value: Any) -> bool:
    """Set `row.attr = new_value` iff the current value differs. Returns
    True when a write happened. Treats None and empty-string as
    interchangeable for nullable text columns (rekordbox represents
    "no label" inconsistently — sometimes NULL, sometimes "").
    """
    current = getattr(row, attr, None)
    if current == new_value:
        return False
    if (current is None and new_value == "") or (current == "" and new_value is None):
        return False
    setattr(row, attr, new_value)
    return True


# ──────────────────────────────────────────────────────────────────────────────
# Lookup-or-create helpers for relationship tables. pyrekordbox stores
# Artist/Album/Label/Genre as separate tables with a foreign-key column on
# DjmdContent (ArtistID, AlbumID, LabelID, GenreID). We resolve a name to a
# LIVE row id and assign by ID, NOT by relationship object — assigning
# `content.Artist = row` doesn't persist the FK column on commit.
#
# "Live" is load-bearing. rekordbox soft-deletes relation rows it no longer
# uses (`rb_local_deleted = 1`, e.g. after it re-created "Auggië" as a fresh
# row, or when a comma-less "Matador Artche" fell out of use) and hides them
# in the UI. pyrekordbox's `get_artist(Name=…)` does NOT filter that flag, so
# the previous implementation happily bound tracks to tombstones: the FK
# resolved, the verifier read the name back through the same relationship,
# and rekordbox rendered a blank Artist column (2026-09-10: 28 artists, 70
# albums, 6 labels, 1 genre across the library). When only tombstoned rows
# match we create a fresh row — exactly what rekordbox does after a
# tombstone — rather than resurrecting one that may be a cloud-sync
# deletion in flight.

def _is_live(row: Any) -> bool:
    return not bool(getattr(row, "rb_local_deleted", 0))


def _lookup_or_create(db: Any, name: Optional[str], table: Any) -> Optional[str]:
    """Return the ID of a live `table` row named `name`, creating one if
    none is live. None/empty → None (clears the FK).

    Duplicate names are tolerated: pyrekordbox tables carry no uniqueness
    constraint at the SQLite level (older libraries have two albums called
    the same thing), so we take the first live match instead of
    `.one_or_none()`, which raised MultipleResultsFound.

    Creation bypasses pyrekordbox's `add_artist/add_album/...` on purpose:
    their pre-add uniqueness check counts tombstoned rows and would raise
    "already exists" for the very case we need to create in. The body is
    the same as theirs (fresh ID + UUID, `db.add` so the registry/USN
    bookkeeping runs, `flush` so the ID is usable in this op).
    """
    if not name:
        return None
    try:
        rows = list(db.session.query(table).filter_by(Name=name).all())
    except Exception:
        rows = []
    for row in rows:
        if _is_live(row):
            return row.ID
    from uuid import uuid4
    new_row = table.create(
        ID=str(db.generate_unused_id(table)),
        Name=name,
        UUID=str(uuid4()),
    )
    db.add(new_row)
    db.flush()
    return new_row.ID


def _lookup_or_create_artist(db: Any, name: Optional[str]) -> Optional[str]:
    from pyrekordbox.db6.tables import DjmdArtist  # type: ignore
    return _lookup_or_create(db, name, DjmdArtist)


def _lookup_or_create_album(db: Any, name: Optional[str]) -> Optional[str]:
    from pyrekordbox.db6.tables import DjmdAlbum  # type: ignore
    return _lookup_or_create(db, name, DjmdAlbum)


def _lookup_or_create_label(db: Any, name: Optional[str]) -> Optional[str]:
    from pyrekordbox.db6.tables import DjmdLabel  # type: ignore
    return _lookup_or_create(db, name, DjmdLabel)


def _lookup_or_create_genre(db: Any, name: Optional[str]) -> Optional[str]:
    from pyrekordbox.db6.tables import DjmdGenre  # type: ignore
    return _lookup_or_create(db, name, DjmdGenre)


# ──────────────────────────────────────────────────────────────────────────────
# Track metadata write.

def _apply_metadata_fields(db: Any, row: Any, fields: dict[str, Any]) -> bool:
    """Write the user-facing metadata `fields` onto a DjmdContent row —
    shared by the `track` op and `content_create`, so a freshly created row
    gets byte-identical values to what a later `track` op would write (and
    that op then no-ops). Field semantics are documented on
    apply_track_metadata. Returns True when anything changed."""
    changed = False

    if "Title" in fields:
        changed |= _set_if_changed(row, "Title", fields["Title"])

    if "ArtistName" in fields:
        new_id = _lookup_or_create_artist(db, fields["ArtistName"])
        changed |= _set_if_changed(row, "ArtistID", new_id)

    if "AlbumName" in fields:
        new_id = _lookup_or_create_album(db, fields["AlbumName"])
        changed |= _set_if_changed(row, "AlbumID", new_id)

    if "LabelName" in fields:
        new_id = _lookup_or_create_label(db, fields["LabelName"])
        changed |= _set_if_changed(row, "LabelID", new_id)

    if "GenreName" in fields:
        new_id = _lookup_or_create_genre(db, fields["GenreName"])
        changed |= _set_if_changed(row, "GenreID", new_id)

    if "Rating" in fields:
        # Curator and rb6 share the 0..5 scale (reader.py reads Rating
        # straight through), so no conversion. The exporter omits the key
        # when the curator side has never rated the track.
        changed |= _set_if_changed(row, "Rating", int(fields["Rating"]))

    if "Comment" in fields:
        # rb's column really is named Commnt.
        changed |= _set_if_changed(row, "Commnt", fields["Comment"])

    if "Color" in fields:
        # Palette name → ColorID via the reverse of the read-side map.
        # Unknown names are skipped (don't write a ColorID rb won't render)
        # rather than cleared.
        name = fields["Color"]
        # ColorID is a VARCHAR FK (djmdColor.ID) and rekordbox stores '0',
        # '2', … as text; comparing/writing the int form re-wrote every
        # coloured row on every push (USN churn) while storing the same
        # text, so diff and write in string form.
        if not name:
            changed |= _set_if_changed(row, "ColorID", "0")
        elif name in _COLOR_NAME_TO_ID:
            changed |= _set_if_changed(row, "ColorID", str(_COLOR_NAME_TO_ID[name]))

    return changed


def apply_track_metadata(db: Any, op: dict[str, Any]) -> dict[str, Any]:
    """Apply a metadata write to one DjmdContent row.

    Input shape:
        {
          "rb_content_id": "12345",
          "fields": {
            "Title": "New Title",        # nullable
            "ArtistName": "...",         # lookup-or-create → ArtistID
            "AlbumName": "...",          # lookup-or-create → AlbumID
            "LabelName": "...",          # lookup-or-create → LabelID
            "GenreName": "...",          # lookup-or-create → GenreID
          }
        }

    Only the fields PRESENT in `fields` are considered. A missing key
    means "Curator doesn't have an opinion, leave alone." An explicit
    null/"" means "clear this field on the rb side" (write None to the
    FK / Title).

    Returns `{"rb_content_id", "changed": bool}`. `changed=False` means
    every field already matched — no SQLAlchemy attribute was touched,
    so commit() won't bump this row's USN.
    """
    cid = op["rb_content_id"]
    # pyrekordbox's get_content(ID=...) returns the row directly (or None
    # on miss) when filtering by primary key — see _parse_query_result in
    # db6/database.py. Calling .one_or_none() on the row would
    # AttributeError. The Query/.one_or_none() pattern only applies to
    # non-PK filters (Name, etc.) used in the lookup-or-create helpers
    # below.
    row = db.get_content(ID=cid)
    if row is None:
        # Row was deleted from rekordbox after Curator's last read sync.
        # Mark `missing` so the exporter can drop the stale rekordboxLink
        # on the curator side AND filter this op out of verify (otherwise
        # the verifier reports "row missing after write" for a write we
        # never attempted).
        return {"rb_content_id": cid, "changed": False, "skipped": True, "missing": True}

    changed = _apply_metadata_fields(db, row, op.get("fields") or {})
    if _heal_never_null_columns(row):
        changed = True
    return {"rb_content_id": cid, "changed": changed, "skipped": False}


# ──────────────────────────────────────────────────────────────────────────────
# Cue write — wipe-and-re-add per track.
#
# Why wipe instead of merge: today cues are 100% rekordbox-sourced (no
# Curator-side cue editor). A "sync cues" action is really "re-push the
# cues we read from rb." The wipe-and-re-add pattern avoids the
# slot-identity matching headaches the read-side importer already
# documented at importer.ts:355. Once Curator grows a cue editor, the
# merge needs revisiting — but for now this is sound.

def _parse_cti(color: Optional[str]) -> Optional[int]:
    """Curator's stored color tokens are now exclusively `"cti:N"` or None.
    The legacy named palette ("red"/"green"/etc) is no longer recognised on
    either the read or write side; pre-refactor rows are NULLed by the
    migration in apps/core/src/db/migrate.ts. See [[curator-cue-editor]] +
    the rb-color-refactor plan for the rationale.

    Returns the CTI integer, or None for "no color set" / unknown tokens.
    """
    if not color or not color.startswith("cti:"):
        return None
    try:
        return int(color[4:])
    except ValueError:
        return None


def apply_cues(db: Any, op: dict[str, Any]) -> dict[str, Any]:
    """Replace every DjmdCue row for `rb_content_id` with the list in `cues`.

    Input shape:
        {
          "rb_content_id": "12345",
          "cues": [
            {"slot": 0,   "kind": "hot",    "position_sec": 12.5, "length_sec": null, "color": "cti:22", "name": "..."},
            {"slot": 100, "kind": "memory", "position_sec": 30.0, "length_sec": 4.0,  "color": null,     "name": null},
            ...
          ]
        }

    `slot` follows the read-side ordinal:
        hot cues   → slots 0..7 (one per A..H letter)
        memory cues → slots 100+ (ordinal by time)

    rb's canonical on-disk shape — verified 2026-10-08 against cue rows
    rekordbox itself wrote (an earlier "two identical rows" reading came
    from a library already full of Curator-written duplicates):
      ONE row per user-visible cue (rekordbox's own write shape; only 17 of
      468 pre-Curator hot cues had a twin). See the comment at the insert.

    Returns `{"rb_content_id", "deleted", "inserted", "rows_written"}`.
    `inserted` counts user-visible cues; `rows_written` equals it (one row
    per cue).
    """
    cid = op["rb_content_id"]
    content = db.get_content(ID=cid)  # PK lookup returns row or None
    if content is None:
        # See apply_track_metadata's `missing` flag — exporter uses it to
        # prune the dead rekordboxLink + skip verify for this op.
        return {"rb_content_id": cid, "deleted": 0, "inserted": 0, "rows_written": 0, "skipped": True, "missing": True}

    # Wipe existing cues. `db.delete(...)` registers with the registry so
    # the eventual commit() bumps the local_update_count appropriately.
    from pyrekordbox.db6.tables import DjmdCue  # type: ignore
    existing = list(db.session.query(DjmdCue).filter_by(ContentID=str(cid)).all())
    for old in existing:
        db.delete(old)

    inserted = 0
    rows_written = 0
    content_uuid = getattr(content, "UUID", None)
    for c in op.get("cues") or []:
        in_ms = int(round(float(c.get("position_sec", 0.0)) * 1000.0))
        length_sec = c.get("length_sec")
        out_ms = int(round(float(length_sec) * 1000.0)) + in_ms if length_sec else -1
        kind_str = c.get("kind", "hot")
        is_hot = kind_str == "hot"
        if is_hot:
            slot = int(c.get("slot", 0))
            kind_val = _SLOT_TO_HOT_KIND.get(slot)
            if kind_val is None:
                # Unknown slot — skip rather than write a row rb will reject.
                sys.stderr.write(f"cue write: skipping unknown hot slot {slot}\n")
                continue
        else:
            kind_val = 0  # memory cue
        cti = _parse_cti(c.get("color"))

        # ONE row per cue, in rekordbox's own shape. Writing two rows per
        # cue (the old behaviour, based on a library that already held
        # duplicates) made deleted cues come back: rekordbox deletes the one
        # row it tracks, and the twin resurfaces the next time it reads the
        # track from the DB (2026-10-08). InFrame/OutFrame are 1/150 s units,
        # truncated like rekordbox's own (52 ms -> 7, 71585 ms -> 10737).
        common = dict(
            ID=str(db.generate_unused_id(DjmdCue)),
            ContentID=str(cid),
            InMsec=in_ms,
            InFrame=int(in_ms * 0.15),
            InMpegFrame=0,
            InMpegAbs=0,
            OutMsec=out_ms,
            OutFrame=int(out_ms * 0.15) if out_ms > 0 else 0,
            OutMpegFrame=0,
            OutMpegAbs=0,
            Kind=kind_val,
            ContentUUID=content_uuid,
            UUID=str(uuid4()),
        )
        if is_hot:
            # CTI=0 means "no color". ActiveLoop/BeatLoopSize stay 0 on hot
            # rows (point vs loop is OutMsec=-1 vs in-ms+length).
            db.add(DjmdCue(
                **common,
                Color=255,
                ColorTableIndex=cti if cti is not None else 0,
                ActiveLoop=0,
                BeatLoopSize=0,
                CueMicrosec=0,
                Comment=c.get("name") or "",
            ))
        else:
            # Memory cue: rekordbox leaves the hot-cue extras NULL.
            db.add(DjmdCue(
                **common,
                Color=-1,
                ColorTableIndex=None,
                ActiveLoop=None,
                BeatLoopSize=None,
                CueMicrosec=None,
                Comment=c.get("name"),
            ))
        rows_written += 1
        inserted += 1

    return {
        "rb_content_id": cid,
        "deleted": len(existing),
        "inserted": inserted,
        "rows_written": rows_written,
        "skipped": False,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Tag membership write — per-track wipe-and-re-add of DjmdSongMyTag.

def apply_tags(db: Any, op: dict[str, Any]) -> dict[str, Any]:
    """Replace this track's DjmdSongMyTag membership with `rb_tag_ids`.

    Input:
        {"rb_content_id": "12345", "rb_tag_ids": ["100", "200"]}

    The MyTag rows themselves (DjmdMyTag) are not created here — the
    exporter only includes rb_tag_ids that were originally read FROM rb
    (i.e., they correspond to existing DjmdMyTag rows). Curator-only
    tags don't have an rb-side identity and are out of scope for v1.

    Returns `{"rb_content_id", "deleted", "inserted", "revived"}` — `revived`
    counts tombstoned DjmdMyTag rows un-deleted because this track references
    them (see below).
    """
    cid = op["rb_content_id"]
    rb_tag_ids = list(op.get("rb_tag_ids") or [])

    # Mirror apply_track_metadata's missing-row check: if the rb track is
    # gone, mark the op so the exporter can prune the dead rekordboxLink
    # and skip verify. Otherwise we'd silently insert DjmdSongMyTag rows
    # pointing at a dead ContentID (pyrekordbox doesn't enforce the FK).
    if db.get_content(ID=cid) is None:
        return {"rb_content_id": cid, "deleted": 0, "inserted": 0, "skipped": True, "missing": True}

    from pyrekordbox.db6.tables import DjmdMyTag, DjmdSongMyTag  # type: ignore
    existing = list(db.session.query(DjmdSongMyTag).filter_by(ContentID=str(cid)).all())
    existing_tag_ids = {r.MyTagID for r in existing}
    new_tag_ids = set(rb_tag_ids)

    # Revive tombstoned MyTags we are about to reference. rekordbox
    # soft-deletes MyTag rows (rb_local_deleted=1) and hides them from the
    # tag pane; a membership row pointing at one is invisible. Curator only
    # pushes tags the user still curates with, so a reference IS the signal
    # the tag should exist again — same id, same parent group, memberships
    # intact (2026-08-25: one rb operation tombstoned 33 MyTags, including
    # controlling/afterglow/vocal, and every push since wrote at dead ids).
    revived = 0
    for tag_id in new_tag_ids:
        tag_row = db.session.get(DjmdMyTag, str(tag_id)) if hasattr(db.session, "get") else None
        if tag_row is not None and bool(getattr(tag_row, "rb_local_deleted", 0)):
            tag_row.rb_local_deleted = 0
            revived += 1

    # Diff: only remove rows we no longer want and add rows that aren't
    # already there. Identical membership produces no writes.
    to_remove = [r for r in existing if r.MyTagID not in new_tag_ids]
    to_add = new_tag_ids - existing_tag_ids

    for r in to_remove:
        db.delete(r)
    for tag_id in to_add:
        new_row = DjmdSongMyTag(
            ID=str(db.generate_unused_id(DjmdSongMyTag)),
            MyTagID=str(tag_id),
            ContentID=str(cid),
            TrackNo=0,
        )
        db.add(new_row)

    return {
        "rb_content_id": cid,
        "deleted": len(to_remove),
        "inserted": len(to_add),
        "revived": revived,
        "skipped": False,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Playlist write — name + membership.

def _track_no_sort_key(row: Any) -> tuple[int, str, str]:
    """Stable ordering for DjmdSongPlaylist rows: TrackNo first, then
    insertion (created_at, ID) so colliding numbers resolve old-before-new.
    Mirrors the reader's ORDER BY so the writer's compaction/reorder and
    the pull agree on what "current order" means."""
    return (
        int(getattr(row, "TrackNo", 0) or 0),
        str(getattr(row, "created_at", None) or ""),
        str(getattr(row, "ID", None) or ""),
    )


def apply_playlist_merge(db: Any, op: dict[str, Any]) -> dict[str, Any]:
    """Apply a targeted membership merge to one DjmdPlaylist.

    Input:
        {
          "rb_playlist_id": "...",
          "name": "Optional new name",
          "remove": ["100", "200"],                # rb_content_ids to remove
          "add":    [{"rb_content_id": "300", "position": 4}],
          "order":  ["300", "150", "100"] | null   # desired order of Curator-
                                                    # known members, or null=held
        }

    Unlike the old wholesale wipe-and-re-add, this NEVER touches rekordbox
    members Curator doesn't manage: only the explicit `remove` ids are
    dropped, only `add` ids are inserted, and the reorder pass keeps any
    rb-only member (not in `order`) appended in its existing relative order.
    That's the whole point — a Curator that holds a subset of a playlist can
    no longer delete the rest of it.

    Folders + smart playlists are silently skipped. Returns counts.
    """
    pid = op["rb_playlist_id"]
    playlist = db.get_playlist(ID=pid)  # PK lookup returns row or None
    if playlist is None:
        # Playlist was deleted in rekordbox after Curator's last read sync.
        # Mark `missing` so the exporter can drop the curator-side rb
        # playlist row (cascade clears playlist_track) AND filter this op
        # from verify.
        return {"rb_playlist_id": pid, "skipped": True, "missing": True, "added": 0, "removed": 0, "reordered": False, "name_changed": False}

    # Folder (Attribute=1) or smart playlist (Attribute=4) — can't push
    # member tracks. Name updates also off the table for folders.
    attribute = int(getattr(playlist, "Attribute", 0) or 0)
    if attribute != 0:
        return {"rb_playlist_id": pid, "skipped": True, "added": 0, "removed": 0, "reordered": False, "name_changed": False}

    name_changed = False
    if "name" in op and op["name"] is not None:
        name_changed = _set_if_changed(playlist, "Name", op["name"])

    from pyrekordbox.db6.tables import DjmdSongPlaylist  # type: ignore

    def _rows() -> list[Any]:
        return list(db.session.query(DjmdSongPlaylist).filter_by(PlaylistID=str(pid)).all())

    # 1. Removals — by ContentID. A removed id not present is a no-op (the
    #    other side may have removed it first; idempotent by design).
    remove_ids = {str(x) for x in (op.get("remove") or [])}
    removed = 0
    if remove_ids:
        for row in _rows():
            if str(row.ContentID) in remove_ids:
                db.delete(row)
                removed += 1

    # 2. Collapse accidental duplicate rows (same ContentID listed twice in
    #    one playlist). Curator's model is unique-per-track — the importer's
    #    membership merge is content-id-keyed (a Set), so it can't even
    #    represent a repeat — yet an earlier wipe-and-re-add writer left stray
    #    double rows in some playlists. A targeted merge is the natural place
    #    to heal them: keep the lowest-TrackNo row per ContentID, delete the
    #    rest. Without this the reorder below would assign both rows a TrackNo
    #    and post-write verify would (correctly) flag the playlist as duped.
    seen_cids: set[str] = set()
    deduped = 0
    for row in sorted(_rows(), key=_track_no_sort_key):
        cid = str(row.ContentID)
        if cid in seen_cids:
            db.delete(row)
            deduped += 1
        else:
            seen_cids.add(cid)

    # 3. Compact TrackNo to a dense 1..n BEFORE adding. The deletes above
    #    (removals + dedupe) leave holes — and rekordbox assumes TrackNo is
    #    dense: its own add assigns TrackNo = row count + 1, not max + 1.
    #    With holes, a rb-side add collides with existing higher numbers
    #    (2026-09-15: `# backlog` had 117 rows numbered 2..188 after months
    #    of Curator removals; rekordbox gave 21 new imports 118..138, eight
    #    of them exact duplicates of old rows, and the next pull read an
    #    interleaved order and pushed it back as a permanent renumber).
    #    Compacting here — stable on (TrackNo, created_at, ID) — keeps
    #    relative order, makes add_to_playlist's len+1 a clean append, and
    #    heals holes left by earlier pushes the first time each playlist is
    #    touched (one-time USN churn on the renumbered rows; the next pull
    #    sees the deltas and the membership merge no-ops on unchanged order).
    renumbered = 0
    for i, row in enumerate(sorted(_rows(), key=_track_no_sort_key)):
        if int(getattr(row, "TrackNo", 0) or 0) != i + 1:
            row.TrackNo = i + 1
            renumbered += 1

    # 4. Additions — by ContentID, skipping any already present (convergent
    #    add). add_to_playlist owns the UUID/TrackNo/timestamp bookkeeping;
    #    the reorder pass below fixes final positions, so append-at-end here.
    present = {str(r.ContentID) for r in _rows()}
    added = 0
    missing_adds: list[str] = []
    for entry in (op.get("add") or []):
        cid = str(entry["rb_content_id"])
        if cid in present:
            continue
        # Pre-check the content row: a track deleted in rekordbox since
        # Curator's last read leaves a dangling rb_content_id in the diff,
        # and add_to_playlist blows up on it ('NoneType' has no attribute
        # 'ID') — reported to stderr but never to the exporter, so the same
        # dead add retried on EVERY sync. Report it as missing so the
        # exporter can prune the stale link (same evidence class as a
        # missing track op) and the diff converges.
        if db.get_content(ID=cid) is None:
            missing_adds.append(cid)
            continue
        try:
            db.add_to_playlist(pid, cid)  # appends at end; reorder pass below
            present.add(cid)
            added += 1
        except Exception as exc:  # noqa: BLE001 — one bad add shouldn't abort the op
            sys.stderr.write(f"playlist_merge: add content {cid} to {pid} failed: {exc}\n")

    # 5. Reorder — only when Curator's order won (order != null). Known
    #    members get TrackNo by their index in `order`; any rb-only member
    #    not in `order` keeps its relative order, appended after the known
    #    block. db.add_to_playlist already flushed the new rows, so _rows()
    #    sees everything (and the dedupe above already removed the extras).
    order = op.get("order")
    reordered = False
    if order is not None:
        want = [str(x) for x in order]
        want_rank = {cid: i for i, cid in enumerate(want)}
        rows = _rows()
        # Stable: known members by their desired rank, unknown members after
        # in current-TrackNo order.
        known = sorted(
            (r for r in rows if str(r.ContentID) in want_rank),
            key=lambda r: want_rank[str(r.ContentID)],
        )
        unknown = sorted(
            (r for r in rows if str(r.ContentID) not in want_rank),
            key=_track_no_sort_key,
        )
        for i, row in enumerate(known + unknown):
            track_no = i + 1
            if int(getattr(row, "TrackNo", 0) or 0) != track_no:
                row.TrackNo = track_no
                reordered = True

    return {
        "rb_playlist_id": pid,
        "skipped": False,
        "name_changed": name_changed,
        "added": added,
        "removed": removed,
        "deduped": deduped,
        "renumbered": renumbered,
        "reordered": reordered,
        # rb_content_ids whose djmdContent row is gone (deleted in rekordbox)
        # — the exporter prunes their curator-side links so the diff stops
        # retrying them. Omitted when empty to keep the wire quiet.
        **({"missing_adds": missing_adds} if missing_adds else {}),
    }


def apply_playlist_rename(db: Any, op: dict[str, Any]) -> dict[str, Any]:
    """Set DjmdPlaylist.Name on a playlist OR folder row — name only.

    The merge path bails on folders (Attribute != 0) before its name write,
    so folder renames ride this dedicated op instead. No member changes.
    Idempotent: `_set_if_changed` no-ops when the stored name already matches,
    so reconciling an unchanged folder is a cheap read with no USN bump.
    """
    pid = op["rb_playlist_id"]
    playlist = db.get_playlist(ID=pid)  # PK lookup; works for folders too
    if playlist is None:
        # Folder/playlist deleted in rekordbox since Curator's last read.
        # `missing` lets the exporter skip without pruning the curator row.
        return {"rb_playlist_id": pid, "skipped": True, "missing": True, "name_changed": False}
    name = op.get("name")
    name_changed = False
    if name is not None:
        name_changed = _set_if_changed(playlist, "Name", name)
    return {"rb_playlist_id": pid, "skipped": False, "name_changed": name_changed}


def apply_content_delete(db: Any, op: dict[str, Any]) -> dict[str, Any]:
    """Soft-delete one DjmdContent row — remove the track from rekordbox's
    Collection.

    We set `rb_local_deleted = 1` rather than DELETE the row: that's the
    tombstone convention rekordbox's own cloud sync uses (our reader
    already treats the flag as "deleted" everywhere it scans), it needs no
    FK cleanup across the Djmd* satellite tables, and it's reversible from
    a backup-free position — flipping the flag back resurrects the row.
    DjmdSongPlaylist rows for the content get the same flag so playlists
    don't keep ghost entries pointing at deleted content (the reader's
    membership scans filter rb_local_deleted == 0, and rekordbox hides
    them the same way).

    Idempotent: an already-deleted row returns changed=False so a retried
    push (e.g. after an unrelated verify failure) causes no USN churn.
    """
    from pyrekordbox.db6.tables import DjmdSongPlaylist  # type: ignore

    cid = op["rb_content_id"]
    row = db.get_content(ID=cid)
    if row is None:
        # Already hard-gone from rekordbox (deleted rb-side) — nothing to
        # do; `missing` lets the exporter stamp the tombstone as settled.
        return {"rb_content_id": cid, "changed": False, "skipped": True, "missing": True}

    changed = False
    if not bool(getattr(row, "rb_local_deleted", 0)):
        row.rb_local_deleted = 1
        changed = True

    memberships_removed = 0
    songs = list(db.session.query(DjmdSongPlaylist).filter_by(ContentID=str(cid)).all())
    for s in songs:
        if not bool(getattr(s, "rb_local_deleted", 0)):
            s.rb_local_deleted = 1
            memberships_removed += 1
            changed = True

    return {
        "rb_content_id": cid,
        "changed": changed,
        "memberships_removed": memberships_removed,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Non-DB side effects — compensators for what a SAVEPOINT can't roll back.
#
# content_create copies files into share/ and playlist_create adds a node to
# pyrekordbox's in-memory masterPlaylists6.xml tree (saved to disk only inside
# db.commit()). If the op's SAVEPOINT rolls back, or the batch-level commit
# fails, those must be undone too — otherwise share/ collects orphan analysis
# dirs and the next successful commit writes an XML node for a playlist row
# that doesn't exist. Each side effect registers an undo callable on the db
# handle; apply_batch runs an op's undos when that op fails, main.py runs all
# pending undos when commit fails or the session closes uncommitted, and a
# SQLAlchemy after_commit hook forgets them once the DB transaction has
# landed (after_commit fires before pyrekordbox's own XML save, so an XML
# write error can't make us delete files a committed row points at). Every
# compensator also re-checks the DB before undoing anything — see
# _remove_dir_unless_referenced for why "rolled back" can't be assumed.

_UNDO_ATTR = "_curator_pending_undo"
_HOOK_ATTR = "_curator_commit_hook_session"


def _pending_undo(db: Any) -> list[Callable[[], None]]:
    pending = getattr(db, _UNDO_ATTR, None)
    if pending is None:
        pending = []
        setattr(db, _UNDO_ATTR, pending)
    session = getattr(db, "session", None)
    if session is not None and getattr(db, _HOOK_ATTR, None) is not session:
        from sqlalchemy import event

        def _forget(sess: Any) -> None:
            # SQLAlchemy fires after_commit for every SAVEPOINT release too
            # (apply_batch's per-op begin_nested); only the outermost commit
            # means the rows — and so their files — are durable.
            if not sess.in_nested_transaction():
                pending.clear()

        event.listen(session, "after_commit", _forget)
        setattr(db, _HOOK_ATTR, session)
    return pending


def _register_undo(db: Any, fn: Callable[[], None]) -> None:
    _pending_undo(db).append(fn)


def _run_undos(undos: list[Callable[[], None]]) -> int:
    ran = 0
    for fn in reversed(undos):
        try:
            fn()
            ran += 1
        except Exception as exc:  # noqa: BLE001 — best-effort cleanup
            sys.stderr.write(f"write: side-effect undo failed: {type(exc).__name__}: {exc}\n")
    return ran


def discard_uncommitted_side_effects(db: Any) -> int:
    """Undo every registered side effect not yet covered by a DB commit.
    Called by main.py when commit fails or a write session closes without
    committing. Returns how many compensators ran."""
    pending = getattr(db, _UNDO_ATTR, None)
    if not pending:
        return 0
    undos = list(pending)
    pending.clear()
    return _run_undos(undos)


# ──────────────────────────────────────────────────────────────────────────────
# Content create — new DjmdContent row for a local file ("Convert to WAV").

# DjmdContent.FileType for the suffixes Curator creates rows for.
_FILE_TYPE_BY_SUFFIX: dict[str, int] = {".mp3": 1, ".m4a": 4, ".flac": 5, ".wav": 11, ".aiff": 12, ".aif": 12}

# Camelot code → classical spellings, preferred spelling first (the one
# rekordbox itself writes into djmdKey.ScaleName: flats, except F#/F#m).
_CAMELOT_TO_CLASSICAL: dict[str, tuple[str, ...]] = {
    "1A": ("Abm", "G#m"), "1B": ("B", "Cb"),
    "2A": ("Ebm", "D#m"), "2B": ("F#", "Gb"),
    "3A": ("Bbm", "A#m"), "3B": ("Db", "C#"),
    "4A": ("Fm",), "4B": ("Ab", "G#"),
    "5A": ("Cm",), "5B": ("Eb", "D#"),
    "6A": ("Gm",), "6B": ("Bb", "A#"),
    "7A": ("Dm",), "7B": ("F",),
    "8A": ("Am",), "8B": ("C",),
    "9A": ("Em",), "9B": ("G",),
    "10A": ("Bm",), "10B": ("D",),
    "11A": ("F#m", "Gbm"), "11B": ("A",),
    "12A": ("Dbm", "C#m"), "12B": ("E",),
}


# Columns every rekordbox-written DjmdContent row carries a value in — 0 of
# 4,749 live rows had them NULL (probe 2026-10-08). add_content leaves them
# NULL, and rekordbox reads NULL here as "something": rows created that way
# showed a red badge in the Title column (ServiceID drives the streaming-
# service badge, LyricStatus the lyrics one). Written with setattr, NOT
# _set_if_changed — that helper treats None and "" as equal, which is exactly
# the difference that matters for the text defaults below.
_NEVER_NULL_DEFAULTS: dict[str, Any] = {
    "ServiceID": 0,
    "LyricStatus": 0,
    "SamplerTrackInfo": 0,
    "SamplerPlayOffset": 0,
    "SamplerGain": 0.0,
}

# What rekordbox itself writes on a fresh local row (blank, not NULL). Only
# applied to rows Curator creates — ~410 of rekordbox's own rows hold NULL in
# these text columns, so they're no evidence of damage on existing rows.
_NEW_ROW_DEFAULTS: dict[str, Any] = {
    **_NEVER_NULL_DEFAULTS,
    "VideoAssociate": "0",
    "FileNameS": "", "Subtitle": "", "ReleaseDate": "", "ModifiedByRBM": "",
    "DeliveryComment": "", "Lyricist": "", "OrgFolderPath": "", "Reserved1": "",
    "ISRC": "", "ExtInfo": "null", "ColorID": "0", "Rating": 0,
    "TrackNo": 0, "DiscNo": 0, "ReleaseYear": 0,
}


def _fill_new_content_defaults(row: Any) -> None:
    for attr, value in _NEW_ROW_DEFAULTS.items():
        if getattr(row, attr, None) is None:
            setattr(row, attr, value)


def _heal_never_null_columns(row: Any) -> bool:
    """Back-fill the never-NULL columns on a row we update. Only rows Curator
    created before this fix can match, so native rows are never touched;
    a WAV copy is healed by its next metadata push. True when it wrote."""
    healed = False
    for attr, value in _NEVER_NULL_DEFAULTS.items():
        if hasattr(row, attr) and getattr(row, attr) is None:
            setattr(row, attr, value)
            healed = True
    return healed


def normalize_folder_path(path: str) -> str:
    """rekordbox's FolderPath form: forward slashes, uppercase drive letter
    (`C:/Users/x/Music/a.wav`) — what every live row stores."""
    p = str(path).replace("\\", "/")
    if len(p) >= 2 and p[1] == ":" and p[0].isalpha():
        p = p[0].upper() + p[1:]
    return p


def _key_scale_candidates(code: Optional[str]) -> list[str]:
    """ScaleName spellings a djmdKey row for `code` may carry. rekordbox
    stores whatever notation was active at analysis time, so one library
    holds both 'Am' and '8A' rows."""
    if not code:
        return []
    c = str(code).strip()
    camelot = c.upper().lstrip("0")
    if camelot in _CAMELOT_TO_CLASSICAL:
        return [*_CAMELOT_TO_CLASSICAL[camelot], camelot]
    # Tolerate a classical name on the wire too.
    for cam, names in _CAMELOT_TO_CLASSICAL.items():
        if c in names:
            return [*names, cam]
    return []


def _lookup_key_id(db: Any, code: Optional[str]) -> Optional[str]:
    """ID of a LIVE djmdKey row matching `code`, or None. Never creates one:
    a wrong-notation key row would be worse than rekordbox's own blank."""
    candidates = _key_scale_candidates(code)
    if not candidates:
        return None
    from pyrekordbox.db6.tables import DjmdKey  # type: ignore
    rows = db.session.query(DjmdKey).filter(DjmdKey.ScaleName.in_(candidates)).all()
    live = {r.ScaleName: r.ID for r in rows if _is_live(r)}
    for name in candidates:
        if name in live:
            return str(live[name])
    return None


def _live_content(db: Any, cid: Any) -> Optional[Any]:
    if cid in (None, ""):
        return None
    row = db.get_content(ID=str(cid))
    return row if row is not None and _is_live(row) else None


def _find_content_by_folder_path(db: Any, folder_path: str) -> list[Any]:
    """Rows (live first) whose FolderPath is `folder_path` modulo slash style
    and ASCII case — Windows paths are case-insensitive, and a row written
    by pyrekordbox's add_content elsewhere may carry backslashes."""
    from sqlalchemy import func
    from pyrekordbox.db6.tables import DjmdContent  # type: ignore
    col = DjmdContent.FolderPath
    rows = list(
        db.session.query(DjmdContent)
        .filter(func.lower(func.replace(col, "\\", "/")) == func.lower(folder_path))
        .all()
    )
    return sorted(rows, key=lambda r: 0 if _is_live(r) else 1)


def _meta_fields(meta: dict[str, Any]) -> dict[str, Any]:
    """content_create `meta` → the `fields` dict the track op understands.
    Rating is omitted when null (int(None) would raise; unrated = leave)."""
    fields = {k: meta[k] for k in ("Title", "ArtistName", "AlbumName", "LabelName", "GenreName", "Comment", "Color") if k in meta}
    if meta.get("Rating") is not None:
        fields["Rating"] = meta["Rating"]
    return fields


def _apply_technical_fields(row: Any, meta: dict[str, Any], folder_path: str, source: Optional[Any]) -> None:
    sr, bd, ch = meta.get("sample_rate"), meta.get("bit_depth"), meta.get("channels")
    if sr:
        _set_if_changed(row, "SampleRate", int(sr))
    if bd:
        _set_if_changed(row, "BitDepth", int(bd))
    if sr and bd and ch:
        # rekordbox's own WAV rows: floor(rate * depth * channels / 1000)
        # kbps (2116 for 44.1k/24/2, 1411 for 44.1k/16/2).
        _set_if_changed(row, "BitRate", int(sr) * int(bd) * int(ch) // 1000)
    length = meta.get("length_sec")
    if length is None and source is not None:
        length = getattr(source, "Length", None)
    if length is not None:
        _set_if_changed(row, "Length", int(round(float(length))))
    try:
        _set_if_changed(row, "FileSize", os.stat(folder_path).st_size)
    except OSError:
        pass
    file_type = _FILE_TYPE_BY_SUFFIX.get(Path(folder_path).suffix.lower())
    if file_type is not None:
        _set_if_changed(row, "FileType", file_type)
    _set_if_changed(row, "DeliveryControl", "on")
    _set_if_changed(row, "DJPlayCount", 0)
    if meta.get("release_year") is not None:
        _set_if_changed(row, "ReleaseYear", int(meta["release_year"]))


def _apply_bpm_key(db: Any, row: Any, meta: dict[str, Any], source: Optional[Any]) -> None:
    """BPM/KeyID from the SOURCE row when there is one: the copied beatgrid
    was computed at the source's BPM, and a row whose BPM column disagrees
    with its grid shows the wrong tempo in the browser and sync. Otherwise
    Curator's values (BPM stored ×100 as an int)."""
    if source is not None:
        _set_if_changed(row, "BPM", getattr(source, "BPM", None))
        _set_if_changed(row, "KeyID", getattr(source, "KeyID", None))
        return
    if meta.get("bpm") is not None:
        _set_if_changed(row, "BPM", int(round(float(meta["bpm"]) * 100)))
    key_id = _lookup_key_id(db, meta.get("key_camelot"))
    if key_id is not None:
        _set_if_changed(row, "KeyID", key_id)


def _native_content_link(db: Any, source: Optional[Any]) -> Optional[int]:
    """ContentLink as rekordbox writes it on rows it creates itself.

    pyrekordbox's add_content fills ContentLink with the TRACK menu item's
    rb_local_usn. That assumption doesn't hold here: the menu item sits at
    677397 while every row rekordbox created since 2025 carries 3999246.
    Given the foreign value, rekordbox rewrote our rows to 0x3F560E — the
    native 0x3D060E with bits 12–14 set — and those bits put a red badge on
    the track and make USB export refuse it as an unsupported format
    (2026-10-09; resetting the value cleared both). Prefer the source row's
    value (same generation), else the value rekordbox gave the rows it
    created most recently.
    """
    if source is not None and getattr(source, "ContentLink", None):
        return int(source.ContentLink)
    from pyrekordbox.db6.tables import DjmdContent  # type: ignore
    rows = (
        db.session.query(DjmdContent.ContentLink)
        .filter(DjmdContent.rb_local_deleted == 0, DjmdContent.ContentLink.isnot(None))
        .order_by(DjmdContent.created_at.desc())
        .limit(200)
        .all()
    )
    counts = Counter(int(r[0]) for r in rows if r[0])
    return counts.most_common(1)[0][0] if counts else None


def _apply_content_link(db: Any, row: Any, source: Optional[Any]) -> None:
    link = _native_content_link(db, source)
    if link is not None:
        _set_if_changed(row, "ContentLink", link)


def _uuid_subdir(uuid: str) -> str:
    # rekordbox's share layout: <UUID[0:3]>/<UUID[3:]> (dashes kept).
    return f"{uuid[:3]}/{uuid[3:]}"


def _remove_dir_unless_referenced(db: Any, column: str, rel_path: str, dst_dir: Path, stop: Path) -> None:
    """Compensator for a share/ copy: delete it only if no DjmdContent row
    in the database references it any more.

    Asking the DB instead of assuming "rolled back ⇒ gone" is load-bearing:
    with the pysqlite/sqlcipher3 driver's legacy transaction handling, a
    SAVEPOINT opened while no transaction is active STARTS one, and its
    RELEASE commits it — so an op apply_batch already released may be
    durable even though commit_and_close later failed (verified 2026-10-08
    against sqlcipher3). Deleting its files then would leave a live row
    pointing at missing analysis. Must run on a usable session (after the
    savepoint / session rollback), where the query sees exactly what
    survived."""
    from pyrekordbox.db6.tables import DjmdContent  # type: ignore
    with db.session.no_autoflush:
        ref = (
            db.session.query(DjmdContent.ID)
            .filter(getattr(DjmdContent, column) == rel_path)
            .first()
        )
    if ref is None:
        anlz_copy.remove_created_dir(dst_dir, stop_at=stop)


def _copy_analysis(db: Any, row: Any, source: Any) -> list[str]:
    """Copy the source's ANLZ dir to this row's UUID dir and point the row
    at it. Returns the copied extensions ([] = nothing copied)."""
    src_rel = getattr(source, "AnalysisDataPath", None)
    if not src_rel:
        return []
    share = Path(db.share_directory)
    src_dir = (share / src_rel.strip("/\\")).parent
    if not (src_dir / "ANLZ0000.DAT").is_file():
        return []
    sub = _uuid_subdir(str(row.UUID))
    dst_dir = share / "PIONEER" / "USBANLZ" / sub
    stop = share / "PIONEER" / "USBANLZ"
    copied = anlz_copy.copy_anlz_dir(src_dir, dst_dir, row.FolderPath, stop_at=stop)
    if not copied:
        return []
    rel = f"/PIONEER/USBANLZ/{sub}/ANLZ0000.DAT"
    _register_undo(db, lambda: _remove_dir_unless_referenced(db, "AnalysisDataPath", rel, dst_dir, stop))
    _set_if_changed(row, "AnalysisDataPath", rel)
    _set_if_changed(row, "Analysed", getattr(source, "Analysed", None))
    return copied


def _copy_artwork(db: Any, row: Any, source: Any) -> bool:
    """Copy the source's Artwork dir (artwork.jpg + _l/_m/_s variants) to
    this row's own UUID dir. Never points the new row at the source's files:
    rekordbox treats the dir as owned by its row and would delete or
    overwrite it on a re-import/artwork change of either track."""
    src_rel = getattr(source, "ImagePath", None)
    if not src_rel:
        return False
    share = Path(db.share_directory)
    src_file = share / src_rel.strip("/\\")
    if not src_file.is_file():
        return False
    sub = _uuid_subdir(str(row.UUID))
    dst_dir = share / "PIONEER" / "Artwork" / sub
    stop = share / "PIONEER" / "Artwork"
    if not anlz_copy.copy_artwork_dir(src_file.parent, dst_dir, stop_at=stop):
        return False
    rel = f"/PIONEER/Artwork/{sub}/{src_file.name}"
    _register_undo(db, lambda: _remove_dir_unless_referenced(db, "ImagePath", rel, dst_dir, stop))
    _set_if_changed(row, "ImagePath", rel)
    return True


def apply_content_create(db: Any, op: dict[str, Any]) -> dict[str, Any]:
    """Create (or find, or revive) the DjmdContent row for a local file and,
    given a source row, copy the source's analysis + artwork onto it.

    Input:
        {"curator_track_id": "...", "path": "c:\\\\Music\\\\a.wav",
         "source_rb_content_id": "123" | null,
         "meta": {"Title", "ArtistName", "AlbumName", "LabelName", "GenreName",
                  "Rating", "Comment", "Color", "bpm", "length_sec",
                  "sample_rate", "bit_depth", "channels", "release_year",
                  "key_camelot"}}

    Idempotent per FolderPath: a live row at the path is returned as-is
    (created=False; analysis/artwork only filled in when it has none); a
    soft-deleted one is revived and refreshed. Cues, MyTags and playlist
    membership are NOT handled here — the exporter pushes them with the
    regular ops once it knows rb_content_id.
    """
    meta = op.get("meta") or {}
    folder_path = normalize_folder_path(op["path"])
    source = _live_content(db, op.get("source_rb_content_id"))

    created = revived = False
    matches = _find_content_by_folder_path(db, folder_path)
    if matches and _is_live(matches[0]):
        row = matches[0]
    elif matches:
        row = matches[0]
        row.rb_local_deleted = 0
        revived = True
    else:
        row = db.add_content(folder_path, Title=meta.get("Title"))
        # pyrekordbox stores FolderPath=str(Path(path)), which on Windows is
        # BACKSLASHED. Every rekordbox-written row uses forward slashes, and
        # Curator's reader/exporter match on that form — overwrite before
        # anything else reads the row.
        row.FolderPath = folder_path
        row.FileNameL = folder_path.rsplit("/", 1)[-1]
        _fill_new_content_defaults(row)
        created = True

    if created or revived:
        _fill_new_content_defaults(row)
        _apply_content_link(db, row, source)
        _apply_technical_fields(row, meta, folder_path, source)
        _set_if_changed(row, "FolderPath", folder_path)
        _apply_metadata_fields(db, row, _meta_fields(meta))
        _apply_bpm_key(db, row, meta, source)

    anlz_files: list[str] = []
    artwork_copied = False
    if source is not None and not getattr(row, "AnalysisDataPath", None):
        anlz_files = _copy_analysis(db, row, source)
        if anlz_files and not (created or revived):
            # Pre-existing row gaining the source's grid: keep its BPM/key
            # consistent with that grid (see _apply_bpm_key).
            _apply_bpm_key(db, row, meta, source)
    if source is not None and not getattr(row, "ImagePath", None):
        artwork_copied = _copy_artwork(db, row, source)
    if (created or revived) and not getattr(row, "AnalysisDataPath", None):
        # No analysis to hand over: Analysed=0 makes rekordbox analyse the
        # track on first load instead of trusting an empty grid.
        _set_if_changed(row, "Analysed", 0)

    return {
        "curator_track_id": op.get("curator_track_id"),
        # add_content leaves an int ID on the in-session object; the wire
        # (and every get_content lookup) uses the string form.
        "rb_content_id": str(row.ID),
        "created": created,
        "revived": revived,
        "anlz_copied": bool(anlz_files),
        "anlz_files": anlz_files,
        "artwork_copied": artwork_copied,
        "folder_path": folder_path,
    }


def apply_playlist_create(db: Any, op: dict[str, Any]) -> dict[str, Any]:
    """Create a new playlist at the root via pyrekordbox's create_playlist.

    create_playlist only stages rows (no flush/commit) — safe under the
    per-op SAVEPOINT — but it also appends a NODE to the in-memory
    masterPlaylists6.xml tree, which db.commit() later writes to disk. That
    append is outside the transaction, so register a compensator that drops
    the node again if this op (or the batch commit) rolls back.

    Not idempotent: each call creates a playlist. The exporter records
    rb_playlist_id from the result and never re-sends the create.
    """
    playlist = db.create_playlist(op["name"])
    pid = str(playlist.ID)
    xml = getattr(db, "playlist_xml", None)
    if xml is not None:
        def _drop_xml_node() -> None:
            # Same DB-truth rule as the share/ copies: only drop the node
            # when the playlist row really didn't persist.
            from pyrekordbox.db6.tables import DjmdPlaylist  # type: ignore
            with db.session.no_autoflush:
                exists = db.session.query(DjmdPlaylist.ID).filter(DjmdPlaylist.ID == pid).first()
            if exists is None and xml.get(pid) is not None:
                xml.remove(pid)
        _register_undo(db, _drop_xml_node)
    return {
        "curator_playlist_id": op.get("curator_playlist_id"),
        "rb_playlist_id": pid,
        "created": True,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Public batch entry point — called by main.py's _handle_apply_write_batch.

def _sanitize_strings(value: Any) -> Any:
    """Belt-and-braces mirror of the Node-side scrub (scrubLoneSurrogates):
    replace lone UTF-16 surrogates — which json.loads faithfully reconstructs
    from \\uDCxx escapes — so SQLAlchemy's strict UTF-8 encode at flush can't
    raise "surrogates not allowed". The UTF-16 round-trip (surrogatepass out,
    replace back) maps each lone surrogate to U+FFFD, matching
    String.prototype.toWellFormed on the Node side — a plain
    encode('utf-8', 'replace') would substitute ASCII '?' instead."""
    if isinstance(value, str):
        try:
            value.encode("utf-8")
            return value
        except UnicodeEncodeError:
            return value.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
    if isinstance(value, list):
        return [_sanitize_strings(v) for v in value]
    if isinstance(value, dict):
        return {k: _sanitize_strings(v) for k, v in value.items()}
    return value


_HANDLERS = {
    "track": apply_track_metadata,
    "cues": apply_cues,
    "tags": apply_tags,
    "playlist_merge": apply_playlist_merge,
    "playlist_rename": apply_playlist_rename,
    "content_delete": apply_content_delete,
    "content_create": apply_content_create,
    "playlist_create": apply_playlist_create,
}


# Progress cadence for apply_batch: a frame at most every PROGRESS_MIN_OPS
# ops or PROGRESS_MIN_SECONDS, whichever comes first, plus a final frame at
# done == total. A 4k-op "Sync updates" spent ~30 s in one call with the
# renderer's bar parked at 0; per-op frames would instead flood stdout (and
# Node's JSON parse) on big batches for no visible gain.
PROGRESS_MIN_OPS = 200
PROGRESS_MIN_SECONDS = 0.25


def apply_batch(
    db: Any,
    ops: list[dict[str, Any]],
    on_progress: Optional[Callable[[int, int], None]] = None,
    clock: Callable[[], float] = time.monotonic,
) -> list[dict[str, Any]]:
    """Apply a list of mixed-kind write ops to the session. Does NOT
    commit — caller (main.py) does that after the full batch (or
    sequence of batches) is staged, so a single commit() covers
    everything and the rb_local_usn auto-increment runs once.

    `on_progress(done, total)` is called on the cadence above (never per op)
    and once at the end. It is cosmetic: a raising callback is swallowed so
    a broken progress pipe can't abort a half-staged batch. `clock` is
    injectable for tests.

    Each op has a `kind` discriminator (see `_HANDLERS`). Unknown kinds are
    logged + skipped (forward-compat for Node-side additions).

    Each op applies inside a SAVEPOINT with an explicit flush. A bare
    try/except could not isolate encoding/constraint errors: they surface
    at FLUSH time (autoflush during a later op's query, or the final
    commit) — by which point the session is poisoned (PendingRollbackError)
    and the whole batch used to die (a single lone-surrogate title once
    rolled back an entire sync). Flushing inside the savepoint forces this
    op's SQL to execute NOW; a failure rolls back to the savepoint —
    restoring both DB and in-session object state — and the outer
    transaction stays usable for the remaining ops. Non-DB side effects
    the failed op registered (share/ copies, XML nodes) are undone too —
    the savepoint can't reach them.
    """
    results: list[dict[str, Any]] = []
    session = db.session
    pending = _pending_undo(db)
    total = len(ops)
    last_ops = 0
    last_t = clock()

    def _report(done: int) -> None:
        if on_progress is None:
            return
        try:
            on_progress(done, total)
        except Exception as exc:  # noqa: BLE001 — progress is cosmetic
            sys.stderr.write(f"write: progress callback failed: {type(exc).__name__}: {exc}\n")

    for i, op in enumerate(ops):
        results.append(_apply_one(db, session, pending, op))
        done = i + 1
        if done < total:
            now = clock()
            if done - last_ops >= PROGRESS_MIN_OPS or now - last_t >= PROGRESS_MIN_SECONDS:
                _report(done)
                last_ops, last_t = done, now
    if total > 0:
        _report(total)
    return results


def _apply_one(db: Any, session: Any, pending: list[Callable[[], None]], op: dict[str, Any]) -> dict[str, Any]:
    kind = op.get("kind")
    handler = _HANDLERS.get(kind)
    if handler is None:
        sys.stderr.write(f"write: skipping unknown op kind {kind!r}\n")
        return {"kind": kind, "skipped": True}
    op = _sanitize_strings(op)
    undo_mark = len(pending)
    try:
        with session.begin_nested():
            result = handler(db, op)
            session.flush()
        return {"kind": kind, **result}
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"write op {kind!r} failed: {type(exc).__name__}: {exc}\n")
        failed_undos = pending[undo_mark:]
        del pending[undo_mark:]
        _run_undos(failed_undos)
        failure: dict[str, Any] = {
            "kind": kind,
            "error": f"{type(exc).__name__}: {exc}",
            "skipped": True,
        }
        # Attribution for the Node side's writeFailures surface.
        if "rb_content_id" in op:
            failure["rb_content_id"] = op["rb_content_id"]
        if "rb_playlist_id" in op:
            failure["rb_playlist_id"] = op["rb_playlist_id"]
        # Create ops have no rb id yet — attribute by Curator's id.
        if "curator_track_id" in op:
            failure["curator_track_id"] = op["curator_track_id"]
        if "curator_playlist_id" in op:
            failure["curator_playlist_id"] = op["curator_playlist_id"]
        return failure
