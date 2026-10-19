"""pyrekordbox queries with USN-watermark filtering and per-row event emission.

Centralizes all schema-knowledge about Rekordbox's master.db. The rest of
the sidecar stays a thin transport layer.

`scan()` is a generator that yields events; main.py forwards them to stdout.
This keeps memory flat — we never hold the whole library in RAM, just one
row at a time.
"""

from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
import time
from dataclasses import asdict
from typing import Any, Callable, Iterable, Optional

from . import REKORDBOX_ADAPTER_VERSION
from .proto import (
    CueDelta, HistoryDelta, HistoryPlayRef, MyTagDelta, PlaylistDelta, PlaylistIndex,
    PlaylistTrackRef, TrackDelta, WaveformDelta,
)
from .waveform import extract_bands_from_anlz, write_cpk_pair_from_rekordbox


# Musical key → Camelot Wheel. Lookup keyed on "<pitch> <scale>". Mirror of
# apps/analyzer/worker.py:_KEY_TO_CAMELOT — same wheel, kept in sync so both
# the analyzer and rekordbox importer agree on the canonical 12A/12B labels.
_KEY_TO_CAMELOT: dict[str, str] = {
    "B major":  "1B", "F# major": "2B", "Db major": "3B", "Ab major": "4B",
    "Eb major": "5B", "Bb major": "6B", "F major":  "7B", "C major":  "8B",
    "G major":  "9B", "D major":  "10B", "A major": "11B", "E major": "12B",
    "G# minor": "1A", "D# minor": "2A", "A# minor": "3A", "F minor":  "4A",
    "C minor":  "5A", "G minor":  "6A", "D minor":  "7A", "A minor":  "8A",
    "E minor":  "9A", "B minor":  "10A", "F# minor": "11A", "C# minor": "12A",
    # Enharmonic aliases — Rekordbox prefers flat spellings (Ab/Eb/Bb/Db minor),
    # Essentia prefers sharp spellings (G#/D#/A#/C# minor); both must resolve.
    "C# major": "3B", "D# major": "4B", "G# major": "9B", "Ab minor": "1A",
    "Eb minor": "2A", "Bb minor": "3A", "Db minor": "12A",
}

# Reverse map: Camelot → canonical musical spelling. Used when Rekordbox stored
# the key directly as Camelot (e.g. user set "8A" in the rekordbox tag) and we
# need to populate keyMusical. Spellings match what Rekordbox itself displays
# — flats for naturally-flat keys, F# for the sharp tritone — so a round-trip
# from a Rekordbox tag back to a Rekordbox-style musical name is stable.
_CAMELOT_TO_MUSICAL: dict[str, str] = {
    "1A": "Ab minor",  "1B":  "B major",
    "2A": "Eb minor",  "2B":  "F# major",
    "3A": "Bb minor",  "3B":  "Db major",
    "4A": "F minor",   "4B":  "Ab major",
    "5A": "C minor",   "5B":  "Eb major",
    "6A": "G minor",   "6B":  "Bb major",
    "7A": "D minor",   "7B":  "F major",
    "8A": "A minor",   "8B":  "C major",
    "9A": "E minor",   "9B":  "G major",
    "10A": "B minor",  "10B": "D major",
    "11A": "F# minor", "11B": "A major",
    "12A": "Db minor", "12B": "E major",
}

# Rekordbox compact-musical: "<note><accidental?><minor?>", e.g.
#   "C", "Cm", "F#", "F#m", "Bb", "Bbm", "Db", "Dbm".
_RB_COMPACT_KEY_RE = re.compile(r"^([A-G])([#b]?)(m?)$")
# Camelot: "1A".."12A" / "1B".."12B".
_CAMELOT_RE = re.compile(r"^(?:[1-9]|1[0-2])[AB]$")

# Rekordbox colour-id (DjmdContent.ColorID, DjmdMyTag.Color) → palette name.
# Matches the in-app colour picker for TRACK and TAG colours, which still use
# the legacy 8-entry palette. Cue colours do NOT come through here anymore —
# rb 6 stores cue colours in the extended 64-entry palette via DjmdCue.Color
# (255) + DjmdCue.ColorTableIndex; see `_resolve_cue_color` below.
_COLOR_ID_TO_NAME = {
    0: None,
    1: "pink",
    2: "red",
    3: "orange",
    4: "yellow",
    5: "green",
    6: "aqua",
    7: "blue",
    8: "purple",
}

# DjmdCue.Kind → 0-indexed hot cue slot (A=0, B=1, ..., P=15).
#
# Page 1 (A-H, slots 0-7): Pioneer/rekordbox 6 stores these with a gap at
# Kind=4 — pyrekordbox's docstring on `DjmdCue.Kind` flags 4 as the "Loop"
# cue type sentinel. So page-1 mapping is:
#   A=1, B=2, C=3, D=5, E=6, F=7, G=8, H=9.
#
# Page 2 (I-P, slots 8-15): CDJ-3000 + rb 6.x "Hot Cue Bank" feature adds
# a second 8-slot bank. Verified empirically by setting cues with rb's UI
# and reading back the Kind values: I=10, J=11, K=12, L=13, M=14, N=15,
# O=16, P=17. NO gap in page 2 (no "loop sentinel" analogue).
_HOT_KIND_TO_SLOT = {
    # Page 1 — A..H
    1: 0, 2: 1, 3: 2, 5: 3, 6: 4, 7: 5, 8: 6, 9: 7,
    # Page 2 — I..P
    10: 8, 11: 9, 12: 10, 13: 11, 14: 12, 15: 13, 16: 14, 17: 15,
}

# ──────────────────────────────────────────────────────────────────────────────
# PSSI (Song Structure Information) phrase decoding.
#
# Rekordbox ANLZ EXT files carry a PSSI tag with a `mood` (1=High, 2=Mid, 3=Low)
# and a list of phrase entries, each with a 1-indexed `beat`, a `kind` code
# (mood-dependent meaning), three sub-flags `k1/k2/k3`, and an optional
# `fill_beat` marker. The canonical decoding tables are from the Deep-Symmetry
# Crate Digger spec (https://github.com/Deep-Symmetry/crate-digger).
#
# For mood=1 ("High" — dance/electronic), several `kind` values have sub-
# variants resolved via the k-flags (Intro 1/2, Up 1/2/3, Chorus 1/2,
# Outro 1/2). For mood=2/3 the kinds are direct phrase labels with no
# variants. mood=3 ("Low") collapses kinds 2/3/4 to "Verse 1" and 5/6/7 to
# "Verse 2" — rekordbox's UI doesn't distinguish them but the underlying
# `kind` code is preserved in `rb_kind` on the emitted segment so callers
# can round-trip if needed.
_PSSI_LABEL_BY_MOOD_KIND: dict[tuple[int, int], Optional[str]] = {
    # mood=1 (High) — None entries get resolved via _HIGH_*_VARIANT below.
    (1, 1): None,   (1, 2): None,   (1, 3): "Down", (1, 5): None,   (1, 6): None,
    # mood=2 (Mid)
    (2, 1): "Intro", (2, 2): "Verse 1", (2, 3): "Verse 2", (2, 4): "Verse 3",
    (2, 5): "Verse 4", (2, 6): "Verse 5", (2, 7): "Verse 6",
    (2, 8): "Bridge", (2, 9): "Chorus", (2, 10): "Outro",
    # mood=3 (Low) — verses collapse per rb's UI behavior.
    (3, 1): "Intro", (3, 2): "Verse 1", (3, 3): "Verse 1", (3, 4): "Verse 1",
    (3, 5): "Verse 2", (3, 6): "Verse 2", (3, 7): "Verse 2",
    (3, 8): "Bridge", (3, 9): "Chorus", (3, 10): "Outro",
}
_HIGH_INTRO_VARIANT  = {1: "Intro 1",  0: "Intro 2"}    # keyed by k1
_HIGH_CHORUS_VARIANT = {1: "Chorus 1", 0: "Chorus 2"}   # keyed by k1
_HIGH_OUTRO_VARIANT  = {1: "Outro 1",  0: "Outro 2"}    # keyed by k1
_HIGH_UP_VARIANT     = {(0, 0): "Up 1", (0, 1): "Up 2", (1, 0): "Up 3"}  # keyed by (k2, k3)


_logged_legacy_cue_color = False


def _resolve_cue_color(color_raw, color_table_index) -> Optional[str]:
    """Map a DjmdCue (Color, ColorTableIndex) pair to a renderable colour id.

    rb 6 uses the extended 64-entry palette exclusively for cues:
      Color == -1 (legacy null) or Color == 255 (extended marker) +
      ColorTableIndex > 0 → `"cti:{idx}"`. The token is opaque to
      Curator's high-level layers; resolution to a hex hue lives in
      apps/desktop/src/renderer/cuePalette.ts via the rb sidecar's static
      palette (apps/rekordbox/src/curator_rekordbox/palette.py).

    Legacy Color in 1..8 (the named pink/red/etc palette) is no longer
    recognised here. Empirically rb 6 effectively never writes those for
    cues (the user's library had 0 native rows in 1..8); preserving the
    branch would split the storage format into two parallel codepaths for
    no real-world benefit.

    Returns None when no usable color is present — renderer falls back to
    its default hex.
    """
    try:
        c = int(color_raw) if color_raw is not None else None
    except (TypeError, ValueError):
        c = None
    try:
        cti = int(color_table_index) if color_table_index is not None else 0
    except (TypeError, ValueError):
        cti = 0
    if c is not None and 1 <= c <= 8:
        # Legacy palette row — surface as "no color" but log once so we
        # notice if a future library actually has lots of them.
        global _logged_legacy_cue_color
        if not _logged_legacy_cue_color:
            sys.stderr.write(
                f"cue read: encountered legacy Color={c} (rb-6 cues use extended palette); "
                "treating as 'no color'. Further occurrences silenced.\n"
            )
            _logged_legacy_cue_color = True
        return None
    if cti > 0:
        return f"cti:{cti}"
    return None


def _normalize_path(p: Optional[str]) -> Optional[str]:
    """Mirror apps/core/src/local/scanner.ts:normalizePath() — forward slashes,
    lowercase drive letter on Windows. Importer matches by this exact string."""
    if not p:
        return None
    n = p.replace("\\", "/")
    if len(n) >= 2 and n[1] == ":" and n[0].isalpha():
        n = n[0].lower() + n[1:]
    return n


