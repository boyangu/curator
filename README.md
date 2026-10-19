# Curator

A hybrid music library manager for DJs and serious listeners. One library that spans the streaming services you discover on, the files you own, and the rig you actually play.

## What it is

Curator takes an end-to-end approach for DJs - 

It connects and unites your personal and professional music worlds - from streaming services to local library managers and DJ apps.

- Music discovery
  - Endless feed, tailored made for you
- Professional listening
  - **See** the track, add cues and much more
- Library Management
  - Create playlists
  - Enrich with BPM, Key, Genre, Label, Energy, and many more - Manually or automatically
  - Tagging
- Curation
- Set building
  - Create sets 
- Sharing
  - Share your sets 

Curator is smart, AI is everywhere - Discover, enrichment, automatic Cues, curation & set building, ...

## Sources

- **Spotify** — playlists, Liked Songs, listening history. OAuth (PKCE).
- **Tidal** — playlists + downloads. OAuth for catalogue; sniffed session for the lossless streaming endpoints.
- **SoundCloud** — Coming soon
- **Apple** - Coming soon
- **Google** - Coming soon
- **Local files** — anything on disk. Walked recursively; identified by ISRC, then fingerprint, then filename.
- **Rekordbox** — reads the Rekordbox library (master.db + ANLZ cue/beatgrid/waveform data) and my tags. Two-way sync so library changes flow into the DJ rig and play history flows back.

A track that lives in multiple places (Spotify ID, Tidal ID, a FLAC on disk, a Rekordbox entry) is one record with several source-links — not four duplicate records.

## Value chain

Music goes through four stages from "noticed" to "played in a set", and Curator owns each one:

1. **Discovery.** Bring in candidates from every source. Recommendations across services, watching specific labels, following peers, scraping editorial. Surface the same track from multiple sources together so taste signals don't fragment.
2. **Cataloguing.** Enrich with BPM, key, genre, label, energy, vocal/instrumental, mood. Reconcile metadata conflicts (the Spotify title vs. the Beatport title vs. the file's Vorbis tag) into a canonical record with auditable overrides.
3. **Purchasing.** When a track earns it, route to the right store and format. Currently Beatport / Bandcamp for FLAC; future: direct-to-label. Track ownership state so a streamed-only track is visibly different from one that's bought.
4. **Playlist & set creation.** Build playlists and DJ sets from the catalogue, sort by harmonic key / BPM / energy, export to Rekordbox or back into streaming services. A set is just a playlist with timing constraints.

## Pillars

- **AI throughout.** Discovery (matching taste vectors across services, surfacing tracks you'd like that are buried in catalogue tails), cataloguing (auto-tagging style/mood/energy beyond what Beatport provides, resolving metadata conflicts), and creation (suggesting next-track candidates, building rough sets from a seed track and a target energy curve). Not a chatbot on top — a model woven into the data plane.
- **Listening + set habits feed back into the machine.** Every play, skip, set built, and gig played is a training signal. The system that suggests your next track is the same one watching what you actually pick. Over time the recommendations shouldn't just be "you might like" — they should be "this fits the moment you usually play tracks like this in".

## Status

This repo is in active build-out. Working today:

- Spotify and Tidal OAuth + playlist sync
- ISRC-based deduplication across sources
- Beatport / Traxsource enrichment (BPM / key / label / genre / release date)
- Tidal track-id resolution against Spotify tracks (hybrid playlists)
- Lossless FLAC downloads via DASH manifest decoding
- Persistent download queue with retry / verify / re-download
- Spotify in-app playback via Web Playback SDK (Widevine via castlabs Electron)
- Native audio engine — Rust sidecar (Symphonia + cpal) for local file playback
- Virtualised tracks list, per-playlist anchor + search persistence
- Offline audio analysis (Essentia): BPM, key, peaks, structural segments, learned brightness/power scores
- Big-waveform player: phrase/segment lane, vinyl-style drag scrubbing
- Track tagging
- Pioneer FLX10 controller control
- Discover feed v1 (Spotify producers, ranked feed, promotion into the library)
- Rekordbox two-way sync (read from collection + push metadata / cues / playlists back)

Not yet:

- SoundCloud / Apple / Google ingest
- Full AI layer (recommendations, set generation, automatic cues)
- Purchase routing
- Tidal in-app playback (SDK wired, gated behind further auth work)

## Repo layout

```
apps/
  core/            backend: sync, enrichment, download, feed service, SQLite (CoreService)
  desktop/         Electron main + renderer; UI, IPC, custom protocols, sidecar hosting
  analyzer/        Python sidecar — Essentia audio analysis + peaks (JSON-RPC/stdio, WSL)
  audio/           Rust sidecar — native decode/playback (Symphonia + cpal)
  rekordbox/       Python sidecar — Rekordbox library read (master.db + ANLZ)
  spotify-player/  headless Electron sidecar — Spotify Web Playback SDK + Widevine
  graph-explorer/  experimental in-memory knowledge-graph view over curator.db
packages/
  shared/          Drizzle schema + shared types (the data-model API surface)
  providers/       per-service clients (Spotify, Tidal, Beatport, MusicBrainz, Traxsource)
  matcher/         ISRC / fuzzy track matching
```

## Getting started

```bash
pnpm install
pnpm dev
```

## Configuration

No key, vendor credential or project identifier lives in the code; everything comes from the environment. Copy [`.env.example`](.env.example) to `.env` at the repo root (git-ignored) and fill in what you have:

- `CURATOR_SPOTIFY_CLIENT_ID` — Spotify app (developer dashboard)
- `CURATOR_TIDAL_CLIENT_ID`, `CURATOR_TIDAL_CLIENT_SECRET` — Tidal app (developer portal)
- `CURATOR_GOOGLE_CLIENT_ID`, `CURATOR_GOOGLE_CLIENT_SECRET` — Google OAuth client of type Desktop, for Drive backup
- `CURATOR_SUPABASE_URL`, `CURATOR_SUPABASE_PUBLISHABLE_KEY`, `CURATOR_CLOUD_API_URL` — Curator account + cloud sync

Without them the app runs **local-only**: no streaming sources, no cloud sync, no Drive backup — each shows "not configured" in Settings, and local files, rekordbox, analysis and playback work as before. `pnpm dev` and `pnpm --filter @curator/desktop build` / `package*` read `.env` (then `apps/desktop/.env`, then the shell) and bake the values into the main bundle at build time; a packaged app never reads the end user's shell. A build with any credential or project id unset fails with a message naming them, unless `CURATOR_ALLOW_UNCONFIGURED_BUILD=1` is set; an empty `CURATOR_CLOUD_API_URL` only warns (sign-in works, library sync off). Tests and the headless CLI need none of them.

The cloud API (`apps/cloud`) has its own `.env.example`; its Fly app name is the `FLY_APP` GitHub repository variable (see its README).

To test Spotify playback specifically (requires the castlabs Widevine signing flow):

```bash
cd apps/desktop
pnpm package:signed
pnpm start:packaged
```

See `apps/desktop/scripts/rebuild-sqlite.mjs` for the native-rebuild contract if you change the Electron version.
