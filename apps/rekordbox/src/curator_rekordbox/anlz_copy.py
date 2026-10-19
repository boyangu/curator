"""Copy a track's rekordbox analysis (ANLZ) + artwork to a new content row.

Used by `content_create` (writer.py) when Curator pushes a lossless WAV copy
of a FLAC rekordbox already analysed: the WAV has the same timing, so the
FLAC's beatgrid / waveforms / phrases are valid for it verbatim — only the
embedded file path (PPTH tag) has to change.

Pure filesystem functions (src_dir, dst_dir, folder_path) so they unit-test
without a database.

Why a byte-level tag walker instead of pyrekordbox's AnlzFile.parse/save
(the route `update_content_path` uses): pyrekordbox's parser silently DROPS
every tag it has no struct for, and save() rebuilds from the parsed tags.
On the live library that loses PVB2 in .EXT (~27% of files) and PVDI in
.2EX (~36%) — measured 2026-10-08 against copies of 300 real files. The
walker below only re-encodes PPTH and copies every other tag's bytes
untouched, so the copy is lossless by construction; pyrekordbox is still
used afterwards to prove the result parses and carries the new path.

PPTH format: every sampled file (400/400, rekordbox 7.2) stores
"?/<file name>" — not the full FolderPath — as UTF-16BE with a trailing
NUL. We mirror whatever form the SOURCE file uses (see `ppth_for`), so an
older full-path library stays consistent too.

.3EX is not copied. It is not a PMAI file at all but a MessagePack blob
({"embedding": {...}}) holding rekordbox 7's similarity embedding plus
per-track identity fields (a content-id-like string, an md5-like hash, the
length and BPM). We can't tell what those identify, so carrying them onto a
different row could make rekordbox trust a mismatched embedding. ~38% of
the live library has no .3EX, so its absence is a state rekordbox already
handles (it regenerates it itself).
"""

from __future__ import annotations

import os
import shutil
import struct
import uuid
from pathlib import Path
from typing import Optional, Union

PathLike = Union[str, Path]

# PMAI-structured files we copy (PPTH rewritten). Order = report order.
COPIED_EXTS: tuple[str, ...] = ("DAT", "EXT", "2EX")
# Present in rekordbox 7 dirs; deliberately skipped (see module docstring).
SKIPPED_EXTS: tuple[str, ...] = ("3EX",)

_PPTH_HEADER_LEN = 16  # type(4) + len_header(4) + len_tag(4) + len_path(4)


class AnlzFormatError(ValueError):
    """The bytes aren't a PMAI file we can rewrite safely."""


def _walk_tags(data: bytes) -> tuple[int, list[tuple[str, int, int]]]:
    """Return (len_file_header, [(tag_type, offset, len_tag), ...]).

    Validates strictly — the declared file length must equal the byte
    length and the tag chain must land exactly on it — because rewriting a
    file we misread would be silent corruption of the copy."""
    if len(data) < 12 or data[:4] != b"PMAI":
        raise AnlzFormatError("not a PMAI file")
    len_header, len_file = struct.unpack(">II", data[4:12])
    if len_file != len(data):
        raise AnlzFormatError(f"len_file {len_file} != file size {len(data)}")
    if len_header < 12 or len_header > len_file:
        raise AnlzFormatError(f"bad file header length {len_header}")
    tags: list[tuple[str, int, int]] = []
    i = len_header
    while i < len_file:
        if i + 12 > len_file:
            raise AnlzFormatError(f"truncated tag header at {i}")
        try:
            tag_type = data[i:i + 4].decode("ascii")
        except UnicodeDecodeError as exc:
            raise AnlzFormatError(f"non-ascii tag type at {i}") from exc
        tag_hdr, len_tag = struct.unpack(">II", data[i + 4:i + 12])
        if len_tag < 12 or tag_hdr > len_tag or i + len_tag > len_file:
            raise AnlzFormatError(f"bad {tag_type} lengths at {i}")
        tags.append((tag_type, i, len_tag))
        i += len_tag
    return len_header, tags


