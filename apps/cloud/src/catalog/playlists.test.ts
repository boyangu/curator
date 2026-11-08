// Spotify playlists tracked by the catalogue with a watcher's own login: the
// gateway's stored grant (fake Spotify accounts) and a fake Spotify API.

import { describe, expect, it } from 'vitest';
import type { CatalogEventTrackCardV1 } from '@curator/protocol';
import { createLogger } from '../log.js';
import { connectLocal } from '../spotify/gateway.js';
import { createTestApp, type TestApp } from '../test/harness.js';
import type { FetchLike } from '@curator/catalog-readers';
import { SpotifyUserPlaylistTracker } from '@curator/catalog-readers';
import { runTrackers } from './trackers/sweep.js';

import { gatewayPlaylistToken } from './spotify-app-token.js';
const quiet = createLogger(() => {});
const VERIFIER = 'pkce-verifier-'.padEnd(64, 'x');
const REDIRECT = 'http://127.0.0.1:43821/spotify/callback';
const DAY = 86400_000;

type Entry = { id: string; name: string; addedDaysAgo: number };

function fakeApi(state: { snapshot: string; entries: Entry[] }): { fetch: FetchLike; calls: string[] } {
	const calls: string[] = [];
	const fetch: FetchLike = async (input) => {
		const u = new URL(input);
		calls.push(u.pathname);
		const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
		if (u.pathname === '/v1/playlists/pl1') return json({ snapshot_id: state.snapshot, name: 'Deep Picks', images: [{ url: 'https://img.test/p.jpg' }] });
		if (u.pathname === '/v1/playlists/pl1/items')
			return json({
				items: state.entries.map((e) => ({
					added_at: new Date(Date.now() - e.addedDaysAgo * DAY).toISOString(),
					is_local: false,
					item: {
						id: e.id,
						name: e.name,
						type: 'track',
						duration_ms: 400_000,
						external_ids: { isrc: `GBAAA26${e.id.padStart(5, '0')}` },
						artists: [{ id: 'sa1', name: 'Northfold' }],
						album: { name: `${e.name} EP`, release_date: '2026-10-01', images: [{ url: 'https://img.test/a.jpg' }] },
					},
				})),
				next: null,
				total: state.entries.length,
			});
		return new Response('{}', { status: 404 });
	};
	return { fetch, calls };
}

async function setup(connectSpotify = true) {
	const app = await createTestApp();
	const fan = await app.signIn();
	if (connectSpotify) {
		const code = app.spotify!.authorize(VERIFIER, REDIRECT);
		await fan.api.spotify.connect.mutate({ deviceId: fan.deviceId, code, codeVerifier: VERIFIER, redirectUri: REDIRECT });
	}
	const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: { provider: 'spotify', kind: 'playlist', providerId: 'pl1', name: 'Deep Picks' }, source: 'imported' });
	return { app, fan, playlistId: w.watch.object.id };
}

const tracker = (app: TestApp, fetch: FetchLike) => new SpotifyUserPlaylistTracker({ token: gatewayPlaylistToken({ db: app.db, log: quiet, gateway: app.deps.spotify! }) }, fetch);
const run = (app: TestApp, fetch: FetchLike) => runTrackers({ db: app.db, log: quiet, adapters: [tracker(app, fetch)], holder: 'test', sleep: async () => {} });
const settle = (app: TestApp) => app.pg.query(`update curator.catalog_event set first_seen_at = first_seen_at - interval '5 minutes'`);
const due = (app: TestApp) => app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 minute'`);

describe('Spotify playlists in the catalogue', () => {
	it("announces the last two weeks' additions, then each new one once, as track cards", async () => {
		const { app, fan, playlistId } = await setup();
		const state = { snapshot: 's1', entries: [{ id: '1', name: 'Old Add', addedDaysAgo: 60 }, { id: '2', name: 'Fresh Add', addedDaysAgo: 2 }] };
		const api = fakeApi(state);
		expect((await run(app, api.fetch))[0]).toMatchObject({ polled: 1, events: 1 });
		await settle(app);
		const first = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: 0 });
		const card = first.events[0]!.card as CatalogEventTrackCardV1;
		expect(first.events.map((e) => e.kind)).toEqual(['playlist_add']);
		expect(card).toMatchObject({ kind: 'track', title: 'Fresh Add', isrc: 'GBAAA2600002', albumTitle: 'Fresh Add EP', rank: null, container: { kind: 'playlist', id: playlistId, name: 'Deep Picks' } });
		expect(card.handles).toEqual([{ provider: 'spotify', id: '2', url: 'https://open.spotify.com/track/2' }]);
		expect(card.artists.map((a) => a.name)).toEqual(['Northfold']);

		// Same snapshot: one call, nothing read.
		api.calls.length = 0;
		await due(app);
		expect((await run(app, api.fetch))[0]).toMatchObject({ unchanged: 1, events: 0 });
		expect(api.calls).toEqual(['/v1/playlists/pl1']);

		// A new addition.
		state.snapshot = 's2';
		state.entries.push({ id: '3', name: 'Newest', addedDaysAgo: 0 });
		await due(app);
		expect((await run(app, api.fetch))[0]!.events).toBe(1);
		await settle(app);
		const more = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: first.nextSeq });
		expect(more.events.map((e) => (e.card as CatalogEventTrackCardV1).title)).toEqual(['Newest']);
		// Membership is kept for every addition the tracker saw.
		const [n] = await app.db.query<{ n: unknown }>(`select count(*) as n from curator.catalog_playlist_item where playlist_id = $1`, [playlistId]);
		expect(Number(n!.n)).toBe(2);
	});

	it('fails, and backs off, when no watcher has Spotify connected', async () => {
		const { app } = await setup(false);
		const [pass] = await run(app, fakeApi({ snapshot: 's1', entries: [] }).fetch);
		expect(pass).toMatchObject({ claimed: 1, failed: 1, events: 0 });
		const [cur] = await app.db.query<{ last_error: string }>(`select last_error from curator.catalog_cursor`);
		expect(cur!.last_error).toMatch(/no watcher/);
	});

	it('reads with a login the local catalogue keeps itself, connected with no device', async () => {
		const { app, fan } = await setup(false);
		const deps = { db: app.db, log: quiet, audit: () => {}, gateway: app.deps.spotify! };
		const status = await connectLocal(deps, fan.userId, { code: app.spotify!.authorize(VERIFIER, REDIRECT), codeVerifier: VERIFIER, redirectUri: REDIRECT });
		expect(status).toMatchObject({ connected: true, needsReconnect: false });
		const state = { snapshot: 's1', entries: [{ id: '2', name: 'Fresh Add', addedDaysAgo: 2 }] };
		const [pass] = await run(app, fakeApi(state).fetch);
		expect(pass).toMatchObject({ polled: 1, events: 1, failed: 0 });
	});
});
