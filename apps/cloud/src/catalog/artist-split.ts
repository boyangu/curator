// A store page taken off an artist, with what it brought. Two cases, told
// apart by the operator (or the reasoner's bucket verdict):
//   - a namesake's own page ("ELIF" the German pop singer on the Berlin
//     producer, 2026-11-09): the page becomes its own artist and takes its
//     releases — every release the page lists, under whichever stores hold
//     them — so the namesake is a real artist in the catalogue, not a block;
//   - a store's bucket of namesakes (Deezer's "Elif", 0 fans, Turkish pop
//     beside her "Hold Me Close"): the page is blocked (agent/apply.ts
//     runBlockSource) and the releases only this store brought lose the
//     credit; one another store also holds stays hers.
// The page's release list is read from the store before the transaction
// (admin-ops.ts artistUnlink) and travels in the inbox op's args, so an
// approval applies it without a call out. Events about the releases that
// left are withdrawn: they were announced as the followed artist's.

import type { CatalogProvider } from '@curator/protocol';
import type { SystemTx } from '../db/system-tx.js';
import { unlinkPage } from './admin.js';
import { runBlockSource } from './agent/apply.js';
import { ingestClaims } from './ingest.js';
import { recreditOn } from './repair-credits.js';

export type SplitArgs = {
	objectId: string;
	provider: CatalogProvider;
	providerId: string;
	name: string;
	url: string | null;
	// The catalogue releases the page lists (live ids), and of those the ones
	// another page of the artist on the same store lists too (bucket: kept).
	releases: string[];
	keep?: string[];
	as: 'namesake' | 'bucket';
	note: string;
};

export type SplitResult = { into: string | null; recredited: number; uncredited: number; kept: number };

export async function splitArtistPage(tx: SystemTx, a: SplitArgs, by: string): Promise<SplitResult> {
	const out: SplitResult = { into: null, recredited: 0, uncredited: 0, kept: 0 };
	const touched: string[] = [];
	if (a.as === 'namesake') {
		await unlinkPage(tx, a.objectId, { provider: a.provider, id: a.providerId, url: a.url }, by, a.note, { kind: 'artist' });
		// Minted fresh: the page is nobody's now, and a lone artist claim joins
		// by representation only.
		const r = await ingestClaims(tx, [{ provider: a.provider, kind: 'artist', providerId: a.providerId, name: a.name, url: a.url ?? undefined }], { reason: 'enrichment' });
		const into = r.outcomes[0]!.objectId;
		if (into === a.objectId) throw new Error('split: the page came back onto the same artist');
		out.into = into;
		for (const rel of a.releases) {
			const n = await recreditOn(tx, a.objectId, rel, into);
			if (n) {
				out.recredited += n;
				touched.push(rel);
			}
		}
	} else {
		await runBlockSource(tx, { objectId: a.objectId, provider: a.provider, kind: 'artist', providerId: a.providerId, reason: a.note, note: a.note }, by);
		const keep = new Set(a.keep ?? []);
		for (const rel of a.releases) {
			if (keep.has(rel)) {
				out.kept++;
				continue;
			}
			const [other] = await tx.query(
				`select 1 from curator.catalog_source_object so where so.object_id = $1 and so.kind = 'release' and so.provider <> $2 and so.provider <> 'user' limit 1`,
				[rel, a.provider],
			);
			if (other) {
				out.kept++;
				continue;
			}
			const gone = await tx.query(
				`delete from curator.catalog_edge e where (e.src = $1 and e.kind = 'artist-release' and e.dst = $2)
					or (e.dst = $1 and e.kind = 'recording-artist' and e.src in (select rr.dst from curator.catalog_edge rr where rr.src = $2 and rr.kind = 'release-recording'))
				returning 1`,
				[a.objectId, rel],
			);
			if (gone.length) {
				out.uncredited += gone.length;
				touched.push(rel);
			}
		}
	}
	// Announced as this artist's: withdrawn. A release the namesake now holds
	// is announced again only if someone follows them.
	for (const rel of touched) await tx.query(`delete from curator.catalog_event where subject_id = $1`, [rel]);
	return out;
}
