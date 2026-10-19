"""Confirm the post-fix reader.py functions actually produce data.

Walks a handful of real tracks from the user's master.db through the
updated _load_anlz_for_row + _extract_beatgrid + extract_bands_from_anlz,
plus runs the cue scan and counts emissions. Run after editing reader.py.
"""
import os
import sys

# Make the sidecar package importable.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "rekordbox", "src"))

from curator_rekordbox import reader  # noqa: E402
from curator_rekordbox.waveform import extract_bands_from_anlz  # noqa: E402

from pyrekordbox import Rekordbox6Database  # noqa: E402

DB_PATH = os.path.join(os.environ.get("APPDATA", ""), "Pioneer", "rekordbox", "master.db")
db = Rekordbox6Database(DB_PATH)

contents = list(db.get_content())
print(f"total tracks: {len(contents)}")

# Test ANLZ + beatgrid on first 5 with ANLZ files.
print("\n── ANLZ + beatgrid smoke ────────────────")
ok_anlz = 0
ok_beats = 0
ok_bands = 0
for row in contents[:50]:
    anlz = reader._load_anlz_for_row(db, row)
    if anlz is None:
        continue
    ok_anlz += 1
    beats, downbeats = reader._extract_beatgrid(anlz)
    if beats:
        ok_beats += 1
    bands = extract_bands_from_anlz(anlz)
    if bands:
        ok_bands += 1
    if ok_anlz <= 1:
        print(f"  {row.ID} {row.Title!r}")
        # Dump the actual tag attrs so we can see real keys.
        tag_descs = []
        for t in (getattr(anlz, 'tags', []) or [])[:30]:
            tname = type(t).__name__
            attrs = {a: getattr(t, a, None) for a in ('type', 'name', 'tag_type', 'fourcc') if hasattr(t, a)}
            tag_descs.append((tname, attrs))
        for td in tag_descs:
            print(f"    {td}")
        print(f"    beats={len(beats)}  downbeats={len(downbeats)}  bands_ok={bool(bands)}")

print(f"\n  out of first 50: anlz_loaded={ok_anlz}  beatgrids={ok_beats}  bands={ok_bands}")

# Test cue pass — count actual emissions.
print("\n── cue + waveform scan smoke ────────────")
cue_events = []
wf_events = []
def emit(name, payload):
    if name == "cues":
        cue_events.append(payload)
    elif name == "waveform":
        wf_events.append(payload)

import tempfile
with tempfile.TemporaryDirectory() as tmp:
    os.makedirs(os.path.join(tmp, "lo"))
    os.makedirs(os.path.join(tmp, "hi"))
    reader.scan(
        db,
        watermarks={"DjmdContent": 0, "DjmdCue": 0, "DjmdPlaylist": 0, "DjmdMyTag": 0},
        scopes=["analysis"],
        peaks_dir=tmp,
        emit=emit,
        is_cancelled=lambda: False,
    )
print(f"  cue deltas emitted: {len(cue_events)}")
print(f"  waveform deltas emitted: {len(wf_events)}")
beat_count = sum(1 for w in wf_events if w['beatgrid_sec'])
peak_count = sum(1 for w in wf_events if w['peaks_lo_path'])
print(f"  with beatgrid: {beat_count}    with peaks: {peak_count}")
if wf_events:
    sample = wf_events[0]
    print(f"  sample: rb_id={sample['rb_content_id']}  beats={len(sample['beatgrid_sec'])}  downbeats={len(sample['downbeats_sec'])}  peaks={'yes' if sample['peaks_lo_path'] else 'no'}")
