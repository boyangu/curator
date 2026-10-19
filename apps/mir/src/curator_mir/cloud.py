"""Client side of the cloud executor (Modal GPU, deployed from apps/mir/modal_app.py).

Audio leaves the machine only here, only when the user picked the cloud
executor, and only as a model-rate mono FLAC (a 6-minute track at 24 kHz is
~7 MB vs ~40 MB for the source) — vectors come back, nothing is retained.
Credentials are Modal's own (~/.modal.toml from `modal token new`); Curator
never stores the secret, so the agent's read-only DB access can't see it.
"""

from __future__ import annotations

import io
import os
from typing import Any

import numpy as np

from .audio import decode, resample
from .registry import get_spec

APP_NAME = "curator-mir"
CLASS_NAME = "MirGpu"


def upload_rate(models: list[str]) -> int:
    return max(get_spec(m).sample_rate for m in models)


def encode_for_upload(path: str, sample_rate: int) -> bytes:
    import soundfile as sf

    wav = resample(decode(path), sample_rate)
    buf = io.BytesIO()
    sf.write(buf, np.clip(wav, -1.0, 1.0), sample_rate, format="FLAC", subtype="PCM_16")
    return buf.getvalue()


def configured() -> bool:
    if os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET"):
        return True
    return os.path.exists(os.path.join(os.path.expanduser("~"), ".modal.toml"))


def analyze_batch(items: list[dict[str, Any]], models: list[str]) -> list[dict[str, Any]]:
    """items: [{trackId, path, segments?}] -> per-item {trackId, result | error}."""
    import modal

    rate = upload_rate(models)
    payload, failed = [], []
    for item in items:
        try:
            payload.append({"trackId": item["trackId"], "segments": item.get("segments"),
                            "audio": encode_for_upload(item["path"], rate)})
        except Exception as exc:  # noqa: BLE001 — local decode failure stays local
            failed.append({"trackId": item["trackId"], "error": {"kind": "decode", "message": str(exc)}})
    if not payload:
        return failed
    gpu = modal.Cls.from_name(APP_NAME, CLASS_NAME)()
    return failed + list(gpu.embed_batch.remote(payload, models))
