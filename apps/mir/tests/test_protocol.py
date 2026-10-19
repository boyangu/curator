"""Drive the real sidecar process over stdio with the weight-free stub model."""

import json
import os
import queue
import subprocess
import sys
import threading

import numpy as np
import pytest
import soundfile as sf

from curator_mir.pooling import from_b64

TIMEOUT = 60


@pytest.fixture()
def sidecar():
    env = {**os.environ, "CURATOR_MIR_STUB": "1", "CURATOR_MIR_DEVICE": "cpu", "CURATOR_MIR_THREADS": "1",
           "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.Popen([sys.executable, "-m", "curator_mir.main"], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
                            text=True, encoding="utf-8")
    frames: queue.Queue = queue.Queue()
    threading.Thread(target=lambda: [frames.put(json.loads(line)) for line in proc.stdout], daemon=True).start()

    class Client:
        def send(self, msg):
            proc.stdin.write((msg if isinstance(msg, str) else json.dumps(msg)) + "\n")
            proc.stdin.flush()

        def next(self):
            return frames.get(timeout=TIMEOUT)

        def until(self, rid):
            seen = []
            while True:
                f = self.next()
                seen.append(f)
                if f.get("id") == rid and ("result" in f or "error" in f):
                    return f, seen

    yield proc, Client()
    if proc.poll() is None:
        proc.kill()
    proc.wait(timeout=TIMEOUT)
    for pipe in (proc.stdin, proc.stdout):
        pipe.close()


@pytest.fixture()
def wav(tmp_path):
    p = tmp_path / "André Moret - töne.wav"  # non-ASCII path must round-trip
    t = np.arange(16000 * 4) / 16000
    sf.write(p, 0.4 * np.sin(2 * np.pi * 330 * t), 16000)
    return str(p)


def test_hello_capabilities_and_shutdown(sidecar):
    proc, c = sidecar
    hello = c.next()
    assert hello == {"event": "hello", "name": "curator-mir", "version": hello["version"], "protocol": 1}
    c.send({"id": 1, "method": "capabilities"})
    caps, _ = c.until(1)
    assert caps["result"]["device"] == "cpu"
    assert "stub" in {m["key"] for m in caps["result"]["models"]}
    c.send({"id": 2, "method": "shutdown"})
    assert proc.wait(timeout=TIMEOUT) == 0


def test_analyze_streams_progress_then_vectors(sidecar, wav):
    _, c = sidecar
    c.next()
    c.send({"id": 7, "method": "analyze", "params": {"trackId": "t1", "path": wav, "models": ["stub"],
            "segments": [{"startSec": 0, "endSec": 2, "label": "intro"}, {"startSec": 2, "endSec": 4}]}})
    res, seen = c.until(7)
    assert any(f.get("event") == "progress" for f in seen[:-1])
    r = res["result"]
    assert r["trackId"] == "t1" and r["duration"] == pytest.approx(4.0)
    e = r["embeddings"]["stub@1"]
    assert e["dim"] == 8 and from_b64(e["vec"]).shape == (8,)
    assert [s["index"] for s in e["segments"]] == [0, 1] and e["segments"][0]["label"] == "intro"


def test_errors_are_classified(sidecar, wav, tmp_path):
    _, c = sidecar
    c.next()
    c.send({"id": 1, "method": "analyze", "params": {"trackId": "a", "path": str(tmp_path / "missing.flac"), "models": ["stub"]}})
    assert c.until(1)[0]["error"]["kind"] == "decode"
    c.send({"id": 2, "method": "analyze", "params": {"trackId": "b", "path": wav, "models": ["no-such-model"]}})
    assert c.until(2)[0]["error"]["kind"] == "unsupported"
    c.send({"id": 3, "method": "text_embed", "params": {"model": "mert-v2-fullsong", "texts": ["x"]}})
    assert c.until(3)[0]["error"]["kind"] == "unsupported"
    c.send({"id": 4, "method": "frobnicate"})
    assert c.until(4)[0]["error"]["kind"] == "unsupported"
    c.send("{not json")
    assert c.next()["error"]["kind"] == "internal"


def test_cancel_drops_queued_job_but_not_the_next_request(sidecar, wav):
    _, c = sidecar
    c.next()
    c.send({"id": 1, "method": "cancel", "params": {"trackId": "x"}})
    c.send({"id": 2, "method": "analyze", "params": {"trackId": "x", "path": wav, "models": ["stub"]}})
    assert c.until(2)[0]["error"]["kind"] == "cancelled"
    c.send({"id": 3, "method": "analyze", "params": {"trackId": "x", "path": wav, "models": ["stub"]}})
    assert "result" in c.until(3)[0]


def test_text_embed(sidecar):
    _, c = sidecar
    c.next()
    c.send({"id": 1, "method": "text_embed", "params": {"model": "stub", "texts": ["warm pad", "acid bassline"]}})
    r = c.until(1)[0]["result"]
    assert r["modelId"] == "stub@1" and len(r["vecs"]) == 2
