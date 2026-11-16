// What a "connect the dots" answer does to the catalogue once it is let
// through — by connect.ts when the cloud can back the answer, by the inbox
// when the operator approves one it could not (inbox.ts `connectAttach`).
// Kept apart from connect.ts so the inbox can call it without importing the
// procedures that raise inbox items.

import type { CatalogProvider, PageKind } from '@curator/protocol';
import type { SystemTx } from '../db/system-tx.js';
import { attachPage, openReview } from './admin.js';
import { findRepresentation, follow } from './identity.js';
import { Ingester } from './ingest.js';
import { BACKFILL_PROVIDERS } from './profile/label-profiler.js';

export type ConnectPage = { provider: CatalogProvider; providerId: string; name: string; url: string };
export type ConnectAttachArgs = { objectId: string; kind: PageKind; page: ConnectPage };

// The page as the object's representation on that store. Refused when the
// page became another object's since the answer was held.
export async function attachConnected(tx: SystemTx, a: ConnectAttachArgs): Promise<void> {
	const id = await follow(tx, a.objectId);
	const owner = await findRepresentation(tx, { provider: a.page.provider, kind: a.kind, providerId: a.page.providerId });
	if (owner === id) return;
	if (owner) throw new Error(`${a.page.provider}:${a.page.providerId} already belongs to ${owner}`);
	// Under the object's own name: a page's title never renames what it joins.
	const [o] = await tx.query<{ name: string }>(`select name from curator.catalog_object where id = $1`, [id]);
	if (!o) throw new Error(`object ${a.objectId} not found`);
	if (a.kind === 'release') {
		await new Ingester(tx, { reason: 'enrichment' }).attachTo(id, { provider: a.page.provider, kind: 'release', providerId: a.page.providerId, name: o.name, url: a.page.url });
		return;
	}
	await attachPage(tx, id, { provider: a.page.provider, providerId: a.page.providerId, name: o.name, url: a.page.url }, a.kind);
	// A label's releases from its new page, once (trackers/backfill.ts).
	if (a.kind === 'label' && (BACKFILL_PROVIDERS as readonly string[]).includes(a.page.provider)) {
		await tx.query(
			`insert into curator.catalog_enrich_task (object_id, need, provider) values ($1, 'backfill', $2)
			on conflict (object_id, need, provider) do update set next_due_at = now(), attempts = 0, last_error = null`,
			[id, a.page.provider],
		);
	}
}

// The page ruled not this artist's or label's: the planner, the profiler and
// the next answer all read the ruling (admin.ts ruledNotSame). A release has
// no such ruling; the vote alone keeps it from being asked again.
export async function ruleOutPage(tx: SystemTx, a: ConnectAttachArgs, by: string, note: string | null): Promise<void> {
	if (a.kind === 'release') return;
	const objectId = await follow(tx, a.objectId);
	const review = await openReview(tx, {
		kind: a.kind === 'artist' ? 'artist_link' : 'label_page',
		objectId,
		candidates: [{ provider: a.page.provider, providerId: a.page.providerId, name: a.page.name, url: a.page.url }],
		evidence: { reason: `connect the dots: not this ${a.kind}'s page` },
	});
	if (review === null) return;
	await tx.query(
		`update curator.catalog_review set status = 'decided', decision = $2::text::jsonb, decided_by = $3, note = $4, decided_at = now() where id = $1::bigint`,
		[String(review), JSON.stringify({ action: 'not_same', candidate: 0 }), by, note],
	);
}
