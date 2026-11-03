"""Meta Audiobox Aesthetics (facebook/audiobox-aesthetics, CC-BY-4.0).

Not an embedding: the four outputs are the model's 0-10 ratings — Content
Enjoyment, Content Usefulness, Production Complexity, Production Quality — so
the "vector" is [CE, CU, PC, PQ] and the registry marks the model
`similarity=False` (never blended into a nearest-neighbour query). Shipping
it as an adapter keeps the whole engine path (decode, LRU, store, per-section
pooling, coverage, backfill) unchanged; the host reads PQ straight out of the
stored vector (apps/core/src/production/).

Inference matches the official predictor: 16 kHz mono, consecutive 10 s
windows with the last one zero-padded and down-weighted by its real length,
scores un-normalised with the checkpoint's per-axis mean/std. The per-window
scores double as timed vectors so a drop's PQ can be pooled separately.
"""

from __future__ import annotations

import numpy as np

from ..pooling import TimedVectors
from .base import Embedder, StopFn, _never

WINDOW_SECS = 10.0
BATCH = 8
AXES = ("CE", "CU", "PC", "PQ")


class Audiobox(Embedder):
    # The checkpoint is configured fp32 and the model runs its own autocast
    # from that config; nothing to gain from wrapping it in ours.
    precision = "fp32"

    def __init__(self, spec, device):
        super().__init__(spec, device)
        import torch
        from audiobox_aesthetics.model.aes import AesMultiOutput

        model = AesMultiOutput.from_pretrained(spec.repo)
        self.model = model.eval().to(device)
        self.scale = [(float(model.target_transform[a]["mean"]), float(model.target_transform[a]["std"])) for a in AXES]
        self._torch = torch

    def embed_audio(self, wav: np.ndarray, should_stop: StopFn = _never):
        torch = self._torch
        sr = self.spec.sample_rate
        win = int(WINDOW_SECS * sr)
        n = len(wav)
        starts = list(range(0, max(n, 1), win))
        rows: list[np.ndarray] = []
        weights: list[float] = []
        for i in range(0, len(starts), BATCH):
            self.check(should_stop)
            chunk = starts[i:i + BATCH]
            wavs = np.zeros((len(chunk), 1, win), dtype=np.float32)
            masks = np.zeros((len(chunk), 1, win), dtype=bool)
            for j, s in enumerate(chunk):
                seg = wav[s:s + win]
                wavs[j, 0, :len(seg)] = seg
                masks[j, 0, :len(seg)] = True
                weights.append(len(seg) / win)
            with torch.inference_mode():
                preds = self.model({"wav": torch.from_numpy(wavs).to(self.device),
                                    "mask": torch.from_numpy(masks).to(self.device)})
            cols = [preds[a].float().cpu().numpy() * std + mean for a, (mean, std) in zip(AXES, self.scale)]
            rows.append(np.stack(cols, axis=1))
        vecs = np.concatenate(rows).astype(np.float32)
        w = np.asarray(weights, dtype=np.float64)
        track = (vecs * w[:, None]).sum(axis=0) / max(w.sum(), 1e-9)
        st = np.asarray(starts, dtype=np.float64) / sr
        return track.astype(np.float32), TimedVectors(st, np.minimum(st + WINDOW_SECS, n / sr), vecs)
