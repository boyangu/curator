"""anlz_copy: lossless ANLZ copy with a rewritten PPTH tag.

Fixtures under fixtures/anlz/ are ONE real rekordbox 7 analysis dir
(DAT/EXT/2EX/3EX) with PPTH neutralised to "?/track.flac" — rekordbox 7's
own "?/<file name>" form. They include the tags pyrekordbox can't parse
(PVB2 in EXT, PVDI in 2EX), which is exactly what a parse/save round-trip
would drop and what these tests prove survives.
"""

from __future__ import annotations

import hashlib
import shutil
import struct
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from curator_rekordbox import anlz_copy  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "anlz"


def _digest(d: Path) -> dict[str, str]:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(d.iterdir())}


@pytest.fixture()
def src(tmp_path: Path) -> Path:
    d = tmp_path / "src"
    shutil.copytree(FIXTURES, d)
    return d


def test_fixtures_carry_no_personal_paths() -> None:
    for f in FIXTURES.iterdir():
        data = f.read_bytes()
        # Any home-directory or music-folder fragment: fixtures must come from
        # a synthetic path, never from a real library.
        for needle in ("Users", "Music", "home/"):
            for enc in ("utf-16-be", "utf-8"):
                assert needle.encode(enc) not in data, (f.name, needle, enc)


def test_copy_rewrites_only_ppth(src: Path, tmp_path: Path) -> None:
    before = _digest(src)
    dst = tmp_path / "share" / "PIONEER" / "USBANLZ" / "abc" / "def-123"
    copied = anlz_copy.copy_anlz_dir(src, dst, "C:/Music/WAV/New Track.wav")

    assert copied == ["DAT", "EXT", "2EX"]
    # .3EX is a MessagePack embedding with track-identity fields — skipped.
    assert sorted(p.name for p in dst.iterdir()) == ["ANLZ0000.2EX", "ANLZ0000.DAT", "ANLZ0000.EXT"]
    for ext in copied:
        old = (src / f"ANLZ0000.{ext}").read_bytes()
        new = (dst / f"ANLZ0000.{ext}").read_bytes()
        old_tags = anlz_copy.iter_tags(old)
        new_tags = anlz_copy.iter_tags(new)
        assert [t for t, _ in old_tags] == [t for t, _ in new_tags]
        for (t, ob), (_, nb) in zip(old_tags, new_tags):
            if t != "PPTH":
                assert ob == nb, f"{ext}/{t} changed"
        # Source form was "?/<name>" → the copy uses the same form.
        assert anlz_copy.read_ppth(new) == "?/New Track.wav"
        assert struct.unpack(">I", new[8:12])[0] == len(new)
        # PPTH tag's own length fields agree with its payload.
        ppth = dict(new_tags)["PPTH"]
        _, len_tag, len_path = struct.unpack(">III", ppth[4:16])
        assert len_tag == len(ppth) == 16 + len_path
    # The original is only ever read.
    assert _digest(src) == before


def test_unparseable_tags_survive(src: Path, tmp_path: Path) -> None:
    dst = tmp_path / "dst"
    anlz_copy.copy_anlz_dir(src, dst, "C:/x/a.wav")
    assert "PVB2" in [t for t, _ in anlz_copy.iter_tags((dst / "ANLZ0000.EXT").read_bytes())]
    assert "PVDI" in [t for t, _ in anlz_copy.iter_tags((dst / "ANLZ0000.2EX").read_bytes())]


def test_pyrekordbox_reads_the_new_path(src: Path, tmp_path: Path) -> None:
    from pyrekordbox.anlz import AnlzFile

    dst = tmp_path / "dst"
    anlz_copy.copy_anlz_dir(src, dst, "C:/x/Ünïcode – name.wav")
    for ext in ("DAT", "EXT", "2EX"):
        assert AnlzFile.parse_file(dst / f"ANLZ0000.{ext}").get("path") == "?/Ünïcode – name.wav"


def test_full_path_source_form_is_mirrored(src: Path, tmp_path: Path) -> None:
    for ext in ("DAT", "EXT", "2EX"):
        f = src / f"ANLZ0000.{ext}"
        f.write_bytes(anlz_copy.rewrite_ppth(f.read_bytes(), "C:/fixture/track.flac"))
    dst = tmp_path / "dst"
    anlz_copy.copy_anlz_dir(src, dst, "C:/Music/WAV/a.wav")
    assert anlz_copy.read_ppth((dst / "ANLZ0000.DAT").read_bytes()) == "C:/Music/WAV/a.wav"


def test_refuses_existing_destination(src: Path, tmp_path: Path) -> None:
    dst = tmp_path / "dst"
    dst.mkdir()
    (dst / "keep.txt").write_text("mine")
    with pytest.raises(FileExistsError):
        anlz_copy.copy_anlz_dir(src, dst, "C:/x/a.wav")
    assert [p.name for p in dst.iterdir()] == ["keep.txt"]


def test_failure_leaves_nothing_behind(src: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "USBANLZ"
    root.mkdir()
    dst = root / "abc" / "def"

    def boom(a, b):  # noqa: ANN001
        raise OSError("rename failed")

    monkeypatch.setattr(anlz_copy.os, "rename", boom)
    with pytest.raises(OSError):
        anlz_copy.copy_anlz_dir(src, dst, "C:/x/a.wav", stop_at=root)
    # No dst, no staging sibling, and the "abc" parent we created is gone.
    assert list(root.iterdir()) == []


def test_malformed_source_fails_before_touching_destination(src: Path, tmp_path: Path) -> None:
    dat = src / "ANLZ0000.DAT"
    dat.write_bytes(dat.read_bytes()[:-10])  # truncated → len_file mismatch
    dst = tmp_path / "a" / "b"
    with pytest.raises(anlz_copy.AnlzFormatError):
        anlz_copy.copy_anlz_dir(src, dst, "C:/x/a.wav")
    assert not (tmp_path / "a").exists()


def test_no_dat_means_nothing_to_copy(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    assert anlz_copy.copy_anlz_dir(empty, tmp_path / "dst", "C:/x/a.wav") == []
    assert not (tmp_path / "dst").exists()


def test_artwork_dir_copy_and_undo(tmp_path: Path) -> None:
    art = tmp_path / "art"
    art.mkdir()
    for name in ("artwork.jpg", "artwork_l.jpg", "artwork_m.jpg", "artwork_s.jpg"):
        (art / name).write_bytes(name.encode())
    root = tmp_path / "Artwork"
    root.mkdir()
    dst = root / "abc" / "def"
    assert anlz_copy.copy_artwork_dir(art, dst, stop_at=root) == [
        "artwork.jpg", "artwork_l.jpg", "artwork_m.jpg", "artwork_s.jpg"]
    assert (dst / "artwork_s.jpg").read_bytes() == b"artwork_s.jpg"
    with pytest.raises(FileExistsError):
        anlz_copy.copy_artwork_dir(art, dst, stop_at=root)
    anlz_copy.remove_created_dir(dst, stop_at=root)
    assert list(root.iterdir()) == []
    assert len(list(art.iterdir())) == 4


def test_ppth_matches_accepts_both_forms() -> None:
    assert anlz_copy.ppth_matches("C:/a/b.wav", "C:/a/b.wav")
    assert anlz_copy.ppth_matches("?/b.wav", "C:/a/b.wav")
    assert not anlz_copy.ppth_matches("?/c.wav", "C:/a/b.wav")
    assert not anlz_copy.ppth_matches(None, "C:/a/b.wav")
