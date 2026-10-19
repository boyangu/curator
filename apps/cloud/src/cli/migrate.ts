// `pnpm --filter @curator/cloud db:migrate` (or `node dist/migrate.js` in the
// image). DATABASE_URL must be the schema owner's connection (`postgres` on
// Supabase) for this one command, not the API's `curator_api` role, which
// can create nothing. Then run sql/roles.sql (README "Database setup").

import { createPostgresDb } from '../db/db.js';
import { findSqlDir, migrate } from '../db/migrate.js';

const url = process.env.DATABASE_URL?.trim();
if (!url) {
	console.error('DATABASE_URL is not set (the owner connection, see apps/cloud/README.md)');
	process.exit(2);
}

const db = createPostgresDb(url, { max: 1 });
try {
	const r = await migrate(db, findSqlDir());
	console.log(JSON.stringify({ applied: r.applied, alreadyApplied: r.skipped }));
} catch (e) {
	console.error(e instanceof Error ? e.message : e);
	process.exitCode = 1;
} finally {
	await db.close();
}
