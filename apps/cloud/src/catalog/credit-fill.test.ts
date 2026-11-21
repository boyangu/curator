// Track credits only Deezer stated (credits.ts): queued where the state
// arises, read from Spotify's album, put off when the read settles nothing.
// Fake Spotify, made-up names.

import type { CatalogClaim } from '@curator/protocol';
import { SpotifyTracker, type FetchLike } from '@curator/catalog-readers';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import { createLogger } from '../log.js';
import { createTestApp, createTestDb } from '../test/harness.js';
import { runCreditFill } from './credit-fill.js';
import { ingestClaims, Ingester } from './ingest.js';
import { appCredentialsToken } from './spotify-app-token.js';

const quiet = createLogger(() => {});
const noSleep = async () => {};

const sp = (id: string, name: string) => ({ id, name });
type FakeTrack = { id: string; name: string; duration_ms: number; artists: { id: string; name: string }[] };

function fakeSpotify(albums: Record<string, { name: string; artists: { id: string; name: string }[]; tracks: FakeTrack[] }>): { fetch: FetchLike; reads: string[][] } {
	const reads: string[][] = [];
	const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
	const fetch: FetchLike = async (input) => {
		const u = new URL(input);
		if (u.hostname === 'accounts.spotify.com') return json({ access_token: 'tok', expires_in: 3600 });
		if (u.pathname === '/v1/albums') {
			const ids = (u.searchParams.get('ids') ?? '').split(',');
			reads.push(ids);
			return json({
				albums: ids.map((id) => {
					const a = albums[id];
					return a ? { id, name: a.name, album_type: 'single', release_date: '2026-03-25', total_tracks: a.tracks.length, artists: a.artists, tracks: { items: a.tracks.map((t, i) => ({ ...t, track_number: i + 1 })) } } : null;
				}),
			});
		}
		return new Response('{}', { status: 404 });
	};
	return { fetch, reads };
}
const tracker = (fetch: FetchLike) => new SpotifyTracker({ token: appCredentialsToken({ clientId: 'id', clientSecret: 'secret' }, fetch) }, fetch);

const OMBER = sp('sa1', 'Omber Vale');
const BRACK = sp('sa2', 'Brack Wight');
const GALEN = sp('sa3', 'Galen Kine');
const spArtist = (a: { id: string; name: string }): CatalogClaim => ({ provider: 'spotify', kind: 'artist', providerId: a.id, name: a.name });
const dzArtist = (id: string, name: string): CatalogClaim => ({ provider: 'deezer', kind: 'artist', providerId: id, name });

// Spotify's listing of the single: its three artists, no tracklist.
const spotifyListing: CatalogClaim = {
	provider: 'spotify',
	kind: 'release',
	providerId: 'al1',
	name: 'Slate Blue',
	facts: { releaseDate: '2026-03-25', releaseType: 'single', trackCount: 1 },
	artists: [OMBER, BRACK, GALEN].map(spArtist),
};
// Deezer's copy as its tracklist credits it: the primary artist on the track.
const deezerFull = (tracks: { id: string; title: string; n: number; len: number }[] = [{ id: 'dt1', title: 'Slate Blue', n: 1, len: 218 }]): CatalogClaim => ({
	provider: 'deezer',
	kind: 'release',
	providerId: 'dz1',
	name: 'Slate Blue',
	facts: { releaseDate: '2026-03-25', releaseType: 'single', trackCount: tracks.length },
	artists: [dzArtist('d1', 'Omber Vale'), dzArtist('d2', 'Brack Wight'), dzArtist('d3', 'Galen Kine')],
	recordings: tracks.map((t) => ({ provider: 'deezer' as const, kind: 'recording' as const, providerId: t.id, name: t.title, facts: { durationSec: t.len, trackNumber: t.n }, artists: [dzArtist('d1', 'Omber Vale')] })),
});
const spotifyAlbum = { name: 'Slate Blue', artists: [OMBER, BRACK, GALEN], tracks: [{ id: 'st1', name: 'Slate Blue', duration_ms: 218_400, artists: [OMBER, BRACK, GALEN] }] };

const tasks = (db: Db) =>
	db.query<{ provider: string; days: unknown; attempts: unknown; last_error: string | null }>(
		`select provider, round(extract(epoch from next_due_at - now()) / 86400) as days, attempts, last_error from curator.catalog_enrich_task where need = 'credits' order by provider`,
	);
const credits = async (db: Db, title: string) =>
	(
		await db.query<{ name: string }>(
			`select a.name from curator.catalog_object o join curator.catalog_edge e on e.src = o.id and e.kind = 'recording-artist' join curator.catalog_object a on a.id = e.dst
			where o.kind = 'recording' and o.name = $1 and o.merged_into is null order by e.position, a.name`,
			[title],
		)
	).map((r) => r.name);

