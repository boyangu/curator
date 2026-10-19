"""content_create / playlist_create (writer.py) + their verifiers.

Runs pyrekordbox's REAL Rekordbox6Database — add_content, create_playlist,
the USN registry, masterPlaylists6.xml handling — against an unencrypted
temp SQLite file built from pyrekordbox's own table models (unlock=False),
with a temp share/ dir holding the neutralised ANLZ fixtures as the
"source FLAC" analysis. Nothing here touches a real rekordbox library.
"""

from __future__ import annotations

import datetime
import hashlib
import shutil
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pyrekordbox import Rekordbox6Database  # noqa: E402
from pyrekordbox.db6 import tables as T  # noqa: E402

from curator_rekordbox import anlz_copy, verifier, writer  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "anlz"
SRC_UUID = "0011abec-ce9e-4ae2-944b-62d9639819d7"
XML = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<MASTER_PLAYLIST Version="3.0.0" AutomaticSync="0">\n'
    '<PRODUCT Name="rekordbox" Version="7.2.19" Company="Pioneer DJ"/>\n'
    "<PLAYLISTS>\n</PLAYLISTS>\n</MASTER_PLAYLIST>\n"
)


def _digest(d: Path) -> dict[str, str]:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(d.iterdir())}


@pytest.fixture()
def db(tmp_path: Path):
    root = tmp_path / "rb"
    root.mkdir()
    db_path = root / "master.db"
    engine = create_engine(f"sqlite:///{db_path}")
    # pyrekordbox's models declare NOT NULL on columns the real master.db
    # leaves NULL (see test_relation_lookup); relax them for the fixture DDL.
    for table in T.Base.metadata.tables.values():
        for col in table.columns:
            if not col.primary_key:
                col.nullable = True
    T.Base.metadata.create_all(engine)
    engine.dispose()
    (root / "masterPlaylists6.xml").write_text(XML, encoding="utf-8")

    rdb = Rekordbox6Database(db_path, db_dir=root, unlock=False)
    now = datetime.datetime.now()
    s = rdb.session
    s.add(T.AgentRegistry(registry_id="localUpdateCount", int_1=1000, date_1=now, date_2=now))
    s.add(T.DjmdMenuItems(ID="1", Class=1, Name="TRACK", UUID="menu", rb_local_usn=7))
    s.add(T.DjmdDevice(ID="dev-1", MasterDBID="999", Name="PC", UUID="dev"))
    for kid, name, deleted in (("k-am", "Am", 0), ("k-9a", "9A", 0), ("k-fm", "Fm", 1), ("k-dm", "Dm", 0)):
        s.add(T.DjmdKey(ID=kid, ScaleName=name, Seq=1, UUID=kid, rb_local_deleted=deleted))

    # Source FLAC row with analysis + artwork under share/.
    share = Path(rdb.share_directory)
    anlz_dir = share / "PIONEER" / "USBANLZ" / SRC_UUID[:3] / SRC_UUID[3:]
    shutil.copytree(FIXTURES, anlz_dir)
    art_dir = share / "PIONEER" / "Artwork" / SRC_UUID[:3] / SRC_UUID[3:]
    art_dir.mkdir(parents=True)
    for name in ("artwork.jpg", "artwork_l.jpg", "artwork_m.jpg", "artwork_s.jpg"):
        (art_dir / name).write_bytes(name.encode())
    s.add(T.DjmdContent(
        ID="500", UUID=SRC_UUID, Title="Src", FolderPath="C:/Music/flat/Src.flac",
        FileType=5, BPM=12345, KeyID="k-dm", Length=403, Analysed=105, ContentLink=3999246,
        AnalysisDataPath=f"/PIONEER/USBANLZ/{SRC_UUID[:3]}/{SRC_UUID[3:]}/ANLZ0000.DAT",
        ImagePath=f"/PIONEER/Artwork/{SRC_UUID[:3]}/{SRC_UUID[3:]}/artwork.jpg",
        rb_local_deleted=0,
    ))
    s.commit()
    rdb._test_root = root  # noqa: SLF001
    yield rdb
    try:
        rdb.close()
    finally:
        rdb.engine.dispose()


