// One label under two names — "Afterlife" and "Afterlife Records", "Renaissance
// Records" and "Renaissance Music" — is decided by what the two hold, not by
// their spelling: a sub-label ("Steyoyoke Black"), a sister imprint
// ("Rebellion") or a distribution alias shares artists with its parent and is
// still its own label. So this is a collection.Contains whose comparer is the
// back office: the code retrieves every label that might be the same one
// (high recall, cheap) and lays out the evidence; a reviewer (Claude Code with
// the catalog skill) reads it and merges, rules the pair apart, or skips.
//
// Retrieval, any of:
//   - the names relate: equal once filler words are dropped ("records",
//     "music"…), or one's words begin the other's ("Steyoyoke" / "Steyoyoke
//     Black");
//   - they share releases: the same release object tied to both
//     (`release-label`), which two imports of one label under two names leave;
//   - they share a large part of a roster, whatever their names.
// Pairs ruled apart (catalog_not_same) or asked before are never raised again.
//
// It runs over a label when it is minted (the `dedupe` task, ingest.ts) and
// again while the label is young and its releases arrive (a new label holds
// nothing to compare), and on demand (`catalog review scan --kind label`).

import { nameFold } from '@curator/library-logic';
import type { Db, Queryable } from '../db/db.js';
import { num } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import { objectReleases, openReview, type ReviewCandidate } from './admin.js';
import { labelCore } from './label-names.js';

export type NameRelation = 'same' | 'contains' | null;

export function nameRelation(a: string, b: string): NameRelation {
	const x = labelCore(a);
	const y = labelCore(b);
	if (x.join(' ') === y.join(' ')) return 'same';
	const [short, long] = x.length <= y.length ? [x, y] : [y, x];
	// Word-wise, from the start: "steyoyoke" begins "steyoyoke black"; a one-letter
	// or numeric core ("a", "7") begins too much to mean anything.
	if (short.join('').length < 3 || /^\d+$/.test(short.join(''))) return null;
	return short.every((w, i) => long[i] === w) ? 'contains' : null;
}

// Below this, an artist overlap alone is a scene, not a sameness.
const ROSTER_MIN_SHARED = 3;
const ROSTER_MIN_SHARE = 0.3;
const RELEASES_MIN_SHARED = 2;
// Credits that are no one.
const NOBODY = new Set(['various artists', 'various', 'va', 'v a', 'unknown artist']);

type LabelRow = { id: string; name: string; watchers: number; releases: number; pages: string[]; fromLibrary: boolean };

async function labelRows(tx: Queryable, ids: string[]): Promise<Map<string, LabelRow>> {
	if (!ids.length) return new Map();
	const rows = await tx.query<{ id: string; name: string; watch_count: unknown; releases: unknown; pages: string | null; library: boolean }>(
		`select o.id, o.name, o.watch_count,
			(select count(*) from curator.catalog_edge e join curator.catalog_object r on r.id = e.src and r.merged_into is null where e.kind = 'release-label' and e.dst = o.id) as releases,
			(select string_agg(distinct so.provider, ',') from curator.catalog_source_object so where so.object_id = o.id and so.provider <> 'user') as pages,
			exists (select 1 from curator.catalog_source_object so where so.object_id = o.id and so.provider = 'user') as library
		from curator.catalog_object o where o.id = any($1::uuid[])`,
		[`{${ids.join(',')}}`],
	);
	return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, watchers: num(r.watch_count), releases: num(r.releases), pages: r.pages ? r.pages.split(',') : [], fromLibrary: r.library === true }]));
}

// The artists a label puts out: its releases' credits and its roster.
async function roster(tx: Queryable, labelId: string): Promise<Map<string, string>> {
	const rows = await tx.query<{ id: string; name: string }>(
		`select distinct a.id, a.name from curator.catalog_edge rl
			join curator.catalog_object r on r.id = rl.src and r.merged_into is null
			join curator.catalog_edge ar on ar.dst = r.id and ar.kind = 'artist-release'
			join curator.catalog_object a on a.id = ar.src and a.merged_into is null
		where rl.kind = 'release-label' and rl.dst = $1
		union
		select a.id, a.name from curator.catalog_edge la join curator.catalog_object a on a.id = la.dst and a.merged_into is null
		where la.kind = 'label-artist' and la.src = $1`,
		[labelId],
	);
	return new Map(rows.filter((r) => !NOBODY.has(nameFold(r.name))).map((r) => [r.id, r.name]));
}

export type RelatedEvidence = {
	kind: 'related_label';
	name: NameRelation;
	sharedReleases: number;
	sharedReleaseExamples: string[];
	sharedArtists: number;
	sharedArtistExamples: string[];
	// Of each side's roster, the part the other shares.
	rosterShare: [number, number];
	sides: { name: string; releases: number; roster: number; watchers: number; pages: string[]; fromLibrary: boolean; span: [string | null, string | null] }[];
};

export type RelatedLabel = { keep: string; fold: string; evidence: RelatedEvidence };

// The labels that may be `labelId` under another name, each with the evidence
// and the side to keep (watchers, the owner's library, pages, releases).
export async function relatedLabels(tx: Queryable, labelId: string, opts: { limit?: number } = {}): Promise<RelatedLabel[]> {
	const [me] = await tx.query<{ name: string }>(`select name from curator.catalog_object where id = $1 and kind = 'label' and merged_into is null`, [labelId]);
	if (!me) return [];
	const found = new Map<string, NameRelation>();
	// Names: every live label is a few thousand rows at most; compared in code.
	const all = await tx.query<{ id: string; name: string }>(`select id, name from curator.catalog_object where kind = 'label' and merged_into is null and id <> $1`, [labelId]);
	for (const l of all) {
		const rel = nameRelation(me.name, l.name);
		if (rel) found.set(l.id, rel);
	}
	// Releases tied to both.
	const shared = await tx.query<{ other: string; n: unknown }>(
		`select e2.dst as other, count(distinct e1.src) as n from curator.catalog_edge e1
			join curator.catalog_object r on r.id = e1.src and r.merged_into is null
			join curator.catalog_edge e2 on e2.src = e1.src and e2.kind = 'release-label' and e2.dst <> e1.dst
			join curator.catalog_object o on o.id = e2.dst and o.kind = 'label' and o.merged_into is null
		where e1.kind = 'release-label' and e1.dst = $1
		group by e2.dst having count(distinct e1.src) >= $2::int`,
		[labelId, String(RELEASES_MIN_SHARED)],
	);
	for (const s of shared) if (!found.has(s.other)) found.set(s.other, null);
	// Rosters: the labels the most of my artists also release on.
	const mine = await roster(tx, labelId);
	if (mine.size >= ROSTER_MIN_SHARED) {
		const overlap = await tx.query<{ other: string; n: unknown }>(
			`select rl.dst as other, count(distinct ar.src) as n from curator.catalog_edge ar
				join curator.catalog_object r on r.id = ar.dst and r.merged_into is null
				join curator.catalog_edge rl on rl.src = r.id and rl.kind = 'release-label' and rl.dst <> $1
				join curator.catalog_object o on o.id = rl.dst and o.kind = 'label' and o.merged_into is null
			where ar.kind = 'artist-release' and ar.src = any($2::uuid[])
			group by rl.dst having count(distinct ar.src) >= $3::int`,
			[labelId, `{${[...mine.keys()].join(',')}}`, String(ROSTER_MIN_SHARED)],
		);
		for (const o of overlap) if (!found.has(o.other) && num(o.n) / mine.size >= ROSTER_MIN_SHARE) found.set(o.other, null);
	}
	// Already ruled apart: never asked again.
	const others = [...found.keys()];
	if (!others.length) return [];
	const apart = await tx.query<{ a: string; b: string }>(
		`select object_a as a, object_b as b from curator.catalog_not_same where (object_a = $1 and object_b = any($2::uuid[])) or (object_b = $1 and object_a = any($2::uuid[]))`,
		[labelId, `{${others.join(',')}}`],
	);
	const ruled = new Set(apart.map((r) => (r.a === labelId ? r.b : r.a)));
	const rows = await labelRows(tx, [labelId, ...others]);
	const out: RelatedLabel[] = [];
	for (const other of others) {
		if (ruled.has(other)) continue;
		const ev = await pairEvidence(tx, labelId, other, rows, found.get(other) ?? null, mine);
		// A roster-only candidate must still clear the share on the smaller side.
		if (!ev.name && ev.sharedReleases < RELEASES_MIN_SHARED && Math.max(...ev.rosterShare) < ROSTER_MIN_SHARE) continue;
		out.push({ keep: keeper(rows.get(labelId)!, rows.get(other)!), fold: other, evidence: ev });
	}
	const strength = (e: RelatedEvidence) => (e.name === 'same' ? 1000 : 0) + e.sharedReleases * 10 + e.sharedArtists;
	return out.sort((a, b) => strength(b.evidence) - strength(a.evidence)).slice(0, opts.limit ?? 10);
}

// The side a merge keeps: the one people follow, the owner's library names,
// with more pages and releases. A reviewer merging folds the other into it.
function keeper(a: LabelRow, b: LabelRow): string {
	const score = (l: LabelRow) => l.watchers * 1000 + (l.fromLibrary ? 500 : 0) + l.pages.length * 20 + l.releases;
	// A tie goes the same way from either side, so the pair is one question.
	return score(b) > score(a) || (score(b) === score(a) && b.id < a.id) ? b.id : a.id;
}

async function pairEvidence(tx: Queryable, a: string, b: string, rows: Map<string, LabelRow>, name: NameRelation, rosterA?: Map<string, string>): Promise<RelatedEvidence> {
	const [ra, rb] = await Promise.all([rosterA ? Promise.resolve(rosterA) : roster(tx, a), roster(tx, b)]);
	const sharedArtists = [...ra.keys()].filter((id) => rb.has(id)).map((id) => ra.get(id)!);
	const rel = await tx.query<{ name: string; artists: string | null; at: string | null }>(
		`select r.name, to_char(r.release_at, 'YYYY-MM-DD') as at,
			(select string_agg(x.name, ', ' order by ar.position) from curator.catalog_edge ar join curator.catalog_object x on x.id = ar.src where ar.dst = r.id and ar.kind = 'artist-release') as artists
		from curator.catalog_object r
		where r.kind = 'release' and r.merged_into is null
			and exists (select 1 from curator.catalog_edge e where e.src = r.id and e.kind = 'release-label' and e.dst = $1)
			and exists (select 1 from curator.catalog_edge e where e.src = r.id and e.kind = 'release-label' and e.dst = $2)
		order by r.release_at desc nulls last`,
		[a, b],
	);
	const span = async (id: string): Promise<[string | null, string | null]> => {
		const [s] = await tx.query<{ lo: string | null; hi: string | null }>(
			`select to_char(min(r.release_at), 'YYYY-MM-DD') as lo, to_char(max(r.release_at), 'YYYY-MM-DD') as hi from curator.catalog_edge e
				join curator.catalog_object r on r.id = e.src and r.merged_into is null where e.kind = 'release-label' and e.dst = $1`,
			[id],
		);
		return [s?.lo ?? null, s?.hi ?? null];
	};
	const side = async (id: string, r: Map<string, string>) => {
		const row = rows.get(id) ?? (await labelRows(tx, [id])).get(id)!;
		return { name: row.name, releases: row.releases, roster: r.size, watchers: row.watchers, pages: row.pages, fromLibrary: row.fromLibrary, span: await span(id) };
	};
	return {
		kind: 'related_label',
		name: name ?? nameRelation(rows.get(a)?.name ?? '', rows.get(b)?.name ?? ''),
		sharedReleases: rel.length,
		sharedReleaseExamples: rel.slice(0, 6).map((r) => `${r.name}${r.artists ? ` — ${r.artists}` : ''}${r.at ? ` (${r.at})` : ''}`),
		sharedArtists: sharedArtists.length,
		sharedArtistExamples: sharedArtists.slice(0, 10),
		rosterShare: [ra.size ? sharedArtists.length / ra.size : 0, rb.size ? sharedArtists.length / rb.size : 0],
		sides: [await side(a, ra), await side(b, rb)],
	};
}

// A `duplicate` review for the pair, oriented so that `merge:0` keeps the
// stronger side. Returns its id, or null when the pair was asked before.
async function openRelated(tx: Queryable, labelId: string, r: RelatedLabel): Promise<number | null> {
	const [object, candidate] = r.keep === labelId ? [labelId, r.fold] : [r.fold, labelId];
	const [names, theirs] = await Promise.all([
		tx.query<{ id: string; name: string }>(`select id, name from curator.catalog_object where id = any($1::uuid[])`, [`{${object},${candidate}}`]),
		objectReleases(tx, candidate, 25),
	]);
	const name = names.find((n) => n.id === candidate)?.name ?? '';
	const evidence = r.keep === labelId ? r.evidence : { ...r.evidence, rosterShare: [r.evidence.rosterShare[1], r.evidence.rosterShare[0]] as [number, number], sides: [r.evidence.sides[1]!, r.evidence.sides[0]!] };
	const c: ReviewCandidate = { objectId: candidate, name, releases: theirs.map((x) => x.title), evidence };
	return openReview(tx, { kind: 'duplicate', objectId: object, candidates: [c], evidence: { reason: 'related label (label-related.ts): same label under another name, a sub-label, or apart?' } });
}

