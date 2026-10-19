"""MERT-v2-FullSong: whole-song self-supervised music representation.

The checkpoint is adapted to 30-360 s inputs (config.context_seconds = 360), so
a typical 6-7 minute DJ track is split into two equal windows and every valid
frame of both is mean-pooled into the track vector — the model card's masked
mean, extended across windows. Attention is SDPA (memory-efficient on CPU), so
a 360 s window (~9k frames) never materialises a full attention matrix.
"""

from __future__ import annotations

import numpy as np

from ..pooling import TimedVectors, bin_frames, equal_windows
from .base import Embedder, StopFn, _never

FRAME_RATE = 25.0  # config.frame_rate


class MertV2(Embedder):
    def __init__(self, spec, device):
        super().__init__(spec, device)
        from transformers import AutoFeatureExtractor, AutoModel

        self.processor = AutoFeatureExtractor.from_pretrained(spec.repo, trust_remote_code=True)
        self.model = AutoModel.from_pretrained(
            spec.repo, trust_remote_code=True, attn_implementation="sdpa",
        ).eval().to(device)

    def embed_audio(self, wav: np.ndarray, should_stop: StopFn = _never):
        import torch

        sr = self.spec.sample_rate
        total = np.zeros(self.spec.dim, dtype=np.float64)
        count = 0
        parts: list[TimedVectors] = []
        for a, b in equal_windows(len(wav), sr, self.spec.window_secs):
            self.check(should_stop)
            inputs = self.processor(wav[a:b], sampling_rate=sr, return_tensors="pt").to(self.device)
            with torch.inference_mode(), self.autocast():
                out = self.model(**inputs)
            frames = out.last_hidden_state[0].float()
            mask = out.feature_attention_mask[0].bool()
            valid = frames[mask].cpu().numpy()
            if valid.shape[0] == 0:
                continue
            total += valid.sum(axis=0, dtype=np.float64)
            count += valid.shape[0]
            parts.append(bin_frames(valid, FRAME_RATE, a / sr))
        if count == 0:
            raise ValueError("MERT-v2 produced no valid frames (audio too short?)")
        return (total / count).astype(np.float32), TimedVectors.concat(parts)
