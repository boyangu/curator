// A label's uploads on YouTube and SoundCloud (fake APIs, made-up names):
// how a title becomes a credit, how an upload joins a known recording or
// becomes an announcement on the label, and how a SoundCloud upload with an
// ISRC is a release the label's watchers hear about.

import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createLogger } from '../log.js';
import { createTestApp, type TestApp } from '../test/harness.js';
import { ingestClaims } from './ingest.js';
import type { FetchLike } from './trackers/http.js';
import { SoundCloudTracker } from './trackers/soundcloud.js';
import { runTrackers } from './trackers/sweep.js';
import { TrackerRateLimitedError } from './trackers/types.js';
import { parseUploadTitle, splitCatalogNumber, splitCredit, stripFormatWord } from './trackers/upload-title.js';
import { YouTubeTracker } from './trackers/youtube.js';

const quiet = createLogger(() => {});
const DAY = 86400_000;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('upload titles', () => {
	it('reads "Artist - Title" and drops the medium', () => {
		expect(parseUploadTitle('Northfold - Glass Rivers (Official Video)')).toEqual({ title: 'Glass Rivers', artists: ['Northfold'] });
		// `&` is a duo's name, as the stores and the library hold it; `,` separates.
		expect(parseUploadTitle('Northfold & Kaske – Glass Rivers (Ilka Rane Remix) [Official Audio]')).toEqual({ title: 'Glass Rivers (Ilka Rane Remix)', artists: ['Northfold & Kaske'] });
		expect(parseUploadTitle('Northfold, Kaske - Glass Rivers')).toEqual({ title: 'Glass Rivers', artists: ['Northfold', 'Kaske'] });
		expect(parseUploadTitle('Northfold feat. Kaske - Glass Rivers | Northfold Records')).toEqual({ title: 'Glass Rivers', artists: ['Northfold', 'Kaske'] });
		expect(parseUploadTitle('Northfold Records Showcase 2026')).toEqual({ title: 'Northfold Records Showcase 2026', artists: [] });
	});

	it('reads a collective with its members in parentheses as the group and each member, and keeps &, x and vs inside a name', () => {
		expect(splitCredit('Lowtide (Kaske, Ilka Rane, &OR)')).toEqual(['Lowtide', 'Kaske', 'Ilka Rane', '&OR']);
		expect(splitCredit('Lowtide (Kaske, &OR), Northfold')).toEqual(['Lowtide', 'Kaske', '&OR', 'Northfold']);
		expect(splitCredit('Kaske (UK) x Ilka Rane')).toEqual(['Kaske (UK) x Ilka Rane']);
		expect(splitCredit('Kaske vs Northfold (feat. Ilka Rane)')).toEqual(['Kaske vs Northfold', 'Ilka Rane']);
		expect(splitCredit('Kaske, kaske')).toEqual(['Kaske']);
	});

	it("takes a label's catalogue number off the front of its own sets", () => {
		expect(splitCatalogNumber('Maeve 034 - Jonathan Kaspar - Can\'t Stop', 'Maeve')).toEqual({ catalogNumber: 'MAEVE034', rest: "Jonathan Kaspar - Can't Stop" });
		expect(splitCatalogNumber('Northfold 12 – Kaske - Drift EP', 'Northfold Records')).toEqual({ catalogNumber: 'NORTHFOLD12', rest: 'Kaske - Drift EP' });
		expect(splitCatalogNumber('Chymera - Noise Tool - Maeve 14', 'Maeve')).toEqual({ rest: 'Chymera - Noise Tool - Maeve 14' });
	});

	it("reads a label's album wording: Artist \"Title\", and the format word the set's type already says", () => {
		expect(parseUploadTitle('Phil Kieran "Life Cycling"')).toEqual({ title: 'Life Cycling', artists: ['Phil Kieran'] });
		expect(stripFormatWord('Abiogenesis EP', 'ep')).toBe('Abiogenesis');
		expect(stripFormatWord('Reveries EP', 'album')).toBe('Reveries EP');
		expect(stripFormatWord('Trails LP', 'album')).toBe('Trails');
		expect(stripFormatWord('Deep', 'ep')).toBe('Deep');
	});
});

