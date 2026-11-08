// Bandcamp through its app JSON (fake, made-up names): a label's discography
// with the recent releases expanded, its roster as label-artist edges, and a
// roster name matched to a known artist only through the label's releases.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSqlDir } from '../db/migrate.js';
import { withSystemTx } from '../db/system-tx.js';
import { createLogger } from '../log.js';
import { createTestApp } from '../test/harness.js';
import { ingestClaims } from './ingest.js';
import { BandcampTracker } from '@curator/catalog-readers';
import type { FetchLike } from '@curator/catalog-readers';
import { runTrackers } from './trackers/sweep.js';

const quiet = createLogger(() => {});
const DAY = 86400_000;
// Bandcamp's listing dates read "13 Nov 2026 00:00:00 GMT".
const bcDate = (ms: number) => new Date(ms).toUTCString().replace(/^\w+, /, '').replace(/\d\d:\d\d:\d\d GMT$/, '00:00:00 GMT');

function fakeBandcamp(state: { items: { item_id: number; title: string; artist_name: string; band_id: number; ageDays: number }[] }): { fetch: FetchLike; calls: string[] } {
	const calls: string[] = [];
	const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
	const fetch: FetchLike = async (input) => {
		const u = new URL(input);
		calls.push(u.pathname);
		if (u.pathname.endsWith('/band_details')) {
			return json({
				id: 2140572776,
				name: 'Northfold Records',
				bandcamp_url: 'https://northfold.bandcamp.com',
				artists: [{ id: 77, name: 'Northfold' }, { id: 79, name: 'Lumen Vale' }],
				discography: state.items.map((i) => ({ item_id: i.item_id, item_type: 'album', title: i.title, artist_name: i.artist_name, band_name: i.artist_name, band_id: i.band_id, art_id: 1, release_date: bcDate(Date.now() - i.ageDays * DAY) })),
			});
		}
		if (u.pathname.endsWith('/tralbum_details')) {
			const id = Number(u.searchParams.get('tralbum_id'));
			const i = state.items.find((x) => x.item_id === id)!;
			return json({ id, type: 'a', title: i.title, bandcamp_url: `https://x.bandcamp.com/album/${id}`, art_id: 2, band: { band_id: i.band_id, name: i.artist_name }, tralbum_artist: i.artist_name, release_date: Math.floor((Date.now() - i.ageDays * DAY) / 1000), label: 'Northfold Records', tracks: [{ track_id: id * 10 + 1, title: `${i.title} (Original Mix)`, track_num: 1, duration: 401.2 }, { track_id: id * 10 + 2, title: `${i.title} (Dub)`, track_num: 2, duration: 380 }] });
		}
		return new Response('not found', { status: 404 });
	};
	return { fetch, calls };
}

describe('BandcampTracker credits', () => {
	it("credits a release on the label's own account by its text, never by the label's id; one on an artist's account by that account", async () => {
		const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
		const old = bcDate(Date.now() - 400 * DAY);
		const fetch: FetchLike = async (input) => {
			const u = new URL(input);
			if (u.pathname.endsWith('/band_details')) {
				return json({
					id: 2140572776,
					name: 'Northfold Records',
					artists: [],
					discography: [
						{ item_id: 1, item_type: 'album', title: 'Glass Rivers', artist_name: 'Ilka Rane, Lumen Vale', band_name: 'Northfold Records', band_id: 2140572776, release_date: old },
						{ item_id: 2, item_type: 'album', title: 'Drift', artist_name: 'Kaske', band_name: 'Northfold Records', band_id: 2140572776, release_date: old },
						{ item_id: 3, item_type: 'album', title: 'Tide', artist_name: 'Northfold', band_name: 'Northfold', band_id: 77, release_date: old },
					],
				});
			}
			return new Response('not found', { status: 404 });
		};
		const r = await new BandcampTracker(fetch).poll({ object: { id: 'x', kind: 'label', name: 'Northfold Records' }, representation: { providerId: '2140572776', url: null }, cursor: {} }, AbortSignal.timeout(5000));
		expect(r.children.map((c) => [c.name, c.artists!.map((a) => `${a.providerId}=${a.name}`)])).toEqual([
			['Glass Rivers', ['2140572776/ilka rane=Ilka Rane', '2140572776/lumen vale=Lumen Vale']],
			['Drift', ['2140572776/kaske=Kaske']],
			['Tide', ['77=Northfold']],
		]);
	});
});

