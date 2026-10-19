# Op-log round-trip spike

Measures how long an op takes to travel device B -> Supabase -> device A when the log is a
plain table, pushes go through an RPC, and the "something new" signal is a Postgres trigger
broadcasting on a private Realtime channel. One Node process plays both devices, signed in as
the same user, so the headline latency is skew-free.

Files: `schema.sql` (table, RLS, `push_ops`, `pull_ops`, wake-up trigger, channel policy),
`run.mjs` (the two devices and the report), `package.json` + `pnpm-lock.yaml` (standalone
install), and `pnpm-workspace.yaml`, which exists only so `pnpm install` here does not walk
up into the repo workspace (`research/` is outside `apps/*` and `packages/*`).

## Setup (once)

1. Create a free project at supabase.com. Pick the region closest to you: round-trip time
   dominates every number below.
2. SQL Editor -> new query -> paste all of `schema.sql` -> Run. It is re-runnable. You do
   **not** need the table's "Enable Realtime" toggle (that is the WAL publication for
   `postgres_changes`); broadcast rides on `realtime.messages`. What the channel does need
   is Realtime Authorization (on by default) plus the `realtime.messages` SELECT policy that
   `schema.sql` creates, because `user:<uid>` is a private channel.
3. Authentication -> Users -> Add user -> Create new user. Email + password, and tick
   **Auto Confirm User**, otherwise sign-in fails with "Email not confirmed". The Email
   provider is enabled by default.
4. Project Settings -> API: copy the Project URL and the `anon` public key (the newer
   `publishable` key works with supabase-js too).

Set the four variables in the shell that will run the spike:

```powershell
$env:SUPABASE_URL = 'https://<ref>.supabase.co'
$env:SUPABASE_ANON_KEY = '<anon key>'
$env:SPIKE_EMAIL = '<user email>'
$env:SPIKE_PASSWORD = '<user password>'
```

## Run

```
cd research/cloud/oplog-spike
pnpm install
node run.mjs                 # trigger-driven wake-ups (the design under test)
node run.mjs --no-realtime   # same pushes, device A polls every 1 s, for comparison
node run.mjs --ops=100       # smoke test; also --batch=N --delay=MS
```

Do a throwaway run first: the free tier cold-starts the Realtime connection and the
PostgREST schema cache, and the first numbers are not representative.

## Reading the output

```
sent 1000  received 1000  missing 0  duplicates 0  foreign 0
wake-ups 20  pulls 20  pages 20
latency enqueue -> applied   p50 ...  p95 ...  max ... ms
  push leg   client_ts -> received_at   ...   (server clock, includes skew)
  fan-out    received_at -> applied     ...   (server clock, includes skew)
push_ops rpc                 p50 ...  p95 ...  max ... ms
elapsed: push 2.4 s, drain after last push 0.3 s, total 5.1 s
re-push of one batch: head seq 1020 -> 1020, wake-ups +0, new rows 0  ok
```

- **latency enqueue -> applied** is the number that matters: from B stamping `client_ts`
  (just before the `push_ops` call) to A having the row in hand after a pull. In poll mode
  it includes up to 1 s of waiting for the next tick.
- The two legs split it at the server's `received_at`. They are measured against the
  server clock, so they carry whatever skew your machine has against Postgres; read them
  for shape (is the time in the push or in the fan-out?), not as absolutes.
- **wake-ups** should equal the number of batches (20 for the defaults): the trigger is
  per statement, and `push_ops` inserts a batch in one statement. **pulls** <= wake-ups + 1,
  because a wake-up that lands mid-pull only marks the receiver dirty, and one whose `seq`
  is already held is skipped. **pages** counts `pull_ops` calls (500 rows each).
- **duplicates** is an op_id seen twice by A; **foreign** is a row that is not from this
  run (another run against the same user at the same time). Both should be 0.
- **re-push** resends one already-accepted batch verbatim. Idempotency holds when the
  head seq is unchanged, no wake-up fires (rows skipped by `on conflict` are not in the
  trigger's transition table) and A pulls nothing new.
- Exit code: 0 all good; 1 ops still missing after the 30 s grace period; 2 duplicates or a
  leaky re-push; 64 bad usage; 70 a runtime error (the message says which call).

The table keeps rows across runs; each run starts from the current head seq, so that is
harmless. To empty it: `delete from public.library_op;` in the SQL editor.

## Caveats and things to decide

- **Free projects pause after 7 days without activity.** Restore from the dashboard before a
  re-run; the first run after a restore is slow.
- Free-tier Realtime quotas (200 concurrent connections, 2M messages/month) are nowhere near
  this spike, but the default per-project rate limit is 100 events/s. The per-statement
  trigger sends 1 message per batch (10/s at the defaults). A per-row trigger would send 50
  per batch and brush that limit at two batches per second; that, plus 50 WAL records per
  batch for the Realtime server to read, is why the trigger is per statement.
- `push_ops` takes a per-user transaction-scoped advisory lock so seq order equals commit
  order. That closes the gap race (a slow transaction holding seq 100 committing after seq
  101 was already pulled past) at the cost of serializing one user's pushes. With one active
  device per user that is free; decide whether that holds for the product.
- `op_id` is globally unique as specified. Scoping it `(user_id, op_id)` would be the call if
  ids are ever minted outside the client.
- The `authenticated` role has an 8 s statement timeout on hosted projects; batches of 50
  are far below it, but it caps how large a batch can get.
- Both devices share one machine, so the headline latency has no clock skew. A real second
  device adds its own skew to any `client_ts`-based number; use the server's `received_at`
  for cross-device ordering, never `client_ts`.

## Troubleshooting

- `subscribe CHANNEL_ERROR` on A: the `realtime.messages` policy is missing (re-run
  `schema.sql`) or the JWT was not set on the socket.
- `Could not find the function public.push_ops`: PostgREST's schema cache is stale; run
  `notify pgrst, 'reload schema';` in the SQL editor.
- Rows arrive in `--no-realtime` mode but never via wake-ups: `realtime.send` swallows
  errors as warnings. Logs -> Postgres, search for `WarnSendingBroadcastMessage`.

## Where the broadcast functions were confirmed

- Docs: https://supabase.com/docs/guides/realtime/broadcast (section "Broadcast from the
  database"), https://supabase.com/docs/guides/realtime/subscribing-to-database-changes
  (the `broadcast_changes` trigger example, FOR EACH ROW, SECURITY DEFINER) and
  https://supabase.com/docs/guides/realtime/authorization (`realtime.messages` policies,
  `realtime.topic()`, `extension = 'broadcast'`).
- Source of truth, the Realtime tenant migrations:
  `realtime.send(payload jsonb, event text, topic text, private boolean default true)` in
  https://github.com/supabase/realtime/blob/main/lib/realtime/tenants/repo/migrations/20251103001201_broadcast_send_include_payload_id.ex
  (warning text renamed in `20260605120000_rename_broadcast_send_warning.ex`), and both
  signatures listed in
  https://github.com/supabase/realtime/blob/main/lib/realtime/tenants/repo/migrations/20260707120000_restrict_realtime_schema.ex:
  `realtime.send(jsonb, text, text, boolean)` and
  `realtime.broadcast_changes(text, text, text, text, text, record, record, text)`.
- `realtime.send` is used. `broadcast_changes` wants one NEW/OLD record pair and sends the
  row as payload, which neither fits a statement-level trigger nor a wake-up-only message.
