// A library's collection in the catalogue (made-up names and ids): its labels
// and releases taken in from the back office, each release then read in full
// from its stores by the worker; a label's listing read through across
// passes; and what a device browses afterwards — a label's releases, a
// release's tracks — with the store handles to play them.

import { describe, expect, it } from 'vitest';
import type { CatalogClaim } from '@curator/protocol';
import { withSystemTx } from '../db/system-tx.js';
import { createLogger } from '../log.js';
import { createTestApp, type TestApp } from '../test/harness.js';
import { adminOps } from './admin-ops.js';
import { mergeObjects } from './admin.js';
import { ingestClaims } from './ingest.js';
import { runReleaseFiller } from './release-fill.js';
import { runBackfill } from './trackers/backfill.js';
import { DeezerTracker } from './trackers/deezer.js';
import type { FetchLike } from './trackers/http.js';
import { SpotifyAppTracker } from './trackers/spotify-app.js';

const quiet = createLogger(() => {});
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const LABEL = 'Northfold Records';
const SP_ALBUM = 'A'.repeat(22);
const SP_TRACK = 'C'.repeat(22);
const UPC = '0123456789012';

const label: CatalogClaim = { provider: 'user', kind: 'label', providerId: 'name:northfold records', name: LABEL };
const glass: CatalogClaim = { provider: 'spotify', kind: 'artist', providerId: 'B'.repeat(22), name: 'Glass Rivers' };

// What core's releaseCandidates sends: the label, then each release with the
// owner's tracks on it.
const claims = (): unknown[] => [
	label,
	{
		provider: 'spotify',
		kind: 'release',
		providerId: SP_ALBUM,
		url: `https://open.spotify.com/album/${SP_ALBUM}`,
		name: 'Low Tide EP',
		identifiers: [{ namespace: 'upc', value: UPC }],
		facts: { releaseDate: '2026-06-12', releaseType: 'single', trackCount: 2, labelText: LABEL },
		artists: [glass],
		label,
		recordings: [{ provider: 'spotify', kind: 'recording', providerId: SP_TRACK, name: 'Low Tide', identifiers: [{ namespace: 'isrc', value: 'GBNFR2600001' }], facts: { durationSec: 301, trackNumber: 1 }, artists: [glass] }],
	},
	{
		provider: 'user',
		kind: 'release',
		providerId: 'album:local-night-swim',
		name: 'Night Swim',
		facts: { releaseDate: '2025-03-01', trackCount: 1, labelText: LABEL },
		artists: [{ provider: 'user', kind: 'artist', providerId: 'northfold records/kaske', name: 'Kaske' }],
		label,
		recordings: [{ provider: 'user', kind: 'recording', providerId: 'rec-night-swim', name: 'Night Swim', identifiers: [{ namespace: 'isrc', value: 'GBNFR2500009' }], facts: { durationSec: 412, trackNumber: 1 } }],
	},
	// A date no store writes: refused alone.
	{ provider: 'user', kind: 'release', providerId: 'album:bad', name: 'Bad Date', facts: { releaseDate: '2026/13/40' }, label },
];

