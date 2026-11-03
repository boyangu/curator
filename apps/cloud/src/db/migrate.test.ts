import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, ROLES_SQL as rolesSql, type TestDb } from '../test/harness.js';
import { findSqlDir, listMigrations, migrate, MigrationDriftError } from './migrate.js';

const sqlDir = findSqlDir();

// Tables holding a user's rows: RLS on, every policy keyed on auth.uid().
const USER_TABLES = [
	'audit_event',
	'catalogue_account',
	'catalogue_item',
	'device',
	'device_session',
	'library_base',
	'library_op',
	'library_op_batch',
	'library_op_fence',
	'library_op_staged',
	'library_snapshot',
	'request_log',
	'spotify_grant',
	'catalog_watch',
];

// The Global Catalog (sql/0011): shared across accounts, reachable only as curator_api.
const SHARED_TABLES = [
	'admin_user',
	'catalog_agent_case',
	'catalog_audio',
	'catalog_chart_entry',
	'catalog_credit_rule',
	'catalog_cursor',
	'catalog_edge',
	'catalog_edge_evidence',
	'catalog_enrich_task',
	'catalog_event',
	'catalog_event_subject',
	'catalog_fact',
	'catalog_genre',
	'catalog_identifier',
	'catalog_inbox',
	'catalog_ingest_batch',
	'catalog_insight',
	'catalog_merge_log',
	'catalog_not_same',
	'catalog_object',
	'catalog_playlist_item',
	'catalog_review',
	'catalog_signal',
	'catalog_source_block',
	'catalog_source_object',
	'genre_alias',
	'provider_budget',
	'tracker',
	'tracker_run',
];

describe('migrations', () => {
	let t: TestDb;
	beforeAll(async () => {
		t = await createTestDb({ migrate: false });
	});
	afterAll(() => t.db.close());

	it('apply cleanly, then a second run is a no-op', async () => {
		const names = listMigrations(sqlDir).map((m) => m.name);
		expect(names[0]).toBe('0001_init.sql');

		const first = await migrate(t.db, sqlDir);
		expect(first).toEqual({ applied: names, skipped: [] });
		const second = await migrate(t.db, sqlDir);
		expect(second).toEqual({ applied: [], skipped: names });

		const recorded = await t.db.query<{ name: string }>('select name from curator.schema_migration order by name');
		expect(recorded.map((r) => r.name)).toEqual(names);
		const tables = await t.db.query<{ table_name: string }>(
			`select table_name from information_schema.tables where table_schema = 'curator' order by table_name`,
		);
		expect(tables.map((r) => r.table_name)).toEqual([...USER_TABLES, ...SHARED_TABLES, 'schema_migration'].sort());
	});

	it('refuses to run when an applied file changed', async () => {
		await t.db.query(`update curator.schema_migration set checksum = 'tampered' where name = '0001_init.sql'`);
		await expect(migrate(t.db, sqlDir)).rejects.toBeInstanceOf(MigrationDriftError);
		const [m] = listMigrations(sqlDir);
		await t.db.query(`update curator.schema_migration set checksum = $1 where name = '0001_init.sql'`, [m!.checksum]);
	});

	it('enables RLS on every curator table that holds user data', async () => {
		const rows = await t.db.query<{ relname: string; relrowsecurity: boolean }>(
			`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
			where n.nspname = 'curator' and c.relkind = 'r' and c.relname = any($1::text[]) order by c.relname`,
			[`{${USER_TABLES.join(',')}}`],
		);
		expect(rows).toEqual([...USER_TABLES].sort().map((relname) => ({ relname, relrowsecurity: true })));
	});

	// The Global Catalog's shared tables belong to no user: no RLS to judge
	// them, so `authenticated` and `anon` hold no privilege on them at all
	// (curator_api's grants come from roles.sql).
	it('grants the shared catalogue tables to no client role', async () => {
		const rows = await t.db.query<{ table_name: string; grantee: string }>(
			`select table_name, grantee from information_schema.role_table_grants
			where table_schema = 'curator' and table_name = any($1::text[]) and grantee in ('authenticated', 'anon', 'public')`,
			[`{${SHARED_TABLES.join(',')}}`],
		);
		expect(rows).toEqual([]);
	});
});

