-- Curator cloud, migration 0002: the per-call access log and the security audit trail.
--
-- Both tables are the operator's, not the user's: RLS is on and no policy or grant exists for
-- `authenticated` (or anon), so no token can read or write a row, through this API or any other
-- door into the database. The API writes through the SECURITY DEFINER functions below, executable
-- by its login role `curator_api` alone (sql/roles.sql); nothing but the owner can update or
-- delete. Only the owner reads them, from the Supabase SQL editor (README "Logs and audit").
--
-- Rows carry ids, counts and stable reason strings only: never a token, an op payload, an email,
-- a connection string or a query string (src/audit.ts builds them).

-- ── request_log ─────────────────────────────────────────────────────────────────────────────
-- One row per HTTP request, failures included (401, 404, 413, 429, 500). `at` is when the
-- request arrived (the writer buffers and flushes up to a second later). `user_id` and
-- `session_id` come from a verified token only, `device_id` from a verified push's input; a
-- failed sign-in therefore has a null user. Kept 90 days (prune_request_log, run daily).
create table curator.request_log (
	id bigint generated always as identity primary key,
	at timestamptz not null default now(),
	request_id uuid not null,
	user_id uuid,
	device_id text,
	session_id text,
	procedure text not null,
	http_status int not null,
	reason text,
	duration_ms int not null,
	ops_in int,
	ops_out int,
	bytes_in int,
	bytes_out int,
	client_ip text,
	client text
);

-- Pruning and "the last hour" scans read by time; a user's history reads by user then time.
create index request_log_at on curator.request_log (at);
create index request_log_user_at on curator.request_log (user_id, at);

alter table curator.request_log enable row level security;

-- ── audit_event ─────────────────────────────────────────────────────────────────────────────
-- Security-relevant events (auth failures, rate limits, device lifecycle, rejected or clamped
-- ops, full-library exports). Append-only and never pruned: this is the trail an incident review
-- reads months later. `request_id` joins it to request_log while that row still exists.
create table curator.audit_event (
	id bigint generated always as identity primary key,
	at timestamptz not null default now(),
	request_id uuid,
	user_id uuid,
	device_id text,
	kind text not null,
	detail jsonb not null default '{}'
);

create index audit_event_user_at on curator.audit_event (user_id, at);
create index audit_event_kind_at on curator.audit_event (kind, at);

alter table curator.audit_event enable row level security;

-- No policies and no grants on either table: `authenticated` and `anon` get "permission denied",
-- and RLS stays on as the second wall should a grant ever slip in.
revoke all on curator.request_log from public, anon, authenticated;
revoke all on curator.audit_event from public, anon, authenticated;

-- ── writers ─────────────────────────────────────────────────────────────────────────────────
-- Batched: the API buffers rows in memory and lands up to a few hundred per call, outside any
-- user transaction. `rows` is a JSON array of objects keyed by column name; a missing `at` means
-- now. Lengths are capped here too, so a bug upstream cannot write unbounded text.
create function curator.log_requests(rows jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
	insert into curator.request_log (at, request_id, user_id, device_id, session_id, procedure, http_status, reason,
		duration_ms, ops_in, ops_out, bytes_in, bytes_out, client_ip, client)
	select coalesce((r ->> 'at')::timestamptz, now()), (r ->> 'request_id')::uuid, (r ->> 'user_id')::uuid,
		left(r ->> 'device_id', 128), left(r ->> 'session_id', 128), left(r ->> 'procedure', 200), (r ->> 'http_status')::int,
		left(r ->> 'reason', 100), (r ->> 'duration_ms')::int, (r ->> 'ops_in')::int, (r ->> 'ops_out')::int,
		(r ->> 'bytes_in')::int, (r ->> 'bytes_out')::int, left(r ->> 'client_ip', 64), left(r ->> 'client', 100)
	from jsonb_array_elements($1) as r
$$;

create function curator.log_audit_events(rows jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
	insert into curator.audit_event (at, request_id, user_id, device_id, kind, detail)
	select coalesce((r ->> 'at')::timestamptz, now()), (r ->> 'request_id')::uuid, (r ->> 'user_id')::uuid,
		left(r ->> 'device_id', 128), left(r ->> 'kind', 64), coalesce(r -> 'detail', '{}'::jsonb)
	from jsonb_array_elements($1) as r
$$;

-- Retention for the access log only; audit_event has no pruner on purpose. Returns the number of
-- rows deleted. Run daily, so each call deletes about one day of rows.
create function curator.prune_request_log(older_than interval)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
	n bigint;
begin
	delete from curator.request_log where at < now() - older_than;
	get diagnostics n = row_count;
	return n;
end;
$$;

-- Named roles too, not just public: Supabase can carry default privileges that grant EXECUTE on
-- new functions to anon/authenticated directly.
revoke execute on function curator.log_requests(jsonb) from public, anon, authenticated;
revoke execute on function curator.log_audit_events(jsonb) from public, anon, authenticated;
revoke execute on function curator.prune_request_log(interval) from public, anon, authenticated;
