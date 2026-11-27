#!/usr/bin/env node
// Rotates the cloud API's database password end to end:
//
//   pnpm cloud:rotate-db-password
//
// 1. mints a new password and sets it on curator_api over the owner's
//    connection (only the owner can alter a role);
// 2. proves the new password logs in as curator_api through the pooler;
// 3. builds DATABASE_URL itself and hands it to Fly through `fly secrets
//    import` on stdin, never argv, never the screen, never a shell variable;
// 4. rolls the secret onto the machines and waits for /trpc/health.
//
// The password is never shown and never typed: it exists in this process and
// in Fly's secret. Hand-typed connection strings kept going wrong (a bare
// password stored as DATABASE_URL, an address typed into a prompt's question),
// a pasted `alter role` line stayed in the SQL Editor's saved queries, and
// each slip leaked the secret somewhere.
//
// Between steps 1 and 4 the running API still holds the old password, so
// requests can fail for the minute or two that takes. A run that stops in
// between leaves the role on a password nobody holds: run it again.
//
// Reads from the git-ignored root .env: CURATOR_FLY_TOKEN, CURATOR_FLY_APP,
// CURATOR_SUPABASE_URL (the project ref is its first host label),
// CURATOR_DB_POOLER_HOST (Supabase → Connect → Transaction pooler host) and
// CURATOR_DB_OWNER_URL (the owner connection; asked for with the input hidden
// when absent).

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadPostgres, scramVerifier } from './cloud-pg.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROLE = 'curator_api';
const PORT = 6543;
// The pooler keeps a role's credentials for a while after they change.
const LOGIN_WAIT_MS = 120_000;

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

function ask(prompt) {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase());
		});
	});
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

// Shape only, never echoing the value (as cloud-db-apply does).
function checkOwnerUrl(url) {
	let u;
	try { u = new URL(url); } catch { fail('the owner connection string is not a URL (value not shown)'); }
	if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') fail('the owner connection string must start with postgresql:// (value not shown)');
	if (!/^postgres([.]|$)/.test(decodeURIComponent(u.username))) fail('expected the owner user postgres.<ref> (value not shown)');
}

async function setPassword(postgres, ownerUrl, password) {
	const sql = postgres(ownerUrl, { prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} });
	try {
		const [role] = await sql`select 1 from pg_roles where rolname = ${ROLE}`;
		if (!role) return `the role ${ROLE} does not exist (apps/cloud/sql/roles.sql creates it)`;
		// A utility statement takes no parameters; the verifier is base64 and ours.
		await sql.unsafe(`alter role ${ROLE} with password '${scramVerifier(password)}'`);
		return null;
	} catch (e) {
		// postgres.js errors carry no connection string; the code is enough.
		return `${e?.code ?? ''} ${String(e?.message ?? e).slice(0, 120)}`.trim();
	} finally {
		await sql.end({ timeout: 2 });
	}
}

async function canLogin(postgres, url) {
	const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} });
	try {
		const [row] = await sql`select current_user as u`;
		return row.u === ROLE ? null : `logged in as ${row.u}, expected ${ROLE}`;
	} catch (e) {
		return e && e.code === '28P01' ? 'password rejected' : `${e?.code ?? ''} ${String(e?.message ?? e).slice(0, 120)}`.trim();
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
	if (!process.stdin.isTTY) fail('run this in a terminal: pnpm cloud:rotate-db-password (it asks before it changes anything)');
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
	let ownerUrl = env.CURATOR_DB_OWNER_URL?.trim();
	if (!ownerUrl) ownerUrl = await askHidden('Owner connection string (postgres.<ref>…, input hidden): ');
	if (!ownerUrl) fail('no owner connection string');
	checkOwnerUrl(ownerUrl);
	const postgres = await loadPostgres();

	const answer = await ask(`This replaces the ${ROLE} database password and restarts ${app}; requests can fail for a minute or two. Type yes to go on: `);
	if (answer !== 'yes') fail('stopped; nothing was changed.');
	const halfDone = `The ${ROLE} password was changed but ${app} does not have it yet: run this again.`;

	// Hex keeps the password safe inside a URL without escaping.
	const password = randomBytes(24).toString('hex').toUpperCase();
	const url = `postgresql://${ROLE}.${ref}:${password}@${host}:${PORT}/postgres`;

	process.stdout.write(`\nStep 1 of 4. Setting the new password on ${ROLE}… `);
	const refused = await setPassword(postgres, ownerUrl, password);
	if (refused) fail(`could not set the password: ${refused}`);
	console.log('done.');

	process.stdout.write('Step 2 of 4. Checking it logs in through the pooler… ');
	const deadline = Date.now() + LOGIN_WAIT_MS;
	for (;;) {
		const problem = await canLogin(postgres, url);
		if (!problem) break;
		if (Date.now() > deadline) fail(`${problem}. ${halfDone}`);
		await new Promise((r) => setTimeout(r, 3_000));
	}
	console.log('yes.');

	try {
		console.log('\nStep 3 of 4. Storing DATABASE_URL on Fly (sent over stdin, not shown)…');
		const flyEnv = { ...process.env, FLY_API_TOKEN: token };
		await run(flyctl, ['secrets', 'import', '--stage', '--app', app], { env: flyEnv, input: `DATABASE_URL=${url}\n` });

		console.log('\nStep 4 of 4. Restarting the server with it…');
		await run(flyctl, ['secrets', 'deploy', '--app', app], { env: flyEnv });
	} catch (e) {
		fail(`${e instanceof Error ? e.message : String(e)}. ${halfDone}`);
	}
	await waitHealthy(app);
	console.log(`\nDone: ${app} is healthy on the new password.`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
