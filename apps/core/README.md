# @curator/core

The backend. Everything that isn't UI or a sidecar process lives here: the library
database, streaming sync, enrichment, downloads, the analyzer/rekordbox queues, and the
Discover feed. The desktop app talks to core over IPC; core talks to SQLite, the provider
clients, and the sidecars.

## The API surface

[`src/service.ts`](src/service.ts) defines the **`CoreService`** interface — the single
contract the rest of the system depends on. Treat it like a public API: when core is later
split out to run remotely, the transport changes but these method signatures should not.

Capability groups on `CoreService`:

- **Tracks** — `getTracks`, `setRating`, `setTrackOverrides`, `setTrackSourceLinks`, `deleteTracks`
- **Playlists** — `getPlaylistsWithFolders`, `addTracksToPlaylist`, `reorderPlaylistTracks`, `setPlaylistFavorite`
- **Streaming sync** — `runSpotifySync`, `planSpotifySync`, `runSpotifyPlaylistSync`, `getSyncStatus`
- **Enrichment** — `enrichBeatportTracks`, `matchTidalForTracks`, `setPlaylistHybridTidal`
- **Downloads (Tidal)** — `enqueueTidalDownloads`, `getDownloadQueue`, `verifyDownloads`
- **Analyzer** — `enqueueAnalysis`, `getTrackAnalysis`, `getTrackCues`, `upsertCue` (cues)
- **Rekordbox** — `runRekordboxImport`, `getRekordboxTree`, `syncToRekordbox`, `resolveSyncConflicts`, backups
- **Feed (Discover)** — `getFeedPage`, `feedAction`, `runFeedRefresh`, `loadMoreFeed`
- **Local library** — `addLibraryFolder`, `startLibraryWatching`, `resolveLocalFile`
- **Tags** — `getTags`, `createTag`, `addTrackTag`
- **Organize** — `recommendForSelection` (tag+playlist affinity recommender)
- **Auth** — `auth` (Spotify/Tidal OAuth + token provisioning)

## Layout (`src/`)

| Dir | Owns |
|---|---|
| `db/` | Drizzle + `better-sqlite3` client, `migrate.ts`, `seed.ts` (schema lives in `@curator/shared`) |
| `sync/` | Spotify pull/merge, Tidal hybrid matching, download orchestrator + queue |
| `sources/` | Streaming source adapters + auto-poll scheduler |
| `enrich/` | Beatport/Traxsource enrichers + library sink (the relocatable enrichment boundary) |
| `feed/` | Discover feed engine — `SqliteFeedStore`, `FeedService`, producers, promotion pipeline |
| `analyzer/` | Offline-analysis queue, job dispatch, `.cpk` peak-file generation, flags |
| `rekordbox/` | Importer, exporter, sidecar host, 3-way sync pipeline + conflict resolution |
| `local/` | Library scanner (chokidar folder watching, source-link management) |
| `ingest/` | In-process audio-metadata parser (`parseInline`) |
| `auth/` | OAuth + token management |

## Database

Drizzle ORM over `better-sqlite3` (synchronous SQLite, WAL mode, foreign keys on). The
schema is defined once in [`packages/shared/src/schema.ts`](../../packages/shared/src/schema.ts);
migrations run from [`src/db/migrate.ts`](src/db/migrate.ts) via `pnpm db:migrate`.

> `better-sqlite3` is native — run `pnpm rebuild:node` before `db:migrate` / tests so the
> ABI matches Node (the desktop app uses `rebuild:electron`). See the root CLAUDE.md.

## Sidecars are injected, and optional

`createCoreService(dbPath, opts)` takes optional specs — `analyzer`, `rekordbox`,
`parseAudio`, `trashFile`, `beatportFetch`, `peaksDir`. **Omit a spec and that capability
becomes a no-op / clean rejection** — disabled is a supported state. Tests and the headless
CLI run with no sidecars at all. The desktop main is what wires the real specs in.

## Scripts

`pnpm --filter @curator/core <script>`: `typecheck`, `test`, `test:watch`, `db:migrate`, `db:seed`.

See the root [CLAUDE.md](../../CLAUDE.md) for the cross-stack rules (the "adding a capability"
lockstep, performance constraints, sidecar protocol).
