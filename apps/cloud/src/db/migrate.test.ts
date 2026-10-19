import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../test/harness.js';
import { findSqlDir, listMigrations, migrate, MigrationDriftError } from './migrate.js';

const sqlDir = findSqlDir();
const rolesSql = readFileSync(join(sqlDir, 'roles.sql'), 'utf8');

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
		expect(tables.map((r) => r.table_name)).toEqual(['audit_event', 'device', 'library_op', 'library_snapshot', 'request_log', 'schema_migration']);
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
			where n.nspname = 'curator' and c.relkind = 'r' and c.relname <> 'schema_migration' order by c.relname`,
		);
		expect(rows).toEqual([
			{ relname: 'audit_event', relrowsecurity: true },
			{ relname: 'device', relrowsecurity: true },
			{ relname: 'library_op', relrowsecurity: true },
			{ relname: 'library_snapshot', relrowsecurity: true },
			{ relname: 'request_log', relrowsecurity: true },
		]);
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
	// must be curator_api for these to mean anything (PGlite's is postgres).
	const asSession = async (sql: string[]) =>
		t.db.begin(async (tx) => {
			await tx.exec('set local session authorization curator_api');
			let last: unknown[] = [];
			for (const s of sql) last = await tx.query(s);
			return last;
		});

	it('lets the login role switch to authenticated, and only then reach the tables', async () => {
		const rows = await asSession([`select set_config('role', 'authenticated', true)`, 'select count(*)::int as n from curator.library_op']);
		expect(rows).toEqual([{ n: 0 }]);
	});

	it('does not let the login role become any other role', async () => {
		await expect(asSession([`select set_config('role', 'service_role', true)`])).rejects.toThrow(/permission denied/);
		await expect(asSession([`select set_config('role', 'postgres', true)`])).rejects.toThrow(/permission denied/);
	});

	it('keeps the cross-user snapshot list away from authenticated and anon', async () => {
		const due = `select * from curator.users_due_for_snapshot(1, interval '1 hour')`;
		await expect(asRole('curator_api', due)).resolves.toEqual([]);
		await expect(asRole('authenticated', due)).rejects.toThrow(/permission denied/);
		await expect(asRole('anon', due)).rejects.toThrow(/permission denied/);
	});

	it('gives anon nothing in the curator schema', async () => {
		await expect(asRole('anon', 'select * from curator.library_op')).rejects.toThrow(/permission denied/);
	});
});