describe('track credits only Deezer stated', () => {
	it("queues the release when Deezer's tracklist lands beside a Spotify page, and the album read adds the other artists", async () => {
		const { db } = await createTestDb();
		await withSystemTx(db, (tx) => ingestClaims(tx, [spotifyListing], { reason: 'tracker' }));
		expect(await tasks(db)).toEqual([]);
		await withSystemTx(db, (tx) => ingestClaims(tx, [deezerFull()], { reason: 'enrichment' }));
		expect(await credits(db, 'Slate Blue')).toEqual(['Omber Vale']);
		expect((await tasks(db)).map((t) => t.provider)).toEqual(['spotify']);

		const { fetch, reads } = fakeSpotify({ al1: spotifyAlbum });
		const r = await runCreditFill({ db, log: quiet, spotify: tracker(fetch), sleep: noSleep });
		expect(r).toMatchObject({ attempted: 1, settled: 1, putOff: 0, dropped: 0, parked: [] });
		expect(reads).toEqual([['al1']]);
		// Deezer's credit stays first; Spotify's two join it. One recording, on both stores.
		expect(await credits(db, 'Slate Blue')).toEqual(['Omber Vale', 'Brack Wight', 'Galen Kine']);
		const reps = await db.query<{ provider: string }>(`select so.provider from curator.catalog_source_object so join curator.catalog_object o on o.id = so.object_id and o.kind = 'recording' order by so.provider`);
		expect(reps.map((x) => x.provider)).toEqual(['deezer', 'spotify']);
		expect(await tasks(db)).toEqual([]);

		// Settled: nothing to read on the next pass.
		reads.length = 0;
		expect(await runCreditFill({ db, log: quiet, spotify: tracker(fetch), sleep: noSleep })).toMatchObject({ attempted: 0 });
		expect(reads).toEqual([]);
	});

	it('queues nothing while the release is on no store that credits in full, and queues it when a page is linked', async () => {
		const { db } = await createTestDb();
		const [out] = (await withSystemTx(db, (tx) => ingestClaims(tx, [deezerFull()], { reason: 'tracker' }))).outcomes;
		expect(await tasks(db)).toEqual([]);
		// A bare page link (`release link`, a device's match): no tracklist with it.
		await withSystemTx(db, (tx) => new Ingester(tx, { reason: 'enrichment' }).attachTo(out!.objectId, { provider: 'spotify', kind: 'release', providerId: 'al1', name: 'Slate Blue' }));
		expect((await tasks(db)).map((t) => t.provider)).toEqual(['spotify']);
	});

	it('queues nothing when the store that credits in full was read first', async () => {
		const { db } = await createTestDb();
		const full: CatalogClaim = {
			...spotifyListing,
			recordings: [{ provider: 'spotify', kind: 'recording', providerId: 'st1', name: 'Slate Blue', facts: { durationSec: 218.4, trackNumber: 1 }, artists: [OMBER, BRACK, GALEN].map(spArtist) }],
		};
		await withSystemTx(db, (tx) => ingestClaims(tx, [full], { reason: 'enrichment' }));
		await withSystemTx(db, (tx) => ingestClaims(tx, [deezerFull()], { reason: 'enrichment' }));
		expect(await credits(db, 'Slate Blue')).toEqual(['Omber Vale', 'Brack Wight', 'Galen Kine']);
		expect(await tasks(db)).toEqual([]);
	});

	it('puts a release off for a month when the album leaves a track to Deezer alone, and drops a task nothing needs', async () => {
		const { db } = await createTestDb();
		await withSystemTx(db, (tx) => ingestClaims(tx, [spotifyListing], { reason: 'tracker' }));
		// Deezer's edition holds a second track Spotify's album does not.
		await withSystemTx(db, (tx) =>
			ingestClaims(tx, [deezerFull([{ id: 'dt1', title: 'Slate Blue', n: 1, len: 218 }, { id: 'dt2', title: 'Harbour Light', n: 2, len: 305 }])], { reason: 'enrichment' }),
		);
		const { fetch, reads } = fakeSpotify({ al1: spotifyAlbum });
		const r = await runCreditFill({ db, log: quiet, spotify: tracker(fetch), sleep: noSleep });
		expect(r).toMatchObject({ attempted: 1, settled: 0, putOff: 1 });
		expect(await credits(db, 'Slate Blue')).toEqual(['Omber Vale', 'Brack Wight', 'Galen Kine']);
		expect(await credits(db, 'Harbour Light')).toEqual(['Omber Vale']);
		expect((await tasks(db)).map((t) => `${t.provider}:${Number(t.days)}:${Number(t.attempts)}`)).toEqual(['spotify:30:1']);
		// Not due: no call. Made due again with the track gone from the release: dropped, no call.
		reads.length = 0;
		await runCreditFill({ db, log: quiet, spotify: tracker(fetch), sleep: noSleep });
		expect(reads).toEqual([]);
		await db.query(`delete from curator.catalog_edge e using curator.catalog_object o where o.id = e.dst and o.name = 'Harbour Light' and e.kind = 'release-recording'`);
		await db.query(`update curator.catalog_enrich_task set next_due_at = now() where need = 'credits'`);
		expect(await runCreditFill({ db, log: quiet, spotify: tracker(fetch), sleep: noSleep })).toMatchObject({ attempted: 0, dropped: 1 });
		expect(reads).toEqual([]);
		expect(await tasks(db)).toEqual([]);
	});

	it('queues a release held from before the rule when a device opens a page listing it', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const [out] = (await withSystemTx(app.db, (tx) => ingestClaims(tx, [spotifyListing, deezerFull()], { reason: 'tracker' }))).outcomes;
		await app.db.query(`delete from curator.catalog_enrich_task where need = 'credits'`);
		const page = await fan.api.catalog.tracks.query({ deviceId: fan.deviceId, id: out!.objectId });
		expect(page.releases[0]!.tracks[0]!.artists.map((a) => a.name)).toEqual(['Omber Vale']);
		expect((await tasks(app.db)).map((t) => t.provider)).toEqual(['spotify']);
	});
});
