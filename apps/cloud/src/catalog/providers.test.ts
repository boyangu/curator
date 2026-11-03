// The provider adapters and the identity planner against fake HTTP: what each
// turns a provider's answers into, and how the planner links a watched artist
// to another provider only on evidence. No network.

import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createLogger } from '../log.js';
import { createTestApp } from '../test/harness.js';
import { ingestClaims } from './ingest.js';
import { DeezerFinder, runPlanner, SpotifyFinder } from './planner.js';
import { DeezerTracker } from './trackers/deezer.js';
import type { FetchLike } from './trackers/http.js';
import { SpotifyAppTracker } from './trackers/spotify-app.js';
import { runTrackers } from './trackers/sweep.js';
import { TrackerRateLimitedError } from './trackers/types.js';

const quiet = createLogger(() => {});
const today = new Date().toISOString().slice(0, 10);

function fakeFetch(routes: Record<string, unknown | ((url: URL) => unknown)>, calls: string[] = []): FetchLike {
	return async (input, init) => {
		const url = new URL(input);
		calls.push(`${init?.method ?? 'GET'} ${url.hostname}${url.pathname}`);
		const key = Object.keys(routes).find((k) => `${url.hostname}${url.pathname}`.endsWith(k));
		if (!key) return new Response(JSON.stringify({ error: { code: 800, message: 'no data' } }), { status: 200 });
		const r = routes[key];
		const body = typeof r === 'function' ? (r as (u: URL) => unknown)(url) : r;
		if (body instanceof Response) return body;
		return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
	};
}

const target = (kind: 'artist' | 'label', name: string, providerId: string | null, cursor: Record<string, unknown> = {}) => ({
	object: { id: '00000000-0000-4000-8000-000000000001', kind, name },
	representation: providerId ? { providerId, url: null } : null,
	cursor,
});

describe('DeezerTracker', () => {
	const routes = {
		'/artist/77/albums': { data: [{ id: 2, title: 'Older', release_date: '2025-01-01' }, { id: 1, title: 'Glass Rivers', release_date: today }] },
		'/album/1': {
			id: 1,
			title: 'Glass Rivers',
			upc: '0123456789012',
			label: 'Northfold Records',
			release_date: today,
			record_type: 'single',
			genres: { data: [{ name: 'Electro' }] },
			contributors: [{ id: 77, name: 'Northfold' }],
		},
		'/album/1/tracks': { data: [{ id: 11, title: 'Glass Rivers', isrc: 'GBAAA2600001', duration: 401, track_position: 1, artist: { id: 77, name: 'Northfold' } }] },
		'/album/2': { id: 2, title: 'Older', release_date: '2025-01-01', contributors: [{ id: 77, name: 'Northfold' }] },
		'/album/2/tracks': { data: [] },
	};

	it("reads an artist's albums newest first and expands each once, fully identified", async () => {
		const calls: string[] = [];
		const dz = new DeezerTracker(fakeFetch(routes, calls));
		const first = await dz.poll(target('artist', 'Northfold', '77'), AbortSignal.timeout(5000));
		// The old release comes from the listing alone; only the recent one is expanded.
		expect(first.children.map((c) => [c.name, c.recordings?.length ?? 0])).toEqual([
			['Older', 0],
			['Glass Rivers', 1],
		]);
		expect(calls.filter((c) => c.includes('/album/2'))).toEqual([]);
		const rel = first.children[1]!;
		expect(rel.identifiers).toEqual([{ namespace: 'upc', value: '0123456789012' }]);
		expect(rel.facts).toMatchObject({ releaseDate: today, labelText: 'Northfold Records', releaseType: 'single' });
		expect(rel.recordings![0]).toMatchObject({ providerId: '11', identifiers: [{ namespace: 'isrc', value: 'GBAAA2600001' }], facts: { durationSec: 401 } });
		expect(rel.genres).toEqual(['Electro']);
		// Second poll: same listing, nothing expanded again, same hash.
		calls.length = 0;
		const second = await dz.poll(target('artist', 'Northfold', '77', first.cursor), AbortSignal.timeout(5000));
		expect(second.children).toEqual([]);
		expect(second.listingHash).toBe(first.listingHash);
		expect(calls).toEqual(['GET api.deezer.com/artist/77/albums']);
	});

	it("keeps a label search's hit only when the album's own label is the watched one", async () => {
		const dz = new DeezerTracker(
			fakeFetch({
				...routes,
				'/search/album': { data: [{ id: 1, title: 'Glass Rivers' }, { id: 3, title: 'Loose Match' }] },
				'/album/3': { id: 3, title: 'Loose Match', label: 'Northfold Recordings Ltd', release_date: today },
				'/album/3/tracks': { data: [] },
			}),
		);
		const r = await dz.poll(target('label', 'Northfold Records', null), AbortSignal.timeout(5000));
		expect(r.children.map((c) => c.name)).toEqual(['Glass Rivers']);
	});

	it("turns Deezer's quota answer into a rate limit", async () => {
		const dz = new DeezerTracker(fakeFetch({ '/artist/77/albums': { error: { code: 4, message: 'Quota limit exceeded' } } }));
		await expect(dz.poll(target('artist', 'Northfold', '77'), AbortSignal.timeout(5000))).rejects.toBeInstanceOf(TrackerRateLimitedError);
	});
});

