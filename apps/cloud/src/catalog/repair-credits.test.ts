// Credits the SoundCloud splitter cut apart before 2026-11-01 (made-up names):
// "Lowtide (Kaske, Ilka Rane, &Or)" held as "Lowtide (Kaske", "Ilka Rane)"
// and "Or", and "Sun & Moon" as "Sun" and "Moon", each credit given to the
// artists the store credits beside it; a bracketed piece nobody is credited
// as becomes the artist the fixed reader names; the store artists and a plain
// name stay. A dry run writes nothing.

import { describe, expect, it } from 'vitest';
import type { CatalogClaim } from '@curator/protocol';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp } from '../test/harness.js';
import { adminOps } from './admin-ops.js';
import { ingestClaims } from './ingest.js';

const label: CatalogClaim = { provider: 'bandcamp', kind: 'label', providerId: '2140572776', name: 'Northfold Records' };
const sp = (name: string): CatalogClaim => ({ provider: 'spotify', kind: 'artist', providerId: `sp-${name}`, name });
const user = (name: string): CatalogClaim => ({ provider: 'user', kind: 'artist', providerId: `name:${name.toLowerCase()}`, name });
const STORE = ['Lowtide', 'Kaske', 'Ilka Rane', '&Or'].map(sp);
const BROKEN = ['Lowtide (Kaske', 'Ilka Rane)', 'Or'].map(user);
const isrc = (n: number) => [{ namespace: 'isrc' as const, value: `DEUD9260000${n}` }];

describe('repair credits', () => {
	it('gives each cut-apart credit to the artists credited beside it, names what nobody is — a dry run writes nothing', async () => {
		const app = await createTestApp();
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					{
						provider: 'spotify', kind: 'release', providerId: 'al-1', name: 'Tidal Lines', facts: { releaseDate: '2026-05-08' }, artists: STORE, label,
						recordings: [
							{ provider: 'spotify', kind: 'recording', providerId: 'tr-1', name: 'Tidal Lines', identifiers: isrc(1), facts: { durationSec: 300 }, artists: STORE },
							{ provider: 'spotify', kind: 'recording', providerId: 'tr-2', name: 'Halflight', identifiers: isrc(2), facts: { durationSec: 280 }, artists: [sp('Sun & Moon')] },
						],
					},
					// The label's SoundCloud set as the old splitter read it, the tracks
					// joined to the store's by their ISRCs.
					{
						provider: 'soundcloud', kind: 'release', providerId: 'set:1', name: 'Tidal Lines', facts: { releaseDate: '2026-05-08' }, artists: BROKEN, label,
						recordings: [
							{ provider: 'soundcloud', kind: 'recording', providerId: '901', name: 'Tidal Lines', identifiers: isrc(1), facts: { durationSec: 300 }, artists: [...BROKEN, user('Paper (Mill'), user('Northfold')] },
							{ provider: 'soundcloud', kind: 'recording', providerId: '902', name: 'Halflight', identifiers: isrc(2), facts: { durationSec: 280 }, artists: [user('Sun'), user('Moon')] },
						],
					},
				],
				{ reason: 'library_import' },
			),
		);
		const ops = adminOps(app.db, {});
		const live = (name: string) => app.db.query(`select 1 from curator.catalog_object where kind = 'artist' and name = $1 and merged_into is null`, [name]).then((r) => r.length);
		const creditsOn = async (scId: string) => {
			const [rec] = await app.db.query<{ id: string }>(`select object_id as id from curator.catalog_source_object where provider = 'soundcloud' and provider_id = $1`, [scId]);
			return (await app.db.query<{ name: string }>(`select a.name from curator.catalog_edge e join curator.catalog_object a on a.id = e.dst where e.src = $1 and e.kind = 'recording-artist' order by a.name`, [rec!.id])).map((c) => c.name);
		};

		const dry = await ops.repairCredits({ dry: true });
		// "Ilka Rane)" folds to the store's "Ilka Rane": the ingest joined it,
		// and the store's artist took its name — given back.
		expect(dry.renamed).toMatchObject([{ from: 'Ilka Rane)', to: 'Ilka Rane' }]);
		expect(dry.fixed.map((f) => [f.name, f.into.sort(), f.minted])).toEqual([
			['Lowtide (Kaske', ['Kaske', 'Lowtide'], []],
			['Moon', ['Sun & Moon'], []],
			['Or', ['&Or'], []],
			['Paper (Mill', ['Mill', 'Paper'], ['Paper', 'Mill']],
			['Sun', ['Sun & Moon'], []],
		]);
		expect(dry.left).toEqual([]);
		expect(await live('Lowtide (Kaske')).toBe(1);

		await ops.repairCredits({});
		for (const name of ['Lowtide (Kaske', 'Ilka Rane)', 'Or', 'Paper (Mill', 'Sun', 'Moon']) expect(await live(name)).toBe(0);
		for (const name of ['Northfold', 'Lowtide', 'Kaske', '&Or', 'Ilka Rane', 'Sun & Moon', 'Paper', 'Mill']) expect(await live(name)).toBe(1);
		expect(await creditsOn('901')).toEqual(['&Or', 'Ilka Rane', 'Kaske', 'Lowtide', 'Mill', 'Northfold', 'Paper']);
		expect(await creditsOn('902')).toEqual(['Sun & Moon']);
		// Nothing left to do the second time.
		expect(await ops.repairCredits({})).toMatchObject({ fixed: [], renamed: [], left: [] });
	});
});
