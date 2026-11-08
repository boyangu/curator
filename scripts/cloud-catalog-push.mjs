#!/usr/bin/env node
// Pushes the local Global Catalog (apps/cloud `pnpm local`, PGlite) into the
// cloud database, once, as the schema owner:
//
//   pnpm cloud:catalog-push --from <copy of ~/.curator-local-cloud/pgdata>
//   pnpm cloud:catalog-push --from <pgdata> --to-pglite <empty dir>   # rehearsal into a fresh PGlite
//
// Take the source from a copy made while the local server is stopped (PGlite
// is single-process; a copy of a running folder may not open). The target's
// catalogue tables must be empty: this is the first fill, not a sync, and it
// refuses anything else. Rows move as CSV through COPY on both sides, table by
// table in foreign-key order, so values keep their exact text form (jsonb,
// arrays, timestamps). Self-referencing tables (catalog_object.merged_into,
// catalog_genre.parent_id) load by depth so every parent precedes its children.
//
// Not copied: the account and library tables (library_*, device*, catalogue_*,
// spotify_grant, request_log, audit_event: the cloud's own, and the local shim's
// copies are test data), catalog_worker (its device row is the local shim's; the
// desktop re-registers on first contact), and schema_migration (the target ran
// its own). catalog_watch rows whose user is unknown to the target's auth.users
// are dropped with a warning; the watch counter trigger stays off during the
// load because watch_count arrives with the objects.
//
// The owner connection comes from CURATOR_DB_OWNER_URL in the git-ignored root
// .env (never argv), like scripts/cloud-db-apply.mjs.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cloudDir = join(repoRoot, 'apps', 'cloud');
const require = createRequire(join(cloudDir, 'package.json'));
const argv = process.argv.slice(2);
const arg = (name) => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};

function fail(msg) {
	console.error(`\ncloud-catalog-push: ${msg}`);
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

// The catalogue's tables, in an order that satisfies every foreign key
// (apps/cloud/sql/0011+). A table added later lands here or the empty-target
// check below names it.
const TABLES = [
	'catalog_object',
	'catalog_source_object',
	'catalog_genre',
	'genre_alias',
	'catalog_identifier',
	'catalog_fact',
	'catalog_edge',
	'catalog_edge_evidence',
	'catalog_playlist_item',
	'catalog_not_same',
	'catalog_signal',
	'catalog_audio',
	'catalog_enrich_task',
	'catalog_event',
	'catalog_event_subject',
	'catalog_cursor',
	'catalog_chart_entry',
	'catalog_review',
	'catalog_inbox',
	'catalog_agent_case',
	'catalog_credit_rule',
	'catalog_source_block',
	'catalog_insight',
	'catalog_merge_log',
	'catalog_ingest_batch',
	'provider_budget',
	'tracker',
	'tracker_run',
	'catalog_watch',
	'admin_user',
];
const SKIP = new Set(['catalog_worker']);
// Tables the migrations seed, children before parents (the order they are cleared in).
const SEEDED = ['genre_alias', 'catalog_enrich_task', 'catalog_cursor', 'catalog_source_object', 'catalog_genre', 'tracker', 'provider_budget', 'catalog_object'];
const SELF_REF = { catalog_object: 'merged_into', catalog_genre: 'parent_id' };
// Big uuid-keyed tables go in 16 slices by the first hex digit of the key so
// no single CSV blob has to fit in PGlite's memory at once.
const SLICE_BY = { catalog_object: 'id', catalog_source_object: 'id', catalog_fact: 'object_id', catalog_edge: 'id', catalog_edge_evidence: 'edge_id', catalog_identifier: 'value', catalog_enrich_task: 'object_id' };

async function openSource(dir) {
	const { PGlite } = await import(pathToFileURL(require.resolve('@electric-sql/pglite')).href);
	if (existsSync(join(dirname(dir), 'lock'))) {
		const pid = Number(readFileSync(join(dirname(dir), 'lock'), 'utf8'));
		let alive = false;
		try { process.kill(pid, 0); alive = true; } catch { /* gone */ }
		if (alive) fail(`${dir} belongs to a running local catalogue (pid ${pid}); stop it or point --from at a copy`);
	}
	const pg = await PGlite.create(dir);
	return {
		rows: async (sql, params = []) => (await pg.query(sql, params)).rows,
		csv: async (select) => (await pg.query(`copy (${select}) to '/dev/blob' with (format csv)`)).blob,
		close: () => pg.close(),
	};
}

async function openPostgresTarget(url) {
	const postgres = (await import(pathToFileURL(require.resolve('postgres')).href)).default;
	const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 15, idle_timeout: 0, onnotice: () => {} });
	return {
		rows: (q) => sql.unsafe(q),
		copyIn: async (copySql, blob) => {
			const w = await sql.unsafe(copySql).writable();
			const buf = Buffer.from(await blob.arrayBuffer());
			await new Promise((resolve, reject) => {
				w.on('error', reject);
				w.on('finish', resolve);
				w.end(buf);
			});
		},
		close: () => sql.end({ timeout: 5 }),
	};
}

