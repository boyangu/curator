"""Read-only dump of the fields Curator writes to rekordbox, for the e2e
comparison (e2e/src/compare-rb.ts). Opens a COPY of master.db with
pyrekordbox's built-in key, runs SELECTs only, never commits.

    python rb_dump.py <master.db> <content-ids.json> <out.json>

<content-ids.json>: the rekordbox content ids Curator links (a JSON list).
Every playlist is dumped (membership filtering happens in TypeScript); per
content: Title, the four relation names, Rating, Commnt, ColorID,
rb_local_deleted, the key (as the sidecar's reader parses it, so it compares
with the rb slot Curator keeps) and updated_at (the row's edit stamp, for
telling an edit Curator never pulled from a push it never made); live cues;
live MyTag membership by name.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

# The sidecar's own key parser (apps/rekordbox/src): the e2e runs this with
# apps/rekordbox as the working directory.
sys.path.insert(0, os.path.join(os.getcwd(), "src"))


def _ms(v: Any) -> int | None:
    """updated_at as epoch ms: a datetime from the ORM, or rekordbox's text
    form ("2026-10-21 13:09:21.446 +00:00") from a raw SELECT."""
    if v is None:
        return None
    if hasattr(v, "timestamp"):
        return int(v.timestamp() * 1000)
    import datetime
    try:
        return int(datetime.datetime.strptime(str(v), "%Y-%m-%d %H:%M:%S.%f %z").timestamp() * 1000)
    except ValueError:
        return None


def main() -> None:
    db_path, ids_path, out_path = sys.argv[1:4]
    with open(ids_path, encoding="utf-8") as f:
        ids: list[str] = [str(i) for i in json.load(f)]

    from pyrekordbox import Rekordbox6Database
    from sqlalchemy import text
    from curator_rekordbox.reader import _parse_rekordbox_key as parse_key

    db = Rekordbox6Database(db_path, db_dir=os.path.dirname(os.path.abspath(db_path)))
    s = db.session

    def rows(sql: str, params: dict[str, Any] | None = None) -> list[Any]:
        return list(s.execute(text(sql), params or {}))

    def chunked(sql: str) -> list[Any]:
        out: list[Any] = []
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            marks = ",".join(f":p{j}" for j in range(len(chunk)))
            out.extend(rows(sql.replace("(:ids)", f"({marks})"), {f"p{j}": v for j, v in enumerate(chunk)}))
        return out

    contents: dict[str, Any] = {}
    for r in chunked(
        """SELECT c.ID, c.Title, ar.Name, al.Name, lb.Name, g.Name, c.Rating, c.Commnt, c.ColorID, c.rb_local_deleted, c.FolderPath,
            k.ScaleName, c.updated_at
        FROM djmdContent c
        LEFT JOIN djmdKey k ON k.ID = c.KeyID
        LEFT JOIN djmdArtist ar ON ar.ID = c.ArtistID
        LEFT JOIN djmdAlbum al ON al.ID = c.AlbumID
        LEFT JOIN djmdLabel lb ON lb.ID = c.LabelID
        LEFT JOIN djmdGenre g ON g.ID = c.GenreID
        WHERE c.ID IN (:ids)"""
    ):
        contents[str(r[0])] = {
            "title": r[1], "artist": r[2], "album": r[3], "label": r[4], "genre": r[5],
            "rating": r[6], "comment": r[7], "colorId": None if r[8] is None else str(r[8]),
            "deleted": int(r[9] or 0), "path": r[10],
            "keyCamelot": parse_key(r[11])[0], "updatedAtMs": _ms(r[12]),
        }

    cues: dict[str, list[list[Any]]] = {}
    for r in chunked(
        """SELECT ContentID, Kind, InMsec, OutMsec, ColorTableIndex, Comment FROM djmdCue
        WHERE rb_local_deleted = 0 AND ContentID IN (:ids)"""
    ):
        cues.setdefault(str(r[0]), []).append([r[1], r[2], r[3], r[4], r[5] or ""])

    my_tags: dict[str, list[str]] = {}
    for r in chunked(
        """SELECT sm.ContentID, m.Name FROM djmdSongMyTag sm JOIN djmdMyTag m ON m.ID = sm.MyTagID
        WHERE sm.rb_local_deleted = 0 AND m.rb_local_deleted = 0 AND sm.ContentID IN (:ids)"""
    ):
        my_tags.setdefault(str(r[0]), []).append(r[1] or "")

    playlists: list[dict[str, Any]] = []
    members: dict[str, list[str]] = {}
    for r in rows("SELECT PlaylistID, ContentID FROM djmdSongPlaylist WHERE rb_local_deleted = 0 ORDER BY PlaylistID, TrackNo, ID"):
        members.setdefault(str(r[0]), []).append(str(r[1]))
    for r in rows("SELECT ID, Name, Attribute, ParentID, rb_local_deleted, SmartList FROM djmdPlaylist"):
        pid = str(r[0])
        playlists.append({
            "id": pid, "name": r[1], "attribute": r[2], "parentId": r[3], "deleted": int(r[4] or 0),
            "smart": bool(r[5]), "members": members.get(pid, []),
        })

    db.close()
    db.engine.dispose()
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"contents": contents, "cues": cues, "myTags": my_tags, "playlists": playlists}, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