@pytest.fixture()
def wav(tmp_path: Path) -> Path:
    d = tmp_path / "Music" / "WAV"
    d.mkdir(parents=True)
    f = d / "Artist - Title.wav"
    f.write_bytes(b"RIFF" + b"\0" * 1000)
    return f


def _messy(p: Path) -> str:
    """Lowercase drive letter + backslashes — what Node may send."""
    s = str(p).replace("/", "\\")
    return s[0].lower() + s[1:]


def _norm(p: Path) -> str:
    s = str(p).replace("\\", "/")
    return s[0].upper() + s[1:]


META = {
    "Title": "Title [WAV]", "ArtistName": "A, B", "AlbumName": "Alb", "LabelName": "Lbl",
    "GenreName": "House", "Rating": 4, "Comment": "c", "Color": "red",
    "bpm": 123.0, "length_sec": 240, "sample_rate": 44100, "bit_depth": 24, "channels": 2,
    "release_year": 2021, "key_camelot": "8A",
}


def _op(path: str, source: str | None = None, **meta) -> dict:  # noqa: ANN003
    return {"kind": "content_create", "curator_track_id": "cur-1", "path": path,
            "source_rb_content_id": source, "meta": {**META, **meta}}


def _reload(db, cid: str) -> T.DjmdContent:  # noqa: ANN001
    # Fresh read straight from SQL — not the in-session object add_content
    # returned (that one is keyed by an int ID).
    db.session.expire_all()
    return db.session.query(T.DjmdContent).filter(T.DjmdContent.ID == cid).one()


def test_create_without_source(db, wav: Path) -> None:  # noqa: ANN001
    [res] = writer.apply_batch(db, [_op(_messy(wav))])
    assert "error" not in res, res
    assert res["created"] is True and res["revived"] is False
    assert res["anlz_copied"] is False and res["anlz_files"] == [] and res["artwork_copied"] is False
    assert res["folder_path"] == _norm(wav)
    assert res["curator_track_id"] == "cur-1"

    row = _reload(db, res["rb_content_id"])
    assert row.FolderPath == _norm(wav)  # forward slashes, uppercase drive
    assert "\\" not in row.FolderPath
    assert row.FileNameL == "Artist - Title.wav"
    assert row.FileType == 11
    assert (row.SampleRate, row.BitDepth, row.BitRate) == (44100, 24, 2116)
    assert row.Length == 240 and row.FileSize == wav.stat().st_size
    # DJPlayCount is VARCHAR in pyrekordbox's model (INTEGER in real master.db).
    assert row.DeliveryControl == "on" and int(row.DJPlayCount) == 0 and row.ReleaseYear == 2021
    assert row.BPM == 12300
    assert row.KeyID == "k-am"  # 8A ↔ Am
    assert row.AnalysisDataPath is None and row.Analysed == 0
    assert row.ImagePath is None
    assert row.Title == "Title [WAV]" and row.Rating == 4 and row.Commnt == "c"
    assert row.Artist.Name == "A, B" and row.Album.Name == "Alb" and row.Label.Name == "Lbl"
    assert row.Genre.Name == "House"
    assert int(row.ColorID) == writer._COLOR_NAME_TO_ID["red"]

    # The later `track` op with the same values is a no-op.
    t = writer.apply_track_metadata(db, {"rb_content_id": res["rb_content_id"],
                                         "fields": writer._meta_fields(META)})
    assert t["changed"] is False


def test_bitrate_for_16_bit(db, wav: Path) -> None:  # noqa: ANN001
    [res] = writer.apply_batch(db, [_op(str(wav), bit_depth=16)])
    assert _reload(db, res["rb_content_id"]).BitRate == 1411


def test_second_call_is_idempotent(db, wav: Path) -> None:  # noqa: ANN001
    [first] = writer.apply_batch(db, [_op(_messy(wav))])
    [second] = writer.apply_batch(db, [_op(_norm(wav).lower())])
    assert second["created"] is False and second["revived"] is False
    assert second["rb_content_id"] == first["rb_content_id"]
    n = db.session.query(T.DjmdContent).filter(T.DjmdContent.FileType == 11).count()
    assert n == 1