// What a Deezer tracker had already ingested of the EP: its first track, by ISRC.
async function seedDeezer(app: TestApp): Promise<string> {
	await withSystemTx(app.db, (tx) =>
		ingestClaims(
			tx,
			[
				{
					provider: 'deezer',
					kind: 'release',
					providerId: '991',
					name: 'Low Tide EP',
					identifiers: [{ namespace: 'upc', value: UPC }],
					facts: { releaseDate: '2026-06-12' },
					artists: [{ provider: 'deezer', kind: 'artist', providerId: '7', name: 'Glass Rivers' }],
					recordings: [{ provider: 'deezer', kind: 'recording', providerId: '11', name: 'Low Tide', identifiers: [{ namespace: 'isrc', value: 'GBNFR2600001' }], facts: { durationSec: 301 } }],
				},
			],
			{ reason: 'tracker' },
		),
	);
	const [r] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'deezer' and kind = 'release'`);
	return r!.object_id;
}

const count = async (app: TestApp, sql: string, params: string[] = []) => Number((await app.db.query<{ n: unknown }>(sql, params))[0]!.n);

describe('library import', () => {
	it('takes in a library: labels, releases joined to what the catalogue holds, each release queued for a fill — idempotent, a bad claim refused alone, a dry run writing nothing', async () => {
		const app = await createTestApp();
		const deezerRelease = await seedDeezer(app);
		const ops = adminOps(app.db, {});

		const objects = () => count(app, `select count(*) as n from curator.catalog_object`);
		const before = await objects();
		const dry = await ops.libraryImport({ claims: claims(), key: 'library:test:dry', dry: true });
		expect(dry).toMatchObject({ dry: true, fills: 2, profiles: 1 });
		expect(await objects()).toBe(before);

		const r = await ops.libraryImport({ claims: claims(), key: 'library:test:0' });
		expect(r.results.map((x) => ('rejected' in x ? 'rejected' : `${x.kind}${x.created ? '+' : '='}`))).toEqual(['label+', 'release=', 'release+', 'rejected']);
		expect(r).toMatchObject({ duplicate: false, fills: 2, profiles: 1 });
		// The EP joined the Deezer copy by UPC, its track by ISRC.
		const [ep] = r.results.slice(1) as { objectId: string }[];
		expect(ep!.objectId).toBe(deezerRelease);
		expect(await count(app, `select count(*) as n from curator.catalog_object where kind = 'recording'`)).toBe(2);
		const reps = await app.db.query<{ provider: string }>(
			`select so.provider from curator.catalog_identifier i join curator.catalog_source_object so on so.object_id = i.object_id where i.value = 'GBNFR2600001' order by so.provider`,
		);
		expect(reps.map((x) => x.provider)).toEqual(['deezer', 'spotify']);
		// Both releases are the label's.
		const labelId = (r.results[0] as { objectId: string }).objectId;
		expect(await count(app, `select count(*) as n from curator.catalog_edge where kind = 'release-label' and dst = $1`, [labelId])).toBe(2);
		// A fill per release and the label's profile …
		const tasks = await app.db.query<{ need: string; provider: string }>(`select need, provider from curator.catalog_enrich_task where need in ('fill', 'profile') order by need, provider`);
		expect(tasks.map((t) => `${t.need}/${t.provider}`)).toEqual(['fill/catalog', 'fill/catalog', 'profile/catalog']);
		// … and a Spotify id asked for the owner's own track, which has only its ISRC.
		const asked = await app.db.query<{ name: string }>(
			`select o.name from curator.catalog_enrich_task t join curator.catalog_object o on o.id = t.object_id where t.need = 'representation' and t.provider = 'spotify' and o.name = 'Night Swim'`,
		);
		expect(asked).toHaveLength(1);

		// The same batch again: its first answer, nothing redone.
		const after = await objects();
		const again = await ops.libraryImport({ claims: claims(), key: 'library:test:0' });
		expect(again).toMatchObject({ duplicate: true, created: r.created });
		expect(await objects()).toBe(after);
	});

	it('the device path (catalog.ingest, library_import) queues the fills too', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		await fan.api.catalog.ingest.mutate({ deviceId: fan.deviceId, reason: 'library_import', idempotencyKey: 'library-device-1', claims: claims().slice(0, 3) });
		expect(await count(app, `select count(*) as n from curator.catalog_enrich_task where need = 'fill'`)).toBe(2);
		// Labels are the device's own call (catalog.enrich), as before.
		expect(await count(app, `select count(*) as n from curator.catalog_enrich_task where need = 'profile'`)).toBe(0);
	});

	it("a device browses a label's releases and a release's tracks with their store handles, and an id merged away answers for its winner", async () => {
		const app = await createTestApp();
		await seedDeezer(app);
		const ops = adminOps(app.db, {});
		const r = await ops.libraryImport({ claims: claims().slice(0, 3), key: 'library:test:browse' });
		const labelId = (r.results[0] as { objectId: string }).objectId;
		const epId = (r.results[1] as { objectId: string }).objectId;
		const fan = await app.signIn();

		const l = await fan.api.catalog.browse.query({ deviceId: fan.deviceId, id: labelId });
		expect(l).toMatchObject({ object: { id: labelId, kind: 'label', name: LABEL }, redirectedFrom: null, releaseCount: 2 });
		expect(l.releases!.map((x) => x.title)).toEqual(['Low Tide EP', 'Night Swim']);
		expect(l.releases![0]!.handles.map((h) => `${h.provider}:${h.id}`)).toEqual(['deezer:991', `spotify:${SP_ALBUM}`]);

		const ep = await fan.api.catalog.browse.query({ deviceId: fan.deviceId, id: epId });
		expect(ep.release).toMatchObject({ date: '2026-06-12' });
		expect(ep.tracks).toMatchObject([{ title: 'Low Tide', position: 1, isrc: 'GBNFR2600001' }]);
		expect(ep.tracks![0]!.handles.map((h) => h.provider)).toEqual(['deezer', 'spotify']);

		// Another record of the label, merged into it: browsing the old id lands on the winner.
		const [old] = (await withSystemTx(app.db, (tx) => ingestClaims(tx, [{ provider: 'beatport', kind: 'label', providerId: '804', name: LABEL }], { reason: 'enrichment' }))).outcomes;
		await withSystemTx(app.db, (tx) => mergeObjects(tx, old!.objectId, labelId, 'test', 'same label'));
		const moved = await fan.api.catalog.browse.query({ deviceId: fan.deviceId, id: old!.objectId });
		expect(moved).toMatchObject({ object: { id: labelId }, redirectedFrom: old!.objectId });
	});
});

// The stores a fill reads: Spotify's album (two tracks, the UPC), Deezer by
// that UPC (ISRCs), with Deezer's quota when asked.
function stores(calls: string[], opts: { deezerQuota?: boolean } = {}): FetchLike {
	const artist = { id: 'B'.repeat(22), name: 'Glass Rivers' };
	const full = {
		id: SP_ALBUM,
		name: 'Low Tide EP',
		album_type: 'single',
		release_date: '2026-06-12',
		total_tracks: 2,
		label: LABEL,
		artists: [artist],
		external_ids: { upc: UPC },
		tracks: {
			items: [
				{ id: SP_TRACK, name: 'Low Tide', duration_ms: 301_000, track_number: 1, artists: [artist] },
				{ id: 'D'.repeat(22), name: 'Undertow', duration_ms: 288_000, track_number: 2, artists: [artist] },
			],
		},
	};
	const dzAlbum = { id: 991, title: 'Low Tide EP', upc: UPC, release_date: '2026-06-12', nb_tracks: 2, label: LABEL, artist: { id: 7, name: 'Glass Rivers' } };
	const dzTracks = {
		data: [
			{ id: 11, title: 'Low Tide', isrc: 'GBNFR2600001', duration: 301, track_position: 1, artist: { id: 7, name: 'Glass Rivers' } },
			{ id: 12, title: 'Undertow', isrc: 'GBNFR2600002', duration: 288, track_position: 2, artist: { id: 7, name: 'Glass Rivers' } },
		],
	};
	return async (u) => {
		const url = String(u);
		calls.push(url.replace(/^https:\/\/[^/]+/, '').split('?')[0]!);
		if (url.includes('accounts.spotify.com')) return json({ access_token: 't', expires_in: 3600 });
		if (url.includes('/v1/albums?ids=')) return json({ albums: [full] });
		if (url.includes('api.deezer.com') && opts.deezerQuota) return json({ error: { code: 4, message: 'Quota limit exceeded' } });
		if (url.includes(`/album/upc%3A${UPC}`) || url.includes(`/album/upc:${UPC}`) || /\/album\/991($|\?)/.test(url)) return json(dzAlbum);
		if (url.includes('/album/991/tracks')) return json(dzTracks);
		return json({ error: { code: 800, message: 'no data' } });
	};
}

describe('release filler', () => {
	it("reads a library's release in full from its stores, charges the day's budgets, and is done", async () => {
		const app = await createTestApp();
		const ops = adminOps(app.db, {});
		const r = await ops.libraryImport({ claims: claims().slice(0, 2), key: 'library:test:fill' });
		const epId = (r.results[1] as { objectId: string }).objectId;
		const calls: string[] = [];
		const fetchFn = stores(calls);
		const fetchers = { spotify: new SpotifyAppTracker({ clientId: 'id', clientSecret: 's' }, fetchFn), deezer: new DeezerTracker(fetchFn), apple: null, tidal: null };
		expect(await runReleaseFiller({ db: app.db, fetchers, holder: 'test' })).toMatchObject({ attempted: 1, done: 1, later: 0 });
		const tracks = await app.db.query<{ name: string; isrc: string | null }>(
			`select o.name, (select value from curator.catalog_identifier i where i.object_id = o.id and i.namespace = 'isrc') as isrc
			from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst where e.src = $1 and e.kind = 'release-recording' order by e.position`,
			[epId],
		);
		expect(tracks).toEqual([
			{ name: 'Low Tide', isrc: 'GBNFR2600001' },
			{ name: 'Undertow', isrc: 'GBNFR2600002' },
		]);
		expect(await count(app, `select count(*) as n from curator.catalog_enrich_task where need = 'fill'`)).toBe(0);
		const used = await app.db.query<{ provider: string }>(`select provider from curator.provider_budget where units_used > 0 order by provider`);
		expect(used.map((u) => u.provider)).toEqual(expect.arrayContaining(['deezer', 'spotify']));
		// Nothing left: a second pass leases nothing.
		expect(await runReleaseFiller({ db: app.db, fetchers, holder: 'test' })).toMatchObject({ attempted: 0 });
	});

	it("a store's quota brings the release back later, without counting it a failure", async () => {
		const app = await createTestApp();
		const ops = adminOps(app.db, {});
		// A user-keyed release on Deezer only (by its UPC): nothing but Deezer to read it from.
		await ops.libraryImport({
			claims: [label, { provider: 'user', kind: 'release', providerId: 'album:local-ep', name: 'Low Tide EP', identifiers: [{ namespace: 'upc', value: UPC }], facts: { trackCount: 2 }, label }],
			key: 'library:test:quota',
		});
		const fetchFn = stores([], { deezerQuota: true });
		const r = await runReleaseFiller({ db: app.db, fetchers: { spotify: null, deezer: new DeezerTracker(fetchFn), apple: null, tidal: null }, holder: 'test' });
		expect(r).toMatchObject({ attempted: 1, done: 0, later: 1, parked: ['deezer'] });
		const [t] = await app.db.query<{ attempts: unknown; later: boolean; last_error: string }>(
			`select attempts, next_due_at > now() + interval '5 hours' as later, last_error from curator.catalog_enrich_task where need = 'fill'`,
		);
		expect({ attempts: Number(t!.attempts), later: t!.later }).toEqual({ attempts: 0, later: true });
		expect(t!.last_error).toMatch(/^deezer: .*rate limited/);
	});
});

// A label Deezer lists fifty albums of: four expanded a poll, ten polls a run.
function deezerLabel(albums: number): FetchLike {
	return async (u) => {
		const url = new URL(String(u));
		if (url.pathname === '/search/album') return json({ data: Array.from({ length: albums }, (_, i) => ({ id: i + 1, title: `Glass ${i + 1}`, release_date: '2024-01-01' })) });
		const m = /^\/album\/(\d+)(\/tracks)?$/.exec(url.pathname);
		if (m && m[2]) return json({ data: [{ id: Number(m[1]) * 100, title: `Glass ${m[1]}`, isrc: `GBNFR24${String(m[1]).padStart(5, '0')}`, duration: 300, track_position: 1, artist: { id: 7, name: 'Kaske' } }] });
		if (m) return json({ id: Number(m[1]), title: `Glass ${m[1]}`, release_date: '2024-01-01', label: LABEL, artist: { id: 7, name: 'Kaske' } });
		return json({ error: { code: 800, message: 'no data' } });
	};
}

describe('label backfill', () => {
	it("reads a label's whole listing, a run at a time, from the cursor it keeps", async () => {
		const app = await createTestApp();
		const [l] = (await withSystemTx(app.db, (tx) => ingestClaims(tx, [label], { reason: 'library_import' }))).outcomes;
		await app.db.query(`insert into curator.catalog_enrich_task (object_id, need, provider) values ($1, 'backfill', 'deezer')`, [l!.objectId]);
		const adapters = [new DeezerTracker(deezerLabel(50))];
		const run = () => runBackfill({ db: app.db, log: quiet, adapters, holder: 'test', sleep: async () => {} });
		const releases = () => count(app, `select count(*) as n from curator.catalog_object where kind = 'release'`);

		// Ten polls of four: forty albums, and the task comes due again with its place kept.
		expect(await run()).toMatchObject({ attempted: 1, done: 0, claims: 40 });
		expect(await releases()).toBe(40);
		const [t] = await app.db.query<{ state: string; due: boolean }>(`select state::text as state, next_due_at <= now() as due from curator.catalog_enrich_task where need = 'backfill'`);
		expect((JSON.parse(t!.state) as { seen: string[] }).seen).toHaveLength(40);
		expect(t!.due).toBe(true);

		// The next pass reads the last ten and is done.
		expect(await run()).toMatchObject({ attempted: 1, done: 1, claims: 10 });
		expect(await releases()).toBe(50);
		expect(await count(app, `select count(*) as n from curator.catalog_enrich_task where need = 'backfill'`)).toBe(0);
		// Read for the catalogue, not for anyone's feed.
		expect(await count(app, `select count(*) as n from curator.catalog_event`)).toBe(0);
	});
});