describe('SpotifyAppTracker', () => {
	it('authenticates once with app credentials and reads UPCs from the full album', async () => {
		const calls: string[] = [];
		const sp = new SpotifyAppTracker(
			{ clientId: 'id', clientSecret: 'secret' },
			fakeFetch(
				{
					'/api/token': { access_token: 'app-token', expires_in: 3600 },
					'/artists/sa1/albums': { items: [{ id: 'al1', name: 'Glass Rivers', release_date: today }] },
					'/albums/al1': {
						id: 'al1',
						name: 'Glass Rivers',
						album_type: 'single',
						release_date: today,
						external_ids: { upc: '0123456789012' },
						artists: [{ id: 'sa1', name: 'Northfold' }],
						tracks: { items: [{ id: 'st1', name: 'Glass Rivers', duration_ms: 401000, track_number: 1, artists: [{ id: 'sa1', name: 'Northfold' }] }] },
					},
				},
				calls,
			),
		);
		const r = await sp.poll(target('artist', 'Northfold', 'sa1'), AbortSignal.timeout(5000));
		await sp.poll(target('artist', 'Northfold', 'sa1', r.cursor), AbortSignal.timeout(5000));
		expect(calls.filter((c) => c.includes('/api/token'))).toHaveLength(1);
		expect(r.children[0]).toMatchObject({ identifiers: [{ namespace: 'upc', value: '0123456789012' }], facts: { releaseType: 'single' } });
		expect(r.children[0]!.recordings![0]).toMatchObject({ providerId: 'st1', facts: { durationSec: 401 } });
	});

	it("parks on Spotify's 429 with its Retry-After", async () => {
		const sp = new SpotifyAppTracker(
			{ clientId: 'id', clientSecret: 'secret' },
			fakeFetch({ '/api/token': { access_token: 't', expires_in: 3600 }, '/artists/sa1/albums': new Response('', { status: 429, headers: { 'retry-after': '120' } }) }),
		);
		const err = await sp.poll(target('artist', 'Northfold', 'sa1'), AbortSignal.timeout(5000)).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TrackerRateLimitedError);
		expect((err as TrackerRateLimitedError).retryAfterSec).toBe(120);
	});
});