def test_soft_deleted_row_is_revived(db, wav: Path) -> None:  # noqa: ANN001
    [first] = writer.apply_batch(db, [_op(str(wav))])
    row = _reload(db, first["rb_content_id"])
    row.rb_local_deleted = 1
    row.FolderPath = _messy(wav)  # stale slash style on the tombstone
    db.session.flush()

    [res] = writer.apply_batch(db, [_op(str(wav), Title="Again")])
    assert res["revived"] is True and res["created"] is False
    assert res["rb_content_id"] == first["rb_content_id"]
    row = _reload(db, res["rb_content_id"])
    assert row.rb_local_deleted == 0
    assert row.FolderPath == _norm(wav)
    assert row.Title == "Again"


def test_create_with_source_copies_analysis_and_artwork(db, wav: Path) -> None:  # noqa: ANN001
    share = Path(db.share_directory)
    src_anlz = share / "PIONEER" / "USBANLZ" / SRC_UUID[:3] / SRC_UUID[3:]
    before = _digest(src_anlz)

    [res] = writer.apply_batch(db, [_op(_messy(wav), source="500")])
    assert "error" not in res, res
    assert res["anlz_copied"] is True and res["anlz_files"] == ["DAT", "EXT", "2EX"]
    assert res["artwork_copied"] is True

    row = _reload(db, res["rb_content_id"])
    uuid = row.UUID
    assert uuid != SRC_UUID
    assert row.AnalysisDataPath == f"/PIONEER/USBANLZ/{uuid[:3]}/{uuid[3:]}/ANLZ0000.DAT"
    assert row.ImagePath == f"/PIONEER/Artwork/{uuid[:3]}/{uuid[3:]}/artwork.jpg"
    # BPM/Key/Analysed follow the SOURCE (its grid), not Curator's meta.
    assert row.BPM == 12345 and row.KeyID == "k-dm" and row.Analysed == 105

    dst = share / row.AnalysisDataPath.strip("/")
    assert anlz_copy.read_ppth(dst.read_bytes()) == "?/Artist - Title.wav"
    assert not (dst.parent / "ANLZ0000.3EX").exists()
    art = share / row.ImagePath.strip("/")
    assert sorted(p.name for p in art.parent.iterdir()) == [
        "artwork.jpg", "artwork_l.jpg", "artwork_m.jpg", "artwork_s.jpg"]
    assert _digest(src_anlz) == before

    ok = verifier._verify_content_create(db, {"rb_content_id": res["rb_content_id"],
                                              "path": _messy(wav), "anlz_copied": True})
    assert ok is None


def test_length_falls_back_to_source(db, wav: Path) -> None:  # noqa: ANN001
    [res] = writer.apply_batch(db, [_op(str(wav), source="500", length_sec=None)])
    assert _reload(db, res["rb_content_id"]).Length == 403


def test_key_lookup_rules(db) -> None:  # noqa: ANN001
    assert writer._lookup_key_id(db, "8A") == "k-am"
    assert writer._lookup_key_id(db, "08a") == "k-am"
    assert writer._lookup_key_id(db, "9A") == "k-9a"  # stored in Camelot notation
    assert writer._lookup_key_id(db, "4A") is None  # only a tombstoned Fm
    assert writer._lookup_key_id(db, "1B") is None  # no row; never created
    assert writer._lookup_key_id(db, None) is None
    assert db.session.query(T.DjmdKey).count() == 4


def test_existing_row_without_analysis_gets_source_analysis(db, wav: Path) -> None:  # noqa: ANN001
    [first] = writer.apply_batch(db, [_op(str(wav))])
    [res] = writer.apply_batch(db, [_op(str(wav), source="500")])
    assert res["created"] is False and res["anlz_copied"] is True
    row = _reload(db, first["rb_content_id"])
    assert row.BPM == 12345 and row.KeyID == "k-dm" and row.Analysed == 105
    # Third call: already has analysis — nothing re-copied.
    [again] = writer.apply_batch(db, [_op(str(wav), source="500")])
    assert again["anlz_copied"] is False and again["artwork_copied"] is False


