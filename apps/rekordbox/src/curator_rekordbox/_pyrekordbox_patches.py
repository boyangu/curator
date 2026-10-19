"""Monkey-patches against pyrekordbox.

Centralised so the sidecar boot path doesn't have to reason about which
upstream quirks we work around. Every patch is failure-isolated — a single
broken patch logs a line to stderr but does not abort sidecar startup,
because pyrekordbox without any of these patches still does most of what
the importer needs.

Today there is one patch (PQT2.u1 relaxed for Rekordbox 7 compatibility).
Future quirks slot in alongside as sibling `_patch_*` functions dispatched
from `apply_pyrekordbox_patches`.
"""

from __future__ import annotations

import sys


def apply_pyrekordbox_patches() -> None:
    """Apply every monkey-patch against pyrekordbox before any ANLZ parses.

    Called once from main.py at module load, before the RPC loop accepts
    any frames. Per-patch failures are caught so a future upstream refactor
    that renames internals doesn't take the whole sidecar down — the
    affected tracks just fall back to the analyzer pipeline (same outcome
    as the unpatched code path today).
    """
    _patch_pqt2_u1_const()


def _patch_pqt2_u1_const() -> None:
    """Relax pyrekordbox's PQT2 `u1` `Const(0x01000002)` to a plain `Int32ub`
    so Rekordbox 7 EXT files parse.

    pyrekordbox's binary parser asserts u1 == 0x01000002 at offset 20 inside
    the PQT2 (Extended Beat Grid) tag. RB7 writes 0x02000002 there, which
    trips construct's ConstError and aborts the whole-file parse — every
    other tag in that ANLZ (basic beatgrid in DAT, cues, peaks) gets
    dropped along with it because pyrekordbox's `AnlzTag.Switch` does
    not isolate per-tag failures.

    Loosening the field to Int32ub recovers every other tag; we just no
    longer validate that one reserved byte. RB6 files (u1 == 0x01000002)
    are still parsed correctly — the relaxed parser accepts any 4-byte
    value at that offset.

    The patch:
      • probes by field NAME (not fixed index) so a future pyrekordbox
        release that reorders PQT2 without renaming u1 keeps working;
      • mutates `structs.PQT2.subcons` in place — the `AnlzTag.Switch`
        already holds the same PQT2 object reference, so no further
        rebinding is needed (verified with `is` comparison at design
        time);
      • is fully guarded — any failure logs one stderr line and returns
        without raising, leaving sidecar startup unaffected.
    """
    try:
        from pyrekordbox.anlz import structs
        from construct import Int32ub
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(
            f"pyrekordbox patch skipped (import failed): {type(exc).__name__}: {exc}\n"
        )
        return

    pqt2 = getattr(structs, "PQT2", None)
    if pqt2 is None or not hasattr(pqt2, "subcons"):
        sys.stderr.write(
            "pyrekordbox patch skipped: PQT2 / subcons not present on this version\n"
        )
        return

    for i, sc in enumerate(pqt2.subcons):
        if getattr(sc, "name", None) == "u1":
            try:
                # Slash syntax wraps the field in a Renamed(name="u1") —
                # matches the original subcon shape so any downstream code
                # that reads `.name` continues to work.
                pqt2.subcons[i] = "u1" / Int32ub
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(
                    f"pyrekordbox PQT2.u1 patch failed: {type(exc).__name__}: {exc}\n"
                )
                return
            sys.stderr.write("pyrekordbox PQT2.u1 Const relaxed (RB7 compatibility)\n")
            return

    sys.stderr.write(
        "pyrekordbox patch skipped: PQT2.u1 field not found on this version\n"
    )
