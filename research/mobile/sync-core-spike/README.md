# Sync client inside an embedded JS engine

Can a phone run the desktop's own sync client instead of a port of it? This spike runs the
client (`packages/sync-core/src/sync-log`, unchanged, imported from the product source) inside
QuickJS with SQLite linked beside it, joins the real library as a new device, and compares
the resulting database with what Node + better-sqlite3 writes from the same input.

Not part of the pnpm workspace; nothing here ships.

## What is here

| Path | What it is |
|---|---|
| `host/host.c` | QuickJS-ng + SQLite in one command-line program. Gives JavaScript one global, `__host`: a SQLite binding, SHA-1/SHA-256, gunzip, files, clocks, memory figures. |
| `shim/` | What the client imports from Node, over `__host`: `better-sqlite3`, `node:crypto`, `node:zlib`, `Buffer`, timers, `console`. |
| `src/driver.ts` | The run. `join`: `createSyncClient` against the tests' in-memory cloud (`test-support/fake-cloud.ts`) holding the real snapshot as the master published it; with `--ops`, later ops for it to pull. `stream`: the loader alone, fed the snapshot in small pieces, then the client's settle steps (what showed a streamed load fits a phone, before the client could do it). `probe`: ops applied in pages with every record write traced. |
| `scripts/` | `fetch-vendor`, `bundle`, `prepare`, `split-snapshot`, `export-ops`, `build-host`, `reference`, `run-device`, `compare`, `compare-desktop`, `gate`, `serve-cloud`. Each file's header says what it does. |

Nothing leaves this machine: the transport is the fake cloud's, or (`sync`, last section)
plain HTTP to a test server on loopback. The real library is opened
read-only once (`prepare`: `VACUUM INTO` a copy); everything else works on copies under
`c:/tmp/curator-mobile-spike/`.

`dist/desktop.mjs` is only ever imported. Run as a program it would migrate `./curator.db`
(`migrate.ts` has a CLI entry), so it refuses.

## Run it

```
pnpm install
node scripts/fetch-vendor.mjs          # QuickJS, SQLite, zlib sources -> vendor/
node scripts/bundle.mjs                # dist/core.js (QuickJS), dist/desktop.mjs (Node)
node scripts/prepare.mjs               # copy of the library, its snapshot, an empty library
node scripts/reference.mjs --fixed     # Node, counted clock and ids
node scripts/build-host.mjs linux      # or android-arm64 / android-x86_64
node scripts/run-device.mjs wsl --fixed
node scripts/compare.mjs c:/tmp/curator-mobile-spike/main/node-fixed c:/tmp/curator-mobile-spike/main/wsl-fixed
```

On a phone (USB debugging on, `adb devices` lists it):

```
node scripts/build-host.mjs android-arm64
node scripts/run-device.mjs adb --stream     # the streamed load: fits a phone's memory
node scripts/run-device.mjs adb              # the whole-snapshot join: about 3 GB, see below
```

The program runs under `adb shell` from `/data/local/tmp`; nothing is installed and the
folder is removed afterwards. Results land in `c:/tmp/curator-mobile-spike/main/<model>…/`.

`run-device.mjs wsl-node` (Node inside WSL, for the two engines on one machine) needs a
Node build at `/tmp/spike-node/node` and `npm i better-sqlite3@12.10.0` in `/tmp/spike-node`.

