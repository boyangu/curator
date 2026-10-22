# @curator/cloud

The cloud API: a per-user op log behind tRPC (`sync.push`, `sync.pull`, `sync.bootstrap`, the batch upload `sync.batchBegin` / `batchPush` / `batchCommit` / `batchAbort`, the master's `sync.publishSnapshot`, `account.registerDevice` / `devices` / `revokeDevice`, `health`), and the analysis catalogue (`catalogue.lookup` / `put` / `inventory`). It stores ops, snapshots of the folded library state (published by the account's master device, or folded by the server as a fallback) and analysis results devices computed; it never analyses, and it never writes to Spotify, Tidal, rekordbox or files. Design: `planning/tech/cloud.md` ("Server API", "Schema versioning and security", "Bootstrap, snapshots and history retention").

## Local development

```
pnpm --filter @curator/cloud test        # PGlite in-process, no Postgres or network needed
pnpm --filter @curator/cloud typecheck   # tsc + the import-boundary rule
pnpm --filter @curator/cloud dev         # tsx watch src/server.ts, needs the env below
pnpm --filter @curator/cloud build       # esbuild → dist/{server,migrate,snapshot}.js
```

`dev` needs a real Postgres with the Supabase bits (`auth.uid()`, `realtime.send`, the `authenticated` role). The simplest is the Supabase CLI's local stack (`supabase start`) with `SUPABASE_URL=http://localhost:54321`; the tests carry their own shim (`src/test/supabase-shim.ts`) and need nothing.

## Environment

Read from the environment only; `.env.example` lists them with placeholders. Never commit a real value.

| Var | What |
| --- | --- |
| `DATABASE_URL` | Postgres connection as `curator_api` (below). Not `postgres`, not the service role. |
| `SUPABASE_URL` | `https://<ref>.supabase.co`. Tokens are verified against `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`; there is no JWT secret anywhere. |
| `PORT` | Defaults to 8080. |
| `CURATOR_CATALOGUE` | The catalogue units this server accepts, e.g. `rhythm,key,structure,advanced,fingerprint,peaks:lo` (stage D-a). Unset or `off`: no catalogue. Not a secret: production sets it in `fly.toml` `[env]`. See "Catalogue". |
| `CURATOR_REQUIRE_DEVICE_ID` | `1`: `sync.pull` / `sync.bootstrap` that name no device are refused `update_required`. Unset (`0`) during the `device_reads` transition. Not a secret: `fly.toml` `[env]`. See "Revoking a device". |

## Database setup (Supabase project)

Once, in this order. Before you start, delete the spike's objects from `public` (`library_op`, `push_ops`, `pull_ops`, `library_op_wake`, the "owner receives own wakeups" policy on `realtime.messages`) and the spike user.

1. **Migrations**, with the owner connection (Project Settings → Database → connection string, user `postgres`), from your machine:

   ```
   DATABASE_URL='postgres://postgres.<ref>:<owner password>@<pooler host>:5432/postgres' pnpm --filter @curator/cloud db:migrate
   ```

   It creates the `curator` schema and records each applied file in `curator.schema_migration` with a checksum. Re-running is a no-op; editing an applied file is refused. A fix goes in the next numbered file (`sql/0005_*.sql`). `0004_catalogue.sql` adds the catalogue (`catalogue_item`, `catalogue_account`, the `catalogue_rev` sequence, `catalogue_entitled()`). The SQL files are plain SQL, so pasting one into the SQL editor works too, but then the runner does not know it ran.

2. **The API role**: paste `sql/roles.sql` into the SQL editor and run it (as `postgres`). Then, separately and never in a file:

   ```sql
   alter role curator_api with password '<generate 32+ random chars>';
   ```

   `curator_api` can log in and do nothing as itself. Each request switches to `authenticated` in its transaction with the caller's JWT claims, so RLS decides every row. If `grant authenticated to curator_api` is refused, the project's `postgres` lacks admin option on `authenticated`; ask Supabase support or run that one line from a session that has it.

