-- Curator cloud, migration 0009: the snapshot is the account's base, not a cache of the log.
--
-- Until now the log held every op ever accepted and a snapshot was a fold of a prefix of it, which
-- the server could rebuild from the log at any time. The server no longer folds anything (the fold
-- held a 227 MB state in a 512 MB API process): the account's master publishes the snapshot to
-- Storage (0008, src/sync/publish-snapshot.ts) and that snapshot is now the BASE of the account.
-- The log carries only the changes since a base; ops the oldest kept snapshot covers are deleted
-- once that snapshot is a week old (compact_ops, below), and a device whose cursor is below the
-- base must bootstrap from a snapshot rather than replay (`baseSeq` on the wire). The existing
-- account is rebased by hand onto its master's published snapshot right after this migration
-- (README "Snapshots", the rebase runbook).
--
-- Destructive, by design: the server-folded snapshots (`body`) and the fold's lease go, and an
-- image from before this migration cannot run against the schema it leaves (README "Snapshots",
-- rollback).

-- ── library_snapshot: manifests only ──────────────────────────────────────────────────────
-- Every row is a master-published Storage snapshot. The server-built bodied rows (three on the
-- production database when this was written) are deleted here: nothing can read them any more
-- (sync.bootstrap answers manifests only), and the base they would have been for the fold has no
-- fold left to serve. The 0001 policies (select / insert / delete, own rows only) stay as they are.
delete from curator.library_snapshot where storage is null;
alter table curator.library_snapshot
	drop constraint library_snapshot_body_or_storage,
	drop constraint library_snapshot_storage_stamped,
	drop column body;
alter table curator.library_snapshot
	alter column storage set not null,
	alter column state_sha256 set not null,
	alter column published_by set not null;

-- The fold's lease (0007) and its three scheduling rules (0001, 0007, 0008): nothing folds now.
-- sql/roles.sql no longer grants them; `batches_to_tend` (0007) stays, the batch sweep is unchanged.
drop table curator.library_snapshot_lease;
drop function curator.users_due_for_snapshot(bigint, interval);
drop function curator.users_due_for_snapshot_v2(bigint, interval, interval, interval);
drop function curator.users_due_for_snapshot_v3(bigint, interval, interval, interval, interval);

-- ── library_base ──────────────────────────────────────────────────────────────────────────
-- One row per account once it has been compacted: `base_seq` is the seq at or below which the log
-- no longer holds the account's ops (0 until the first compaction, and an account with no row reads
-- as 0). Invariant: base_seq <= the account's oldest kept snapshot's seq, so there is always a
-- snapshot a device can bootstrap from at or above the base; set_base_seq refuses anything else,
-- and publishSnapshot's retention only ever drops older rows, which keeps the minimum above it.
-- Every head the API answers (push maxSeq, a batch's fence, publishSnapshot's bound) is
-- greatest(max(seq), base_seq), so a log emptied by compaction still reports the account's head.
--
-- Readable by the account (the API reads it in every pull / bootstrap under RLS); written only
-- through the SECURITY DEFINER functions below, which the API's login role calls outside any
-- user transaction (the sweep) or the operator calls from the CLI. No insert / update / delete
-- grant exists for `authenticated`.
create table curator.library_base (
	user_id uuid primary key references auth.users (id) on delete cascade,
	base_seq bigint not null default 0 check (base_seq >= 0),
	-- When compact_ops last found nothing left to delete below the base.
	compacted_at timestamptz
);

alter table curator.library_base enable row level security;

create policy library_base_select on curator.library_base
	for select to authenticated
	using (user_id = (select auth.uid()));

grant select on curator.library_base to authenticated;

