// SoundCloud preview copies (made-up names): what the album reader ingested
// before it knew a preview's length is the preview's and an untitled credit
// is not the label's — a 0:30 recording credited to the label, with the ISRC
// the store copies lack — undone and merged into the store recording.

import { describe, expect, it } from 'vitest';
import type { CatalogClaim } from '@curator/protocol';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp, type TestApp } from '../test/harness.js';
import { adminOps } from './admin-ops.js';
import { ingestClaims } from './ingest.js';

const LABEL = 'Northfold Records';
const label: CatalogClaim = { provider: 'bandcamp', kind: 'label', providerId: '2140572776', name: LABEL };
const kaske: CatalogClaim = { provider: 'spotify', kind: 'artist', providerId: 'sp-kaske', name: 'Kaske' };

async function seed(app: TestApp): Promise<{ store: string; preview: string; previewRelease: string }> {
	const claims: CatalogClaim[] = [
		label,
		// The store single: Spotify and Deezer, its real length, no ISRC.
		{
			provider: 'spotify',
			kind: 'release',
			providerId: 'al-drift',
			name: 'Drift',
			facts: { releaseDate: '2026-05-08' },
			artists: [kaske],
			recordings: [{ provider: 'spotify', kind: 'recording', providerId: 'tr-drift', name: 'Drift', facts: { durationSec: 236.2 }, artists: [kaske] }],
			label,
		},
		// The label's compilation on Bandcamp, another copy of the track.
		{
			provider: 'bandcamp',
			kind: 'release',
			providerId: 'bc-comp',
			name: 'Northfold 035',
			facts: { releaseDate: '2026-06-12' },
			artists: [{ provider: 'bandcamp', kind: 'artist', providerId: '2140572776/various', name: 'Various' }],
			recordings: [{ provider: 'bandcamp', kind: 'recording', providerId: 'bct-drift', name: 'Drift', facts: { durationSec: 237 } }],
			label,
		},
		// What the reader made of the label's SoundCloud set: the preview's
		// length, the account's name as the credit, the ISRC.
		{
			provider: 'soundcloud',
			kind: 'release',
			providerId: 'set:5001',
			name: 'Various Artists EP',
			facts: { releaseDate: '2026-06-12', releaseType: 'ep' },
			artists: [{ provider: 'user', kind: 'artist', providerId: 'name:northfold records', name: LABEL }],
			recordings: [
				{
					provider: 'soundcloud',
					kind: 'recording',
					providerId: '901',
					name: 'Drift',
					identifiers: [{ namespace: 'isrc', value: 'DEUD92694223' }],
					facts: { durationSec: 30 },
					artists: [{ provider: 'user', kind: 'artist', providerId: 'name:northfold records', name: LABEL }],
				},
			],
			label,
		},
	];
	await withSystemTx(app.db, (tx) => ingestClaims(tx, claims, { reason: 'library_import' }));
	const id = (provider: string, kind: string, providerId: string) =>
		app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = $1 and kind = $2 and provider_id = $3`, [provider, kind, providerId]).then((x) => x[0]!.object_id);
	return { store: await id('spotify', 'recording', 'tr-drift'), preview: await id('soundcloud', 'recording', '901'), previewRelease: await id('soundcloud', 'release', 'set:5001') };
}

describe('repair previews', () => {
	it('drops the preview length and the label-named credit, and merges the copy into the store recording with its ISRC — a dry run writes nothing', async () => {
		const app = await createTestApp();
		const { store, preview, previewRelease } = await seed(app);
		const ops = adminOps(app.db, {});

		const dry = await ops.repairPreviews({ label: LABEL, dry: true });
		expect(dry).toMatchObject({ dry: true, recordings: 1, lengthsCleared: 1, merged: [{ title: 'Drift', into: store, intoRelease: 'Drift' }], unmatched: [] });
		expect(await app.db.query(`select 1 from curator.catalog_object where id = $1 and merged_into is null`, [preview])).toHaveLength(1);

		const r = await ops.repairPreviews({ label: LABEL });
		expect(r).toMatchObject({ dry: false, recordings: 1, lengthsCleared: 1, creditsDropped: 2, merged: [{ into: store }] });
		const [o] = await app.db.query<{ duration_sec: unknown; isrc: string | null; merged: string | null }>(
			`select s.duration_sec, (select value from curator.catalog_identifier where object_id = s.id and namespace = 'isrc') as isrc, p.merged_into as merged
			from curator.catalog_object s, curator.catalog_object p where s.id = $1 and p.id = $2`,
			[store, preview],
		);
		// The store copy keeps its length, gains the ISRC and the SoundCloud copy.
		expect({ len: Number(o!.duration_sec), isrc: o!.isrc, merged: o!.merged }).toEqual({ len: 236.2, isrc: 'DEUD92694223', merged: store });
		const reps = await app.db.query<{ provider: string }>(`select provider from curator.catalog_source_object where object_id = $1 and kind = 'recording' order by provider`, [store]);
		expect(reps.map((x) => x.provider)).toEqual(['soundcloud', 'spotify']);
		// Nobody named like the label on the track; the SoundCloud release is the track's artist's now.
		const credits = await app.db.query<{ name: string }>(`select a.name from curator.catalog_edge e join curator.catalog_object a on a.id = e.dst where e.src = $1 and e.kind = 'recording-artist'`, [store]);
		expect(credits.map((c) => c.name)).toEqual(['Kaske']);
		const relCredits = await app.db.query<{ name: string }>(`select a.name from curator.catalog_edge e join curator.catalog_object a on a.id = e.src where e.dst = $1 and e.kind = 'artist-release'`, [previewRelease]);
		expect(relCredits.map((c) => c.name)).toEqual(['Kaske']);
		// The compilation's copy stays (a Bandcamp credit question, not this one), and a second run finds nothing.
		expect((await ops.repairPreviews({})).recordings).toBe(0);
	});

	it('credits a various-artists set with every track artist once all are merged, and a rerun keeps it so', async () => {
		const app = await createTestApp();
		const ilka: CatalogClaim = { provider: 'spotify', kind: 'artist', providerId: 'sp-ilka', name: 'Ilka Rane' };
		const preview = (id: string, name: string, isrc: string): CatalogClaim => ({
			provider: 'soundcloud',
			kind: 'recording',
			providerId: id,
			name,
			identifiers: [{ namespace: 'isrc', value: isrc }],
			facts: { durationSec: 30 },
			artists: [{ provider: 'user', kind: 'artist', providerId: 'name:northfold records', name: LABEL }],
		});
		const single = (id: string, name: string, artist: CatalogClaim, len: number): CatalogClaim => ({
			provider: 'spotify',
			kind: 'release',
			providerId: `al-${id}`,
			name,
			facts: { releaseDate: '2026-05-08' },
			artists: [artist],
			recordings: [{ provider: 'spotify', kind: 'recording', providerId: `tr-${id}`, name, facts: { durationSec: len }, artists: [artist] }],
			label,
		});
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					label,
					single('a', 'Aye', kaske, 444),
					single('b', 'Glass', ilka, 401),
					{
						provider: 'soundcloud',
						kind: 'release',
						providerId: 'set:6001',
						name: 'Various Artists EP',
						facts: { releaseDate: '2026-06-12', releaseType: 'ep' },
						artists: [{ provider: 'user', kind: 'artist', providerId: 'name:northfold records', name: LABEL }],
						recordings: [preview('a1', 'Aye', 'DEVU52647787'), preview('b1', 'Glass', 'DEVU52647788')],
						label,
					},
				],
				{ reason: 'library_import' },
			),
		);
		const ops = adminOps(app.db, {});
		expect((await ops.repairPreviews({ label: LABEL })).merged).toHaveLength(2);
		const credits = () =>
			app.db.query<{ name: string }>(
				`select a.name from curator.catalog_edge e join curator.catalog_object a on a.id = e.src
				join curator.catalog_source_object so on so.object_id = e.dst and so.provider = 'soundcloud' and so.provider_id = 'set:6001'
				where e.kind = 'artist-release' order by a.name`,
			).then((r) => r.map((x) => x.name));
		expect(await credits()).toEqual(['Ilka Rane', 'Kaske']);
		expect((await ops.repairPreviews({ label: LABEL })).recordings).toBe(0);
		expect(await credits()).toEqual(['Ilka Rane', 'Kaske']);
	});

	it('never merges across ISRCs, and leaves a copy it cannot place with its length cleared', async () => {
		const app = await createTestApp();
		const { store, preview } = await seed(app);
		// Another ISRC on the Spotify copy: not this one. The compilation's copy is the one left.
		await app.db.query(`insert into curator.catalog_identifier (namespace, value, object_id) values ('isrc', 'GBXXX2600001', $1)`, [store]);
		const [comp] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'bandcamp' and provider_id = 'bct-drift'`);
		await app.db.query(`insert into curator.catalog_identifier (namespace, value, object_id) values ('isrc', 'GBXXX2600002', $1)`, [comp!.object_id]);
		// Both store copies carry other ISRCs: nothing to join.
		const r = await adminOps(app.db, {}).repairPreviews({ label: LABEL });
		expect(r).toMatchObject({ recordings: 1, lengthsCleared: 1, merged: [], unmatched: [{ title: 'Drift', id: preview, why: 'no store copy on the label' }] });
		const [p] = await app.db.query<{ duration_sec: unknown; merged_into: string | null }>(`select duration_sec, merged_into from curator.catalog_object where id = $1`, [preview]);
		expect(p).toEqual({ duration_sec: null, merged_into: null });
	});
});
