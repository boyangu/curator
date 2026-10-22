-- Curator cloud, migration 0007: batch uploads, a per-user virtual transaction over the op log.
--
-- A desktop's one-time backlog (the initial push of an existing library, a backfill after a protocol
-- upgrade: ~116k ops on the main library, 2026-10-21) used to arrive as ~230 plain pushes, each an
-- INSERT into library_op with its index upkeep, a wake-up and a seq every other device then pulled one
-- page at a time, while the snapshot job rebuilt the 37 MB snapshot behind it every sweep. A batch
-- stages those ops instead (library_op_staged: no seq, no wake-up, read by nothing), and its commit
-- moves them into the log and only then makes the lot visible at once with one wake-up; the regular
-- sweep snapshots them once the log has gone quiet. src/sync/batch.ts is the protocol;
-- src/sync/visibility.ts is the rule every reader applies.
--
-- Nothing here changes what an existing reader sees until a batch commits: with no fence row, every
-- predicate below is "seq <= max bigint".

-- ── library_op_batch ────────────────────────────────────────────────────────────────────────
-- One row per batch, kept after it closes (a few rows per device per backlog): a commit answered
-- twice, after the client lost the first answer, is read back from here. `total_ops` freezes the
-- staged count when the commit starts; `moved_ops` counts staged ops taken into the log so far
-- (`inserted_ops` of them new, the rest re-pushes of ops the log already held, or `rejected`).
-- `fence_seq` is the head of the log when the commit fenced it (library_op_fence below);
-- `prior_own_max_seq` is PushResult.priorOwnMaxSeq for the batch. The lease lets exactly one runner
-- (a request on any machine, or the sweep) drive a commit at a time, across transactions.
create table curator.library_op_batch (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
	device_id text not null,
	label text not null check (label ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'),
	status text not null default 'open' check (status in ('open', 'committing', 'committed', 'aborted', 'expired')),
	expected_ops bigint check (expected_ops >= 0),
	staged_ops bigint not null default 0,
	total_ops bigint,
	moved_ops bigint not null default 0,
	inserted_ops bigint not null default 0,
	rejected jsonb not null default '[]',
	fence_seq bigint,
	prior_own_max_seq bigint,
	committed_seq bigint,
	lease_holder text,
	lease_until timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	commit_started_at timestamptz,
	closed_at timestamptz,
	foreign key (user_id, device_id) references curator.device (user_id, device_id) on delete cascade
);

-- One live batch per device and label: batchBegin resumes it rather than opening a second.
create unique index library_op_batch_live on curator.library_op_batch (user_id, device_id, label) where status in ('open', 'committing');
-- The sweep's scan (idle open batches, stalled commits).
create index library_op_batch_tend on curator.library_op_batch (status, updated_at) where status in ('open', 'committing');

alter table curator.library_op_batch enable row level security;

create policy library_op_batch_select on curator.library_op_batch
	for select to authenticated
	using (user_id = (select auth.uid()));

create policy library_op_batch_insert on curator.library_op_batch
	for insert to authenticated
	with check (user_id = (select auth.uid()));

create policy library_op_batch_update on curator.library_op_batch
	for update to authenticated
	using (user_id = (select auth.uid()))
	with check (user_id = (select auth.uid()));

grant select, insert on curator.library_op_batch to authenticated;
-- Column-level: identity, device, label and creation are fixed once written.
grant update (status, expected_ops, staged_ops, total_ops, moved_ops, inserted_ops, rejected, fence_seq, prior_own_max_seq,
	committed_seq, lease_holder, lease_until, updated_at, commit_started_at, closed_at) on curator.library_op_batch to authenticated;

-- ── library_op_staged ───────────────────────────────────────────────────────────────────────
-- A batch's ops before its commit: library_op's columns minus `seq` and `received_at`, which the
-- commit assigns. `ord` keeps the device's order (the commit hands out seqs in it). The primary key
-- makes staging the same op twice (a retried batchPush) a no-op; an op the log already holds is
-- skipped at commit (`on conflict (op_id) do nothing`), so a re-push is never stored twice.
-- Nothing reads this table but the batch code: pull, bootstrap and the snapshot job never do.
create table curator.library_op_staged (
	batch_id uuid not null references curator.library_op_batch (id) on delete cascade,
	user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
	ord bigint generated always as identity,
	op_id uuid not null,
	device_id text not null,
	client_ts bigint not null,
	schema_version int not null,
	entity text not null,
	entity_id text not null,
	kind text not null,
	payload jsonb not null,
	primary key (batch_id, op_id)
);

-- The commit takes staged ops in `ord` order, a chunk per statement.
create index library_op_staged_ord on curator.library_op_staged (batch_id, ord);

alter table curator.library_op_staged enable row level security;

create policy library_op_staged_select on curator.library_op_staged
	for select to authenticated
	using (user_id = (select auth.uid()));

create policy library_op_staged_insert on curator.library_op_staged
	for insert to authenticated
	with check (user_id = (select auth.uid()));

create policy library_op_staged_delete on curator.library_op_staged
	for delete to authenticated
	using (user_id = (select auth.uid()));

grant select, insert, delete on curator.library_op_staged to authenticated;

-- ── library_op_fence ────────────────────────────────────────────────────────────────────────
-- While a commit moves a batch into library_op (in chunks, each its own transaction, so no statement
-- runs into the 30 s timeout), the user's log is fenced: every reader sees only `seq <=
-- visible_through`, the head when the fence went up. The fence is written under the push lock, so
-- every seq the commit (or any push meanwhile) takes is above it; it is deleted only once every op
-- is moved. A cursor therefore never passes a seq that becomes visible later (src/sync/visibility.ts
-- has the full argument). One fence per user: a second batch's commit waits for the first to publish.
create table curator.library_op_fence (
	user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
	batch_id uuid not null unique references curator.library_op_batch (id) on delete cascade,
	visible_through bigint not null check (visible_through >= 0),
	created_at timestamptz not null default now()
);

alter table curator.library_op_fence enable row level security;

create policy library_op_fence_select on curator.library_op_fence
	for select to authenticated
	using (user_id = (select auth.uid()));

create policy library_op_fence_insert on curator.library_op_fence
	for insert to authenticated
	with check (user_id = (select auth.uid()));

create policy library_op_fence_delete on curator.library_op_fence
	for delete to authenticated
	using (user_id = (select auth.uid()));

grant select, insert, delete on curator.library_op_fence to authenticated;

-- ── library_snapshot_lease ──────────────────────────────────────────────────────────────────
-- Who is building a user's snapshot. A build now spans several short transactions (read the base,
-- fold pages, store), so the old transaction-scoped try-lock cannot cover it, and a session-level
-- advisory lock is unsafe behind Supabase's transaction pooler. A row with an expiry can: the
-- holder renews nothing, it just finishes well inside it or loses it to the next runner.
create table curator.library_snapshot_lease (
	user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
	holder text not null check (char_length(holder) between 1 and 128),
	until timestamptz not null
);

alter table curator.library_snapshot_lease enable row level security;

create policy library_snapshot_lease_select on curator.library_snapshot_lease
	for select to authenticated
	using (user_id = (select auth.uid()));

create policy library_snapshot_lease_insert on curator.library_snapshot_lease
	for insert to authenticated
	with check (user_id = (select auth.uid()));

create policy library_snapshot_lease_update on curator.library_snapshot_lease
	for update to authenticated
	using (user_id = (select auth.uid()))
	with check (user_id = (select auth.uid()));

create policy library_snapshot_lease_delete on curator.library_snapshot_lease
	for delete to authenticated
	using (user_id = (select auth.uid()));

grant select, insert, delete on curator.library_snapshot_lease to authenticated;
grant update (holder, until) on curator.library_snapshot_lease to authenticated;

-- ── wake-ups ────────────────────────────────────────────────────────────────────────────────
-- A commit's chunks would each ring the doorbell for ops nobody can see yet; the commit sets
-- `curator.quiet_wake` for its own transactions (set_config(..., true), so it dies with each one)
-- and rings once when it publishes, through curator.wake_self. Every other insert wakes as before.
create or replace function curator.library_op_wake()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	r record;
begin
	if current_setting('curator.quiet_wake', true) = 'on' then
		return null;
	end if;
	for r in select user_id, max(seq) as seq from inserted group by user_id loop
		perform realtime.send(jsonb_build_object('seq', r.seq), 'wake', 'user:' || r.user_id::text, true);
	end loop;
	return null;
end;
$$;

-- The caller's own channel only: `user:` || auth.uid(), never a channel the caller names.
create function curator.wake_self(seq bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	if auth.uid() is null then
		return;
	end if;
	perform realtime.send(jsonb_build_object('seq', seq), 'wake', 'user:' || auth.uid()::text, true);
end;
$$;

revoke execute on function curator.wake_self(bigint) from public, anon, authenticated;
grant execute on function curator.wake_self(bigint) to authenticated;

-- ── snapshot scheduling, v2 ─────────────────────────────────────────────────────────────────
-- 0001's rule (10k new ops or a day) rebuilt a 37 MB snapshot every 15-minute sweep while a backfill
-- flooded the log. Now a user is due only when the rule holds AND the log has been quiet for `quiet`
-- (5 min), or the last snapshot is older than `busy_every` (an hour) so a steady stream still gets
-- one; and never while the user has an open or committing batch (it is about to add to the log: the
-- sweep after its commit snapshots the lot).
-- Same shape as v1: ids only, executable by the API's login role alone (sql/roles.sql).
create function curator.users_due_for_snapshot_v2(min_ops bigint, max_age interval, quiet interval, busy_every interval)
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
	cross join lateral (
		select o.received_at as last_at
		from curator.library_op o
		where o.user_id = u.user_id
		order by o.seq desc
		limit 1
	) latest
	where (n.new_ops >= min_ops or (n.new_ops > 0 and coalesce(last.created_at, n.first_at) < now() - max_age))
		and (latest.last_at < now() - quiet or coalesce(last.created_at, n.first_at) < now() - busy_every)
		and not exists (
			select 1 from curator.library_op_batch b
			where b.user_id = u.user_id and b.status in ('open', 'committing')
		)
$$;

revoke execute on function curator.users_due_for_snapshot_v2(bigint, interval, interval, interval) from public, anon, authenticated;

-- ── batch upkeep ────────────────────────────────────────────────────────────────────────────
-- The sweep's other cross-user read: open batches idle past `idle` (to expire), commits nobody is
-- driving (lease lapsed: finish them, since their fence holds the user's other devices back), and
-- closed batches that still hold staged rows (to purge). Ids only; each action then runs as its
-- user under RLS.
create function curator.batches_to_tend(idle interval)
returns table (user_id uuid, batch_id uuid, device_id text, status text)
language sql
stable
security definer
set search_path = ''
as $$
	select b.user_id, b.id, b.device_id, b.status
	from curator.library_op_batch b
	where (b.status = 'open' and b.updated_at < now() - idle)
		or (b.status = 'committing' and (b.lease_until is null or b.lease_until < now()))
	union all
	select b.user_id, b.id, b.device_id, b.status
	from curator.library_op_batch b
	where b.status in ('aborted', 'expired')
		and exists (select 1 from curator.library_op_staged s where s.batch_id = b.id)
$$;

revoke execute on function curator.batches_to_tend(interval) from public, anon, authenticated;
