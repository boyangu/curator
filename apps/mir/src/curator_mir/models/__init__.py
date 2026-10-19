"""Model adapters. Imports are lazy so `capabilities` and the hello frame never
pay for torch/transformers start-up."""

from __future__ import annotations

from ..registry import ModelSpec
from .base import Cancelled, Embedder

__all__ = ["Cancelled", "Embedder", "load_embedder"]


def load_embedder(spec: ModelSpec, device: str) -> Embedder:
    if spec.key == "mert-v2-fullsong":
        from .mert_v2 import MertV2
        return MertV2(spec, device)
    if spec.key == "muq-mulan-large":
        from .muq_mulan import MuqMulan
        return MuqMulan(spec, device)
    if spec.key == "clap":
        from .clap import Clap
        return Clap(spec, device)
    if spec.key == "stub":
        from .stub import Stub
        return Stub(spec, device)
    raise KeyError(spec.key)
