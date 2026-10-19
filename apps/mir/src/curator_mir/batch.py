"""Batch analysis over uploaded audio — the function the cloud GPU runs.

Kept free of any Modal import so the exact code path is testable locally:
modal_app.py only wraps `run_batch` in a GPU container. Each item carries its
audio as compact FLAC bytes (see cloud.encode_for_upload); failures are
reported per item so one bad file never sinks a 32-track batch.
"""

from __future__ import annotations

import os
import tempfile
from typing import Any

from .models import Cancelled


def run_batch(engine, items: list[dict[str, Any]], models: list[str]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="curator-mir-") as tmp:
        for i, item in enumerate(items):
            path = os.path.join(tmp, f"{i}.flac")
            with open(path, "wb") as f:
                f.write(item["audio"])
            try:
                res = engine.analyze(path, models, segments=item.get("segments") or None)
                results.append({"trackId": item["trackId"], "result": res})
            except Cancelled:
                results.append({"trackId": item["trackId"], "error": {"kind": "cancelled", "message": "cancelled"}})
            except Exception as exc:  # noqa: BLE001 — per-item failure, batch continues
                from .main import classify
                results.append({"trackId": item["trackId"],
                                "error": {"kind": classify(exc), "message": f"{type(exc).__name__}: {exc}"}})
            finally:
                os.remove(path)
    return results
