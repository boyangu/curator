// One artist held twice under one name (made-up names): two copies credited
// on the same track merged, and two on the same release from stores that
// share none; two ids of one store on one release put to the operator and
// merged on approval; namesakes on different releases, placeholders and a
// pair ruled apart left alone. A dry run writes nothing; a second sweep finds nothing.

import { describe, expect, it } from 'vitest';
import type { CatalogClaim } from '@curator/protocol';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp, type TestApp } from '../test/harness.js';
import { adminOps } from './admin-ops.js';
import { notSame } from './admin.js';
import { decideInbox, listInbox, raise } from './inbox.js';
import { ingestClaims } from './ingest.js';

const artist = (provider: 'spotify' | 'beatport' | 'user', id: string, name: string): CatalogClaim =>
	({ provider, kind: 'artist', providerId: provider === 'user' ? `name:${id}` : id, name }) as CatalogClaim;
const release = (provider: 'spotify' | 'beatport', id: string, title: string, tracks: { id: string; name: string; by: CatalogClaim }[]): CatalogClaim => ({
	provider,
	kind: 'release',
	providerId: id,
	name: title,
	facts: { releaseDate: '2026-05-08' },
	artists: [...new Map(tracks.map((t) => [t.by.providerId, t.by])).values()],
	recordings: tracks.map((t, i) => ({ provider, kind: 'recording', providerId: t.id, name: t.name, facts: { durationSec: 200 + i * 7 }, artists: [t.by] })),
});

const idOf = async (app: TestApp, provider: string, kind: string, providerId: string) =>
	(await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = $1 and kind = $2 and provider_id = $3`, [provider, kind, providerId]))[0]!.object_id;
const edge = (app: TestApp, src: string, kind: string, dst: string) => app.db.query(`insert into curator.catalog_edge (src, kind, dst) values ($1, $2, $3) on conflict do nothing`, [src, kind, dst]);
const live = async (app: TestApp, name: string) => (await app.db.query(`select 1 from curator.catalog_object where kind = 'artist' and name = $1 and merged_into is null`, [name])).length;

describe('artist twins', () => {
	it('merges same-name copies on one track, proposes those on one release, leaves namesakes', async () => {
		const app = await createTestApp();
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					release('spotify', 'al-1', 'Tidal Lines', [{ id: 'tr-1', name: 'Tidal Lines', by: artist('spotify', 'sp-lowtide', 'Lowtide') }]),
					release('beatport', 'bp-9', 'Undertow', [{ id: 'bt-9', name: 'Undertow', by: artist('beatport', 'bp-lowtide', 'Lowtide') }]),
					release('spotify', 'al-2', 'Northfold 01', [
						{ id: 'tr-2', name: 'Glass', by: artist('spotify', 'sp-ben', 'Ben') },
						{ id: 'tr-3', name: 'Paper', by: artist('spotify', 'sp-ode', 'Tamsin Ode') },
					]),
					release('beatport', 'bp-8', 'Shoreline', [{ id: 'bt-8', name: 'Shoreline', by: artist('beatport', 'bp-ben', 'Ben') }]),
					release('spotify', 'al-3', 'Drift', [{ id: 'tr-4', name: 'Drift', by: artist('spotify', 'sp-kaske-a', 'Kaske') }]),
					release('beatport', 'bp-7', 'Low Sun', [{ id: 'bt-7', name: 'Low Sun', by: artist('beatport', 'bp-kaske-b', 'Kaske') }]),
					release('spotify', 'al-4', 'Sampler', [{ id: 'tr-5', name: 'Sampler', by: artist('spotify', 'sp-va-1', 'Various Artists') }]),
					release('beatport', 'bp-6', 'Sampler Two', [{ id: 'bt-6', name: 'Sampler Two', by: artist('beatport', 'bp-va-2', 'Various Artists') }]),
					release('spotify', 'al-6', 'Northfold 02', [
						{ id: 'tr-7', name: 'Ember', by: artist('spotify', 'sp-abel-a', 'Abel') },
						{ id: 'tr-8', name: 'Ash', by: artist('spotify', 'sp-ode', 'Tamsin Ode') },
					]),
					release('spotify', 'al-7', 'Cinder', [{ id: 'tr-9', name: 'Cinder', by: artist('spotify', 'sp-abel-b', 'Abel') }]),
					release('spotify', 'al-5', 'Halflight', [{ id: 'tr-6', name: 'Halflight', by: artist('spotify', 'sp-ilka-a', 'Ilka Rane') }]),
					release('beatport', 'bp-5', 'Halflight Dub', [{ id: 'bt-5', name: 'Halflight Dub', by: artist('beatport', 'bp-ilka-b', 'Ilka Rane') }]),
				],
				{ reason: 'library_import' },
			),
		);
		const a = (p: string, id: string) => idOf(app, p, 'artist', id);
		const rec = (p: string, id: string) => idOf(app, p, 'recording', id);
		expect(await live(app, 'Lowtide')).toBe(2);
		// Lowtide's two copies on one track; Ben's (Spotify's and Beatport's) on
		// one release, two tracks; Abel's two Spotify ids likewise; the
		// placeholder twice on a track; Ilka Rane twice on a track but ruled apart.
		await edge(app, await rec('spotify', 'tr-1'), 'recording-artist', await a('beatport', 'bp-lowtide'));
		await edge(app, await idOf(app, 'spotify', 'release', 'al-2'), 'release-recording', await rec('beatport', 'bt-8'));
		await edge(app, await idOf(app, 'spotify', 'release', 'al-6'), 'release-recording', await rec('spotify', 'tr-9'));
		await edge(app, await rec('spotify', 'tr-5'), 'recording-artist', await a('beatport', 'bp-va-2'));
		await edge(app, await rec('spotify', 'tr-6'), 'recording-artist', await a('beatport', 'bp-ilka-b'));
		const [ilkaA, ilkaB] = [await a('spotify', 'sp-ilka-a'), await a('beatport', 'bp-ilka-b')];
		await withSystemTx(app.db, (tx) => notSame(tx, ilkaA, ilkaB, 'guy', 'two people'));
		const ops = adminOps(app.db, {});

		const dry = await ops.repairArtistTwins({ dry: true });
		expect(dry.merged.map((m) => [m.name, m.folds.length, m.on])).toEqual([['Lowtide', 1, 'track'], ['Ben', 1, 'release']]);
		expect(dry.proposed.map((p) => [p.name, p.pairs])).toEqual([['Abel', 1]]);
		expect(await live(app, 'Lowtide')).toBe(2);

		const r = await ops.repairArtistTwins({});
		expect(r.merged).toMatchObject([{ name: 'Lowtide', folds: [expect.any(String)] }, { name: 'Ben' }]);
		for (const [name, n] of [['Lowtide', 1], ['Ben', 1], ['Abel', 2], ['Kaske', 2], ['Various Artists', 2], ['Ilka Rane', 2]] as const) expect(await live(app, name)).toBe(n);
		const items = await withSystemTx(app.db, (tx) => listInbox(tx, { status: 'open', kind: 'artist.twins', limit: 10 }));
		expect(items.rows).toHaveLength(1);
		expect(items.rows[0]!.evidence).toMatchObject({ pairs: [{ keep: { title: 'Abel', providers: ['spotify'] }, fold: { title: 'Abel', providers: ['spotify'] }, on: ['Northfold 02'] }] });
		// Asked once: a second sweep neither merges nor asks again.
		expect(await ops.repairArtistTwins({})).toMatchObject({ merged: [], proposed: [] });

		await withSystemTx(app.db, (tx) => decideInbox(tx, items.rows[0]!.id, { action: 'approve', by: 'guy', note: 'one Abel' }));
		expect(await live(app, 'Abel')).toBe(1);
	});

	it('two releases made one in the inbox join their same-name artists at once', async () => {
		const app = await createTestApp();
		// The same EP under two titles with the tracks named apart (the store's
		// extended mixes), so ingestion joined neither the releases nor the
		// tracks nor, through them, the artists; a second Spotify copy of Mara
		// on the Beatport one (a label-page profile) is a store's second id.
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					release('spotify', 'al-1', 'Saltmarsh EP', [{ id: 'tr-1', name: 'Saltmarsh', by: artist('spotify', 'sp-rook', 'Rook') }, { id: 'tr-2', name: 'Reed', by: artist('spotify', 'sp-mara-a', 'Mara') }]),
					release('beatport', 'bp-1', 'Saltmarsh', [{ id: 'bt-1', name: 'Saltmarsh (Extended Mix)', by: artist('beatport', 'bp-rook', 'Rook') }, { id: 'bt-2', name: 'Reed (Extended Mix)', by: artist('spotify', 'sp-mara-b', 'Mara') }]),
				],
				{ reason: 'library_import' },
			),
		);
		expect(await live(app, 'Rook')).toBe(2);
		const [keep, fold] = [await idOf(app, 'spotify', 'release', 'al-1'), await idOf(app, 'beatport', 'release', 'bp-1')];
		const item = await withSystemTx(app.db, (tx) =>
			raise(tx, { kind: 'release.twins', severity: 'approval', title: 'twins', subjects: [keep], evidence: { pairs: [{ keep: { id: keep }, fold: { id: fold } }] }, apply: { op: 'mergeReleases', args: { pairs: [{ keep, fold }] } }, actor: 'worker' }),
		);
		await withSystemTx(app.db, (tx) => decideInbox(tx, item!, { action: 'approve', by: 'guy' }));
		expect(await live(app, 'Rook')).toBe(1);
		expect(await live(app, 'Mara')).toBe(2);
		const asked = await withSystemTx(app.db, (tx) => listInbox(tx, { status: 'open', kind: 'artist.twins', limit: 10 }));
		expect(asked.rows.map((r) => r.title)).toEqual(['«Mara» held 2 times on one release, by one store under two ids']);
	});
});