// A rehearsal target: a fresh PGlite with the shim, migrations and storage SQL,
// the same way apps/cloud/src/cli/local.ts builds the local catalogue.
async function openPgliteTarget(dir) {
	const { PGlite } = await import(pathToFileURL(require.resolve('@electric-sql/pglite')).href);
	const tsx = pathToFileURL(require.resolve('tsx/esm/api')).href;
	const { register } = await import(tsx);
	register();
	const { pgliteDb, STORAGE_SQL } = await import(pathToFileURL(join(cloudDir, 'src/test/harness.ts')).href);
	const { SUPABASE_SHIM_SQL } = await import(pathToFileURL(join(cloudDir, 'src/test/supabase-shim.ts')).href);
	const { migrate, findSqlDir } = await import(pathToFileURL(join(cloudDir, 'src/db/migrate.ts')).href);
	const pg = await PGlite.create(join(dir, 'pgdata'));
	const [fresh] = (await pg.query(`select to_regclass('auth.users') is null as missing`)).rows;
	if (fresh?.missing) await pg.exec(SUPABASE_SHIM_SQL);
	await migrate(pgliteDb(pg), findSqlDir(join(cloudDir, 'src/db')));
	if (fresh?.missing) await pg.exec(STORAGE_SQL);
	return {
		rows: async (q) => (await pg.query(q)).rows,
		// PGlite's COPY reads the blob handed to query(), named as '/dev/blob'.
		copyIn: async (copySql, blob) => { await pg.query(copySql.replace(/from stdin/, `from '/dev/blob'`), [], { blob }); },
		seedUser: async (id) => { await pg.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [id]); },
		close: () => pg.close(),
	};
}

