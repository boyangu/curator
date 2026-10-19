"""Decode any library file to mono float32, then resample per model.

Decoding happens once per analyze call at the file's native rate; each model
gets its own resample (MERT-v2 and MuQ want 24 kHz, CLAP 48 kHz). libsndfile
(via soundfile) opens FLAC/WAV/AIFF/OGG/MP3, which is nearly all of a DJ
library; PyAV covers AAC/M4A/ALAC, which libsndfile cannot open.

Files are only ever opened for reading — the engine never writes next to the
user's music (see CLAUDE.md: library files are live production data).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


class DecodeError(Exception):
    pass


@dataclass
class Audio:
    samples: np.ndarray  # mono float32 at `sample_rate`
    sample_rate: int

    @property
    def duration(self) -> float:
        return len(self.samples) / float(self.sample_rate)


def decode(path: str) -> Audio:
    try:
        audio = _decode_soundfile(path)
    except Exception as sf_exc:  # noqa: BLE001 — any libsndfile failure falls through to PyAV
        try:
            audio = _decode_av(path)
        except Exception as av_exc:  # noqa: BLE001
            raise DecodeError(f"cannot decode: soundfile: {sf_exc}; av: {av_exc}") from av_exc
    if audio.samples.size == 0:
        raise DecodeError("file decoded to zero samples")
    return audio


def _decode_soundfile(path: str) -> Audio:
    import soundfile as sf

    data, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
    return Audio(np.ascontiguousarray(mono, dtype=np.float32), int(sr))


def _decode_av(path: str) -> Audio:
    import av

    with av.open(path) as container:
        stream = next(s for s in container.streams if s.type == "audio")
        sr = int(stream.codec_context.sample_rate or 44100)
        # The resampler does the downmix; 'flt' packed mono gives (1, n) arrays.
        resampler = av.AudioResampler(format="flt", layout="mono", rate=sr)
        chunks: list[np.ndarray] = []
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):  # flush the resampler's tail
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        raise DecodeError("no audio frames")
    return Audio(np.concatenate(chunks).astype(np.float32, copy=False), sr)


def resample(audio: Audio, rate: int) -> np.ndarray:
    if audio.sample_rate == rate:
        return audio.samples
    import soxr

    out = soxr.resample(audio.samples, audio.sample_rate, rate, quality="HQ")
    return np.ascontiguousarray(out, dtype=np.float32)
