"""rb 6 cue color palette — single source of truth for cue color codes.

Curator's high-level layers (renderer, core service, IPC) store cue colors
as OPAQUE id strings ("cti:N" or null). Only this module knows what those
ids mean in rb's storage. The writer uses `_parse_cti` (writer.py) to map
ids → DjmdCue.ColorTableIndex; the reader maps the reverse via
`_resolve_cue_color` (reader.py).

The picker rb 6 surfaces in its cue-color popover is a 4×4 grid of 16
swatches. We mirror that exactly so a swatch picked in Curator paints
the same color in rb. CTI values were captured empirically: 8 cues
coloured cell 1..8 on one track, 8 more on another track, then the
DjmdCue.ColorTableIndex values read back from master.db.

CTI sequence walks the hue wheel: 49 (magenta-pink) → 56 → 60 → 62 →
wrap → 1 (blue) → 5 → ... → 45 (hot pink). Cell 10 (lime, CTI=22)
sits between cells 9 (green, CTI=18) and 11 (yellow-green, CTI=26);
the user's library uses CTI=22 heavily (726 cues) which corroborates
its place in the picker.

Hex values are eyeballed from a screenshot of rb's picker (no Pioneer
RGB spec exists). They're close enough that the Curator picker visually
matches rb's — refine later if exact parity becomes important.
"""

from __future__ import annotations

from typing import TypedDict


class PaletteEntry(TypedDict):
    id: str        # opaque token Curator stores in cue.color (e.g. "cti:22")
    hex: str       # renderable color for swatches + waveform markers
    label: str     # user-facing label in the picker


# (cti, hex, label) tuples in cell order — the 4×4 grid rendered left-to-
# right, top-to-bottom. The renderer paints in the same order so position
# matches rb's picker.
_PALETTE: list[tuple[int, str, str]] = [
    # Row 1 — magentas / purples
    (49, '#e045d6', 'Magenta'),
    (56, '#a347e5', 'Purple'),
    (60, '#c085f2', 'Lavender'),
    (62, '#5878f0', 'Indigo'),
    # Row 2 — blues / cyans / teal
    (1,  '#3690ec', 'Blue'),
    (5,  '#34b5e0', 'Light Blue'),
    (9,  '#2bc8d9', 'Cyan'),
    (14, '#2a988c', 'Teal'),
    # Row 3 — greens
    (18, '#33b860', 'Green'),
    (22, '#7dc430', 'Lime'),
    (26, '#a4c432', 'Yellow Green'),
    (30, '#b5ac32', 'Olive'),
    # Row 4 — warms
    (32, '#b59332', 'Mustard'),
    (38, '#e26832', 'Orange'),
    (42, '#e22832', 'Red'),
    (45, '#e22885', 'Hot Pink'),
]


# Static palette surfaced to the renderer's cue-pad context menu.
RB6_CUE_PALETTE: list[PaletteEntry] = [
    {"id": f"cti:{cti}", "hex": hex_, "label": label}
    for cti, hex_, label in _PALETTE
]


# Reverse map cti → hex for the reader's renderer-side cueColor lookup and
# any future "what's the canonical color for this CTI" helper.
_HEX_BY_CTI: dict[int, str] = {cti: hex_ for cti, hex_, _ in _PALETTE}


def list_cue_palette() -> list[PaletteEntry]:
    """Return the 16-entry rb cue palette. Used by the JSON-RPC
    `list_cue_palette` method in main.py — the only path Curator's
    high-level layers see."""
    return list(RB6_CUE_PALETTE)


def cti_hex(idx: int) -> str | None:
    """Resolve a CTI index to its hex string, or None for unknown CTIs
    (cues coloured outside the curated 16-cell picker — rare in practice
    since rb users only ever pick from those 16)."""
    return _HEX_BY_CTI.get(idx)
