// Labels written as text, as label objects (2026-11-26: a label is the label
// of its name; ingest.ts textLabel). Two things here beyond ingestion:
//
//   - linkLabelTexts: the releases ingested before that rule, which hold their
//     label as text only, tied to the label of that name. A back-office
//     command run once (`catalog labels link-texts`), in pages by id; run
//     again it finds nothing left. Raises no event of its own: the cards of
//     recent events concerned are rebuilt with the label among their subjects
//     (card-rebuild.ts), as for any later link.
//   - detectLabelNamesakes: the cost of the rule. Two labels of one name are
//     one object now unless a store holds them apart, so a label's page can
//     sit beside releases of a namesake that only share its name. Where the
//     releases tied by name share no artist with the releases the label's own
//     store pages list, the operator is told (an inbox notice). Nothing is
//     undone by itself: a namesake is a judgement.

import type { Db, Queryable } from '../db/db.js';
import { num } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import { WEAK_SQL } from './identity.js';
import { raise } from './inbox.js';
import { Ingester } from './ingest.js';

const PAGE = 2000;

export type LabelTextsReport = { scanned: number; linked: number; next: string | null; dry: boolean };

// One page of releases that hold a label as text and are tied to none, from
// `after` (a release id; null = the start). The evidence of each link is a
// representation of the release (the store that wrote the text), the first by
// id. `next`: where the following page starts, null when this was the last.
export async function linkLabelTexts(db: Db, opts: { after?: string | null; limit?: number; dry?: boolean } = {}): Promise<LabelTextsReport> {
	const limit = Math.min(Math.max(1, opts.limit ?? PAGE), 10_000);
	return withSystemTx(db, async (tx) => {
		const rows = await tx.query<{ id: string; text: string; so: string | null }>(
			`select r.id, r.label_text as text,
				(select s.id from curator.catalog_source_object s where s.object_id = r.id order by s.id limit 1) as so
			from curator.catalog_object r
			where r.kind = 'release' and r.merged_into is null and r.label_text is not null and r.id > $1::uuid
				and not exists (select 1 from curator.catalog_edge e where e.src = r.id and e.kind = 'release-label')
			order by r.id limit $2::int`,
			[opts.after ?? '00000000-0000-0000-0000-000000000000', String(limit)],
		);
		const next = rows.length === limit ? rows[rows.length - 1]!.id : null;
		const usable = rows.filter((r) => r.so !== null).map((r) => ({ releaseId: r.id, text: r.text, sourceObjectId: r.so! }));
		const linked = opts.dry ? usable.length : await new Ingester(tx, { reason: 'enrichment' }).labelsByText(usable);
		return { scanned: rows.length, linked, next, dry: opts.dry === true };
	});
}

// The stores whose label page lists the label's releases itself.
const PAGE_STORES = ['beatport', 'bandcamp', 'soundcloud', 'traxsource'];
// Below these the two sides say too little to call them strangers.
const MIN_EACH = 3;
const LABELS_PER_PASS = 200;
const WINDOW_DAYS = 2;

// Labels that gained a release lately, both sides sizeable and no artist in
// common. Returns how many were raised.
export async function detectLabelNamesakes(tx: Queryable): Promise<number> {
	const sides = await tx.query<{ label: string; name: string; own: unknown; named: unknown; providers: string }>(
		`with recent as (
			select distinct e.dst as id from curator.catalog_edge e where e.kind = 'release-label' and e.at > now() - make_interval(days => $1::int) limit $2::int
		), pages as (
			select s.object_id as label, array_agg(distinct s.provider) as providers
			from recent join curator.catalog_source_object s on s.object_id = recent.id
			where s.kind = 'label' and s.provider = any($3::text[]) and not ${WEAK_SQL}
			group by s.object_id
		), rel as (
			select p.label, e.src as release, exists (
				select 1 from curator.catalog_edge_evidence ev join curator.catalog_source_object so on so.id = ev.source_object_id
				where ev.edge_id = e.id and so.provider = any(p.providers)) as own
			from pages p join curator.catalog_edge e on e.dst = p.label and e.kind = 'release-label'
		)
		select rel.label, l.name, count(*) filter (where own) as own, count(*) filter (where not own) as named, array_to_string(min(p.providers), ',') as providers
		from rel join curator.catalog_object l on l.id = rel.label and l.merged_into is null join pages p on p.label = rel.label
		group by rel.label, l.name`,
		[String(WINDOW_DAYS), String(LABELS_PER_PASS), `{${PAGE_STORES.join(',')}}`],
	);
	let raised = 0;
	for (const s of sides) {
		if (num(s.own) < MIN_EACH || num(s.named) < MIN_EACH) continue;
		const providers = `{${s.providers}}`;
		const [shared] = await tx.query<{ yes: boolean }>(
			`with rel as (
				select e.src as release, exists (
					select 1 from curator.catalog_edge_evidence ev join curator.catalog_source_object so on so.id = ev.source_object_id
					where ev.edge_id = e.id and so.provider = any($2::text[])) as own
				from curator.catalog_edge e where e.dst = $1 and e.kind = 'release-label'
			)
			select exists (
				select 1 from rel a join curator.catalog_edge aa on aa.dst = a.release and aa.kind = 'artist-release'
				join curator.catalog_edge bb on bb.src = aa.src and bb.kind = 'artist-release'
				join rel b on b.release = bb.dst and b.own
				where not a.own) as yes`,
			[s.label, providers],
		);
		if (shared?.yes) continue;
		const sample = async (own: boolean) =>
			(
				await tx.query<{ name: string }>(
					`select r.name from curator.catalog_edge e join curator.catalog_object r on r.id = e.src
					where e.dst = $1 and e.kind = 'release-label' and ${own ? '' : 'not '}exists (
						select 1 from curator.catalog_edge_evidence ev join curator.catalog_source_object so on so.id = ev.source_object_id
						where ev.edge_id = e.id and so.provider = any($2::text[]))
					order by r.release_at desc nulls last limit 5`,
					[s.label, providers],
				)
			).map((r) => r.name);
		const id = await raise(tx, {
			kind: 'label.namesake',
			severity: 'notice',
			title: `«${s.name}»: ${num(s.named)} release(s) tied by the label's name share no artist with the ${num(s.own)} its ${s.providers} page lists`,
			subjects: [s.label],
			evidence: { providers: s.providers.split(','), own: num(s.own), named: num(s.named), sampleOwn: await sample(true), sampleNamed: await sample(false) },
			actor: 'worker',
			key: s.label,
		});
		if (id !== null) raised++;
	}
	return raised;
}
