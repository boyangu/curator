-- Curator cloud, migration 0001: the per-user op log, its snapshots and the device registry.
--
-- Applied by src/db/migrate.ts with the schema owner's connection (`postgres` on Supabase),
-- never with the API's login role; sql/roles.sql runs after it. Grown from the validated spike
-- (research/cloud/oplog-spike/schema.sql): same per-user advisory lock, same statement-level
-- `realtime.send` wake-up, moved out of `public` so the Data API exposes none of it.
--
-- Relies on what a Supabase project provides: `auth.uid()`, `auth.users`, `realtime.send`,
-- `realtime.messages`, `realtime.topic()` and the `anon` / `authenticated` roles. The tests
-- shim exactly those (src/test/supabase-shim.ts).

-- `if not exists`: the runner creates the schema first to hold its own bookkeeping table.
create schema if not exists curator;
revoke all on schema curator from public;
grant usage on schema curator to authenticated;

-- ── library_op ──────────────────────────────────────────────────────────────────────────────
-- One immutable row per accepted op. `user_id` comes from the JWT through `auth.uid()`, never
-- from the client: the API does not insert it, the default does, and the RLS check rejects any
-- other value. `seq` is a global identity, so a user's seqs have gaps (other users' rows, rows
-- skipped by `on conflict`): clients cursor with `seq > last`, never `seq = last + 1`.
--
-- `client_ts` is the device's epoch-ms clock (protocol `client_ts`), clamped on push; bigint
-- rather than timestamptz so the LWW stamp round-trips exactly. `received_at` is the server
-- stamp it was clamped against.
create table curator.library_op (
	user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
	seq bigint generated always as identity primary key,
	op_id uuid not null unique,
	device_id text not null,
	client_ts bigint not null,
	schema_version int not null,
	entity text not null,
	entity_id text not null,
	kind text not null,
	payload jsonb not null,
	received_at timestamptz not null default now()
);

-- Every pull, push head and snapshot fold reads one user's ops in seq order.
create index library_op_user_seq on curator.library_op (user_id, seq);

alter table curator.library_op enable row level security;

-- `(select auth.uid())` rather than bare `auth.uid()`: the planner evaluates the subselect once
-- per statement instead of once per row, which matters on 1000-row pulls.
create policy library_op_select on curator.library_op
	for select to authenticated
	using (user_id = (select auth.uid()));

create policy library_op_insert on curator.library_op
	for insert to authenticated
	with check (user_id = (select auth.uid()));

-- Append-only: no update or delete grant exists, so history cannot be rewritten through the API.
grant select, insert on curator.library_op to authenticated;

-- Wake-up: one broadcast per INSERT statement, not per row. The API lands a whole push in a
-- single INSERT ... SELECT, so a 500-op batch costs one realtime.messages row and one frame; the
-- transition table also makes an idempotent re-push free, because rows skipped by `on conflict`
-- are not in it. The payload is a doorbell ({seq}), never data: the table is the source of truth.
--
-- SECURITY DEFINER so the insert into realtime.messages runs as the owner; `authenticated` has no
-- business writing there. realtime.send swallows failures as WARNINGs, so a permissions miss shows
-- up as silent no-wake-ups (devices still converge on the 60 s fallback pull).
create function curator.library_op_wake()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	r record;
begin
	for r in select user_id, max(seq) as seq from inserted group by user_id loop
		perform realtime.send(jsonb_build_object('seq', r.seq), 'wake', 'user:' || r.user_id::text, true);
	end loop;
	return null;
end;
$$;

revoke execute on function curator.library_op_wake() from public;

create trigger library_op_wake
	after insert on curator.library_op
	referencing new table as inserted
	for each statement
	execute function curator.library_op_wake();

-- Private-channel authorisation: Realtime evaluates this when a client joins `user:<uid>` with
-- private: true. No INSERT policy, because clients never publish on the channel; the trigger does.
create policy curator_owner_wakeups on realtime.messages
	for select to authenticated
	using (
		realtime.messages.extension = 'broadcast'
		and realtime.topic() = 'user:' || (select auth.uid())::text
	);

