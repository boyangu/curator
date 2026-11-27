"""mytag_ensure — giving a Curator-made tag a DjmdMyTag row.

Reuse a live same-name tag, else revive a tombstoned one, else create a row
filled the way rekordbox fills its own (see apply_mytag_ensure). Real
pyrekordbox models on an in-memory session, same fixture shape as
test_mytag_tombstones.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pyrekordbox.db6 import tables as T  # noqa: E402

from curator_rekordbox import reader, writer  # noqa: E402


class FakeDb:
    def __init__(self, session: Session) -> None:
        self.session = session
        self.id_args: list[dict] = []
        self._next = 3_000_000_000  # above 28 bits, like rekordbox's own ids

    def generate_unused_id(self, table, **kwargs) -> int:  # noqa: ANN001
        self.id_args.append(kwargs)
        self._next += 1
        return self._next

    def add(self, row) -> None:  # noqa: ANN001
        self.session.add(row)

    def flush(self) -> None:
        self.session.flush()


@pytest.fixture()
def db() -> FakeDb:
    engine = create_engine("sqlite://")
    for col in T.DjmdMyTag.__table__.columns:
        if not col.primary_key:
            col.nullable = True
    T.DjmdMyTag.__table__.create(engine)
    s = Session(engine)
    for gid, seq, name in (("1", 1, "Genre"), ("2", 2, "Components"), ("3", 3, "Situation"), ("4", 4, "attributes")):
        s.add(T.DjmdMyTag.create(ID=gid, Seq=seq, Name=name, Attribute=1, ParentID="root", UUID=gid))
    s.add(T.DjmdMyTag.create(ID="100", Seq=1, Name="wonder", Attribute=0, ParentID="4", UUID="a"))
    s.add(T.DjmdMyTag.create(ID="101", Seq=7, Name="fragile", Attribute=0, ParentID="4", UUID="b"))
    s.add(T.DjmdMyTag.create(ID="102", Seq=9, Name="gone", Attribute=0, ParentID="4", UUID="c", rb_local_deleted=1))
    s.add(T.DjmdMyTag.create(ID="200", Seq=1, Name="Vocal", Attribute=0, ParentID="2", UUID="d"))
    s.add(T.DjmdMyTag.create(ID="201", Seq=2, Name="controlling", Attribute=0, ParentID="2", UUID="e", rb_local_deleted=1))
    s.flush()
    return FakeDb(s)


def _op(name: str, group_id=None, group_name="attributes") -> dict:  # noqa: ANN001
    return {"kind": "mytag_ensure", "curator_tag_id": "cur-1", "name": name, "group_id": group_id, "group_name": group_name}


def test_live_same_name_tag_is_reused_case_insensitively(db: FakeDb) -> None:
    res = writer.apply_mytag_ensure(db, _op("  vocal "))
    assert res == {"curator_tag_id": "cur-1", "rb_tag_id": "200", "created": False, "revived": False}
    assert db.session.query(T.DjmdMyTag).count() == 9


def test_tombstoned_same_name_tag_is_revived(db: FakeDb) -> None:
    res = writer.apply_mytag_ensure(db, _op("Controlling"))
    assert res["rb_tag_id"] == "201" and res["revived"] is True and res["created"] is False
    assert int(db.session.get(T.DjmdMyTag, "201").rb_local_deleted) == 0


def test_group_rows_never_match_a_tag_name(db: FakeDb) -> None:
    res = writer.apply_mytag_ensure(db, _op("Genre"))
    assert res["created"] is True and res["rb_tag_id"] not in {"1", "2", "3", "4"}


def test_new_tag_is_filled_like_rekordbox_fills_its_own(db: FakeDb) -> None:
    res = writer.apply_mytag_ensure(db, _op("bluerama"))
    assert res["created"] is True
    row = db.session.get(T.DjmdMyTag, res["rb_tag_id"])
    assert row.Name == "bluerama"
    assert row.Attribute == 0
    assert row.ParentID == "4"
    # Next Seq among the group's LIVE tags (the tombstoned Seq 9 doesn't count).
    assert row.Seq == 8
    assert len(row.UUID) == 36 and row.UUID.count("-") == 4
    assert (row.rb_data_status, row.rb_local_data_status, row.rb_local_deleted, row.rb_local_synced) == (0, 0, 0, 0)
    assert row.usn is None
    # rekordbox's MyTag ids span the full 32 bits, not pyrekordbox's 28-bit default.
    assert db.id_args == [{"is_28_bit": False}]
    assert isinstance(row.ID, str) and int(row.ID) > 2**28


def test_group_id_wins_over_group_name(db: FakeDb) -> None:
    res = writer.apply_mytag_ensure(db, _op("newtag", group_id="3"))
    row = db.session.get(T.DjmdMyTag, res["rb_tag_id"])
    assert row.ParentID == "3" and row.Seq == 1


def test_missing_group_falls_back_to_name_then_first_group(db: FakeDb) -> None:
    by_name = writer.apply_mytag_ensure(db, _op("a1", group_id="999", group_name="Components"))
    assert db.session.get(T.DjmdMyTag, by_name["rb_tag_id"]).ParentID == "2"
    first = writer.apply_mytag_ensure(db, _op("a2", group_id=None, group_name="no such group"))
    assert db.session.get(T.DjmdMyTag, first["rb_tag_id"]).ParentID == "1"


def test_tombstoned_group_is_not_used(db: FakeDb) -> None:
    db.session.get(T.DjmdMyTag, "4").rb_local_deleted = 1
    db.session.flush()
    res = writer.apply_mytag_ensure(db, _op("x"))
    assert db.session.get(T.DjmdMyTag, res["rb_tag_id"]).ParentID == "1"


def test_empty_name_is_refused(db: FakeDb) -> None:
    with pytest.raises(ValueError):
        writer.apply_mytag_ensure(db, _op("   "))


def test_batch_is_idempotent_by_name(db: FakeDb) -> None:
    # Two Curator tags differing only in case resolve to one MyTag; a retry
    # (e.g. after a failed commit) finds the row instead of minting a second.
    results = writer.apply_batch(db, [_op("Warmup"), {**_op("warmup"), "curator_tag_id": "cur-2"}])
    assert [r["kind"] for r in results] == ["mytag_ensure", "mytag_ensure"]
    assert results[0]["created"] is True and results[1]["created"] is False
    assert results[0]["rb_tag_id"] == results[1]["rb_tag_id"]
    assert results[1]["curator_tag_id"] == "cur-2"
    assert db.session.query(T.DjmdMyTag).filter_by(Name="Warmup").count() == 1


def test_settings_lists_live_groups_in_rekordbox_order(db: FakeDb) -> None:
    db.session.get(T.DjmdMyTag, "3").rb_local_deleted = 1
    db.session.get(T.DjmdMyTag, "1").Seq = 9
    db.session.flush()
    assert reader.query_mytag_groups(db.session) == [
        {"id": "2", "name": "Components"},
        {"id": "4", "name": "attributes"},
        {"id": "1", "name": "Genre"},
    ]