describe('sql/roles.sql', () => {
	let t: TestDb;
	beforeAll(async () => {
		t = await createTestDb();
		// Re-runnable by design; run it twice to prove it.
		await t.db.exec(rolesSql);
		await t.db.exec(rolesSql);
	});
	afterAll(() => t.db.close());

	const asRole = async (role: string, sql: string) =>
		t.db.begin(async (tx) => {
			await tx.query(`select set_config('role', $1, true)`, [role]);
			return tx.query(sql);
		});

	it('creates a login role that cannot bypass RLS or inherit grants', async () => {
		const [r] = await t.db.query<Record<string, boolean>>(
			`select rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = 'curator_api'`,
		);
		expect(r).toEqual({ rolcanlogin: true, rolinherit: false, rolbypassrls: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false });
	});

	it('gives the login role no table access of its own', async () => {
		await expect(asRole('curator_api', 'select * from curator.library_op')).rejects.toThrow(/permission denied/);
		await expect(asRole('curator_api', 'select * from curator.device')).rejects.toThrow(/permission denied/);
	});

	// SET ROLE is checked against the session user, so the session itself
	// must be curator_api for these to mean anything (PGlite's is postgres,
	// a superuser that may become anyone). PGlite keeps SET [LOCAL] SESSION
	// AUTHORIZATION past the transaction and past RESET, so on the shared
	// instance it would leave every later test here running as curator_api,
	// and the permission-denied checks would pass for the wrong reason. Each
	// call gets a throwaway instance instead, closed with the session in it.
	const asSession = async (sql: string[]) => {
		const fresh = await createTestDb();
		try {
			await fresh.db.exec(rolesSql);
			return await fresh.db.begin(async (tx) => {
				await tx.exec('set local session authorization curator_api');
				let last: unknown[] = [];
				for (const s of sql) last = await tx.query(s);
				return last;
			});
		} finally {
			await fresh.db.close();
		}
	};

	it('lets the login role switch to authenticated, and only then reach the tables', async () => {
		const rows = await asSession([`select set_config('role', 'authenticated', true)`, 'select count(*)::int as n from curator.library_op']);
		expect(rows).toEqual([{ n: 0 }]);
	});

	it('does not let the login role become any other role', async () => {
		await expect(asSession([`select set_config('role', 'service_role', true)`])).rejects.toThrow(/permission denied/);
		await expect(asSession([`select set_config('role', 'postgres', true)`])).rejects.toThrow(/permission denied/);
	});

	it('drops the snapshot-fold rules (0001 / 0007 / 0008) with 0009', async () => {
		const gone = await t.db.query<{ n: number }>(
			`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
			where n.nspname = 'curator' and p.proname like 'users_due_for_snapshot%'`,
		);
		expect(gone).toEqual([{ n: 0 }]);
	});

	it('keeps the cross-user lists (batch upkeep, compaction) and the compaction writers for the login role alone', async () => {
		for (const sql of [
			`select * from curator.batches_to_tend(interval '1 day')`,
			`select * from curator.users_due_for_compaction(interval '7 days')`,
		]) {
			await expect(asRole('curator_api', sql)).resolves.toEqual([]);
			await expect(asRole('authenticated', sql)).rejects.toThrow(/permission denied/);
			await expect(asRole('anon', sql)).rejects.toThrow(/permission denied/);
		}
		// The writers: callable by the login role (a base of 0 on an account
		// with no snapshot is the one value set_base_seq takes there), refused
		// to everyone else.
		const user = await t.createUser();
		for (const sql of [`select curator.set_base_seq('${user}', 0)`, `select curator.compact_ops('${user}', 10)`]) {
			await expect(asRole('curator_api', sql)).resolves.toHaveLength(1);
			await expect(asRole('authenticated', sql)).rejects.toThrow(/permission denied/);
			await expect(asRole('anon', sql)).rejects.toThrow(/permission denied/);
		}
		// The batch tables and the base are the user's own, through RLS; never the login role's.
		for (const table of ['library_op_batch', 'library_op_staged', 'library_op_fence', 'library_base']) {
			await expect(asRole('curator_api', `select * from curator.${table}`)).rejects.toThrow(/permission denied/);
			await expect(asRole('anon', `select * from curator.${table}`)).rejects.toThrow(/permission denied/);
		}
		// wake_self rings the caller's own channel only, so authenticated may call it; anon may not.
		await expect(asRole('anon', 'select curator.wake_self(1)')).rejects.toThrow(/permission denied/);
	});

	it('gives anon nothing in the curator schema', async () => {
		await expect(asRole('anon', 'select * from curator.library_op')).rejects.toThrow(/permission denied/);
		await expect(asRole('anon', 'select * from curator.catalogue_item')).rejects.toThrow(/permission denied/);
		await expect(asRole('anon', 'select * from curator.catalogue_account')).rejects.toThrow(/permission denied/);
	});

	it('gives the login role no catalogue access of its own', async () => {
		await expect(asRole('curator_api', 'select * from curator.catalogue_item')).rejects.toThrow(/permission denied/);
		await expect(asRole('curator_api', 'select curator.catalogue_entitled()')).rejects.toThrow(/permission denied/);
	});

	// Last on purpose, and the reason the asSession instances are throwaway:
	// every check in this block ran as the role it names, on a session that
	// is still the owner's.
	it('leaves the shared instance in the owner session', async () => {
		await expect(t.db.query('select session_user::text as s, current_user::text as c')).resolves.toEqual([{ s: 'postgres', c: 'postgres' }]);
	});
});
