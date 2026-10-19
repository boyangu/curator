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
//   `realtime.messages`, so tests can count wake-ups.

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
`;
