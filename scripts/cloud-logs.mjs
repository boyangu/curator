#!/usr/bin/env node
// Prints phones' log records from the cloud database, oldest first, as the
// owner (apps/cloud/sql/0036_client_log.sql: nothing else may read them):
//
//   pnpm cloud:logs                              the last 2 hours
//   pnpm cloud:logs --since 1d --level warn
//   pnpm cloud:logs --area updater --install 3f0c8a52 --limit 2000
//   pnpm cloud:logs --follow                     and what arrives from now on
//
// --since counts back from now by the record's own time (30m, 2h, 3d; a week
// is kept). --follow goes by arrival, since a phone uploads in batches.
// --json prints the rows as they are. Read-only. The connection is
// CURATOR_DB_OWNER_URL, as for scripts/cloud-db-apply.mjs; never printed.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS = ['debug', 'info', 'warn', 'error'];

function fail(msg) {
	console.error(`\ncloud-logs: ${msg}`);
	process.exit(1);
}

const { values } = parseArgs({
	options: {
		since: { type: 'string', default: '2h' },
		level: { type: 'string', default: 'debug' },
		area: { type: 'string' },
		install: { type: 'string' },
		limit: { type: 'string', default: '1000' },
		follow: { type: 'boolean', default: false },
		json: { type: 'boolean', default: false },
	},
});
const span = /^(\d+)([mhd])$/.exec(values.since);
if (!span) fail('--since takes a number and m, h or d: 30m, 2h, 3d');
const sinceSec = Number(span[1]) * { m: 60, h: 3600, d: 86400 }[span[2]];
if (!LEVELS.includes(values.level)) fail(`--level takes ${LEVELS.join(', ')}`);
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1) fail('--limit takes a number');

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

const url = { ...loadDotEnv(join(repoRoot, '.env')), ...process.env }.CURATOR_DB_OWNER_URL?.trim();
if (!url) fail('CURATOR_DB_OWNER_URL is not set in .env');
try {
	if (!/^postgres([.]|$)/.test(decodeURIComponent(new URL(url).username))) fail('expected the owner user postgres.<ref> (value not shown)');
} catch {
	fail('the owner connection string is not a URL (value not shown)');
}

const require = createRequire(join(repoRoot, 'apps', 'cloud', 'package.json'));
const postgres = (await import(pathToFileURL(require.resolve('postgres')).href)).default;
const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} });

// A phone's log is whatever its apps and libraries said: no control character
// of it reaches the terminal.
// eslint-disable-next-line no-control-regex
const plain = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '·');

function print(r) {
	if (values.json) return console.log(JSON.stringify(r));
	const at = new Date(r.ts).toLocaleString('sv');
	const err = r.err ? JSON.parse(r.err) : null;
	console.log(plain(`${at} ${r.level.toUpperCase().padEnd(5)} ${r.install_id.slice(0, 8)} ${r.app_version} [${r.area}] ${r.msg}${r.data ? ` ${r.data}` : ''}`));
	if (err) console.log(plain(`    ${err.name ?? ''}: ${err.message ?? ''}${err.stack ? `\n    ${String(err.stack).replaceAll('\n', '\n    ')}` : JSON.stringify(err.truncated ?? '')}`));
}

const where = (extra) => sql`
	level = any(${LEVELS.slice(LEVELS.indexOf(values.level))})
	${values.area ? sql`and area = ${values.area}` : sql``}
	${values.install ? sql`and install_id::text like ${`${values.install.toLowerCase().replace(/[^0-9a-f-]/g, '')}%`}` : sql``}
	and ${extra}`;
const columns = sql`ts, received_at, level, proc, area, msg, data, err, app_version, device, install_id::text as install_id, n::text as n`;

try {
	const rows = await sql`select ${columns} from curator.client_log where ${where(sql`ts > now() - make_interval(secs => ${sinceSec})`)} order by ts desc, n desc limit ${limit}`;
	for (const r of rows.reverse()) print(r);
	if (!rows.length && !values.follow) console.log('Nothing in that time.');
	if (values.follow) {
		let [{ at }] = await sql`select now() as at`;
		for (;;) {
			await new Promise((r) => setTimeout(r, 5_000));
			const fresh = await sql`select ${columns} from curator.client_log where ${where(sql`received_at > ${at}`)} order by received_at, ts, n limit ${limit}`;
			for (const r of fresh) {
				print(r);
				if (r.received_at > at) at = r.received_at;
			}
		}
	}
} catch (e) {
	console.error(`\ncloud-logs: ${e?.code ? `${e.code} ` : ''}${String(e?.message ?? e).slice(0, 300)}`);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 2 });
}