3. **`DATABASE_URL`** for the API, through the session pooler (port 5432) or the transaction pooler (6543; the driver already runs without prepared statements):

   ```
   postgres://curator_api.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```

4. **Storage buckets**: paste `sql/storage.sql` into the SQL editor and run it (as `postgres`, after the migrations: it calls `curator.catalogue_entitled()` from 0004 and `curator.session_revoked()` from 0006). Idempotent; the runner skips it like `roles.sql`. It creates two private buckets (16 MiB per object, `application/octet-stream`), each with three policies on `storage.objects`: select / insert / delete under the caller's own `<uid>/` prefix, and no update policy (objects are immutable, content-addressed).
   - `catalogue`: insert only as `<uid>/peaks/<sha256>.cpk` or `<uid>/vec/<sha256>.cvec` and only while the account is entitled and under quota.
   - `snapshots` (`snapshot_storage`): insert only as `<uid>/snap/<sha256>.cgz` and only while the account holds under 512 MiB there (`curator.snapshot_upload_allowed()`). Not gated on the catalogue entitlement: snapshots are part of sync.

   Check:

   ```sql
   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id in ('catalogue', 'snapshots');
   select policyname, cmd from pg_policies where tablename = 'objects' and (policyname like 'curator_catalogue%' or policyname like 'curator_snapshots%');
   ```

   **If the editor refuses it** (42501, "must be owner of table objects": Supabase owns the `storage` schema), create the buckets and their policies in the dashboard instead (Storage → New bucket, then Storage → Policies), exactly as the comment at the top of `sql/storage.sql` spells out, and run only its `curator.catalogue_upload_allowed()` and `curator.snapshot_upload_allowed()` functions, each with the two lines after it (revoke / grant), in the SQL editor.

5. **Catalogue accounts.** Nobody may store analysis until the owner adds them (public sign-ups are off in Auth → Sign In / Providers, and this row is the second wall). In the SQL editor:

   ```sql
   insert into curator.catalogue_account (user_id) values ('<uid from Authentication → Users>');
   ```

   The default quota is 900 MiB (943718400 bytes), sized for Supabase Free during stage D-a. Raise it with `update curator.catalogue_account set quota_bytes = <bytes> where user_id = '<uid>'`; withdraw with `set entitled = false` (puts and uploads stop; what is stored stays readable).

6. **Data API exposed schemas.** Devices reach Auth, Realtime and Storage (own prefix: insert / select / delete, ≤16 MiB; catalogue uploads entitled only); the library and the catalogue's records go through this API. Dashboard → Project Settings → Data API → Exposed schemas: remove `public`, and do not add `curator`. Remove `graphql_public` too unless something uses GraphQL. With both gone, PostgREST serves no table to a device even with a valid token; RLS is the second wall, not the first.

7. **Realtime.** Nothing to toggle: the wake-up is a broadcast from a trigger on the private channel `user:<uid>` and the subscribe policy is created by 0001. Realtime Authorization must stay on (the default).

## Release (Fly.io)

Production deploys run **from the maintainer's machine only**, through [`scripts/release-cloud.mjs`](../../scripts/release-cloud.mjs). GitHub holds no Fly token, no environment and no other access to production; CI only checks code. The script keeps the guarantees a CI deploy would give:

1. **Only a pushed tag on `main` ships.** Tag the commit and push the tag, then run the release:

   ```
   git tag cloud-v0.2.0 <commit on main>
   git push origin cloud-v0.2.0
   pnpm release:cloud cloud-v0.2.0
   ```

   The script reads the tag from origin (a local-only or moved tag does not count), fetches `main`, and refuses unless the commit is an ancestor of `origin/main`.