def iter_tags(data: bytes) -> list[tuple[str, bytes]]:
    """[(tag_type, raw tag bytes incl. header), ...] — tests/diagnostics."""
    _, tags = _walk_tags(data)
    return [(t, data[off:off + n]) for t, off, n in tags]


def read_ppth(data: bytes) -> Optional[str]:
    """The path stored in the file's PPTH tag (NUL stripped), or None."""
    _, tags = _walk_tags(data)
    for tag_type, off, _len_tag in tags:
        if tag_type == "PPTH":
            (len_path,) = struct.unpack(">I", data[off + 12:off + 16])
            raw = data[off + _PPTH_HEADER_LEN:off + _PPTH_HEADER_LEN + len_path]
            return raw.decode("utf-16-be").rstrip("\x00")
    return None


def _build_ppth(path: str) -> bytes:
    payload = (path + "\x00").encode("utf-16-be")
    return (
        b"PPTH"
        + struct.pack(">III", _PPTH_HEADER_LEN, _PPTH_HEADER_LEN + len(payload), len(payload))
        + payload
    )


def rewrite_ppth(data: bytes, new_path: str) -> bytes:
    """Return `data` with its single PPTH tag re-encoded to `new_path` and
    the PMAI len_file header updated. Every other byte is copied verbatim."""
    len_header, tags = _walk_tags(data)
    ppth = [t for t in tags if t[0] == "PPTH"]
    if len(ppth) != 1:
        raise AnlzFormatError(f"expected exactly one PPTH tag, found {len(ppth)}")
    out = bytearray(data[:len_header])
    for tag_type, off, len_tag in tags:
        out += _build_ppth(new_path) if tag_type == "PPTH" else data[off:off + len_tag]
    out[8:12] = struct.pack(">I", len(out))
    return bytes(out)


def ppth_for(folder_path: str, source_ppth: Optional[str]) -> str:
    """The PPTH value to write for a row at `folder_path`, in the same form
    the source file used: rekordbox 7 writes "?/<file name>"; older files
    carry the full forward-slash FolderPath."""
    if source_ppth is not None and source_ppth.startswith("?/"):
        return "?/" + folder_path.replace("\\", "/").rsplit("/", 1)[-1]
    return folder_path


def ppth_matches(ppth: Optional[str], folder_path: str) -> bool:
    """True when `ppth` is either accepted form for `folder_path`."""
    if ppth is None:
        return False
    return ppth in (folder_path, ppth_for(folder_path, "?/"))


_patches_applied = False


def _validate_with_pyrekordbox(data: bytes, expected_path: str) -> None:
    """Belt-and-braces: the output must parse with pyrekordbox (the parser
    our reader uses) and report the new path."""
    global _patches_applied
    if not _patches_applied:
        # main.py applies these at sidecar boot; standalone callers (tests,
        # scripts) need them too or RB7 PQT2 tags fail to parse.
        from ._pyrekordbox_patches import apply_pyrekordbox_patches
        apply_pyrekordbox_patches()
        _patches_applied = True
    from pyrekordbox.anlz import AnlzFile  # type: ignore
    got = AnlzFile.parse(data).get("path")
    if got != expected_path:
        raise AnlzFormatError(f"rewritten PPTH reads back as {got!r}, expected {expected_path!r}")


def _missing_parents(dst_dir: Path, stop: Optional[Path]) -> list[Path]:
    """Ancestors of dst_dir that don't exist yet (deepest first), bounded by
    `stop`, so failure cleanup removes exactly the dirs we created."""
    out: list[Path] = []
    p = dst_dir.parent
    while not p.exists() and (stop is None or p != stop) and p != p.parent:
        out.append(p)
        p = p.parent
    return out


def _remove_empty(dirs: list[Path]) -> None:
    for d in dirs:
        try:
            d.rmdir()  # only succeeds when empty — never removes others' data
        except OSError:
            pass


