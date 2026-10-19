"""Wire-format dataclasses for the rekordbox sidecar's stdio JSON-RPC protocol.

Keep these in sync with apps/core/src/rekordbox/sidecar.ts. They're not used
for runtime validation (we trust the Node side); they exist so the shape of
each event is documented in one place.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


# ──────────────────────────────────────────────────────────────────────────────
# Requests (Node → sidecar)

@dataclass
class OpenParams:
    db_path: str               # absolute path to master.db
    key: Optional[str] = None  # SQLCipher key; None → pyrekordbox auto-resolves


@dataclass
class ScanParams:
    # Per-table watermarks. Keys: 'DjmdContent', 'DjmdCue', 'DjmdPlaylist',
    # 'DjmdSongPlaylist', 'DjmdMyTag', 'DjmdSongMyTag'. Values: highest USN
    # we've previously imported. Sidecar emits only rows with usn > watermark.
    watermarks: dict[str, int]
    # Which event families to emit. 'metadata' → tracks + playlists + mytags;
    # 'analysis' → cues + beatgrid + waveform. Lets the importer skip work
    # the user has disabled in settings.
    scopes: list[str] = field(default_factory=lambda: ["metadata", "analysis"])
    # Where to write converted .cpk peak files. Sidecar mkdirs the
    # lo/ and hi/ subdirs as needed (mirrors apps/analyzer behaviour).
    peaks_dir: Optional[str] = None


# ──────────────────────────────────────────────────────────────────────────────
# Per-row delta payloads (sidecar → Node, embedded in event frames)

@dataclass
class TrackDelta:
    """One DjmdContent row that crossed the watermark.

    All fields nullable so the importer's merge logic can decide per-field
    whether to overwrite or skip. `file_path` is normalized (forward slashes,
    lowercase drive letter on Windows) by the sidecar before emission so the
    Node side doesn't have to know about path conventions.

    `rb_updated_at_ms` is Rekordbox's own `djmdContent.updated_at` rendered as
    epoch milliseconds. It powers the Node importer's "last modified wins"
    merge: if Curator's track.updated_at is newer than the value rb seen at
    the previous import, Curator's row stays; if rb's is newer, rb wins. None
    indicates Rekordbox didn't populate the column (older schemas) — the
    importer treats this as "rb hasn't changed since the last seen value".
    """
    rb_content_id: str
    rb_local_usn: int
    rb_local_deleted: bool
    rb_updated_at_ms: Optional[int]
    # Rekordbox's "added to library" date — DjmdContent.StockDate (the column
    # the Rekordbox UI labels "Date Added"). Epoch ms; None if absent.
    # Importer writes this into track.added_at so the UI's "Added" column
    # reflects the user's Rekordbox truth, not the Curator scan timestamp.
    rb_added_at_ms: Optional[int]
    file_path: Optional[str]
    title: Optional[str]
    artist: Optional[str]
    album: Optional[str]
    genre: Optional[str]
    label: Optional[str]
    bpm: Optional[float]
    key_camelot: Optional[str]
    key_musical: Optional[str]
    color_label: Optional[str]
    rating: Optional[int]
    comment: Optional[str]
    play_count: Optional[int]
    last_played_at_ms: Optional[int]
    duration_sec: Optional[float]


@dataclass
class CueDelta:
    """One row from DjmdCue (hot or memory cue).

    Maps directly to Curator's cue table layout: slot is 0-7 for both hot
    and memory; kind discriminates. `length_sec` is None for point cues,
    >0 for loops.
    """
    rb_content_id: str          # → look up trackId via rekordbox_link
    rb_local_usn: int
    rb_local_deleted: bool
    slot: int                   # 0..7
    kind: str                   # 'hot' | 'memory'
    position_sec: float
    length_sec: Optional[float]
    color: Optional[str]
    name: Optional[str]


@dataclass
class PlaylistDelta:
    rb_playlist_id: str
    rb_local_usn: int
    rb_local_deleted: bool
    parent_folder_id: Optional[str]
    name: str
    is_folder: bool             # True → playlist_folder row, False → playlist row
    is_smart: bool
    # User's manual ordering within their parent folder (DjmdPlaylist.Seq in
    # rekordbox). Importer writes this into playlist.position /
    # playlist_folder.position so the sidebar matches the Rekordbox UI order.
    position: int = 0
    # Track membership snapshot. Position-keyed (rekordbox stores TrackNo on
    # DjmdSongPlaylist). Only present for non-folder playlists.
    tracks: list["PlaylistTrackRef"] = field(default_factory=list)


@dataclass
class PlaylistTrackRef:
    rb_content_id: str
    position: int


@dataclass
class PlaylistIndex:
    """Existence index for the playlists pass — emitted once, after a COMPLETE pass.

    rekordbox only tombstones a DjmdPlaylist row (rb_local_deleted=1 + USN
    bump) when a sync peer has already seen it (rb_local_synced=1). A row no
    peer has seen is hard-deleted, so its disappearance never rides the USN
    stream and no PlaylistDelta is ever emitted for it. The importer diffs
    Curator's rekordbox-sourced playlists/folders against this instead.
    Exactly one field is set: `live_ids` on a whole-library pass,
    `missing_ids` (requested ids with no live row) on a targeted pull. Never
    emitted when the fetch failed or the pass was cancelled — a partial index
    would read as mass deletion.
    """
    live_ids: Optional[list[str]] = None
    missing_ids: Optional[list[str]] = None


@dataclass
class MyTagDelta:
    rb_tag_id: str
    rb_local_usn: int
    rb_local_deleted: bool
    name: str
    color: Optional[str]
    # Track membership — DjmdSongMyTag rows. The importer translates to
    # Curator's track_tag table after resolving rb_content_id → trackId.
    tracks: list[str] = field(default_factory=list)  # rb_content_ids


@dataclass
class WaveformDelta:
    """Result of decoding a track's ANLZ waveforms into .cpk files."""
    rb_content_id: str
    peaks_lo_path: str
    peaks_hi_path: str
    beatgrid_sec: list[float]
    downbeats_sec: list[float]


@dataclass
class HistoryPlayRef:
    """One djmdSongHistory row — a single play inside a history session."""
    rb_song_history_id: str        # djmdSongHistory.ID (uuid)
    rb_content_id: str
    track_no: int
    # Row created_at as UTC epoch ms. For live rekordbox sessions this is the
    # actual play time; for histories imported from a USB device pane, every
    # row shares the import instant (the Node importer detects that bulk-
    # insert signature and drops per-play timestamps, keeping track_no order).
    created_at_ms: Optional[int]


@dataclass
class HistoryDelta:
    """One djmdHistory SESSION (Attribute=0) with its plays embedded.

    Session-per-event (mirroring PlaylistDelta.tracks) rather than
    row-per-event: the importer's set-vs-prep classifier needs the whole
    session's timestamp spread in one look. Attribute=1 rows are rekordbox's
    year/month folder nodes and are filtered sidecar-side.
    """
    rb_history_id: str
    name: str                      # "HISTORY yyyy-mm-dd (n)"
    # DjmdHistory.DateCreated converted from LOCAL wall-clock to epoch ms.
    # The Node side prefers the date parsed from `name`; this is the fallback.
    date_created_ms: Optional[int]
    plays: list[HistoryPlayRef] = field(default_factory=list)