def test_failed_op_rolls_back_row_and_files(db, wav: Path, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
    def boom(*a, **k):  # noqa: ANN002, ANN003
        raise RuntimeError("artwork disk full")

    monkeypatch.setattr(writer.anlz_copy, "copy_artwork_dir", boom)
    share = Path(db.share_directory)
    before_anlz = sorted(p.name for p in (share / "PIONEER" / "USBANLZ").iterdir())

    [res] = writer.apply_batch(db, [_op(str(wav), source="500")])
    assert res["skipped"] is True and "artwork disk full" in res["error"]
    assert res["curator_track_id"] == "cur-1"
    # SAVEPOINT undid the row; the compensator undid the ANLZ copy.
    assert db.session.query(T.DjmdContent).filter(T.DjmdContent.FileType == 11).count() == 0
    assert sorted(p.name for p in (share / "PIONEER" / "USBANLZ").iterdir()) == before_anlz
    assert getattr(db, writer._UNDO_ATTR) == []


def test_missing_file_failure_is_attributed(db, tmp_path: Path) -> None:  # noqa: ANN001
    [res] = writer.apply_batch(db, [_op(str(tmp_path / "nope.wav"))])
    assert res["skipped"] is True and res["curator_track_id"] == "cur-1"
    assert "rb_content_id" not in res


def _open_outer_transaction(db) -> None:  # noqa: ANN001
    # Any DML makes pysqlite emit BEGIN, so the per-op SAVEPOINTs nest inside
    # a real transaction and a session rollback truly discards them.
    db.session.execute(text("UPDATE agentRegistry SET int_2 = 1"))


def test_commit_failure_discards_unpersisted_copies(db, wav: Path) -> None:  # noqa: ANN001
    _open_outer_transaction(db)
    share = Path(db.share_directory)
    [res] = writer.apply_batch(db, [_op(str(wav), source="500")])
    row = _reload(db, res["rb_content_id"])
    dat = share / row.AnalysisDataPath.strip("/")
    art = share / row.ImagePath.strip("/")
    assert dat.exists() and art.exists()
    # main.py's commit-failure path: rollback, then discard.
    db.session.rollback()
    assert writer.discard_uncommitted_side_effects(db) == 2
    assert not dat.exists() and not art.exists()
    assert not dat.parent.parent.exists()  # the <uuid[:3]> dir we created


def test_discard_keeps_files_of_rows_that_persisted(db, wav: Path) -> None:  # noqa: ANN001
    # No outer transaction: pysqlite/sqlcipher3 auto-begin at the first
    # SAVEPOINT and its RELEASE commits — the row is durable even though the
    # session later "rolls back". Its files must survive the discard.
    share = Path(db.share_directory)
    [res] = writer.apply_batch(db, [_op(str(wav), source="500")])
    row = _reload(db, res["rb_content_id"])
    dat = share / row.AnalysisDataPath.strip("/")
    db.session.rollback()
    writer.discard_uncommitted_side_effects(db)
    assert db.session.query(T.DjmdContent).filter(T.DjmdContent.ID == res["rb_content_id"]).count() == 1
    assert dat.exists()


def test_commit_forgets_compensators(db, wav: Path) -> None:  # noqa: ANN001
    _open_outer_transaction(db)
    share = Path(db.share_directory)
    [res] = writer.apply_batch(db, [_op(str(wav), source="500")])
    row = _reload(db, res["rb_content_id"])
    dat = share / row.AnalysisDataPath.strip("/")
    db.session.commit()  # after_commit (outermost only) forgets them
    assert writer.discard_uncommitted_side_effects(db) == 0
    assert dat.exists()


def test_verify_content_create_catches_mismatches(db, wav: Path) -> None:  # noqa: ANN001
    [res] = writer.apply_batch(db, [_op(str(wav))])
    cid = res["rb_content_id"]
    assert verifier._verify_content_create(db, {"rb_content_id": cid, "path": _messy(wav), "anlz_copied": False}) is None
    err = verifier._verify_content_create(db, {"rb_content_id": cid, "path": "C:/elsewhere.wav", "anlz_copied": False})
    assert err and "FolderPath" in err
    err = verifier._verify_content_create(db, {"rb_content_id": cid, "path": str(wav), "anlz_copied": True})
    assert err and "AnalysisDataPath" in err
    assert "missing" in verifier._verify_content_create(db, {"rb_content_id": "nope", "path": str(wav)})


def test_playlist_create(db) -> None:  # noqa: ANN001
    [res] = writer.apply_batch(db, [{"kind": "playlist_create", "curator_playlist_id": "pl-1", "name": "Set [WAV]"}])
    assert res["created"] is True and res["curator_playlist_id"] == "pl-1"
    pid = res["rb_playlist_id"]
    pl = db.get_playlist(ID=pid)
    assert pl.Name == "Set [WAV]" and pl.ParentID == "root" and int(pl.Attribute) == 0
    assert db.playlist_xml.get(pid) is not None
    assert verifier._verify_playlist_create(db, {"rb_playlist_id": pid, "name": "Set [WAV]"}) is None
    assert "Name" in verifier._verify_playlist_create(db, {"rb_playlist_id": pid, "name": "Other"})


def test_failed_playlist_create_drops_xml_node(db, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
    created: list[str] = []
    real = writer._HANDLERS["playlist_create"]

    def failing_flush(*a, **k):  # noqa: ANN002, ANN003
        raise RuntimeError("flush failed")

    def handler_then_poison_flush(db_, op):  # noqa: ANN001
        res = real(db_, op)
        created.append(res["rb_playlist_id"])
        # Fail at the per-op flush — AFTER the handler returned, i.e. after
        # the XML node exists — which is where constraint/encoding errors
        # surface in production.
        monkeypatch.setattr(db_.session, "flush", failing_flush)
        return res

    monkeypatch.setitem(writer._HANDLERS, "playlist_create", handler_then_poison_flush)
    [res] = writer.apply_batch(db, [{"kind": "playlist_create", "curator_playlist_id": "pl-9", "name": "X"}])
    monkeypatch.undo()
    assert res["skipped"] is True and res["curator_playlist_id"] == "pl-9"
    [pid] = created
    assert db.playlist_xml.get(pid) is None
    assert db.get_playlist(ID=pid) is None


def test_playlist_xml_node_removed_on_commit_failure(db) -> None:  # noqa: ANN001
    _open_outer_transaction(db)
    [res] = writer.apply_batch(db, [{"kind": "playlist_create", "curator_playlist_id": "pl-2", "name": "Y"}])
    pid = res["rb_playlist_id"]
    assert db.playlist_xml.get(pid) is not None
    db.session.rollback()
    writer.discard_uncommitted_side_effects(db)
    assert db.get_playlist(ID=pid) is None
    assert db.playlist_xml.get(pid) is None


def test_playlist_xml_node_kept_when_row_persisted(db) -> None:  # noqa: ANN001
    [res] = writer.apply_batch(db, [{"kind": "playlist_create", "curator_playlist_id": "pl-3", "name": "Z"}])
    pid = res["rb_playlist_id"]
    db.session.rollback()  # no outer txn → the RELEASE already committed it
    writer.discard_uncommitted_side_effects(db)
    assert db.get_playlist(ID=pid) is not None
    assert db.playlist_xml.get(pid) is not None


def test_created_row_carries_rekordbox_defaults_not_null(db, wav: Path) -> None:  # noqa: ANN001
    # NULL ServiceID / LyricStatus showed a red badge in rekordbox's Title
    # column (2026-10-08); every native row holds 0 there.
    [res] = writer.apply_batch(db, [_op(str(wav))])
    row = _reload(db, res["rb_content_id"])
    assert (row.ServiceID, row.LyricStatus) == (0, 0)
    assert (row.SamplerTrackInfo, row.SamplerPlayOffset, row.SamplerGain) == (0, 0, 0.0)
    assert row.VideoAssociate == "0"
    assert (row.OrgFolderPath, row.FileNameS, row.Subtitle, row.ISRC) == ("", "", "", "")


def test_track_op_heals_null_never_null_columns(db, wav: Path) -> None:  # noqa: ANN001
    [res] = writer.apply_batch(db, [_op(str(wav))])
    cid = res["rb_content_id"]
    row = _reload(db, cid)
    row.ServiceID = None
    row.LyricStatus = None
    row.SamplerGain = None
    db.session.flush()
    fields = writer._meta_fields(META)
    op = {"kind": "track", "rb_content_id": cid, "fields": fields}
    [first] = writer.apply_batch(db, [op])
    assert first["changed"] is True
    row = _reload(db, cid)
    assert (row.ServiceID, row.LyricStatus, row.SamplerGain) == (0, 0, 0.0)
    # Healed once; the next identical push is a no-op again.
    [second] = writer.apply_batch(db, [op])
    assert second["changed"] is False


def test_cues_write_one_row_per_cue_in_rekordbox_shape(db, wav: Path) -> None:  # noqa: ANN001
    # Two rows per cue made deleted cues come back in rekordbox: it deletes
    # the row it tracks and the twin resurfaces on the next DB read
    # (2026-10-08). One row per cue, shaped like rekordbox's own.
    [res] = writer.apply_batch(db, [_op(str(wav))])
    cid = res["rb_content_id"]
    op = {"kind": "cues", "rb_content_id": cid, "cues": [
        {"slot": 0, "kind": "hot", "position_sec": 62.354, "length_sec": None, "color": "cti:36", "name": None},
        {"slot": 1, "kind": "hot", "position_sec": 10.0, "length_sec": 8.0, "color": None, "name": "Loop"},
        {"slot": 100, "kind": "memory", "position_sec": 0.646, "length_sec": None, "color": None, "name": None},
    ]}
    [out] = writer.apply_batch(db, [op])
    assert out["inserted"] == 3 and out["rows_written"] == 3
    db.session.expire_all()
    rows = db.session.query(T.DjmdCue).filter(T.DjmdCue.ContentID == cid).order_by(T.DjmdCue.InMsec).all()
    assert len(rows) == 3
    mem, loop, hot = rows
    assert (hot.InMsec, hot.InFrame, hot.OutMsec, hot.OutFrame, hot.Color, hot.ColorTableIndex, hot.ActiveLoop, hot.BeatLoopSize, hot.CueMicrosec) == (62354, 9353, -1, 0, 255, 36, 0, 0, 0)
    assert (hot.InMpegFrame, hot.InMpegAbs, hot.OutMpegFrame, hot.OutMpegAbs) == (0, 0, 0, 0)
    assert hot.UUID and hot.UUID != loop.UUID
    assert (loop.OutMsec, loop.OutFrame, loop.Comment, loop.ColorTableIndex) == (18000, 2700, "Loop", 0)
    assert (mem.Kind, mem.Color, mem.ColorTableIndex, mem.ActiveLoop, mem.InFrame) == (0, -1, None, None, 96)
    # rekordbox deleting a cue removes it for good — no twin row left behind.
    db.session.delete(hot)
    db.session.flush()
    left = db.session.query(T.DjmdCue).filter(T.DjmdCue.ContentID == cid, T.DjmdCue.InMsec == 62354).count()
    assert left == 0

def test_content_link_follows_rekordbox_not_the_menu_item(db, wav: Path) -> None:  # noqa: ANN001
    # pyrekordbox writes the TRACK menu item's usn (7 in this fixture);
    # rekordbox flags such rows (red badge, export refused). Use the source
    # row's value, or the one rekordbox gave its newest rows.
    [with_src] = writer.apply_batch(db, [_op(str(wav), source="500")])
    assert _reload(db, with_src["rb_content_id"]).ContentLink == 3999246
    other = wav.with_name("Other.wav")
    other.write_bytes(wav.read_bytes())
    [no_src] = writer.apply_batch(db, [_op(str(other))])
    assert _reload(db, no_src["rb_content_id"]).ContentLink == 3999246