def _parse_rekordbox_key(scale_name: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Normalize whatever Rekordbox stored in DjmdKey.ScaleName into a
    (key_camelot, key_musical) pair.

    Rekordbox lets the user tag a track's key in three different shapes
    (per-user preference in app settings):
      - Compact musical:    "Cm", "F#", "Bb", "Dbm"
      - Expanded musical:   "C minor", "F# major"   (rare, but accepted)
      - Camelot:            "8A", "12B"
    We always populate both columns when possible so the UI can switch
    notation without re-reading the source DB.
    """
    if not scale_name:
        return (None, None)
    s = scale_name.strip()
    if not s:
        return (None, None)

    # Already-Camelot tags pass through to keyCamelot and reverse-map for
    # keyMusical so the column renders consistently.
    if _CAMELOT_RE.match(s):
        return (s, _CAMELOT_TO_MUSICAL.get(s))

    # Direct hit on the expanded form ("C minor"). Cheap to check first.
    cam = _KEY_TO_CAMELOT.get(s)
    if cam:
        return (cam, s)

    # Compact form ("Cm", "F#", "Bbm"): expand to "<pitch> <scale>", look up.
    m = _RB_COMPACT_KEY_RE.match(s)
    if m:
        pitch, accidental, minor_flag = m.group(1), m.group(2), m.group(3)
        musical = f"{pitch}{accidental} {'minor' if minor_flag else 'major'}"
        cam = _KEY_TO_CAMELOT.get(musical)
        if cam:
            return (cam, musical)

    # Unknown shape — leave both null rather than guess. The analyzer can
    # still populate the columns later from audio if it runs on the track.
    return (None, None)


def snapshot_db_to_temp(db_path: str) -> tuple[str, str, str]:
    """Copy master.db (and its WAL/SHM sidecars if present) into a fresh
    temp directory so reads don't contend with a running Rekordbox.

    Returns (temp_db_path, temp_dir, original_db_dir). The caller is
    responsible for `shutil.rmtree(temp_dir, ignore_errors=True)` once the
    pyrekordbox handle backed by the snapshot has been closed.

    The temp file is always named `master.db` so any pyrekordbox internals
    that derive paths from the filename keep working. The companion
    files (`master.db-wal`, `master.db-shm`, `master.db-journal`) are
    copied alongside if they exist — a WAL-mode snapshot is only
    consistent when all three travel together. Missing sidecars are
    normal (no in-flight transaction, or rollback-journal mode).

    Note: we don't snapshot `share/` or `masterPlaylists6.xml`. Those
    live in the *original* directory; `open_db` points pyrekordbox's
    `db_dir` back at that directory so ANLZ + playlist XML still resolve
    while only the master.db file itself is decoupled from rekordbox's
    writer.
    """
    original_dir = os.path.dirname(os.path.abspath(db_path))
    temp_dir = tempfile.mkdtemp(prefix="curator-rb-snap-")
    try:
        dst = os.path.join(temp_dir, "master.db")
        shutil.copy2(db_path, dst)
        for suffix in ("-wal", "-shm", "-journal"):
            sidecar = db_path + suffix
            if os.path.exists(sidecar):
                shutil.copy2(sidecar, dst + suffix)
    except Exception:
        # Partial copy on failure — nuke the dir before re-raising so we
        # don't leak the half-written file.
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    return dst, temp_dir, original_dir


def open_db(db_path: str, key: Optional[str], db_dir: Optional[str] = None):
    """Open master.db via pyrekordbox. Returns a Rekordbox6Database handle.

    Imports pyrekordbox lazily so the sidecar boots fast and import errors
    surface as a proper protocol error (not a startup crash).

    Constructor signature in pyrekordbox >=0.4 is
        Rekordbox6Database(path, db_dir='', key='', unlock=True)
    The earlier `db_path=` keyword was renamed to `path=`. We pass the master.db
    file path positionally so both keyword names work in the future.

    When `db_dir` is provided it overrides the default (which is
    `Path(db_path).parent`). The caller passes the *original* rekordbox
    directory here when `db_path` points at a temp snapshot, so
    pyrekordbox still finds `share/` (ANLZ files) and
    `masterPlaylists6.xml` at their real locations.
    """
    from pyrekordbox import Rekordbox6Database
    kwargs: dict[str, Any] = {}
    if key:
        kwargs["key"] = key
    if db_dir:
        kwargs["db_dir"] = db_dir
    return Rekordbox6Database(db_path, **kwargs)


# Live DjmdContent rows whose Artist/Album/Label/Genre FK points at a relation
# row rekordbox has tombstoned (rb_local_deleted=1), and live DjmdSongMyTag
# memberships at a tombstoned MyTag. rekordbox renders those as blank /
# invisible; Curator's writer used to create them (see writer.py's
# lookup-or-create header). One row per (content, stale relation) so the
# exporter can tell WHICH relation is dead: the push only heals a field it
# actually sends, and it never sends an empty one (omit-if-empty), so a track
# whose only dead relation is a field Curator has no value for must not be
# swept in — it would be re-pushed on every "Sync updates" without ever
# converging (the 2026-10 "Remembering" album rows).
_STALE_RELATIONS_SQL = """
SELECT c.ID, 'artist', NULL FROM djmdContent c JOIN djmdArtist r ON r.ID = c.ArtistID
WHERE c.rb_local_deleted = 0 AND r.rb_local_deleted = 1
UNION ALL
SELECT c.ID, 'album', NULL FROM djmdContent c JOIN djmdAlbum r ON r.ID = c.AlbumID
WHERE c.rb_local_deleted = 0 AND r.rb_local_deleted = 1
UNION ALL
SELECT c.ID, 'label', NULL FROM djmdContent c JOIN djmdLabel r ON r.ID = c.LabelID
WHERE c.rb_local_deleted = 0 AND r.rb_local_deleted = 1
UNION ALL
SELECT c.ID, 'genre', NULL FROM djmdContent c JOIN djmdGenre r ON r.ID = c.GenreID
WHERE c.rb_local_deleted = 0 AND r.rb_local_deleted = 1
UNION ALL
SELECT c.ID, 'mytag', m.Name FROM djmdSongMyTag sm
JOIN djmdMyTag m ON m.ID = sm.MyTagID
JOIN djmdContent c ON c.ID = sm.ContentID
WHERE sm.rb_local_deleted = 0 AND m.rb_local_deleted = 1 AND c.rb_local_deleted = 0
"""

# Wire order of `fields` — stable so the payload diffs cleanly in logs.
_STALE_FIELD_ORDER = ("artist", "album", "label", "genre")


def shape_stale_relations(rows: Any) -> list[dict[str, Any]]:
    """Group `(content_id, kind, mytag_name)` rows into one entry per content:
    `{"rbContentId", "fields": [artist|album|label|genre...], "myTags": [name...]}`.
    A dead MyTag with no name still yields an entry (it IS stale), just one
    the exporter can't match against a Curator tag."""
    by_id: dict[str, tuple[set[str], set[str]]] = {}
    for cid, kind, name in rows:
        fields, tags = by_id.setdefault(str(cid), (set(), set()))
        if kind == "mytag":
            if name:
                tags.add(str(name))
        elif kind in _STALE_FIELD_ORDER:
            fields.add(kind)
    return [
        {
            "rbContentId": cid,
            "fields": [f for f in _STALE_FIELD_ORDER if f in fields],
            "myTags": sorted(tags),
        }
        for cid, (fields, tags) in sorted(by_id.items())
    ]


def query_stale_relations(session: Any) -> list[dict[str, Any]]:
    from sqlalchemy import text  # type: ignore
    return shape_stale_relations(session.execute(text(_STALE_RELATIONS_SQL)).fetchall())


def list_stale_relations(db_path: str, key: Optional[str]) -> list[dict[str, Any]]:
    """Per-content stale relations (see shape_stale_relations). Read-only:
    opens master.db directly (no snapshot — one indexed-join SELECT)."""
    db = open_db(db_path, key)
    try:
        return query_stale_relations(db.session)
    finally:
        try:
            db.close()
        except Exception:
            pass


def detect_default_db_path() -> Optional[str]:
    """OS-specific default master.db location. Returns None if missing."""
    if sys.platform == "darwin":
        candidate = os.path.expanduser("~/Library/Pioneer/rekordbox/master.db")
    elif sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if not appdata:
            return None
        candidate = os.path.join(appdata, "Pioneer", "rekordbox", "master.db")
    else:
        candidate = os.path.expanduser("~/.config/Pioneer/rekordbox/master.db")
    return candidate if os.path.exists(candidate) else None


def is_rekordbox_running() -> bool:
    """Best-effort check: is Pioneer's Rekordbox process running locally?
    Used by the settings UI to warn before writes (and to flag read-time
    SQLite-lock risk). We probe via psutil when available; fall back to a
    no-op `False` if it's not installed (psutil isn't a hard dep).

    Our own sidecar is named `curator-rekordbox(.exe)`, so a plain
    `"rekordbox" in name` substring match flags *us* and wrongly disables
    sync whenever Curator is open. Exclude anything carrying the `curator`
    marker — that's only ever our bundle, never the Pioneer app."""
    try:
        import psutil  # type: ignore
    except Exception:
        return False
    for proc in psutil.process_iter(["name"]):
        name = (proc.info.get("name") or "").lower()
        if "rekordbox" in name and "curator" not in name:
            return True
    return False


# ──────────────────────────────────────────────────────────────────────────────
# Scan — generator that yields tagged events for main.py to forward as JSON.

EventEmitter = Callable[[str, dict[str, Any]], None]


def _dt_to_epoch_ms(value: Any, *, assume_utc: bool) -> Optional[int]:
    """Datetime/date/ISO-string → epoch ms, defensively.

    pyrekordbox surfaces `created_at`/`updated_at` as tz-aware UTC datetimes
    but `DateCreated` as a naive LOCAL wall-clock value (sometimes a plain
    string in older schema dumps). A naive datetime's .timestamp() assumes
    local time — correct for DateCreated, wrong for a naive UTC row — so the
    caller states which convention applies via `assume_utc`.
    """
    if value is None:
        return None
    try:
        from datetime import datetime, timezone

        if isinstance(value, str):
            s = value.strip()
            if len(s) < 10:
                return None
            try:
                value = datetime.fromisoformat(s)
            except ValueError:
                # e.g. "2026-08-15 11:22:25.898 +00:00" — the space before
                # the offset defeats fromisoformat; the seconds-precision
                # prefix always parses.
                value = datetime.fromisoformat(s[:19])
        if not hasattr(value, "timestamp"):
            return None
        if getattr(value, "tzinfo", None) is None and assume_utc:
            value = value.replace(tzinfo=timezone.utc)
        return int(value.timestamp() * 1000)
    except Exception:
        return None


def _fetch_rows(db: Any, *method_names: str) -> tuple[list[Any], Optional[str]]:
    """Try each method name in order; return (rows, errors_summary).

    pyrekordbox renamed several `get_*` methods between minor releases
    (`get_mytag` → `get_my_tag`, etc.) and the user's installed version
    isn't pinned. Falling through known aliases keeps the importer working
    across versions; if every alias fails we log a single line per attempt
    so the user can see what's missing.
    """
    errors: list[str] = []
    for name in method_names:
        fn = getattr(db, name, None)
        if fn is None:
            errors.append(f"{name}=missing")
            continue
        try:
            return list(fn()), None
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}={type(exc).__name__}: {exc}")
    return [], "; ".join(errors) if errors else None