async function main() {
	const from = arg('--from');
	if (!from) fail('usage: --from <pgdata dir> [--to-pglite <dir>]');
	if (!existsSync(join(from, 'PG_VERSION'))) fail(`${from} is not a PGlite data folder (no PG_VERSION)`);
	const toPglite = arg('--to-pglite');
	let target;
	if (toPglite) {
		target = await openPgliteTarget(toPglite);
	} else {
		const env = { ...loadDotEnv(join(repoRoot, '.env')), ...process.env };
		const url = env.CURATOR_DB_OWNER_URL?.trim();
		if (!url) fail('CURATOR_DB_OWNER_URL is not set in .env (the owner connection, postgres.<ref>…)');
		let u;
		try { u = new URL(url); } catch { fail('the owner connection string is not a URL (value not shown)'); }
		if (!/^postgres([.]|$)/.test(decodeURIComponent(u.username))) fail('expected the owner user postgres.<ref> (value not shown)');
		target = await openPostgresTarget(url);
	}
	const source = await openSource(from);

	try {
		// Both sides on the same schema: every migration file in the tree applied on each.
		const files = readdirSync(join(cloudDir, 'sql')).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
		for (const [name, side] of [['source', source], ['target', target]]) {
			const applied = new Set((await side.rows(`select name from curator.schema_migration`)).map((r) => r.name));
			const missing = files.filter((f) => !applied.has(f));
			if (missing.length) fail(`${name} is behind this checkout: ${missing.join(', ')}`);
		}
		// Every catalogue table in the source is accounted for, and the target holds none of it yet.
		const sourceTables = (await source.rows(`select relname from pg_class where relnamespace = 'curator'::regnamespace and relkind = 'r' order by 1`)).map((r) => r.relname);
		const catalogTables = sourceTables.filter((t) => (t.startsWith('catalog_') || ['genre_alias', 'provider_budget', 'tracker', 'tracker_run', 'admin_user'].includes(t)));
		const unplaced = catalogTables.filter((t) => !TABLES.includes(t) && !SKIP.has(t));
		if (unplaced.length) fail(`tables without a place in the load order: ${unplaced.join(', ')} (add them to TABLES in this script)`);
		// The migrations seed a few tables (genres, their aliases, the trackers; 0012+).
		// The source carries the same seeds plus everything since, so those rows go and
		// the source's versions take their place. Anything else on the target means it
		// is not a fresh catalogue, and the script stops.
		for (const t of TABLES) {
			const [{ n }] = await target.rows(`select count(*)::int as n from curator.${t}`);
			if (Number(n) === 0) continue;
			if (!SEEDED.includes(t)) fail(`target curator.${t} already holds ${n} rows; this script fills an empty catalogue only`);
			if (Number(n) > 1000) fail(`target curator.${t} holds ${n} rows, more than the migrations seed; this script fills an empty catalogue only`);
			if (t === 'catalog_object') {
				const [{ other }] = await target.rows(`select count(*)::int as other from curator.catalog_object where kind <> 'genre'`);
				if (Number(other) > 0) fail(`target curator.catalog_object holds ${other} non-genre rows; this script fills an empty catalogue only`);
			}
		}
		for (const t of SEEDED) {
			const [{ n }] = await target.rows(`select count(*)::int as n from curator.${t}`);
			if (Number(n) === 0) continue;
			await target.rows(`delete from curator.${t}`);
			console.log(`  cleared ${n} seeded rows from curator.${t}`);
		}

		const targetUsers = new Set((await target.rows(`select id::text as id from auth.users`)).map((r) => r.id));
		const watchUsers = await source.rows(`select user_id::text as user_id, count(*)::int as n from curator.catalog_watch group by 1`);
		for (const w of watchUsers) {
			if (targetUsers.has(w.user_id)) continue;
			if (target.seedUser) { await target.seedUser(w.user_id); targetUsers.add(w.user_id); continue; }
			console.warn(`  warning: ${w.n} catalog_watch rows of user ${w.user_id} dropped (no such user on the target)`);
		}
		const adminUsers = await source.rows(`select user_id::text as user_id from curator.admin_user`);
		for (const a of adminUsers) if (!targetUsers.has(a.user_id) && target.seedUser) await target.seedUser(a.user_id);

		const columnsOf = async (t) => (await source.rows(`select attname from pg_attribute where attrelid = 'curator.${t}'::regclass and attnum > 0 and not attisdropped order by attnum`)).map((r) => r.attname);
		const targetColumns = async (t) => (await target.rows(`select attname from pg_attribute where attrelid = 'curator.${t}'::regclass and attnum > 0 and not attisdropped order by attnum`)).map((r) => r.attname);

		await target.rows(`alter table curator.catalog_watch disable trigger catalog_watch_count`);
		const started = Date.now();
		const totals = {};
		for (const t of TABLES) {
			const cols = await columnsOf(t);
			const tcols = await targetColumns(t);
			if (cols.join() !== tcols.join()) fail(`curator.${t}: columns differ (source ${cols.join(',')} / target ${tcols.join(',')})`);
			const colList = cols.map((c) => `"${c}"`).join(', ');
			const base = `select ${colList} from curator.${t}`;
			const filters = [];
			if (t === 'catalog_watch') {
				const ids = [...targetUsers].map((id) => `'${id}'`).join(',');
				filters.push(`user_id in (${ids || `'00000000-0000-0000-0000-000000000000'`})`);
			}
			const where = (extra) => {
				const all = [...filters, ...(extra ? [extra] : [])];
				return all.length ? ` where ${all.join(' and ')}` : '';
			};
			const copyIn = `copy curator.${t} (${colList}) from stdin with (format csv)`;
			let moved = 0;
			const ship = async (select) => {
				const blob = await source.csv(select);
				// PGlite hands back no blob at all for an empty result.
				if (!blob || blob.size === 0) return;
				await target.copyIn(copyIn, blob);
			};
			if (SELF_REF[t]) {
				// Parents first: depth 0 has no parent, depth n's parent sits at n-1.
				const ref = SELF_REF[t];
				const pk = t === 'catalog_genre' ? 'object_id' : 'id';
				const depths = await source.rows(`with recursive d as (select ${pk} as id, 0 as depth from curator.${t} where ${ref} is null union all select o.${pk}, d.depth + 1 from curator.${t} o join d on o.${ref} = d.id) select depth, count(*)::int as n from d group by 1 order by 1`);
				for (const { depth } of depths) {
					const depthSelect = `with recursive d as (select ${pk} as id, 0 as depth from curator.${t} where ${ref} is null union all select o.${pk}, d.depth + 1 from curator.${t} o join d on o.${ref} = d.id) ${base} where ${pk} in (select id from d where depth = ${Number(depth)})`;
					if (SLICE_BY[t] && Number(depth) === 0) {
						for (const h of '0123456789abcdef') await ship(`${depthSelect} and left(${SLICE_BY[t]}::text, 1) = '${h}'`);
					} else {
						await ship(depthSelect);
					}
				}
			} else if (SLICE_BY[t]) {
				const k = SLICE_BY[t];
				for (const h of '0123456789abcdef') await ship(`${base}${where(`left(${k}::text, 1) = '${h}'`)}`);
				// Keys that are not hex-led (text keys such as identifier values).
				await ship(`${base}${where(`left(${k}::text, 1) !~ '^[0-9a-f]$'`)}`);
			} else {
				await ship(`${base}${where()}`);
			}
			const [{ n: srcN }] = await source.rows(`select count(*)::int as n from curator.${t}${where()}`);
			const [{ n: dstN }] = await target.rows(`select count(*)::int as n from curator.${t}`);
			moved = Number(dstN);
			totals[t] = [Number(srcN), moved];
			console.log(`  ${t.padEnd(26)} ${String(moved).padStart(9)} rows${Number(srcN) !== moved ? `   MISMATCH (source ${srcN})` : ''}`);
			if (Number(srcN) !== moved) fail(`curator.${t}: moved ${moved} of ${srcN} rows`);
		}
		await target.rows(`alter table curator.catalog_watch enable trigger catalog_watch_count`);

		// Identity / serial keys continue after the highest value that arrived.
		const serials = await source.rows(`select c.relname as t, a.attname as col from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relnamespace = 'curator'::regnamespace and a.attnum > 0 and not a.attisdropped and (a.attidentity <> '' or exists (select 1 from pg_attrdef d where d.adrelid = c.oid and d.adnum = a.attnum and pg_get_expr(d.adbin, d.adrelid) like 'nextval%'))`);
		for (const { t, col } of serials) {
			if (!TABLES.includes(t)) continue;
			await target.rows(`select setval(pg_get_serial_sequence('curator.${t}', '${col}'), coalesce((select max("${col}") from curator.${t}), 0) + 1, false)`);
		}
		for (const t of TABLES) await target.rows(`analyze curator.${t}`);
		console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)} s: ${Object.values(totals).reduce((a, [, n]) => a + n, 0)} rows across ${TABLES.length} tables.`);
	} catch (e) {
		fail(`${e?.code ? e.code + ' ' : ''}${String(e?.message ?? e).slice(0, 400)}`);
	} finally {
		await source.close();
		await target.close();
	}
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
