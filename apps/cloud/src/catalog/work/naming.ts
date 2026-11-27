// Which of an artist's or a label's store pages a device may be asked to
// read. The device never chooses: it reads exactly the pages a job names, so
// the guard against a mixed-up page lives here and nowhere else (2026-11-18,
// "Fade": an artist object holding a namesake's Spotify page and Deezer's
// page of every act of that name had all of them read, and amplified).
//
// An artist: its one Spotify page. Spotify is the only store whose artist
// listing is read at all (Deezer's artist pages file namesakes together;
// Beatport has no artist listing reader). A label: its Beatport and its
// Bandcamp page (a numeric Bandcamp id only: a slug is a reader's key, not a
// page) — never a distributor's, whose name is on thousands of unrelated
// releases.
//
// Several pages of ONE store on one object is a fault in the data, never a
// state to read through: an artist is the name an act releases under — the
// same person's other names are other artists — so two Spotify pages are a
// namesake attached by its name, or the store's own duplicate profile. None
// is read, whatever a device's library names (a user holding the namesake's
// track would name the namesake's page), and the operator is asked which is
// theirs (Guy, 2026-11-27).
//
// A label with a page on both stores. Two listings are only ever compared
// when both were READ: what the catalogue holds of a label on a store nobody
// read is whatever some library happened to own there, and two such samples
// say nothing of each other.
//   - Both read: what the catalogue holds of the two must agree — two titles
//     in common, a quarter of the shorter list, a twentieth of the longer
//     (library-logic listingsAgree). Where they do, both are read.
//     Where they do not, NEITHER is read and the operator is told — which of
//     two pages is the label cannot be read off their sizes (Guy, 2026-11-26)
//     — except the page a device's own library names (its hint), read alone.
//   - Otherwise one page is the REFERENCE — the one that was read; with
//     neither read, the one the catalogue holds more of — and is read as it
//     is. The other is a PROBE: its listing is compared with the reference's
//     before anything of it is kept (report.ts), and only once the reference
//     has been read, so it is compared with a listing and not with a sample.
//     `awaits` names the reference's store while that reading is still to
//     come: a device that cannot read that store is not handed the probe.
//
// "Read": a device's reading of the page is on record (catalog_work_state,
// find ok | more), or the weekly reading's is (catalog_cursor holding what a
// poll left, for the page the object has had longest on that store).
//
// A page under a block (catalog_source_block), judged mixed or foreign
// (catalog_page_check), or whose probe did not agree within the confirmation
// age, is never named. Blocks, verdicts and the object's pages are read
// afresh every time — one small statement — so an operator's ruling holds
// from the next read; only the comparison of a label's two listings (how
// much the catalogue holds of each, and whether they agree), which walks its
// releases, is kept for a day.

import type { CatalogKind, CatalogRef, CatalogWorkStore } from '@curator/protocol';
import { isDistributor, listingsAgree } from '@curator/library-logic';
import type { Queryable } from '../../db/db.js';
import { raise } from '../inbox.js';

export type NamedPage = { provider: CatalogWorkStore; providerId: string; url: string | null; probe: boolean; awaits?: CatalogWorkStore };

export const WORK_ACTOR = 'device-work';
export const PAGE_STORES: Record<'artist' | 'label', CatalogWorkStore[]> = { artist: ['spotify'], label: ['beatport', 'bandcamp'] };
// How long a label's two listings stay compared before they are walked again.
const VERDICT_HOURS = 24;
// A probe that did not agree is tried again after this: the catalogue's own
// copy of the label may have been the one at fault, and the operator's
// answer to the notice (unlink it, block it) settles it sooner.
const PROBE_REST_DAYS = 90;
// The releases of one label walked for a comparison, at most.
const TITLES_MAX = 20_000;

// A store's own id for the page, not a reader's key.
export const ownId = (provider: string, id: string): boolean => !id.includes('/') && (provider !== 'bandcamp' || /^\d+$/.test(id));

export const pageKey = (p: { provider: string; providerId: string }): string => `${p.provider}:${p.providerId}`;

export const isPageKind = (kind: CatalogKind): kind is 'artist' | 'label' => kind === 'artist' || kind === 'label';

