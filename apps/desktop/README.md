# @curator/desktop

The Electron app — main process, preload bridge, and the renderer UI. It hosts
`@curator/core`, spawns the sidecars, registers the custom media protocols, and renders the
library. Built with electron-vite; the renderer is vanilla TS + Solid.js (no heavy framework
in the hot paths).

## main / preload / renderer

The data flow is **renderer → preload → IPC → `CoreService` → DB / provider / sidecar**.
Don't add capability halfway down that stack — see the "adding a capability" lockstep in the
root [CLAUDE.md](../../CLAUDE.md).

- **`src/main/`** — app lifecycle + window, `CoreService` creation, sidecar hosting, protocol
  handlers. Key files: [`index.ts`](src/main/index.ts) (lifecycle, sidecar specs, protocols),
  [`handlers.ts`](src/main/handlers.ts) (one handler per IPC channel), `events.ts` (main→renderer
  push), `trpc.ts` (tRPC router for complex shapes), `audio-sidecar.ts`, `spotify-sidecar.ts`,
  `ingest/pool.ts` (utility-process audio-metadata parsing, off-main).
- **`src/preload/index.ts`** — minimal context-bridge; exposes `window.api` derived from the
  channel catalog in [`src/ipc.ts`](src/ipc.ts) + the event catalog.
- **`src/renderer/`** — Solid.js UI. `main.ts` (bootstrap), `player.ts` (playback state machine,
  routes to the audio/Spotify sidecars), `track-list.ts` (virtualized grid), `query.ts`
  (filter/sort DSL), plus `stores/`, `views/`, `components/`.

[`src/ipc.ts`](src/ipc.ts) is the catalog: each channel maps to `{ args, ret }`, so adding one
entry auto-exposes it through preload and forces a matching handler signature at compile time.

## Custom protocols

Registered as **privileged schemes before `app.whenReady()`** (Chromium freezes that registry
at boot — don't move the call later):

- `curator-cover://<trackId>` — album art (remote fetch or embedded APIC extraction)
- `curator-local://…` — local audio, with HTTP Range support for seek. **Only serves ingested
  files** (resolved through `source_link`) — that's a security boundary, no "any path" escape.
- `curator-peaks://<trackId>/<lo|hi>` — waveform peak files (`.cpk` / `rb_*.cpk`)

## Sidecars

`index.ts` builds each spec and passes it to `createCoreService` — each returns `null` when its
binary/bundle is absent, disabling that feature gracefully:

- `getAnalyzerSpec()` — Python Essentia analyzer (WSL on Windows; path translation at the boundary)
- `getRekordboxSpec()` — Python Rekordbox reader
- `getAudioSpec()` — Rust audio engine (stdio JSON-RPC)
- `getSpotifySpec()` — Spotify playback sidecar (loopback TCP, **not** stdio — prefers the signed bundle)

It also injects `beatportFetch = net.fetch` (Electron's HTTP, to dodge Cloudflare WAF 403s),
`parseAudio` (the utility-process pool), and `trashFile = shell.trashItem`.

## Scripts

`pnpm --filter @curator/desktop <script>`: `dev`, `build`, `typecheck` (includes a renderer
boundary check), `test`, `rebuild:electron`, `package:signed`, `start:packaged`. `predev` /
`prebuild` rebuild `better-sqlite3` for Electron's ABI automatically.

```bash
pnpm dev   # from repo root
```

Native rebuilds, Widevine signing, and the Spotify-sidecar build flow are documented in the
root [CLAUDE.md](../../CLAUDE.md).
