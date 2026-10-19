"""LAION CLAP (laion/larger_clap_general, Apache-2.0).

The feature extractor random-crops inputs longer than 10 s ("rand_trunc"), so
the track is fed as consecutive exact 10 s windows — deterministic vectors —
and the window embeddings are L2-normalised then averaged. A trailing scrap
under 2 s is dropped rather than repeat-padded into a stutter the model never
heard in training.
"""

from __future__ import annotations

import numpy as np

from ..pooling import TimedVectors, l2n
from .base import Embedder, StopFn, _never

WINDOW_SECS = 10.0
MIN_TAIL_SECS = 2.0
BATCH = 8


class Clap(Embedder):
    def __init__(self, spec, device):
        super().__init__(spec, device)
        from transformers import ClapModel, ClapProcessor

        self.processor = ClapProcessor.from_pretrained(spec.repo)
        self.model = ClapModel.from_pretrained(spec.repo).eval().to(device)

    def _inputs(self, **kw):
        enc = self.processor(return_tensors="pt", **kw)
        return {k: v.to(self.device) for k, v in enc.items()}

    def embed_audio(self, wav: np.ndarray, should_stop: StopFn = _never):
        import torch

        sr = self.spec.sample_rate
        win = int(WINDOW_SECS * sr)
        n = len(wav)
        starts = list(range(0, n, win))
        if len(starts) > 1 and n - starts[-1] < MIN_TAIL_SECS * sr:
            starts.pop()
        feats = []
        for i in range(0, len(starts), BATCH):
            self.check(should_stop)
            batch = [wav[s:s + win] for s in starts[i:i + BATCH]]
            with torch.inference_mode(), self.autocast():
                emb = self.model.get_audio_features(**self._inputs(audios=batch, sampling_rate=sr))
            feats.append(l2n(emb.float().cpu().numpy()))
        vecs = np.concatenate(feats).astype(np.float32)
        st = np.asarray(starts, dtype=np.float64) / sr
        return vecs.mean(axis=0), TimedVectors(st, np.minimum(st + WINDOW_SECS, n / sr), vecs)

    def embed_text(self, texts: list[str]) -> np.ndarray:
        import torch

        with torch.inference_mode():
            emb = self.model.get_text_features(**self._inputs(text=list(texts), padding=True))
        return l2n(emb.float().cpu().numpy()).astype(np.float32)
