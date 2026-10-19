"""Sidecar entry: line-delimited JSON-RPC over stdio (same framing as the
analyzer/rekordbox sidecars; host = apps/core/src/mir/sidecar.ts).

    Node -> sidecar
      {"id": 1, "method": "capabilities"}
      {"id": 2, "method": "warmup",  "params": {"models": ["mert-v2-fullsong"]}}
      {"id": 3, "method": "analyze", "params": {"trackId": "uuid", "path": "C:/...flac",
                                                "models": ["mert-v2-fullsong"],
                                                "segments": [{"startSec": 0, "endSec": 32, "label": "intro"}]}}
      {"id": 4, "method": "text_embed", "params": {"model": "muq-mulan-large", "texts": ["rolling acid bassline"]}}
      {"id": 5, "method": "cancel", "params": {"trackId": "uuid"}}
      {"id": 6, "method": "shutdown"}

    sidecar -> Node
      {"event": "hello", "name": "curator-mir", "version": "...", "protocol": 1}   (first frame)
      {"id": 3, "event": "progress", "stage": "embed:mert-v2-fullsong", "pct": 0.0}
      {"id": 3, "result": {...}}  |  {"id": 3, "error": {"kind": "...", "message": "..."}}

Error kinds: decode | model | unsupported | cancelled | oom | internal.

One worker thread runs jobs strictly in order: models are multi-GB and torch
already uses every allotted core (or the GPU), so two concurrent jobs would
only thrash. `capabilities` and `cancel` are answered on the reader thread so
they never wait behind a long embed. Cancel is cooperative: a queued job is
dropped, a running one stops at its next window/batch boundary.
"""

from __future__ import annotations

import io
import json
import os
import queue
import sys
import threading
import traceback
from typing import Any

# UTF-8 stdio (non-ASCII paths like 'André Moret.flac' must round-trip), then
# reserve the real stdout for protocol frames: muq, transformers and tqdm can
# print, and one stray line on stdout corrupts the stream the host parses.
for _stream, _errors in ((sys.stdin, "strict"), (sys.stdout, "strict"), (sys.stderr, "backslashreplace")):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors=_errors)
_PROTO_OUT = sys.stdout
sys.stdout = sys.stderr
_write_lock = threading.Lock()


def _private_stdin() -> io.TextIOBase:
    """Read requests from a private duplicate of the stdin pipe, and point the
    process's standard input at NUL.

    Windows deadlock this avoids: while the reader blocks in a synchronous
    ReadFile on the stdin pipe, the C runtime start-up of any DLL loaded on
    another thread (numpy, torch, tokenizers... first imported by the worker)
    calls GetFileType on the std input handle, and Windows serialises
    synchronous I/O per file object — so the DLL load waits for the next
    request line, which the host only sends after the reply that the worker
    can never produce. With fd 0 / STD_INPUT_HANDLE on NUL, DLL start-up
    queries NUL and returns at once; only this module reads the real pipe.
    """
    if sys.platform != "win32":
        return sys.stdin
    import ctypes
    import msvcrt

    fd = os.dup(0)
    nul = os.open(os.devnull, os.O_RDONLY)
    os.dup2(nul, 0)
    os.close(nul)
    ctypes.windll.kernel32.SetStdHandle(-10, msvcrt.get_osfhandle(0))  # STD_INPUT_HANDLE
    sys.stdin = open(os.devnull, encoding="utf-8")
    return open(fd, "r", encoding="utf-8", errors="strict", closefd=True)

from . import MIR_VERSION, PROTOCOL_VERSION  # noqa: E402