describe('identity planner', () => {
	async function watchedSpotifyArtist() {
		const app = await createTestApp();
		const fan = await app.signIn();
		const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: { provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'Northfold' }, source: 'manual' });
		return { app, fan, objectId: w.watch.object.id };
	}

	const deezerRoutes = (albumsOf: Record<string, string[]>) => ({
		'/search/artist': { data: [{ id: 77, name: 'Northfold' }, { id: 78, name: 'NorthFold' }, { id: 79, name: 'Northfold Collective' }] },
		...Object.fromEntries(Object.entries(albumsOf).map(([id, titles]) => [`/artist/${id}/albums`, { data: titles.map((t, i) => ({ id: i, title: t })) }])),
	});

	it('waits for known releases rather than linking a name', async () => {
		const { app } = await watchedSpotifyArtist();
		const r = await runPlanner({ db: app.db, log: quiet, finders: [new DeezerFinder(fakeFetch(deezerRoutes({ 77: ['Glass Rivers'] })))] });
		expect(r).toEqual({ attempted: 1, linked: 0 });
		const [task] = await app.db.query<{ last_error: string }>(`select last_error from curator.catalog_enrich_task where need = 'representation'`);
		expect(task!.last_error).toBe('no_known_releases');
	});

	it('links the one namesake whose releases overlap, and its tracker starts', async () => {
		const { app, fan, objectId } = await watchedSpotifyArtist();
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[{ provider: 'spotify', kind: 'release', providerId: 'al1', name: 'Glass Rivers', facts: { releaseDate: today }, artists: [{ provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'Northfold' }] }],
				{ reason: 'tracker' },
			),
		);
		const r = await runPlanner({ db: app.db, log: quiet, finders: [new DeezerFinder(fakeFetch(deezerRoutes({ 77: ['Glass Rivers'], 78: ['Something Else'] })))] });
		expect(r).toEqual({ attempted: 1, linked: 1 });
		const [w] = await fan.api.catalog.listWatches.query({ deviceId: fan.deviceId });
		expect(w!.object.id).toBe(objectId);
		expect(w!.object.handles.map((h) => `${h.provider}:${h.id}`).sort()).toEqual(['deezer:77', 'spotify:sa1']);
		expect(w!.tracking.map((t) => t.provider)).toEqual(['deezer', 'spotify']);
	});

	it('refuses an ambiguous pair of overlapping namesakes', async () => {
		const { app } = await watchedSpotifyArtist();
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[{ provider: 'spotify', kind: 'release', providerId: 'al1', name: 'Glass Rivers', facts: { releaseDate: today }, artists: [{ provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'Northfold' }] }],
				{ reason: 'tracker' },
			),
		);
		const r = await runPlanner({ db: app.db, log: quiet, finders: [new DeezerFinder(fakeFetch(deezerRoutes({ 77: ['Glass Rivers'], 78: ['Glass Rivers'] })))] });
		expect(r.linked).toBe(0);
	});

	it('links a Deezer-registered artist to Spotify the same way', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: { provider: 'deezer', kind: 'artist', providerId: '77', name: 'Northfold' }, source: 'manual' });
		const dz = new DeezerTracker(
			fakeFetch({
				'/artist/77/albums': { data: [{ id: 1, title: 'Glass Rivers', release_date: today }] },
				'/album/1': { id: 1, title: 'Glass Rivers', release_date: today, contributors: [{ id: 77, name: 'Northfold' }] },
				'/album/1/tracks': { data: [] },
			}),
		);
		await runTrackers({ db: app.db, log: quiet, adapters: [dz], holder: 'test', sleep: async () => {} });
		const spotify = new SpotifyAppTracker(
			{ clientId: 'id', clientSecret: 'secret' },
			fakeFetch({
				'/api/token': { access_token: 't', expires_in: 3600 },
				'/search': { artists: { items: [{ id: 'sa1', name: 'Northfold' }] } },
				'/artists/sa1/albums': { items: [{ name: 'Glass Rivers' }] },
			}),
		);
		expect(await runPlanner({ db: app.db, log: quiet, finders: [new SpotifyFinder(spotify)] })).toEqual({ attempted: 1, linked: 1 });
	});
});
