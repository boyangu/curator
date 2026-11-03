// A library's collection taken into the catalogue from the back office
// (`catalog library import`, and the headless core script
// apps/core/src/cli/catalog-import.ts, which posts here because a Node script
// holds no app session to call catalog.ingest with). The claims are what
// the app would send itself (core library-candidates.ts releaseCandidates):
// its labels first, then each release with the owner's tracks on it and
// their ISRCs. The same rules as catalog.ingest — claims checked one by one,
// a batch keyed so a retry returns what the first try did — under the
// producer `admin:<by>`; then each release is queued for a fill and each
// label not yet profiled for its profile (queueLibraryFollowUps).

import type { CatalogKind } from '@curator/protocol';
import type { Db } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import { parseClaims, priorBatch, queueLibraryFollowUps, recordBatch } from './catalog.js';
import { ingestClaims } from './ingest.js';

export type LibraryImportResult = {
	dry: boolean;
	duplicate: boolean;
	// Per claim, in order.
	results: ({ objectId: string; kind: CatalogKind; created: boolean } | { rejected: string })[];
	created: number;
	attached: number;
	fills: number;
	profiles: number;
};

export const LIBRARY_IMPORT_MAX = 100;

export async function libraryImport(db: Db, args: { claims: unknown[]; key: string; by: string; dry?: boolean }): Promise<LibraryImportResult> {
	if (!Array.isArray(args.claims) || !args.claims.length) throw new Error('library import needs claims');
	if (args.claims.length > LIBRARY_IMPORT_MAX) throw new Error(`at most ${LIBRARY_IMPORT_MAX} claims a batch`);
	if (!/^[\w:.-]{8,128}$/.test(args.key)) throw new Error('library import needs an idempotency key (8–128 characters)');
	const producer = `admin:${args.by}`;
	const rollback = new Error('dry run');
	let out: LibraryImportResult | null = null;
	try {
		await withSystemTx(db, async (tx) => {
			const prior = await priorBatch<LibraryImportResult>(tx, producer, args.key);
			if (prior) {
				out = { ...prior, duplicate: true };
				return;
			}
			const { claims, index, rejected } = parseClaims(args.claims);
			const r = await ingestClaims(tx, claims, { reason: 'library_import' });
			const follow = await queueLibraryFollowUps(tx, r.outcomes, { profileLabels: true });
			const results: LibraryImportResult['results'] = args.claims.map((_, i) => {
				const at = index.indexOf(i);
				if (at === -1) return { rejected: rejected.get(i) ?? 'invalid' };
				const o = r.outcomes[at]!;
				return { objectId: o.objectId, kind: o.kind, created: o.created };
			});
			out = { dry: !!args.dry, duplicate: false, results, created: r.created, attached: r.attached, fills: follow.fills, profiles: follow.profiles };
			if (args.dry) throw rollback;
			await recordBatch(tx, producer, args.key, 'library_import', claims.length, r.created, r.attached, out);
		});
	} catch (e) {
		if (e !== rollback) throw e;
	}
	return out!;
}
