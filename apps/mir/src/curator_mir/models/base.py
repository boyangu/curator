"""Adapter contract every model implements.

`embed_audio` takes mono float32 at the spec's native rate and returns the
track vector plus the adapter's finest TimedVectors (frame bins or clips), from
which the engine pools per-segment vectors. Adapters poll `should_stop`
between windows/batches so a cancel lands within one window, not one track.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from contextlib import nullcontext
from typing import Callable

import numpy as np

from ..pooling import TimedVectors
from ..registry import ModelSpec


class Cancelled(Exception):
    pass


StopFn = Callable[[], bool]


def _never() -> bool:
    return False


class Embedder(ABC):
    def __init__(self, spec: ModelSpec, device: str):
        self.spec = spec
        self.device = device

    # Accelerator precision. fp16 is fastest on XMX/tensor cores, but some
    # models overflow in it (MuQ's conformer goes NaN), so adapters can opt
    # into bf16 or plain fp32. CPU always runs exact fp32: CPU half precision
    # is slower, not faster, and fp32 keeps CPU vectors the reference.
    precision = "fp16"

    def autocast(self):
        if self.device == "cpu" or self.precision == "fp32":
            return nullcontext()
        import torch

        dtype = torch.bfloat16 if self.precision == "bf16" else torch.float16
        return torch.autocast(device_type=self.device, dtype=dtype)

    def check(self, should_stop: StopFn) -> None:
        if should_stop():
            raise Cancelled()

    @abstractmethod
    def embed_audio(self, wav: np.ndarray, should_stop: StopFn = _never) -> tuple[np.ndarray, TimedVectors]:
        ...

    def embed_text(self, texts: list[str]) -> np.ndarray:
        raise NotImplementedError(f"{self.spec.key} has no text tower")