// The titles the catalogue holds of a label's releases, by the store each
// has a page on: what one of its pages listed, read off the releases.
export async function labelTitlesByStore(tx: Queryable, labelId: string, stores: readonly string[]): Promise<Map<string, string[]>> {
	// From the label's own edges, each release by primary key (the fence of
	// pages.ts: a plain join lets the planner walk every release). No more
	// than TITLES_MAX of them: the walk is a read per release, and the few
	// labels past that are compared on the part walked — both stores' titles
	// from the same releases, so a label listed alike on both still agrees.
	const rows = await tx.query<{ provider: string; titles: string | null }>(
		`select so.provider, string_agg(distinct r.name, chr(30)) as titles
		from (select e.src as id from curator.catalog_edge e where e.dst = $1 and e.kind = 'release-label' limit ${TITLES_MAX}) s
		cross join lateral (select x.name, x.merged_into from curator.catalog_object x where x.id = s.id offset 0) r
		join curator.catalog_source_object so on so.object_id = s.id and so.kind = 'release' and so.provider = any($2::text[])
		where r.merged_into is null
		group by so.provider`,
		[labelId, `{${stores.join(',')}}`],
	);
	return new Map(rows.map((r) => [r.provider, r.titles ? r.titles.split('\u001e') : []]));
}

// How a label's two pages' listings compare: what the catalogue holds of
// each, and whether the smaller lists enough of the larger. `read`: whether
// it compared two listings that were read, or — to pick the reference of two
// pages nobody read — two samples; one is never taken for the other.
type Compared = { sig: string; read: boolean; size: Record<string, number>; agrees: boolean; shared: number };

async function compared(tx: Queryable, labelId: string, pages: readonly { provider: string; provider_id: string }[], read: boolean): Promise<Compared> {
	const sig = pages.map((p) => `${p.provider}:${p.provider_id}`).sort().join('|');
	const [kept] = await tx.query<{ evidence: string | null }>(
		`select evidence::text as evidence from curator.catalog_work_state
		where object_id = $1 and job = 'page' and provider = '*' and provider_id = '' and answered_at > now() - make_interval(hours => ${VERDICT_HOURS})`,
		[labelId],
	);
	const before = kept?.evidence ? (JSON.parse(kept.evidence) as Partial<Compared>) : null;
	if (before?.sig === sig && before.read === read && before.size && typeof before.agrees === 'boolean') return before as Compared;

	const a = pages[0]!;
	const b = pages[1]!;
	const titles = await labelTitlesByStore(tx, labelId, [a.provider, b.provider]);
	const of = (p: { provider: string }): string[] => titles.get(p.provider) ?? [];
	const verdict = listingsAgree(of(a), of(b));
	const out: Compared = { sig, read, size: { [a.provider]: of(a).length, [b.provider]: of(b).length }, agrees: verdict.agrees, shared: verdict.shared };
	await tx.query(
		`insert into curator.catalog_work_state (object_id, job, provider, provider_id, outcome, evidence) values ($1, 'page', '*', '', 'ok', $2::text::jsonb)
		on conflict (object_id, job, provider, provider_id) do update set outcome = 'ok', evidence = excluded.evidence, answered_at = now()`,
		[labelId, JSON.stringify(out)],
	);
	return out;
}

