-- Curator cloud, migration 0006: which device each Supabase session acts as.
--
-- Revoking a device used to stop only its pushes. Its Supabase session stayed valid, and a pull
-- named no device unless the own-op skip was in use, so a stolen, revoked laptop could keep
-- reading the library. The device id a call names is the client's word, though: a session can
-- leave it out or name another device. What the server can hold on to is the session id in the
-- verified token (`session_id`, stable across refreshes for as long as that sign-in lasts).
--
-- So each session is bound to the device it last acted as: on registerDevice, on every push and
-- on every pull, bootstrap and catalogue call that names a device. A session whose bound device
-- is revoked is refused everything (src/account/device-gate.ts), whatever device id it names and
-- whether or not it names one, and it cannot rebind itself by registering a fresh device id: the
-- way back is a new sign-in, which needs the user's credentials. One row per session rather than
-- one per (session, device): a restored install re-mints its device id under the same session
-- (core sync-log/remint.ts), and revoking the stale old id afterwards must not cut off the
-- install that now acts as the new one.
--
-- Storage reads the same verdict through curator.session_revoked() (sql/storage.sql), since
-- Storage requests carry the session's JWT but no device id.
create table curator.device_session (
	user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
	session_id text not null check (char_length(session_id) between 1 and 128),
	device_id text not null,
	bound_at timestamptz not null default now(),
	primary key (user_id, session_id),
	foreign key (user_id, device_id) references curator.device (user_id, device_id) on delete cascade
);

alter table curator.device_session enable row level security;

create policy device_session_select on curator.device_session
	for select to authenticated
	using (user_id = (select auth.uid()));

create policy device_session_insert on curator.device_session
	for insert to authenticated
	with check (user_id = (select auth.uid()));

create policy device_session_update on curator.device_session
	for update to authenticated
	using (user_id = (select auth.uid()))
	with check (user_id = (select auth.uid()));

grant select, insert on curator.device_session to authenticated;
grant update (device_id, bound_at) on curator.device_session to authenticated;

-- Whether the caller's session (the `session_id` claim of the token the request carries) acts
-- as a revoked device. For RLS policies outside this API, Storage's first: there the claims are
-- the device's own token. False for a token without a session id, and for a session never seen
-- by the API, which is the state before this migration; the API's own gate is the main wall.
-- SECURITY INVOKER: as `authenticated` it reads only the caller's own rows.
create function curator.session_revoked()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
	select exists (
		select 1
		from curator.device_session s
		join curator.device d on d.user_id = s.user_id and d.device_id = s.device_id
		where s.user_id = auth.uid()
			and s.session_id = auth.jwt() ->> 'session_id'
			and d.revoked_at is not null
	)
$$;

revoke execute on function curator.session_revoked() from public, anon;
grant execute on function curator.session_revoked() to authenticated;