def send(payload: dict[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False)
    with _write_lock:
        _PROTO_OUT.write(line + "\n")
        _PROTO_OUT.flush()


def log(msg: str) -> None:
    print(f"[mir] {msg}", file=sys.stderr, flush=True)


def classify(exc: BaseException) -> str:
    from .audio import DecodeError
    from .engine import ModelLoadError
    from .models import Cancelled
    from .registry import UnknownModel

    if isinstance(exc, Cancelled):
        return "cancelled"
    if isinstance(exc, DecodeError):
        return "decode"
    if isinstance(exc, (UnknownModel, NotImplementedError)):
        return "unsupported"
    if isinstance(exc, ModelLoadError):
        return "model"
    if isinstance(exc, MemoryError) or "out of memory" in str(exc).lower():
        return "oom"
    return "internal"


class Sidecar:
    def __init__(self) -> None:
        self._jobs: queue.Queue = queue.Queue()
        self._cancelled: set[str] = set()
        self._lock = threading.Lock()
        self._engine = None
        self._worker = threading.Thread(target=self._loop, name="mir-worker", daemon=True)
        self._worker.start()

    def engine(self):
        with self._lock:
            if self._engine is None:
                from .engine import Engine

                threads = os.environ.get("CURATOR_MIR_THREADS")
                self._engine = Engine(
                    device=os.environ.get("CURATOR_MIR_DEVICE", "auto"),
                    threads=int(threads) if threads and threads.isdigit() else None,
                    # Two resident models by default: the app blends MERT-v2 +
                    # MuQ-MuLan per track, and with one slot every track would
                    # reload both sets of weights (13-35 s each).
                    max_loaded=int(os.environ.get("CURATOR_MIR_MAX_LOADED", "2")),
                )
                log(f"engine ready on {self._engine.device}")
            return self._engine

    def handle(self, msg: dict[str, Any]) -> bool:
        """Returns False when the sidecar should exit."""
        method, rid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
        if method == "capabilities":
            self._reply(rid, self._capabilities)
        elif method == "cancel":
            track_id = params.get("trackId")
            if track_id:
                with self._lock:
                    self._cancelled.add(track_id)
        elif method in ("analyze", "analyze_batch", "warmup", "text_embed"):
            self._jobs.put((rid, method, params))
        elif method == "shutdown":
            return False
        else:
            send({"id": rid, "error": {"kind": "unsupported", "message": f"unknown method {method!r}"}})
        return True

    def _reply(self, rid, fn) -> None:
        try:
            send({"id": rid, "result": fn()})
        except Exception as exc:  # noqa: BLE001 — every failure becomes an error frame
            kind = classify(exc)
            if kind == "internal":
                log(traceback.format_exc())
            send({"id": rid, "error": {"kind": kind, "message": str(exc) or type(exc).__name__}})

    def _loop(self) -> None:
        while True:
            job = self._jobs.get()
            if job is None:
                return
            rid, method, params = job
            if method == "analyze":
                self._reply(rid, lambda: self._analyze(rid, params))
            elif method == "analyze_batch":
                self._reply(rid, lambda: self._analyze_batch(params))
            elif method == "warmup":
                self._reply(rid, lambda: {"loaded": [self.engine().get(m).spec.model_id for m in params.get("models", [])]})
            else:
                self._reply(rid, lambda: self.engine().text_embed(params["model"], list(params["texts"])))

    def _analyze(self, rid, params: dict[str, Any]) -> dict[str, Any]:
        from .models import Cancelled

        track_id = params["trackId"]
        with self._lock:
            if track_id in self._cancelled:
                self._cancelled.discard(track_id)
                raise Cancelled()
        stop = lambda: track_id in self._cancelled  # noqa: E731 — read under the GIL, set by the reader thread
        try:
            result = self.engine().analyze(
                params["path"], list(params["models"]), segments=params.get("segments") or None,
                progress=lambda stage, pct: send({"id": rid, "event": "progress", "stage": stage, "pct": pct}),
                should_stop=stop,
            )
        finally:
            # A cancel aimed at this run must not also reject the track's next
            # request (the analyzer sidecar's stale-cancel bug).
            with self._lock:
                self._cancelled.discard(track_id)
        return {"trackId": track_id, **result}

    def _capabilities(self) -> dict[str, Any]:
        from . import cloud

        return {"version": MIR_VERSION, "cloudConfigured": cloud.configured(), **self.engine().capabilities()}

    def _analyze_batch(self, params: dict[str, Any]) -> dict[str, Any]:
        """Cloud lane: one GPU call for many tracks. Per-item results/errors."""
        from . import cloud

        if params.get("executor") != "cloud":
            raise NotImplementedError("analyze_batch only runs on the cloud executor; use analyze locally")
        items = [{"trackId": it["trackId"], "path": it["path"], "segments": it.get("segments")}
                 for it in params["items"]]
        return {"items": cloud.analyze_batch(items, list(params["models"]))}

    def stop(self) -> None:
        self._jobs.put(None)


def main() -> None:
    # Hello first, before torch is imported (several seconds): the host only
    # waits 15 s for it before warning.
    send({"event": "hello", "name": "curator-mir", "version": MIR_VERSION, "protocol": PROTOCOL_VERSION})
    requests = _private_stdin()
    sidecar = Sidecar()
    try:
        for line in requests:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as exc:
                send({"id": None, "error": {"kind": "internal", "message": f"bad json: {exc}"}})
                continue
            if not sidecar.handle(msg):
                break
    finally:
        sidecar.stop()


if __name__ == "__main__":
    main()
