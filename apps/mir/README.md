# curator-mir — AI audio analysis engine

Foundation-model audio analysis for the playable (local-file) library. v1 computes
**track-level "sounds like" embeddings** (plus per-segment vectors pooled over the
existing Curator/rekordbox segments) and powers similarity in the app:
right-click → **Find Similar**, `similar:` / `sounds:"…"` queries, and the
`get_similar_tracks` / `search_tracks_by_sound` agent + MCP tools.
Design and research: `research/mir/FINDINGS.md`.

Stems, structure, transcription and zero-shot facets are the planned v2/v3 stages;
the wire protocol (`stages`), the store (`mir_vector` keyed by
track × model × scope × segment × stem) and the registry are already shaped for them.

## Models

| key | weights | dim | text search | licence |
|---|---|---|---|---|
| `mert-v2-fullsong` | m-a-p/MERT-v2-FullSong (632M, whole-song context ≤360 s) | 1024 | no | CC-BY-NC-4.0 |
| `muq-mulan-large` | OpenMuQ/MuQ-MuLan-large (MuQ + XLM-R, music–text space) | 512 | yes | CC-BY-NC-4.0 |
| `clap` | laion/larger_clap_general (HTSAT; music + general audio) | 512 | yes | Apache-2.0 |

Stored vectors are keyed by `model_id = <key>@<adapter version>` (`registry.py`). Bump the
version whenever an adapter change would move the vectors; the app then re-embeds by itself.

Measured on a Core Ultra 7 258V (one 6:22 track):

| | CPU (6 threads, fp32) | Intel Arc 140V (XPU) |
|---|---|---|
| MERT-v2-FullSong | 70 s | 2.4 s (fp16, cosine 0.99995 vs CPU) |
| MuQ-MuLan | 53 s | 2.9 s (bf16 — fp16 overflows to NaN) |
| CLAP | 8 s | 2.4 s (fp16) |

## Dev setup (Windows-native, no WSL)

```
cd apps/mir
uv sync --extra cpu --extra dev                                   # .venv     (CPU torch)
UV_PROJECT_ENVIRONMENT=.venv-xpu uv sync --extra xpu --extra dev  # .venv-xpu (Intel Arc / Core Ultra iGPU)
```

`pnpm dev` prefers `.venv-xpu`, else `.venv` (`getMirSpec()` in apps/desktop/src/main/index.ts).
`CURATOR_DISABLE_MIR=1` disables the engine. Weights download into the Hugging Face cache on
first use (~10 GB for all three models). Env knobs: `CURATOR_MIR_DEVICE` (auto|cpu|xpu|cuda),
`CURATOR_MIR_THREADS` (default cores − 2), `CURATOR_MIR_MAX_LOADED` (resident models, default 2 — the app blends two).

## Protocol

Line-delimited JSON-RPC over stdio, documented at the top of `src/curator_mir/main.py`
(host: `apps/core/src/mir/sidecar.ts`). Methods: `capabilities`, `warmup`, `analyze`,
`analyze_batch` (cloud), `text_embed`, `cancel`, `shutdown`. One worker thread runs jobs in
order; `capabilities`/`cancel` answer immediately.

Windows gotcha the server works around: a DLL loaded on a worker thread calls `GetFileType`
on stdin during C-runtime start-up, which blocks behind the reader's pending pipe read
(Windows serialises synchronous I/O per file object). The server reads requests from a private
duplicate of the pipe and points fd 0 at NUL (`_private_stdin`).

## Storage (core side)

`mir.db` beside `curator.db` (the fifth sibling DB): vectors as Float32 LE BLOBs, per-run
provenance in `mir_run`. No job table — pending work is derived (playable tracks × enabled
models − done − failed twice). Delete/merge hooks keep it in step with the library; an orphan
sweep runs 15 s after boot. Settings live in `app_setting` key `mir.settings`.

## Packaged builds

`pnpm build:sidecars` stages this project (source + `uv.lock`) and a `uv` binary into
`resources/mir`. Settings → Similarity → **Set up AI engine** runs
`uv sync --frozen --no-install-project --extra xpu|cpu` into `%APPDATA%/Curator/mir/venv`
with a uv-managed CPython (xpu on Intel Core Ultra machines). Weights go to `mir/hf`.

## Cloud executor (optional)

```
uv sync --extra cpu --extra cloud
uv run modal token new                 # stores credentials in ~/.modal.toml (never in Curator)
uv run modal deploy modal_app.py       # GPU class MirGpu.embed_batch, weights cached in a Volume
```

Then pick "Cloud GPU (Modal)" in Settings. Audio is uploaded as model-rate mono FLAC; only
vectors come back. Not yet exercised against a live Modal deployment.

## CLI and tests

```
uv run curator-mir capabilities
uv run curator-mir embed a.flac b.flac --model mert-v2-fullsong --out vectors.npz
uv run curator-mir text "warm rolling bassline" --model muq-mulan-large
uv run pytest      # stub model (CURATOR_MIR_STUB=1): protocol, decode, pooling, batch path
```

The engine only ever reads audio files; it never writes next to the user's music.
