"""playlist_merge: TrackNo must stay dense (1..n) after Curator removals.

rekordbox assigns TrackNo = row count + 1 on its own adds and never expects
holes. The writer's removals hard-delete rows without renumbering, so a
playlist that shed members through Curator accumulated holes; the next
rb-side add then collided with existing higher numbers (2026-09-15
`# backlog`: 117 rows numbered 2..188, 21 rb imports numbered 118..138,
8 exact duplicates) and the pull read an interleaved order.

Fake-db based, same surface as test_playlist_merge_missing_adds.
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
    def __init__(self, rows: list[tuple[str, int]] | list[tuple[str, int, str]]) -> None:
        self.playlist = SimpleNamespace(ID="P1", Name="pl", Attribute=0)
        self.rows: list[Any] = []
        for spec in rows:
            cid, no = spec[0], spec[1]
            created = spec[2] if len(spec) > 2 else ""
            self.rows.append(SimpleNamespace(ID=f"row-{cid}", ContentID=cid, TrackNo=no, created_at=created))
        self.session = FakeSession(self.rows)

    def get_playlist(self, ID: str) -> Any:
        return self.playlist if ID == "P1" else None

    def get_content(self, ID: str) -> Any:
        return SimpleNamespace(ID=ID)

    def add_to_playlist(self, pid: str, cid: str) -> None:
        # Mirrors rekordbox / pyrekordbox: count + 1, NOT max + 1.
        self.rows.append(SimpleNamespace(ID=f"row-{cid}", ContentID=cid, TrackNo=len(self.rows) + 1, created_at="new"))

    def delete(self, row: Any) -> None:
        self.rows.remove(row)


def order(db: FakeDb) -> list[tuple[str, int]]:
    return [(r.ContentID, r.TrackNo) for r in sorted(db.rows, key=lambda r: r.TrackNo)]


def test_removal_compacts_remaining_rows_in_place() -> None:
    db = FakeDb([("A", 2), ("B", 5), ("C", 9)])
    result = writer.apply_playlist_merge(db, {"rb_playlist_id": "P1", "remove": ["B"], "add": [], "order": None})
    assert order(db) == [("A", 1), ("C", 2)]
    assert result["removed"] == 1
    assert result["renumbered"] == 2
    assert result["reordered"] is False


def test_add_lands_after_compaction_not_on_a_stale_number() -> None:
    # Without compaction the add would get TrackNo 3 (count+1) and collide
    # with an existing row numbered above it.
    db = FakeDb([("A", 2), ("B", 9)])
    writer.apply_playlist_merge(db, {"rb_playlist_id": "P1", "remove": [], "add": [{"rb_content_id": "C", "position": 3}], "order": None})
    assert order(db) == [("A", 1), ("B", 2), ("C", 3)]


def test_already_dense_playlist_is_untouched() -> None:
    db = FakeDb([("A", 1), ("B", 2), ("C", 3)])
    result = writer.apply_playlist_merge(db, {"rb_playlist_id": "P1", "remove": [], "add": [], "order": None})
    assert order(db) == [("A", 1), ("B", 2), ("C", 3)]
    assert result["renumbered"] == 0


def test_duplicate_numbers_resolve_old_before_new() -> None:
    # Legacy collision shape: rb appended X at count+1 == an old row's number.
    db = FakeDb([("A", 1), ("B", 3, "2026-06-01"), ("X", 3, "2026-09-15"), ("C", 4)])
    writer.apply_playlist_merge(db, {"rb_playlist_id": "P1", "remove": [], "add": [], "order": None})
    assert order(db) == [("A", 1), ("B", 2), ("X", 3), ("C", 4)]


def test_explicit_order_still_wins_after_compaction() -> None:
    db = FakeDb([("A", 2), ("B", 5), ("C", 9)])
    result = writer.apply_playlist_merge(db, {"rb_playlist_id": "P1", "remove": [], "add": [], "order": ["C", "A", "B"]})
    assert order(db) == [("C", 1), ("A", 2), ("B", 3)]
    assert result["reordered"] is True