def _fetch_content_since(db, wm: int):
    """DjmdContent fetch with the USN watermark pushed into SQL.

    The track pass used to load the ENTIRE content table and discard
    `usn <= wm` rows one by one in Python — fine at 10k tracks, a real tax
    on incremental imports of 100k+ libraries where typically <1% changed.
    Same direct-SQLAlchemy pattern as the DjmdSongPlaylist USN query below;
    `rb_local_usn > wm` matches the per-row gate exactly (NULL/0 USNs were
    already skipped by `usn <= wm` since wm >= 0, and SQL NULL-comparison
    excludes them too). Soft-deleted rows are intentionally INCLUDED — the
    importer's rb_local_deleted branch drops the provenance link.

    Falls back to the full get_content() fetch when the table import or
    query fails (pyrekordbox version drift); the caller's per-row gate
    stays in place either way, so the fallback path filters correctly.
    """
    try:
        from pyrekordbox.db6.tables import DjmdContent  # type: ignore
        if hasattr(db, "session"):
            rows = (
                db.session.query(DjmdContent)
                .filter(DjmdContent.rb_local_usn > wm)
                .all()
            )
            return rows, None
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(
            f"tracks: USN-filtered fetch failed ({type(exc).__name__}: {exc}) — falling back to full scan\n"
        )
    return _fetch_rows(db, "get_content")