// Raises every related pair for the labels given (or every live label).
export async function scanRelatedLabels(tx: Queryable, opts: { labels?: string[]; limit?: number } = {}): Promise<{ checked: number; opened: number }> {
	const ids = opts.labels?.length
		? opts.labels
		: (await tx.query<{ id: string }>(`select id from curator.catalog_object where kind = 'label' and merged_into is null order by watch_count desc, name limit $1::int`, [String(opts.limit ?? 5000)])).map((r) => r.id);
	let opened = 0;
	for (const id of ids) for (const r of await relatedLabels(tx, id)) if ((await openRelated(tx, id, r)) !== null) opened++;
	return { checked: ids.length, opened };
}

// A pair a reviewer names outright (the scan did not raise it).
export async function openRelatedPair(tx: Queryable, a: string, b: string): Promise<{ id: number | null; keep: string }> {
	const rows = await labelRows(tx, [a, b]);
	if (rows.size !== 2) throw new Error('both must be live labels');
	const r: RelatedLabel = { keep: keeper(rows.get(a)!, rows.get(b)!), fold: b, evidence: await pairEvidence(tx, a, b, rows, null) };
	return { id: await openRelated(tx, a, r), keep: r.keep };
}

// A label is checked when it is minted and again while it is young: its
// releases and roster, the real evidence, arrive with its first backfills.
const RECHECK_DAYS = 1;
const RECHECK_TIMES = 14;
const GROWN_RELEASES = 20;

export async function queueLabelDedupe(tx: Queryable, labelId: string): Promise<void> {
	await tx.query(`insert into curator.catalog_enrich_task (object_id, need, provider) values ($1, 'dedupe', 'catalog') on conflict do nothing`, [labelId]);
}

export async function runLabelDedupe(deps: { db: Db; batch?: number; log?: { info: (m: string, f?: Record<string, unknown>) => void } }): Promise<{ checked: number; opened: number }> {
	const due = await deps.db.query<{ object_id: string; attempts: unknown }>(
		`select t.object_id, t.attempts from curator.catalog_enrich_task t
			join curator.catalog_object o on o.id = t.object_id and o.kind = 'label' and o.merged_into is null
		where t.need = 'dedupe' and t.provider = 'catalog' and t.next_due_at <= now()
		order by t.next_due_at limit $1::int`,
		[String(deps.batch ?? 25)],
	);
	await deps.db.query(
		`delete from curator.catalog_enrich_task t using curator.catalog_object o
		where t.need = 'dedupe' and t.provider = 'catalog' and o.id = t.object_id and (o.kind <> 'label' or o.merged_into is not null)`,
	);
	let opened = 0;
	for (const d of due) {
		opened += await withSystemTx(deps.db, async (tx) => {
			let n = 0;
			for (const r of await relatedLabels(tx, d.object_id)) if ((await openRelated(tx, d.object_id, r)) !== null) n++;
			const [row] = await tx.query<{ releases: unknown }>(`select count(*) as releases from curator.catalog_edge where kind = 'release-label' and dst = $1`, [d.object_id]);
			if (num(row!.releases) >= GROWN_RELEASES || num(d.attempts) + 1 >= RECHECK_TIMES) {
				await tx.query(`delete from curator.catalog_enrich_task where object_id = $1 and need = 'dedupe' and provider = 'catalog'`, [d.object_id]);
			} else {
				await tx.query(
					`update curator.catalog_enrich_task set attempts = attempts + 1, next_due_at = now() + make_interval(days => $2::int) where object_id = $1 and need = 'dedupe' and provider = 'catalog'`,
					[d.object_id, String(RECHECK_DAYS)],
				);
			}
			return n;
		});
	}
	if (due.length) deps.log?.info('label_dedupe_pass', { checked: due.length, opened });
	return { checked: due.length, opened };
}