The pull run: `node scripts/prepare.mjs --name <base> --static --source <an older backup>`,
`node scripts/export-ops.mjs` (the newer library's own ops), then `--name <base> --ops <ops.json>`
on `reference.mjs` and `run-device.mjs`. The streamed run needs `node scripts/split-snapshot.mjs` first.

## Results (2026-11-20)

Library: 38,999 tracks, 309,164 records; snapshot 248 MB of JSON, 42 MB gzipped. Machine:
Core Ultra 7 258V laptop. QuickJS-ng 0.18.0, SQLite 3.53.1 on both sides. Times are single
runs on a laptop and moved by tens of percent between runs; read them as sizes, not benchmarks.

**It runs unchanged.** The client, the fake cloud and everything they import bundle to
0.9 MB of JavaScript. Outside plain JavaScript they need a SQLite binding
(prepare / run / get / all / iterate / pluck / exec / pragma / transaction), SHA-1 and
SHA-256, random ids, gunzip, timers and a small `Buffer`. `node:fs/promises` is touched
only by the master's snapshot publish.

**Same database, row for row — after one engine fix.** With a counted clock and counted ids:

| Input | Compared | Result |
|---|---|---|
| Join from the snapshot | Node vs QuickJS (Linux) | 59 tables, 775,245 rows identical |
| Base of 8 November + the desktop's 5,604 ops since | Node vs QuickJS (Linux) | 59 tables, 775,151 rows identical |
| Streamed load | Node vs QuickJS on the Android emulator (API 35, x86_64) | 59 tables, 775,626 rows identical |

Eleven tables are identical apart from columns SQLite stamps with its own clock
(`DEFAULT unixepoch() * 1000`). `compare.mjs` names them.

The engine fix: as released, QuickJS-ng 0.18.0 lost 30 fingerprint claims in the pull run.
Its `Map` hashes a long concatenated string differently from the equal flat string, so the
store's flush took records it had just written for missing and deleted them.
`host/map-rope-repro.js` shows it in 20 lines; `host/quickjs-map-rope-fix.mjs` is the fix
`build-host.mjs` applies to a copy of the engine (`--stock` builds it as released). The bug
is in the engine's master too.

**Against the desktop's own library** (`compare-desktop.mjs`): the joined replica holds the
same tags, playlists and their order, cues, ratings, overrides and rekordbox analysis; it
differs in one deleted track row and one artist credit's role. Node's replica differs the
same way: a sync matter, not an engine one.

**Time.**

| Run | QuickJS | Node, same Linux and disk | Node, Windows |
|---|---|---|---|
| Join through the client | 136–155 s | 78–132 s | 280 s |
| Pull 5,604 ops (8 pages) | 3.4 s | 1.8 s | |
| Streamed load and settle | 174 s | 104 s | |

The work is mostly SQLite's, which is why the engines are within a factor of two. The
emulator's streamed load took 239 s.

**Memory is the obstacle, on both engines.** The join peaks at 2.9 GB resident in QuickJS
and 3.0–3.2 GB in Node: `transport.bootstrap()` hands the client the whole snapshot as one
array of records. On the emulator with 8 GB of device memory the join was killed at about
2.2 GB (allocator out of memory). Fed the same snapshot in pieces of 2,000 entries, the
loader peaks at 341 MB (QuickJS, Linux), 386 MB (emulator), 514 MB (Node). The streamed run
calls `loadSnapshot` once per piece and then the client's settle steps; the client itself
cannot load that way today.

**On a phone.** Sony Xperia XQ-EC72 (Snapdragon 8 Gen 3, 12 GB, Android 16), the arm64
build under `adb shell`:

| Run | Time | Peak memory | Against Node |
|---|---|---|---|
| Streamed load and settle, real clock | 226 s (load 162, settle 64) | 421 MB | same synced content |
| Streamed load and settle, counted clock | 184 s | 421 MB | 59 tables, 775,626 rows identical |

| Streamed load of the 8 November base, then the 5,604 ops applied in pages of 500 (`stream --ops`), counted clock | ops: 4.0 s to apply, 0.8 s to settle, 61 MB | 430 MB | 59 tables, 775,550 rows identical |
| Whole-snapshot join through the client | killed after 22 s: the engine could not allocate, at 3.3 GB | | |

A flagship chip: a best case for Android, about 1.3 times this laptop's QuickJS time. The
ops on the phone go through `applyOps` directly, as the replay check applies them: the
client's own pull loop only runs after its join, which does not fit.

**Not measured:** a mid-range phone, the client's pull loop on a phone, the client inside
an app process rather than a shell program, iOS / JavaScriptCore, and a transport that is
not in memory.

## After the fixes (2026-11-20, later)

The sync client now takes the snapshot as text in pieces and loads it through a scratch
database (`packages/sync-core/src/sync-log/snapshot.ts loadSnapshotText`; the wire format did not
change), a snapshot load derives artists and albums only once every record is in, and the
credit normalisation derives what a records-only device derives. `join` is the product's
client end to end; the spike only supplies the phone's inflater.

| Join of the full library through the client | Before | After |
|---|---|---|
| Node on Windows (the desktop), real clock: time / peak memory | 280 s / 2.9 GB | 223 s / 562 MB |
| QuickJS on Linux, counted clock: peak memory | 2.9 GB | 410 MB |
| QuickJS on the phone (Xperia XQ-EC72), real clock | killed at 3.3 GB | 385 s / 461 MB |
| QuickJS on the phone, counted clock | | 268 s / 461 MB |

Node vs QuickJS on Linux and Node vs the phone, counted clock: 59 tables, 775,246 rows
identical each time, and every track on the same release. Two Node runs sliced differently
(real clock, counted clock) now end with the same 26,495 album rows; before, the count moved
by a few between runs.

The phone's 385 s is 9 s to cut the text into the scratch, 270 s to load it, 106 s to
settle. With the counted clock the loader's slices grow to 2,000 records and the run is a
third shorter: the 40 ms slices are sized for the desktop's main loop, which a phone's sync
thread does not share.

`node scripts/gate.mjs [--ops <file>] [--device adb]` runs the comparison in one go.

## A real transport and longer slices (2026-11-20, evening)

**The phone's transport.** `packages/sync-core/src/sync-log/fetch-transport.ts` is the client's
`CloudTransport` over plain HTTP: the server's tRPC procedures called by URL, with whatever
HTTP the platform has. No Electron, no tRPC client, no Supabase SDK. It covers the library
sync (push, pull, the snapshot join and publish, the account calls); the catalogue, Spotify
and feed calls are not in it. `e2e/src/cloud.test.ts` runs the same scenarios through it
and through the tRPC client against the real server code.

Here the driver's `sync` command runs the client through that transport against
`scripts/serve-cloud.ts`: the real server code (migrations, row security, the router, the
snapshot checks) on an in-process PGlite, loopback only, holding the snapshot as its master
published it. A phone or emulator reaches it through `adb reverse`; the host's HTTP is a
plain socket (`__host.http`), which is enough for a test server and nothing else.

```
cd apps/cloud && npx tsx ../../research/mobile/sync-core-spike/scripts/serve-cloud.ts --name nov8 --ops <ops.json>
node scripts/reference.mjs --http --tail --fixed --name nov8        # Node; a fresh server per run
node scripts/run-device.mjs adb --http --tail --fixed --name nov8   # phone or emulator
```

The 8 November base joined over HTTP, then the desktop's 5,604 later ops pulled in 8 pages,
counted clock:

| Run | Join | Pull | Peak memory |
|---|---|---|---|
| Node on Windows | 109 s | 4.0 s | 575 MB |
| QuickJS on the Android emulator (API 35, x86_64, 2.5 GB of memory) | 260 s | 6.6 s | 364 MB |
| QuickJS on the phone (Xperia XQ-EC72) | 167 s | 5.3 s | 422 MB |

Node vs the emulator and Node vs the phone, 59 tables, 775,156 rows: identical but for two
settings the server gives each run (the test account's id and the server's clock).

Two things the comparison turned up, both in the harness: QuickJS-ng makes `InternalError`
uncatchable, so the host throws plain errors (a refused connection has to be catchable);
and Node's `fetch` reads `Date` and `performance.now` on every request, so the Node side
makes its requests from a worker, the main thread waiting as the phone's socket does.

**Longer slices.** The client's `sliceScale` option (`slice-budget.ts`) multiplies the
budgets that keep a desktop's main loop responsive; a host whose sync has a thread to
itself can set it (`--scale <n>`). Real clock:

| Scale | Laptop, QuickJS on Linux: full join | Phone, over HTTP: join of the 8 November base | Phone: pull of 5,604 ops |
|---|---|---|---|
| 1 | 132 s | 251 s | 10.0 s |
| 3 | | 234 s | 6.6 s |
| 6 | 97 s | 202 s | 6.5 s |
| 12 | | 191 s | 5.9 s |

Peak memory is the same at every scale (421 MB on the phone), and so are the synced content
and every track's release. The phone runs were back to back, one each, the first from a
cooler phone (35.7 °C against about 37.5 °C). The counted-clock run above (167 s) is the
loader at its largest slices: what is left after that is the work itself.

## Hermes, and where a join's time goes (2026-11-21)

**Hermes V1** (Meta's 260318099.0.8, prebuilt for Android) runs the same bundle through
`host/host-hermes.cpp`, which offers JavaScript the same `__host` as the QuickJS host
(the engine-neutral half of both is `host/common.h`). `fetch-vendor.mjs` brings the engine,
its compiler, the JSI sources of its tag, fbjni and a portable JDK, all pinned;
`node scripts/build-host.mjs android-arm64 --engine hermes` and
`node scripts/run-device.mjs adb --engine hermes …` build and run it.

- Hermes on Android hands `normalize`, `localeCompare`, case conversion beyond ASCII and date
  formatting to Java (`AndroidUnicodeUtils`, through fbjni) and attaches its finalizer thread
  to the Java VM: it cannot run as a plain program. The host is a library run inside
  Android's Java runtime by `app_process` (`host/java/spike/Main.java`), as an app runs it.
- `subarray` and `slice` of a `Uint8Array` subclass return a plain `Uint8Array` (no species):
  version-5 ids came out as lists of numbers until the shim's Buffer said so itself.
- Async generators are unsupported (esbuild lowers them); block scoping is the compiler's
  experimental `-Xes6-block-scoping`.

Phone, counted clock, against Node: identical rows for both engines (59 tables, 775,156 rows).

| Engine | Join | Pull of 5,604 ops | Peak memory |
|---|---|---|---|
| QuickJS | 176 s | 7.1 s | 421 MB |
| Hermes | 172 s | 5.2 s | 449 MB (with the Java runtime) |

The engine is not where the time goes. **`scripts/profile.mjs`** times every SQLite call of a
Node join by statement and by phase. Of 145 s on the laptop, 63 s were 4,549 commits (each
rewriting every page it touched, 32 indexes on `track`, a checkpoint every ~4 MB of WAL),
600,000 prepares of the same statements took 8 s, and one lookup chose the wrong index
(5–75 s). SQLite rebuilds the finished database whole (`VACUUM INTO`) in 2.7 s.

The client now joins with rarer checkpoints and, on an empty library, no flush per commit
(`enterJoinSettings`), caches its per-record statements (`packages/sync-core/src/db/stmt.ts`) and
keeps that lookup on the right index. Same rows as before (Node, counted clock):

| Join of the 8 November base | Before | After |
|---|---|---|
| Node on the laptop, real clock | 145 s | 82 s |
| Phone (QuickJS), real clock, slice scale 1 | 251 s | 120 s |
| Phone (QuickJS), real clock, slice scale 6 | 202 s | 109 s |

## Joining from a ready-made replica (2026-11-21)

With no disk at all (`profile.mjs --memory`) the tuned join still took 72 s on the laptop: the
time is the per-record work, not storage. So the master builds the database once and new
devices download it.

- `scripts/build-replica.mjs` stands in for the master's background step: the join of the
  published snapshot (here a `reference.mjs --http` run), compacted with `VACUUM INTO`, cut into
  32 MB slices gzipped one by one (each inflates on its own as it arrives). Built from the
  snapshot, not copied from the master's library, so nothing local to the master is in it.
- `serve-cloud.ts` serves it under `/storage/replica/`; the driver's `replica` command
  (`run-device.mjs adb --replica --tail`) fetches each part, checks it, inflates it onto the end
  of the library file, takes a device identity of its own (`remint.ts`, as a restored backup
  does), and then runs the ordinary client, which finds the account joined and pulls what came
  after.

| | Laptop | Phone (Xperia XQ-EC72) |
|---|---|---|
| Master: join, compact, compress (once per build) | 128 s + 4 s + 10 s | — |
| Download 18 parts, 143 MB (loopback / USB) | 0.6 s | 3.5 s |
| Verify (SHA-256) | 0.05 s | 1.3 s |
| Inflate and write 571 MB | 1.8 s | 1.4 s |
| New identity, first cycle | 0.3 s | 0.4 s |
| **Library usable** | **2.8 s** | **6.7 s** (a normal join: 109–120 s) |
| Then the 5,604-op tail | 3.4 s | 5.8 s |

Same synced content as a normal join and every track on the same release, on the laptop, the
emulator and the phone. The downloads here are local; over the internet 143 MB is ~11 s at
100 Mbit/s, which is then most of the time. zstd (128 MB, faster to inflate) and a slimmer
`sync_state` (325 of the 571 MB) would shrink it.

## The replica in the product (2026-11-21, later)

The prototype above is now the product's path; the spike drives it unchanged.

- **Protocol:** sync feature `replica_storage`. `sync.publishReplica` (master only, its
  snapshot must be stored), and `bootstrap` offers the newest replica when the client sends
  `replicaSchema`. Server migration `0034_library_replica.sql`. Retention keeps the newest
  replica and pins its snapshot.
- **Core** (`sync-log/replica.ts`): `buildReplica` runs the real client's join of the
  snapshot against an offline account (the build must emit no ops), then `VACUUM INTO`, then
  cuts the file into gzip parts of up to 8 MB. `installReplica` / `joinFromReplica`
  download the parts, check them, inflate them into a staging file, rename it, `migrate()`, and
  re-mint the device identity. The master builds weekly, after a snapshot publish
  (`REPLICA_EVERY_MS`). On the desktop, the build runs in the snapshot utility process.
- **Spike:** `build-replica.mjs` calls `buildReplica`. `serve-cloud.ts` publishes the
  replica through `sync.publishReplica`. The driver's `replica` command calls
  `joinFromReplica`.

Two fixes came out of measuring it on the device:

- The hosts' `createHash` collected every update and hashed only at the end, so the replica's
  whole file stayed in memory. It now hashes as data arrives (`hashOpen` / `hashUpdate` /
  `hashDigest`). Emulator: install 30.7 s → 9.5 s, rss 575 → 35 MB, tail 41 → 8.7 s.
- **`migrate()` redid work on every run.** `ALTER_MIGRATIONS` replays on each launch, and its
  ADDs of columns that a later entry drops or renames came back each time. Each run then
  back-filled them and rewrote `track` to drop them again. That cost ~2–3 s of every desktop
  launch on this library, and of every replica install. The dead entries are gone, an empty
  stray `spectral_complexity` is dropped once, and a second `migrate()` now changes nothing
  (0.4 s).

| | Laptop | Emulator (QuickJS) |
|---|---|---|
| Download 30 parts, 143 MB (loopback) | 0.5 s | 1.1 s |
| Verify (SHA-256) | 0.04 s | 0.5 s |
| Inflate and write 571 MB | 1.8 s | 4.3 s |
| Migrate, new identity | 0.8 s | 0.4 s |
| **Library usable** | **3.2 s** | **6.3 s** |
| Then the 5,604-op tail | 4.9 s | 6.9 s |

The phone has not run the product path yet.
