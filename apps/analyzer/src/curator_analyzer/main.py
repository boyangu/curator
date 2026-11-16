"""Sidecar entry point. Reads line-delimited JSON-RPC requests on stdin,
fans out to a multiprocessing worker pool, writes line-delimited JSON
responses + events to stdout.

Protocol (one JSON object per line, both directions):

    Node → sidecar:
      {"id": 42, "method": "analyze", "params": {
        "trackId": "uuid",
        "path": "...",
        "outPeaksLoPath": "<peaksDir>/lo/<uuid>.cpk",  # 20 Hz strip
        "outPeaksHiPath": "<peaksDir>/hi/<uuid>.cpk"   # 100 Hz detail
      }}
      {"id": 43, "method": "cancel", "params": {"trackId": "uuid"}}
      {"method": "configure", "params": {"workers": 3}}   (no reply)
      {"id": 44, "method": "shutdown"}

    sidecar → Node:
      {"id": 42, "event": "progress", "stage": "beatgrid", "pct": 0.25}
      {"id": 42, "event": "partial",  "fields": {...}}    (reserved; not used yet)
      {"id": 42, "result": {...}}                          (success)
      {"id": 42, "error": {"kind": "...", "message": "..."}}

`id` correlates request ↔ response. The sidecar emits zero or more progress
events with the same id before the final result/error.

Cancellation is best-effort: we only check the cancel set between job
dispatches (not mid-Essentia). For most workloads that's fine — a single
track is ~10-20s, so a cancel propagates within seconds. Mid-stage cancel
would require Essentia signal handling we don't have.

Concurrency: the pool starts at min(cpus - 1, 4) workers (one per core,
minus one for the master + the Node main process) and the host resizes it
with `configure` — the user's Settings → Library "parallel analyses" value.
A resize swaps in a fresh pool for new work; the old one finishes what it
already holds and exits, so running jobs are never killed. The host's queue
caps in-flight requests at the same number, which bounds the total running
across both pools during the hand-over.

CPU budget: there is no hard CPU-percentage governor available to us
(the workers live inside the WSL VM on Windows; cgroups need root), so the
budget is made honest a different way — every BLAS/OpenMP runtime in a worker
is pinned to ONE thread, so N workers ≈ N cores — the worker count IS the
CPU ceiling. The pool also runs niced, which yields to other processes in the
same kernel; under WSL that is only the VM's own processes (Windows schedules
the VM's vCPU threads at normal priority), so on Windows the worker count is
the only real lever. The hello frame reports `cpus` so the host can offer the
user "N of C cores".
"""

from __future__ import annotations

import json
import multiprocessing as mp
import os
import sys
import threading
from concurrent.futures import ProcessPoolExecutor, Future
from typing import Any

# Force UTF-8 stdio — same guard as the rekordbox sidecar (see its main.py):
# a PyInstaller bootloader ignores PYTHONIOENCODING, so a frozen bundle falls
# back to the console codepage. On stdout/stderr that raises
# UnicodeEncodeError on any non-Latin-1 char; on stdin it silently decodes an
# incoming 'path' param as cp1252, so a non-ASCII filename (e.g. 'André
# Moret.flac') resolves to the wrong path and the analysis fails. Harmless
# under WSL/dev (already utf-8), but reconfigure all three for parity.
for _stream, _errors in ((sys.stdin, "strict"), (sys.stdout, "strict"), (sys.stderr, "backslashreplace")):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors=_errors)

from .worker import worker_entrypoint

# Wire-format version of the JSON-RPC protocol documented above. The Node
# host (apps/core/src/analyzer/sidecar.ts) refuses to talk to a sidecar
# announcing a different protocol.
PROTOCOL_VERSION = 1


def _stdout_write(payload: dict[str, Any]) -> None:
    # JSON-RPC frames are one per line; Python's `print` adds the newline.
    # `flush=True` is essential — without it the Node side waits forever
    # for a result that's sitting in Python's stdout buffer.
    line = json.dumps(payload, ensure_ascii=False, default=_jsonable)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _jsonable(obj: Any) -> Any:
    # numpy scalars sneak through MusicExtractor outputs.
    try:
        import numpy as np
        if isinstance(obj, np.generic):
            return obj.item()
    except Exception:
        pass
    raise TypeError(f"not JSON-serializable: {type(obj).__name__}")


def _worker_count() -> int:
    cpus = os.cpu_count() or 2
    return max(1, min(cpus - 1, 4))


# How far below normal the pool is scheduled. 10 is the conventional
# "background batch" value: the analyzer still gets the whole machine when it
# is otherwise idle, but yields immediately to anything interactive.
BACKGROUND_NICE = 10


def _apply_resource_policy() -> None:
    # Spawned workers inherit both the environment and the nice value, so this
    # runs once in the master before the pool exists. The thread pins make a
    # worker cost one core (numpy's OpenBLAS/MKL would otherwise fan each
    # matmul across every core, and N workers × C threads thrashes).
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ.setdefault(var, "1")
    if hasattr(os, "nice"):
        try:
            os.nice(BACKGROUND_NICE)
        except OSError:
            pass


