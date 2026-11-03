// The local collection into the Global Catalog, from a terminal:
//
//   pnpm --filter @curator/core catalog:import --dry          (what it would send; writes nothing)
//   pnpm --filter @curator/core catalog:import                (the import)
//   pnpm --filter @curator/core catalog:import --resume       (skip albums already imported)
//     [--db <curator.db>] [--catalog <url>] [--labels <n>] [--by <name>] [--force]
//
// Every track with a file on this computer goes up on its release, and every
// release on its label (catalog-client/library-claims.ts); the catalogue then
// reads each release in full from its stores and each label's whole
// catalogue (apps/cloud catalog/library-import.ts, release-fill.ts,
// trackers/backfill.ts). Labels go first, biggest first — the order the
// catalogue works them in.
//
// The catalogue is the local one (apps/cloud `pnpm local`, its loopback
// /admin path): a Node script holds no app session to call catalog.ingest
// with. The app's own "import my collection" sends the same claims through
// catalog.ingest when it comes.
//
// curator.db is the user's live library. This script reads it, and writes
// one thing: catalog_ref rows (what each album and label is in the
// catalogue). Before it does, it copies the database beside itself
// (VACUUM INTO), and it refuses to run while the app is open (one writer).
// --dry opens the database read-only and asks the catalogue to roll back.

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { CatalogClaim } from '@curator/protocol';
import { migrate } from '../db/migrate.js';
import { writeRefs, type CatalogRefRow } from '../catalog-client/catalog-refs.js';
import { libraryClaims } from '../catalog-client/library-claims.js';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};
const flag = (name: string) => argv.includes(name);

const dbPath = arg('--db') ?? join(process.env.APPDATA ?? join(process.env.HOME ?? '', '.config'), 'Curator', 'curator.db');
const catalog = (arg('--catalog') ?? process.env.CURATOR_CATALOG_API_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const dry = flag('--dry');
const resume = flag('--resume');
const by = arg('--by') ?? 'catalog-import';
const labelLimit = arg('--labels') ? Number(arg('--labels')) : null;
const BATCH = 100;

type Result = { objectId: string; kind: string; created: boolean } | { rejected: string };
type BatchAnswer = { dry: boolean; duplicate: boolean; results: Result[]; created: number; attached: number; fills: number; profiles: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(claims: CatalogClaim[], key: string): Promise<BatchAnswer> {
	for (let attempt = 0; ; attempt++) {
		try {
			const res = await fetch(`${catalog}/admin`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'libraryImport', args: { claims, key, by, dry } }),
				signal: AbortSignal.timeout(300_000),
			});
			const body = (await res.json()) as { ok: boolean; result?: BatchAnswer; error?: string };
			if (body.ok) return body.result!;
			// The catalogue refused the batch itself (not one claim): no retry.
			if (res.status < 500) throw new Error(body.error ?? `HTTP ${res.status}`);
			throw new Error(body.error ?? `HTTP ${res.status}`);
		} catch (e) {
			if (attempt >= 3) throw e;
			const wait = [2_000, 5_000, 15_000][attempt]!;
			process.stdout.write(`  batch ${key}: ${e instanceof Error ? e.message : String(e)} — again in ${wait / 1000}s\n`);
			await sleep(wait);
		}
	}
}

const keyOf = (kind: string, claims: CatalogClaim[]) =>
	`library:${hostname().replace(/[^\w.-]/g, '')}:${kind}:${createHash('sha256').update(claims.map((c) => `${c.provider}:${c.providerId}`).join(',')).digest('hex').slice(0, 32)}`;

