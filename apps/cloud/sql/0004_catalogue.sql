-- Curator cloud, migration 0004: the catalogue, phase 1 (own devices only).
--
-- Analysis one device computed, kept for the same user's other devices: inline units (rhythm,
-- key, structure, advanced, fingerprint) as jsonb here, waveform peaks and AI vectors as files
-- in the private Storage bucket `catalogue` (sql/storage.sql) that the device uploads and
-- downloads itself; a row for those units names its object in `blob_paths`. The API writes
-- through RLS as the user, like every other table (src/db/user-tx.ts); nothing here grants a
-- device direct access, since the Data API exposes no `curator` table.
--
-- Keyed by audio hash, never recording id: grids and peaks belong to the decoded samples of one
-- encoding, and the hash is global, so phase 2 (sharing across users) adds a table beside this
-- one rather than reshaping it.

-- ── catalogue_rev ───────────────────────────────────────────────────────────────────────────
-- Orders one account's writes for `catalogue.inventory` (rev > last seen). Global, like
-- library_op.seq, so a user's revs have gaps. The API takes a per-user advisory lock around
-- each put, so revs commit in order for that user and a cursor never skips a slow writer.
create sequence curator.catalogue_rev;
grant usage on sequence curator.catalogue_rev to authenticated;

-- ── catalogue_account ───────────────────────────────────────────────────────────────────────
-- Who may store analysis, and how much. The owner inserts a row per account (README "Database
-- setup"); no grant lets a user create or change their own. Public sign-ups are closed in
-- Supabase Auth, and this row is the second wall: without it puts are refused and the Storage
-- insert policy refuses uploads.
--
-- The quota default fits Supabase Free (1 GB Storage per project) during stage D-a (inline
-- units + lo peaks, ~0.49 GB for the 4.7k-track library); D-b (hi peaks + vectors, ~3.6 GB)
-- comes with a plan upgrade and an `update ... set quota_bytes` by the owner.
create table curator.catalogue_account (
	user_id uuid primary key references auth.users (id) on delete cascade,
	entitled boolean not null default true,
	quota_bytes bigint not null default 943718400 check (quota_bytes >= 0),
	created_at timestamptz not null default now()
);

alter table curator.catalogue_account enable row level security;

create policy catalogue_account_select on curator.catalogue_account
	for select to authenticated
	using (user_id = (select auth.uid()));

grant select on curator.catalogue_account to authenticated;

-- SECURITY DEFINER so it answers the same wherever it is evaluated: inside the catalogue_item
-- policies below and inside the Storage insert policy, which Supabase's storage service runs
-- as `authenticated` with the caller's claims. It reveals only the caller's own flag.
create function curator.catalogue_entitled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce((select a.entitled from curator.catalogue_account a where a.user_id = auth.uid()), false)
$$;

-- Named roles too, not just public: Supabase can carry default privileges that grant EXECUTE on
-- new functions to anon/authenticated directly.
revoke execute on function curator.catalogue_entitled() from public, anon, authenticated;
grant execute on function curator.catalogue_entitled() to authenticated;

-- ── catalogue_item ──────────────────────────────────────────────────────────────────────────
-- One row per (user, audio hash, unit, variant, version). `user_id` comes from the JWT through
-- the default and the policies, never from the client. The CHECKs repeat the protocol's shape
-- rules (packages/protocol/src/catalogue.ts) so a bug in the API cannot store a key no reader
-- can parse; `data` itself is validated by the API's zod schema only.
--
--   variant      'default' for inline units, 'lo'/'hi' for peaks, the model id for vectors
--   version      the producer's version as int[] ([2,4,0]); Postgres orders int[] the way
--                the protocol's compareVersions does, which lookup's "newest" relies on
--   unit_schema  the shape version of `data`
--   data_bytes   UTF-8 length of `data` as sent, for the quota
--   blob_paths   Storage object names in the `catalogue` bucket, `<uid>/peaks/<sha>.cpk` or
--                `<uid>/vec/<sha>.cvec`; empty for inline units
--   digest       sha256 of the canonical item (unit, variant, version, schema, data), so
--                phase 2 can tell when N users computed the same result
--   licence      what the result was derived with (vectors: the model's licence)
create table curator.catalogue_item (
	user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
	audio_hash text not null check (audio_hash ~ '^(?:pcm-md5:[0-9a-f]{32}|mp3-sha256:[0-9a-f]{64}|mp4-sha256:[0-9a-f]{64})$'),
	unit text not null check (unit in ('rhythm', 'key', 'structure', 'advanced', 'fingerprint', 'peaks', 'vectors')),
	variant text not null check (variant ~ '^[a-z0-9][a-z0-9._@-]{0,63}$'),
	version int[] not null check (
		cardinality(version) between 1 and 4
		and array_position(version, null) is null
		and 0 <= all (version) and 65535 >= all (version)
	),
	unit_schema int not null check (unit_schema between 1 and 1000),
	duration_sec double precision not null check (duration_sec > 0 and duration_sec <= 86400),
	data jsonb not null,
	data_bytes int not null check (data_bytes between 0 and 1048576),
	blob_paths text[] not null default '{}' check (cardinality(blob_paths) <= 4),
	blob_bytes bigint not null default 0 check (blob_bytes >= 0),
	digest text not null check (digest ~ '^[0-9a-f]{64}$'),
	licence text check (char_length(licence) between 1 and 64),
	device_id text not null check (char_length(device_id) between 1 and 128),
	rev bigint not null default nextval('curator.catalogue_rev'),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	primary key (user_id, audio_hash, unit, variant, version)
);

-- Inventory reads one user's rows in rev order; lookup goes through the primary key.
create index catalogue_item_user_rev on curator.catalogue_item (user_id, rev);

alter table curator.catalogue_item enable row level security;

create policy catalogue_item_select on curator.catalogue_item
	for select to authenticated
	using (user_id = (select auth.uid()));

-- Writes also need the entitlement, so a revoked account (entitled = false) stops at the
-- database even if the API's own check were skipped.
create policy catalogue_item_insert on curator.catalogue_item
	for insert to authenticated
	with check (user_id = (select auth.uid()) and (select curator.catalogue_entitled()));

create policy catalogue_item_update on curator.catalogue_item
	for update to authenticated
	using (user_id = (select auth.uid()))
	with check (user_id = (select auth.uid()) and (select curator.catalogue_entitled()));

-- Retention (newest two versions per key) deletes through this.
create policy catalogue_item_delete on curator.catalogue_item
	for delete to authenticated
	using (user_id = (select auth.uid()));

grant select, insert, delete on curator.catalogue_item to authenticated;
-- Column-level: the key and created_at are fixed once written; an overwrite of the same version
-- replaces the payload and takes a new rev.
grant update (unit_schema, duration_sec, data, data_bytes, blob_paths, blob_bytes, digest, licence, device_id, rev, updated_at)
	on curator.catalogue_item to authenticated;