2. **Built from the commit, never the working tree.** It `git archive`s that commit into a temporary directory, so uncommitted edits, `.env`, the live library database and git-ignored private files cannot reach the image.
3. **The CI checks run on that export**: install with the frozen lockfile, typecheck (including the boundary rule), test and build, the same steps as the `cloud` CI job ([`.github/actions/cloud-check`](../../.github/actions/cloud-check/action.yml)).
4. **Deploy and verify.** `flyctl deploy --remote-only` builds on Fly's builder with `--build-arg GIT_SHA=<commit>` and `--image-label <tag>`, then the script polls `https://<app>.fly.dev/trpc/health` until `commit` is that SHA, failing after 3 minutes. Check it yourself with `curl -s https://<app>.fly.dev/trpc/health`.

Before deploying it also refuses when the Fly secrets `DATABASE_URL` / `SUPABASE_URL` are missing or `primary_region` is still a placeholder. Rolling back is a release too: tag the older commit (it is on `main`) as a new `cloud-v*` version.

**Configuration**, in the git-ignored root `.env` (or the shell), never in the tree:

| Variable | Value |
| --- | --- |
| `CURATOR_FLY_TOKEN` | A deploy token scoped to the one app: `fly tokens create deploy -a <app> --expiry 8760h`. Rotate with `fly tokens list -a <app>` / `fly tokens revoke <id>`. |
| `CURATOR_FLY_APP` | The Fly app name. |

The token reaches flyctl through its environment only; it is never printed or written. The desktop build bakes only its own named keys, so neither variable can end up in the app.

**Migrations come before the release**, in this order:

