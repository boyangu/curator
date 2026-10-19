# @curator/spotify-player

A headless Electron sidecar that hosts the **Spotify Web Playback SDK + Widevine**, so the
main app shell isn't chained to the castlabs fork's signing ceremony. The desktop app spawns
it and drives playback over a **loopback TCP socket** (LF-delimited JSON-RPC frames).

## Why a separate process

Spotify in-app playback needs Widevine (EME), which requires a VMP-signed, castlabs-forked
Electron. Isolating that here keeps the main shell free to iterate without re-signing on every
dev loop. Unlike the Rust audio sidecar (stdio), this one uses **TCP** — an Electron main
process can't reliably read piped stdin and leaks bytes onto stdout. The host passes
`--rpc-port` and `--rpc-nonce`; the sidecar connects to `127.0.0.1`, proves the nonce, and
exchanges JSON frames terminated by `\n`.

- Entry: `src/main.ts` → built to `out/main/index.cjs`
- Renderer: `src/renderer/` (`sdk.ts` + `index.html`) hosts the Web Playback SDK in a hidden window
- Host side (in the desktop app): [`../desktop/src/main/spotify-sidecar.ts`](../desktop/src/main/spotify-sidecar.ts); renderer wiring goes through the `spotify:rpc` / `spotify:event` IPC channels.

## Build & sign (once), then dev freely

```bash
pnpm build:sidecars   # from repo root — builds + VMP-signs + stages every sidecar
```

This stages the signed bundle into `../desktop/resources/spotify-player/`. `getSpotifySpec()`
prefers that signed bundle in **dev and prod**, so `pnpm dev` spawns the signed sidecar and the
main-app loop never re-signs. Re-run `build:sidecars` only when you change *sidecar* code.

Local scripts (`pnpm --filter @curator/spotify-player <script>`): `build` (electron-vite),
`package` (electron-builder `--dir`), `sign` (`castlabs_evs.vmp sign-pkg`), `package:signed`.

`CURATOR_DISABLE_SPOTIFY=1` disables the sidecar entirely (disabled is a supported state).

> Don't "fix" Spotify auth/Widevine errors by editing auth code — check the sidecar is built
> and signed first. The canonical rules live in the root [CLAUDE.md](../../CLAUDE.md).