export async function namedPages(tx: Queryable, o: { id: string; kind: CatalogKind; name: string }, hints: readonly CatalogRef[] = []): Promise<NamedPage[]> {
	if (!isPageKind(o.kind)) return [];
	// A distributor's name is on thousands of unrelated releases: not a label
	// to read, whatever page it has (ingest.ts keeps it as text for the same reason).
	if (o.kind === 'label' && isDistributor(o.name)) return [];
	const stores = PAGE_STORES[o.kind];
	// `read`: the weekly reading keeps one memory per store — of the page the
	// object has had longest there — and only a poll that answered leaves one
	// (a failed run stamps its time and its error, not the memory).
	const rows = await tx.query<{ provider: CatalogWorkStore; provider_id: string; url: string | null; blocked: boolean; verdict: string | null; read: boolean }>(
		`select so.provider, so.provider_id, so.url,
			exists (select 1 from curator.catalog_source_block b where b.provider = so.provider and b.kind = so.kind and b.provider_id = so.provider_id) as blocked,
			coalesce(
				(select 'disagrees' from curator.catalog_work_state ws where ws.object_id = so.object_id and ws.job = 'find' and ws.provider = so.provider and ws.provider_id = so.provider_id
					and ws.outcome = 'disagrees' and ws.answered_at > now() - make_interval(days => ${PROBE_REST_DAYS})),
				(select pc.verdict from curator.catalog_page_check pc where pc.provider = so.provider and pc.kind = so.kind and pc.provider_id = so.provider_id)
			) as verdict,
			(exists (select 1 from curator.catalog_work_state ws where ws.object_id = so.object_id and ws.job = 'find' and ws.provider = so.provider and ws.provider_id = so.provider_id and ws.outcome in ('ok', 'more'))
				or (exists (select 1 from curator.catalog_cursor c where c.object_id = so.object_id and c.provider = so.provider and c.cursor <> '{}'::jsonb and c.last_run_at > so.first_seen_at)
					and not exists (select 1 from curator.catalog_source_object older where older.object_id = so.object_id and older.kind = so.kind and older.provider = so.provider
						and (older.first_seen_at, older.provider_id) < (so.first_seen_at, so.provider_id)))) as read
		from curator.catalog_source_object so
		where so.object_id = $1 and so.kind = $2 and so.provider = any($3::text[])
		order by so.first_seen_at, so.provider_id`,
		[o.id, o.kind, `{${stores.join(',')}}`],
	);
	const usable = rows.filter((r) => ownId(r.provider, r.provider_id) && !r.blocked && r.verdict !== 'mixed' && r.verdict !== 'foreign' && r.verdict !== 'disagrees');
	type Row = (typeof usable)[number];
	const page = (r: Row, probe = false, awaits?: CatalogWorkStore): NamedPage => ({ provider: r.provider, providerId: r.provider_id, url: r.url, probe, ...(awaits ? { awaits } : {}) });

	// One page a store; of several, none.
	const perStore: Row[] = [];
	for (const store of stores) {
		const here = usable.filter((r) => r.provider === store);
		if (here.length <= 1) {
			perStore.push(...here);
			continue;
		}
		await raise(tx, {
			kind: 'work.pages',
			severity: 'notice',
			title: `${o.name}: ${here.length} ${store} pages on one ${o.kind} — none is read until all but one are unlinked or blocked. Which is theirs?`,
			subjects: [o.id],
			evidence: { store, pages: here.map((r) => ({ id: r.provider_id, url: r.url })) },
			actor: WORK_ACTOR,
			key: `several:${store}`,
		});
	}
	if (perStore.length <= 1) return perStore.map((r) => page(r));

	// A label with a page on both stores.
	const [a, b] = perStore as [Row, Row];
	if (a.read && b.read) {
		const c = await compared(tx, o.id, perStore, true);
		if (c.agrees) return [page(a), page(b)];
		const named = perStore.find((r) => hints.some((h) => h.kind === o.kind && h.provider === r.provider && h.providerId === r.provider_id));
		const size = (r: Row): number => c.size[r.provider] ?? 0;
		const [larger, smaller] = size(b) > size(a) ? [b, a] : [a, b];
		await raise(tx, {
			kind: 'work.pages',
			severity: 'notice',
			title: `${o.name}: its ${smaller.provider} page shares ${c.shared} of ${size(smaller)} releases with its ${larger.provider} page — ${named ? `only the ${named.provider} page is read` : 'neither is read'}`,
			subjects: [o.id],
			evidence: { pages: perStore.map((r) => ({ provider: r.provider, id: r.provider_id, url: r.url, listed: size(r) })), shared: c.shared },
			actor: WORK_ACTOR,
			key: `disagree:${c.sig}`,
		});
		// The device's own page stands; with none named, neither does.
		return named ? [page(named)] : [];
	}
	// One read, or neither: the reference as it is, the other compared with it.
	let reference = a.read ? a : b.read ? b : null;
	if (!reference) {
		// How much the catalogue holds of each, from the same kept comparison:
		// a label nobody has read yet is not walked at every page open.
		const c = await compared(tx, o.id, perStore, false);
		reference = (c.size[b.provider] ?? 0) > (c.size[a.provider] ?? 0) ? b : a;
	}
	const other = reference === a ? b : a;
	const pages = [page(reference), page(other, true, reference.read ? undefined : reference.provider)];
	// In the stores' own order, whichever is which.
	return reference === a ? pages : [pages[1]!, pages[0]!];
}

// A label's listings are compared again at the next ask: a page of it was
// just read, so what the catalogue holds of it changed.
export async function forgetPages(tx: Queryable, objectId: string): Promise<void> {
	await tx.query(`delete from curator.catalog_work_state where object_id = $1 and job = 'page'`, [objectId]);
}