class Sidecar:
    def __init__(self) -> None:
        self._workers = _worker_count()
        self._pool = self._make_pool(self._workers)
        # Track in-flight futures by request id so cancel can find them.
        self._inflight: dict[int, Future] = {}
        self._inflight_lock = threading.Lock()
        # Tracks the user has asked to cancel before we even dispatched.
        # We check on submit and silently skip them.
        self._cancelled_ids: set[str] = set()

    @staticmethod
    def _make_pool(workers: int) -> ProcessPoolExecutor:
        # `spawn` start method everywhere — `fork` is unsafe with Essentia's
        # native threads on Linux and unsupported on Windows.
        return ProcessPoolExecutor(max_workers=workers, mp_context=mp.get_context("spawn"))

    def handle(self, msg: dict[str, Any]) -> None:
        method = msg.get("method")
        req_id = msg.get("id")
        if method == "analyze":
            self._analyze(req_id, msg.get("params") or {})
        elif method == "cancel":
            self._cancel(msg.get("params") or {})
        elif method == "configure":
            self._configure(msg.get("params") or {})
        elif method == "shutdown":
            self.shutdown()
            sys.exit(0)
        else:
            _stdout_write({"id": req_id, "error": {"kind": "internal", "message": f"unknown method {method!r}"}})

    def _analyze(self, req_id: int, params: dict[str, Any]) -> None:
        try:
            req_dict = {
                "track_id": params["trackId"],
                "path": params["path"],
                "out_peaks_lo_path": params["outPeaksLoPath"],
                "out_peaks_hi_path": params["outPeaksHiPath"],
                # Per-call analyzer tuning. Optional on the wire — when absent
                # the worker's dataclass default ({}) applies and behaviour
                # matches the pre-options-introduction codepath. Unknown keys
                # are ignored downstream so wire compat doesn't break when a
                # newer renderer talks to an older sidecar.
                "options": params.get("options") or {},
            }
        except KeyError as exc:
            _stdout_write({"id": req_id, "error": {"kind": "internal", "message": f"missing param {exc}"}})
            return

        if req_dict["track_id"] in self._cancelled_ids:
            self._cancelled_ids.discard(req_dict["track_id"])
            _stdout_write({"id": req_id, "error": {"kind": "cancelled", "message": "cancelled before dispatch"}})
            return

        future = self._pool.submit(worker_entrypoint, req_dict)
        with self._inflight_lock:
            self._inflight[req_id] = future

        def on_done(f: Future) -> None:
            with self._inflight_lock:
                self._inflight.pop(req_id, None)
            try:
                outcome = f.result()
            except Exception as exc:  # noqa: BLE001
                _stdout_write({"id": req_id, "error": {"kind": "internal", "message": str(exc)}})
                return

            # Flush any buffered progress events the worker captured before
            # we write the terminal result/error frame.
            for evt in outcome.get("events", []):
                _stdout_write({
                    "id": req_id,
                    "event": evt["event"],
                    "stage": evt["stage"],
                    "pct": evt.get("pct"),
                })

            if outcome["ok"]:
                _stdout_write({"id": req_id, "result": outcome["result"]})
            else:
                _stdout_write({"id": req_id, "error": outcome["error"]})

        future.add_done_callback(on_done)

    def _configure(self, params: dict[str, Any]) -> None:
        workers = params.get("workers")
        if not isinstance(workers, int) or workers < 1:
            return
        workers = min(workers, os.cpu_count() or workers)
        if workers == self._workers:
            return
        # ProcessPoolExecutor can't resize, so swap. configure and analyze are
        # both handled on the stdin thread, so no submit can race the swap.
        # shutdown(wait=False) without cancel_futures lets the old pool finish
        # its running + already-queued jobs (their done-callbacks still fire),
        # then its workers exit and return their Essentia-loaded memory.
        old = self._pool
        self._pool = self._make_pool(workers)
        self._workers = workers
        try:
            old.shutdown(wait=False)
        except Exception:
            pass

    def _cancel(self, params: dict[str, Any]) -> None:
        track_id = params.get("trackId")
        if not track_id:
            return
        # Mark for skip-on-dispatch. We can't cancel a future that's mid-run
        # (ProcessPoolExecutor.cancel only works pre-start), but a future
        # waiting in the queue will be skipped.
        self._cancelled_ids.add(track_id)
        with self._inflight_lock:
            for fut in self._inflight.values():
                fut.cancel()

    def shutdown(self) -> None:
        try:
            self._pool.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass


def main() -> None:
    # Hello handshake — FIRST stdout frame, before any request is read. The
    # Node host validates name + protocol so a stale bundled binary (or the
    # wrong executable on PATH) is caught at spawn instead of surfacing later
    # as schema-mismatched results. Bump PROTOCOL_VERSION on any breaking
    # change to the frame shapes below; ANALYZER_VERSION tracks the analysis
    # semantics (drives re-analysis), not the wire format.
    from . import ANALYZER_VERSION
    _stdout_write({
        "event": "hello",
        "name": "curator-analyzer",
        "version": ANALYZER_VERSION,
        "protocol": PROTOCOL_VERSION,
        "cpus": os.cpu_count(),
    })
    _apply_resource_policy()
    sidecar = Sidecar()
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as exc:
                _stdout_write({"id": None, "error": {"kind": "internal", "message": f"bad json: {exc}"}})
                continue
            try:
                sidecar.handle(msg)
            except SystemExit:
                raise
            except Exception as exc:  # noqa: BLE001
                _stdout_write({"id": msg.get("id"), "error": {"kind": "internal", "message": str(exc)}})
    finally:
        sidecar.shutdown()


if __name__ == "__main__":
    main()
