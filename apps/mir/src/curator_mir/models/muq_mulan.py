"""MuQ-MuLan: contrastive music-text embeddings (audio and text share a space).

Track vector = mean of the L2-normalised latents of consecutive 10 s clips,
clipped exactly like MuQMuLan._get_all_clips (the last partial clip is filled
by wrapping to the track start), so our track vectors equal the official
`mulan(wavs=...)` output. Clips are batched here instead of looped one by one;
the per-clip latents double as 10 s timed vectors for segment pooling.
"""

from __future__ import annotations

import numpy as np

from ..pooling import TimedVectors
from .base import Embedder, StopFn, _never

CLIP_BATCH = 8


class MuqMulan(Embedder):
    # MuQ's conformer overflows to NaN under fp16 autocast; bf16 keeps the fp16
    # speed on Intel XMX with cosine 0.99995 vs the CPU fp32 reference.
    precision = "bf16"

    def __init__(self, spec, device):
        super().__init__(spec, device)
        from muq import MuQMuLan

        self.model = MuQMuLan.from_pretrained(spec.repo).eval().to(device)
        self.clip_secs = float(self.model.clip_secs)

    def _clips(self, wav: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        sr = self.spec.sample_rate
        delta = int(sr * self.clip_secs)
        n = len(wav)
        if n < delta:
            # Official clipping under-fills clips shorter than one window; tile instead.
            reps = -(-delta // n)
            return np.tile(wav, reps)[None, :delta], np.array([0.0]), np.array([n / sr])
        clips, starts = [], []
        pos = 0
        while pos + delta <= n:
            clips.append(wav[pos:pos + delta])
            starts.append(pos)
            pos += delta
        if pos < n:
            clips.append(np.concatenate([wav[pos:], wav[:delta - (n - pos)]]))
            starts.append(pos)
        st = np.asarray(starts, dtype=np.float64) / sr
        return np.stack(clips), st, np.minimum(st + self.clip_secs, n / sr)

    def embed_audio(self, wav: np.ndarray, should_stop: StopFn = _never):
        import torch

        clips, starts, ends = self._clips(wav)
        latents = []
        for i in range(0, len(clips), CLIP_BATCH):
            self.check(should_stop)
            batch = torch.from_numpy(np.ascontiguousarray(clips[i:i + CLIP_BATCH])).to(self.device)
            with torch.inference_mode(), self.autocast():
                lat = self.model.mulan_module.get_audio_latents(batch)
            latents.append(lat.float().cpu().numpy())
        vecs = np.concatenate(latents).astype(np.float32)
        return vecs.mean(axis=0), TimedVectors(starts, ends, vecs)

    def embed_text(self, texts: list[str]) -> np.ndarray:
        import torch

        with torch.inference_mode():
            lat = self.model(texts=list(texts))
        return lat.float().cpu().numpy().astype(np.float32)
