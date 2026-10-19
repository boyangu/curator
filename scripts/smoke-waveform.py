"""Confirm extract_bands_from_anlz now produces real per-band peaks."""
import os
import sys
import logging

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "rekordbox", "src"))
logging.getLogger("pyrekordbox.anlz.file").setLevel(logging.ERROR)

from curator_rekordbox import reader  # noqa: E402
from curator_rekordbox.waveform import extract_bands_from_anlz, write_cpk_pair_from_rekordbox  # noqa: E402
from pyrekordbox import Rekordbox6Database  # noqa: E402
import numpy as np  # noqa: E402

DB_PATH = os.path.join(os.environ.get("APPDATA", ""), "Pioneer", "rekordbox", "master.db")
db = Rekordbox6Database(DB_PATH)

ok = 0
for i, row in enumerate(db.get_content()):
    if i >= 5:
        break
    anlz = reader._load_anlz_for_row(db, row)
    if anlz is None:
        continue
    pack = extract_bands_from_anlz(anlz)
    if not pack:
        print(f"{row.ID} {row.Title!r}: NO BANDS")
        continue
    (low, mid, high), rate = pack
    print(f"{row.ID} {row.Title!r}:")
    print(f"  rate={rate}Hz  samples={len(low)}")
    print(f"  low : min={low.min()} max={low.max()} mean={low.mean():.1f}  head={list(low[:6])}")
    print(f"  mid : min={mid.min()} max={mid.max()} mean={mid.mean():.1f}  head={list(mid[:6])}")
    print(f"  high: min={high.min()} max={high.max()} mean={high.mean():.1f}  head={list(high[:6])}")
    ok += 1

print(f"\nResult: {ok}/5 tracks decoded successfully")
