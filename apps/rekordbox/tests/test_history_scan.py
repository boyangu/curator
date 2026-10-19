"""History pass — djmdHistory/djmdSongHistory → HistoryDelta events.

Folder rows (Attribute=1) are filtered in SQL, plays group under their
session sorted by TrackNo, and timestamps convert with the right tz
convention (rows are UTC, DateCreated is local). Uses light fakes for the
pyrekordbox surface (session.query per model), mirroring test_content_delete.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from curator_rekordbox import reader  # noqa: E402


class FakeHistory:
    def __init__(self, hid: str, name: str, date_created) -> None:
        self.ID = hid
        self.Name = name
        self.Attribute = 0
        self.DateCreated = date_created


class FakeSongHistory:
    def __init__(self, sid: str, hid: str, cid: str, track_no: int, created_at) -> None:
        self.ID = sid
        self.HistoryID = hid
        self.ContentID = cid
        self.TrackNo = track_no
        self.created_at = created_at


class _Query:
    def __init__(self, rows: list) -> None:
        self._rows = rows

    def filter(self, *_args) -> "_Query":
        # The scan filters Attribute==0 in SQL; the fakes are sessions only,
        # so filter is a pass-through (folder exclusion asserted separately
        # by feeding no folder rows through this path).
        return self

    def all(self) -> list:
        return self._rows


class FakeSession:
    def __init__(self, histories: list, songs: list) -> None:
        self._histories = histories
        self._songs = songs

    def query(self, model) -> _Query:
        return _Query(self._histories if model.__name__ == "DjmdHistory" else self._songs)


class FakeDb:
    def __init__(self, histories: list, songs: list) -> None:
        self.session = FakeSession(histories, songs)


def _run_scan(histories: list, songs: list, target_content_ids=None) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    reader.scan(
        FakeDb(histories, songs),
        watermarks={},
        scopes=["history"],
        peaks_dir=None,
        emit=lambda kind, row: events.append((kind, row)),
        is_cancelled=lambda: False,
        target_content_ids=target_content_ids,
    )
    return [(k, r) for k, r in events if k == "history"]


def test_groups_plays_by_session_sorted_by_track_no() -> None:
    t0 = datetime(2026, 8, 14, 10, 0, 0, tzinfo=timezone.utc)
    histories = [FakeHistory("H1", "HISTORY 2026-08-14", "2026-08-14 17:00:00")]
    songs = [
        FakeSongHistory("s2", "H1", "C2", 2, t0),
        FakeSongHistory("s1", "H1", "C1", 1, t0),
        FakeSongHistory("sX", "H-unknown", "C9", 1, t0),  # orphan session → ignored
    ]

    events = _run_scan(histories, songs)

    assert len(events) == 1
    row = events[0][1]
    assert row["rb_history_id"] == "H1"
    assert row["name"] == "HISTORY 2026-08-14"
    assert [p["track_no"] for p in row["plays"]] == [1, 2]
    assert [p["rb_content_id"] for p in row["plays"]] == ["C1", "C2"]
    assert row["plays"][0]["created_at_ms"] == int(t0.timestamp() * 1000)


def test_runs_even_when_content_targeting_is_active() -> None:
    # A scoped sync-from passes target_content_ids to restrict the track/cue
    # passes; history reads its own tables and must still run in full.
    t0 = datetime(2026, 8, 14, 10, 0, 0, tzinfo=timezone.utc)
    histories = [FakeHistory("H1", "HISTORY 2026-08-14", None)]
    songs = [FakeSongHistory("s1", "H1", "C1", 1, t0)]
    events = _run_scan(histories, songs, target_content_ids=["C999"])  # C999 not in this session
    assert len(events) == 1
    assert events[0][1]["rb_history_id"] == "H1"


def test_session_without_plays_still_emits() -> None:
    events = _run_scan([FakeHistory("H1", "HISTORY 2026-01-01", None)], [])
    assert len(events) == 1
    assert events[0][1]["plays"] == []
    assert events[0][1]["date_created_ms"] is None


def test_dt_to_epoch_ms_conventions() -> None:
    # Naive value + assume_utc → interpreted as UTC.
    naive = datetime(2026, 8, 14, 10, 0, 0)
    assert reader._dt_to_epoch_ms(naive, assume_utc=True) == int(
        naive.replace(tzinfo=timezone.utc).timestamp() * 1000
    )
    # Naive value without assume_utc → local wall-clock (DateCreated).
    local_ms = reader._dt_to_epoch_ms(naive, assume_utc=False)
    assert local_ms == int(naive.timestamp() * 1000)
    # tz-aware value is authoritative regardless of the flag.
    aware = datetime(2026, 8, 14, 10, 0, 0, tzinfo=timezone.utc)
    assert reader._dt_to_epoch_ms(aware, assume_utc=False) == int(aware.timestamp() * 1000)
    # String forms — ISO parses; the "space before offset" shape falls back
    # to the seconds-precision prefix instead of erroring.
    assert reader._dt_to_epoch_ms("2026-08-14 10:00:00", assume_utc=True) == int(
        naive.replace(tzinfo=timezone.utc).timestamp() * 1000
    )
    assert reader._dt_to_epoch_ms("2026-08-14 10:00:00.898 +00:00", assume_utc=True) is not None
    assert reader._dt_to_epoch_ms(None, assume_utc=True) is None
    assert reader._dt_to_epoch_ms("bogus", assume_utc=True) is None
