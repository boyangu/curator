#!/usr/bin/env node
// Rotates the cloud API's database password end to end:
//
//   pnpm cloud:rotate-db-password
//
// 1. mints a new password locally and shows the one SQL line the owner runs in
//    the Supabase SQL Editor (only the owner can alter a role);
// 2. waits, then proves the new password logs in as curator_api;
// 3. builds DATABASE_URL itself and hands it to Fly through `fly secrets
//    import` on stdin, never argv, never the screen, never a shell variable;
// 4. rolls the secret onto the machines and waits for /trpc/health.
//
// Hand-typed connection strings kept going wrong (a bare password stored as
// DATABASE_URL, an address typed into a prompt's question), and each slip
// leaked the secret somewhere. This makes the only manual step one paste.
//
// Reads from the git-ignored root .env: CURATOR_FLY_TOKEN, CURATOR_FLY_APP,
// CURATOR_SUPABASE_URL (the project ref is its first host label) and
// CURATOR_DB_POOLER_HOST (Supabase → Connect → Transaction pooler host).

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROLE = 'curator_api';
const PORT = 6543;

function fail(msg) {
	console.error(`\nrotate-cloud-db-password: ${msg}`);
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

function findFlyctl() {
	const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['flyctl'], { encoding: 'utf8' });
	if (probe.status === 0) return 'flyctl';
	const local = join(homedir(), '.fly', 'bin', process.platform === 'win32' ? 'flyctl.exe' : 'flyctl');
	if (existsSync(local)) return local;
	fail('flyctl not found: install it from https://fly.io/docs/flyctl/install/');
}

function waitForEnter(prompt) {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase());
		});
	});
}

// postgres.js lives in apps/cloud, not at the repo root.
async function loadPostgres() {
	const require = createRequire(join(repoRoot, 'apps', 'cloud', 'package.json'));
	return (await import(pathToFileURL(require.resolve('postgres')).href)).default;
}

async function canLogin(postgres, url) {
	const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} });
	try {
		const [row] = await sql`select current_user as u`;
		return row.u === ROLE ? null : `logged in as ${row.u}, expected ${ROLE}`;
	} catch (e) {
		// postgres.js errors carry no connection string; the code is enough.
		return e && e.code === '28P01' ? 'password rejected (the alter role line has not run yet, or was mistyped)' : `${e?.code ?? ''} ${String(e?.message ?? e).slice(0, 120)}`;
	} finally {
		await sql.end({ timeout: 2 });
	}
}

function run(cmd, args, { env, input } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { env, stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'] });
		child.on('error', reject);
		child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${args.slice(0, 2).join(' ')} exited ${code}`))));
		if (input !== undefined) child.stdin.end(input);
	});
}

async function waitHealthy(app) {
	const url = `https://${app}.fly.dev/trpc/health`;
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
			if (res.ok && (await res.json())?.result?.data?.ok === true) return;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 5_000));
	}
	fail(`${url} did not come up within 3 minutes; check \`fly logs -a ${app}\``);
}

async function main() {
	if (!process.stdin.isTTY) fail('run this in a terminal: pnpm cloud:rotate-db-password (it waits for you between steps)');
	const env = { ...loadDotEnv(join(repoRoot, '.env')), ...process.env };
	const token = env.CURATOR_FLY_TOKEN?.trim();
	const app = env.CURATOR_FLY_APP?.trim();
	const host = env.CURATOR_DB_POOLER_HOST?.trim();
	let ref;
	try {
		ref = new URL(env.CURATOR_SUPABASE_URL ?? '').hostname.split('.')[0];
	} catch {
		ref = '';
	}
	if (!token) fail('CURATOR_FLY_TOKEN is not set in .env');
	if (!app) fail('CURATOR_FLY_APP is not set in .env');
	if (!host) fail('CURATOR_DB_POOLER_HOST is not set in .env (Supabase → Connect → Transaction pooler, the host after @)');
	if (!ref) fail('CURATOR_SUPABASE_URL is not set in .env');
	const flyctl = findFlyctl();
	const postgres = await loadPostgres();

	// Hex keeps the password safe inside a URL without escaping.
	const password = randomBytes(24).toString('hex').toUpperCase();
	const url = `postgresql://${ROLE}.${ref}:${password}@${host}:${PORT}/postgres`;

	console.log('\nStep 1 of 3. In Supabase, open the SQL Editor, start a new query, paste this line and click Run:\n');
	console.log(`    alter role ${ROLE} with password '${password}';\n`);
	console.log('Then delete that query from the SQL Editor\'s saved list (it holds the password).');
	console.log('Do not paste the line anywhere else.\n');

	for (;;) {
		const answer = await waitForEnter('Press Enter once it says Success (or type q to quit): ');
		if (answer === 'q') fail('stopped; nothing was changed on Fly. The old password still works unless the line was run.');
		process.stdout.write('Checking the new password logs in… ');
		const problem = await canLogin(postgres, url);
		if (!problem) {
			console.log('yes.');
			break;
		}
		console.log(`not yet: ${problem}.`);
	}

	console.log('\nStep 2 of 3. Storing DATABASE_URL on Fly (sent over stdin, not shown)…');
	const flyEnv = { ...process.env, FLY_API_TOKEN: token };
	await run(flyctl, ['secrets', 'import', '--stage', '--app', app], { env: flyEnv, input: `DATABASE_URL=${url}\n` });

	console.log('\nStep 3 of 3. Restarting the server with it…');
	await run(flyctl, ['secrets', 'deploy', '--app', app], { env: flyEnv });
	await waitHealthy(app);
	console.log(`\nDone: ${app} is healthy on the new password. Close this terminal tab to clear the screen.`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