// A recording the catalogue knows from Spotify, released on the watched label.
async function seedKnown(app: TestApp, labelClaim: { provider: 'youtube' | 'soundcloud'; providerId: string }) {
	const fan = await app.signIn();
	const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: { provider: labelClaim.provider, kind: 'label', providerId: labelClaim.providerId, name: 'Northfold Records', url: null }, source: 'manual' });
	await withSystemTx(app.db, (tx) =>
		ingestClaims(
			tx,
			[
				{
					provider: 'spotify',
					kind: 'release',
					providerId: 'al1',
					name: 'Glass Rivers',
					facts: { releaseDate: '2026-10-23' },
					artists: [{ provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'Northfold' }],
					recordings: [{ provider: 'spotify', kind: 'recording', providerId: 'st1', name: 'Glass Rivers', identifiers: [{ namespace: 'isrc', value: 'GBAAA2600001' }], facts: { durationSec: 401 } }],
				},
			],
			{ reason: 'library_import' },
		),
	);
	return { fan, labelId: w.watch.object.id };
}

const signals = (app: TestApp, labelId: string) =>
	app.db.query<{ kind: string; value: string }>(`select kind, value::text as value from curator.catalog_signal where object_id = $1 order by observed_at`, [labelId]);

describe('YouTubeTracker', () => {
	const uploads = (state: { quota?: boolean }, calls: string[]): FetchLike => async (input) => {
		const u = new URL(input);
		calls.push(`${u.pathname}?${[...u.searchParams.keys()].filter((k) => k !== 'key').sort().join(',')}`);
		if (state.quota) return json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403);
		if (u.pathname.endsWith('/channels')) return json({ items: u.searchParams.get('forHandle') === '@northfold' ? [{ id: 'UCnorthfold00000000000000' }] : [] });
		if (u.pathname.endsWith('/playlistItems')) {
			expect(u.searchParams.get('playlistId')).toBe('UUnorthfold00000000000000');
			const at = (d: number) => new Date(Date.now() - d * DAY).toISOString();
			return json({
				items: [
					{ snippet: { title: 'Northfold - Glass Rivers (Official Video)', publishedAt: at(2), resourceId: { videoId: 'v1' }, thumbnails: { high: { url: 'https://i.test/v1.jpg' } } } },
					{ snippet: { title: 'Northfold Records Showcase 2026', publishedAt: at(5), resourceId: { videoId: 'v2' } } },
					{ snippet: { title: 'Kaske - Old Premiere', publishedAt: at(200), resourceId: { videoId: 'v3' } } },
				],
			});
		}
		return json({}, 404);
	};

	it('resolves a handle once, joins the upload it can place, and notes the rest on the label', async () => {
		const app = await createTestApp();
		const { labelId } = await seedKnown(app, { provider: 'youtube', providerId: '@northfold' });
		const calls: string[] = [];
		const run = () => runTrackers({ db: app.db, log: quiet, adapters: [new YouTubeTracker('k', uploads({}, calls))], holder: 'test', sleep: async () => {} });
		expect((await run()).find((p) => p.provider === 'youtube')).toMatchObject({ polled: 1, events: 0 });
		expect(calls).toEqual(['/youtube/v3/channels?forHandle,part', '/youtube/v3/playlistItems?maxResults,part,playlistId']);
		// The known recording gained its YouTube handle; the showcase is an announcement; the old premiere nothing.
		const [rep] = await app.db.query<{ url: string }>(`select url from curator.catalog_source_object where provider = 'youtube' and kind = 'recording'`);
		expect(rep?.url).toBe('https://www.youtube.com/watch?v=v1');
		const s = await signals(app, labelId);
		expect(s.map((x) => [x.kind, (JSON.parse(x.value) as { title: string }).title])).toEqual([['announcement', 'Northfold Records Showcase 2026']]);
		expect(await app.db.query(`select 1 from curator.catalog_object where kind = 'recording'`)).toHaveLength(1);
		// Next poll: the channel id is remembered, the listing unchanged.
		calls.length = 0;
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 minute'`);
		expect((await run()).find((p) => p.provider === 'youtube')).toMatchObject({ polled: 1, unchanged: 1 });
		expect(calls).toEqual(['/youtube/v3/playlistItems?maxResults,part,playlistId']);
	});

	it('a spent quota parks the tracker', async () => {
		const yt = new YouTubeTracker('k', uploads({ quota: true }, []));
		await expect(yt.poll({ object: { id: 'x', kind: 'label', name: 'N' }, representation: { providerId: 'UCnorthfold00000000000000', url: null }, cursor: {} }, AbortSignal.timeout(5000))).rejects.toBeInstanceOf(TrackerRateLimitedError);
	});
});

