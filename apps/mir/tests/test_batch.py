"""The cloud GPU path, minus Modal: encode -> run_batch (what the container runs)."""

import os

import numpy as np
import pytest
import soundfile as sf

os.environ["CURATOR_MIR_STUB"] = "1"

from curator_mir import cloud  # noqa: E402
from curator_mir.batch import run_batch  # noqa: E402
from curator_mir.engine import Engine  # noqa: E402
from curator_mir.pooling import from_b64  # noqa: E402


@pytest.fixture(scope="module")
def engine():
    return Engine(device="cpu", threads=1)


def tone(path, freq):
    t = np.arange(44100 * 3) / 44100
    sf.write(path, 0.4 * np.sin(2 * np.pi * freq * t), 44100)


def test_upload_is_model_rate_mono_flac(tmp_path):
    p = tmp_path / "a.wav"
    tone(p, 440)
    data = cloud.encode_for_upload(str(p), 16000)
    assert data[:4] == b"fLaC"
    assert len(data) < os.path.getsize(p)


def test_run_batch_matches_local_and_isolates_failures(tmp_path, engine):
    a, b = tmp_path / "a.wav", tmp_path / "b.wav"
    tone(a, 220)
    tone(b, 880)
    items = [{"trackId": "a", "audio": cloud.encode_for_upload(str(a), 16000)},
             {"trackId": "bad", "audio": b"not audio"},
             {"trackId": "b", "audio": cloud.encode_for_upload(str(b), 16000)}]
    out = run_batch(engine, items, ["stub"])
    assert [r["trackId"] for r in out] == ["a", "bad", "b"]
    assert out[1]["error"]["kind"] == "decode"
    remote = from_b64(out[0]["result"]["embeddings"]["stub@1"]["vec"])
    local = from_b64(engine.analyze(str(a), ["stub"])["embeddings"]["stub@1"]["vec"])
    # 16-bit FLAC at the model rate vs float decode of the original: same vector to ~1e-3.
    np.testing.assert_allclose(remote, local, atol=2e-3)
