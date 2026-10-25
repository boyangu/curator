#!/usr/bin/env node
// Brings the cloud database up to the code in this checkout, as the owner:
//
//   pnpm cloud:db-apply            # apply, then verify
//   pnpm cloud:db-apply --check    # verify only, change nothing
//
// The four steps a release needs, in their required order, then a check:
//   1. numbered migrations (apps/cloud/sql/NNNN_*.sql) through the project's
//      own runner, which records each with its checksum;
//   2. sql/roles.sql (idempotent; grants on objects the migrations create);
//   3. sql/storage.sql (idempotent; the catalogue bucket and its policies);
//   4. a read-only verification of all of the above.
//
// The connection is the schema OWNER's (postgres.<ref>), from
// CURATOR_DB_OWNER_URL in the git-ignored root .env, or asked for with the
// input hidden when absent. It is handed to the runner through a child
// environment only: never argv, never the screen, never shell history. The
// API's own role (curator_api) is refused up front: it can create nothing.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cloudDir = join(repoRoot, 'apps', 'cloud');
const sqlDir = join(cloudDir, 'sql');
const checkOnly = process.argv.includes('--check');

function fail(msg) {
	console.error(`\ncloud-db-apply: ${msg}`);
	process.exit(1);
}

function loadDotEnv(path) {
	const out = {};
	if (!existsSync(path)) return out;
	for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 1) continue;
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		out[line.slice(0, eq).trim()] = value;
	}
	return out;
}

async function askHidden(question) {
	let muted = false;
	const output = new Writable({ write(chunk, _e, done) { if (!muted) process.stdout.write(chunk); done(); } });
	const rl = createInterface({ input: process.stdin, output, terminal: true });
	const answer = new Promise((resolve) => rl.question(question, resolve));
	muted = true;
	const value = await answer;
	rl.close();
	process.stdout.write('\n');
	return value.trim();
}

// Shape only, never echoing the value (a mis-pasted secret must not land in
// a terminal or a log; apps/cloud/src/db/db.ts does the same).
function checkUrl(url) {
	let u;
	try { u = new URL(url); } catch { fail('the owner connection string is not a URL (value not shown)'); }
	if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') fail('the owner connection string must start with postgresql:// (value not shown)');
	if (/^curator_api[.]?/.test(decodeURIComponent(u.username))) fail('that is the API role (curator_api); migrations need the owner (user postgres.<ref>)');
	if (!/^postgres([.]|$)/.test(decodeURIComponent(u.username))) fail('expected the owner user postgres.<ref> (value not shown)');
}

async function loadPostgres() {
	const require = createRequire(join(cloudDir, 'package.json'));
	return (await import(pathToFileURL(require.resolve('postgres')).href)).default;
}

function runMigrations(url) {
	return new Promise((resolve, reject) => {
		const tsx = join(cloudDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
		const child = spawn(tsx, ['src/cli/migrate.ts'], {
			cwd: cloudDir,
			env: { ...process.env, DATABASE_URL: url },
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: process.platform === 'win32',
		});
		let out = '';
		let err = '';
		child.stdout.on('data', (d) => { out += d; });
		child.stderr.on('data', (d) => { err += d; });
		child.on('error', reject);
		child.on('close', (code) => {
			if (code !== 0) return reject(new Error(`migration runner exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
			const line = out.trim().split('\n').pop() ?? '{}';
			try { resolve(JSON.parse(line)); } catch { resolve({ raw: line }); }
		});
	});
}

async function verify(sql) {
	const files = readdirSync(sqlDir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
	const applied = new Set((await sql`select name from curator.schema_migration`).map((r) => r.name));
	const rows = [];
	for (const f of files) rows.push([`migration ${f}`, applied.has(f)]);
	const [g] = await sql`
		select
			has_function_privilege('curator_api', 'curator.applied_migrations()', 'execute') as gate_grant,
			has_function_privilege('curator_api', 'curator.log_requests(jsonb)', 'execute') as log_grant,
			exists (select 1 from storage.buckets where id = 'catalogue' and public = false) as bucket,
			(select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'curator_catalogue%') as policies,
			(select count(*)::int from curator.catalogue_account) as entitled_accounts,
			coalesce((select relrowsecurity from pg_class where oid = to_regclass('curator.spotify_grant')), false) as spotify_rls`;
	rows.push(['roles.sql grants (API role)', g.gate_grant && g.log_grant]);
	rows.push(['storage bucket "catalogue", private', g.bucket]);
	rows.push([`storage policies (${g.policies} of 3)`, g.policies === 3]);
	rows.push([`catalogue accounts entitled (${g.entitled_accounts})`, g.entitled_accounts > 0]);
	// 0010: the Spotify grant holds sealed tokens; RLS is its second wall.
	rows.push(['curator.spotify_grant under RLS', g.spotify_rls]);
	return rows;
}

async function main() {
	const env = { ...loadDotEnv(join(repoRoot, '.env')), ...process.env };
	let url = env.CURATOR_DB_OWNER_URL?.trim();
	if (!url) {
		if (!process.stdin.isTTY) fail('CURATOR_DB_OWNER_URL is not set in .env and there is no terminal to ask in');
		url = await askHidden('Owner connection string (postgres.<ref>…, input hidden): ');
	}
	if (!url) fail('no connection string');
	checkUrl(url);

	const postgres = await loadPostgres();
	const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} });
	try {
		if (!checkOnly) {
			process.stdout.write('1/3 migrations… ');
			const r = await runMigrations(url);
			console.log(r.applied ? `applied ${r.applied.length ? r.applied.join(', ') : 'none (up to date)'}` : JSON.stringify(r));
			for (const [label, file] of [['2/3 roles.sql', 'roles.sql'], ['3/3 storage.sql', 'storage.sql']]) {
				process.stdout.write(`${label}… `);
				await sql.unsafe(readFileSync(join(sqlDir, file), 'utf8'));
				console.log('ok');
			}
		}
		console.log('\nverification:');
		const rows = await verify(sql);
		for (const [label, ok] of rows) console.log(`  ${ok ? 'ok  ' : 'MISSING'}  ${label}`);
		if (rows.some(([, ok]) => !ok)) process.exitCode = 1;
		else console.log('\nThe database matches this checkout.');
	} catch (e) {
		// postgres.js errors carry no connection string; the code and message suffice.
		fail(`${e?.code ? e.code + ' ' : ''}${String(e?.message ?? e).slice(0, 300)}`);
	} finally {
		await sql.end({ timeout: 2 });
	}
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
