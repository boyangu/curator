// The back office's tracklist fill: a release a tracker took from a listing
// alone gains its tracks, UPC and label from the stores it is on, joined
// across stores by UPC and ISRC; a store id held elsewhere opens a review.
// Made-up names and ids.

import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp } from '../test/harness.js';
import { adminOps } from './admin-ops.js';
import { ingestClaims } from './ingest.js';
import { releaseStubs } from './release-fill.js';
import { releaseClaim, SpotifyAppTracker } from './trackers/spotify-app.js';
import { TidalApp } from './trackers/tidal-app.js';
import type { FetchLike } from './trackers/http.js';

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const SP_ALBUM = 'A'.repeat(22);
const artist = { id: 'B'.repeat(22), name: 'Glass Rivers' };
const listed = { id: SP_ALBUM, name: 'Low Tide EP', album_type: 'single', release_date: '2026-06-12', total_tracks: 2, artists: [artist] };
const full = {
	...listed,
	label: 'Northfold Records',
	external_ids: { upc: '0123456789012' },
	tracks: {
		items: [
			{ id: 'C'.repeat(22), name: 'Low Tide', duration_ms: 301_000, track_number: 1, artists: [artist] },
			// Spotify credits the feature; Deezer names the main artist only.
			{ id: 'D'.repeat(22), name: 'Undertow', duration_ms: 288_000, track_number: 2, artists: [artist, { id: 'E'.repeat(22), name: 'Northern Drift' }] },
		],
	},
};
const deezerAlbum = { id: 991, title: 'Low Tide EP', upc: '0123456789012', release_date: '2026-06-12', nb_tracks: 2, label: 'Northfold Records', artist: { id: 7, name: 'Glass Rivers' } };
const deezerTracks = {
	data: [
		{ id: 11, title: 'Low Tide', isrc: 'GBNFR2600001', duration: 301, track_position: 1, artist: { id: 7, name: 'Glass Rivers' } },
		{ id: 12, title: 'Undertow', isrc: 'GBNFR2600002', duration: 288, track_position: 2, artist: { id: 7, name: 'Glass Rivers' } },
	],
};

// Apple and Tidal know the release by its Spotify UPC; their tracks carry no
// featured credit, and Tidal has the ISRCs.
const appleResults = [
	{ wrapperType: 'collection', collectionId: 77, collectionName: 'Low Tide EP', artistId: 5, artistName: 'Glass Rivers', collectionViewUrl: 'https://music.apple.com/us/album/low-tide-ep/77?uo=4', primaryGenreName: 'Dance', releaseDate: '2026-09-04T07:00:00Z', trackCount: 2 },
	{ wrapperType: 'track', kind: 'song', collectionId: 77, trackId: 771, trackName: 'Low Tide', trackNumber: 1, trackTimeMillis: 301_000, trackViewUrl: 'https://music.apple.com/us/album/low-tide/77?i=771&uo=4', primaryGenreName: 'House', artistId: 5, artistName: 'Glass Rivers' },
	{ wrapperType: 'track', kind: 'song', collectionId: 77, trackId: 772, trackName: 'Undertow', trackNumber: 2, trackTimeMillis: 288_000, trackViewUrl: 'https://music.apple.com/us/album/undertow/77?i=772&uo=4', primaryGenreName: 'House', artistId: 5, artistName: 'Glass Rivers' },
];
const tidalDoc = {
	data: [{ id: '900', type: 'albums', attributes: { title: 'Low Tide EP', barcodeId: '0123456789012', releaseDate: '2026-09-04', numberOfItems: 2, externalLinks: [{ href: 'https://tidal.com/browse/album/900' }] }, relationships: { items: { data: [{ id: '901', type: 'tracks', meta: { trackNumber: 1 } }, { id: '902', type: 'tracks', meta: { trackNumber: 2 } }] }, artists: { data: [{ id: '50', type: 'artists' }] } } }],
	included: [
		{ id: '50', type: 'artists', attributes: { name: 'Glass Rivers' } },
		{ id: '901', type: 'tracks', attributes: { title: 'Low Tide', isrc: 'GBNFR2600001', duration: 'PT5M1S', externalLinks: [{ href: 'https://tidal.com/browse/track/901' }] }, relationships: { artists: { data: [{ id: '50', type: 'artists' }] } } },
		{ id: '902', type: 'tracks', attributes: { title: 'Undertow', isrc: 'GBNFR2600002', duration: 'PT4M48S', externalLinks: [{ href: 'https://tidal.com/browse/track/902' }] }, relationships: { artists: { data: [{ id: '50', type: 'artists' }] } } },
	],
};

