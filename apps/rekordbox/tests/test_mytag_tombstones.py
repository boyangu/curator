"""Tombstoned MyTag handling on the write side.

rekordbox soft-deletes MyTag rows (rb_local_deleted=1) and hides them; a
DjmdSongMyTag row pointing at one is invisible. apply_tags revives any
tombstoned tag a pushed track references; _verify_tags fails when a
referenced tag is still dead. Real pyrekordbox models on an in-memory
session, same fixture shape as test_relation_lookup.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pyrekordbox.db6 import tables as T  # noqa: E402

from curator_rekordbox import verifier, writer  # noqa: E402


class FakeDb:
    def __init__(self, session: Session) -> None:
        self.session = session
        self._next = 5000

    def generate_unused_id(self, table) -> int:  # noqa: ANN001
        self._next += 1
        return self._next

    def add(self, row) -> None:  # noqa: ANN001
        self.session.add(row)

    def delete(self, row) -> None:  # noqa: ANN001
        self.session.delete(row)

    def flush(self) -> None:
        self.session.flush()

    def get_content(self, ID: str):  # noqa: N803
        return self.session.get(T.DjmdContent, ID)


@pytest.fixture()
def db() -> FakeDb:
    engine = create_engine("sqlite://")
    for model in (T.DjmdMyTag, T.DjmdSongMyTag, T.DjmdContent):
        for col in model.__table__.columns:
            if not col.primary_key:
                col.nullable = True
        model.__table__.create(engine)
    s = Session(engine)
    s.add(T.DjmdContent.create(ID="C1", Title="x", UUID="u1"))
    s.add(T.DjmdMyTag.create(ID="live", Name="vocal", ParentID="2", UUID="t1", rb_local_deleted=0))
    s.add(T.DjmdMyTag.create(ID="dead", Name="controlling", ParentID="3", UUID="t2", rb_local_deleted=1))
    s.flush()
    return FakeDb(s)


def test_apply_tags_revives_a_referenced_tombstone(db: FakeDb) -> None:
    res = writer.apply_tags(db, {"rb_content_id": "C1", "rb_tag_ids": ["live", "dead"]})
    db.session.flush()
    assert res["inserted"] == 2 and res["revived"] == 1
    assert int(db.session.get(T.DjmdMyTag, "dead").rb_local_deleted) == 0
    assert int(db.session.get(T.DjmdMyTag, "live").rb_local_deleted) == 0
    assert verifier._verify_tags(db, {"rb_content_id": "C1", "rb_tag_ids": ["live", "dead"]}) is None


def test_apply_tags_leaves_unreferenced_tombstones_alone(db: FakeDb) -> None:
    res = writer.apply_tags(db, {"rb_content_id": "C1", "rb_tag_ids": ["live"]})
    assert res["revived"] == 0
    assert int(db.session.get(T.DjmdMyTag, "dead").rb_local_deleted) == 1


def test_verify_fails_on_a_membership_at_a_dead_tag(db: FakeDb) -> None:
    db.session.add(T.DjmdSongMyTag(ID="s1", MyTagID="dead", ContentID="C1", TrackNo=0))
    db.session.flush()
    msg = verifier._verify_tags(db, {"rb_content_id": "C1", "rb_tag_ids": ["dead"]})
    assert msg is not None and "tombstoned" in msg and "dead" in msg