def _stage_and_publish(dst: Path, stop_at: Optional[PathLike], fill) -> None:  # noqa: ANN001
    """Run `fill(tmp_dir)` into a fresh hidden sibling of `dst`, then rename
    it into place. Same parent ⇒ same volume, so the rename is atomic and a
    failure never leaves a half-populated destination. On failure the
    staging dir and any parent dirs this call created are removed."""
    if dst.exists():
        raise FileExistsError(f"destination already exists: {dst}")
    new_parents = _missing_parents(dst, Path(stop_at) if stop_at else None)
    tmp: Optional[Path] = None
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.parent / f".{dst.name}.curator-tmp-{uuid.uuid4().hex[:8]}"
        tmp.mkdir()
        fill(tmp)
        os.rename(tmp, dst)
    except BaseException:
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)
        _remove_empty(new_parents)
        raise


def copy_anlz_dir(src_dir: PathLike, dst_dir: PathLike, folder_path: str,
                  stop_at: Optional[PathLike] = None) -> list[str]:
    """Copy DAT/EXT/2EX from `src_dir` into a NEW `dst_dir`, rewriting PPTH
    for `folder_path` (in the source's PPTH form). Returns the copied
    extensions, e.g. ["DAT", "EXT", "2EX"]; [] when src has no DAT (nothing
    usable — the caller then leaves the row unanalysed).

    Refuses (FileExistsError) when dst_dir already exists — a fresh row UUID
    never has one, so an existing dir is something we must not clobber.
    All-or-nothing; the source files are only ever read.
    """
    src = Path(src_dir)
    dst = Path(dst_dir)
    if dst.exists():
        raise FileExistsError(f"ANLZ destination already exists: {dst}")
    if not (src / "ANLZ0000.DAT").is_file():
        return []
    # Rewrite everything in memory first so a malformed source fails before
    # we touch the destination tree at all.
    outputs: list[tuple[str, bytes]] = []
    for ext in COPIED_EXTS:
        f = src / f"ANLZ0000.{ext}"
        if not f.is_file():
            continue
        data = f.read_bytes()
        new_ppth = ppth_for(folder_path, read_ppth(data))
        out = rewrite_ppth(data, new_ppth)
        _validate_with_pyrekordbox(out, new_ppth)
        outputs.append((ext, out))

    def fill(tmp: Path) -> None:
        for ext, out in outputs:
            (tmp / f"ANLZ0000.{ext}").write_bytes(out)

    _stage_and_publish(dst, stop_at, fill)
    return [ext for ext, _ in outputs]


def copy_artwork_dir(src_dir: PathLike, dst_dir: PathLike,
                     stop_at: Optional[PathLike] = None) -> list[str]:
    """Copy every regular file of a rekordbox Artwork dir (artwork.jpg plus
    the artwork_l/_m/_s size variants rekordbox keeps alongside) into a NEW
    dst_dir. Same refuse-if-exists + stage-then-rename contract as
    copy_anlz_dir. Returns the copied file names ([] when src is empty)."""
    src = Path(src_dir)
    dst = Path(dst_dir)
    if dst.exists():
        raise FileExistsError(f"artwork destination already exists: {dst}")
    files = sorted(p for p in src.iterdir() if p.is_file()) if src.is_dir() else []
    if not files:
        return []

    def fill(tmp: Path) -> None:
        for f in files:
            shutil.copy2(f, tmp / f.name)

    _stage_and_publish(dst, stop_at, fill)
    return [f.name for f in files]


def remove_created_dir(path: PathLike, stop_at: Optional[PathLike] = None) -> None:
    """Undo a successful copy_*: delete the dir, then any now-empty parents
    up to (not including) `stop_at`."""
    p = Path(path)
    shutil.rmtree(p, ignore_errors=True)
    if stop_at is None:
        return
    stop = Path(stop_at)
    parent = p.parent
    while parent != stop and parent != parent.parent and stop in parent.parents:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent
