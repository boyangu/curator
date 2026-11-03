// One artist held twice under the same name: two stores' (or a store's and a
// reader's) copies the ingest did not join — "You Are Safe" credited Rampa,
// Adam Port, &ME and Keinemusik two or three times each, and 2,767 names were
// on one track twice across the catalogue (2026-11-01).
// `catalog repair artist-twins` sweeps the catalogue; the worker's detector
// pass runs the same over recently minted artists.
//
// Twins are two live artists of the same folded name credited on one release.
// A name alone is never enough (namesakes are common), so is the release:
//   - on the same track: one person — merged;
//   - on the same release only: merged too, unless one store holds both — a
//     store's two ids say two people as far as it knows (a compilation's two
//     "Ben"s), so that pair is put to the operator as an `artist.twins`
//     approval (approve = merge, reject = ruled not the same). Copies from
//     stores that share none cannot tell each other's ids apart.
// Merged into the copy a store holds, then the one with more credits, then
// the older. A pair ruled not the same stays apart, and placeholder names
// ("Various Artists") are never twins.

import type { Db, Queryable } from '../db/db.js';
import { num } from '../db/db.js';
import type { SystemTx } from '../db/system-tx.js';
import { withSystemTx } from '../db/system-tx.js';
import { mergeObjects } from './admin.js';
import { WEAK_SQL } from './identity.js';
import { listInbox, raise } from './inbox.js';

export type ArtistTwinReport = {
	dry: boolean;
	merged: { name: string; keep: string; folds: string[]; on: 'track' | 'release'; shared: number }[];
	proposed: { name: string; pairs: number; item: number | null }[];
	// Groups found in all, and whether this call stopped at a limit with more to do.
	found: { track: number; release: number };
	more: boolean;
};

// A sweep is one transaction on PGlite's one connection: bounded, so the
// server keeps answering (200 merges ≈ 30 s on 2026-11-01's catalogue).
export const MERGE_LIMIT = 200;
export const PROPOSE_LIMIT = 25;

type Twin = { id: string; name: string; fold: string; stores: string[]; credits: number; discovered: number };
export type ArtistPairView = { keep: { id: string; title: string; providers: string[]; tracks: number }; fold: { id: string; title: string; providers: string[]; tracks: number }; on: string[] };
// Whose copies a sweep looks at: names an artist was minted under lately (the
// worker's pass; null = every name), or the artists credited on given releases
// (after two releases became one, or two of its tracks did).
type SweepScope = { recentDays: number | null } | { releases: string[] };
type SweepOpts = { scope: SweepScope; by: string; mergeLimit: number; proposeLimit: number };

const PLACEHOLDER = new Set(['various artists', 'various', 'va', 'v a', 'unknown', 'unknown artist', 'anonymous', 'traditional', 'n a']);

// The live artists whose folded name another live artist holds — the only ones
// worth a look (optionally names an artist was minted under lately) — kept in
// a temp table the pair queries start from. Passed as an array of thousands
// of names instead, every artist was compared with each: 8 minutes of PGlite
// on 2026-11-01's catalogue.
async function loadSuspects(tx: Queryable, scope: SweepScope): Promise<number> {
	await tx.query(`create temp table if not exists artist_twin (id uuid primary key, fold text not null)`);
	await tx.query(`truncate pg_temp.artist_twin`);
	const placeholders = `{${[...PLACEHOLDER].map((p) => `"${p}"`).join(',')}}`;
	if ('releases' in scope) {
		if (!scope.releases.length) return 0;
		await tx.query(
			`insert into pg_temp.artist_twin (id, fold)
			select o.id, o.name_fold from curator.catalog_object o
			join (
				select o.name_fold from curator.catalog_object o
				join (
					select e.src as id from curator.catalog_edge e where e.kind = 'artist-release' and e.dst = any($1::uuid[])
					union
					select ra.dst from curator.catalog_edge rr join curator.catalog_edge ra on ra.src = rr.dst and ra.kind = 'recording-artist'
					where rr.kind = 'release-recording' and rr.src = any($1::uuid[])
				) c on c.id = o.id
				where o.kind = 'artist' and o.merged_into is null and o.name_fold <> '' and not (o.name_fold = any($2::text[]))
				group by o.name_fold having count(*) > 1
			) s on s.name_fold = o.name_fold
			where o.kind = 'artist' and o.merged_into is null`,
			[`{${scope.releases.join(',')}}`, placeholders],
		);
	} else {
		await tx.query(
			`insert into pg_temp.artist_twin (id, fold)
			select o.id, o.name_fold from curator.catalog_object o
			join (
				select name_fold from curator.catalog_object
				where kind = 'artist' and merged_into is null and name_fold <> '' and not (name_fold = any($2::text[]))
				group by name_fold having count(*) > 1
					and ($1::int is null or max(discovered_at) > now() - make_interval(days => $1::int))
			) s on s.name_fold = o.name_fold
			where o.kind = 'artist' and o.merged_into is null`,
			[scope.recentDays === null ? null : String(scope.recentDays), placeholders],
		);
	}
	await tx.query(`analyze pg_temp.artist_twin`);
	return num((await tx.query<{ n: unknown }>(`select count(*) as n from pg_temp.artist_twin`))[0]!.n);
}

// Each copy with the stores that hold it (a reader's name key is no store).
async function twinsOf(tx: Queryable, ids: string[]): Promise<Map<string, Twin>> {
	const rows = await tx.query<{ id: string; name: string; fold: string; stores: string | null; credits: unknown; discovered: unknown }>(
		`select o.id, o.name, o.name_fold as fold, extract(epoch from o.discovered_at) * 1000 as discovered,
			(select string_agg(distinct s.provider, '|') from curator.catalog_source_object s where s.object_id = o.id and not ${WEAK_SQL}) as stores,
			(select count(*) from curator.catalog_edge c where (c.dst = o.id and c.kind = 'recording-artist') or (c.src = o.id and c.kind = 'artist-release')) as credits
		from curator.catalog_object o where o.id = any($1::uuid[])`,
		[`{${ids.join(',')}}`],
	);
	return new Map(rows.map((r) => [r.id, { ...r, stores: r.stores ? r.stores.split('|') : [], credits: num(r.credits), discovered: num(r.discovered) }]));
}

const better = (a: Twin, b: Twin) => Number(b.stores.length > 0) - Number(a.stores.length > 0) || b.credits - a.credits || a.discovered - b.discovered || a.id.localeCompare(b.id);

// Pairs into groups (one name's copies connected by the pairs).
function groups(pairs: { a: string; b: string }[]): string[][] {
	const parent = new Map<string, string>();
	const find = (x: string): string => {
		const p = parent.get(x) ?? x;
		if (p === x) return x;
		const r = find(p);
		parent.set(x, r);
		return r;
	};
	for (const { a, b } of pairs) {
		parent.set(a, find(a));
		parent.set(b, find(b));
		parent.set(find(a), find(b));
	}
	const out = new Map<string, string[]>();
	for (const x of parent.keys()) out.set(find(x), [...(out.get(find(x)) ?? []), x]);
	return [...out.values()];
}

async function ruledApart(tx: Queryable, ids: string[]): Promise<Set<string>> {
	const rows = await tx.query<{ a: string; b: string }>(`select object_a as a, object_b as b from curator.catalog_not_same where object_a = any($1::uuid[]) and object_b = any($1::uuid[])`, [`{${ids.join(',')}}`]);
	return new Set(rows.map((r) => `${r.a}|${r.b}`));
}
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Same name on the same track.
async function trackPairs(tx: Queryable): Promise<{ a: string; b: string; n: number }[]> {
	const rows = await tx.query<{ a: string; b: string; n: unknown }>(
		`select ea.dst as a, eb.dst as b, count(*) as n
		from pg_temp.artist_twin x
		join curator.catalog_edge ea on ea.dst = x.id and ea.kind = 'recording-artist'
		join curator.catalog_edge eb on eb.src = ea.src and eb.kind = 'recording-artist' and eb.dst > ea.dst
		join pg_temp.artist_twin y on y.id = eb.dst and y.fold = x.fold
		group by ea.dst, eb.dst`,
	);
	return rows.map((r) => ({ a: r.a, b: r.b, n: num(r.n) }));
}

// Same name on the same release (credited on it or on one of its tracks),
// with the releases they share. The copies the track pass merged are out.
async function releasePairs(tx: Queryable): Promise<{ a: string; b: string; on: string[] }[]> {
	const rows = await tx.query<{ a: string; b: string; on: string }>(
		`with live as (
			select t.id, t.fold from pg_temp.artist_twin t join curator.catalog_object o on o.id = t.id and o.merged_into is null
		), ra as (
			select e.dst as rel, l.id as art, l.fold from live l join curator.catalog_edge e on e.src = l.id and e.kind = 'artist-release'
			union
			select rr.src, l.id, l.fold from live l
			join curator.catalog_edge e on e.dst = l.id and e.kind = 'recording-artist'
			join curator.catalog_edge rr on rr.dst = e.src and rr.kind = 'release-recording'
		)
		select x.art as a, y.art as b, string_agg(distinct r.name, '|') as on
		from ra x join ra y on y.rel = x.rel and y.fold = x.fold and y.art > x.art
		join curator.catalog_object r on r.id = x.rel and r.merged_into is null
		group by x.art, y.art`,
	);
	return rows.map((r) => ({ a: r.a, b: r.b, on: r.on ? r.on.split('|') : [] }));
}

// One name's group: every copy no store holds alongside the kept one merges
// into it (the kept one then holds that copy's stores too); the rest come
// back, each a store's second id.
async function mergeGroup(tx: SystemTx, g: Twin[], apart: Set<string>, on: 'track' | 'release', shared: (keep: string, fold: string) => number, opts: SweepOpts, report: ArtistTwinReport): Promise<{ keep: Twin; split: Twin[] }> {
	const [keep, ...rest] = [...g].sort(better);
	const stores = new Set(keep!.stores);
	const folded: string[] = [];
	const split: Twin[] = [];
	let n = 0;
	for (const f of rest) {
		// A copy ruled apart from the kept one stays, whatever joined them.
		if (apart.has(pairKey(keep!.id, f.id))) continue;
		if (on === 'release' && f.stores.some((s) => stores.has(s))) {
			split.push(f);
			continue;
		}
		await mergeObjects(tx, f.id, keep!.id, opts.by, on === 'track' ? 'same-name artist credited twice on one track' : 'same-name artist on one release, no store holding both', { repair: 'artist-twins' });
		for (const s of f.stores) stores.add(s);
		folded.push(f.id);
		n += shared(keep!.id, f.id);
	}
	if (folded.length) report.merged.push({ name: keep!.name, keep: keep!.id, folds: folded, on, shared: n });
	return { keep: keep!, split };
}

async function providersOf(tx: Queryable, id: string): Promise<string[]> {
	return (await tx.query<{ provider: string }>(`select distinct provider from curator.catalog_source_object where object_id = $1 order by provider`, [id])).map((r) => r.provider);
}

async function sweep(tx: SystemTx, opts: SweepOpts, report: ArtistTwinReport): Promise<void> {
	if (!(await loadSuspects(tx, opts.scope))) return;
	const full = () => report.merged.length >= opts.mergeLimit;

	// On one track.
	const tp = await trackPairs(tx);
	if (tp.length) {
		const info = await twinsOf(tx, [...new Set(tp.flatMap((p) => [p.a, p.b]))]);
		const apart = await ruledApart(tx, [...info.keys()]);
		const tracks = new Map(tp.map((p) => [pairKey(p.a, p.b), p.n]));
		const gs = groups(tp.filter((p) => !apart.has(pairKey(p.a, p.b))));
		report.found.track = gs.length;
		for (const g of gs) {
			if (full()) {
				report.more = true;
				break;
			}
			await mergeGroup(tx, g.map((id) => info.get(id)!), apart, 'track', (k, f) => tracks.get(pairKey(k, f)) ?? 0, opts, report);
		}
	}

	// On one release only — once the track merges are done, so what the next
	// call merges is not put to the operator first.
	if (!report.more) {
		const rp = await releasePairs(tx);
		if (rp.length) {
			const info = await twinsOf(tx, [...new Set(rp.flatMap((p) => [p.a, p.b]))]);
			const apart = await ruledApart(tx, [...info.keys()]);
			const open = await listInbox(tx, { status: 'open', kind: 'artist.twins', limit: 500 });
			const proposed = new Set(open.rows.flatMap((i) => ((i.evidence.pairs as { keep: { id: string }; fold: { id: string } }[] | undefined) ?? []).map((p) => pairKey(p.keep.id, p.fold.id))));
			const on = new Map(rp.map((p) => [pairKey(p.a, p.b), p.on]));
			const gs = groups(rp.filter((p) => !apart.has(pairKey(p.a, p.b))));
			report.found.release = gs.length;
			for (const g of gs) {
				if (full() || (opts.proposeLimit > 0 && report.proposed.length >= opts.proposeLimit)) {
					report.more = true;
					break;
				}
				const { keep, split } = await mergeGroup(tx, g.map((id) => info.get(id)!), apart, 'release', (k, f) => on.get(pairKey(k, f))?.length ?? 0, opts, report);
				if (!opts.proposeLimit) continue;
				const view = async (t: Twin) => ({ id: t.id, title: t.name, providers: await providersOf(tx, t.id), tracks: t.credits });
				const pairs: ArtistPairView[] = [];
				for (const f of split) {
					if (proposed.has(pairKey(keep.id, f.id))) continue;
					// Joined through a merged copy: the releases any copy shares with it.
					const shared = on.get(pairKey(keep.id, f.id)) ?? [...new Set(g.flatMap((x) => on.get(pairKey(x, f.id)) ?? []))];
					pairs.push({ keep: await view(keep), fold: await view(f), on: shared.slice(0, 5) });
				}
				if (!pairs.length) continue;
				const item = await raise(tx, {
					kind: 'artist.twins',
					severity: 'approval',
					title: `«${keep.name}» held ${pairs.length + 1} times on one release, by one store under two ids`,
					subjects: [keep.id],
					evidence: { pairs },
					apply: { op: 'mergeArtists', args: { pairs: pairs.map((p) => ({ keep: p.keep.id, fold: p.fold.id })) } },
					actor: opts.by,
					key: pairs.map((p) => p.fold.id).sort().join(','),
				});
				report.proposed.push({ name: keep.name, pairs: pairs.length, item });
			}
		}
	}

	// What it merged by itself, on the record (undoable as merges are).
	if (report.merged.length)
		await raise(tx, {
			kind: 'artist.merged',
			severity: 'audit',
			title: `Merged ${report.merged.reduce((s, m) => s + m.folds.length, 0)} same-name artist copies on one track or release: ${report.merged.slice(0, 8).map((m) => m.name).join(', ')}${report.merged.length > 8 ? ', …' : ''}`,
			subjects: report.merged.slice(0, 50).map((m) => m.keep),
			evidence: { merged: report.merged.slice(0, 100) },
			actor: opts.by,
		});
}

const blank = (dry: boolean): ArtistTwinReport => ({ dry, merged: [], proposed: [], found: { track: 0, release: 0 }, more: false });

export async function artistTwins(db: Db, opts: { dry?: boolean; by?: string; recentDays?: number | null; mergeLimit?: number; proposeLimit?: number } = {}): Promise<ArtistTwinReport> {
	const report = blank(!!opts.dry);
	const rollback = new Error('dry run');
	try {
		await withSystemTx(db, async (tx) => {
			await sweep(tx, { scope: { recentDays: opts.recentDays ?? null }, by: opts.by ?? 'claude-code', mergeLimit: opts.mergeLimit ?? MERGE_LIMIT, proposeLimit: opts.proposeLimit ?? PROPOSE_LIMIT }, report);
			if (opts.dry) throw rollback;
		});
	} catch (e) {
		if (e !== rollback) throw e;
	}
	return report;
}

// The same rule over the artists of given releases, inside the transaction
// that just made two releases one (inbox.ts) or two of a release's tracks one
// (release-fill.ts): what that join brought onto one release or track is
// merged or put to the operator at once, not when a sweep next comes by.
export async function artistTwinsOn(tx: SystemTx, releases: string[], by: string): Promise<ArtistTwinReport> {
	const report = blank(false);
	await sweep(tx, { scope: { releases }, by, mergeLimit: Number.POSITIVE_INFINITY, proposeLimit: Number.POSITIVE_INFINITY }, report);
	return report;
}
