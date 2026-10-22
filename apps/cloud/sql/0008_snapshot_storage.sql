-- Curator cloud, migration 0008: master-published snapshots ('snapshot_storage').
--
-- The server's own fold held the whole library state in the API process (227 MB of JSON for the main
-- library, 2026-10-21, in a 512 MB machine) to build each snapshot. The account's master device
-- already holds that fold in its records, so it now builds the snapshot itself, uploads it as
-- content-addressed gzip parts to the private `snapshots` bucket with its own session
-- (sql/storage.sql), and calls sync.publishSnapshot, which only verifies and indexes it
-- (src/sync/publish-snapshot.ts). The server fold stays, as the fallback for an account whose master
-- never publishes or went quiet, and as the only snapshot an older desktop can read.
--
-- Nothing changes for an existing reader until a master publishes: every row written before this
-- migration has a body.

-- ── library_snapshot: a body, or a manifest ────────────────────────────────────────────────
-- A row is either a Postgres snapshot (`body`, written by the server's fold) or a Storage one
-- (`storage`: the protocol's SnapshotManifest, written by publishSnapshot), never both and never
-- neither. `state_sha256` is the sha256 of the serialised JSON (what the verifier compares a server
-- fold with); `published_by` is the master device that published it. Both are set on every Storage
-- row and left null on bodied ones (the fold has no reason to hash what it never compares).
--
-- The table-level grants and RLS policies of 0001 (select / insert / delete, own rows only) cover
-- the new columns as they are: table grants apply to every column, current and future.
alter table curator.library_snapshot alter column body drop not null;
alter table curator.library_snapshot
	add column storage jsonb,
	add column state_sha256 text check (state_sha256 ~ '^[0-9a-f]{64}$'),
	add column published_by text check (char_length(published_by) between 1 and 128);
alter table curator.library_snapshot
	add constraint library_snapshot_body_or_storage check ((body is null) <> (storage is null)),
	add constraint library_snapshot_storage_stamped check (storage is null or (state_sha256 is not null and published_by is not null));

-- ── the master device ─────────────────────────────────────────────────────────────────────
-- `library.master_device` is an ordinary account setting op; the current master is the LWW winner
-- among them, ordered as the reducer's compareClock orders clocks (client_ts, then device id, then
-- op id). publishSnapshot and the push's source audit read it on every call, so they get one probe
-- of this partial index (a handful of rows per account) instead of a walk of the user's log.
-- `collate "C"`: compareClock compares device ids by code unit, not by the database's locale.
create index library_op_master_device on curator.library_op (user_id, client_ts desc, device_id collate "C" desc, op_id desc)
	where entity = 'setting' and entity_id = 'library.master_device';

-- ── snapshot scheduling, v3 ─────────────────────────────────────────────────────────────────
-- v2's rule, plus: a user whose newest snapshot is a master-published one younger than
-- `master_fresh` (7 days) is not folded at all. The master publishes; the server's fold is only the
-- fallback for an account whose master never published or has gone quiet, and it is the one step
-- here that holds a whole library in the API's memory. Past `master_fresh` (and with new ops, as
-- v2 asks), the sweep folds again from the newest bodied snapshot (src/snapshot/job.ts).
-- Same shape as v1 / v2: ids only, executable by the API's login role alone (sql/roles.sql).
create function curator.users_due_for_snapshot_v3(min_ops bigint, max_age interval, quiet interval, busy_every interval, master_fresh interval)
returns table (user_id uuid, new_ops bigint)
language sql
stable
security definer
set search_path = ''
as $$
	select u.user_id, n.new_ops
	from (select distinct d.user_id from curator.device d) u
	left join lateral (
		select s.snapshot_seq, s.created_at, s.storage is not null as published
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
		and not (coalesce(last.published, false) and last.created_at >= now() - master_fresh)
		and not exists (
			select 1 from curator.library_op_batch b
			where b.user_id = u.user_id and b.status in ('open', 'committing')
		)
$$;

revoke execute on function curator.users_due_for_snapshot_v3(bigint, interval, interval, interval, interval) from public, anon, authenticated;
