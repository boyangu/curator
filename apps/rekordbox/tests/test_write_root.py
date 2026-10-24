"""CURATOR_RB_WRITE_ROOT: the write-side RPCs refuse any path outside it.

The rekordbox end-to-end run (e2e/) spawns this sidecar against a work-dir
copy of master.db with the variable set to that copy's directory; these
checks are what keep a wrong path from reaching the live library. Everything
here lives under tmp_path; the "outside" files are temp files too, and the
assertions include that they were left byte-for-byte alone.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from curator_rekordbox import main  # noqa: E402


@pytest.fixture()
def frames(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    monkeypatch.setattr(main, "_write", out.append)
    return out


@pytest.fixture()
def dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    root = tmp_path / "work" / "rb"
    outside = tmp_path / "live" / "rekordbox"
    root.mkdir(parents=True)
    outside.mkdir(parents=True)
    (outside / "master.db").write_bytes(b"live library")
    monkeypatch.setenv(main.WRITE_ROOT_ENV, str(root))
    return root, outside


def test_unset_allows_everything(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv(main.WRITE_ROOT_ENV, raising=False)
    assert main.write_root_refusal(str(tmp_path / "anywhere" / "master.db")) is None


def test_inside_allowed_outside_refused(dirs: tuple[Path, Path]) -> None:
    root, outside = dirs
    assert main.write_root_refusal(str(root / "master.db")) is None
    assert main.write_root_refusal(str(root)) is None
    assert main.write_root_refusal(str(outside / "master.db")) is not None
    # `..` cannot climb out, and a sibling sharing the root's name prefix is
    # not inside it.
    assert main.write_root_refusal(str(root / ".." / ".." / "live" / "rekordbox" / "master.db")) is not None
    assert main.write_root_refusal(str(root.parent / "rb-reference" / "master.db")) is not None
    # One bad path refuses the call.
    assert main.write_root_refusal(str(root / "master.db"), str(outside / "master.db")) is not None


def test_backup_outside_refused(dirs: tuple[Path, Path], frames: list[dict[str, Any]]) -> None:
    _, outside = dirs
    main._dispatch({"id": 1, "method": "backup", "params": {"dbPath": str(outside / "master.db")}})
    assert frames[-1]["id"] == 1 and "outside" in frames[-1]["error"]["message"]
    assert sorted(p.name for p in outside.iterdir()) == ["master.db"]


def test_backup_inside_runs(dirs: tuple[Path, Path], frames: list[dict[str, Any]]) -> None:
    root, _ = dirs
    (root / "master.db").write_bytes(b"copy")
    main._dispatch({"id": 2, "method": "backup", "params": {"dbPath": str(root / "master.db")}})
    assert "result" in frames[-1], frames[-1]
    assert Path(frames[-1]["result"]["path"]).parent == root


def test_open_for_write_outside_refused(dirs: tuple[Path, Path], frames: list[dict[str, Any]]) -> None:
    _, outside = dirs
    main._dispatch({"id": 3, "method": "open_for_write", "params": {"dbPath": str(outside / "master.db")}})
    assert "outside" in frames[-1]["error"]["message"]
    assert main._db_state["mode"] is None


def test_restore_onto_outside_refused(dirs: tuple[Path, Path], frames: list[dict[str, Any]]) -> None:
    root, outside = dirs
    backup = root / "master_2026-10-24T00-00-00.db"
    backup.write_bytes(b"backup")
    main._dispatch({"id": 4, "method": "restore_backup", "params": {"backupPath": str(backup), "dbPath": str(outside / "master.db")}})
    assert "outside" in frames[-1]["error"]["message"]
    assert (outside / "master.db").read_bytes() == b"live library"


def test_clear_backups_outside_refused(dirs: tuple[Path, Path], frames: list[dict[str, Any]]) -> None:
    _, outside = dirs
    mine = outside / "master_2026-10-24T00-00-00.db"
    mine.write_bytes(b"backup")
    main._dispatch({"id": 5, "method": "clear_backups", "params": {"dbDir": str(outside)}})
    assert "outside" in frames[-1]["error"]["message"]
    assert mine.exists()