1. The owner runs the new migrations from their machine (Database setup, step 1): `DATABASE_URL='<owner connection>' pnpm --filter @curator/cloud db:migrate`.
2. The owner re-runs `sql/roles.sql` (step 2), always: it is idempotent, and a migration that adds a function the API calls (`0002_audit.sql`, `0003_migration_check.sql`) needs its grant.
3. When `sql/storage.sql` changed (or on the catalogue's first release), the owner runs it too (step 4), always after the migrations. It changed with `0006_device_session.sql` (its policies call `curator.session_revoked()`) and with `0008_snapshot_storage.sql` (the `snapshots` bucket).
4. Then release.

The server enforces the order. At boot it compares the migration files it ships (`sql/NNNN_*.sql`, not `roles.sql`) with `curator.applied_migrations()` (0003, executable by `curator_api` only, which has no read on `curator.schema_migration` itself) and, if any is missing, logs `schema_behind` with the missing files and a hint, and exits. The new machine never passes the health check, the deploy fails, and the previous release keeps serving. A database *ahead* of the image (a rollback onto a newer schema) starts with a `schema_ahead` warning, since migrations are additive.

**One-time Fly setup**, from the repo root (none of this deploys code):

```
fly apps create <app>
# set primary_region in apps/cloud/fly.toml to the region nearest the Supabase project, and commit that
fly secrets set --stage --app <app> DATABASE_URL='...' SUPABASE_URL='https://<ref>.supabase.co'
```

`--stage` stores the secrets without restarting machines; the next release picks them up. The health check is `GET /trpc/health` (`{ ok, schemaVersion, minSupportedSchemaVersion, features, catalogue?, commit }`). Every 15 minutes the running machine tends batches (expires idle ones, finishes stalled commits) and builds snapshots for users with 10k new ops or a day-old snapshot whose log has been quiet for 5 minutes (or whose snapshot is an hour old), never while they have an open batch, and never while their newest snapshot is one their master published within 7 days (see "Snapshots"); `node dist/snapshot.js [--user <uuid>]` in `fly ssh console` runs the same sweep (or one user's snapshot) on demand, `node dist/snapshot.js verify --user <uuid>` checks a published snapshot against a fold of the log, and `node dist/snapshot.js --db-size [--user <uuid>]` prints the curator tables' sizes and the user's Storage use per bucket.

## Repository settings

Applied on `boyangu/curator` (public) on 2026-10-19; none of them grants access to production:

- Secret scanning with push protection.
- Dependabot alerts and security updates (version updates come from `.github/dependabot.yml`).
- `main` refuses force-pushes and deletion. No status check is required yet; to require `node` and `cloud` once work goes through PRs:

  ```
  gh api -X PUT repos/boyangu/curator/branches/main/protection --input - <<'EOF'
  {
    "required_status_checks": { "strict": true, "checks": [{ "context": "node", "app_id": 15368 }, { "context": "cloud", "app_id": 15368 }] },
    "enforce_admins": false,
    "required_pull_request_reviews": null,
    "restrictions": null,
    "allow_force_pushes": false,
    "allow_deletions": false
  }
  EOF
  ```

## Supply chain

- Every third-party action in `.github/` is pinned by full commit SHA with the release in a trailing comment (`@<sha> # v4.4.0`); `dtolnay/rust-toolchain` has no releases, so its pin names the `stable` branch and is bumped by hand. flyctl is whatever the maintainer has installed; the release script uses it as found.
- The Dockerfile pins `node:22-slim` (Dependabot bumps it) and the BuildKit `# syntax` frontend (bumped by hand) by digest.
- Dependabot (`.github/dependabot.yml`) opens weekly PRs for npm (minor + patch grouped, Electron majors ignored), the actions and the base image.

## Logs and audit

Two tables in the `curator` schema (`sql/0002_audit.sql`), written by the API and readable by nobody but the owner:

- **`curator.request_log`**: one row per HTTP request, failures included (401, 404, 413, 429, 500), except a `health` call that succeeds (Fly's check, every 30 s per machine: 2,880 rows a day of nothing; a failing one is logged like any request): request id, procedure (the tRPC path, or `http:<status>` when tRPC never ran), status, reason, duration, ops pushed / pulled, bytes in / out, client IP (Fly's `Fly-Client-IP` only, never `X-Forwarded-For`), client (`x-curator-client`, e.g. `desktop/0.1.0 win32`). User and session ids come from the verified token only; the device id is the one a push, pull, bootstrap or catalogue call names (the client's word, trusted only once the token verified). **Kept 90 days**: the server prunes once a day from its snapshot timer; `node dist/snapshot.js --prune-logs [--older-than '90 days']` runs it by hand.
- **`curator.audit_event`**: security events, **never pruned**: `auth_failed`, `rate_limited`, `device_registered`, `device_revoked`, `device_reregister_refused` (`{ via }`), `push_from_revoked_device` (`{ ops, via }`), `read_from_revoked_device` (a refused `sync.pull` / `sync.bootstrap`, `{ procedure, via }`), `ops_rejected`, `client_ts_clamped`, `bootstrap_served` (a full-library export, `{ snapshotSeq, bytes, chunked, storage }`), `catalogue_rejected` (a put's per-item rejections as `{ procedure, byReason }`, or a catalogue call refused for a revoked device as `{ procedure, reason, via }` or for a missing entitlement as `{ procedure, reason }`), and the batch lifecycle (below): `batch_begun` (`{ batchId, label, resumed, stagedOps, expectedOps }`), `batch_committed` (`{ batchId, label, totalOps, insertedOps, rejected, fenceSeq, committedSeq, snapshotSeq, ms }`), `batch_aborted` (`{ batchId, label, stagedOps }`), `batch_expired` (`{ batchId, label, stagedOps, idleMs }`); and the snapshots (below): `snapshot_published` (`{ snapshotSeq, bytes, parts, pruned, superseded }`), `source_from_non_master` (a push or batchPush whose source ops came from a device that is not the master, `{ procedure, master, byKind }`; the ops are kept), `snapshot_verified` / `snapshot_mismatch` (the verifier CLI, `{ snapshotSeq, baseSeq, opsFolded, stateSha256, foldSha256 }`). A batch call or a publish from a revoked device is audited as `push_from_revoked_device`. `request_id` joins an event to its request while that row exists; the commit and the sweep raise theirs with none.

The catalogue procedures log like the sync ones, reusing the op columns as item counts: `catalogue.lookup` has `ops_in` = hashes asked and `ops_out` = items returned, `catalogue.put` has `ops_in` = items sent and `ops_out` = items accepted, `catalogue.inventory` has `ops_out` = entries returned. `device_id` is the calling device on all three (from the input, trusted once the token verified, as for a push). The batch procedures likewise: `sync.batchPush` has `ops_in` = ops sent, `sync.batchCommit` has `ops_out` = ops moved into the log so far.

Neither holds a token, an op payload, an email, a connection string or a query string. Every response carries `x-request-id` (the client's, when it sent a UUID), so a user's report can be matched to its row. Each request and event is also one JSON line on stdout (`fly logs`).

The API writes through `curator.log_requests` / `curator.log_audit_events` (SECURITY DEFINER, executable by `curator_api` only, see `sql/roles.sql`), buffered in memory and flushed every second or 100 rows, outside any user transaction. If a flush fails, the rows go to stdout as `request_log_unsaved` / `audit_event_unsaved` lines instead; the request never waits on or fails because of it. `authenticated` and `anon` have no grant on either table and RLS is on with no policy; `curator_api` cannot read, update or delete them. Read them in the SQL editor (as `postgres`):

```sql
-- One user's calls in the last day
select at, procedure, http_status, reason, duration_ms, ops_in, ops_out, device_id, client
from curator.request_log
where user_id = '<uuid>' and at > now() - interval '1 day'
order by at desc;

-- Auth failures by IP, last 7 days
select client_ip, reason, count(*) as n, max(at) as last
from curator.request_log
where http_status = 401 and at > now() - interval '7 days'
group by client_ip, reason
order by n desc;

-- Every security event for a user
select at, kind, device_id, detail, request_id
from curator.audit_event
where user_id = '<uuid>'
order by at desc;

-- Catalogue traffic per device, last day
select device_id, procedure, count(*) as calls, sum(ops_in) as items_in, sum(ops_out) as items_out
from curator.request_log
where user_id = '<uuid>' and procedure like 'catalogue.%' and at > now() - interval '1 day'
group by device_id, procedure
order by device_id, procedure;

-- Catalogue holdings per account against quota
select a.user_id, count(i.*) as items, coalesce(sum(i.data_bytes), 0) as inline_bytes,
	coalesce(sum(i.blob_bytes), 0) as blob_bytes, a.quota_bytes, a.entitled
from curator.catalogue_account a
left join curator.catalogue_item i on i.user_id = a.user_id
group by a.user_id, a.quota_bytes, a.entitled;
```

## Batches (`batches`, `sql/0007_library_op_batch.sql`)

A desktop's one-time backlog (the initial push of an existing library, a backfill after a protocol upgrade: ~116k ops on the main library, 2026-10-21) goes up as one per-user virtual transaction instead of ~230 plain pushes (`src/sync/batch.ts`):

- **`sync.batchBegin`** opens a batch per device and label (`initial-push`, `backfill`), or answers the one already open for it (a restarted desktop resumes it).
- **`sync.batchPush`** validates exactly like `sync.push` (same caps, schema gate, zod, provenance, clamp, per-op rejections) and stages the ops in `curator.library_op_staged`: no seq, no wake-up, read by no pull, bootstrap or snapshot. Staging an op twice is a no-op.
- **`sync.batchCommit`** starts the commit and answers its progress (`committing`, `movedOps` of `totalOps`), then `committed` with `committedSeq` and `priorOwnMaxSeq` (`snapshotSeq` is always 0: the commit builds no snapshot); asked again it answers the same. The commit runs in the background of whichever request or sweep holds the batch's lease: it fences the user's log at its head (`curator.library_op_fence`), moves the staged ops into `library_op` in chunks sized to ~3 s a statement (fresh seqs in the device's order, op ids the log already holds skipped, no per-chunk wake-up), then drops the fence and rings once. It builds no snapshot: the fence alone keeps the moved ops unseen, and the regular sweep snapshots them once the log has been quiet for 5 minutes (until then a new device bootstraps from the older snapshot and pulls the batch after it). Until then no reader passes the fence (`src/sync/visibility.ts` has the argument why no cursor can skip an op that becomes visible later); other devices' pushes keep landing above it and appear with the batch. Order of seqs is irrelevant to the result: the reducer is order-independent.
- **`sync.batchAbort`** drops an open batch and its staged ops; a committing one cannot be aborted.
- **Expiry**: an open batch idle for 24 h is expired by the sweep and its staged ops deleted (`batch_expired`); the device stages again under a new one. A commit whose runner died (machine gone) is finished by the next poll or sweep once its 2-minute lease lapses.

Measured on PGlite (an upper bound for the shape, not production timing) at 120k set-meta ops: staging 53 ms median per 500-op call; the commit's move in 16 statements of up to ~8k ops, max 3.3 s; the snapshot build 15 s (inside the commit then, the sweep's job now); the whole commit 57 s including that build (`src/sync/batch-scale.test.ts`, `CURATOR_BATCH_SCALE_OPS=120000`).

**Release order:** migration `0007` (`db:migrate`) → `roles.sql` (grants `users_due_for_snapshot_v2` and `batches_to_tend` to `curator_api`) → cloud release (the migration gate refuses to start without 0007) → desktop release. A desktop without batches keeps pushing plainly against the new server; a batches-aware desktop against an older server sees no `batches` in `features` and pushes plainly too.

## Snapshots (`snapshot_storage`, `sql/0008_snapshot_storage.sql`)

A snapshot is the reducer's raw state after every op up to its seq, so a new device downloads one file and pulls only what came after. Two kinds share `curator.library_snapshot` (exactly one of `body` / `storage` per row):

- **Published by the master** (the normal case). The account's master device (the `library.master_device` setting, LWW over its setting ops, read in one probe of the partial index `library_op_master_device`) already holds the fold in its records. It serialises it, gzips it, uploads it in content-addressed parts of ≤8 MiB to the `snapshots` bucket with its own session, and calls **`sync.publishSnapshot`** (`src/sync/publish-snapshot.ts`). The server never sees the bytes. It refuses `snapshot_part_invalid` (a path that is not `snapshotPartPath(uid, sha256)`, a duplicate, sizes that do not add up), `not_master` (the caller is not the current master, or none is stated), `snapshot_ahead` (a seq above the visible head, a batch's fence included) and `snapshot_part_missing` (a part not in `storage.objects` with the stated size, read under the caller's RLS); then it answers `stored`, or `exists` / `stale` with no write when a snapshot at or above that seq is there. The row keeps the manifest, `state_sha256` (sha256 of the serialised JSON) and `published_by`.
- **Folded by the server** (the fallback, `src/snapshot/job.ts`), gzipped canonical JSON in `body`, written and read as bytea through the driver (never base64'd inside Postgres) in several short transactions under a per-user lease (`curator.library_snapshot_lease`). It always starts from the newest *bodied* snapshot (the API holds no Storage key and never reads a published one). The sweep (`users_due_for_snapshot_v3`) leaves an account alone while its newest snapshot is master-published and younger than 7 days; past that (a master that never publishes, or went quiet) it folds as before.

**Retention**: the newest 3 snapshots, plus always the newest bodied one (the fold's base, and what an older desktop loads). Storage rows are pruned only by `publishSnapshot`, which answers `superseded`: the parts of the rows it dropped (or, on `exists` / `stale`, the call's own parts) that no kept manifest lists, for the master to delete. The fold prunes bodied rows only.

**Reading them.** `sync.bootstrap` with `storage: true` answers the newest of either kind: a published one as `{ snapshot: '', snapshotSeq, encoding, storage: <manifest> }` (the client downloads the parts, checks size and sha256, inflates). Any other client gets the newest bodied snapshot (an older seq is fine; it pulls the rest) inline, or — asking `chunked: true` (`snapshot_chunks`) — its seq and size, with `sync.snapshotChunk` serving the body in pieces of at most 4 MiB (`substring` of the bytea, bodied rows only). The far-behind hint on `sync.pull` names the newest bodied snapshot only: a pull does not say whether its client reads Storage, and an older client sent to a published seq would bootstrap to an older bodied one, be told again on its next pull, and download the library every cycle. Measured 2026-10-21 on the main library at protocol v4: 227 MB of JSON, 36.7 MB gzipped.

**Checking a master.** `node dist/snapshot.js verify --user <uuid>` folds the log from the newest bodied snapshot up to the newest published one's seq, hashes the serialised JSON and compares it with `state_sha256` (`snapshot_verified` / `snapshot_mismatch` in audit_event, exit 1 on a mismatch). It holds the whole library in memory, so a person runs it, never the timer.

**Release order:** migration `0008` (`db:migrate`) → `roles.sql` (grants `users_due_for_snapshot_v3`) → `storage.sql` (the `snapshots` bucket) → cloud release (the migration gate refuses to start without 0008) → desktop release. An older desktop keeps bootstrapping from bodied snapshots. Rolling the server back past this release once a master has published needs the published rows deleted first (`delete from curator.library_snapshot where storage is not null`): an older image reads `body` without expecting null.

## Revoking a device

`account.revokeDevice` is final for that device id, and since `0006_device_session.sql` it cuts off **reads** as well as pushes: `sync.pull`, `sync.bootstrap`, `catalogue.*`, `account.devices` / `revokeDevice` / `registerDevice` all answer `FORBIDDEN` / `device_revoked` (`src/account/device-gate.ts`). Two facts decide it, in the request's own transaction:

- **The device the call names.** Revoked → refused, from any session.
- **The device the call's Supabase session acts as.** `curator.device_session` binds each session (the token's `session_id` claim) to the device it last named on a register, push, pull, bootstrap or catalogue call. A session bound to a revoked device is refused everything, whatever device it names and whether it names one at all, and it cannot register a fresh device id to escape. Coming back takes a new sign-in, i.e. the user's credentials. One row per session, so an install that re-mints its device id (a restored backup) moves its binding, and revoking its stale old id later does not cut it off.

Every refusal is audited (`read_from_revoked_device`, `push_from_revoked_device`, `catalogue_rejected`, `device_reregister_refused`), with `via: 'device' | 'session'`.

**The transition (`device_reads`).** Desktops before this release send no device id on `sync.pull` (unless they use the own-op skip) and no input on `sync.bootstrap`. The server keeps serving those, judged by the session alone, and advertises `device_reads` in `features` (health, push, pull) so newer desktops always name themselves. The gap while it lasts: a revoked device whose session the server has never bound (it has made no call since `0006` shipped) can still read with an older desktop. Close it once every install runs a `device_reads` desktop by setting `CURATOR_REQUIRE_DEVICE_ID=1` (fly.toml `[env]`): nameless reads then answer `update_required`, which older desktops already show as "Update Curator to keep syncing". `MIN_SUPPORTED_SCHEMA_VERSION` is not the lever: it gates op shapes, not reads, and bumping it would also refuse the ops older desktops hold.

**Release order:** migration `0006` → `roles.sql` (idempotent, as always) → `storage.sql` → cloud release → desktop release → later, `CURATOR_REQUIRE_DEVICE_ID=1`. A desktop with `device_reads` support against an older server simply sees no `device_reads` in `features` and pulls as before.

**What the server cannot do.** It holds no admin key, so it cannot end a Supabase session: the revoked device's refresh token keeps minting access tokens until someone signs it out. The desktop's Settings → Account → "Sign out all other sessions" (Supabase `signOut({ scope: 'others' })` from the user's own session) does that; access tokens already issued live until they expire (≤ 1 h). In that window, and for anything outside this API:

- **Storage**: the `catalogue` and `snapshots` buckets' policies (`sql/storage.sql`) also require `not curator.session_revoked()`, which reads the session's binding from the request's own JWT claims, so a bound revoked session can no longer list, download, upload or delete there. A session never bound (see the transition) is not caught by it.
- **Realtime**: the `user:<uid>` wake-up channel stays open to it. It carries `{ seq }` only, a doorbell with no library data, so this is accepted.

## Notes

- **Why the master publishes.** The server's fold held a 227 MB state in a 512 MB API process, and the API can neither write a bucket (no service key, and the job runs with no user session) nor read one. The master has the fold already and a session to write with, so the server only verifies and indexes (see "Snapshots").
- **Protocol drift to fix** (`src/wire.ts`): the protocol's `BootstrapResult` says `snapshotUrl`, this server returns `{ snapshot, snapshotSeq, encoding }`; the protocol's `listDevices` is `account.devices` here; the snapshot decoder (`src/snapshot/codec.ts`) has to move into `packages/protocol` before a client can bootstrap.
- **Rate limits** are in-memory per machine (10 pushes/s per device, shared by the four batch procedures; 100 pulls/min per session; catalogue calls 20 burst / 5 per s per device), answered with `TOO_MANY_REQUESTS`, `data.retryAfterSec` and a `Retry-After` header.

## Catalogue

Analysis one device computed, shared with the same user's other devices (workstream D, phase 1; the protocol is `packages/protocol/src/catalogue.ts`). Items are keyed by `(audio hash, unit, variant, version)`. Inline units (rhythm, key, structure, advanced, fingerprint) are jsonb in `curator.catalogue_item`; peaks (`.cpk`) and vector packs (`.cvec`, `catalogue-pack.ts`) are objects in the `catalogue` bucket that devices upload and download themselves with their own session, and a row names its object. The API holds no service key and never touches object bytes: `catalogue.put` checks each named object exists in `storage.objects` with the stated size, under the caller's RLS.

- **`catalogue.lookup`** (POST): ≤50 hashes and a want list (unit, optional variant, `minVersion`, `maxSchema`); answers the newest acceptable version per hash / unit / variant.
- **`catalogue.put`**: ≤100 items, ≤1 MiB. Per-item rejections (`invalid_item`, `unit_disabled`, `blob_path_invalid`, `blob_missing`, `blob_size_mismatch`, `quota_exceeded`, `version_outdated`, `duplicate_in_batch`); the rest is upserted, bumping `rev`. The newest two versions per key are kept; blob paths no item references any more come back as `superseded` for the device to delete. Whole-call refusals: `catalogue_not_entitled` (no `catalogue_account` row), `device_not_registered`, `device_revoked`, `batch_too_large`.
- **`catalogue.inventory`**: the account's items after a rev (≤5000 a page), with the account's usage, quota, entitlement and the server's policy.

**Stages (D-a / D-b)** are the `CURATOR_CATALOGUE` setting, not code. D-a (now, Supabase Free): `rhythm,key,structure,advanced,fingerprint,peaks:lo`; hi peaks and vectors are refused as `unit_disabled`. D-b (after a plan upgrade): add `peaks:hi,vectors` in `fly.toml`, raise the account's `quota_bytes`, release. The server advertises its policy in `health` (`features` lists `catalogue`, `catalogue.policy` names the units) and on every inventory page; the desktop uploads and hydrates only what it allows. With the setting off, `features` omits `catalogue` and the procedures answer `catalogue_disabled`.
