-- The API's login role. Run once as `postgres` in the Supabase SQL editor AFTER the migrations
-- (it grants on objects they create), and again after any migration that adds a function the API
-- calls directly. Re-runnable: every statement is idempotent.
--
-- `curator_api` can log in and do almost nothing as itself: no table privileges, no BYPASSRLS,
-- NOINHERIT so it does not silently hold `authenticated`'s grants. Every request switches to
-- `authenticated` inside its transaction (src/db/user-tx.ts) with the caller's claims, so the RLS
-- policies decide what each statement can see; a leaked DATABASE_URL is worth one user's rows
-- per forged claim at most, never a policy bypass, and never DDL. The service-role key and the
-- `postgres` password stay out of the API entirely.
--
-- No password here: set it separately so it never lands in the repo, e.g.
--   alter role curator_api with password '<generated, 32+ chars>';
-- then build DATABASE_URL from it (README "Database setup").

do $$
begin
	if not exists (select 1 from pg_roles where rolname = 'curator_api') then
		create role curator_api login;
	end if;
end
$$;

alter role curator_api with login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

-- Membership is what lets the API `set role authenticated`; with NOINHERIT it confers nothing
-- until that switch happens.
grant authenticated to curator_api;

grant usage on schema curator to curator_api;

-- The snapshot sweep's user list (sql/0001_init.sql). Not granted to `authenticated`: it is the
-- one function that reads across users.
grant execute on function curator.users_due_for_snapshot(bigint, interval) to curator_api;

-- The access log and audit trail (sql/0002_audit.sql): write-only for the API through these
-- definer functions. No table grant at all, so it can neither read rows back nor update or
-- delete them; only the owner can.
grant execute on function curator.log_requests(jsonb) to curator_api;
grant execute on function curator.log_audit_events(jsonb) to curator_api;
grant execute on function curator.prune_request_log(interval) to curator_api;

-- The boot-time migration gate (sql/0003_migration_check.sql): the applied migration names, and
-- no other access to curator.schema_migration.
grant execute on function curator.applied_migrations() to curator_api;

-- A runaway query should fail, not hold a pooled connection; the slowest legitimate statement is
-- a 5000-op page of the snapshot fold.
alter role curator_api set statement_timeout = '30s';
alter role curator_api set idle_in_transaction_session_timeout = '60s';
