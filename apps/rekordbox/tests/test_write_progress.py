"""Progress cadence of writer.apply_batch.

A "Sync updates" batch can be thousands of ops inside ONE apply_write_batch
call; without progress frames the renderer's bar sat at 0 for ~30 s. The
writer reports (done, total) at most every PROGRESS_MIN_OPS ops or
PROGRESS_MIN_SECONDS, whichever comes first, plus once at the end — never
per op (that would flood stdout and Node's frame parser on big batches).

Runs against plain in-memory SQLAlchemy with a stand-in handler and an
injected clock, like test_writer_isolation.py: the cadence is under test,
not pyrekordbox.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from curator_rekordbox import writer  # noqa: E402


class FakeDb:
    def __init__(self, session: Session) -> None:
        self.session = session


class FakeClock:
    """Advances by `step` seconds on every read — one read per applied op."""

    def __init__(self, step: float) -> None:
        self.t = 0.0
        self.step = step

    def __call__(self) -> float:
        self.t += self.step
        return self.t


@pytest.fixture()
def db() -> FakeDb:
    return FakeDb(Session(create_engine("sqlite://")))


@pytest.fixture(autouse=True)
def noop_handler(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(writer._HANDLERS, "track", lambda _db, op: {"changed": False, "rb_content_id": op["rb_content_id"]})


def _ops(n: int) -> list[dict]:
    return [{"kind": "track", "rb_content_id": str(i), "fields": {}} for i in range(n)]


def _run(db: FakeDb, n: int, step: float) -> list[tuple[int, int]]:
    frames: list[tuple[int, int]] = []
    writer.apply_batch(db, _ops(n), on_progress=lambda d, t: frames.append((d, t)), clock=FakeClock(step))
    return frames


def test_fast_batch_reports_every_200_ops_then_the_end(db: FakeDb) -> None:
    # Ops far quicker than the time threshold → the op count governs.
    frames = _run(db, 1000, step=0.0001)
    assert frames == [(200, 1000), (400, 1000), (600, 1000), (800, 1000), (1000, 1000)]


def test_slow_batch_reports_on_the_time_threshold(db: FakeDb) -> None:
    # 0.1 s per op → the 250 ms threshold trips every third op, well before 200.
    frames = _run(db, 10, step=0.1)
    assert [d for d, _ in frames] == [3, 6, 9, 10]
    assert all(t == 10 for _, t in frames)


def test_cadence_is_bounded_and_monotonic(db: FakeDb) -> None:
    frames = _run(db, 4412, step=0.006)  # ~26 s batch, the measured live shape
    done = [d for d, _ in frames]
    assert done == sorted(done) and len(set(done)) == len(done)
    assert done[-1] == 4412
    # Never closer than the op threshold unless the time threshold tripped
    # (0.25 s / 0.006 s ≈ 42 ops) — so at most ~one frame per 42 ops here,
    # nowhere near one per op.
    gaps = [b - a for a, b in zip([0] + done, done)]
    assert min(gaps[:-1]) >= 40
    assert len(frames) < 4412 // 40 + 2


def test_empty_batch_reports_nothing(db: FakeDb) -> None:
    assert _run(db, 0, step=1.0) == []


def test_raising_callback_does_not_abort_the_batch(db: FakeDb) -> None:
    def boom(_d: int, _t: int) -> None:
        raise BrokenPipeError("stdout gone")

    results = writer.apply_batch(db, _ops(450), on_progress=boom, clock=FakeClock(0.0001))
    assert len(results) == 450
    assert all("error" not in r for r in results)


def test_no_callback_is_the_old_behaviour(db: FakeDb) -> None:
    results = writer.apply_batch(db, _ops(3))
    assert [r["rb_content_id"] for r in results] == ["0", "1", "2"]