def scan(
    db,
    watermarks: dict[str, int],
    scopes: Iterable[str],
    peaks_dir: Optional[str],
    emit: EventEmitter,
    is_cancelled: Callable[[], bool],
    force_refresh_grids: bool = False,
    target_content_ids: Optional[Iterable[str]] = None,
    target_playlist_ids: Optional[Iterable[str]] = None,
) -> dict[str, int]:
    """Iterate everything past the watermarks. Emits per-row events; returns
    the new watermarks for the caller to persist after the pass completes.

    Each pass (tracks, cues, playlists, mytags, waveforms) is wrapped in its
    own try/except: a failure in one pass logs to stderr but does NOT
    short-circuit the others. Critical because pyrekordbox method names
    drifted between minor versions, and a `db.get_cue` AttributeError
    would otherwise leave the entire library uninstalled.

    Scopes are independent per-data-class flags chosen by the user in
    Settings → Rekordbox:
        'tracks'              → DjmdContent pass (track metadata)
        'playlists'           → DjmdPlaylist + DjmdSongPlaylist + folders
        'mytags'              → DjmdMyTag + DjmdSongMyTag
        'cues'                → DjmdCue only (no ANLZ work) — the sync
                                pipeline's pull phase, which needs cue
                                deltas for the three-way merge but must
                                not pay the beatgrid/waveform decode
        'cues_grids_phrases'  → DjmdCue + ANLZ beatgrid + PSSI phrases
        'waveform_peaks'      → ANLZ band extract + .cpk writes
        'history'             → DjmdHistory + DjmdSongHistory (play history;
                                read-only, skipped on targeted pulls)

    The waveform pass loads each ANLZ file once and decodes multiple tags
    out of it, so 'cues_grids_phrases' and 'waveform_peaks' share the
    pass when both are on; either alone runs only its half of the work.
    """
    scopes_set = set(scopes)
    new_marks = dict(watermarks)

    # ── Scoped ("Sync from Rekordbox") targeting ────────────────────────────
    # When target_content_ids / target_playlist_ids are supplied, the scan is
    # restricted to just those rows regardless of the USN watermark — the
    # caller (a per-track / per-playlist / per-folder pull) passes empty
    # watermarks so every targeted row is re-read at its CURRENT rb state and
    # the LMW merge decides per row. `targeted` gates the per-pass filters
    # below; a None target keeps the whole-library incremental behaviour.
    #
    # target_playlist_ids expand to their member ContentIDs so the targeted
    # playlists' member tracks (including ones newly added on the rb side)
    # get their metadata/cues/waveforms pulled too — not just the playlist
    # row + membership. The playlists pass itself filters on the raw
    # target_playlist_ids.
    tcids: Optional[set] = None if target_content_ids is None else {str(c) for c in target_content_ids}
    tpids: Optional[set] = None if target_playlist_ids is None else {str(p) for p in target_playlist_ids}
    targeted = tcids is not None or tpids is not None
    if targeted and tcids is None:
        tcids = set()
    if tpids:
        try:
            from pyrekordbox.db6.tables import DjmdSongPlaylist  # type: ignore
            if hasattr(db, "session"):
                member_rows = (
                    db.session.query(DjmdSongPlaylist.ContentID)
                    .filter(DjmdSongPlaylist.PlaylistID.in_([str(p) for p in tpids]))
                    .filter(DjmdSongPlaylist.rb_local_deleted == 0)
                    .all()
                )
                for r in member_rows:
                    c = getattr(r, "ContentID", None)
                    if c:
                        tcids.add(str(c))
                sys.stderr.write(
                    f"scoped: {len(tpids)} playlist(s) expanded to {len(tcids)} content id(s)\n"
                )
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"scoped: playlist member expansion failed: {type(exc).__name__}: {exc}\n")

    # ── Tracks (DjmdContent) ────────────────────────────────────────────────
    # Skipped when 'tracks' is off. Downstream passes (cues, playlists,
    # mytags) resolve their members via the importer's rekordbox_link DB
    # fallback for previously-imported tracks. New rb tracks won't appear
    # in Curator until the user re-runs with 'tracks' on, and their
    # cues/playlists/etc. are silently skipped in the meantime (nothing
    # to attach them to). That matches the user's mental model.
    if "tracks" in scopes_set:
        try:
            wm = watermarks.get("DjmdContent", 0)
            max_seen = wm
            rows, err = _fetch_content_since(db, wm)
            if err: sys.stderr.write(f"tracks fetch warnings: {err}\n")
            sys.stderr.write(f"tracks: fetched {len(rows)} rows past watermark={wm}\n")
            emit("progress", {"phase": "tracks", "done": 0, "total": len(rows)})
            emitted = 0
            for i, row in enumerate(rows):
                if is_cancelled():
                    break
                usn = int(getattr(row, "rb_local_usn", 0) or 0)
                if targeted:
                    # Scoped pull: emit iff this row is in the target set,
                    # regardless of USN (the caller wants the current state).
                    if str(getattr(row, "ID", "") or "") not in tcids:
                        continue
                elif usn <= wm:
                    continue
                if usn > max_seen:
                    max_seen = usn
                delta = _row_to_track_delta(row)
                if delta is not None:
                    emit("track", asdict(delta))
                    emitted += 1
                if (i + 1) % 50 == 0:
                    emit("progress", {"phase": "tracks", "done": i + 1, "total": len(rows)})
            emit("progress", {"phase": "tracks", "done": len(rows), "total": len(rows)})
            sys.stderr.write(f"tracks: emitted {emitted} deltas\n")
            new_marks["DjmdContent"] = max_seen
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"tracks pass failed: {type(exc).__name__}: {exc}\n")

    # ── Cues (DjmdCue + ANLZ-derived hot/memory cues) ──────────────────────
    if "cues_grids_phrases" in scopes_set or "cues" in scopes_set:
        try:
            # Unlike DjmdContent / DjmdPlaylist, DjmdCue rows carry NO usable
            # rb_local_usn — pyrekordbox returns None for the column. Gating
            # on it would skip every row forever (usn=0 <= wm=0). Cues are
            # cheap (~1 per hot/memory slot per track, ~5k total for a 10k
            # library) so we scan the whole set on every sync.
            #
            # Rekordbox writes EVERY cue twice (one with ColorTableIndex,
            # one without — confirmed empirically), so we group per content
            # and dedupe by (InMsec, Kind) before emitting. Within each
            # group, slot is assigned as a stable ordinal so the
            # importer's (trackId, slot, kind) UNIQUE constraint doesn't
            # collapse multiple cues into one row. Without this dedupe+enum,
            # a track with 9 hot cues lands as 1-2 rows in Curator (one
            # per distinct Kind value, last-write-wins on the rest).
            cue_rows, err = _fetch_rows(db, "get_cue", "get_djmd_cue", "get_hot_cue_banklist_cue")
            if err: sys.stderr.write(f"cues fetch warnings: {err}\n")
            sys.stderr.write(f"cues: fetched {len(cue_rows)} rows (no USN gate — full scan)\n")
            # Group by ContentID, dedupe by (InMsec, Kind, is_hot_cue).
            per_track: dict[str, dict] = {}
            for r in cue_rows:
                cid = getattr(r, "ContentID", None)
                if not cid:
                    continue
                key = (getattr(r, "InMsec", 0), getattr(r, "Kind", 0), bool(getattr(r, "is_hot_cue", False)))
                bucket = per_track.setdefault(str(cid), {})
                existing = bucket.get(key)
                # Prefer the row carrying a non-None ColorTableIndex — that's
                # the "active" duplicate that holds the user-set colour.
                if existing is None or (
                    getattr(existing, "ColorTableIndex", None) is None
                    and getattr(r, "ColorTableIndex", None) is not None
                ):
                    bucket[key] = r

            emit("progress", {"phase": "cues", "done": 0, "total": len(per_track)})
            emitted = 0
            dropped_unknown_kind = 0
            for i, (cid, bucket) in enumerate(per_track.items()):
                if is_cancelled():
                    break
                if targeted and str(cid) not in tcids:
                    continue
                # Slot assignment:
                #   Hot cues: decode DjmdCue.Kind through _HOT_KIND_TO_SLOT
                #     (handles the Kind=4 gap so slots A-H land at 0-7
                #     regardless of which actual letters the user filled).
                #     This is what makes a user's "A,B,C,H" round-trip:
                #     Kind 1,2,3,9 → slots 0,1,2,7 → letters A,B,C,H in
                #     the renderer.
                #   Memory cues: ordinal-by-time, starting at slot 100.
                # Both spaces are wide enough to avoid collision; the
                # importer's slot cap is loosened to match.
                hot_rows = [r for r in bucket.values() if getattr(r, "is_hot_cue", False)]
                mem = sorted(
                    [r for r in bucket.values() if not getattr(r, "is_hot_cue", False)],
                    key=lambda r: int(getattr(r, "InMsec", 0) or 0),
                )
                for r in hot_rows:
                    kind_val = int(getattr(r, "Kind", 0) or 0)
                    slot = _HOT_KIND_TO_SLOT.get(kind_val)
                    if slot is None:
                        dropped_unknown_kind += 1
                        continue
                    delta = _row_to_cue_delta(r, slot=slot, kind="hot")
                    if delta is not None:
                        emit("cues", asdict(delta))
                        emitted += 1
                for idx, r in enumerate(mem):
                    delta = _row_to_cue_delta(r, slot=100 + idx, kind="memory")
                    if delta is not None:
                        emit("cues", asdict(delta))
                        emitted += 1
                if (i + 1) % 200 == 0:
                    emit("progress", {"phase": "cues", "done": i + 1, "total": len(per_track)})
            emit("progress", {"phase": "cues", "done": len(per_track), "total": len(per_track)})
            sys.stderr.write(
                f"cues: emitted {emitted} deltas across {len(per_track)} tracks"
                f" (dropped {dropped_unknown_kind} with unknown Kind)\n"
            )
            # Bump the watermark to a stable sentinel so consumers see the
            # pass completed. The value itself is unused for cue gating.
            new_marks["DjmdCue"] = len(cue_rows)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"cues pass failed: {type(exc).__name__}: {exc}\n")

    # ── Waveform pass (ANLZ → beatgrid + phrases + .cpk bands) ─────────────
    # Loads each ANLZ file once and decodes multiple tags. Runs when EITHER
    # 'cues_grids_phrases' or 'waveform_peaks' is selected; the two booleans
    # below control which halves of the work actually happen:
    #   emit_grids  → beatgrid + downbeats + PSSI segments get emitted
    #   write_peaks → .cpk band files get decoded + written
    # Both halves share the same ANLZ load, so running them together is
    # cheap; running either alone skips its sibling's work entirely.
    emit_grids = "cues_grids_phrases" in scopes_set
    write_peaks = "waveform_peaks" in scopes_set
    if (emit_grids or write_peaks) and peaks_dir:
        try:
            _scan_waveforms(
                db, peaks_dir, emit, is_cancelled,
                force_refresh_grids=force_refresh_grids,
                emit_grids=emit_grids,
                write_peaks=write_peaks,
                only_content_ids=tcids if targeted else None,
            )
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"waveform pass failed: {type(exc).__name__}: {exc}\n")

    # ── Playlists + memberships ────────────────────────────────────────────
    # Two watermarks here: DjmdPlaylist USN bumps when the playlist row itself
    # changes (rename, reparent, reorder among siblings); DjmdSongPlaylist USN
    # bumps when a song is added to or removed from a playlist. The parent
    # playlist row does NOT get its USN bumped on membership-only changes,
    # so gating only on DjmdPlaylist misses every "removed a track from rb
    # playlist X" case — the reported "# backlog" desync. We collect both
    # signals and emit a delta when either fires.
    if "playlists" in scopes_set:
        try:
            wm = watermarks.get("DjmdPlaylist", 0)
            sp_wm = watermarks.get("DjmdSongPlaylist", 0)
            max_seen = wm
            sp_max_seen = sp_wm

            # Find playlists whose membership changed since last sync. Direct
            # SQLAlchemy query — same pattern as _fetch_playlist_songs below;
            # pyrekordbox's high-level helpers don't expose USN filters.
            touched_playlist_ids: set[str] = set()
            try:
                from pyrekordbox.db6.tables import DjmdSongPlaylist  # type: ignore
                if hasattr(db, "session"):
                    sp_rows = (
                        db.session.query(DjmdSongPlaylist.PlaylistID, DjmdSongPlaylist.rb_local_usn)
                        .filter(DjmdSongPlaylist.rb_local_usn > sp_wm)
                        .all()
                    )
                    for r in sp_rows:
                        pid = getattr(r, "PlaylistID", None)
                        if pid:
                            touched_playlist_ids.add(str(pid))
                        usn = getattr(r, "rb_local_usn", None)
                        if usn is not None:
                            usn_int = int(usn)
                            if usn_int > sp_max_seen:
                                sp_max_seen = usn_int
                    sys.stderr.write(
                        f"playlists: {len(sp_rows)} song-playlist rows past usn={sp_wm}, "
                        f"covering {len(touched_playlist_ids)} playlists\n"
                    )
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(
                    f"playlists: DjmdSongPlaylist USN scan failed: {type(exc).__name__}: {exc}\n"
                )

            pl_rows, err = _fetch_rows(db, "get_playlist", "get_djmd_playlist")
            if err: sys.stderr.write(f"playlists fetch warnings: {err}\n")
            sys.stderr.write(f"playlists: fetched {len(pl_rows)} rows\n")
            emit("progress", {"phase": "playlists", "done": 0, "total": len(pl_rows)})
            emitted = 0
            # Every non-tombstoned id, gathered BEFORE the watermark/target
            # gates below — the existence index must cover unchanged rows too.
            live_ids: list[str] = []
            for i, row in enumerate(pl_rows):
                if is_cancelled():
                    break
                usn = int(getattr(row, "rb_local_usn", 0) or 0)
                if usn > max_seen:
                    max_seen = usn
                pid = str(getattr(row, "ID", "") or "")
                if pid and not int(getattr(row, "rb_local_deleted", 0) or 0):
                    live_ids.append(pid)
                if targeted:
                    # Scoped pull: only the requested playlists (folder targets
                    # arrive pre-expanded to their descendant playlist ids by
                    # the caller). USN/membership gates don't apply — we want
                    # the current row + membership regardless.
                    if tpids is None or pid not in tpids:
                        continue
                else:
                    membership_changed = pid in touched_playlist_ids
                    if usn <= wm and not membership_changed:
                        continue
                delta = _row_to_playlist_delta(db, row)
                if delta is not None:
                    emit("playlist", asdict(delta))
                    emitted += 1
            emit("progress", {"phase": "playlists", "done": len(pl_rows), "total": len(pl_rows)})
            sys.stderr.write(f"playlists: emitted {emitted} deltas\n")
            # Existence index (see PlaylistIndex): rekordbox hard-deletes rows no
            # sync peer has seen, so a vanished playlist/folder never shows up
            # as a tombstone delta above. Only a COMPLETE pass may vouch for
            # absence — a failed fetch or a cancel would read as mass deletion.
            if err is None and not is_cancelled():
                if not targeted:
                    emit("playlist_index", asdict(PlaylistIndex(live_ids=live_ids, missing_ids=None)))
                    sys.stderr.write(f"playlists: index {len(live_ids)} live ids\n")
                elif tpids:
                    live_set = set(live_ids)
                    missing = sorted(p for p in tpids if p not in live_set)
                    emit("playlist_index", asdict(PlaylistIndex(live_ids=None, missing_ids=missing)))
                    sys.stderr.write(f"playlists: index {len(missing)} targeted id(s) missing\n")
            new_marks["DjmdPlaylist"] = max_seen
            new_marks["DjmdSongPlaylist"] = sp_max_seen
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"playlists pass failed: {type(exc).__name__}: {exc}\n")

    # ── MyTags ─────────────────────────────────────────────────────────────
    if "mytags" in scopes_set:
        try:
            wm = watermarks.get("DjmdMyTag", 0)
            max_seen = wm
            # pyrekordbox >=0.4 renamed: get_mytag → get_my_tag.
            tag_rows, err = _fetch_rows(db, "get_my_tag", "get_mytag", "get_djmd_my_tag")
            if err: sys.stderr.write(f"mytags fetch warnings: {err}\n")
            sys.stderr.write(f"mytags: fetched {len(tag_rows)} rows\n")
            emit("progress", {"phase": "mytags", "done": 0, "total": len(tag_rows)})
            for i, row in enumerate(tag_rows):
                if is_cancelled():
                    break
                usn = int(getattr(row, "rb_local_usn", 0) or 0)
                # Tombstoned MyTags are emitted on EVERY pass, watermark or
                # not: the importer reconciles them against Curator's live
                # tags each run (merge into a live same-name tag, prune when
                # unused, keep when still curated so the next push revives
                # it). They carry no membership — a dead tag's song rows are
                # invisible in rekordbox and must not re-seed Curator.
                tombstoned = bool(getattr(row, "rb_local_deleted", 0))
                if usn <= wm and not tombstoned:
                    continue
                if usn > max_seen:
                    max_seen = usn
                delta = _row_to_mytag_delta(db, row, with_tracks=not tombstoned)
                if delta is not None:
                    emit("mytag", asdict(delta))
            emit("progress", {"phase": "mytags", "done": len(tag_rows), "total": len(tag_rows)})
            new_marks["DjmdMyTag"] = max_seen
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"mytags pass failed: {type(exc).__name__}: {exc}\n")

    # ── Play history ───────────────────────────────────────────────────────
    # Neither DjmdHistory nor DjmdSongHistory carries a usable rb_local_usn,
    # so this is a full scan every pass (same call as cues) — the Node
    # importer upserts idempotently by the rb ids. Independent of `targeted`:
    # history reads its OWN tables (djmdHistory), unaffected by the content-id
    # targeting that scopes the track/cue/playlist passes, so it runs in full
    # whenever the caller asked for the scope (the sync-from/sync-to flows do).
    if "history" in scopes_set:
        try:
            from pyrekordbox.db6.tables import DjmdHistory, DjmdSongHistory  # type: ignore

            # Attribute=1 rows are rekordbox's year/month FOLDER nodes in the
            # history tree; only Attribute=0 rows are real sessions.
            hist_rows = (
                db.session.query(DjmdHistory)
                .filter(DjmdHistory.Attribute == 0)
                .all()
            )
            song_rows = db.session.query(DjmdSongHistory).all()
            plays_by_hist: dict[str, list[HistoryPlayRef]] = {}
            for srow in song_rows:
                sid = getattr(srow, "ID", None)
                hid = getattr(srow, "HistoryID", None)
                cid = getattr(srow, "ContentID", None)
                if not sid or not hid or not cid:
                    continue
                plays_by_hist.setdefault(str(hid), []).append(
                    HistoryPlayRef(
                        rb_song_history_id=str(sid),
                        rb_content_id=str(cid),
                        track_no=int(getattr(srow, "TrackNo", 0) or 0),
                        created_at_ms=_dt_to_epoch_ms(getattr(srow, "created_at", None), assume_utc=True),
                    )
                )
            emit("progress", {"phase": "history", "done": 0, "total": len(hist_rows)})
            emitted = 0
            for i, hrow in enumerate(hist_rows):
                if is_cancelled():
                    break
                hid = getattr(hrow, "ID", None)
                if not hid:
                    continue
                plays = plays_by_hist.get(str(hid), [])
                plays.sort(key=lambda p: p.track_no)
                delta = HistoryDelta(
                    rb_history_id=str(hid),
                    name=str(getattr(hrow, "Name", "") or ""),
                    # DateCreated is LOCAL wall-clock (unlike the rows'
                    # UTC created_at — the constant offset between them is
                    # timezone, not import lag).
                    date_created_ms=_dt_to_epoch_ms(getattr(hrow, "DateCreated", None), assume_utc=False),
                    plays=plays,
                )
                emit("history", asdict(delta))
                emitted += 1
                if (i + 1) % 100 == 0:
                    emit("progress", {"phase": "history", "done": i + 1, "total": len(hist_rows)})
            emit("progress", {"phase": "history", "done": len(hist_rows), "total": len(hist_rows)})
            # Sentinel watermark for observability only (like DjmdCue) — the
            # importer's upsert-by-id is what makes re-scans idempotent.
            new_marks["DjmdSongHistory"] = len(song_rows)
            sys.stderr.write(f"history: emitted {emitted} sessions, {len(song_rows)} plays\n")
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"history pass failed: {type(exc).__name__}: {exc}\n")

    return new_marks


