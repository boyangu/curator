-- Curator cloud, migration 0034: ready-made libraries for new devices ('replica_storage').
--
-- A device joins by folding the master's snapshot record by record: about two minutes on a phone
-- for the 39k-track library, nearly all of it per-record work, not storage (2026-11-21). The master
-- can do that once: it runs the same join into an empty library and publishes the database beside
-- the snapshot, and a device whose library is empty downloads it instead (protocol cloud-service.ts,
-- 'replica_storage'). Like a snapshot, the database itself is in the `snapshots` bucket as
-- content-addressed gzip parts under the master's own prefix (sql/storage.sql, unchanged); this
-- table only indexes the manifest (src/sync/publish-replica.ts).
--
-- A replica stands on a kept snapshot (`snapshot_seq` names one when it is published), and snapshot
-- retention keeps the newest replica's snapshot (src/sync/publish-snapshot.ts): the base can never
-- rise above the oldest kept snapshot (0009 set_base_seq), so the log stays replayable from the
-- replica's seq for as long as it is the one offered.

create table curator.library_replica (
	user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
	snapshot_seq bigint not null check (snapshot_seq >= 1),
	created_at timestamptz not null default now(),
	-- The library's replica format (core sync-log/replica.ts REPLICA_SCHEMA): a device asks for its
	-- own format or older.
	schema_version int not null check (schema_version >= 1),
	-- The protocol's ReplicaManifest.
	storage jsonb not null,
	published_by text not null check (char_length(published_by) between 1 and 128),
	primary key (user_id, snapshot_seq)
);

alter table curator.library_replica enable row level security;

create policy library_replica_select on curator.library_replica
	for select to authenticated
	using (user_id = (select auth.uid()));

create policy library_replica_insert on curator.library_replica
	for insert to authenticated
	with check (user_id = (select auth.uid()));

-- Retention deletes all but the newest, in the publishing call.
create policy library_replica_delete on curator.library_replica
	for delete to authenticated
	using (user_id = (select auth.uid()));

grant select, insert, delete on curator.library_replica to authenticated;
