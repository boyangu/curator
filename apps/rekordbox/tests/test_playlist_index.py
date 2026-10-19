"""Playlists pass — existence index (PlaylistIndex) emission.

rekordbox hard-deletes DjmdPlaylist rows no sync peer has seen (only rows with
rb_local_synced=1 get a tombstone), so the reader emits `playlist_index` after
a COMPLETE playlists pass: every live id on a whole-library read, the
requested-but-missing ids on a targeted pull, and nothing at all when the
fetch failed or the pass was cancelled. Light fakes for the pyrekordbox
surface, mirroring test_history_scan.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from curator_rekordbox import reader  # noqa: E402


class FakePlaylist:
    def __init__(self, pid: str, name: str, attribute: int = 0, usn: int = 1, deleted: int = 0) -> None:
        self.ID = pid
        self.Name = name
        self.Attribute = attribute
        self.ParentID = "root"
        self.Seq = 0
        self.rb_local_usn = usn
        self.rb_local_deleted = deleted


class _Query:
    def __init__(self, rows: list) -> None:
        self._rows = rows

    def filter(self, *_args) -> "_Query":
        return self

    def order_by(self, *_args) -> "_Query":
        return self

    def all(self) -> list:
        return self._rows


class FakeSession:
    # The pass hits DjmdSongPlaylist twice (USN scan + per-playlist members);
    # both come back empty — membership is not under test here.
    def query(self, *_entities) -> _Query:
        return _Query([])


class FakeDb:
    def __init__(self, playlists: list, fail: bool = False) -> None:
        self.session = FakeSession()
        self._playlists = playlists
        self._fail = fail

    def get_playlist(self) -> list:
        if self._fail:
            raise RuntimeError("boom")
        return list(self._playlists)


def _scan(db: FakeDb, *, watermarks=None, target_playlist_ids=None, cancel_after=None) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    calls = {"n": 0}

    def is_cancelled() -> bool:
        if cancel_after is None:
            return False
        calls["n"] += 1
        return calls["n"] > cancel_after

    reader.scan(
        db,
        watermarks=watermarks or {},
        scopes=["playlists"],
        peaks_dir=None,
        emit=lambda kind, row: events.append((kind, row)),
        is_cancelled=is_cancelled,
        target_playlist_ids=target_playlist_ids,
    )
    return events


def _indexes(events) -> list[dict]:
    return [r for k, r in events if k == "playlist_index"]


def _delta_ids(events) -> list[str]:
    return [r["rb_playlist_id"] for k, r in events if k == "playlist"]


ROWS = [
    FakePlaylist("P1", "changed", usn=5),
    FakePlaylist("P2", "unchanged", usn=1),
    FakePlaylist("F1", "folder", attribute=1, usn=1),
    FakePlaylist("D1", "tombstoned", usn=9, deleted=1),
]


def test_whole_library_index_lists_every_live_id_even_under_the_watermark() -> None:
    events = _scan(FakeDb(ROWS), watermarks={"DjmdPlaylist": 3})

    # Deltas still ride the USN gate; the index does not.
    assert _delta_ids(events) == ["P1", "D1"]
    idx = _indexes(events)
    assert len(idx) == 1
    assert idx[0] == {"live_ids": ["P1", "P2", "F1"], "missing_ids": None}


def test_cancelled_pass_emits_no_index() -> None:
    events = _scan(FakeDb(ROWS), cancel_after=1)

    assert len(_delta_ids(events)) < len(ROWS)
    assert _indexes(events) == []


def test_failed_fetch_emits_no_index() -> None:
    events = _scan(FakeDb(ROWS, fail=True))

    assert _delta_ids(events) == []
    assert _indexes(events) == []


def test_targeted_pull_reports_only_requested_ids_that_are_gone() -> None:
    events = _scan(FakeDb(ROWS), target_playlist_ids=["P1", "GONE", "F1", "D1"])

    assert _delta_ids(events) == ["P1", "F1", "D1"]
    idx = _indexes(events)
    assert len(idx) == 1
    # A tombstoned row is not live either — the importer's tombstone branch
    # already removed it, so listing it here is harmless and consistent.
    assert idx[0] == {"live_ids": None, "missing_ids": ["D1", "GONE"]}


def test_targeted_pull_with_no_ids_emits_nothing() -> None:
    events = _scan(FakeDb(ROWS), target_playlist_ids=[])

    assert _delta_ids(events) == []
    assert _indexes(events) == []
