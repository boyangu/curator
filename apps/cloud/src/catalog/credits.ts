// Track credits only Deezer has stated — the rule, and the queue of releases
// whose credits are to be read from a store that states them in full.
//
// Deezer's album tracklist names one artist a track, the primary one: its
// full credit sits on the track's own page, a call a track. A recording
// minted from that tracklist is credited to one artist where the other stores
// credit three (2026-11-19, "Big Blue": Omer Bar on the track; Omer Bar,
// Barak White and Gal Kinnel on the release and on Spotify). The credit is
// not wrong, it is short — and nothing on the recording says so except where
// it came from: every `recording-artist` edge it has carries Deezer's evidence
// and no other store's.
//
// Such a credit is provisional. Nothing is taken from it; the stores that
// credit a track in full are read — Spotify's album, Beatport's release page —
// and ingestion adds their artists by its usual rules (credit-fill.ts runs
// the read). A `credits` task per release and store page is queued where the
// state arises:
//   - a Deezer tracklist lands on a release that has such a page, and the
//     page's own tracklist did not come with it (ingest.ts);
//   - a release whose tracks Deezer credited gains such a page without its
//     tracklist — a listing, a link someone found (ingest.ts);
//   - a device opens a page listing one (catalog.ts tracks): what the
//     catalogue held before this rule, as it is looked at.
// A release on neither store waits for the store linker (store-links.ts),
// whose album read by UPC brings the credits along with the page.

import type { CatalogProvider } from '@curator/protocol';
import type { Queryable } from '../db/db.js';

export const CREDITS_NEED = 'credits';

// The stores whose release page credits every track in full, in the order
// they are read.
export const CREDIT_STORES = ['spotify', 'beatport'] as const;
export type CreditStore = (typeof CREDIT_STORES)[number];
export const isCreditStore = (p: CatalogProvider): p is CreditStore => (CREDIT_STORES as readonly string[]).includes(p);

// For a recording (an SQL expression for its id): true when Deezer alone
// stated its credits, false when another source did too, null when nobody
// stated any.
export const deezerOnlySql = (recording: string): string =>
	`(select bool_and(s.provider = 'deezer') from curator.catalog_edge ra
		join curator.catalog_edge_evidence ev on ev.edge_id = ra.id
		join curator.catalog_source_object s on s.id = ev.source_object_id
		where ra.src = ${recording} and ra.kind = 'recording-artist')`;

// For a release: it holds a live track of that kind.
export const shortCreditsSql = (release: string): string =>
	`exists (select 1 from curator.catalog_edge rr join curator.catalog_object o on o.id = rr.dst and o.merged_into is null
		where rr.src = ${release} and rr.kind = 'release-recording' and ${deezerOnlySql('o.id')})`;

// Of these releases, the ones with a track only Deezer credited and a page on
// a store that credits in full: one task per such page. A task already there
// stays as it is (waiting its turn, or put off after a read that settled
// nothing), so asking again costs no store call.
//
// The pages are found first, behind `offset 0`: most releases asked about
// have none (a label's Deezer-only back catalogue on a device's page), and
// without the fence the planner is free to walk every one's tracklist before
// it looks.
export async function queueCredits(tx: Queryable, releaseIds: readonly string[]): Promise<void> {
	if (!releaseIds.length) return;
	await tx.query(
		`insert into curator.catalog_enrich_task (object_id, need, provider)
		select distinct p.id, $2, p.provider
		from (
			select r.id, so.provider from curator.catalog_object r
			join curator.catalog_source_object so on so.object_id = r.id and so.kind = 'release' and so.provider = any($3::text[])
			where r.id = any($1::uuid[]) and r.kind = 'release' and r.merged_into is null
			offset 0
		) p
		where ${shortCreditsSql('p.id')}
		on conflict do nothing`,
		[`{${releaseIds.join(',')}}`, CREDITS_NEED, `{${CREDIT_STORES.join(',')}}`],
	);
}
