// The Supabase pieces the migrations and the API rely on, recreated for
// PGlite so tests never touch a real project. Each mirrors the hosted
// behaviour the code depends on, and only that:
//
// - roles `anon`, `authenticated`, `service_role` (NOLOGIN, no BYPASSRLS for
//   the first two, so RLS applies after `set role authenticated`);
// - `auth.users` (the FK target) and `auth.uid()` reading `sub` from
//   `request.jwt.claims`, as Supabase's own definition does;
// - `realtime.messages` with RLS on and `realtime.topic()`, so the channel
//   policy in 0001 can be created;
// - `realtime.send(payload, event, topic, private)` recording each call in
//   `realtime.messages`, so tests can count wake-ups;
// - `storage.buckets` / `storage.objects` with RLS on and the grants Supabase
//   gives `anon` and `authenticated` (all, filtered by policies), plus
//   `storage.foldername()`, so sql/storage.sql runs and its policies judge
//   direct inserts the way the storage service's own inserts are judged. The
//   service's size and MIME limits are enforced in the service, not in
//   Postgres, so nothing here can test them; an "upload" in a test is an
//   insert carrying `metadata.size`, as the service writes it.

export const SUPABASE_SHIM_SQL = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid
language sql stable
as $$
	select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

create schema realtime;
grant usage on schema realtime to anon, authenticated, service_role;
create table realtime.messages (
	id bigint generated always as identity primary key,
	topic text not null,
	extension text not null,
	event text,
	payload jsonb,
	private boolean,
	inserted_at timestamptz not null default now()
);
alter table realtime.messages enable row level security;
grant select on realtime.messages to authenticated;
create function realtime.topic() returns text
language sql stable
as $$ select nullif(current_setting('realtime.topic', true), '') $$;
create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
language plpgsql security definer set search_path = ''
as $$
begin
	insert into realtime.messages (topic, extension, event, payload, private)
	values (topic, 'broadcast', event, payload, private);
end;
$$;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
	id text primary key,
	name text not null,
	owner uuid,
	public boolean default false,
	file_size_limit bigint,
	allowed_mime_types text[],
	created_at timestamptz default now(),
	updated_at timestamptz default now()
);
create table storage.objects (
	id uuid primary key default gen_random_uuid(),
	bucket_id text references storage.buckets (id),
	name text,
	owner uuid,
	owner_id text,
	metadata jsonb,
	created_at timestamptz default now(),
	updated_at timestamptz default now(),
	last_accessed_at timestamptz default now(),
	version text,
	user_metadata jsonb
);
create unique index bucketid_objname on storage.objects (bucket_id, name);
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant all on storage.buckets to anon, authenticated, service_role;
grant all on storage.objects to anon, authenticated, service_role;
-- Supabase's own definition: every path segment but the last.
create function storage.foldername(name text) returns text[]
language plpgsql immutable
as $$
declare
	_parts text[];
begin
	select string_to_array(name, '/') into _parts;
	return _parts[1:array_length(_parts, 1) - 1];
end
$$;
`;
