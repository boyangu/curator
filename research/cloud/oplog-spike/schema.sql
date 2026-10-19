-- Per-user op log + trigger-driven Realtime wake-up. Paste into the Supabase SQL editor
-- (it runs as `postgres`) and execute once. Re-runnable: every statement is idempotent.
--
-- Shape: clients append ops through push_ops(); each INSERT statement that lands new rows
-- fires one tiny broadcast ({seq}) on the owner's private channel user:<uid>; other devices
-- then pull_ops(after_seq) by seq. The broadcast carries no data on purpose: the table is
-- the source of truth, the channel is only a doorbell.

create table if not exists public.library_op (
	user_id uuid not null default auth.uid(),
	-- Per-user ordering is what clients cursor on, but the identity sequence is global, so a
	-- user's seq has gaps (other users' rows, rows skipped by on conflict). Cursor with
	-- seq > last, never seq = last + 1.
	seq bigint generated always as identity primary key,
	device_id text not null,
	op_id uuid not null unique,
	client_ts timestamptz not null,
	schema_version int not null default 1,
	entity text not null,
	entity_id text not null,
	kind text not null,
	payload jsonb not null,
	received_at timestamptz not null default now()
);

create index if not exists library_op_user_seq on public.library_op (user_id, seq);

alter table public.library_op enable row level security;

-- (select auth.uid()) rather than bare auth.uid(): the planner evaluates the subselect once
-- per statement instead of once per row, which matters on the 500-row pulls.
drop policy if exists "owner reads own ops" on public.library_op;
create policy "owner reads own ops" on public.library_op
	for select to authenticated
	using (user_id = (select auth.uid()));

drop policy if exists "owner appends own ops" on public.library_op;
create policy "owner appends own ops" on public.library_op
	for insert to authenticated
	with check (user_id = (select auth.uid()));

-- Append a batch. Idempotent: a resent batch hits the op_id unique index and is skipped, so a
-- client may retry after a lost response. Returns the caller's head seq. Security invoker,
-- so RLS and the user_id default both come from the caller's JWT, never from the payload.
create or replace function public.push_ops(ops jsonb)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
begin
	-- Serialize pushes per user so seq order equals commit order. Without this a slow
	-- transaction holding seq 100 can commit after a fast one holding 101, and a device that
	-- already cursored past 101 never sees 100. Transaction-scoped: released at commit.
	perform pg_advisory_xact_lock(hashtextextended('library_op:' || (select auth.uid())::text, 0));

	insert into public.library_op (device_id, op_id, client_ts, schema_version, entity, entity_id, kind, payload)
	select o.device_id, o.op_id, o.client_ts, coalesce(o.schema_version, 1), o.entity, o.entity_id, o.kind, o.payload
	from jsonb_to_recordset(ops) as o(
		device_id text, op_id uuid, client_ts timestamptz, schema_version int,
		entity text, entity_id text, kind text, payload jsonb
	)
	on conflict (op_id) do nothing;

	return (select coalesce(max(seq), 0) from public.library_op where user_id = (select auth.uid()));
end;
$$;

-- Cursor read. The equivalent plain REST call, if a function is not wanted:
--   from('library_op').select('*').gt('seq', after_seq).order('seq').limit(lim)
create or replace function public.pull_ops(after_seq bigint, lim int default 500)
returns setof public.library_op
language sql
stable
security invoker
set search_path = ''
as $$
	select * from public.library_op
	where user_id = (select auth.uid()) and seq > after_seq
	order by seq
	limit lim;
$$;

-- Wake-up trigger: one broadcast per INSERT statement, not per row. push_ops lands a whole
-- batch in a single INSERT ... SELECT, so a batch of 50 costs one realtime.messages row and
-- one WebSocket frame; FOR EACH ROW would write 50 rows into the partitioned
-- realtime.messages table (each a WAL record the Realtime server has to read) and push 50
-- frames the client would coalesce anyway. The transition table also makes a no-op re-push
-- free: rows skipped by on conflict are not in it, so nothing is sent for an idempotent retry.
--
-- realtime.send(payload jsonb, event text, topic text, private boolean default true) is used
-- rather than realtime.broadcast_changes(topic, event, operation, table, schema, new, old,
-- level): broadcast_changes is built around one NEW/OLD record pair and ships the row as the
-- payload, while send takes any jsonb, which is what a {seq} doorbell from a statement-level
-- trigger needs. Signatures confirmed against the Realtime tenant migrations, see README.
--
-- SECURITY DEFINER as in the Supabase docs example: the insert into realtime.messages then
-- runs as the function owner, and hosted projects give `postgres` BYPASSRLS, so no INSERT
-- policy is needed. realtime.send swallows failures as WARNINGs, so a permissions miss would
-- surface as silent no-wake-ups; check the Postgres logs for WarnSendingBroadcastMessage if
-- device A never wakes.
create or replace function public.library_op_wake()
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

drop trigger if exists library_op_wake on public.library_op;
create trigger library_op_wake
	after insert on public.library_op
	referencing new table as inserted
	for each statement
	execute function public.library_op_wake();

-- Private-channel authorization: Realtime evaluates this SELECT policy when a client joins
-- user:<uid> with private: true. No INSERT policy, because clients never publish on the
-- channel; the trigger does. The "Enable Realtime" toggle on the table is NOT needed: that is
-- the WAL publication for postgres_changes, and broadcast goes through realtime.messages.
drop policy if exists "owner receives own wakeups" on realtime.messages;
create policy "owner receives own wakeups" on realtime.messages
	for select to authenticated
	using (
		realtime.messages.extension = 'broadcast'
		and realtime.topic() = 'user:' || (select auth.uid())::text
	);
