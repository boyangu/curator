# @curator/cloud

The cloud API: a per-user op log behind tRPC (`sync.push`, `sync.pull`, `sync.bootstrap`, `account.registerDevice` / `devices` / `revokeDevice`, `health`). It stores ops and periodic snapshots of the folded library state; it never writes to Spotify, Tidal, rekordbox or files. Design: `planning/tech/cloud.md` ("Server API", "Schema versioning and security", "Bootstrap, snapshots and history retention").

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

## Database setup (Supabase project)

Once, in this order. Before you start, delete the spike's objects from `public` (`library_op`, `push_ops`, `pull_ops`, `library_op_wake`, the "owner receives own wakeups" policy on `realtime.messages`) and the spike user.

1. **Migrations**, with the owner connection (Project Settings → Database → connection string, user `postgres`), from your machine:

   ```
   DATABASE_URL='postgres://postgres.<ref>:<owner password>@<pooler host>:5432/postgres' pnpm --filter @curator/cloud db:migrate
   ```

   It creates the `curator` schema and records each applied file in `curator.schema_migration` with a checksum. Re-running is a no-op; editing an applied file is refused. A fix goes in the next numbered file (`sql/0004_*.sql`). The SQL files are plain SQL, so pasting one into the SQL editor works too, but then the runner does not know it ran.

2. **The API role**: paste `sql/roles.sql` into the SQL editor and run it (as `postgres`). Then, separately and never in a file:

   ```sql
   alter role curator_api with password '<generate 32+ random chars>';
   ```

   `curator_api` can log in and do nothing as itself. Each request switches to `authenticated` in its transaction with the caller's JWT claims, so RLS decides every row. If `grant authenticated to curator_api` is refused, the project's `postgres` lacks admin option on `authenticated`; ask Supabase support or run that one line from a session that has it.

3. **`DATABASE_URL`** for the API, through the session pooler (port 5432) or the transaction pooler (6543; the driver already runs without prepared statements):

   ```
   postgres://curator_api.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```

4. **Data API exposed schemas.** Devices reach only Auth and Realtime; the library goes through this API. Dashboard → Project Settings → Data API → Exposed schemas: remove `public`, and do not add `curator`. Remove `graphql_public` too unless something uses GraphQL. With both gone, PostgREST serves no table to a device even with a valid token; RLS is the second wall, not the first.

5. **Realtime.** Nothing to toggle: the wake-up is a broadcast from a trigger on the private channel `user:<uid>` and the subscribe policy is created by 0001. Realtime Authorization must stay on (the default).

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
3. Then release.

The server enforces the order. At boot it compares the migration files it ships (`sql/NNNN_*.sql`, not `roles.sql`) with `curator.applied_migrations()` (0003, executable by `curator_api` only, which has no read on `curator.schema_migration` itself) and, if any is missing, logs `schema_behind` with the missing files and a hint, and exits. The new machine never passes the health check, the deploy fails, and the previous release keeps serving. A database *ahead* of the image (a rollback onto a newer schema) starts with a `schema_ahead` warning, since migrations are additive.

**One-time Fly setup**, from the repo root (none of this deploys code):

```
fly apps create <app>
# set primary_region in apps/cloud/fly.toml to the region nearest the Supabase project, and commit that
fly secrets set --stage --app <app> DATABASE_URL='...' SUPABASE_URL='https://<ref>.supabase.co'
```

`--stage` stores the secrets without restarting machines; the next release picks them up. The health check is `GET /trpc/health` (`{ ok, schemaVersion, minSupportedSchemaVersion, commit }`). Snapshots build inside the running machine every 15 minutes for users with 10k new ops or a day-old snapshot; `node dist/snapshot.js [--user <uuid>]` in `fly ssh console` runs one on demand.

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

- **`curator.request_log`**: one row per HTTP request, failures included (401, 404, 413, 429, 500): request id, procedure (the tRPC path, or `http:<status>` when tRPC never ran), status, reason, duration, ops pushed / pulled, bytes in / out, client IP (Fly's `Fly-Client-IP` only, never `X-Forwarded-For`), client (`x-curator-client`, e.g. `desktop/0.1.0 win32`). User and session ids come from the verified token only, the device id from a verified push only. **Kept 90 days**: the server prunes once a day from its snapshot timer; `node dist/snapshot.js --prune-logs [--older-than '90 days']` runs it by hand.
- **`curator.audit_event`**: security events, **never pruned**: `auth_failed`, `rate_limited`, `device_registered`, `device_revoked`, `device_reregister_refused`, `push_from_revoked_device`, `ops_rejected`, `client_ts_clamped`, `bootstrap_served` (a full-library export). `request_id` joins an event to its request while that row exists.

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
```

## Notes

- **Snapshots in Postgres.** `curator.library_snapshot` holds the reducer's raw state, gzipped canonical JSON, three per user; `sync.bootstrap` returns the newest inline as base64. Moving them to R2 later changes only `bootstrap` and the job.
- **Protocol drift to fix** (`src/wire.ts`): the protocol's `BootstrapResult` says `snapshotUrl`, this server returns `{ snapshot, snapshotSeq, encoding }`; the protocol's `listDevices` is `account.devices` here; the snapshot decoder (`src/snapshot/codec.ts`) has to move into `packages/protocol` before a client can bootstrap.
- **Rate limits** are in-memory per machine (10 pushes/s per device, 100 pulls/min per session), answered with `TOO_MANY_REQUESTS`, `data.retryAfterSec` and a `Retry-After` header.