# ──────────────────────────────────────────────────────────────────────────────
# Row→delta translators. Defensive against pyrekordbox attribute variations
# between minor versions — every getattr has a default.

def _row_to_track_delta(row: Any) -> Optional[TrackDelta]:
    cid = getattr(row, "ID", None)
    if not cid:
        return None
    bpm_raw = getattr(row, "BPM", None)
    # Rekordbox stores DjmdContent.BPM as centi-BPM — an int = round(BPM × 100) for
    # EVERY row (91.13 BPM → 9113), not just some. Always /100 for ints; a float
    # (rare, pyrekordbox-version-dependent) is already real BPM, so pass it through.
    if bpm_raw:
        bpm = float(bpm_raw) / 100.0 if isinstance(bpm_raw, int) else float(bpm_raw)
    else:
        bpm = None

    # DjmdContent.Key is a SQLAlchemy relationship to DjmdKey; the actual key
    # string (e.g. "Cm", "F#", "Bb", or a literal Camelot like "8A") lives on
    # DjmdKey.ScaleName. Earlier revisions read row.Key directly and got the
    # ORM object instead of a string, so every imported track ended up with
    # null keyCamelot/keyMusical.
    key_row = getattr(row, "Key", None)
    key_scale_name = getattr(key_row, "ScaleName", None) if key_row is not None else None
    key_camelot, key_musical = _parse_rekordbox_key(key_scale_name)
    artist_row = getattr(row, "Artist", None)
    album_row = getattr(row, "Album", None)
    genre_row = getattr(row, "Genre", None)
    label_row = getattr(row, "Label", None)

    last_played_ms: Optional[int] = None
    last_played = getattr(row, "LastPlayed", None) or getattr(row, "LastPlayedAt", None)
    if last_played is not None:
        try:
            last_played_ms = int(last_played.timestamp() * 1000) if hasattr(last_played, "timestamp") else int(last_played)
        except Exception:
            last_played_ms = None

    # djmdContent.updated_at — Rekordbox's per-row modification timestamp.
    # The pyrekordbox ORM surfaces it as `updated_at` (datetime). Older
    # schema dumps may use `UpdatedAt` or `LastUpdateDate`. Falling back
    # through known aliases keeps the importer compatible with both.
    rb_updated_at_ms: Optional[int] = None
    rb_updated_at = (
        getattr(row, "updated_at", None)
        or getattr(row, "UpdatedAt", None)
        or getattr(row, "LastUpdateDate", None)
    )
    if rb_updated_at is not None:
        try:
            rb_updated_at_ms = (
                int(rb_updated_at.timestamp() * 1000)
                if hasattr(rb_updated_at, "timestamp")
                else int(rb_updated_at)
            )
        except Exception:
            rb_updated_at_ms = None

    # Rekordbox's "Date Added" column on the track-table row. pyrekordbox
    # surfaces it as `StockDate` — usually a `date` or `datetime` instance,
    # but some schema dumps carry a "YYYY-MM-DD" string. Try both shapes;
    # fall through silently when the column is missing or unparseable.
    rb_added_at_ms: Optional[int] = None
    stock_date = (
        getattr(row, "StockDate", None)
        or getattr(row, "DateCreated", None)
    )
    if stock_date is not None:
        try:
            if hasattr(stock_date, "timestamp"):
                rb_added_at_ms = int(stock_date.timestamp() * 1000)
            elif isinstance(stock_date, str) and len(stock_date) >= 10:
                from datetime import datetime
                rb_added_at_ms = int(datetime.fromisoformat(stock_date[:19]).timestamp() * 1000)
        except Exception:
            rb_added_at_ms = None

    return TrackDelta(
        rb_content_id=str(cid),
        rb_local_usn=int(getattr(row, "rb_local_usn", 0) or 0),
        rb_local_deleted=bool(getattr(row, "rb_local_deleted", 0)),
        rb_updated_at_ms=rb_updated_at_ms,
        rb_added_at_ms=rb_added_at_ms,
        file_path=_normalize_path(getattr(row, "FolderPath", None) or getattr(row, "FilePath", None)),
        title=getattr(row, "Title", None),
        artist=getattr(artist_row, "Name", None) if artist_row else None,
        album=getattr(album_row, "Name", None) if album_row else None,
        genre=getattr(genre_row, "Name", None) if genre_row else None,
        label=getattr(label_row, "Name", None) if label_row else None,
        bpm=bpm,
        key_camelot=key_camelot,
        key_musical=key_musical,
        color_label=_COLOR_ID_TO_NAME.get(int(getattr(row, "ColorID", 0) or 0)),
        rating=int(getattr(row, "Rating", 0)) if getattr(row, "Rating", None) is not None else None,
        comment=getattr(row, "Commnt", None) or getattr(row, "Comment", None),
        play_count=int(getattr(row, "DJPlayCount", 0)) if getattr(row, "DJPlayCount", None) is not None else None,
        last_played_at_ms=last_played_ms,
        # DjmdContent.Length is in SECONDS (not ms despite the int look).
        # Verified against the source DB: "Maybe That's a Lie" Length=210
        # = 3.5 min. An earlier /1000 was wrong — it produced 0.21s
        # durations which made the waveform sidecar write tiny .cpk files
        # (44 samples for a 6-min track instead of 36000).
        duration_sec=float(getattr(row, "Length", 0)) if getattr(row, "Length", None) else None,
    )


def _row_to_cue_delta(row: Any, slot: int, kind: str) -> Optional[CueDelta]:
    """Translate one DjmdCue row to our wire delta.

    `slot` and `kind` are assigned by the caller (the per-track grouping
    loop) — slot is an ordinal in the (track, kind) namespace, not a
    field on the row. Kind comes from `is_hot_cue`/`is_memory_cue` on
    the SQLAlchemy row, not the bare `Kind` integer (which is the cue's
    sequential position in rekordbox's own ordering, NOT a hot/memory
    discriminator as our earlier code assumed).
    """
    cid = getattr(row, "ContentID", None)
    if not cid:
        return None
    in_ms = getattr(row, "InMsec", None) or 0
    out_ms = getattr(row, "OutMsec", None)
    position_sec = float(in_ms) / 1000.0
    length_sec: Optional[float] = None
    # OutMsec is -1 when there's no out point (single-point cue, not a loop).
    if out_ms is not None and out_ms > 0 and out_ms > in_ms:
        length_sec = (float(out_ms) - float(in_ms)) / 1000.0

    color = _resolve_cue_color(
        getattr(row, "Color", None),
        getattr(row, "ColorTableIndex", None),
    )
    return CueDelta(
        rb_content_id=str(cid),
        rb_local_usn=int(getattr(row, "rb_local_usn", 0) or 0),
        rb_local_deleted=bool(getattr(row, "rb_local_deleted", 0)),
        slot=slot,
        kind=kind,
        position_sec=position_sec,
        length_sec=length_sec,
        color=color,
        name=getattr(row, "Comment", None) or None,
    )


