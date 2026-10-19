// A deliberately tiny migration runner: plain SQL files in apps/cloud/sql named
// `NNNN_name.sql`, applied in name order, each in its own transaction, and
// recorded in `curator.schema_migration` with a checksum. The SQL files are
// the schema (no ORM model to drift from them), readable and pasteable into
// the Supabase SQL editor as they are.
//
// An applied file that has since changed is an error, not a re-run: Postgres
// migrations are not idempotent, and the fix for a shipped mistake is the
// next numbered file.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

export const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

export type MigrationResult = { applied: string[]; skipped: string[] };

export class MigrationDriftError extends Error {
	override readonly name = 'MigrationDriftError';
}

// The sql/ directory next to this package, found by walking up from this
// module: it is src/db/ under tsx and dist/ in the bundled image.
export function findSqlDir(from: string = dirname(fileURLToPath(import.meta.url))): string {
	let dir = from;
	for (;;) {
		const candidate = join(dir, 'sql');
		if (existsSync(join(candidate, '0001_init.sql'))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`no sql/ directory with 0001_init.sql above ${from}`);
		dir = parent;
	}
}

function checksum(text: string): string {
	// Line endings normalised so a Windows checkout does not read as drift.
	return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

export function listMigrations(sqlDir: string): { name: string; sql: string; checksum: string }[] {
	return readdirSync(sqlDir)
		.filter((f) => MIGRATION_FILE.test(f))
		.sort()
		.map((name) => {
			const sql = readFileSync(join(sqlDir, name), 'utf8');
			return { name, sql, checksum: checksum(sql) };
		});
}

export async function migrate(db: Db, sqlDir: string = findSqlDir()): Promise<MigrationResult> {
	// The bookkeeping table lives in the schema the first migration creates,
	// so it is made here, before that migration, and 0001 must tolerate the
	// schema already existing.
	await db.exec(`
		create schema if not exists curator;
		create table if not exists curator.schema_migration (
			name text primary key,
			checksum text not null,
			applied_at timestamptz not null default now()
		);
	`);
	const done = new Map(
		(await db.query<{ name: string; checksum: string }>('select name, checksum from curator.schema_migration')).map((r) => [r.name, r.checksum]),
	);
	const result: MigrationResult = { applied: [], skipped: [] };
	for (const m of listMigrations(sqlDir)) {
		const prior = done.get(m.name);
		if (prior !== undefined) {
			if (prior !== m.checksum) throw new MigrationDriftError(`${m.name} changed after it was applied; add a new migration instead`);
			result.skipped.push(m.name);
			continue;
		}
		await db.begin(async (tx) => {
			await tx.exec(m.sql);
			await tx.query('insert into curator.schema_migration (name, checksum) values ($1, $2)', [m.name, m.checksum]);
		});
		result.applied.push(m.name);
	}
	return result;
}
