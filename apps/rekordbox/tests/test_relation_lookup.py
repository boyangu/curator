"""Tombstone-aware Artist/Album/Label/Genre lookup-or-create (writer.py) and
the matching verifier rule.

rekordbox soft-deletes relation rows it no longer uses (rb_local_deleted=1)
and hides them; binding a track to one renders a blank Artist column. Runs
pyrekordbox's real DjmdArtist/DjmdContent models on an in-memory SQLAlchemy
session so the query + create path is exercised for real, with a light FakeDb
standing in for the Rekordbox6Database surface the helper touches
(session / add / flush / generate_unused_id / get_content).
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
        self._next = 1000

    def generate_unused_id(self, table) -> int:  # noqa: ANN001
        self._next += 1
        return self._next

    def add(self, row) -> None:  # noqa: ANN001
        self.session.add(row)

    def flush(self) -> None:
        self.session.flush()

    def get_content(self, ID: str):  # noqa: N803 — mirrors pyrekordbox
        return self.session.get(T.DjmdContent, ID)


@pytest.fixture()
def db() -> FakeDb:
    engine = create_engine("sqlite://")
    # pyrekordbox's models declare NOT NULL on columns the real master.db
    # leaves NULL (e.g. DjmdArtist.SearchStr is None on every row rekordbox
    # itself creates). Relax the model constraints so the fixture matches
    # the production schema the writer actually runs against.
    for model in (T.DjmdArtist, T.DjmdAlbum, T.DjmdLabel, T.DjmdGenre, T.DjmdContent):
        for col in model.__table__.columns:
            if not col.primary_key:
                col.nullable = True
        model.__table__.create(engine)
    return FakeDb(Session(engine))


def artist(db: FakeDb, id_: str, name: str, deleted: int = 0) -> T.DjmdArtist:
    row = T.DjmdArtist.create(ID=id_, Name=name, UUID=f"uuid-{id_}", rb_local_deleted=deleted)
    db.session.add(row)
    db.session.flush()
    return row


def test_live_row_is_reused(db: FakeDb) -> None:
    artist(db, "1", "Lane 8")
    assert writer._lookup_or_create_artist(db, "Lane 8") == "1"
    assert db.session.query(T.DjmdArtist).count() == 1


def test_tombstoned_row_is_skipped_and_a_fresh_row_created(db: FakeDb) -> None:
    artist(db, "1", "Lane 8", deleted=1)
    new_id = writer._lookup_or_create_artist(db, "Lane 8")
    assert new_id != "1"
    rows = db.session.query(T.DjmdArtist).filter_by(Name="Lane 8").all()
    assert {r.ID: int(r.rb_local_deleted or 0) for r in rows} == {"1": 1, new_id: 0}
    # The tombstone is left alone (may be a cloud-sync deletion in flight).
    assert db.session.get(T.DjmdArtist, "1").rb_local_deleted == 1


def test_live_wins_over_tombstone_with_the_same_name(db: FakeDb) -> None:
    artist(db, "old", "Auggië", deleted=1)
    artist(db, "new", "Auggië")
    assert writer._lookup_or_create_artist(db, "Auggië") == "new"


def test_empty_name_clears(db: FakeDb) -> None:
    assert writer._lookup_or_create_artist(db, None) is None
    assert writer._lookup_or_create_artist(db, "") is None


def test_metadata_write_repoints_a_tombstone_binding(db: FakeDb) -> None:
    artist(db, "dead", "Lane 8", deleted=1)
    content = T.DjmdContent.create(ID="C1", Title="Fingerprint", ArtistID="dead", UUID="u-c1")
    db.session.add(content)
    db.session.flush()
    res = writer.apply_track_metadata(db, {"rb_content_id": "C1", "fields": {"ArtistName": "Lane 8"}})
    assert res["changed"] is True
    live = db.session.get(T.DjmdArtist, content.ArtistID)
    assert live.Name == "Lane 8" and int(live.rb_local_deleted or 0) == 0
    assert content.ArtistID != "dead"


def test_verifier_treats_a_tombstoned_relation_as_missing(db: FakeDb) -> None:
    artist(db, "dead", "Lane 8", deleted=1)
    artist(db, "live", "Depart")
    c_dead = T.DjmdContent.create(ID="C1", Title="x", ArtistID="dead", UUID="u1")
    c_live = T.DjmdContent.create(ID="C2", Title="y", ArtistID="live", UUID="u2")
    db.session.add_all([c_dead, c_live])
    db.session.flush()
    bad = verifier._verify_track_metadata(db, {"rb_content_id": "C1", "fields": {"ArtistName": "Lane 8"}})
    assert bad is not None and "ArtistName" in bad and "None" in bad
    assert verifier._verify_track_metadata(db, {"rb_content_id": "C2", "fields": {"ArtistName": "Depart"}}) is None
