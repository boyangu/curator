"""Weight-free test model (registered only when CURATOR_MIR_STUB=1).

Lets protocol and host-integration tests drive the real engine end to end —
decode, resample, windowing, pooling, framing — without multi-GB downloads.
Vectors are cheap signal statistics per 1 s bin, so they're deterministic and
differ between different test tones.
"""

from __future__ import annotations

import numpy as np

from ..pooling import TimedVectors
from .base import Embedder, StopFn, _never


class Stub(Embedder):
    def embed_audio(self, wav: np.ndarray, should_stop: StopFn = _never):
        sr = self.spec.sample_rate
        n_bins = max(1, len(wav) // sr)
        rows = []
        for i in range(n_bins):
            self.check(should_stop)
            x = wav[i * sr:(i + 1) * sr].astype(np.float64)
            spec = np.abs(np.fft.rfft(x, n=sr))
            freqs = np.fft.rfftfreq(sr, 1 / sr)
            centroid = float((spec * freqs).sum() / max(spec.sum(), 1e-12)) / (sr / 2)
            rows.append([float(np.sqrt(np.mean(x ** 2))), centroid, float(np.mean(np.abs(np.diff(np.sign(x))))) / 2,
                         float(np.max(np.abs(x))), 1.0, 0.0, 0.0, 0.0])
        vecs = np.asarray(rows, dtype=np.float32)
        starts = np.arange(n_bins, dtype=np.float64)
        return vecs.mean(axis=0), TimedVectors(starts, np.minimum(starts + 1, len(wav) / sr), vecs)

    def embed_text(self, texts):
        return np.stack([np.full(8, (hash(t) % 97) / 97.0, dtype=np.float32) for t in texts])
