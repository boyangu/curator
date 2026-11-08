// A watched label's profile pass against fake lookups (MusicBrainz, Discogs,
// Beatport's search page, a homepage, Bandcamp, SoundCloud, Spotify), with
// made-up labels: which pages get attached, which do not, and what tracking
// follows.

import { describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { createTestApp, type TestApp } from '../test/harness.js';
import { classifyUrl, websiteLink } from './profile/links.js';
import { runLabelProfiler } from './profile/label-profiler.js';
import type { FetchLike } from '@curator/catalog-readers';
import { SpotifyTracker } from '@curator/catalog-readers';
import { appCredentialsToken } from './spotify-app-token.js';
const quiet = createLogger(() => {});

type World = {
	mb: { id: string; name: string }[];
	mbRels: { type: string; url: string }[];
	discogs: { id: number; title: string; type: string }[];
	discogsUrls: string[];
	beatport: { label_id: number; label_name: string }[];
	bandcampLabelId?: string;
	bandcampSites?: string[];
	homepage?: string;
	soundcloudId?: number;
	playlists?: { id: string; name: string; owner: string }[];
	// Beatport answering with Cloudflare's challenge page.
	beatportChallenge?: boolean;
};

function fakeWorld(w: World): { fetch: FetchLike; calls: string[] } {
	const calls: string[] = [];
	const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
	const html = (b: string) => new Response(b, { status: 200, headers: { 'content-type': 'text/html' } });
	const next = (queries: unknown[]) => html(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { dehydratedState: { queries } } } })}</script>`);
	const fetch: FetchLike = async (input) => {
		const u = new URL(input);
		calls.push(`${u.hostname}${u.pathname}`);
		if (u.hostname === 'musicbrainz.org' && u.pathname === '/ws/2/label') return json({ labels: w.mb.map((l) => ({ ...l, score: 100 })) });
		if (u.hostname === 'musicbrainz.org' && u.pathname.startsWith('/ws/2/label/')) return json({ relations: w.mbRels.map((r) => ({ type: r.type, url: { resource: r.url } })) });
		if (u.hostname === 'api.discogs.com' && u.pathname === '/database/search') return json({ results: w.discogs });
		if (u.hostname === 'api.discogs.com' && u.pathname.startsWith('/labels/')) return json({ urls: w.discogsUrls });
		if (u.hostname === 'www.beatport.com' && w.beatportChallenge) return new Response('<html><title>Just a moment...</title></html>', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
		if (u.hostname === 'www.beatport.com' && u.pathname === '/search/labels') return next([{ queryKey: ['search-labels', { q: u.searchParams.get('q') }], state: { data: { data: w.beatport } } }]);
		if (u.hostname.endsWith('.bandcamp.com') && u.pathname === '/music') return html(w.bandcampLabelId ? `<a href="https://x.bandcamp.com/album/y?label=${w.bandcampLabelId}&tab=music">y</a>` : '<html></html>');
		if (u.hostname === 'bandcamp.com' && u.pathname.endsWith('/band_details')) return json({ id: Number(w.bandcampLabelId), name: 'Northfold Records', sites: (w.bandcampSites ?? []).map((url) => ({ url, title: url })) });
		if (u.hostname === 'northfold.example') return html(w.homepage ?? '');
		if (u.hostname === 'soundcloud.com') return html(`<script>window.__sc_hydration = [{"hydratable":"user","data":{"id":${w.soundcloudId ?? 0},"username":"x"}}];</script>`);
		if (u.hostname === 'accounts.spotify.com') return json({ access_token: 'tok', expires_in: 3600 });
		if (u.hostname === 'api.spotify.com' && u.pathname === '/v1/search') return json({ playlists: { items: (w.playlists ?? []).map((p) => ({ id: p.id, name: p.name, owner: { display_name: p.owner }, images: [] })) } });
		return new Response('not found', { status: 404 });
	};
	return { fetch, calls };
}

const run = (app: TestApp, fetch: FetchLike, spotify = true) =>
	runLabelProfiler({ db: app.db, log: quiet, fetch, spotify: spotify ? new SpotifyTracker({ token: appCredentialsToken({ clientId: 'id', clientSecret: 's' }, fetch) }, fetch) : null, sleep: async () => {} });

const reps = async (app: TestApp, objectId: string) =>
	(await app.db.query<{ provider: string; provider_id: string }>(`select provider, provider_id from curator.catalog_source_object where object_id = $1 order by provider`, [objectId])).map((r) => `${r.provider}:${r.provider_id}`);

describe('page links', () => {
	it('tells a label\'s pages apart by URL', () => {
		expect(classifyUrl('https://www.beatport.com/label/northfold-records/804')).toEqual({ provider: 'beatport', kind: 'label', id: '804', url: 'https://www.beatport.com/label/northfold-records/804' });
		expect(classifyUrl('https://northfold.bandcamp.com/')).toMatchObject({ provider: 'bandcamp', id: 'northfold' });
		expect(classifyUrl('https://soundcloud.com/northfold-records')).toMatchObject({ provider: 'soundcloud', id: 'northfold-records' });
		expect(classifyUrl('https://www.instagram.com/northfold/')).toMatchObject({ provider: 'instagram', id: 'northfold' });
		expect(classifyUrl('https://www.youtube.com/channel/UCbDgBFAketcO26wz-pR6OKAx')).toMatchObject({ provider: 'youtube', id: 'UCbDgBFAketcO26wz-pR6OKAx' });
		expect(classifyUrl('https://www.youtube.com/@northfold')).toMatchObject({ provider: 'youtube', id: '@northfold' });
		expect(classifyUrl('https://open.spotify.com/playlist/37i9dQZF1DX2TRYkJECvfC')).toMatchObject({ provider: 'spotify', kind: 'playlist' });
		expect(classifyUrl('https://soundcloud.com/you/likes')).toBeNull();
		expect(classifyUrl('https://www.facebook.com/northfold')).toBeNull();
		expect(websiteLink('https://northfold.example/')).toMatchObject({ provider: 'website', id: 'northfold.example' });
		expect(websiteLink('https://www.facebook.com/northfold')).toBeNull();
	});
});

describe('label profiler', () => {
	it('attaches the pages the lists agree on, follows the homepage for the rest, and starts the trackers', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: { provider: 'user', kind: 'label', providerId: 'name:northfold records', name: 'Northfold Records' }, source: 'manual' });
		const labelId = w.watch.object.id;
		expect(w.watch.tracking.map((t) => t.provider)).toEqual(['deezer']);
		const { fetch, calls } = fakeWorld({
			mb: [{ id: '5b66608b-878d-4d7a-a96b-6da38356f6c8', name: 'Northfold Records' }, { id: '71c0430b-30f0-4280-83b1-91ec0faa54a0', name: 'Northfold Records Explorations' }],
			mbRels: [{ type: 'bandcamp', url: 'https://northfold.bandcamp.com/' }, { type: 'official homepage', url: 'https://northfold.example/' }, { type: 'youtube', url: 'https://www.youtube.com/channel/UCbDgBFAketcO26wz-pR6OKAx' }, { type: 'social network', url: 'https://www.facebook.com/northfold' }],
			// Discogs suffixes namesakes "(2)"; a sub-label with a longer name is no namesake.
			discogs: [{ id: 45909, title: 'Northfold Records', type: 'label' }, { id: 960020, title: 'Northfold Records Explorations (2)', type: 'label' }, { id: 1, title: 'Northfold Records', type: 'artist' }],
			discogsUrls: ['https://soundcloud.com/northfold-records'],
			beatport: [{ label_id: 804, label_name: 'Northfold Records' }],
			bandcampLabelId: '2140572776',
			bandcampSites: ['https://www.instagram.com/northfold/', 'https://northfold.example'],
			homepage: '<a href="https://www.traxsource.com/label/3089/northfold-records">Traxsource</a> <a href="https://open.spotify.com/playlist/37i9dQZF1DX2TRYkJECvfC">playlist</a>',
			soundcloudId: 237204,
			playlists: [{ id: '37i9dQZF1DX2TRYkJECvfC', name: 'Northfold Radio', owner: 'Northfold Records' }, { id: '0000000000000000000000', name: 'Fan mix', owner: 'someone' }],
		});
		expect(await run(app, fetch)).toEqual({ attempted: 1, attached: 9 });
		expect(await reps(app, labelId)).toEqual([
			'bandcamp:2140572776',
			'beatport:804',
			'discogs:45909',
			'instagram:northfold',
			'musicbrainz:5b66608b-878d-4d7a-a96b-6da38356f6c8',
			'soundcloud:237204',
			'traxsource:3089',
			'user:name:northfold records',
			'website:northfold.example',
			'youtube:UCbDgBFAketcO26wz-pR6OKAx',
		]);
		const ids = await app.db.query<{ namespace: string; value: string }>(`select namespace, value from curator.catalog_identifier where object_id = $1 order by namespace`, [labelId]);
		expect(ids).toEqual([{ namespace: 'discogs_label', value: '45909' }, { namespace: 'mbid_label', value: '5b66608b-878d-4d7a-a96b-6da38356f6c8' }]);
		// The sub-labels did not confuse either match; two calls a list (search, then the one hit).
		expect(calls.filter((c) => c.startsWith('musicbrainz.org'))).toHaveLength(2);
		expect(calls.filter((c) => c.startsWith('api.discogs.com'))).toHaveLength(2);
		// The trackers that needed an id now have a cursor; the profile task is gone.
		const [list] = await fan.api.catalog.listWatches.query({ deviceId: fan.deviceId });
		expect(list!.tracking.map((t) => t.provider).sort()).toEqual(['bandcamp', 'beatport', 'deezer', 'soundcloud', 'youtube']);
		expect(await app.db.query(`select 1 from curator.catalog_enrich_task where need = 'profile'`)).toEqual([]);
		// No playlist is taken by its owner's name any more: the catalogue
		// playlists are the next step's, after the backfills.
		expect(await app.db.query(`select 1 from curator.catalog_edge where kind = 'label-playlist'`)).toEqual([]);
		const next = await app.db.query<{ need: string; provider: string }>(`select need, provider from curator.catalog_enrich_task where object_id = $1 order by need, provider`, [labelId]);
		expect(next.map((t) => `${t.need}/${t.provider}`)).toEqual(['backfill/bandcamp', 'backfill/beatport', 'backfill/deezer', 'catalogue_playlists/spotify', 'dedupe/catalog']);
	});

	it("a source's challenge parks that source only: the rest attach, a slug page becomes its id, and the profile is queued again for later", async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: { provider: 'user', kind: 'label', providerId: 'name:northfold records', name: 'Northfold Records' }, source: 'manual' });
		const labelId = w.watch.object.id;
		// The label already carries its Bandcamp page by subdomain (linked by hand before).
		await app.db.query(`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url) values ($1, 'bandcamp', 'label', 'northfold', 'https://northfold.bandcamp.com')`, [labelId]);
		const { fetch } = fakeWorld({
			mb: [{ id: '5b66608b-878d-4d7a-a96b-6da38356f6c8', name: 'Northfold Records' }],
			mbRels: [{ type: 'soundcloud', url: 'https://soundcloud.com/northfold-records' }],
			discogs: [],
			discogsUrls: [],
			beatport: [],
			beatportChallenge: true,
			bandcampLabelId: '2140572776',
			soundcloudId: 237204,
		});
		expect(await run(app, fetch, false)).toEqual({ attempted: 1, attached: 2 });
		// Bandcamp re-pointed to its band id (one row, not two); SoundCloud by its numeric id; MusicBrainz attached.
		expect(await reps(app, labelId)).toEqual(['bandcamp:2140572776', 'musicbrainz:5b66608b-878d-4d7a-a96b-6da38356f6c8', 'soundcloud:237204', 'user:name:northfold records']);
		const [task] = await app.db.query<{ last_error: string; later: boolean }>(`select last_error, next_due_at > now() + interval '50 minutes' as later from curator.catalog_enrich_task where object_id = $1 and need = 'profile'`, [labelId]);
		expect(task).toMatchObject({ last_error: 'parked: beatport (21600s)', later: true });
		// The backfills are queued regardless, and the Bandcamp tracker has its id.
		const next = await app.db.query<{ need: string; provider: string }>(`select need, provider from curator.catalog_enrich_task where object_id = $1 and need = 'backfill' order by provider`, [labelId]);
		expect(next.map((t) => t.provider)).toEqual(['bandcamp', 'deezer']);
	});

	it('attaches nothing from a list with two namesakes, nor a page another label owns', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const other = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: { provider: 'beatport', kind: 'label', providerId: '804', name: 'Northfold' }, source: 'manual' });
		const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: { provider: 'user', kind: 'label', providerId: 'name:northfold', name: 'Northfold' }, source: 'manual' });
		const { fetch } = fakeWorld({
			mb: [{ id: 'a0000000-0000-4000-8000-000000000001', name: 'Northfold' }, { id: 'a0000000-0000-4000-8000-000000000002', name: 'Northfold' }],
			mbRels: [],
			discogs: [{ id: 7, title: 'Northfold', type: 'label' }, { id: 8, title: 'Northfold (2)', type: 'label' }],
			discogsUrls: ['https://soundcloud.com/northfold'],
			beatport: [{ label_id: 804, label_name: 'Northfold' }],
		});
		await run(app, fetch, false);
		// MusicBrainz and Discogs were ambiguous; Beatport's 804 belongs to the other label.
		expect(await reps(app, w.watch.object.id)).toEqual(['user:name:northfold']);
		expect(await reps(app, other.watch.object.id)).toEqual(['beatport:804']);
		expect(await app.db.query(`select 1 from curator.catalog_enrich_task where need = 'profile'`)).toHaveLength(0);
	});
});
