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

alter role curator_api with login noinherit;

-- Supabase's `postgres` is not a superuser, and Postgres refuses to even name
-- SUPERUSER, REPLICATION or BYPASSRLS in an ALTER ROLE from a non-superuser
-- (42501), so the role cannot be stripped of them here. They are off for any
-- role `create role` makes, and a non-superuser could never have granted them;
-- this asserts it instead, so a pre-existing over-powered role fails the
-- script rather than serving the API.
do $$
declare
	r pg_roles%rowtype;
begin
	select * into r from pg_roles where rolname = 'curator_api';
	if r.rolsuper or r.rolreplication or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolinherit or not r.rolcanlogin then
		raise exception 'curator_api has unexpected attributes (super %, replication %, bypassrls %, createrole %, createdb %, inherit %, login %); drop and recreate it',
			r.rolsuper, r.rolreplication, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolinherit, r.rolcanlogin;
	end if;
end
$$;

-- Membership is what lets the API `set role authenticated`; with NOINHERIT it confers nothing
-- until that switch happens.
grant authenticated to curator_api;

grant usage on schema curator to curator_api;

-- The sweeps' cross-user reads and the compaction writers, ids and counts only, so never
-- `authenticated`. Conditional so this script still runs on a database that has not had the
-- migration yet (it is re-run after every migration, and the migration gate tests run it against
-- older schemas).
--   0007: the batch upkeep list (expire idle batches, finish stalled commits).
--   0009: the base model. users_due_for_compaction lists accounts whose oldest kept snapshot has
--   aged past the base; set_base_seq and compact_ops are what the sweep (and the operator's
--   `compact` CLI) then run, outside any user transaction. The snapshot-fold rules of 0001 / 0007 /
--   0008 are dropped by 0009 and no longer granted.
do $$
begin
	if to_regprocedure('curator.batches_to_tend(interval)') is not null then
		grant execute on function curator.batches_to_tend(interval) to curator_api;
	end if;
	if to_regprocedure('curator.users_due_for_compaction(interval)') is not null then
		grant execute on function curator.users_due_for_compaction(interval) to curator_api;
	end if;
	if to_regprocedure('curator.set_base_seq(uuid, bigint)') is not null then
		grant execute on function curator.set_base_seq(uuid, bigint) to curator_api;
	end if;
	if to_regprocedure('curator.compact_ops(uuid, int)') is not null then
		grant execute on function curator.compact_ops(uuid, int) to curator_api;
	end if;
end
$$;

-- The access log and audit trail (sql/0002_audit.sql): write-only for the API through these
-- definer functions. No table grant at all, so it can neither read rows back nor update or
-- delete them; only the owner can.
grant execute on function curator.log_requests(jsonb) to curator_api;
grant execute on function curator.log_audit_events(jsonb) to curator_api;
grant execute on function curator.prune_request_log(interval) to curator_api;

-- The boot-time migration gate (sql/0003_migration_check.sql): the applied migration names, and
-- no other access to curator.schema_migration.
grant execute on function curator.applied_migrations() to curator_api;

-- A runaway query should fail, not hold a pooled connection; the slowest legitimate statements are
-- one chunk of a batch commit's move (sized by time to a few seconds, src/sync/batch.ts) and one
-- compact_ops call (5,000 rows, src/sync/compact.ts).
alter role curator_api set statement_timeout = '30s';
alter role curator_api set idle_in_transaction_session_timeout = '60s';
