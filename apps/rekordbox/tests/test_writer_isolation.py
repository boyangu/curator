"""Per-op SAVEPOINT isolation in writer.apply_batch.

Reproduces the production failure class for real: a lone UTF-16 surrogate in
an op's string raises "surrogates not allowed" at FLUSH time (Python's
sqlite3 driver refuses the UTF-8 encode at bind, same as SQLCipher against
master.db). The old bare try/except couldn't catch that — the error surfaced
at the batch-level commit with the session already poisoned, and one bad
string rolled back an entire sync.

Asserts: (1) with sanitization bypassed, the bad op fails AT ITS OWN flush,
is reported with error + rb_content_id, and the NEXT op still applies (the
session is not poisoned); (2) with sanitization on, the same batch succeeds
end-to-end and the stored value carries U+FFFD.

Runs against plain in-memory SQLAlchemy with a stand-in table + handlers —
the isolation logic (begin_nested + flush + rollback-restore) is what's
under test, not pyrekordbox's schema.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import Column, String, create_engine
from sqlalchemy.orm import Session, declarative_base

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from curator_rekordbox import writer  # noqa: E402

Base = declarative_base()


class Content(Base):
    __tablename__ = "content"
    id = Column(String, primary_key=True)
    title = Column(String)


class FakeDb:
    def __init__(self, session: Session) -> None:
        self.session = session


def _apply_track(db: FakeDb, op: dict) -> dict:
    db.session.add(Content(id=op["rb_content_id"], title=op["fields"]["Title"]))
    return {"changed": True, "rb_content_id": op["rb_content_id"]}


@pytest.fixture()
def db() -> FakeDb:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    return FakeDb(Session(engine))


@pytest.fixture()
def track_handler(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(writer._HANDLERS, "track", _apply_track)


BATCH = [
    {"kind": "track", "rb_content_id": "C1", "fields": {"Title": "Clean Before"}},
    {"kind": "track", "rb_content_id": "C2", "fields": {"Title": "Ti\udc90tle"}},
    {"kind": "track", "rb_content_id": "C3", "fields": {"Title": "Clean After"}},
]


def test_bad_op_is_isolated_and_batch_continues(
    db: FakeDb, track_handler: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Bypass the belt so the braces get exercised: the surrogate reaches
    # the flush and must fail THERE, inside the op's own savepoint.
    monkeypatch.setattr(writer, "_sanitize_strings", lambda v: v)

    results = writer.apply_batch(db, [dict(op, fields=dict(op["fields"])) for op in BATCH])

    assert results[0] == {"kind": "track", "changed": True, "rb_content_id": "C1"}
    assert results[1]["skipped"] is True
    assert results[1]["rb_content_id"] == "C2"
    assert "surrogates not allowed" in results[1]["error"]
    # The load-bearing bit: op 3 still applied — the session survived op 2.
    assert results[2] == {"kind": "track", "changed": True, "rb_content_id": "C3"}

    db.session.commit()
    titles = {c.id: c.title for c in db.session.query(Content).all()}
    assert titles == {"C1": "Clean Before", "C3": "Clean After"}


def test_sanitization_lets_the_whole_batch_land(db: FakeDb, track_handler: None) -> None:
    results = writer.apply_batch(db, [dict(op, fields=dict(op["fields"])) for op in BATCH])

    assert all("error" not in r for r in results)
    db.session.commit()
    titles = {c.id: c.title for c in db.session.query(Content).all()}
    assert titles["C2"] == "Ti�tle"  # U+FFFD, mirroring toWellFormed


def test_unknown_kind_is_skipped_not_fatal(db: FakeDb, track_handler: None) -> None:
    results = writer.apply_batch(db, [
        {"kind": "hologram", "rb_content_id": "X"},
        {"kind": "track", "rb_content_id": "C9", "fields": {"Title": "Fine"}},
    ])
    assert results[0] == {"kind": "hologram", "skipped": True}
    assert results[1]["changed"] is True
