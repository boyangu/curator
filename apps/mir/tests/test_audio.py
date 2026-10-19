import numpy as np
import pytest
import soundfile as sf

from curator_mir.audio import DecodeError, decode, resample


def tone(path, sr=44100, secs=3.0, channels=2, freq=440.0):
    t = np.arange(int(sr * secs)) / sr
    x = 0.5 * np.sin(2 * np.pi * freq * t)
    sf.write(path, np.stack([x] * channels, axis=1) if channels > 1 else x, sr)


def test_decode_downmixes_and_keeps_native_rate(tmp_path):
    p = tmp_path / "tone.flac"
    tone(p)
    a = decode(str(p))
    assert a.sample_rate == 44100
    assert a.samples.ndim == 1 and a.samples.dtype == np.float32
    assert a.duration == pytest.approx(3.0, abs=1e-3)


def test_resample_to_model_rate(tmp_path):
    p = tmp_path / "tone.wav"
    tone(p, channels=1)
    a = decode(str(p))
    y = resample(a, 24000)
    assert len(y) == pytest.approx(3.0 * 24000, abs=2)
    assert resample(a, 44100) is a.samples


def test_garbage_file_is_a_decode_error(tmp_path):
    p = tmp_path / "not-audio.flac"
    p.write_bytes(b"definitely not audio" * 50)
    with pytest.raises(DecodeError):
        decode(str(p))


def test_missing_file_is_a_decode_error(tmp_path):
    with pytest.raises(DecodeError):
        decode(str(tmp_path / "nope.flac"))