-- ── set_base_seq ──────────────────────────────────────────────────────────────────────────
-- Raises the account's base to `p_through` (never lowers it: greatest of the two). Refused when
-- `p_through` is above the account's oldest kept snapshot, or when the account has no snapshot at
-- all and p_through > 0: a device below the base must be able to bootstrap at or above it. A base
-- that moved resets compacted_at, since there is something to delete again. Returns the base now.
create function curator.set_base_seq(p_user uuid, p_through bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
	oldest bigint;
	result bigint;
begin
	if p_through < 0 then
		raise exception 'set_base_seq: base % is negative', p_through using errcode = 'check_violation';
	end if;
	select min(s.snapshot_seq) into oldest from curator.library_snapshot s where s.user_id = p_user;
	if p_through > coalesce(oldest, 0) then
		raise exception 'set_base_seq: base % is above the oldest kept snapshot (%) of user %', p_through, coalesce(oldest::text, 'none'), p_user
			using errcode = 'check_violation';
	end if;
	insert into curator.library_base (user_id, base_seq) values (p_user, p_through)
	on conflict (user_id) do update
		set base_seq = greatest(curator.library_base.base_seq, excluded.base_seq),
			compacted_at = case when excluded.base_seq > curator.library_base.base_seq then null else curator.library_base.compacted_at end
	returning base_seq into result;
	return result;
end;
$$;

-- ── compact_ops ───────────────────────────────────────────────────────────────────────────
-- Deletes up to `p_limit` of the account's ops at or below its base, lowest seq first, and returns
-- how many went. Called in a loop until it answers 0 (the sweep, the CLI): the API role's 30 s
-- statement_timeout wants chunks, 5,000 a call. The `library.master_device` setting ops are kept
-- whatever their seq: the server reads the account's master from the log (src/sync/master.ts, the
-- partial index library_op_master_device of 0008), and a compacted master would make
-- publishSnapshot refuse every device. They are a handful of rows per account.
-- (user_id, seq) is the index both the subselect and the delete use.
create function curator.compact_ops(p_user uuid, p_limit int)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
	base bigint;
	n bigint;
begin
	select b.base_seq into base from curator.library_base b where b.user_id = p_user;
	if base is null or base = 0 then
		return 0;
	end if;
	delete from curator.library_op o
	where o.user_id = p_user and o.seq in (
		select x.seq from curator.library_op x
		where x.user_id = p_user and x.seq <= base
			and not (x.entity = 'setting' and x.entity_id = 'library.master_device')
		order by x.seq
		limit greatest(p_limit, 1)
	);
	get diagnostics n = row_count;
	if n < greatest(p_limit, 1) then
		update curator.library_base set compacted_at = now() where user_id = p_user;
	end if;
	return n;
end;
$$;

-- ── users_due_for_compaction ──────────────────────────────────────────────────────────────
-- The sweep's cross-user read (ids and seqs only, like batches_to_tend): accounts whose oldest kept
-- snapshot is above their base and older than `p_min_age` (7 days: a device that has not pulled
-- for a week bootstraps rather than replays; the newest 3 snapshots are kept, so the base trails
-- the head by two publishes). `through` is that snapshot's seq, the base the sweep then sets.
create function curator.users_due_for_compaction(p_min_age interval)
returns table (user_id uuid, through bigint)
language sql
stable
security definer
set search_path = ''
as $$
	select o.user_id, o.snapshot_seq
	from (
		select distinct on (s.user_id) s.user_id, s.snapshot_seq, s.created_at
		from curator.library_snapshot s
		order by s.user_id, s.snapshot_seq
	) o
	left join curator.library_base b on b.user_id = o.user_id
	where o.snapshot_seq > coalesce(b.base_seq, 0)
		and o.created_at < now() - p_min_age
$$;

-- Named roles too, not just public: Supabase can carry default privileges that grant EXECUTE on
-- new functions to anon/authenticated directly. The API's login role gets them in sql/roles.sql.
revoke execute on function curator.set_base_seq(uuid, bigint) from public, anon, authenticated;
revoke execute on function curator.compact_ops(uuid, int) from public, anon, authenticated;
revoke execute on function curator.users_due_for_compaction(interval) from public, anon, authenticated;