function appRunning(): boolean {
	if (process.platform !== 'win32') return false;
	try {
		const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).toLowerCase();
		return out.includes('"curator.exe"');
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	if (!existsSync(dbPath)) throw new Error(`no library at ${dbPath} (--db)`);
	// The local catalogue is one process (PGlite): during a worker pass it can
	// take a while to answer, so it gets a few minutes before it counts as down.
	let health: { result?: { data?: { features?: string[] } } } | null = null;
	for (let i = 0; i < 10 && !health; i++) {
		health = await fetch(`${catalog}/trpc/health`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json() as Promise<{ result?: { data?: { features?: string[] } } }>).catch(() => null);
		if (!health) process.stdout.write(`catalogue at ${catalog} busy or down — trying again\n`);
	}
	if (!health?.result?.data?.features?.includes('global_catalog')) throw new Error(`no catalogue answers at ${catalog} — start it with \`pnpm --filter @curator/cloud local\``);

	let raw: Database.Database;
	if (dry) raw = new Database(dbPath, { readonly: true, fileMustExist: true });
	else {
		if (appRunning() && !flag('--force')) throw new Error('Curator is running: close it first (one writer at a time on curator.db), or pass --force if that is not this library');
		const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
		const backup = `${dbPath}.catalog-import-${stamp}.bak`;
		const src = new Database(dbPath, { readonly: true, fileMustExist: true });
		src.prepare('VACUUM INTO ?').run(backup);
		src.close();
		process.stdout.write(`backup: ${backup}\n`);
		migrate(dbPath);
		raw = new Database(dbPath, { fileMustExist: true });
	}

	const { labels: allLabels, releases: allReleases } = libraryClaims(raw);
	const labels = labelLimit ? allLabels.slice(0, labelLimit) : allLabels;
	const chosen = new Set(labels.map((l) => l.fold));
	const done = resume ? new Set((raw.prepare(`select entity_id from catalog_ref where entity_kind = 'album'`).all() as { entity_id: string }[]).map((r) => r.entity_id)) : new Set<string>();
	const releases = allReleases.filter((r) => (labelLimit ? r.labelFold !== null && chosen.has(r.labelFold) : true) && !(r.albumId && done.has(r.albumId)));
	const recordings = releases.reduce((n, r) => n + (r.claim.recordings?.length ?? 0), 0);
	process.stdout.write(
		`${dry ? '[dry run] ' : ''}${labels.length} label(s), ${releases.length} release(s), ${recordings} track(s) → ${catalog}` +
			`${resume ? ` (${done.size} album(s) already imported, skipped)` : ''}\n` +
			`top labels: ${labels
				.slice(0, 10)
				.map((l) => `${l.name} (${l.tracks})`)
				.join(', ')}\n`,
	);

	const totals = { created: 0, attached: 0, fills: 0, profiles: 0, rejected: [] as string[] };
	const add = (a: BatchAnswer) => {
		totals.created += a.created;
		totals.attached += a.attached;
		totals.fills += a.fills;
		totals.profiles += a.profiles;
	};
	const refs: CatalogRefRow[] = [];

	for (let i = 0; i < labels.length; i += BATCH) {
		const batch = labels.slice(i, i + BATCH);
		const a = await post(
			batch.map((l) => l.claim),
			keyOf('labels', batch.map((l) => l.claim)),
		);
		add(a);
		a.results.forEach((r, k) => {
			const l = batch[k]!;
			if ('rejected' in r) totals.rejected.push(`label ${l.name}: ${r.rejected}`);
			else refs.push({ entityKind: 'label', entityId: l.fold, objectId: r.objectId, objectKind: 'label', provider: 'user', providerId: l.claim.providerId });
		});
	}
	process.stdout.write(`labels: ${labels.length} sent\n`);
	for (let i = 0; i < releases.length; i += BATCH) {
		const batch = releases.slice(i, i + BATCH);
		const claims = batch.map((r) => r.claim);
		const a = await post(claims, keyOf('releases', claims));
		add(a);
		const rows: CatalogRefRow[] = [];
		a.results.forEach((r, k) => {
			const rel = batch[k]!;
			if ('rejected' in r) totals.rejected.push(`release ${rel.claim.name}: ${r.rejected}`);
			else if (rel.albumId) rows.push({ entityKind: 'album', entityId: rel.albumId, objectId: r.objectId, objectKind: 'release', provider: rel.claim.provider, providerId: rel.claim.providerId });
		});
		// Kept as each batch lands, so --resume goes on from here.
		if (!dry) writeRefs(raw, rows);
		process.stdout.write(`releases: ${Math.min(i + BATCH, releases.length)}/${releases.length}${a.duplicate ? ' (already sent)' : ''}\n`);
	}
	if (!dry) writeRefs(raw, refs);
	raw.close();

	process.stdout.write(
		`${dry ? '[dry run, nothing written] ' : ''}created ${totals.created}, joined ${totals.attached}; ${totals.fills} release fill(s) and ${totals.profiles} label profile(s) queued; ${totals.rejected.length} refused\n`,
	);
	for (const r of totals.rejected.slice(0, 30)) process.stdout.write(`  refused: ${r}\n`);
	if (totals.rejected.length > 30) process.stdout.write(`  … and ${totals.rejected.length - 30} more\n`);
}

main().catch((e: unknown) => {
	process.stderr.write(`catalog import failed: ${e instanceof Error ? e.message : String(e)}\n`);
	process.exitCode = 1;
});
