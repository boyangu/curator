#!/usr/bin/env node
// Exports one account's op log and snapshot manifests from the cloud
// database, as the owner, to a gzipped NDJSON file:
//
//   pnpm cloud:export-ops --user <uuid> [--out <path>]
//
// A safety net before a destructive step (the rebase onto a published
// snapshot deletes the account's ops below the base: apps/cloud/README.md
// "Snapshots"), not a backup system: there is no restore script, and the
// file is the raw rows, one JSON object a line, in seq order:
//   { "t": "op", "seq", "op_id", "device_id", "client_ts", "schema_version",
//     "entity", "entity_id", "kind", "payload", "received_at" }
//   { "t": "snapshot", "snapshot_seq", "created_at", "storage",
//     "state_sha256", "published_by" }      (after the ops)
// Rows stream through a server-side cursor (1,000 a fetch) into gzip, so a
// 500k-op log never sits in memory. The default path is under planning/,
// which is git-ignored.
//
// The connection is the schema OWNER's (postgres.<ref>), from
// CURATOR_DB_OWNER_URL in the git-ignored root .env, or asked for with the
// input hidden when absent; it is never printed, never in argv (the same
// handling as scripts/cloud-db-apply.mjs).

import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createGzip } from 'node:zlib';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cloudDir = join(repoRoot, 'apps', 'cloud');

function fail(msg) {
	console.error(`\ncloud-export-ops: ${msg}`);
	process.exit(1);
}

const { values } = parseArgs({ options: { user: { type: 'string' }, out: { type: 'string' } } });
const userId = values.user?.trim().toLowerCase();
if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(userId)) fail('--user <uuid> is required');
const today = new Date().toISOString().slice(0, 10);
const outPath = resolve(values.out ?? join(repoRoot, 'planning', 'private', 'backups', `library_op-${userId.slice(0, 8)}-${today}.ndjson.gz`));
if (existsSync(outPath)) fail(`${outPath} exists already; pass --out for another path`);

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

// Shape only, never echoing the value.
function checkUrl(url) {
	let u;
	try { u = new URL(url); } catch { fail('the owner connection string is not a URL (value not shown)'); }
	if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') fail('the owner connection string must start with postgresql:// (value not shown)');
	if (!/^postgres([.]|$)/.test(decodeURIComponent(u.username))) fail('expected the owner user postgres.<ref> (value not shown)');
}

async function loadPostgres() {
	const require = createRequire(join(cloudDir, 'package.json'));
	return (await import(pathToFileURL(require.resolve('postgres')).href)).default;
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
	const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 15, idle_timeout: 0, onnotice: () => {} });
	mkdirSync(dirname(outPath), { recursive: true });
	const gzip = createGzip({ level: 6 });
	const file = createWriteStream(outPath, { flags: 'wx' });
	const done = pipeline(gzip, file);
	const write = async (line) => {
		if (!gzip.write(line + '\n')) await new Promise((r) => gzip.once('drain', r));
	};
	let ops = 0;
	let snapshots = 0;
	try {
		process.stdout.write(`exporting ops of ${userId.slice(0, 8)}… `);
		// bigint columns come back as strings from the driver and stay so:
		// exact, whatever the seq.
		const cursor = sql
			.unsafe(
				`select seq::text as seq, op_id::text as op_id, device_id, client_ts::text as client_ts, schema_version, entity, entity_id, kind, payload, received_at
				from curator.library_op where user_id = $1 order by seq`,
				[userId],
			)
			.cursor(1000);
		for await (const rows of cursor) {
			for (const r of rows) await write(JSON.stringify({ t: 'op', ...r }));
			ops += rows.length;
			if (ops % 50_000 === 0) process.stdout.write(`${ops.toLocaleString('en')}… `);
		}
		const manifests = await sql.unsafe(
			`select snapshot_seq::text as snapshot_seq, created_at, storage, state_sha256, published_by
			from curator.library_snapshot where user_id = $1 order by snapshot_seq`,
			[userId],
		);
		for (const r of manifests) await write(JSON.stringify({ t: 'snapshot', ...r }));
		snapshots = manifests.length;
		gzip.end();
		await done;
		const bytes = statSync(outPath).size;
		console.log(`done\n  ops        ${ops.toLocaleString('en')}\n  snapshots  ${snapshots}\n  bytes      ${bytes.toLocaleString('en')}\n  file       ${outPath}`);
	} catch (e) {
		gzip.destroy();
		fail(`${e?.code ? e.code + ' ' : ''}${String(e?.message ?? e).slice(0, 300)}`);
	} finally {
		await sql.end({ timeout: 2 });
	}
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