def _fetch_playlist_songs(db: Any, playlist_obj: Any, pid: str) -> list[Any]:
    """Return DjmdSongPlaylist join rows for one playlist (PlaylistID, ContentID, TrackNo).

    pyrekordbox's helper methods drift between minor versions AND return
    inconsistent shapes — `get_playlist_contents()` sometimes returns
    DjmdContent rows (track records, no ContentID attribute) instead of
    DjmdSongPlaylist join rows. The direct SQLAlchemy query via `db.session`
    is the only shape guaranteed to give us the join rows with positions,
    so we go straight there. Helpers tried as fallbacks only if the import
    fails (which would indicate the SQLAlchemy model name changed).

    `rb_local_deleted = 0` filter is critical: rekordbox soft-deletes
    membership rows rather than hard-deleting them (StatsFull mixin),
    so a track the user removed from this playlist in rb still appears
    in the table. Without this filter, the importer's wipe-and-replace
    re-inserts the zombie and the playlist never shrinks.
    """
    try:
        from pyrekordbox.db6.tables import DjmdSongPlaylist  # type: ignore
        if hasattr(db, "session"):
            # TrackNo is not guaranteed unique: playlists that accumulated
            # holes from earlier (non-compacting) Curator removals got
            # colliding numbers when rekordbox appended at row-count+1. The
            # writer now compacts, but legacy duplicates still exist, and
            # an unordered tie would make the pull adopt whichever order
            # SQLite happened to return. Tie-break on insertion (created_at,
            # then ID) so an older row stays ahead of a newer one.
            return list(
                db.session.query(DjmdSongPlaylist)
                .filter(DjmdSongPlaylist.PlaylistID == pid)
                .filter(DjmdSongPlaylist.rb_local_deleted == 0)
                .order_by(DjmdSongPlaylist.TrackNo, DjmdSongPlaylist.created_at, DjmdSongPlaylist.ID)
                .all()
            )
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"DjmdSongPlaylist query failed for pid={pid}: {type(exc).__name__}: {exc}\n")
    # Fallback helpers (rare — only used if the SQLAlchemy model isn't where
    # we expect). They may return DjmdContent rows; downstream filter drops
    # rows lacking ContentID so this is safe.
    for method_name in ("get_playlist_songs", "get_djmd_song_playlist"):
        fn = getattr(db, method_name, None)
        if fn is None:
            continue
        for kwargs in ({"PlaylistID": pid}, {"playlist_id": pid}):
            try:
                return list(fn(**kwargs))
            except Exception:
                continue
    return []


def _row_to_playlist_delta(db: Any, row: Any) -> Optional[PlaylistDelta]:
    pid = getattr(row, "ID", None)
    if not pid:
        return None
    is_folder = bool(getattr(row, "Attribute", 0) == 1)  # rekordbox: 1=folder
    is_smart = bool(getattr(row, "Attribute", 0) == 4)   # 4=smart playlist
    tracks: list[PlaylistTrackRef] = []
    if not is_folder:
        songs = _fetch_playlist_songs(db, row, str(pid))
        tracks = [
            PlaylistTrackRef(
                rb_content_id=str(getattr(s, "ContentID", "")),
                position=int(getattr(s, "TrackNo", 0) or 0),
            )
            for s in songs
            if getattr(s, "ContentID", None)
        ]

    # Rekordbox stores the top-level parent as the literal string "root" (and
    # in some versions as "0" or 0). Normalize all of these to None so the
    # Node importer doesn't try to reference a non-existent rb_root folder
    # — which would hide every top-level row from the tree renderer.
    parent_raw = getattr(row, "ParentID", None)
    parent_str = str(parent_raw) if parent_raw is not None else ""
    parent_folder_id: Optional[str] = None if parent_str in ("", "root", "0") else parent_str

    # Seq = the user's manual order within ParentID in Rekordbox. Some
    # versions store it as Seq, others as Position; defensively read both.
    seq_raw = getattr(row, "Seq", None)
    if seq_raw is None:
        seq_raw = getattr(row, "Position", None)
    try:
        position = int(seq_raw) if seq_raw is not None else 0
    except (TypeError, ValueError):
        position = 0

    return PlaylistDelta(
        rb_playlist_id=str(pid),
        rb_local_usn=int(getattr(row, "rb_local_usn", 0) or 0),
        rb_local_deleted=bool(getattr(row, "rb_local_deleted", 0)),
        parent_folder_id=parent_folder_id,
        name=str(getattr(row, "Name", "") or ""),
        is_folder=is_folder,
        is_smart=is_smart,
        position=position,
        tracks=tracks,
    )


def _fetch_mytag_songs(db: Any, tid: str) -> list[Any]:
    """Return DjmdSongMyTag join rows for one MyTag (MyTagID, ContentID).

    Same rationale as _fetch_playlist_songs — direct SQLAlchemy query is
    the only shape we can trust to return join rows with the column we need.
    `rb_local_deleted = 0` filter excludes soft-deleted memberships
    (StatsFull mixin) so removed tag-memberships don't come back as zombies.
    """
    try:
        from pyrekordbox.db6.tables import DjmdSongMyTag  # type: ignore
        if hasattr(db, "session"):
            return list(
                db.session.query(DjmdSongMyTag)
                .filter(DjmdSongMyTag.MyTagID == tid)
                .filter(DjmdSongMyTag.rb_local_deleted == 0)
                .all()
            )
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"DjmdSongMyTag query failed for tid={tid}: {type(exc).__name__}: {exc}\n")
    for method_name in ("get_my_tag_songs", "get_mytag_songs", "get_mytag_contents"):
        fn = getattr(db, method_name, None)
        if fn is None:
            continue
        for kwargs in ({"MyTagID": tid}, {"mytag_id": tid}, {"my_tag_id": tid}):
            try:
                return list(fn(**kwargs))
            except Exception:
                continue
    return []