describe('migration 0018', () => {
	it("removes the credits the label's own id made, keeps the rest, and queues the discography again", async () => {
		const app = await createTestApp();
		const label = { provider: 'bandcamp' as const, kind: 'label' as const, providerId: '2140572776', name: 'Northfold Records' };
		// What the old tracker wrote: two label-hosted releases by different
		// artists, both credited through the label's id; one also on Spotify.
		const bad = (name: string) => ({ provider: 'bandcamp' as const, kind: 'artist' as const, providerId: '2140572776', name });
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					label,
					{ provider: 'bandcamp', kind: 'release', providerId: '1', name: 'Glass Rivers', facts: { releaseDate: '2025-01-01' }, artists: [bad('Ilka Rane')], label },
					{ provider: 'bandcamp', kind: 'release', providerId: '2', name: 'Drift', facts: { releaseDate: '2025-02-01' }, artists: [bad('Kaske')], label },
					{ provider: 'spotify', kind: 'release', providerId: 'al2', name: 'Drift', facts: { releaseDate: '2025-02-01' }, artists: [{ provider: 'spotify', kind: 'artist', providerId: 'sk', name: 'Kaske' }] },
				],
				{ reason: 'library_import' },
			),
		);
		const credits = () =>
			app.db.query<{ release: string; artist: string }>(
				`select r.name as release, a.name as artist from curator.catalog_edge e join curator.catalog_object r on r.id = e.dst join curator.catalog_object a on a.id = e.src
				where e.kind = 'artist-release' order by r.name, a.name`,
			);
		// The bug: "Drift" credited to Ilka Rane (first seen), beside Spotify's Kaske.
		expect(await credits()).toEqual([
			{ release: 'Drift', artist: 'Ilka Rane' },
			{ release: 'Drift', artist: 'Kaske' },
			{ release: 'Glass Rivers', artist: 'Ilka Rane' },
		]);
		await app.pg.exec(readFileSync(join(findSqlDir(), '0018_catalog_bandcamp_credits.sql'), 'utf8'));
		// Bandcamp's mis-credits are gone; Spotify's Kaske stays; the re-read is queued.
		expect(await credits()).toEqual([{ release: 'Drift', artist: 'Kaske' }]);
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'bandcamp' and kind = 'artist'`)).toEqual([]);
		expect(await app.db.query(`select 1 from curator.catalog_enrich_task where need = 'backfill' and provider = 'bandcamp'`)).toHaveLength(1);
	});
});

describe('BandcampTracker', () => {
	it('expands recent releases with their tracks, lists old ones shallow, and carries the roster on the label', async () => {
		const { fetch, calls } = fakeBandcamp({ items: [{ item_id: 1, title: 'Glass Rivers', artist_name: 'Northfold', band_id: 77, ageDays: 3 }, { item_id: 2, title: 'Old Album', artist_name: 'Lumen Vale', band_id: 79, ageDays: 400 }] });
		const bp = new BandcampTracker(fetch);
		const target = { object: { id: '00000000-0000-4000-8000-000000000001', kind: 'label' as const, name: 'Northfold Records' }, representation: { providerId: '2140572776', url: 'https://northfold.bandcamp.com' }, cursor: {} };
		const r = await bp.poll(target, AbortSignal.timeout(5000));
		expect(calls).toEqual(['/api/mobile/24/band_details', '/api/mobile/24/tralbum_details']);
		expect(r.self).toMatchObject({ kind: 'label', providerId: '2140572776', name: 'Northfold Records' });
		expect(r.self!.artists!.map((a) => [a.providerId, a.name])).toEqual([['77', 'Northfold'], ['79', 'Lumen Vale']]);
		const [old, fresh] = r.children;
		expect(old).toMatchObject({ providerId: '2', name: 'Old Album', artists: [{ providerId: '79', name: 'Lumen Vale' }], label: { providerId: '2140572776' } });
		expect(old!.recordings).toBeUndefined();
		expect(fresh).toMatchObject({ providerId: '1', name: 'Glass Rivers', url: 'https://x.bandcamp.com/album/1', facts: { releaseType: 'album', trackCount: 2 } });
		expect(fresh!.recordings!.map((t) => [t.name, t.facts?.durationSec, t.facts?.trackNumber])).toEqual([['Glass Rivers (Original Mix)', 401, 1], ['Glass Rivers (Dub)', 380, 2]]);
		const again = await bp.poll({ ...target, cursor: r.cursor }, AbortSignal.timeout(5000));
		expect(again.children).toEqual([]);
		expect(again.listingHash).toBe(r.listingHash);
	});

	it("a watched label's roster becomes label-artist edges; a roster name joins a known artist only through the label's releases", async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		// Northfold is known from Spotify, credited on one of the label's Beatport releases; Lumen Vale is not.
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					{ provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'Northfold' },
					{ provider: 'spotify', kind: 'artist', providerId: 'sa9', name: 'Lumen Vale' },
					{
						provider: 'beatport',
						kind: 'release',
						providerId: '500',
						name: 'Earlier',
						facts: { releaseDate: '2025-01-01' },
						artists: [{ provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'Northfold' }],
						label: { provider: 'bandcamp', kind: 'label', providerId: '2140572776', name: 'Northfold Records', url: 'https://northfold.bandcamp.com' },
					},
				],
				{ reason: 'library_import' },
			),
		);
		const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: { provider: 'bandcamp', kind: 'label', providerId: '2140572776', name: 'Northfold Records' }, source: 'manual' });
		const { fetch } = fakeBandcamp({ items: [{ item_id: 1, title: 'Glass Rivers', artist_name: 'Northfold', band_id: 77, ageDays: 3 }] });
		const [pass] = (await runTrackers({ db: app.db, log: quiet, adapters: [new BandcampTracker(fetch)], holder: 'test', sleep: async () => {} })).filter((p) => p.provider === 'bandcamp');
		expect(pass).toMatchObject({ polled: 1, events: 1 });
		const roster = await app.db.query<{ name: string; reps: string }>(
			`select a.name, string_agg(so.provider || ':' || so.provider_id, ',' order by so.provider) as reps
			from curator.catalog_edge e join curator.catalog_object a on a.id = e.dst
			left join curator.catalog_source_object so on so.object_id = a.id
			where e.src = $1 and e.kind = 'label-artist' group by a.id, a.name, e.position order by e.position`,
			[w.watch.object.id],
		);
		expect(roster).toEqual([
			{ name: 'Northfold', reps: 'bandcamp:77,spotify:sa1' },
			{ name: 'Lumen Vale', reps: 'bandcamp:79' },
		]);
		const [artists] = await app.db.query<{ n: unknown }>(`select count(*) as n from curator.catalog_object where kind = 'artist'`);
		expect(Number(artists!.n)).toBe(3);
	});
});