-- ── library_snapshot ────────────────────────────────────────────────────────────────────────
-- The reducer's raw LibraryState after folding every op up to `snapshot_seq`, gzipped canonical
-- JSON (src/snapshot/codec.ts). Raw state, not the materialised view: it keeps every record's
-- clock, so ops pulled after the snapshot merge onto it exactly as they would onto a replay.
-- In Postgres rather than R2 for v1: a 40k-track library is a few MB and one row read.
create table curator.library_snapshot (
	user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
	snapshot_seq bigint not null check (snapshot_seq >= 0),
	created_at timestamptz not null default now(),
	body bytea not null,
	primary key (user_id, snapshot_seq)
);

alter table curator.library_snapshot enable row level security;

create policy library_snapshot_select on curator.library_snapshot
	for select to authenticated
	using (user_id = (select auth.uid()));

create policy library_snapshot_insert on curator.library_snapshot
	for insert to authenticated
	with check (user_id = (select auth.uid()));

-- The job prunes all but the newest few; ops are never deleted, so an old snapshot is
-- reproducible from the log.
create policy library_snapshot_delete on curator.library_snapshot
	for delete to authenticated
	using (user_id = (select auth.uid()));

grant select, insert, delete on curator.library_snapshot to authenticated;

-- ── device ──────────────────────────────────────────────────────────────────────────────────
-- One row per install (protocol `RegisterDeviceInput`). A revoked device keeps its row so its
-- pushes keep being refused; registering again does not clear `revoked_at`.
create table curator.device (
	user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
	device_id text not null check (char_length(device_id) between 1 and 128),
	name text not null check (char_length(name) between 1 and 200),
	platform text not null check (platform in ('win32', 'darwin', 'linux', 'ios', 'android')),
	created_at timestamptz not null default now(),
	last_seen_at timestamptz,
	revoked_at timestamptz,
	primary key (user_id, device_id)
);

alter table curator.device enable row level security;

create policy device_select on curator.device
	for select to authenticated
	using (user_id = (select auth.uid()));

create policy device_insert on curator.device
	for insert to authenticated
	with check (user_id = (select auth.uid()));

create policy device_update on curator.device
	for update to authenticated
	using (user_id = (select auth.uid()))
	with check (user_id = (select auth.uid()));

grant select, insert on curator.device to authenticated;
-- Column-level: identity and `created_at` are fixed once written.
grant update (name, platform, last_seen_at, revoked_at) on curator.device to authenticated;

-- ── snapshot scheduling ─────────────────────────────────────────────────────────────────────
-- The one cross-user read: which users have enough new ops (or old enough ones) to deserve a new
-- snapshot. It returns ids only and is executable by the API's login role alone (sql/roles.sql),
-- never by `authenticated`; the fold itself then runs per user under RLS like any request.
-- Users are enumerated from `device`, which every pushing user has a row in (push requires a
-- registered device), so the scan is over a small table rather than the whole log.
create function curator.users_due_for_snapshot(min_ops bigint, max_age interval)
returns table (user_id uuid, new_ops bigint)
language sql
stable
security definer
set search_path = ''
as $$
	select u.user_id, n.new_ops
	from (select distinct d.user_id from curator.device d) u
	left join lateral (
		select s.snapshot_seq, s.created_at
		from curator.library_snapshot s
		where s.user_id = u.user_id
		order by s.snapshot_seq desc
		limit 1
	) last on true
	cross join lateral (
		select count(*) as new_ops, min(x.received_at) as first_at
		from (
			select o.received_at
			from curator.library_op o
			where o.user_id = u.user_id and o.seq > coalesce(last.snapshot_seq, 0)
			order by o.seq
			limit min_ops
		) x
	) n
	where n.new_ops >= min_ops
		or (n.new_ops > 0 and coalesce(last.created_at, n.first_at) < now() - max_age)
$$;

revoke execute on function curator.users_due_for_snapshot(bigint, interval) from public;