function fakeFetch(calls: string[], opts: { deezerUpc?: string } = {}): FetchLike {
	const upc = opts.deezerUpc ?? '0123456789012';
	return async (u) => {
		const url = String(u);
		calls.push(url.replace(/^https:\/\/[^/]+/, ''));
		if (url.includes('auth.tidal.com')) return json({ access_token: 'tt', expires_in: 3600 });
		if (url.includes('openapi.tidal.com/v2/albums')) return json(url.includes('barcodeId%5D=0123456789012') ? tidalDoc : { data: [] });
		if (url.includes('itunes.apple.com/lookup')) return json({ results: url.includes('upc=0123456789012') && url.includes('country=us') ? appleResults : [] });
		if (url.includes('accounts.spotify.com')) return json({ access_token: 't', expires_in: 3600 });
		if (url.includes('/v1/albums?ids=')) return json({ albums: [full] });
		if (url.includes(`/album/upc%3A${upc}`)) return json(deezerAlbum);
		if (url.includes('/album/991?') || url.endsWith('/album/991')) return json(deezerAlbum);
		if (url.includes('/search/album')) return json({ data: [{ id: 991, title: 'Low Tide EP', nb_tracks: 2, record_type: 'single', artist: { id: 7, name: 'Glass Rivers' }, link: 'https://www.deezer.com/album/991' }, { id: 5, title: 'Low Tide', artist: { id: 9, name: 'Other' } }] });
		if (url.includes('/album/991/tracks')) return json(deezerTracks);
		return json({ error: { code: 800, message: 'no data' } });
	};
}

async function seeded(opts: { deezerUpc?: string } = {}) {
	const app = await createTestApp();
	// What the Spotify artist tracker ingests for an old release: the listing alone.
	await withSystemTx(app.db, (tx) => ingestClaims(tx, [releaseClaim(listed)], { reason: 'tracker' }));
	const [rel] = await app.db.query<{ id: string }>(`select object_id as id from curator.catalog_source_object where provider = 'spotify' and kind = 'release'`);
	const calls: string[] = [];
	const fetchFn = fakeFetch(calls, opts);
	const ops = adminOps(app.db, { fetch: fetchFn, spotify: new SpotifyAppTracker({ clientId: 'id', clientSecret: 's' }, fetchFn), tidal: new TidalApp({ clientId: 't', clientSecret: 's' }, fetchFn) });
	return { app, ops, calls, releaseId: rel!.id };
}

