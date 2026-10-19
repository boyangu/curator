# curator-analyzer

Python sidecar for the Curator desktop app. Runs offline music analysis
(Essentia + biquad-filtered peaks) and reports results back to the Node
core process over stdio JSON-RPC.

## Running locally (dev)

```bash
cd apps/analyzer
uv venv
uv pip install -e .
python -m curator_analyzer.main < /dev/null   # waits for requests on stdin
```

Smoke test with a single request:

```bash
echo '{"id":1,"method":"analyze","params":{"trackId":"x","path":"/abs/song.flac","outPeaksPath":"/tmp/x.cpk"}}' \
  | python -m curator_analyzer.main
```

You should see a sequence of `progress` events followed by a final `result`
frame (one JSON object per line).

## Bundling for production

We bundle ffmpeg + the Python runtime + the analyzer code into a single
`--onedir` PyInstaller artifact that ships inside the Electron resources.
See `scripts/build-sidecar.sh` (TODO).

## Protocol

Documented at the top of `src/curator_analyzer/main.py`. Mirror in the Node
sidecar manager at `apps/core/src/analyzer/sidecar.ts`.

## Versioning

`ANALYZER_VERSION` in `__init__.py`. Bump when the analysis output schema
changes; the Node side stores this in `track_analysis.analyzer_version` and
surfaces a "re-analyze available" indicator when the bundled sidecar is
newer than the row's persisted version.
