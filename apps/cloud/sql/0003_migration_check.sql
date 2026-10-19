-- Curator cloud, migration 0003: let the API see which migrations have run.
--
-- The server refuses to start when the database is behind the migration files it ships
-- (src/db/migration-gate.ts), so a release that needs a new table never serves requests against
-- the old schema. Its login role `curator_api` has no table grants (sql/roles.sql), and
-- `curator.schema_migration` is no exception: the runner creates it as the owner and grants
-- nothing on it. This SECURITY DEFINER function hands out the applied names only, nothing else
-- from the table, and is executable by `curator_api` alone.
--
-- The gate depends on this function, so it is the first thing a database must have before an
-- image with the gate can start: run this migration, then re-run sql/roles.sql for the grant.

create function curator.applied_migrations()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
	select m.name from curator.schema_migration m order by m.name
$$;

-- Named roles too, not just public: Supabase can carry default privileges that grant EXECUTE on
-- new functions to anon/authenticated directly.
revoke execute on function curator.applied_migrations() from public, anon, authenticated;