def _row_to_mytag_delta(db: Any, row: Any, with_tracks: bool = True) -> Optional[MyTagDelta]:
    tid = getattr(row, "ID", None)
    if not tid:
        return None
    track_ids: list[str] = []
    if with_tracks:
        rows = _fetch_mytag_songs(db, str(tid))
        track_ids = [str(getattr(r, "ContentID", "")) for r in rows if getattr(r, "ContentID", None)]

    return MyTagDelta(
        rb_tag_id=str(tid),
        rb_local_usn=int(getattr(row, "rb_local_usn", 0) or 0),
        rb_local_deleted=bool(getattr(row, "rb_local_deleted", 0)),
        name=str(getattr(row, "Name", "") or ""),
        color=_COLOR_ID_TO_NAME.get(int(getattr(row, "Color", 0) or 0)),
        tracks=track_ids,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Waveform pass — independent of the per-cue scan because it touches the
# filesystem (ANLZ files alongside each audio file) rather than master.db.

def _is_cpk_fresh_for_row(db: Any, row: Any, hi_path: str) -> bool:
    """Fast pre-check: is the on-disk .cpk newer than the row's source ANLZ?

    The whole point is to avoid loading + binary-parsing ANLZ files when the
    cached output is already current. `db.get_anlz_paths` is a pure DB lookup
    (no file I/O) — combined with os.path.getmtime stats, this whole function
    runs in microseconds per row. On a re-run where most rows haven't changed
    in rekordbox, this collapses the waveform pass from minutes to seconds.

    Returns True iff hi_path exists and its mtime is >= every ANLZ source
    file's mtime. False on missing files, missing methods, or any error
    (caller falls back to the slow path).
    """
    if not os.path.exists(hi_path):
        return False
    try:
        hi_mtime = os.path.getmtime(hi_path)
    except OSError:
        return False
    if not hasattr(db, "get_anlz_paths"):
        return False
    try:
        paths_obj = db.get_anlz_paths(content=row)
    except Exception:
        return False
    candidates: list = list(paths_obj.values()) if isinstance(paths_obj, dict) else list(paths_obj or [])
    for p in candidates:
        if not p:
            continue
        try:
            mt = os.path.getmtime(p)
        except OSError:
            continue
        if mt > hi_mtime:
            return False
    # No ANLZ source is newer than the cached .cpk. (And if there are no
    # ANLZ files at all for this row, nothing useful to extract anyway —
    # also a skip.)
    return True


def _scan_waveforms(
    db: Any,
    peaks_dir: str,
    emit: EventEmitter,
    is_cancelled: Callable[[], bool],
    force_refresh_grids: bool = False,
    emit_grids: bool = True,
    write_peaks: bool = True,
    only_content_ids: Optional[set] = None,
) -> None:
    """Walk every track that has an ANLZ file; convert to .cpk pair.

    We don't watermark this against an USN — ANLZ regenerations don't bump
    rb_local_usn. Instead we compare ANLZ mtime vs the existing .cpk mtime
    and skip the entire row when the cpk is current. This makes incremental
    re-reads cheap even without USN coverage for waveforms.

    The freshness check (_is_cpk_fresh_for_row) happens *before* loading the
    ANLZ — that's the whole point. Loading + parsing ANLZ averages ~150ms
    per row; the stat-only fast path is ~microseconds. On a re-run with
    nothing changed, this collapses minutes of work into seconds.

    `force_refresh_grids=True` bypasses the freshness gate for the beatgrid
    half. The .cpk file (peaks/bands) is still skipped when fresh — those
    don't drift — but the ANLZ is loaded so the beatgrid + downbeats can
    be re-emitted. The Node importer pairs this with an LMW bypass on the
    write side. Used when the user has had analyzer beatgrids clobber
    rb-sourced ones and wants to restore them in one shot.

    `emit_grids` / `write_peaks` correspond to the 'cues_grids_phrases' and
    'waveform_peaks' scopes in scan(). The pass loads each ANLZ once and
    decodes the requested halves; running just one half skips the other's
    work. With BOTH off this function isn't called.
    """
    try:
        rows = list(db.get_content())
    except Exception:
        return

    # Phase label tracks what this pass is actually producing: with the
    # waveform scope off it only extracts beatgrids + phrases out of the
    # shared ANLZ load, and showing "waveforms" in the progress UI reads
    # as "my unchecked box is being synced anyway".
    phase = "waveforms" if write_peaks else "grids"
    emit("progress", {"phase": phase, "done": 0, "total": len(rows)})
    beats_emitted = 0
    bands_emitted = 0
    segments_emitted = 0
    # Per-pass ANLZ-load failure accumulator. _load_anlz_for_row bumps the
    # counters by category so we report N totals at end of pass instead of
    # spamming N stderr lines. `samples` keeps the first exception text per
    # category for forensics when something unusual shows up.
    anlz_errors: dict[str, Any] = {"counts": {}, "samples": {}}
    skipped_fresh = 0
    for i, row in enumerate(rows):
        if is_cancelled():
            break
        cid = str(getattr(row, "ID", "") or "")
        if not cid:
            continue
        # Scoped pull: skip rows outside the target set (only_content_ids is
        # the playlist-expanded content set for a "Sync from Rekordbox" run).
        if only_content_ids is not None and cid not in only_content_ids:
            continue

        lo_path = os.path.join(peaks_dir, "lo", f"rb_{cid}.cpk")
        hi_path = os.path.join(peaks_dir, "hi", f"rb_{cid}.cpk")

        # Fast path: stat-only freshness check before any ANLZ load. When
        # the on-disk .cpk is fresh (its mtime is newer than every ANLZ
        # source file), we skip the entire row including the grids/segments
        # half. The reasoning: a fresh .cpk means we processed this row in
        # a previous sync, which would have also emitted beatgrid +
        # segments to the importer — those should already be in Curator's
        # DB. Loading + parsing ANLZ averages ~150ms per row; the stat-only
        # check is microseconds. On a 4k-track library this is the
        # difference between ~10 minutes and ~5 seconds for an incremental
        # sync.
        #
        # `force_refresh_grids` (set by "Resync Everything") bypasses this
        # skip — the user has explicitly asked to re-emit everything.
        # Edge case: if a user wiped Curator's DB while .cpk files remained
        # on disk, "Sync Newer" would skip those rows; they'd need to run
        # "Resync Everything" once to backfill the grids.
        cpk_fresh = _is_cpk_fresh_for_row(db, row, hi_path)
        if cpk_fresh and not force_refresh_grids:
            skipped_fresh += 1
            if (i + 1) % 100 == 0:
                emit("progress", {"phase": phase, "done": i + 1, "total": len(rows)})
            continue

        anlz = _load_anlz_for_row(db, row, anlz_errors)
        if anlz is None:
            continue

        # Grids half (beatgrid + downbeats + PSSI segments). Cheap once the
        # ANLZ is loaded. Gated on `emit_grids` (the 'cues_grids_phrases'
        # scope on the TS side).
        beats: list[float] = []
        downbeats: list[float] = []
        segments = None
        if emit_grids:
            beats, downbeats = _extract_beatgrid(anlz)
            if beats:
                beats_emitted += 1
            duration_for_segments = float(getattr(row, "Length", 0)) if getattr(row, "Length", None) else 0.0
            segments = _extract_segments(anlz, beats, duration_for_segments)
            if segments:
                segments_emitted += 1

        # Peaks half. Gated only on `write_peaks` (the 'waveform_peaks'
        # scope) — by this line we've already passed the fast-path skip,
        # so either the .cpk is stale or force_refresh_grids is on. In
        # both cases we want to re-decode + rewrite the bands.
        bands_ok = False
        if write_peaks:
            bands_pack = extract_bands_from_anlz(anlz)
            if bands_pack:
                bands, src_rate = bands_pack
                # DjmdContent.Length is in SECONDS (see _row_to_track_delta).
                duration_sec = float(getattr(row, "Length", 0)) if getattr(row, "Length", None) else 0.0
                try:
                    write_cpk_pair_from_rekordbox(lo_path, hi_path, duration_sec, bands, src_rate)
                    bands_ok = True
                    bands_emitted += 1
                except Exception as exc:  # noqa: BLE001
                    sys.stderr.write(f"waveform write failed for {cid}: {exc}\n")

        # Emit when ANY of beatgrid / bands / segments succeeded. The importer
        # treats missing peaks paths as "no peaks from rekordbox" and the
        # renderer's curator-peaks:// handler 404s in that case — it can
        # always fall back to the analyzer's output later.
        if beats or bands_ok or segments:
            emit("waveform", {
                "rb_content_id": cid,
                "peaks_lo_path": lo_path if bands_ok else None,
                "peaks_hi_path": hi_path if bands_ok else None,
                "beatgrid_sec": beats,
                "downbeats_sec": downbeats,
                "segments": segments,
            })

        if (i + 1) % 25 == 0:
            emit("progress", {"phase": phase, "done": i + 1, "total": len(rows)})
    emit("progress", {"phase": phase, "done": len(rows), "total": len(rows)})
    err_parts = []
    counts = anlz_errors["counts"]
    samples = anlz_errors["samples"]
    if counts:
        # Pretty: `anlz_skipped=missing:42 version:117 other:1`. Stable key
        # order (missing → version → other) so log greps don't drift.
        for key in ("missing", "version", "other"):
            n = counts.get(key, 0)
            if n:
                err_parts.append(f"{key}:{n}")
    err_summary = f"  anlz_skipped={' '.join(err_parts)}" if err_parts else ""
    sys.stderr.write(
        f"waveforms: skipped_fresh={skipped_fresh}  "
        f"beatgrids={beats_emitted}  bands={bands_emitted}  segments={segments_emitted}"
        f"  (emit_grids={emit_grids} write_peaks={write_peaks}"
        f"{' force' if force_refresh_grids else ''})"
        f"{err_summary}\n"
    )
    # One representative message per error category — useful when a new
    # ANLZ format version starts failing and we want a copy-pasteable
    # exception for the bug report without enabling per-row logging.
    for key in ("missing", "version", "other"):
        sample = samples.get(key)
        if sample:
            sys.stderr.write(f"  anlz sample [{key}]: {sample}\n")


class _AnlzBundle:
    """Multi-file ANLZ wrapper: the per-tag data we need is split across
    DAT (beatgrid PQTZ, mono waveform PWV2/PWV3), EXT (colour waveform
    PWV4/PWV5, hot cues PCO2) and 2EX (extended-color extras). Returning
    a single AnlzFile would miss whichever tag lives in the other file.

    The wrapper presents the union of all loaded files via `get_tag(key)`
    so callers (`extract_bands_from_anlz`, `_extract_beatgrid`) can stay
    file-agnostic and just look up tag names.
    """
    __slots__ = ("files",)

    def __init__(self, files: list) -> None:
        self.files = files

    def get_tag(self, key: str):
        for f in self.files:
            getter = getattr(f, "get_tag", None)
            if callable(getter):
                try:
                    t = getter(key)
                    if t is not None:
                        return t
                except (KeyError, IndexError, StopIteration):
                    continue
                except Exception:
                    continue
            raw = getattr(f, "tags", None)
            if isinstance(raw, dict):
                t = raw.get(key)
                if t is not None:
                    return t
            elif isinstance(raw, list):
                for t in raw:
                    if getattr(t, "type", None) == key:
                        return t
        return None

    @property
    def tags(self) -> list:
        # Convenience for `extract_bands_from_anlz`'s "is the tag list
        # non-empty" debug paths. Returns the concatenation across files.
        out: list = []
        for f in self.files:
            raw = getattr(f, "tags", None)
            if isinstance(raw, list):
                out.extend(raw)
            elif isinstance(raw, dict):
                out.extend(raw.values())
        return out


def _classify_anlz_error(exc: BaseException) -> str:
    """Bucket an ANLZ load failure into one of three categories so the
    waveform-pass summary can break the counts down meaningfully.

    `missing` — the path in master.db points to a file that's gone (user
                deleted/moved tracks; library copied across machines
                without the USBANLZ tree). Expected in real libraries.
    `version` — pyrekordbox's binary parser hit a magic-number / Const
                mismatch. Rekordbox 7+ writes ANLZ files with a different
                version byte that older pyrekordbox can't parse. Tracks
                fall back to the analyzer pipeline.
    `other`   — anything else (corrupted file, partial write, unknown
                tag). Rare; sampled message is kept for forensics.
    """
    if isinstance(exc, FileNotFoundError):
        return "missing"
    name = type(exc).__name__
    # construct raises ConstError; some builds expose it as ConstructError
    # with the same message shape ("Error in path … expected … but parsed …").
    if name in ("ConstError", "ConstructError") or "expected" in str(exc):
        return "version"
    return "other"


def _load_anlz_for_row(db: Any, row: Any, errors: dict[str, Any] | None = None):
    """Best-effort ANLZ loader. pyrekordbox >=0.4 exposes
    `db.read_anlz_files(content)` which returns
    `{'DAT': AnlzFile, 'EXT': AnlzFile, '2EX': AnlzFile, ...}` — already
    parsed.

    Different tags live in different files (PQTZ beatgrid in DAT;
    PWV5 colour-waveform in EXT). Returning a single file would lose
    whichever tag wasn't in it, so we wrap the whole dict in an
    `_AnlzBundle` that proxies `get_tag` across all loaded files.

    Earlier versions of this code called `AnlzFile.parse_file(path)`
    directly, but on pyrekordbox 0.4+ that raises AttributeError
    silently and the whole waveform pass produced zero rows.

    `errors` is an optional accumulator: when provided, failures bump
    `errors['counts'][kind]` and stash the first-seen exception message
    in `errors['samples'][kind]` instead of spamming stderr per-row. The
    waveform pass flushes these into its end-of-pass summary so a 4k-track
    sync produces three numbers in the log instead of three thousand lines.
    """
    try:
        if not hasattr(db, "read_anlz_files"):
            return None
        parsed = db.read_anlz_files(row)
        if not isinstance(parsed, dict) or not parsed:
            return None
        files = [v for v in parsed.values() if v is not None]
        if not files:
            return None
        return _AnlzBundle(files)
    except Exception as exc:  # noqa: BLE001
        if errors is not None:
            kind = _classify_anlz_error(exc)
            errors["counts"][kind] = errors["counts"].get(kind, 0) + 1
            samples = errors["samples"]
            if kind not in samples:
                samples[kind] = f"content {getattr(row, 'ID', '?')}: {type(exc).__name__}: {exc}"
        else:
            sys.stderr.write(
                f"anlz load failed for content {getattr(row, 'ID', '?')}: "
                f"{type(exc).__name__}: {exc}\n"
            )
    return None


def _collapse_beat_seams(
    times: list[float], beat_nos: list[int]
) -> tuple[list[float], list[float]]:
    """Flatten a Rekordbox dynamic (variable-tempo) beatgrid to one entry per
    actual beat, returning (beat seconds, downbeat seconds).

    RB stores a variable-tempo grid as a chain of tempo segments. Where one
    segment hands off to the next it writes a *seam* — a fresh beat marker a
    few ms after the previous beat, frequently a duplicate `beat 1`. Reading
    every PQTZ entry as an independent beat double-counts those seams: it
    inflates the beat/bar count (one real track here: 450 beats / 144 downbeats
    for a ~101-bar song) and wrecks any grid-derived BPM, because the seam
    intervals are near-zero. RB itself draws the seam as a single line (the two
    anchors are sub-pixel apart) and reports a clean tempo.

    Collapse any entry that lands within a fraction of the running beat period
    of the previously kept beat. When the seam carries the bar anchor
    (`beat == 1`) we adopt its precise time as the downbeat — the re-anchor
    routinely places the new bar's `beat 1` onto the seam.
    """
    if len(times) < 3:
        downs = [t for t, b in zip(times, beat_nos) if b == 1]
        return list(times), downs
    # Nominal beat period — median of consecutive gaps is robust to both the
    # near-zero seam spikes and the occasional missing beat (large gap), each
    # a minority of intervals.
    diffs = sorted(times[i] - times[i - 1] for i in range(1, len(times)))
    period = diffs[len(diffs) // 2]
    # 40% of a beat: comfortably above the few-ms seams, well below a real
    # inter-beat gap. Floor guards a degenerate (zero/negative) period.
    seam_gap = max(0.05, period * 0.4) if period > 0 else 0.05

    kept_times: list[float] = [times[0]]
    kept_down: list[bool] = [beat_nos[0] == 1]
    for i in range(1, len(times)):
        if times[i] - kept_times[-1] < seam_gap:
            # Seam re-anchor — fold into the kept beat. If it carries the bar
            # anchor, take its time so the downbeat sits on the true boundary.
            if beat_nos[i] == 1:
                kept_times[-1] = times[i]
                kept_down[-1] = True
            continue
        kept_times.append(times[i])
        kept_down.append(beat_nos[i] == 1)
    # Downbeat selection with a minimum-spacing gate. A turbulent re-gridded
    # section can re-anchor `beat 1` a beat or two apart (RB restarts the bar
    # count mid-bar); those are corrections of the *same* bar, not new bars, so
    # accepting each would mint spurious sub-bar-length bars. A genuine next
    # downbeat is ~4 beats out; require at least 2.5 to separate the two.
    min_bar_gap = period * 2.5 if period > 0 else 0.0
    downbeats: list[float] = []
    last_db = float("-inf")
    for t, d in zip(kept_times, kept_down):
        if d and (t - last_db) >= min_bar_gap:
            downbeats.append(t)
            last_db = t
    return kept_times, downbeats


def _extract_beatgrid(anlz) -> tuple[list[float], list[float]]:
    """Return (beat-time seconds, downbeat-time seconds).

    PQTZ on pyrekordbox 0.4+ exposes `get_times()` (float seconds, already
    decoded) and `get_beats()` (np.int8 in 1..4, downbeat = 1). It does
    NOT have an `.entries` attribute the way our older code assumed —
    PQTZ.content holds the raw struct fields, and the helpers do the
    decode for us. PQT2 (the 4-bar-grid variant) follows the same shape;
    we fall back to it when PQTZ is absent.

    Dynamic (variable-tempo) grids carry tempo-segment seams that read as
    duplicate beats; `_collapse_beat_seams` flattens them so the count and the
    downbeat set match what Rekordbox actually shows.
    """
    beats: list[float] = []
    downbeats: list[float] = []
    try:
        grid = anlz.get_tag("PQTZ") if hasattr(anlz, "get_tag") else None
        if grid is None and hasattr(anlz, "get_tag"):
            try:
                grid = anlz.get_tag("PQT2")
            except (KeyError, IndexError, StopIteration):
                grid = None
        if grid is None:
            return beats, downbeats
        times_iter = grid.get_times() if hasattr(grid, "get_times") else getattr(grid, "times", [])
        beats_iter = grid.get_beats() if hasattr(grid, "get_beats") else getattr(grid, "beats", [])
        times_list = [float(t) for t in times_iter]
        beats_raw = list(beats_iter)
        beat_nos = [int(beats_raw[i]) if i < len(beats_raw) else 0 for i in range(len(times_list))]
        beats, downbeats = _collapse_beat_seams(times_list, beat_nos)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"beatgrid extract failed: {type(exc).__name__}: {exc}\n")
    return beats, downbeats


def _extract_segments(
    anlz,
    beats: list[float],
    duration_sec: float,
) -> Optional[list[dict[str, Any]]]:
    """Decode the PSSI tag into a list of SegmentRecord-shaped dicts.

    Returns None when the tag is missing or the file has no usable beatgrid
    to convert beat-numbers to seconds. The emitted dicts follow the
    `SegmentRecord` shape defined in packages/shared/src/schema.ts —
    {startSec, endSec, label, source: "rekordbox", rb_kind, fill_sec?}.

    Mood interpretation per the canonical Crate Digger spec: mood=1 is
    "High" (dance/electronic vocabulary with k-flag-resolved variants),
    mood=2 is "Mid", mood=3 is "Low". For High mood, kinds 1/2/5/6 dispatch
    through _HIGH_*_VARIANT tables; for Mid/Low we use the direct
    _PSSI_LABEL_BY_MOOD_KIND lookup.

    PSSI `beat` is 1-indexed; `beats` list from PQTZ is 0-indexed. We use
    `beats[beat - 1]` to convert. Defensive: out-of-range beat numbers
    (rare, but PSSI sometimes references past the last PQTZ entry on
    badly-analyzed files) get clamped to the last beat time, and
    out-of-order entries are filtered.
    """
    if not beats:
        return None
    try:
        pssi = anlz.get_tag("PSSI") if hasattr(anlz, "get_tag") else None
    except (KeyError, IndexError, StopIteration):
        return None
    if pssi is None or not hasattr(pssi, "content"):
        return None

    try:
        content = pssi.content
        mood = int(getattr(content, "mood", 0) or 0)
        if mood not in (1, 2, 3):
            return None
        end_beat = int(getattr(content, "end_beat", 0) or 0)
        entries = list(getattr(content, "entries", None) or [])
        if not entries:
            return None

        last_beat_sec = beats[-1]

        def beat_to_sec(beat_no: int) -> float:
            # PSSI is 1-indexed; PQTZ list is 0-indexed.
            if beat_no <= 0:
                return 0.0
            idx = beat_no - 1
            if idx >= len(beats):
                return last_beat_sec
            return beats[idx]

        def label_for(mood_: int, kind_: int, k1: int, k2: int, k3: int) -> Optional[str]:
            direct = _PSSI_LABEL_BY_MOOD_KIND.get((mood_, kind_), "missing")
            if direct != "missing" and direct is not None:
                return direct
            if mood_ != 1:
                return None
            # High mood — resolve variants by k-flags.
            if kind_ == 1:
                return _HIGH_INTRO_VARIANT.get(k1)
            if kind_ == 2:
                return _HIGH_UP_VARIANT.get((k2, k3))
            if kind_ == 5:
                return _HIGH_CHORUS_VARIANT.get(k1)
            if kind_ == 6:
                return _HIGH_OUTRO_VARIANT.get(k1)
            return None

        # First pass: collect (start_sec, label, raw_kind, fill_sec) per entry,
        # filtering anything we can't decode.
        decoded: list[dict[str, Any]] = []
        for e in entries:
            kind = int(getattr(e, "kind", 0) or 0)
            beat_no = int(getattr(e, "beat", 0) or 0)
            if beat_no <= 0 or kind <= 0:
                continue
            k1 = int(getattr(e, "k1", 0) or 0)
            k2 = int(getattr(e, "k2", 0) or 0)
            k3 = int(getattr(e, "k3", 0) or 0)
            label = label_for(mood, kind, k1, k2, k3)
            if label is None:
                # Unknown / unmapped kind — keep the entry as 'unknown' so
                # the user still sees a boundary at the right time, even if
                # the label is empty.
                label = "unknown"
            start_sec = beat_to_sec(beat_no)
            fill_flag = int(getattr(e, "fill", 0) or 0)
            fill_beat = int(getattr(e, "beat_fill", 0) or 0)
            entry: dict[str, Any] = {
                "_start_sec": start_sec,
                "label": label,
                "rb_kind": kind,
            }
            if fill_flag and fill_beat > 0:
                entry["fill_sec"] = beat_to_sec(fill_beat)
            decoded.append(entry)

        if not decoded:
            return None

        # Sort + dedupe by start time; downstream needs strictly ascending.
        decoded.sort(key=lambda x: x["_start_sec"])
        # Drop entries that overlap the previous (start <= prev start).
        cleaned: list[dict[str, Any]] = []
        for d in decoded:
            if cleaned and d["_start_sec"] <= cleaned[-1]["_start_sec"]:
                continue
            cleaned.append(d)
        if not cleaned:
            return None

        # Second pass: compute end_sec for each segment (next.start, or
        # end_beat→sec for the last). Cap at duration_sec to keep records
        # from running past the audio.
        end_anchor = beat_to_sec(end_beat) if end_beat > 0 else last_beat_sec
        if duration_sec > 0:
            end_anchor = min(end_anchor, duration_sec)

        segments: list[dict[str, Any]] = []
        for i, d in enumerate(cleaned):
            start_sec = d["_start_sec"]
            if i + 1 < len(cleaned):
                end_sec = cleaned[i + 1]["_start_sec"]
            else:
                end_sec = end_anchor
            if duration_sec > 0:
                end_sec = min(end_sec, duration_sec)
            if end_sec <= start_sec:
                # Defensive: zero-length segments confuse the renderer.
                continue
            seg: dict[str, Any] = {
                "startSec": float(start_sec),
                "endSec": float(end_sec),
                "label": d["label"],
                "source": "rekordbox",
                "rbKind": int(d["rb_kind"]),
            }
            if "fill_sec" in d:
                seg["fillSec"] = float(d["fill_sec"])
            segments.append(seg)

        return segments or None
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"PSSI extract failed: {type(exc).__name__}: {exc}\n")
        return None
