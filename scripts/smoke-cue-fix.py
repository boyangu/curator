"""Verify cue scan emits the right number of rows per track with proper
slot/kind/color values."""
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "rekordbox", "src"))

from curator_rekordbox import reader  # noqa: E402
from pyrekordbox import Rekordbox6Database  # noqa: E402

DB_PATH = os.path.join(os.environ.get("APPDATA", ""), "Pioneer", "rekordbox", "master.db")
db = Rekordbox6Database(DB_PATH)

events = []
def emit(name, payload):
    if name == "cues":
        events.append(payload)

reader.scan(
    db,
    watermarks={"DjmdContent": 0, "DjmdCue": 0, "DjmdPlaylist": 0, "DjmdMyTag": 0},
    scopes=["analysis"],
    peaks_dir=None,
    emit=emit,
    is_cancelled=lambda: False,
)

print(f"\ntotal cue deltas: {len(events)}")
by_track = Counter(e["rb_content_id"] for e in events)
print(f"unique tracks with cues: {len(by_track)}")
print(f"max cues per track: {max(by_track.values())}")
print(f"mean cues per track: {sum(by_track.values()) / len(by_track):.1f}")

# Show the track with most cues.
top_cid, top_n = by_track.most_common(1)[0]
print(f"\ntop track {top_cid}: {top_n} cues")
for e in [x for x in events if x["rb_content_id"] == top_cid]:
    print(f"  slot={e['slot']:>3}  kind={e['kind']:>6}  pos={e['position_sec']:>7.2f}s  color={e['color']!r:>10}  name={e['name']!r}")

# Color distribution.
colors = Counter(e["color"] for e in events)
print(f"\ncolor distribution: {dict(colors)}")

# Kind distribution.
kinds = Counter(e["kind"] for e in events)
print(f"kind distribution: {dict(kinds)}")
