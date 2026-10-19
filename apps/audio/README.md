# curator-audio

Native local-audio sidecar for the Curator desktop app. Symphonia for decode + cpal for output, communicating with the Node main process over stdio JSON-RPC.

Replaces the prior Chromium Web Audio backend (`decodeAudioData` + `AudioBufferSourceNode`). On a Windows / DDJ-FLX10 dev box we measure:

| Metric | Chromium baseline | curator-audio |
|---|---|---|
| Cold-click → first audio (6-min FLAC) | 1700-2300 ms | **~20-40 ms** |
| Intra-track seek audible | ~42 ms | ~10-15 ms |
| Output buffer floor (cpal interactive) | 41 ms (Chromium) | 5-15 ms (WASAPI) |
| Decode rate (FLAC) | ~3× realtime | ~50-150× realtime |

See [`[[curator-audio-engine]]`](../../.claude/projects/.../memory/curator-audio-engine.md) in agent memory for the architectural decision; see [plans/glistening-gliding-honey.md](../../../.claude/plans/glistening-gliding-honey.md) for the team commit doc.

## What's inside

```
src/
├── main.rs       — stdin JSON-RPC loop, dispatch, stdout writer thread
├── protocol.rs   — serde types for request / response / event wire format
├── decode.rs     — symphonia wrapper: probe(path) + decode_packet_into_cells()
├── engine.rs     — cpal output stream + ProgressiveBuffer + decoder worker
├── convert.rs    — `curator-audio convert`: one-shot FLAC→CDJ-safe WAV job (stdin job, stdout JSON lines)
└── wav_writer.rs — plain-PCM RIFF writer (never EXTENSIBLE) + LIST/INFO + header self-check
```

### Architectural shape

Three mechanisms keep cold-click and seek both fast:

1. **Progressive playback.** `load()` returns after the symphonia probe (~5-15 ms) — *not* after the full decode. A worker thread fills a pre-allocated buffer chunk-by-chunk while audio plays. The audio callback gates output on a `decoded_frames` atomic high-water mark; if the decoder ever falls behind the playhead (rare — happens on a far-forward seek), the callback emits silence without advancing the cursor until the decoder catches up.

