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

Production deploys come only from CI, from a tagged commit on `main`: never `fly deploy` from a laptop or a working tree (security review, risk 3). [`.github/workflows/deploy-cloud.yml`](../../.github/workflows/deploy-cloud.yml) does it:

1. **Merge to `main`** through a PR, with `node` and `cloud` green.
2. **Run the migrations first** if the release adds a `sql/` file (below).
3. **Tag the merge commit** and push the tag:

   ```
   git tag cloud-v0.2.0 <commit on main>
   git push origin cloud-v0.2.0
   ```

   The workflow resolves the tag, fails unless its commit is an ancestor of `main` (`git merge-base --is-ancestor`), then runs the same install / typecheck / test / build as CI ([`.github/actions/cloud-check`](../../.github/actions/cloud-check/action.yml)). A tag that was pushed by mistake can be re-run by hand: Actions → deploy-cloud → Run workflow, from `main`, with `ref` = the tag.
4. **Approve** the `production` deployment: Actions → the run → Review deployments → production → Approve. (Only where required reviewers are available, see the plan note below; otherwise the job starts on its own.)
5. The deploy job builds the image on Fly's remote builder from that commit, with `--build-arg GIT_SHA=<commit>` and `--image-label <tag>`, passing `--app` from the `FLY_APP` repository variable (the workflow fails at once if it is unset; `fly.toml` carries no app name), and **polls `https://<FLY_APP>.fly.dev/trpc/health` until `commit` is the deployed SHA**; it fails after 3 minutes otherwise. Check it yourself with `curl -s https://<FLY_APP>.fly.dev/trpc/health`.

Concurrent releases queue: one deploy at a time, none cancelled midway. Rolling back is a release too: tag the older commit (it is on `main`) as a new `cloud-v*` version.

**Migrations come before the tag**, in this order:

1. The owner runs the new migrations from their machine (Database setup, step 1): `DATABASE_URL='<owner connection>' pnpm --filter @curator/cloud db:migrate`.
2. The owner re-runs `sql/roles.sql` (step 2), always: it is idempotent, and a migration that adds a function the API calls (`0002_audit.sql`, `0003_migration_check.sql`) needs its grant.
3. Then tag the release.

The server enforces the order. At boot it compares the migration files it ships (`sql/NNNN_*.sql`, not `roles.sql`) with `curator.applied_migrations()` (0003, executable by `curator_api` only, which has no read on `curator.schema_migration` itself) and, if any is missing, logs `schema_behind` with the missing files and a hint, and exits. The new machine never passes the health check, the deploy fails, and the previous release keeps serving. A database *ahead* of the image (a rollback onto a newer schema) starts with a `schema_ahead` warning, since migrations are additive. The release that introduces the gate needs 0003 applied and `roles.sql` re-run before it can boot (`reason: no_check_function` or `no_grant` otherwise).

**One-time Fly setup**, from the repo root (none of this deploys code):

```
fly apps create <app>            # the name goes into the FLY_APP repository variable (below), never into the tree
# set primary_region in apps/cloud/fly.toml to the region nearest the Supabase project, and merge that
fly secrets set --stage --app <app> --config apps/cloud/fly.toml DATABASE_URL='...' SUPABASE_URL='https://<ref>.supabase.co'
```

`--stage` stores the secrets without restarting machines; the next release picks them up. The health check is `GET /trpc/health` (`{ ok, schemaVersion, minSupportedSchemaVersion, commit }`). Snapshots build inside the running machine every 15 minutes for users with 10k new ops or a day-old snapshot; `node dist/snapshot.js [--user <uuid>]` in `fly ssh console` runs one on demand.

## One-time GitHub settings

Applied by hand, once, by the repo admin. Each has the click-path and the equivalent `gh` command (run as `boyangu`, `gh auth switch -u boyangu`).

