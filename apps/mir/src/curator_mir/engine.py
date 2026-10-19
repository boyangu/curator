"""The engine: decode once, run the requested models, pool, serialise.

One Engine per process. Models load lazily and stay resident in a small LRU —
each is 0.8-4 GB in fp32, so keeping every model loaded is a RAM decision the
caller makes via `max_loaded`, not a default. Torch threads are capped below
the core count so a background backfill never starves the desktop app.
"""

from __future__ import annotations

import os
import time
from collections import OrderedDict
from typing import Any, Callable

from .audio import decode, resample
from .models import Cancelled, Embedder, load_embedder
from .models.base import _never
from .pooling import pool_segments, to_b64
from .registry import MODELS, get_spec

ProgressFn = Callable[[str, float], None]


class ModelLoadError(RuntimeError):
    """Weights missing/corrupt, offline first run, or an adapter import failure."""


def default_threads() -> int:
    env = os.environ.get("CURATOR_MIR_THREADS")
    if env and env.isdigit():
        return max(1, int(env))
    return max(1, (os.cpu_count() or 2) - 2)


def pick_device(pref: str = "auto") -> str:
    import torch

    if pref in ("auto", "xpu") and hasattr(torch, "xpu") and torch.xpu.is_available():
        return "xpu"
    if pref in ("auto", "cuda") and torch.cuda.is_available():
        return "cuda"
    return "cpu"


class Engine:
    def __init__(self, device: str = "auto", threads: int | None = None, max_loaded: int = 1):
        import torch

        torch.set_num_threads(threads or default_threads())
        self.device = pick_device(device)
        self.max_loaded = max(1, max_loaded)
        self._loaded: OrderedDict[str, Embedder] = OrderedDict()

    def capabilities(self) -> dict[str, Any]:
        import torch

        return {
            "device": self.device,
            "torch": torch.__version__,
            "threads": torch.get_num_threads(),
            "xpu": bool(hasattr(torch, "xpu") and torch.xpu.is_available()),
            "cuda": bool(torch.cuda.is_available()),
            "loaded": list(self._loaded),
            "models": [
                {"key": s.key, "modelId": s.model_id, "dim": s.dim, "sampleRate": s.sample_rate,
                 "text": s.text, "license": s.license, "repo": s.repo, "summary": s.summary}
                for s in MODELS.values()
            ],
        }

    def get(self, key: str) -> Embedder:
        if key in self._loaded:
            self._loaded.move_to_end(key)
            return self._loaded[key]
        while len(self._loaded) >= self.max_loaded:
            _, old = self._loaded.popitem(last=False)
            del old
            self._release()
        spec = get_spec(key)
        try:
            emb = load_embedder(spec, self.device)
        except Exception as exc:  # noqa: BLE001 — surfaced to the host as kind 'model'
            raise ModelLoadError(f"{spec.model_id}: {type(exc).__name__}: {exc}") from exc
        self._loaded[key] = emb
        return emb

    def _release(self) -> None:
        import gc

        gc.collect()
        if self.device == "xpu":
            import torch
            torch.xpu.empty_cache()

    def analyze(self, path: str, models: list[str], segments: list[dict] | None = None,
                progress: ProgressFn | None = None, should_stop=_never) -> dict[str, Any]:
        report = progress or (lambda stage, pct: None)
        t0 = time.perf_counter()
        report("decode", 0.0)
        audio = decode(path)
        out: dict[str, Any] = {
            "duration": audio.duration,
            "sourceSampleRate": audio.sample_rate,
            "decodeMs": round((time.perf_counter() - t0) * 1000),
            "embeddings": {},
        }
        for i, key in enumerate(models):
            if should_stop():
                raise Cancelled()
            spec = get_spec(key)
            report(f"embed:{key}", i / max(1, len(models)))
            t1 = time.perf_counter()
            emb = self.get(key)
            loaded = time.perf_counter()
            track, timed = emb.embed_audio(resample(audio, spec.sample_rate), should_stop)
            segs = []
            if segments:
                for idx, (seg, vec) in enumerate(zip(segments, pool_segments(timed, segments))):
                    if vec is not None:
                        segs.append({"index": idx, "startSec": float(seg["startSec"]), "endSec": float(seg["endSec"]),
                                     "label": seg.get("label"), "vec": to_b64(vec)})
            out["embeddings"][spec.model_id] = {
                "model": spec.key, "version": spec.version, "dim": int(track.shape[0]),
                "vec": to_b64(track), "segments": segs,
                "loadMs": round((loaded - t1) * 1000), "ms": round((time.perf_counter() - loaded) * 1000),
            }
        report("done", 1.0)
        return out

    def text_embed(self, key: str, texts: list[str]) -> dict[str, Any]:
        spec = get_spec(key)
        if not spec.text:
            raise NotImplementedError(f"{key} has no text tower")
        vecs = self.get(key).embed_text(texts)
        return {"modelId": spec.model_id, "dim": int(vecs.shape[1]), "vecs": [to_b64(v) for v in vecs]}
