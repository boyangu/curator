"""Fixture rekordbox libraries for the e2e tests (never a real library).

    python rb_fixture.py create <spec.json>
    python rb_fixture.py edit <spec.json>

`create` builds a blank master.db from pyrekordbox's own table models, as
apps/rekordbox/tests/test_content_create.py does, but ENCRYPTED with
rekordbox's built-in key: the real sidecar and rb_dump.py then open it exactly
as they open the user's library, with no test-only switch in either. Spec:

    {"db": ".../rb/master.db",
     "contents": [{"id", "uuid", "path", "title", "artist", "album", "label",
                   "genre", "rating", "comment", "colorId",
                   "cues": [{"kind", "inMsec", "outMsec", "colorTableIndex", "comment"}],
                   "myTags": ["<tag id>", ...]}],
     "myTags": [{"id", "name"}],
     "playlists": [{"id", "name", "members": ["<content id>", ...]}]}

`edit` changes columns of one content row in place ({"db", "contentId",
"fields": {"Title": ...}}) — how a test makes the reference differ.

Both go through a plain SQLAlchemy engine, never Rekordbox6Database.commit,
so they run whether or not rekordbox is open; they write only the path named.
"""

from __future__ import annotations

import datetime
import json
import os
import sys
from typing import Any

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from sqlcipher3 import dbapi2 as sqlcipher

from pyrekordbox.db6 import tables as T
from pyrekordbox.db6.database import BLOB
from pyrekordbox.utils import deobfuscate

XML = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<MASTER_PLAYLIST Version="3.0.0" AutomaticSync="0">\n'
    '<PRODUCT Name="rekordbox" Version="7.2.19" Company="Pioneer DJ"/>\n'
    "<PLAYLISTS>\n</PLAYLISTS>\n</MASTER_PLAYLIST>\n"
)


def _engine(db_path: str):
    return create_engine(f"sqlite+pysqlcipher://:{deobfuscate(BLOB)}@/{db_path}?", module=sqlcipher)


def create(spec: dict[str, Any]) -> None:
    db_path = spec["db"]
    root = os.path.dirname(os.path.abspath(db_path))
    if os.path.exists(db_path):
        raise SystemExit(f"refusing to overwrite {db_path}")
    os.makedirs(os.path.join(root, "share"), exist_ok=True)
    with open(os.path.join(root, "masterPlaylists6.xml"), "w", encoding="utf-8") as f:
        f.write(XML)
    engine = _engine(db_path)
    # pyrekordbox's models declare NOT NULL on columns the real master.db
    # leaves NULL (see apps/rekordbox/tests/test_relation_lookup.py).
    for table in T.Base.metadata.tables.values():
        for col in table.columns:
            if not col.primary_key:
                col.nullable = True
    T.Base.metadata.create_all(engine)

    now = datetime.datetime.now()
    usn = 0

    def stamp() -> dict[str, Any]:
        nonlocal usn
        usn += 1
        return {"rb_local_usn": usn, "usn": usn, "rb_local_deleted": 0, "created_at": now, "updated_at": now}

    s = Session(bind=engine)
    s.add(T.DjmdProperty(DBID="999", DBVersion="6000", created_at=now, updated_at=now))
    s.add(T.DjmdMenuItems(ID="1", Class=1, Name="TRACK", UUID="menu", **stamp()))
    s.add(T.DjmdDevice(ID="dev-1", MasterDBID="999", Name="PC", UUID="dev", **stamp()))
    names: dict[str, dict[str, str]] = {"artist": {}, "album": {}, "label": {}, "genre": {}}
    model = {"artist": T.DjmdArtist, "album": T.DjmdAlbum, "label": T.DjmdLabel, "genre": T.DjmdGenre}

    def relation(kind: str, name: str | None) -> str | None:
        if not name:
            return None
        if name not in names[kind]:
            rid = f"{kind[:2]}-{len(names[kind]) + 1}"
            names[kind][name] = rid
            s.add(model[kind](ID=rid, Name=name, UUID=rid, **stamp()))
        return names[kind][name]

    # One MyTag category, the tags under it (rekordbox's own shape).
    s.add(T.DjmdMyTag(ID="mt-root", Seq=1, Name="Tags", Attribute=1, ParentID="root", UUID="mt-root", **stamp()))
    for i, t in enumerate(spec.get("myTags", [])):
        s.add(T.DjmdMyTag(ID=t["id"], Seq=i + 1, Name=t["name"], Attribute=0, ParentID="mt-root", UUID=t["id"], **stamp()))

    for c in spec.get("contents", []):
        s.add(T.DjmdContent(
            ID=c["id"], UUID=c["uuid"], Title=c.get("title"), FolderPath=c["path"],
            FileNameL=os.path.basename(c["path"]), FileType=5, Length=300, BPM=12000,
            ArtistID=relation("artist", c.get("artist")), AlbumID=relation("album", c.get("album")),
            LabelID=relation("label", c.get("label")), GenreID=relation("genre", c.get("genre")),
            Rating=c.get("rating", 0), Commnt=c.get("comment"), ColorID=c.get("colorId"),
            ContentLink=0, MasterDBID="999", **stamp(),
        ))
        for j, q in enumerate(c.get("cues", [])):
            cid = f"{c['id']}-cue-{j}"
            s.add(T.DjmdCue(
                ID=cid, UUID=cid, ContentID=c["id"], InMsec=q["inMsec"], InFrame=int(q["inMsec"] * 0.15),
                OutMsec=q.get("outMsec", -1), OutFrame=0, Kind=q["kind"], Color=255 if q.get("colorTableIndex") else -1,
                ColorTableIndex=q.get("colorTableIndex", 0), ActiveLoop=0, Comment=q.get("comment", ""),
                BeatLoopSize=0, CueMicrosec=0, ContentUUID=c["uuid"], **stamp(),
            ))
        for j, tag_id in enumerate(c.get("myTags", [])):
            sid = f"{c['id']}-mt-{j}"
            s.add(T.DjmdSongMyTag(ID=sid, MyTagID=tag_id, ContentID=c["id"], TrackNo=j + 1, UUID=sid, **stamp()))

    for i, p in enumerate(spec.get("playlists", [])):
        s.add(T.DjmdPlaylist(ID=p["id"], Seq=i + 1, Name=p["name"], Attribute=0, ParentID="root", UUID=p["id"], **stamp()))
        for j, cid in enumerate(p.get("members", [])):
            sid = f"{p['id']}-sp-{j}"
            s.add(T.DjmdSongPlaylist(ID=sid, PlaylistID=p["id"], ContentID=cid, TrackNo=j + 1, UUID=sid, **stamp()))

    s.add(T.AgentRegistry(registry_id="localUpdateCount", int_1=usn + 1000, date_1=now, date_2=now))
    s.commit()
    s.close()
    engine.dispose()


def edit(spec: dict[str, Any]) -> None:
    engine = _engine(spec["db"])
    with engine.begin() as conn:
        for col, value in spec["fields"].items():
            if not col.isidentifier():
                raise SystemExit(f"bad column {col!r}")
            conn.execute(text(f"UPDATE djmdContent SET {col} = :v WHERE ID = :id"), {"v": value, "id": spec["contentId"]})
    engine.dispose()


if __name__ == "__main__":
    cmd, spec_path = sys.argv[1:3]
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)
    {"create": create, "edit": edit}[cmd](spec)
