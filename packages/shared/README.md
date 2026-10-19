# @curator/shared

The data-model API surface. One place defines the Drizzle/SQLite schema and the shared TS
types; `@curator/core` and the desktop app both import from here, so the schema can't drift
between backend and renderer.

- [`src/schema.ts`](src/schema.ts) — all Drizzle table definitions
- `src/index.ts` — re-exports the schema + shared types
- Also exported via the `./schema` subpath; uses `drizzle-orm` + `zod`

## The model

A track that lives in several places (a Spotify ID, a Tidal ID, a FLAC on disk, a Rekordbox
entry) is **one `track` row with several `source_link` rows** — not duplicate records. Core
entities:

- **`track`** — the canonical recording (ISRC/MBID, title, artists, BPM, Camelot key, genre,
  label, analysis scalars). `TrackOverrides` shadow specific fields with user edits.
- **`source_link`** — one per provider, preserving that source's original metadata.
  `Source` ∈ `spotify | tidal | beatport | traxsource | musicbrainz | discogs | local | rekordbox`.
- **`playlist` / `playlist_folder` / `playlist_track`** — source-native playlists, folder
  hierarchy, position-keyed membership.
- **`track_analysis` + `cue`** — Essentia output (beatgrid, key, loudness, dissonance, density,
  brightness/power, structural `segments`) and hot/memory cues.
- **`tag` / `track_tag`** — user labels.
- **`token`** — OAuth credentials.
- **Queues & observability** — `sync_job`, `analysis_job`, `download_job`,
  `sync_conflict` / `playlist_conflict`.
- **Rekordbox state** — `rekordbox_link`, `rekordbox_membership_baseline`,
  `rekordbox_sync_watermark`, `rekordbox_deleted_content`.

`TrackState` ∈ `unsorted | feed | backlog | progress | purchased`.

Migrations live in [`apps/core/src/db/migrate.ts`](../../apps/core/src/db/migrate.ts) — when you
change a table here, add the matching migration there (see the root [CLAUDE.md](../../CLAUDE.md)).
