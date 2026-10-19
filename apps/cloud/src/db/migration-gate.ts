// The boot-time schema check: the server compares the migrations it ships
// (sql/NNNN_*.sql, the files `db:migrate` would apply) with what the
// database has recorded, and refuses to start when any is missing. Migrations
// are not run on deploy (README "Release"), so without this a release that
// needs a new table would boot, pass the health check and fail on the first
// request that touches it.
//
// It runs as the API's own login role, which cannot read
// curator.schema_migration; curator.applied_migrations() (sql/0003) hands it
// the names. A database that is *ahead* (an older image rolled back onto a
// newer schema) starts with a warning: migrations are additive, and refusing
// would make a rollback impossible exactly when it is needed.

import type { Logger } from '../log.js';
import type { Queryable } from './db.js';
import { findSqlDir, listMigrations } from './migrate.js';

export type MigrationCheck = { ok: true; unknown: string[] } | { ok: false; missing: string[]; reason: 'behind' | 'no_check_function' | 'no_grant' };

// Postgres SQLSTATEs, present on errors from both postgres.js and PGlite.
const UNDEFINED_FUNCTION = '42883';
const UNDEFINED_SCHEMA = '3F000';
const INSUFFICIENT_PRIVILEGE = '42501';

function sqlState(e: unknown): string | undefined {
	return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
}

export async function checkMigrations(db: Queryable, sqlDir: string = findSqlDir()): Promise<MigrationCheck> {
	const shipped = listMigrations(sqlDir).map((m) => m.name);
	let applied: Set<string>;
	try {
		const rows = await db.query<{ name: string }>('select name from curator.applied_migrations() as name');
		applied = new Set(rows.map((r) => r.name));
	} catch (e) {
		// Before 0003 the function does not exist, so which files ran is not
		// knowable from here; every shipped file from 0003 on is reported.
		const code = sqlState(e);
		if (code === UNDEFINED_FUNCTION || code === UNDEFINED_SCHEMA) {
			return { ok: false, reason: 'no_check_function', missing: shipped.filter((n) => n >= '0003_') };
		}
		// 0003 ran but sql/roles.sql was not re-run after it.
		if (code === INSUFFICIENT_PRIVILEGE) return { ok: false, reason: 'no_grant', missing: [] };
		throw e;
	}
	const missing = shipped.filter((n) => !applied.has(n));
	if (missing.length > 0) return { ok: false, reason: 'behind', missing };
	return { ok: true, unknown: [...applied].filter((n) => !shipped.includes(n)).sort() };
}

const HINT: Record<Extract<MigrationCheck, { ok: false }>['reason'], string> = {
	behind: 'run `db:migrate` as the owner, then re-run sql/roles.sql (apps/cloud/README.md "Release")',
	no_check_function: 'curator.applied_migrations() does not exist: run `db:migrate` as the owner (through 0003_migration_check.sql), then re-run sql/roles.sql',
	no_grant: 'curator_api cannot execute curator.applied_migrations(): re-run sql/roles.sql as the owner',
};

// Logs the outcome; false means the caller must not serve.
export async function migrationGate(db: Queryable, log: Logger, sqlDir?: string): Promise<boolean> {
	const r = await checkMigrations(db, sqlDir);
	if (!r.ok) {
		log.error('schema_behind', { reason: r.reason, missing: r.missing, hint: HINT[r.reason] });
		return false;
	}
	if (r.unknown.length > 0) log.warn('schema_ahead', { unknown: r.unknown });
	return true;
}
