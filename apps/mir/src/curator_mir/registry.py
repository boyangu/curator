"""Model registry: the one place that names every model the engine can run.

`model_id` ("<key>@<version>") is what the host stores next to each vector.
Bump `version` whenever an adapter change would move the vectors (windowing,
pooling, layer choice, weights revision) — old and new vectors must never be
compared, and the host re-embeds anything not at the current model_id.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelSpec:
    key: str             # stable short name used on the wire and in settings
    version: int         # adapter version (see module docstring)
    repo: str            # Hugging Face repo holding the weights
    sample_rate: int     # native mono input rate in Hz
    dim: int             # output vector dimension
    text: bool           # has a text tower: text prompts land in the same space
    license: str         # weights licence (all fine for a personal library)
    window_secs: float   # longest audio span fed to the model in one pass
    summary: str

    @property
    def model_id(self) -> str:
        return f"{self.key}@{self.version}"


MODELS: dict[str, ModelSpec] = {s.key: s for s in [
    ModelSpec(
        key="mert-v2-fullsong", version=1, repo="m-a-p/MERT-v2-FullSong",
        sample_rate=24000, dim=1024, text=False, license="CC-BY-NC-4.0", window_secs=360.0,
        summary="Self-supervised music encoder adapted to whole songs (30-360 s). "
                "Last layer, masked mean over 25 Hz frames; tracks over 360 s are split "
                "into equal windows and all frames pooled together.",
    ),
    ModelSpec(
        key="muq-mulan-large", version=1, repo="OpenMuQ/MuQ-MuLan-large",
        sample_rate=24000, dim=512, text=True, license="CC-BY-NC-4.0", window_secs=10.0,
        summary="MuQ audio tower + XLM-R text tower in one contrastive music-text space. "
                "Mean of L2-normalised 10 s clip latents, clipped exactly like the official API.",
    ),
    ModelSpec(
        key="clap", version=1, repo="laion/larger_clap_general",
        sample_rate=48000, dim=512, text=True, license="Apache-2.0", window_secs=10.0,
        summary="LAION CLAP (HTSAT), trained on music + speech + AudioSet + LAION-630k; strongest "
                "published alignment with human timbre words. Mean of L2-normalised 10 s window "
                "embeddings. (laion/larger_clap_music is broken under transformers: its text and "
                "audio towers don't align — Phase 0 finding.)",
    ),
]}

# Weight-free model for protocol/integration tests only (models/stub.py).
import os as _os  # noqa: E402

if _os.environ.get("CURATOR_MIR_STUB") == "1":
    MODELS["stub"] = ModelSpec(
        key="stub", version=1, repo="", sample_rate=16000, dim=8, text=True, license="n/a",
        window_secs=30.0, summary="Deterministic signal statistics; tests only.",
    )

# Single-model default for the CLI (the app blends its enabled models): MuQ-MuLan
# was the best single model on the user's tags and is text-capable
# (research/mir/FINDINGS.md).
DEFAULT_MODEL = "muq-mulan-large"


class UnknownModel(KeyError):
    pass


def get_spec(key: str) -> ModelSpec:
    try:
        return MODELS[key]
    except KeyError:
        raise UnknownModel(f"unknown model {key!r}; known: {sorted(MODELS)}") from None