describe('SoundCloudTracker', () => {
	function api(calls: string[]): FetchLike {
		return async (input, init) => {
			const u = new URL(input);
			calls.push(`${init?.method ?? 'GET'} ${u.hostname}${u.pathname}`);
			if (u.hostname === 'secure.soundcloud.com') return json({ access_token: 'tok', expires_in: 3600 });
			if (u.pathname === '/resolve') return u.searchParams.get('url') === 'https://soundcloud.com/northfold' ? json({ kind: 'user', id: 237204 }) : json({}, 404);
			const at = (d: number) => new Date(Date.now() - d * DAY).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000').replace(/-/g, '/');
			if (u.pathname === '/users/237204/playlists') {
				expect(u.searchParams.get('show_tracks')).toBe('true');
				return json({
					collection: [
						// The label's own set, numbered: the EP the upload above is from.
						{
							id: 5001,
							title: 'Northfold 034 - Kaske - Drift EP',
							playlist_type: 'ep',
							created_at: at(1),
							release_year: 2026,
							release_month: 11,
							release_day: 6,
							label_name: 'Northfold Records',
							genre: 'Melodic House & Techno',
							permalink_url: 'https://soundcloud.com/northfold/sets/drift-ep',
							user: { username: 'Northfold Records' },
							tracks: [
								{ id: 901, title: 'Northfold - Drift (Extended Mix)', duration: 402_000, isrc: 'GBAAA2600009' },
								// Only a preview plays for the API: its duration is the preview's.
								{ id: 905, title: 'Drift (Dub)', duration: 30_000, access: 'preview', metadata_artist: 'Kaske, Ilka Rane', isrc: 'GBAAA2600010', user: { id: 777, username: 'Kaske' } },
							],
						},
						// Teasers, and a loose playlist: not releases.
						{ id: 5002, title: 'Northfold 034 - Kaske - Drift EP - Snippets', playlist_type: 'ep', created_at: at(3), tracks: [] },
						{ id: 5003, title: 'Northfold Records Radio', playlist_type: 'PLAYLIST', created_at: at(3), tracks: [] },
					],
				});
			}
			if (u.pathname === '/users/237204/tracks') {
				expect(init?.headers).toMatchObject({ authorization: 'OAuth tok' });
				return json({
					collection: [
						{ id: 901, title: 'Northfold - Drift (Extended Mix)', created_at: at(1), duration: 402_000, isrc: 'GBAAA2600009', label_name: 'Northfold Records', genre: 'Melodic House & Techno', release_year: 2026, release_month: 11, release_day: 6, permalink_url: 'https://soundcloud.com/northfold/drift', artwork_url: 'https://i1.sndcdn.com/artworks-x-large.jpg' },
						{ id: 902, title: 'Northfold - Glass Rivers', created_at: at(3), duration: 401_000, permalink_url: 'https://soundcloud.com/northfold/glass-rivers' },
						{ id: 903, title: 'Northfold Records Radio 012', created_at: at(4), duration: 3_600_000 },
					],
				});
			}
			return json({}, 404);
		};
	}

	it('announces an upload with an ISRC as a release, reads the albums, joins what it can place, notes the rest; one token for all', async () => {
		const app = await createTestApp();
		const { fan, labelId } = await seedKnown(app, { provider: 'soundcloud', providerId: '237204' });
		const calls: string[] = [];
		const sc = new SoundCloudTracker({ clientId: 'id', clientSecret: 's' }, api(calls));
		const pass = (await runTrackers({ db: app.db, log: quiet, adapters: [sc], holder: 'test', sleep: async () => {} })).find((p) => p.provider === 'soundcloud');
		expect(pass).toMatchObject({ polled: 1, events: 2 });
		expect(calls).toEqual(['POST secure.soundcloud.com/oauth/token', 'GET api.soundcloud.com/users/237204/tracks', 'GET api.soundcloud.com/users/237204/playlists']);
		await app.pg.query(`update curator.catalog_event set first_seen_at = first_seen_at - interval '5 minutes'`);
		const { events } = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: 0 });
		expect(events.map((e) => [e.kind, (e.card as { title: string }).title]).sort()).toEqual([
			['new_release', 'Drift'],
			['new_release', 'Drift (Extended Mix)'],
		]);
		// SoundCloud's genre is free text: kept as the source's fact, not forced onto the taxonomy.
		const single = events.find((e) => (e.card as { title: string }).title === 'Drift (Extended Mix)')!;
		const card = single.card as { label: { name: string }; releaseDate: string; tracks: { isrc: string | null; handles: { provider: string }[] }[] };
		expect(card).toMatchObject({ label: { name: 'Northfold Records' }, releaseDate: '2026-11-06' });
		expect(card.tracks[0]).toMatchObject({ isrc: 'GBAAA2600009', handles: [{ provider: 'soundcloud' }] });
		// The EP: numbered, credited off its title, two tracks (one the upload above), the teasers and the radio playlist left alone.
		// Named without the "EP" its type already says, so the stores' "Drift" joins it.
		const ep = events.find((e) => (e.card as { title: string }).title === 'Drift')!.card as { releaseType: string | null; artists: { name: string }[]; tracks: { isrc: string | null }[] };
		expect(ep).toMatchObject({ releaseType: 'ep', artists: [{ name: 'Kaske' }] });
		expect(ep.tracks.map((t) => t.isrc)).toEqual(['GBAAA2600009', 'GBAAA2600010']);
		// The preview track: no length (not 0:30), credited from the uploader's artist field.
		const [dub] = await app.db.query<{ duration_sec: unknown; artists: string }>(
			`select o.duration_sec, (select string_agg(a.name, ', ' order by a.name) from curator.catalog_edge e join curator.catalog_object a on a.id = e.dst where e.src = o.id and e.kind = 'recording-artist') as artists
			from curator.catalog_object o join curator.catalog_source_object so on so.object_id = o.id and so.provider = 'soundcloud' and so.provider_id = '905'`,
		);
		expect(dub).toEqual({ duration_sec: null, artists: 'Ilka Rane, Kaske' });
		expect(await app.db.query(`select 1 from curator.catalog_fact where field = 'catalogNumber' and value::text like '%NORTHFOLD034%'`)).toHaveLength(1);
		expect(await app.db.query(`select 1 from curator.catalog_object where kind = 'release'`)).toHaveLength(3);
		// Glass Rivers joined the Spotify recording; the radio show is an announcement.
		const [rep] = await app.db.query<{ url: string }>(`select so.url from curator.catalog_source_object so join curator.catalog_source_object sp on sp.object_id = so.object_id and sp.provider = 'spotify' and sp.kind = 'recording' where so.provider = 'soundcloud' and so.kind = 'recording'`);
		expect(rep?.url).toBe('https://soundcloud.com/northfold/glass-rivers');
		expect((await signals(app, labelId)).map((s) => (JSON.parse(s.value) as { title: string }).title)).toEqual(['Northfold Records Radio 012']);
		// The two new tracks wait for their Spotify ids.
		expect(await app.db.query(`select 1 from curator.catalog_enrich_task where need = 'representation' and provider = 'spotify'`)).toHaveLength(2);
		// A second poll reuses the token.
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 minute'`);
		await runTrackers({ db: app.db, log: quiet, adapters: [sc], holder: 'test', sleep: async () => {} });
		expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
	});

	it('resolves a permalink the profiler left unresolved through the API, re-points the page, and reads it by id from then on', async () => {
		const app = await createTestApp();
		const { labelId } = await seedKnown(app, { provider: 'soundcloud', providerId: 'northfold' });
		await app.pg.query(`update curator.catalog_source_object set url = 'https://soundcloud.com/northfold' where object_id = $1 and provider = 'soundcloud'`, [labelId]);
		const calls: string[] = [];
		const sc = new SoundCloudTracker({ clientId: 'id', clientSecret: 's' }, api(calls));
		const pass = (await runTrackers({ db: app.db, log: quiet, adapters: [sc], holder: 'test', sleep: async () => {} })).find((p) => p.provider === 'soundcloud');
		expect(pass).toMatchObject({ polled: 1, failed: 0, calls: 3 });
		expect(calls.slice(1, 3)).toEqual(['GET api.soundcloud.com/resolve', 'GET api.soundcloud.com/users/237204/tracks']);
		expect(await app.db.query(`select provider_id from curator.catalog_source_object where object_id = $1 and provider = 'soundcloud' and kind = 'label'`, [labelId])).toEqual([{ provider_id: '237204' }]);
		calls.length = 0;
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 minute'`);
		await runTrackers({ db: app.db, log: quiet, adapters: [sc], holder: 'test', sleep: async () => {} });
		expect(calls).toEqual(['GET api.soundcloud.com/users/237204/tracks', 'GET api.soundcloud.com/users/237204/playlists']);
	});

	it('fails a permalink the API does not know as not found (404): a dead page, not an unresolved one', async () => {
		const app = await createTestApp();
		const { labelId } = await seedKnown(app, { provider: 'soundcloud', providerId: 'northfold-gone' });
		const sc = new SoundCloudTracker({ clientId: 'id', clientSecret: 's' }, api([]));
		const pass = (await runTrackers({ db: app.db, log: quiet, adapters: [sc], holder: 'test', sleep: async () => {} })).find((p) => p.provider === 'soundcloud');
		expect(pass).toMatchObject({ polled: 0, failed: 1 });
		const [cur] = await app.db.query<{ last_error: string }>(`select last_error from curator.catalog_cursor where object_id = $1 and provider = 'soundcloud'`, [labelId]);
		expect(cur?.last_error).toBe('soundcloud profile northfold-gone not found (404)');
	});
});
