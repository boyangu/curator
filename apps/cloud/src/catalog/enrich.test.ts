// A device's library labels enriched in the shared catalogue without a
// watch: registered by name, profiled, their releases read once by the
// providers that list them (backfill) — and no event raised for any of it.

import { describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { createTestApp } from '../test/harness.js';
import { runLabelProfiler } from './profile/label-profiler.js';
import { runBackfill } from './trackers/backfill.js';
import type { FetchLike } from './trackers/http.js';
import { BeatportTracker } from './trackers/beatport.js';

const quiet = createLogger(() => {});
const today = new Date().toISOString().slice(0, 10);

// The world answers nothing but Beatport's label search and label pages.
function fakeWorld(): FetchLike {
	const html = (b: string) => new Response(b, { status: 200, headers: { 'content-type': 'text/html' } });
	const next = (queries: unknown[]) => html(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { dehydratedState: { queries } } } })}</script>`);
	const label = { id: 804, name: 'Northfold Records', slug: 'northfold-records' };
	return async (input) => {
		const u = new URL(input);
		if (u.hostname === 'www.beatport.com' && u.pathname === '/search/labels') return next([{ queryKey: ['search-labels', {}], state: { data: { data: [{ label_id: 804, label_name: 'Northfold Records' }] } } }]);
		if (u.hostname === 'www.beatport.com' && u.pathname === '/label/label/804/releases') {
			return next([
				{ queryKey: ['label-804'], state: { data: label } },
				{ queryKey: ['releases-label_id=804&per_page=21&order_by=-release_date'], state: { data: { results: [{ id: 1, name: 'Glass Rivers', slug: 'glass-rivers', upc: '0123456789012', artists: [{ id: 77, name: 'Northfold' }], label, new_release_date: today, track_count: 1 }], next: null } } },
			]);
		}
		if (u.hostname === 'www.beatport.com' && u.pathname === '/release/glass-rivers/1') {
			return next([
				{ queryKey: ['release-1'], state: { data: { id: 1, name: 'Glass Rivers', slug: 'glass-rivers', upc: '0123456789012', artists: [{ id: 77, name: 'Northfold' }], label, new_release_date: today } } },
				{ queryKey: ['tracks', { release_id: 1 }], state: { data: { results: [{ id: 11, name: 'Glass Rivers', mix_name: 'Original Mix', isrc: 'GBAAA2600001', length_ms: 401_000, number: 1, artists: [{ id: 77, name: 'Northfold' }], genre: { id: 90, name: 'Melodic House & Techno' }, bpm: 124, key: { name: 'A Minor' }, release: { id: 1, name: 'Glass Rivers' } }] } } },
			]);
		}
		if (u.hostname === 'musicbrainz.org') return new Response(JSON.stringify({ labels: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
		if (u.hostname === 'api.discogs.com') return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
		return new Response('not found', { status: 404 });
	};
}

describe('catalog.enrich', () => {
	it('profiles and backfills a library label nobody watches, raising nothing', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const r = await fan.api.catalog.ingest.mutate({
			deviceId: fan.deviceId,
			reason: 'library_import',
			idempotencyKey: 'enrich-batch-1',
			claims: [{ provider: 'user', kind: 'label', providerId: 'name:northfold records', name: 'Northfold Records' }, { provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'Northfold' }],
		});
		const ids = r.results.map((x) => ('objectId' in x ? x.objectId : '')).filter(Boolean);
		// Only the label is queued; the artist is ignored.
		expect(await fan.api.catalog.enrich.mutate({ deviceId: fan.deviceId, objectIds: ids })).toEqual({ queued: 1 });
		expect(await fan.api.catalog.enrich.mutate({ deviceId: fan.deviceId, objectIds: ids })).toEqual({ queued: 0 });

		const fetch = fakeWorld();
		expect(await runLabelProfiler({ db: app.db, log: quiet, fetch, spotify: null, providers: { beatport: true, bandcamp: false }, sleep: async () => {} })).toEqual({ attempted: 1, attached: 1 });
		// No watcher: no cursor; a backfill task per provider that can list it.
		expect(await app.db.query(`select 1 from curator.catalog_cursor`)).toEqual([]);
		const tasks = await app.db.query<{ provider: string }>(`select provider from curator.catalog_enrich_task where need = 'backfill' order by provider`);
		expect(tasks.map((t) => t.provider)).toEqual(['beatport', 'deezer']);

		const b = await runBackfill({ db: app.db, log: quiet, adapters: [new BeatportTracker(fetch)], holder: 'test', sleep: async () => {} });
		expect(b).toEqual({ attempted: 1, done: 1, claims: 1 });
		// The release, its track and the label edge are in the catalogue; no event, no Deezer task touched.
		const [rel] = await app.db.query<{ name: string; n: unknown }>(
			`select o.name, (select count(*) from curator.catalog_edge e where e.src = o.id and e.kind in ('release-recording', 'release-label')) as n
			from curator.catalog_object o where o.kind = 'release'`,
		);
		expect({ ...rel, n: Number(rel!.n) }).toEqual({ name: 'Glass Rivers', n: 2 });
		expect(await app.db.query(`select 1 from curator.catalog_identifier where namespace = 'isrc' and value = 'GBAAA2600001'`)).toHaveLength(1);
		expect(await app.db.query(`select 1 from curator.catalog_event`)).toEqual([]);
		expect((await app.db.query<{ provider: string }>(`select provider from curator.catalog_enrich_task where need = 'backfill'`)).map((t) => t.provider)).toEqual(['deezer']);
	});
});
