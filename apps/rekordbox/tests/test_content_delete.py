"""apply_content_delete — soft-deleting a track from rekordbox's Collection.

Sets rb_local_deleted=1 on DjmdContent (rekordbox's own tombstone convention)
plus its DjmdSongPlaylist rows, idempotently. Uses light fakes for the
pyrekordbox surface (get_content + session.query) so the flag logic is under
test, not pyrekordbox's schema.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from curator_rekordbox import writer  # noqa: E402


class FakeContent:
    def __init__(self, deleted: int = 0) -> None:
        self.rb_local_deleted = deleted


class FakeSong:
    def __init__(self, deleted: int = 0) -> None:
        self.rb_local_deleted = deleted


class _Query:
    def __init__(self, rows: list) -> None:
        self._rows = rows

    def filter_by(self, **_kwargs) -> "_Query":
        return self

    def all(self) -> list:
        return self._rows


class FakeSession:
    def __init__(self, songs: list) -> None:
        self._songs = songs

    def query(self, _model) -> _Query:
        return _Query(self._songs)


class FakeDb:
    def __init__(self, content, songs) -> None:
        self._content = content
        self.session = FakeSession(songs)

    def get_content(self, ID: str):  # noqa: N803 — mirrors pyrekordbox
        return self._content


def test_soft_deletes_content_and_memberships() -> None:
    content = FakeContent(deleted=0)
    songs = [FakeSong(0), FakeSong(0)]
    db = FakeDb(content, songs)

    res = writer.apply_content_delete(db, {"kind": "content_delete", "rb_content_id": "C1"})

    assert content.rb_local_deleted == 1
    assert all(s.rb_local_deleted == 1 for s in songs)
    assert res["changed"] is True
    assert res["memberships_removed"] == 2


def test_idempotent_when_already_deleted() -> None:
    content = FakeContent(deleted=1)
    db = FakeDb(content, [FakeSong(1)])

    res = writer.apply_content_delete(db, {"kind": "content_delete", "rb_content_id": "C1"})

    # No write happened → no USN churn on the next commit.
    assert res["changed"] is False
    assert res["memberships_removed"] == 0


def test_missing_content_reports_missing() -> None:
    db = FakeDb(None, [])

    res = writer.apply_content_delete(db, {"kind": "content_delete", "rb_content_id": "GONE"})

    assert res["skipped"] is True
    assert res["missing"] is True
    assert res["changed"] is False
