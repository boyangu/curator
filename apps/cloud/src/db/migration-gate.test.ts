import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, type Logger } from '../log.js';
import { createTestDb, type TestDb } from '../test/harness.js';
import type { Queryable } from './db.js';
import { checkMigrations, migrationGate } from './migration-gate.js';
import { findSqlDir, listMigrations, migrate } from './migrate.js';

const sqlDir = findSqlDir();
const shipped = listMigrations(sqlDir).map((m) => m.name);
const rolesSql = readFileSync(join(sqlDir, 'roles.sql'), 'utf8');
const tmpDirs: string[] = [];

// A copy of sql/ holding only `names` (plus roles.sql), standing in for an
// image that ships a different set of migrations than the database has.
function sqlDirWith(names: string[], extra: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), 'curator-sql-'));
	tmpDirs.push(dir);
	for (const n of [...names, 'roles.sql']) copyFileSync(join(sqlDir, n), join(dir, n));
	for (const [n, text] of Object.entries(extra)) writeFileSync(join(dir, n), text);
	return dir;
}

afterAll(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function capture(): { log: Logger; lines: { level: string; msg: string; [k: string]: unknown }[] } {
	const lines: { level: string; msg: string; [k: string]: unknown }[] = [];
	return { log: createLogger((l) => lines.push(JSON.parse(l) as (typeof lines)[number])), lines };
}

// With the API's login role's privileges, the way the server runs the gate.
// A transaction-local role switch, not SET SESSION AUTHORIZATION: PGlite
// keeps the latter past the transaction (and past RESET), which would leave
// the rest of the file running as curator_api. The privilege checks here go
// by current_user, so the switch is the same test.
const asApi = <T>(t: TestDb, fn: (q: Queryable) => Promise<T>) =>
	t.db.begin(async (tx) => {
		await tx.query(`select set_config('role', 'curator_api', true)`);
		return fn(tx);
	});

describe('migration gate', () => {
	let t: TestDb;
	beforeAll(async () => {
		t = await createTestDb();
		await t.db.exec(rolesSql);
	});
	afterAll(() => t.db.close());

	it('lets the server start when every shipped migration has run', async () => {
		const { log, lines } = capture();
		await expect(asApi(t, (q) => migrationGate(q, log, sqlDir))).resolves.toBe(true);
		expect(lines).toEqual([]);
	});

	it('refuses, naming the file, when the image ships a migration the database lacks', async () => {
		const dir = sqlDirWith(shipped, { '0099_future.sql': 'create table curator.future (id int);' });
		const { log, lines } = capture();
		await expect(asApi(t, (q) => migrationGate(q, log, dir))).resolves.toBe(false);
		expect(lines).toEqual([
			expect.objectContaining({ level: 'error', msg: 'schema_behind', reason: 'behind', missing: ['0099_future.sql'], hint: expect.stringContaining('db:migrate') }),
		]);
	});

	it('reports every missing file, not just the newest', async () => {
		await t.db.query(`delete from curator.schema_migration where name = '0002_audit.sql'`);
		try {
			await expect(asApi(t, (q) => checkMigrations(q, sqlDir))).resolves.toEqual({ ok: false, reason: 'behind', missing: ['0002_audit.sql'] });
		} finally {
			await t.db.query(`insert into curator.schema_migration (name, checksum) values ('0002_audit.sql', 'restored')`);
		}
	});

	it('starts with a warning when the database is ahead of the image (a rollback)', async () => {
		const dir = sqlDirWith(shipped.filter((n) => n !== '0002_audit.sql'));
		const { log, lines } = capture();
		await expect(asApi(t, (q) => migrationGate(q, log, dir))).resolves.toBe(true);
		expect(lines).toEqual([expect.objectContaining({ level: 'warn', msg: 'schema_ahead', unknown: ['0002_audit.sql'] })]);
	});

	it('says roles.sql needs re-running when the login role lost its grant', async () => {
		await t.db.exec('revoke execute on function curator.applied_migrations() from curator_api');
		try {
			const { log, lines } = capture();
			await expect(asApi(t, (q) => migrationGate(q, log, sqlDir))).resolves.toBe(false);
			expect(lines).toEqual([expect.objectContaining({ msg: 'schema_behind', reason: 'no_grant', hint: expect.stringContaining('roles.sql') })]);
		} finally {
			await t.db.exec(rolesSql);
		}
	});

	it('keeps the migration list away from authenticated and anon', async () => {
		for (const role of ['authenticated', 'anon']) {
			await expect(
				t.db.begin(async (tx) => {
					await tx.query(`select set_config('role', $1, true)`, [role]);
					return tx.query('select * from curator.applied_migrations()');
				}),
			).rejects.toThrow(/permission denied/);
		}
	});

	it('gives the login role the names and still no read on the table itself', async () => {
		await expect(asApi(t, (q) => q.query('select * from curator.schema_migration'))).rejects.toThrow(/permission denied/);
	});
});

describe('migration gate before 0003', () => {
	let t: TestDb;
	beforeAll(async () => {
		t = await createTestDb({ migrate: false });
		await migrate(t.db, sqlDirWith(shipped.filter((n) => n < '0003_')));
	});
	afterAll(() => t.db.close());

	it('refuses and lists the files from 0003 on, since it cannot tell which ran', async () => {
		const { log, lines } = capture();
		await expect(migrationGate(t.db, log, sqlDir)).resolves.toBe(false);
		expect(lines).toEqual([
			expect.objectContaining({
				msg: 'schema_behind',
				reason: 'no_check_function',
				missing: shipped.filter((n) => n >= '0003_'),
				hint: expect.stringContaining('0003_migration_check.sql'),
			}),
		]);
	});
});

// The catalogue release (0004) goes out like any other: an image that ships
// it must not serve against a database that lacks it, even though nothing
// else changed and roles.sql grants the gate's function.
describe('migration gate before 0004', () => {
	let t: TestDb;
	beforeAll(async () => {
		t = await createTestDb({ migrate: false });
		await migrate(t.db, sqlDirWith(shipped.filter((n) => n < '0004_')));
		await t.db.exec(rolesSql);
	});
	afterAll(() => t.db.close());

	it('refuses an image that ships 0004_catalogue.sql, naming it', async () => {
		expect(shipped).toContain('0004_catalogue.sql');
		const { log, lines } = capture();
		await expect(asApi(t, (q) => migrationGate(q, log, sqlDir))).resolves.toBe(false);
		// Later files are missing too; the point is that 0004 is named.
		expect(lines).toEqual([expect.objectContaining({ msg: 'schema_behind', reason: 'behind', missing: shipped.filter((n) => n >= '0004_') })]);
		expect(shipped.filter((n) => n >= '0004_')[0]).toBe('0004_catalogue.sql');
	});

	it('lets it start once the owner has run the migration', async () => {
		await migrate(t.db, sqlDir);
		await expect(asApi(t, (q) => checkMigrations(q, sqlDir))).resolves.toEqual({ ok: true, unknown: [] });
	});
});

// 0007 adds the batch tables and the two functions roles.sql grants; the
// script must still run on a database without them (it is re-run after
// every migration), and the gate must name the file.
describe('migration gate before 0007', () => {
	let t: TestDb;
	beforeAll(async () => {
		t = await createTestDb({ migrate: false });
		await migrate(t.db, sqlDirWith(shipped.filter((n) => n < '0007_')));
		await t.db.exec(rolesSql);
	});
	afterAll(() => t.db.close());

	it('refuses an image that ships 0007_library_op_batch.sql, naming it', async () => {
		expect(shipped).toContain('0007_library_op_batch.sql');
		const { log, lines } = capture();
		await expect(asApi(t, (q) => migrationGate(q, log, sqlDir))).resolves.toBe(false);
		expect(lines).toEqual([expect.objectContaining({ msg: 'schema_behind', reason: 'behind', missing: shipped.filter((n) => n >= '0007_') })]);
	});

	it('starts once the owner runs it and re-runs roles.sql, which then grants the new functions', async () => {
		await migrate(t.db, sqlDir);
		await t.db.exec(rolesSql);
		await expect(asApi(t, (q) => checkMigrations(q, sqlDir))).resolves.toEqual({ ok: true, unknown: [] });
		await expect(asApi(t, (q) => q.query(`select * from curator.batches_to_tend(interval '1 day')`))).resolves.toEqual([]);
	});
});

// 0009 is the destructive one: the server-folded (bodied) snapshots and the
// fold's lease and rules go, the published rows stay, and the base table and
// the compaction functions roles.sql grants arrive. A database from before
// it (0008: bodied rows beside published ones) must come through with
// exactly its published snapshots.
describe('migration gate before 0009', () => {
	let t: TestDb;
	let user: string;
	beforeAll(async () => {
		t = await createTestDb({ migrate: false });
		await migrate(t.db, sqlDirWith(shipped.filter((n) => n < '0009_')));
		await t.db.exec(rolesSql);
		user = await t.createUser();
		await t.db.query(`insert into curator.library_snapshot (user_id, snapshot_seq, body) values ($1, 7, 'body'::bytea), ($1, 9, 'body'::bytea)`, [user]);
		await t.db.query(
			`insert into curator.library_snapshot (user_id, snapshot_seq, storage, state_sha256, published_by) values ($1, 8, '{"parts": []}', repeat('a', 64), 'master')`,
			[user],
		);
		await t.db.query(`insert into curator.library_snapshot_lease (user_id, holder, until) values ($1, 'job', now())`, [user]);
	});
	afterAll(() => t.db.close());

	it('refuses an image that ships 0009_library_base.sql, naming it', async () => {
		expect(shipped).toContain('0009_library_base.sql');
		const { log, lines } = capture();
		await expect(asApi(t, (q) => migrationGate(q, log, sqlDir))).resolves.toBe(false);
		expect(lines).toEqual([expect.objectContaining({ msg: 'schema_behind', reason: 'behind', missing: shipped.filter((n) => n >= '0009_') })]);
	});

	it('deletes the bodied snapshots and the lease, keeps the published ones, and grants the compaction functions once roles.sql is re-run', async () => {
		await migrate(t.db, sqlDir);
		await t.db.exec(rolesSql);
		await expect(asApi(t, (q) => checkMigrations(q, sqlDir))).resolves.toEqual({ ok: true, unknown: [] });
		const rows = await t.db.query<{ seq: number; published_by: string }>(`select snapshot_seq::int as seq, published_by from curator.library_snapshot where user_id = $1`, [user]);
		expect(rows).toEqual([{ seq: 8, published_by: 'master' }]);
		const columns = await t.db.query<{ column_name: string; is_nullable: string }>(
			`select column_name, is_nullable from information_schema.columns where table_schema = 'curator' and table_name = 'library_snapshot' order by column_name`,
		);
		expect(columns).toEqual([
			{ column_name: 'created_at', is_nullable: 'NO' },
			{ column_name: 'published_by', is_nullable: 'NO' },
			{ column_name: 'snapshot_seq', is_nullable: 'NO' },
			{ column_name: 'state_sha256', is_nullable: 'NO' },
			{ column_name: 'storage', is_nullable: 'NO' },
			{ column_name: 'user_id', is_nullable: 'NO' },
		]);
		await expect(t.db.query(`select * from curator.library_snapshot_lease`)).rejects.toThrow(/does not exist/);
		await expect(t.db.query(`select * from curator.users_due_for_snapshot_v3(1, interval '1 day', interval '5 minutes', interval '1 hour', interval '7 days')`)).rejects.toThrow(/does not exist/);
		// The new functions, as the API role: no account is due, the base of
		// this account can be set at its one snapshot, and compaction of a
		// log that holds nothing deletes nothing.
		await expect(asApi(t, (q) => q.query(`select * from curator.users_due_for_compaction(interval '7 days')`))).resolves.toEqual([]);
		await expect(asApi(t, (q) => q.query(`select curator.set_base_seq($1::uuid, 8)::int as base`, [user]))).resolves.toEqual([{ base: 8 }]);
		await expect(asApi(t, (q) => q.query(`select curator.compact_ops($1::uuid, 5000)::int as n`, [user]))).resolves.toEqual([{ n: 0 }]);
		expect(await t.db.query(`select base_seq::int as base, compacted_at is not null as done from curator.library_base where user_id = $1`, [user])).toEqual([{ base: 8, done: true }]);
	});
});

// 0005 is index-only, but it ships like any other file: a database without it
// is behind, and the gate says so by name.
describe('migration gate before 0005', () => {
	let t: TestDb;
	beforeAll(async () => {
		t = await createTestDb({ migrate: false });
		await migrate(t.db, sqlDirWith(shipped.filter((n) => n < '0005_')));
		await t.db.exec(rolesSql);
	});
	afterAll(() => t.db.close());

	it('refuses an image that ships 0005_library_op_device_seq.sql, naming it', async () => {
		expect(shipped).toContain('0005_library_op_device_seq.sql');
		const { log, lines } = capture();
		await expect(asApi(t, (q) => migrationGate(q, log, sqlDir))).resolves.toBe(false);
		expect(lines).toEqual([
			expect.objectContaining({ msg: 'schema_behind', reason: 'behind', missing: shipped.filter((n) => n >= '0005_') }),
		]);
	});

	it('creates the (user_id, device_id, seq) index once the owner runs it', async () => {
		await migrate(t.db, sqlDir);
		const rows = await t.db.query<{ indexdef: string }>(
			`select indexdef from pg_indexes where schemaname = 'curator' and indexname = 'library_op_user_device_seq'`,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.indexdef).toMatch(/\(user_id, device_id, seq\)/);
		await expect(asApi(t, (q) => checkMigrations(q, sqlDir))).resolves.toEqual({ ok: true, unknown: [] });
	});
});
