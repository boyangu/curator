"""playlist_merge: adds whose djmdContent row is gone (track deleted in
rekordbox) must be skipped and reported as missing_adds — not exploded on
inside pyrekordbox ('NoneType' object has no attribute 'ID') and silently
retried on every sync, which is what the 2026-07-15 session log showed.

Fake-db based: apply_playlist_merge's surface is get_playlist / get_content /
add_to_playlist / delete / session.query(DjmdSongPlaylist), all stubbed here —
the guard logic is what's under test, not pyrekordbox.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from curator_rekordbox import writer  # noqa: E402


class FakeQuery:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def filter_by(self, **_kw: Any) -> "FakeQuery":
        return self

    def order_by(self, *_a: Any) -> "FakeQuery":
        return self

    def all(self) -> list[Any]:
        return list(self._rows)


class FakeSession:
    def __init__(self, rows: list[Any]) -> None:
        self.rows = rows

    def query(self, *_a: Any) -> FakeQuery:
        return FakeQuery(self.rows)


class FakeDb:
    """One playlist, `existing_content` ids present in djmdContent."""

    def __init__(self, existing_content: set[str]) -> None:
        self.existing = existing_content
        self.playlist = SimpleNamespace(ID="P1", Name="pl", Attribute=0)
        self.rows: list[Any] = []
        self.session = FakeSession(self.rows)
        self.added: list[str] = []

    def get_playlist(self, ID: str) -> Any:
        return self.playlist if ID == "P1" else None

    def get_content(self, ID: str) -> Any:
        return SimpleNamespace(ID=ID) if ID in self.existing else None

    def add_to_playlist(self, pid: str, cid: str) -> None:
        row = SimpleNamespace(ContentID=cid, TrackNo=len(self.rows) + 1)
        self.rows.append(row)
        self.added.append(cid)

    def delete(self, row: Any) -> None:
        self.rows.remove(row)


def test_missing_content_add_is_skipped_and_reported() -> None:
    db = FakeDb(existing_content={"100"})
    result = writer.apply_playlist_merge(db, {
        "rb_playlist_id": "P1",
        "remove": [],
        "add": [
            {"rb_content_id": "100", "position": 1},   # exists → added
            {"rb_content_id": "999", "position": 2},   # deleted in rb → skipped
        ],
        "order": None,
    })
    assert db.added == ["100"]
    assert result["added"] == 1
    assert result["missing_adds"] == ["999"]
    assert result["skipped"] is False


def test_no_missing_adds_key_when_all_exist() -> None:
    db = FakeDb(existing_content={"100", "200"})
    result = writer.apply_playlist_merge(db, {
        "rb_playlist_id": "P1",
        "remove": [],
        "add": [{"rb_content_id": "100", "position": 1}, {"rb_content_id": "200", "position": 2}],
        "order": None,
    })
    assert result["added"] == 2
    assert "missing_adds" not in result
