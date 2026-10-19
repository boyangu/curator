"""Smoke check: drive the analyzer sidecar on a single track and assert that
the EBUR128 LRA + dissonance + density fields are populated and finite.

Usage:
    python scripts/smoke-ebur128.py "C:/path/to/sample.flac"

The script speaks the sidecar's JSON-RPC protocol directly so it doesn't
require the Node side to be running. Set CURATOR_ANALYZER_PYTHON to override
the python binary used to launch the sidecar (default: WSL venv on Windows,
.venv/bin/python elsewhere).
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: smoke-ebur128.py <audio-file>\n")
        return 2
    audio_path = argv[1]
    if not Path(audio_path).is_file():
        sys.stderr.write(f"not a file: {audio_path}\n")
        return 2

    repo_root = Path(__file__).resolve().parents[1]
    analyzer_dir = repo_root / "apps" / "analyzer"

    # Pick a python binary. On Windows we use the WSL venv via `wsl bash -c`,
    # mirroring how the desktop main spawns the sidecar (getAnalyzerSpec in
    # apps/desktop/src/main/index.ts). On other platforms use the venv.
    override = os.environ.get("CURATOR_ANALYZER_PYTHON")
    use_wsl = sys.platform == "win32" and override is None

    tmp = tempfile.mkdtemp(prefix="curator-smoke-")
    out_lo = str(Path(tmp) / "out-lo.cpk")
    out_hi = str(Path(tmp) / "out-hi.cpk")

    def to_wsl(p: str) -> str:
        # C:/x/y → /mnt/c/x/y
        if len(p) >= 2 and p[1] == ":":
            return f"/mnt/{p[0].lower()}/{p[2:].replace(chr(92), '/').lstrip('/')}"
        return p

    if use_wsl:
        cmd = [
            "wsl", "bash", "-c",
            f"cd {to_wsl(str(analyzer_dir))} && source .venv-wsl/bin/activate && python -m curator_analyzer.main",
        ]
        audio_for_sidecar = to_wsl(audio_path)
        out_lo_for_sidecar = to_wsl(out_lo)
        out_hi_for_sidecar = to_wsl(out_hi)
    else:
        py = override or str(analyzer_dir / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python"))
        cmd = [py, "-m", "curator_analyzer.main"]
        audio_for_sidecar = audio_path
        out_lo_for_sidecar = out_lo
        out_hi_for_sidecar = out_hi

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=sys.stderr,
        text=True,
        bufsize=1,  # line-buffered
        cwd=str(analyzer_dir),
    )
    assert proc.stdin and proc.stdout

    req = {
        "id": 1,
        "method": "analyze",
        "params": {
            "trackId": "smoke-test",
            "path": audio_for_sidecar,
            "outPeaksLoPath": out_lo_for_sidecar,
            "outPeaksHiPath": out_hi_for_sidecar,
        },
    }
    proc.stdin.write(json.dumps(req) + "\n")
    proc.stdin.flush()

    result_frame: dict | None = None
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        frame = json.loads(line)
        if "result" in frame:
            result_frame = frame["result"]
            break
        if "error" in frame:
            sys.stderr.write(f"sidecar error: {frame['error']}\n")
            proc.stdin.write(json.dumps({"method": "shutdown"}) + "\n")
            proc.stdin.flush()
            return 1
        # Otherwise it's a progress/partial event — print one-liner and keep reading.
        print(f"  [{frame.get('event','?')}] {frame.get('stage','?')} {frame.get('pct')}")

    proc.stdin.write(json.dumps({"method": "shutdown"}) + "\n")
    proc.stdin.flush()
    proc.wait(timeout=5)

    if result_frame is None:
        sys.stderr.write("no result frame received\n")
        return 1

    print("\nResult keys:", sorted(result_frame.keys()))
    print(f"  analyzer_version    = {result_frame.get('analyzer_version')}")
    print(f"  loudness_range_lu   = {result_frame.get('loudness_range_lu')}")
    print(f"  dissonance          = {result_frame.get('dissonance')}")
    print(f"  density             = {result_frame.get('density')}")
    segments = result_frame.get("segments") or []
    print(f"  segments            = {len(segments)} ({', '.join(s.get('label','?') for s in segments)})")
    print(f"  intro_length_sec    = {result_frame.get('intro_length_sec')}")
    print(f"  first_drop_sec      = {result_frame.get('first_drop_sec')}")
    print(f"  drop_count          = {result_frame.get('drop_count')}")
    print(f"  breakdown_count     = {result_frame.get('breakdown_count')}")

    ok = True
    if result_frame.get("analyzer_version") != "2.2.0":
        sys.stderr.write(f"FAIL: analyzer_version expected '2.2.0', got {result_frame.get('analyzer_version')!r}\n")
        ok = False
    for field in ("loudness_range_lu", "dissonance", "density"):
        v = result_frame.get(field)
        if v is None or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
            sys.stderr.write(f"FAIL: {field} is {v!r} (expected finite number)\n")
            ok = False
    # Stage 6 — segments. Be lenient: a very short or atonal sample may
    # legitimately produce only intro+outro with no inner labels. What we DO
    # require: the array is well-shaped (intro first, outro last, every record
    # has the expected keys) and the count fields are integers (not None).
    if not isinstance(segments, list) or len(segments) < 2:
        sys.stderr.write(f"FAIL: segments expected list of >=2 records, got {segments!r}\n")
        ok = False
    else:
        if segments[0].get("label") != "intro":
            sys.stderr.write(f"FAIL: first segment label expected 'intro', got {segments[0].get('label')!r}\n")
            ok = False
        if segments[-1].get("label") != "outro":
            sys.stderr.write(f"FAIL: last segment label expected 'outro', got {segments[-1].get('label')!r}\n")
            ok = False
        for s in segments:
            for k in ("startSec", "endSec", "label", "confidence", "energy"):
                if k not in s:
                    sys.stderr.write(f"FAIL: segment missing key {k!r}: {s!r}\n")
                    ok = False
                    break
    for field in ("drop_count", "breakdown_count"):
        v = result_frame.get(field)
        if not isinstance(v, int):
            sys.stderr.write(f"FAIL: {field} expected int, got {v!r}\n")
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
