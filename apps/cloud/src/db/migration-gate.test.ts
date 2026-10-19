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
