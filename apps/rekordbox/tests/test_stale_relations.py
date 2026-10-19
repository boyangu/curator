"""`list_stale_relations` probe shape: one entry per live content row, naming
WHICH relations are tombstoned (fields) and the names of tombstoned MyTags it
is still a member of. The exporter's "Sync updates" sweep needs the
per-relation detail to skip tracks the push can't heal (an empty Curator
value is never pushed, so the dead FK would be re-sent forever).

Runs the real SQL against pyrekordbox's models on an in-memory session, same
fixture shape as test_relation_lookup.py / test_mytag_tombstones.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pyrekordbox.db6 import tables as T  # noqa: E402

from curator_rekordbox import reader  # noqa: E402


@pytest.fixture()
def session() -> Session:
    engine = create_engine("sqlite://")
    for model in (T.DjmdArtist, T.DjmdAlbum, T.DjmdLabel, T.DjmdGenre, T.DjmdMyTag, T.DjmdSongMyTag, T.DjmdContent):
        for col in model.__table__.columns:
            if not col.primary_key:
                col.nullable = True
        model.__table__.create(engine)
    s = Session(engine)
    s.add_all([
        T.DjmdArtist.create(ID="a_live", Name="Lane 8", UUID="ua1", rb_local_deleted=0),
        T.DjmdArtist.create(ID="a_dead", Name="Depart", UUID="ua2", rb_local_deleted=1),
        T.DjmdAlbum.create(ID="b_dead", Name="Remembering", UUID="ub1", rb_local_deleted=1),
        T.DjmdLabel.create(ID="l_dead", Name="This Never Happened", UUID="ul1", rb_local_deleted=1),
        T.DjmdGenre.create(ID="g_live", Name="Melodic", UUID="ug1", rb_local_deleted=0),
        T.DjmdMyTag.create(ID="t_live", Name="peak", ParentID="1", UUID="ut1", rb_local_deleted=0),
        T.DjmdMyTag.create(ID="t_dead", Name="vocal", ParentID="1", UUID="ut2", rb_local_deleted=1),
        T.DjmdMyTag.create(ID="t_dead2", Name="afterglow", ParentID="1", UUID="ut3", rb_local_deleted=1),
        # Clean: live artist + genre, live tag.
        T.DjmdContent.create(ID="C_ok", Title="ok", ArtistID="a_live", GenreID="g_live", UUID="u1", rb_local_deleted=0),
        # Dead album only (the live "Remembering" shape).
        T.DjmdContent.create(ID="C_album", Title="r", ArtistID="a_live", AlbumID="b_dead", UUID="u2", rb_local_deleted=0),
        # Dead artist + label + two dead tags.
        T.DjmdContent.create(ID="C_multi", Title="m", ArtistID="a_dead", LabelID="l_dead", UUID="u3", rb_local_deleted=0),
        # Dead tag only.
        T.DjmdContent.create(ID="C_tag", Title="t", ArtistID="a_live", UUID="u4", rb_local_deleted=0),
        # Deleted content is never reported, whatever it points at.
        T.DjmdContent.create(ID="C_gone", Title="g", ArtistID="a_dead", UUID="u5", rb_local_deleted=1),
    ])
    s.add_all([
        T.DjmdSongMyTag(ID="s1", MyTagID="t_live", ContentID="C_ok", TrackNo=0, rb_local_deleted=0),
        T.DjmdSongMyTag(ID="s2", MyTagID="t_dead", ContentID="C_multi", TrackNo=0, rb_local_deleted=0),
        T.DjmdSongMyTag(ID="s3", MyTagID="t_dead2", ContentID="C_multi", TrackNo=0, rb_local_deleted=0),
        T.DjmdSongMyTag(ID="s4", MyTagID="t_dead", ContentID="C_tag", TrackNo=0, rb_local_deleted=0),
        # A deleted membership at a dead tag is not stale.
        T.DjmdSongMyTag(ID="s5", MyTagID="t_dead2", ContentID="C_tag", TrackNo=0, rb_local_deleted=1),
        T.DjmdSongMyTag(ID="s6", MyTagID="t_dead", ContentID="C_gone", TrackNo=0, rb_local_deleted=0),
    ])
    s.flush()
    return s


def test_probe_reports_which_relations_are_stale(session: Session) -> None:
    assert reader.query_stale_relations(session) == [
        {"rbContentId": "C_album", "fields": ["album"], "myTags": []},
        {"rbContentId": "C_multi", "fields": ["artist", "label"], "myTags": ["afterglow", "vocal"]},
        {"rbContentId": "C_tag", "fields": [], "myTags": ["vocal"]},
    ]


def test_shape_groups_dedupes_and_orders() -> None:
    rows = [
        ("9", "genre", None),
        ("9", "artist", None),
        ("9", "artist", None),
        ("9", "mytag", "vocal"),
        ("9", "mytag", "vocal"),
        (10, "mytag", None),  # nameless dead tag: still stale, nothing to match
    ]
    assert reader.shape_stale_relations(rows) == [
        {"rbContentId": "10", "fields": [], "myTags": []},
        {"rbContentId": "9", "fields": ["artist", "genre"], "myTags": ["vocal"]},
    ]


def test_shape_empty() -> None:
    assert reader.shape_stale_relations([]) == []
