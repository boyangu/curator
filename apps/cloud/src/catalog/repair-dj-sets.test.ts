// DJ sets out of the catalogue: what goes, what is only trimmed, what stays. Made-up names.

import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp } from '../test/harness.js';
import { adminOps } from './admin-ops.js';
import { ingestClaims } from './ingest.js';

const rec = (provider: 'soundcloud' | 'apple', id: string, name: string, minutes: number) => ({ provider, kind: 'recording' as const, providerId: id, name, facts: { durationSec: minutes * 60 } });
const rel = (provider: 'soundcloud' | 'apple', id: string, name: string, recordings: ReturnType<typeof rec>[]) => ({ provider, kind: 'release' as const, providerId: id, name, facts: { releaseDate: '2026-03-01' }, artists: [{ provider, kind: 'artist' as const, providerId: `${provider}-kaske`, name: 'Kaske' }], recordings });

describe('repair dj-sets', () => {
	it('removes a set only SoundCloud holds and a release of nothing else, trims a release that has other tracks, and leaves another store’s long track', async () => {
		const app = await createTestApp();
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					rel('soundcloud', 'set:1', 'Northfold Sessions 012', [rec('soundcloud', 'm1', 'Northfold Sessions 012', 62)]),
					rel('soundcloud', 'set:2', 'Glass Rivers', [rec('soundcloud', 't1', 'Glass Rivers', 6), rec('soundcloud', 'm2', 'Glass Rivers (Continuous Mix)', 71)]),
					rel('apple', 'a3', 'Northfold Ten', [rec('apple', 'm3', 'Northfold Ten (Continuous Mix)', 74)]),
				],
				{ reason: 'tracker' },
			),
		);
		const ops = adminOps(app.db, {});
		const names = async (kind: string) => (await app.db.query<{ name: string }>(`select name from curator.catalog_object where kind = $1 and merged_into is null order by name`, [kind])).map((r) => r.name);
		const dry = await ops.repairDjSets({ dry: true });
		expect(dry).toMatchObject({ dry: true, recordings: 2, releases: 1, elsewhere: { count: 1, sample: ['Northfold Ten (Continuous Mix)'] } });
		expect(await names('recording')).toHaveLength(4);
		const r = await ops.repairDjSets({});
		expect(r).toMatchObject({ dry: false, recordings: 2, releases: 1, trimmed: [{ release: 'Glass Rivers', set: 'Glass Rivers (Continuous Mix)' }] });
		expect(await names('recording')).toEqual(['Glass Rivers', 'Northfold Ten (Continuous Mix)']);
		expect(await names('release')).toEqual(['Glass Rivers', 'Northfold Ten']);
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'soundcloud' and provider_id in ('set:1', 'm1', 'm2')`)).toEqual([]);
		// Logged, with what went; a second run finds nothing.
		expect((await ops.inboxList({ status: 'all', kind: 'repair.dj_sets' })).rows).toHaveLength(1);
		expect(await ops.repairDjSets({})).toMatchObject({ recordings: 0, releases: 0 });
	});
});