2. **Stream keepalive.** The cpal output stream is built once per sample rate at engine startup (or on a sample-rate change — rare in a DJ library that's usually all 44.1k). Subsequent loads atomically swap the buffer pointer in `state.current_buffer` via `arc-swap`. No WASAPI device re-init per click — that was previously the ~250 ms tax per track-switch.

3. **Pause/play is a flag, not a stream operation.** The cpal stream runs continuously. The audio callback observes `state.playing: AtomicBool` and emits silence while it's false (without advancing the cursor). Removes pause/play roundtrips to the audio driver.

### Concurrency

- **Control thread** (the JSON-RPC dispatch loop in `main.rs`) issues `load` / `play` / `pause` / `seek` / `set_volume` / `position` / `stop` calls behind a `parking_lot::Mutex<Engine>`.
- **Decoder thread** (spawned per `load`) iterates packets via `symphonia` and writes f32 samples into the shared `ProgressiveBuffer`. Polls a `cancelled: AtomicBool` between packets so a superseding `load` cleanly retires it.
- **Audio thread** (cpal callback) reads `cursor`, `playing`, `volume` atomics + a snapshot of `current_buffer`. Lock-free, no allocation, no logging — must stay glitch-free.
- **Reporter thread** ticks at 20 Hz emitting `state_changed` events while playing, and `Ended` exactly once per natural end-of-buffer.

The decoder/audio thread coordination is the only subtle piece. The decoder writes positions `[decoded_frames .. new_decoded)` then `Release`-stores the new high-water mark; the audio callback `Acquire`-loads the mark and reads positions `[..decoded_frames)`. The ranges never overlap concurrently. Samples are stored in `Box<[UnsafeCell<f32>]>` with manual `unsafe impl Send + Sync` justified by that invariant.

## Running locally (dev)

```bash
cd apps/audio
cargo build --release
```

The Electron main process picks up `target/release/curator-audio[.exe]` automatically via the `getAudioSpec()` resolver in `apps/desktop/src/main/index.ts`. If no pre-built binary exists, it falls back to `cargo run --release` (slower first launch — build with `cargo build --release` for iteration speed).

`CURATOR_DISABLE_AUDIO=1` makes the host skip the sidecar entirely; the renderer's local backend then rejects with "sidecar unavailable" — useful for isolating regressions.

`CURATOR_AUDIO_DEBUG=1` runs the debug profile (slower decode, more useful for stepping through). Default is release.

### Smoke test (no Electron required)

```bash
echo '{"id":1,"method":"load","params":{"path":"C:/path/to/song.flac"}}' \
  | ./target/release/curator-audio.exe
```

You should see one `{"id":1,"result":{"duration":...,"sample_rate":44100,"channels":2}}` line on stdout, plus tracing lines on stderr:

```
INFO curator_audio: curator-audio sidecar starting (build=progressive-r3)
INFO curator_audio::engine: probed file probe_ms=8.2 n_frames=... sample_rate=44100 channels=2
INFO curator_audio::engine: load: rebuild decision need_rebuild=true ...
INFO curator_audio::engine: selected output device device=Ok("Speakers (...)")
INFO curator_audio::engine: built cpal stream build_ms=264.X sample_rate=44100
INFO curator_audio::engine: load() returning load_ms=15.X
INFO curator_audio::engine: decoder thread done decode_ms=380.X frames=...
```

The `load() returning` time is the renderer-perceived load latency. The `decoder thread done` line lands hundreds of ms later — that's the actual decode running in the background, off the critical path.

End-to-end sequence (load → play → seek → quit):

```bash
( echo '{"id":1,"method":"load","params":{"path":"C:/path/to/song.flac"}}'
  sleep 0.5
  echo '{"id":2,"method":"play"}'
  sleep 2
  echo '{"id":3,"method":"seek","params":{"seconds":30}}'
  sleep 2
  echo '{"id":4,"method":"shutdown"}'
) | ./target/release/curator-audio.exe
```

## Wire protocol

Line-delimited JSON, one frame per line, both directions. Same shape as the Python sidecars (`apps/analyzer`, `apps/rekordbox`). Node-side host is `apps/desktop/src/main/audio-sidecar.ts`.

### Requests (Node → sidecar)

```json
{"id": 1, "method": "load",       "params": {"path": "C:/abs/foo.flac"}}
{"id": 2, "method": "play"}
{"id": 3, "method": "pause"}
{"id": 4, "method": "seek",       "params": {"seconds": 12.5}}
{"id": 5, "method": "set_volume", "params": {"volume": 0.7}}
{"id": 6, "method": "position"}
{"id": 7, "method": "stop"}
{"id": 8, "method": "shutdown"}
```

### Responses (sidecar → Node, matching `id`)

```json
{"id": 1, "result": {"duration": 331.7, "sample_rate": 44100, "channels": 2}}
{"id": 1, "error":  {"kind": "load",    "message": "codec params missing n_frames — ..."}}
```

Error `kind` values: `decode`, `load`, `play`, `seek`, `internal`, `io`.

### Events (sidecar → Node, no `id`)

```json
{"event": "state_changed", "position": 12.5, "playing": true}
{"event": "ended"}
```

- `state_changed` fires at ~20 Hz while playing (the reporter thread cadence). The renderer's player module uses it to drive reactive `state.position` updates — no renderer-side polling needed.
- `ended` fires exactly once per natural end-of-buffer. The Node host forwards it; the renderer's `player.ts` advances the queue.

## Known limitations / Phase 2 candidates

- **`n_frames` required from container metadata.** Probe rejects files where Symphonia doesn't expose a frame count (rare for FLAC; some CBR-without-Xing MP3s). Fallback to non-progressive full-decode is straightforward when this becomes a real problem.
- **Sample-rate mismatch rebuilds the stream.** Mixing 44.1k and 48k tracks in a session costs a one-time ~250 ms WASAPI rebuild at each transition. A future resampler (e.g. `rubato`) would let one stream serve any input rate.
- **No native loop region yet.** The renderer's `DeckController` still drives loops via poll-based wrap. Adding `set_loop` + `loop_start/loop_end` checking in the audio callback is straightforward; until then the wrap has the existing ~50 ms seam on the streaming backends but sample-accurate behavior on local because the cursor advances atomically.
- **No multi-deck.** Engine is single-deck. The wire protocol would gain a `deck_id` param; the `Engine` would become a map keyed by deck id; the audio callback would mix N sources into the cpal output. Foundation is there — `ArcSwap`-backed state, shared `playing` flag, etc.

## Build / bundle for production

`cargo build --release` produces a single self-contained binary. Bundle under `resources/audio/` in the Electron package. No runtime deps beyond OS audio (WASAPI / CoreAudio / ALSA).

Release profile uses `lto=fat` + `codegen-units=1` + `opt-level=3` + `strip=true`. Builds are ~30 s from scratch, a few seconds incremental.

## Versioning

`Cargo.toml` `version`. The `main.rs` startup banner prints `build=<tag>` (e.g. `progressive-r3`) for quick at-a-glance "which engine version am I running" confirmation — bump when the wire protocol or audio shape changes.

## Phase scope

- **Phase 1 (shipped):** load + play + pause + seek + set_volume + position + stop + event stream. Single-deck. Progressive playback. Stream keepalive across loads.
- **Phase 2:** native loop region, open-stream support (Beatport / Beatsource / SoundCloud byte-stream + HLS), resampler for mixed-rate libraries.
- **Phase 3:** multi-deck centralized mix bus, Tidal Partner SDK integration (PCM hand-off into the bus), stems / time-stretch.
