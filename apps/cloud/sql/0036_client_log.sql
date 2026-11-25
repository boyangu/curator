-- Curator cloud, migration 0036: phones' own log records ('client_logs', src/diagnostics.ts).
--
-- The operator's table, on the footing of 0002: RLS on with no policy and no grant, so no token
-- reads or writes a row through any door. The API writes through the SECURITY DEFINER function
-- below; only the owner reads (`pnpm cloud:logs`). Rows live 7 days (prune_client_log, run daily).
--
-- `data` and `err` hold JSON as text, not jsonb: nothing queries inside them, and jsonb refuses
-- what a log may well contain (a NUL, half a surrogate pair), which would lose the whole batch.
create table curator.client_log (
	user_id uuid not null references auth.users (id) on delete cascade,
	install_id uuid not null,
	n bigint not null,
	ts timestamptz not null,
	received_at timestamptz not null default now(),
	level text not null,
	proc text not null,
	area text not null,
	msg text not null,
	data text,
	err text,
	app_version text not null,
	device text not null,
	-- A batch sent again (its answer was lost) lands on itself.
	primary key (user_id, install_id, n)
);
create index client_log_received on curator.client_log (received_at);
create index client_log_user_received on curator.client_log (user_id, received_at);

alter table curator.client_log enable row level security;
revoke all on curator.client_log from public, anon, authenticated;

-- Rows stored, or -1 when the account is past its day's ceiling (nothing stored). Lengths are
-- capped here too, so a bug upstream cannot write unbounded text.
create function curator.log_client(for_user uuid, install uuid, app_version text, device text, rows jsonb, per_day int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
	n_stored int;
begin
	if (select count(*) from curator.client_log c where c.user_id = for_user and c.received_at > now() - interval '1 day') >= per_day then
		return -1;
	end if;
	insert into curator.client_log (user_id, install_id, n, ts, level, proc, area, msg, data, err, app_version, device)
	select for_user, install, (r ->> 'n')::bigint, to_timestamp((r ->> 'ts')::float8 / 1000), left(r ->> 'level', 8), left(r ->> 'proc', 32),
		left(r ->> 'area', 64), left(r ->> 'msg', 1000), left(r ->> 'data', 8192), left(r ->> 'err', 16384), left(app_version, 64), left(device, 200)
	from jsonb_array_elements(rows) as r
	on conflict do nothing;
	get diagnostics n_stored = row_count;
	return n_stored;
end;
$$;

create function curator.prune_client_log(older_than interval)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
	n bigint;
begin
	delete from curator.client_log where received_at < now() - older_than;
	get diagnostics n = row_count;
	return n;
end;
$$;

revoke execute on function curator.log_client(uuid, uuid, text, text, jsonb, int) from public, anon, authenticated;
revoke execute on function curator.prune_client_log(interval) from public, anon, authenticated;