> **Plan note (checked against GitHub's docs, 2026-10-19).** `boyangu/curator` is a private, user-owned repo, which limits what is available:
> - Environment **secrets**, environment **deployment branch/tag policies** and **branch protection** need GitHub **Pro** (or Team) on a private repo. On Free, `FLY_API_TOKEN` can only be a repository secret, readable by any workflow on any branch, and `main` cannot be protected. Pro is the minimum this pipeline assumes.
> - Environment **required reviewers** on a private repo need GitHub **Enterprise**; on Free, Pro and Team they exist for public repos only, so step 1's `reviewers` is refused (or ignored) and the deploy job starts without an approval. What still gates production then: a tag only deploys a commit on `main`, `main` only takes green PRs, and the environment only accepts runs from `cloud-v*` tags or `main`.
> - **Secret scanning and push protection** are not offered for private user-owned repos on any GitHub.com personal plan (they need GitHub Secret Protection on an organization with Team or Enterprise). Step 5 is refused until the repo moves to such an organization; meanwhile `.env` files stay git-ignored and the image never reads one.
> - **Dependabot alerts** and security updates work on every plan.

1. **`production` environment** with a required reviewer, and deployments allowed only from `cloud-v*` tags and `main` (manual re-runs start from `main`).
   Settings → Environments → New environment → `production` → Required reviewers: `boyangu` (leave "Prevent self-review" off: you are the one tagging) → Deployment branches and tags: Selected branches and tags → Add rule → Tag, `cloud-v*` → Add rule → Branch, `main` → Save protection rules.

   ```
   gh api -X PUT repos/boyangu/curator/environments/production --input - <<'EOF'
   {
     "reviewers": [{ "type": "User", "id": 2485062 }],
     "prevent_self_review": false,
     "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
   }
   EOF
   gh api -X POST repos/boyangu/curator/environments/production/deployment-branch-policies -f name='cloud-v*' -f type=tag
   gh api -X POST repos/boyangu/curator/environments/production/deployment-branch-policies -f name=main -f type=branch
   ```

   (`2485062` is `boyangu`'s user id, `gh api users/boyangu --jq .id`.)

2. **`FLY_APP` as a repository variable**: the Fly app name. The workflow passes it as `--app` and builds the health URL from it; it refuses to deploy while the variable is unset. Variables are not secrets (an app name is a hosting identifier, kept out of the tree, not a credential).
   Settings → Secrets and variables → Actions → Variables → New repository variable → `FLY_APP`.

   ```
   gh variable set FLY_APP --body <app> --repo boyangu/curator
   ```

3. **`FLY_API_TOKEN` as an environment secret** of `production`, a deploy token scoped to this one app (the workflow references no other secret). Mint it and hand it straight to GitHub without it touching the clipboard or a file:
   Settings → Environments → production → Environment secrets → Add environment secret → `FLY_API_TOKEN`, value from `fly tokens create deploy -a <app>`.

   ```
   fly tokens create deploy -a <app> | gh secret set FLY_API_TOKEN --env production --repo boyangu/curator
   ```

   Add `--expiry 8760h` to the `fly tokens create` for a token that lapses after a year; `fly tokens list -a <app>` and `fly tokens revoke <id>` rotate it. Delete any older repository-level `FLY_API_TOKEN` (`gh secret delete FLY_API_TOKEN --repo boyangu/curator`) so only the environment holds one.

4. **Branch protection on `main`**: require the `node` and `cloud` checks from GitHub Actions, up to date before merging, through a PR, no force-push or deletion, admins included.
   Settings → Branches → Add branch protection rule → Branch name pattern `main` → Require a pull request before merging (required approvals: 0, a solo repo cannot approve its own PRs) → Require status checks to pass before merging → Require branches to be up to date → add `node` and `cloud` → Do not allow bypassing the above settings → Create. (`cloud` is skipped when no cloud file changed; a skipped job counts as passed. The checks appear in the picker once they have run on a PR.)

   ```
   gh api -X PUT repos/boyangu/curator/branches/main/protection --input - <<'EOF'
   {
     "required_status_checks": {
       "strict": true,
       "checks": [{ "context": "node", "app_id": 15368 }, { "context": "cloud", "app_id": 15368 }]
     },
     "enforce_admins": true,
     "required_pull_request_reviews": { "required_approving_review_count": 0 },
     "restrictions": null,
     "allow_force_pushes": false,
     "allow_deletions": false
   }
   EOF
   ```

   (`15368` is the GitHub Actions app, so only Actions can satisfy the checks.) This ends direct pushes to `main`, admin included; set `enforce_admins` to `false` to keep an emergency bypass.

5. **Secret scanning and push protection** (see the plan note).
   Settings → Advanced Security (older UI: Code security and analysis) → Secret Protection: Enable → Push protection: Enable.

   ```
   gh api -X PATCH repos/boyangu/curator --input - <<'EOF'
   { "security_and_analysis": { "secret_scanning": { "status": "enabled" }, "secret_scanning_push_protection": { "status": "enabled" } } }
   EOF
   ```

6. **Dependabot alerts and security updates** (version updates come from `.github/dependabot.yml` on their own).
   Settings → Advanced Security → Dependency graph: Enable → Dependabot alerts: Enable → Dependabot security updates: Enable.

   ```
   gh api -X PUT repos/boyangu/curator/vulnerability-alerts
   gh api -X PUT repos/boyangu/curator/automated-security-fixes
   ```

Check what took: `gh api repos/boyangu/curator/environments/production`, `gh api repos/boyangu/curator/branches/main/protection`, `gh api repos/boyangu/curator/vulnerability-alerts` (204 = on).

## Supply chain

- Every third-party action in `.github/` is pinned by full commit SHA with the release in a trailing comment (`@<sha> # v4.4.0`); `dtolnay/rust-toolchain` has no releases, so its pin names the `stable` branch and is bumped by hand. flyctl is pinned in the deploy workflow (`version:`), also by hand.
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