describe('release fill', () => {
	it('lists a listing-only release as a stub and fills it from Spotify, then Deezer by its UPC', async () => {
		const { app, ops, calls, releaseId } = await seeded();
		const stubs = await ops.releaseStubs({ artist: 'Glass Rivers' });
		expect(stubs).toMatchObject({ total: 1, rows: [{ id: releaseId, title: 'Low Tide EP', have: 0, expected: 2, handles: [{ provider: 'spotify', id: SP_ALBUM }], upc: null }] });

		// A dry run reads everything and writes nothing.
		const dry = await ops.releaseFill({ artist: 'Glass Rivers', dry: true });
		expect(dry.outcomes[0]).toMatchObject({ before: 0, after: 2 });
		expect((await ops.releaseStubs({})).total).toBe(1);

		calls.length = 0;
		const r = await ops.releaseFill({ artist: 'Glass Rivers' });
		expect(r).toMatchObject({ dry: false, stubs: 1, filled: 1, parked: [] });
		expect(r.outcomes[0]).toMatchObject({ id: releaseId, before: 0, after: 2, expected: 2, conflicts: [] });
		expect(r.outcomes[0]!.sources).toEqual([
			{ provider: 'spotify', tracks: 2 },
			{ provider: 'deezer', tracks: 2, note: 'found by UPC 0123456789012' },
			{ provider: 'tidal', tracks: 2, note: 'found by UPC' },
			{ provider: 'apple', tracks: 2, note: 'found by UPC' },
		]);
		// One /albums call carried the Spotify side.
		expect(calls.filter((c) => c.startsWith('/v1/albums')).length).toBe(1);

		// Two recordings, each on both stores, with Deezer's ISRCs.
		const recs = await app.db.query<{ name: string; providers: string; isrc: string | null }>(
			`select o.name, (select string_agg(so.provider, ',' order by so.provider) from curator.catalog_source_object so where so.object_id = o.id) as providers,
				(select i.value from curator.catalog_identifier i where i.object_id = o.id and i.namespace = 'isrc') as isrc
			from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst where e.src = $1 and e.kind = 'release-recording' order by e.position`,
			[releaseId],
		);
		// Every store's page on the same two recordings; Apple's links without the campaign suffix.
		expect(recs).toEqual([
			{ name: 'Low Tide', providers: 'apple,deezer,spotify,tidal', isrc: 'GBNFR2600001' },
			{ name: 'Undertow', providers: 'apple,deezer,spotify,tidal', isrc: 'GBNFR2600002' },
		]);
		const urls = await app.db.query<{ provider: string; url: string }>(`select so.provider, so.url from curator.catalog_source_object so join curator.catalog_edge e on e.dst = so.object_id and e.kind = 'release-recording' and e.src = $1 where e.position = 1 order by so.provider`, [releaseId]);
		expect(urls.map((u) => `${u.provider} ${u.url}`)).toEqual(['apple https://music.apple.com/us/album/low-tide/77?i=771', 'deezer https://www.deezer.com/track/11', `spotify https://open.spotify.com/track/${'C'.repeat(22)}`, 'tidal https://tidal.com/browse/track/901']);
		const albumPages = await app.db.query<{ provider: string }>(`select provider from curator.catalog_source_object where object_id = $1 order by provider`, [releaseId]);
		expect(albumPages.map((x) => x.provider)).toEqual(['apple', 'deezer', 'spotify', 'tidal']);
		// Apple's genres: "Dance" on the album is orthogonal, "House" on the tracks maps.
		const genres = await app.db.query<{ name: string }>(`select g.name from curator.catalog_edge e join curator.catalog_object g on g.id = e.dst where e.src = $1 and e.kind = 'object-genre'`, [releaseId]);
		expect(genres).toEqual([]);
		const trackGenres = await app.db.query<{ name: string }>(`select distinct g.name from curator.catalog_edge rr join curator.catalog_edge e on e.src = rr.dst and e.kind = 'object-genre' join curator.catalog_object g on g.id = e.dst where rr.src = $1 and rr.kind = 'release-recording'`, [releaseId]);
		expect(trackGenres.map((g) => g.name)).toEqual(['House']);
		const [rel] = await app.db.query<{ upc: string; label: string }>(
			`select (select value from curator.catalog_identifier where object_id = $1 and namespace = 'upc') as upc, attrs->>'labelText' as label from curator.catalog_object where id = $1`,
			[releaseId],
		);
		// Kept normalised, without the leading zero.
		expect(rel).toEqual({ upc: '123456789012', label: 'Northfold Records' });
		// No longer a stub; nothing reached a feed.
		expect((await ops.releaseStubs({})).total).toBe(0);
		expect(await app.db.query(`select 1 from curator.catalog_event`)).toEqual([]);
		await withSystemTx(app.db, async (tx) => expect((await releaseStubs(tx, { ids: [releaseId] })).rows[0]).toMatchObject({ have: 2, upc: '123456789012' }));
	});

	it('a store copy under another UPC comes back as a candidate; linked, the next fill reads it', async () => {
		const { app, ops, releaseId } = await seeded({ deezerUpc: '0999999999999' });
		const first = await ops.releaseFill({ ids: [releaseId] });
		expect(first.outcomes[0]).toMatchObject({ after: 2, candidates: [{ provider: 'deezer', id: '991', title: 'Low Tide EP', artist: 'Glass Rivers', tracks: 2 }] });
		expect(first.outcomes[0]!.sources.map((x) => x.provider)).toEqual(['spotify', 'deezer', 'tidal', 'apple']);
		// Nothing attached from a title: no track has a Deezer copy yet.
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'deezer' and kind = 'recording'`)).toEqual([]);

		await ops.releaseLink({ id: releaseId, url: 'https://www.deezer.com/album/991' });
		const second = await ops.releaseFill({ ids: [releaseId] });
		expect(second.outcomes[0]).toMatchObject({ before: 2, after: 2, candidates: [] });
		expect(second.outcomes[0]!.sources).toContainEqual({ provider: 'deezer', tracks: 2 });
		const deezerTracks = await app.db.query<{ isrc: string }>(`select i.value as isrc from curator.catalog_source_object so join curator.catalog_identifier i on i.object_id = so.object_id and i.namespace = 'isrc' where so.provider = 'deezer' and so.kind = 'recording' order by i.value`);
		expect(deezerTracks.map((x) => x.isrc)).toEqual(['GBNFR2600001', 'GBNFR2600002']);
	});

	it('does not move a store id another release holds: a duplicate review opens', async () => {
		const { app, ops, releaseId } = await seeded();
		// The Deezer album is already another release's.
		await withSystemTx(app.db, (tx) =>
			ingestClaims(tx, [{ provider: 'deezer', kind: 'release', providerId: '991', name: 'Low Tide (EP)', artists: [{ provider: 'deezer', kind: 'artist', providerId: '8', name: 'Someone Else' }] }], { reason: 'library_import' }),
		);
		const [other] = await app.db.query<{ id: string }>(`select object_id as id from curator.catalog_source_object where provider = 'deezer' and kind = 'release'`);
		const r = await ops.releaseFill({ ids: [releaseId] });
		expect(r.outcomes[0]).toMatchObject({ after: 2, conflicts: [{ provider: 'deezer', id: '991', heldBy: other!.id }] });
		const reviews = await app.db.query<{ kind: string; object_id: string }>(`select kind, object_id from curator.catalog_review`);
		expect(reviews).toEqual([{ kind: 'duplicate', object_id: releaseId }]);
		const [held] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'deezer' and provider_id = '991'`);
		expect(held!.object_id).toBe(other!.id);
	});

	it('links a store page the agent found, refusing one held elsewhere', async () => {
		const { app, ops, releaseId } = await seeded();
		await expect(ops.releaseLink({ id: releaseId, url: 'https://example.com/x' })).rejects.toThrow(/not a release page/);
		expect(await ops.releaseLink({ id: releaseId, url: 'https://www.beatport.com/release/low-tide-ep/4455' })).toEqual({ provider: 'beatport', id: '4455', conflict: null });
		const [h] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'beatport' and provider_id = '4455'`);
		expect(h!.object_id).toBe(releaseId);
		await withSystemTx(app.db, (tx) => ingestClaims(tx, [{ provider: 'deezer', kind: 'release', providerId: '555', name: 'Elsewhere', artists: [] }], { reason: 'library_import' }));
		const r = await ops.releaseLink({ id: releaseId, url: 'https://www.deezer.com/album/555' });
		expect(r.conflict).not.toBeNull();
	});

	it('dedupe merges one slot held twice, never two different ISRCs', async () => {
		const { app, ops, releaseId } = await seeded();
		await ops.releaseFill({ ids: [releaseId] });
		// A retitled copy of track 2 that an older fill left beside it, and a
		// track with its own ISRC in slot 1 at the same length.
		const extra = async (id: string, name: string, isrc?: string) => {
			await withSystemTx(app.db, (tx) =>
				ingestClaims(tx, [{ provider: 'bandcamp', kind: 'recording', providerId: id, name, facts: { durationSec: id === 'bc1' ? 301 : 288 }, ...(isrc ? { identifiers: [{ namespace: 'isrc' as const, value: isrc }] } : {}) }], { reason: 'enrichment' }),
			);
			const [o] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'bandcamp' and provider_id = $1`, [id]);
			await app.db.query(`insert into curator.catalog_edge (src, kind, dst, position) values ($1, 'release-recording', $2, $3::int)`, [releaseId, o!.object_id, id === 'bc1' ? '1' : '2']);
		};
		await extra('bc2', 'Undertow (Featuring Northern Drift)');
		await extra('bc1', 'Low Tide (Radio Edit)', 'GBNFR2699999');
		// A second disc's track 2 at the same length: another track, not a copy.
		await extra('bc3', 'Breakwater');
		const dry = await ops.releaseDedupe({ ids: [releaseId], dry: true });
		expect(dry.merged).toEqual([{ release: 'Low Tide EP', from: 'Undertow (Featuring Northern Drift)', into: 'Undertow', title: 'Undertow' }]);
		await ops.releaseDedupe({ ids: [releaseId] });
		const left = await app.db.query<{ name: string }>(
			`select o.name from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst where e.src = $1 and e.kind = 'release-recording' and o.merged_into is null order by e.position, o.name`,
			[releaseId],
		);
		expect(left.map((x) => x.name)).toEqual(['Low Tide', 'Low Tide (Radio Edit)', 'Breakwater', 'Undertow']);
	});

	it('dedupe folds a SoundCloud preview clip into the store track of its slot, and nothing else', async () => {
		const { app, ops, releaseId } = await seeded();
		await ops.releaseFill({ ids: [releaseId] });
		// A label's premiere set merged onto the release: 2:00 clips, credited
		// in the title, no ISRC — and in slot 2 a clip of some other track.
		const clip = async (id: string, name: string, position: number) => {
			await withSystemTx(app.db, (tx) => ingestClaims(tx, [{ provider: 'soundcloud', kind: 'recording', providerId: id, name, facts: { durationSec: 120 } }], { reason: 'enrichment' }));
			const [o] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'soundcloud' and provider_id = $1`, [id]);
			await app.db.query(`insert into curator.catalog_edge (src, kind, dst, position) values ($1, 'release-recording', $2, $3::int)`, [releaseId, o!.object_id, String(position)]);
		};
		await clip('sc1', 'Low Tide ft. Ilka Rane [Northfold]', 1);
		await clip('sc2', 'Sea Glass ft. Ilka Rane', 2);
		const r = await ops.releaseDedupe({ ids: [releaseId] });
		expect(r.merged).toEqual([{ release: 'Low Tide EP', from: 'Low Tide ft. Ilka Rane [Northfold]', into: 'Low Tide', title: 'Low Tide' }]);
		const left = await app.db.query<{ name: string; duration_sec: unknown }>(
			`select o.name, o.duration_sec from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst where e.src = $1 and e.kind = 'release-recording' and o.merged_into is null order by e.position, o.name`,
			[releaseId],
		);
		// The store track keeps its own length, not the clip's.
		expect(left.map((x) => [x.name, Number(x.duration_sec)])).toEqual([['Low Tide', 301], ['Sea Glass ft. Ilka Rane', 120], ['Undertow', 288]]);
	});
});
