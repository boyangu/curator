// The store linker's pass: a release with a UPC gets its Tidal and Apple
// pages (and its tracks theirs), a store without it is asked again later,
// not daily, and a track reaches Tidal by ISRC when no album lookup did.

import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createLogger } from '../log.js';
import { createTestApp } from '../test/harness.js';
import { ingestClaims } from './ingest.js';
import { runStoreLinker } from './store-links.js';
import { AppleLookup } from './trackers/apple.js';
import type { FetchLike } from './trackers/http.js';
import { TidalApp } from './trackers/tidal-app.js';

const quiet = createLogger(() => {});
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

const tidalAlbum = {
	data: [{ id: '900', type: 'albums', attributes: { title: 'Low Tide EP', barcodeId: '123456789012', externalLinks: [{ href: 'https://tidal.com/browse/album/900' }] }, relationships: { items: { data: [{ id: '901', type: 'tracks', meta: { trackNumber: 1 } }] }, artists: { data: [] } } }],
	included: [{ id: '901', type: 'tracks', attributes: { title: 'Low Tide', isrc: 'GBNFR2600001', duration: 'PT5M1S', externalLinks: [{ href: 'https://tidal.com/browse/track/901' }] } }],
};
const tidalTrack = { data: [{ id: '955', type: 'tracks', attributes: { title: 'Lone Upload', isrc: 'GBNFR2600009', duration: 'PT4M0S', externalLinks: [{ href: 'https://tidal.com/browse/track/955' }] } }], included: [] };

function fakeFetch(calls: string[]): FetchLike {
	return async (u) => {
		const url = String(u);
		calls.push(url);
		if (url.includes('auth.tidal.com')) return json({ access_token: 'tt', expires_in: 3600 });
		if (url.includes('/v2/albums')) return json(url.includes('123456789012') ? tidalAlbum : { data: [] });
		if (url.includes('/v2/tracks')) return json(url.includes('GBNFR2600009') ? tidalTrack : { data: [] });
		if (url.includes('itunes.apple.com')) return json({ results: [] });
		return json({});
	};
}

describe('store linker', () => {
	it('links a release and its track by UPC, records a miss with a long retry, and reaches a lone track by ISRC', async () => {
		const app = await createTestApp();
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					{
						provider: 'deezer',
						kind: 'release',
						providerId: '1',
						name: 'Low Tide EP',
						identifiers: [{ namespace: 'upc', value: '123456789012' }],
						artists: [{ provider: 'deezer', kind: 'artist', providerId: '7', name: 'Glass Rivers' }],
						recordings: [{ provider: 'deezer', kind: 'recording', providerId: '11', name: 'Low Tide', identifiers: [{ namespace: 'isrc', value: 'GBNFR2600001' }], facts: { durationSec: 301, trackNumber: 1 } }],
					},
					// A SoundCloud upload with an ISRC and no release: only ISRC can reach it.
					{ provider: 'soundcloud', kind: 'recording', providerId: 'sc9', name: 'Lone Upload', identifiers: [{ namespace: 'isrc', value: 'GBNFR2600009' }], facts: { durationSec: 240 } },
				],
				{ reason: 'tracker' },
			),
		);
		const calls: string[] = [];
		const fetchFn = fakeFetch(calls);
		const readers = { tidal: new TidalApp({ clientId: 't', clientSecret: 's' }, fetchFn), apple: new AppleLookup(fetchFn) };
		const first = await runStoreLinker({ db: app.db, log: quiet, readers });
		// Two tracks by ISRC: the lone upload, and Low Tide on Apple, whose album lookup missed.
		expect(first).toMatchObject({ releases: 1, linked: { tidal: 1 }, recordings: 2, recordingsLinked: 1, parked: [] });

		const [rel] = await app.db.query<{ id: string }>(`select object_id as id from curator.catalog_source_object where provider = 'deezer' and kind = 'release'`);
		const pages = await app.db.query<{ provider: string; url: string | null }>(`select provider, url from curator.catalog_source_object where object_id = $1 order by provider`, [rel!.id]);
		expect(pages).toEqual([
			{ provider: 'deezer', url: null },
			{ provider: 'tidal', url: 'https://tidal.com/browse/album/900' },
		]);
		const track = await app.db.query<{ provider: string }>(`select so.provider from curator.catalog_source_object so join curator.catalog_identifier i on i.object_id = so.object_id and i.value = 'GBNFR2600001' order by so.provider`);
		expect(track.map((t) => t.provider)).toEqual(['deezer', 'tidal']);
		const lone = await app.db.query<{ provider: string }>(`select so.provider from curator.catalog_source_object so join curator.catalog_identifier i on i.object_id = so.object_id and i.value = 'GBNFR2600009' order by so.provider`);
		expect(lone.map((t) => t.provider)).toEqual(['soundcloud', 'tidal']);
		// Apple had none of them: asked again in a month, not tomorrow.
		const tasks = await app.db.query<{ provider: string; days: unknown; attempts: unknown }>(
			`select provider, round(extract(epoch from next_due_at - now()) / 86400) as days, attempts from curator.catalog_enrich_task where need = 'representation' and provider in ('apple', 'tidal') order by provider`,
		);
		expect(tasks.map((t) => `${t.provider}:${Number(t.days)}:${Number(t.attempts)}`)).toEqual(['apple:30:1', 'apple:30:1', 'apple:30:1']);

		// Nothing is due now: a second pass makes no calls.
		calls.length = 0;
		const second = await runStoreLinker({ db: app.db, log: quiet, readers });
		expect(second).toMatchObject({ releases: 0, recordings: 0 });
		expect(calls.filter((c) => !c.includes('auth.tidal.com'))).toEqual([]);
	});
});
