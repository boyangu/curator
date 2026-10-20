// `pnpm --filter @curator/cloud db:migrate` (or `node dist/migrate.js` in the
// image). The connection must be the schema owner's (`postgres.<ref>` on
// Supabase) for this one command, not the API's `curator_api` role, which
// can create nothing. Then run sql/roles.sql (README "Database setup").
//
// With no DATABASE_URL in the environment and a terminal attached, it asks
// for the connection string with the input hidden, so the owner password
// never sits in a shell variable or the shell's history file.

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { createPostgresDb } from '../db/db.js';
import { findSqlDir, migrate } from '../db/migrate.js';

async function askHidden(question: string): Promise<string> {
	let muted = false;
	// Echo the question, then swallow everything typed or pasted after it.
	const output = new Writable({
		write(chunk, _enc, done) {
			if (!muted) process.stdout.write(chunk);
			done();
		},
	});
	const rl = createInterface({ input: process.stdin, output, terminal: true });
	const answer = new Promise<string>((resolve) => rl.question(question, resolve));
	muted = true;
	const value = await answer;
	rl.close();
	process.stdout.write('\n');
	return value.trim();
}

let url = process.env.DATABASE_URL?.trim();
if (!url && process.stdin.isTTY) {
	url = await askHidden('Owner connection string (postgres.<ref>…, input hidden): ');
}
if (!url) {
	console.error('No connection string: set DATABASE_URL or run this in a terminal (the owner connection, see apps/cloud/README.md)');
	process.exit(2);
}
// The API's role cannot create anything, so a migration with it would fail
// half-way through with a permissions error; say so up front instead.
if (/\/\/curator_api[.:@]/.test(url)) {
	console.error('That is the API role (curator_api). Migrations need the owner connection: user postgres.<ref>, the database password.');
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
