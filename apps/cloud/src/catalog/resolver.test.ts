// The recording resolver: a track a tracker found elsewhere gets its Spotify
// id by ISRC, its release the album's, and the events about them are
// re-announced with the new handles. Fake Spotify, made-up names.

import { describe, expect, it } from 'vitest';
import type { CatalogEventCardV1 } from '@curator/protocol';
import { withSystemTx } from '../db/system-tx.js';
import { createLogger } from '../log.js';
import { createTestApp } from '../test/harness.js';
import { raiseReleaseEvent } from './events.js';
import { ingestClaims, Ingester } from './ingest.js';
import { runIsrcFill, runRecordingResolver } from './planner.js';
import type { FetchLike } from '@curator/catalog-readers';
import { SpotifyTracker } from '@curator/catalog-readers';
import { appCredentialsToken } from './spotify-app-token.js';
const quiet = createLogger(() => {});
const today = new Date().toISOString().slice(0, 10);

type FakeAlbum = { name: string; tracks: { id: string; name: string; duration_ms: number }[] };

function fakeSpotify(
	hits: Record<string, { id: string; duration_ms: number; isrc?: string }[]>,
	tracks: Record<string, { isrc?: string; duration_ms?: number }> = {},
	albums: Record<string, FakeAlbum> = {},
): { fetch: FetchLike; searches: string[]; batches: string[][]; albumReads: string[][] } {
	const searches: string[] = [];
	const batches: string[][] = [];
	const albumReads: string[][] = [];
	const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
	const fetch: FetchLike = async (input) => {
		const u = new URL(input);
		if (u.hostname === 'accounts.spotify.com') return json({ access_token: 'tok', expires_in: 3600 });
		if (u.pathname === '/v1/albums') {
			const ids = (u.searchParams.get('ids') ?? '').split(',');
			albumReads.push(ids);
			return json({
				albums: ids.map((id) =>
					albums[id]
						? { id, name: albums[id]!.name, album_type: 'single', release_date: today, total_tracks: albums[id]!.tracks.length, artists: [{ id: 'sa1', name: 'Northfold' }], tracks: { items: albums[id]!.tracks.map((t, i) => ({ ...t, track_number: i + 1, artists: [{ id: 'sa1', name: 'Northfold' }] })) } }
						: null,
				),
			});
		}
		if (u.pathname === '/v1/tracks') {
			const ids = (u.searchParams.get('ids') ?? '').split(',');
			batches.push(ids);
			return json({ tracks: ids.map((id) => (tracks[id] ? { id, duration_ms: tracks[id]!.duration_ms, external_ids: tracks[id]!.isrc ? { isrc: tracks[id]!.isrc } : {} } : null)) });
		}
		if (u.pathname === '/v1/search') {
			const isrc = /isrc:(\w+)/.exec(u.searchParams.get('q') ?? '')?.[1] ?? '';
			searches.push(isrc);
			return json({
				tracks: {
					items: (hits[isrc] ?? []).map((h) => ({
						id: h.id,
						name: 'Glass Rivers',
						duration_ms: h.duration_ms,
						external_ids: { isrc: h.isrc ?? isrc },
						external_urls: { spotify: `https://open.spotify.com/track/${h.id}` },
						artists: [{ id: 'sa1', name: 'Northfold' }],
						album: { id: 'al1', name: 'Glass Rivers', album_type: 'single', release_date: today, release_date_precision: 'day', total_tracks: 1, images: [{ url: 'https://img.test/a.jpg' }], artists: [{ id: 'sa1', name: 'Northfold' }] },
					})),
				},
			});
		}
		return new Response('{}', { status: 404 });
	};
	return { fetch, searches, batches, albumReads };
}

async function seed(app: Awaited<ReturnType<typeof createTestApp>>) {
	// A release found by Beatport's tracker, with one track, announced to a watcher.
	const fan = await app.signIn();
	const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: { provider: 'beatport', kind: 'label', providerId: '804', name: 'Northfold Records' }, source: 'manual' });
	const { releaseId, recordingId } = await withSystemTx(app.db, async (tx) => {
		const r = await ingestClaims(
			tx,
			[
				{
					provider: 'beatport',
					kind: 'release',
					providerId: '1',
					name: 'Glass Rivers',
					identifiers: [{ namespace: 'upc', value: '0123456789012' }],
					facts: { releaseDate: today },
					artists: [{ provider: 'beatport', kind: 'artist', providerId: '77', name: 'Northfold' }],
					recordings: [{ provider: 'beatport', kind: 'recording', providerId: '11', name: 'Glass Rivers', identifiers: [{ namespace: 'isrc', value: 'GBAAA2600001' }], facts: { durationSec: 401 } }],
					label: { provider: 'beatport', kind: 'label', providerId: '804', name: 'Northfold Records' },
				},
			],
			{ reason: 'tracker' },
		);
		const releaseId = r.outcomes[0]!.objectId;
		await raiseReleaseEvent(tx, { releaseId, trackedId: w.watch.object.id, publishedAt: null }, { nowMs: Date.now(), windowDays: 14 });
		const [rec] = await tx.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'beatport' and kind = 'recording' and provider_id = '11'`);
		return { releaseId, recordingId: rec!.object_id };
	});
	return { fan, releaseId, recordingId };
}

const handles = (card: CatalogEventCardV1) => ({ release: card.handles.map((h) => h.provider).sort(), track: card.tracks[0]!.handles.map((h) => h.provider).sort() });

describe('recording resolver', () => {
	it('gives a track and its release their Spotify ids by ISRC and re-announces the event', async () => {
		const app = await createTestApp();
		const { fan, releaseId, recordingId } = await seed(app);
		await app.pg.query(`update curator.catalog_event set first_seen_at = first_seen_at - interval '5 minutes'`);
		const before = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: 0 });
		expect(handles(before.events[0]!.card as CatalogEventCardV1)).toEqual({ release: ['beatport'], track: ['beatport'] });

		const { fetch, searches, albumReads } = fakeSpotify({ GBAAA2600001: [{ id: 'st-wrong', duration_ms: 601_000 }, { id: 'st1', duration_ms: 401_500 }] });
		const r = await runRecordingResolver({ db: app.db, log: quiet, spotify: new SpotifyTracker({ token: appCredentialsToken({ clientId: 'id', clientSecret: 'secret' }, fetch) }, fetch) });
		expect(r).toEqual({ attempted: 1, resolved: 1 });
		expect(searches).toEqual(['GBAAA2600001']);
		// The hit's album was read in full for the release (Spotify knew no such album here: the simplified one is attached).
		expect(albumReads).toEqual([['al1']]);
		const reps = await app.db.query<{ object_id: string; provider_id: string }>(`select object_id, provider_id from curator.catalog_source_object where provider = 'spotify' order by kind`);
		expect(reps).toEqual([
			{ object_id: recordingId, provider_id: 'st1' },
			{ object_id: releaseId, provider_id: 'al1' },
		]);
		// The event moved past the device's cursor with both providers on it.
		await app.pg.query(`update curator.catalog_event set first_seen_at = first_seen_at - interval '5 minutes'`);
		const after = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: before.nextSeq });
		expect(after.events).toHaveLength(1);
		expect(handles(after.events[0]!.card as CatalogEventCardV1)).toEqual({ release: ['beatport', 'spotify'], track: ['beatport', 'spotify'] });
		const [tasks] = await app.db.query<{ n: unknown }>(`select count(*) as n from curator.catalog_enrich_task where need = 'representation' and provider = 'spotify'`);
		expect(Number(tasks!.n)).toBe(0);
	});

	it('reads the release’s known Spotify album once instead of searching each of its tracks', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: { provider: 'beatport', kind: 'label', providerId: '804', name: 'Northfold Records' }, source: 'manual' });
		// Beatport's release with two tracks; its Spotify album attached by an
		// earlier lookup without its tracklist, as the resolver used to.
		const { releaseId, recIds } = await withSystemTx(app.db, async (tx) => {
			const r = await ingestClaims(
				tx,
				[
					{
						provider: 'beatport',
						kind: 'release',
						providerId: '2',
						name: 'Low Tide EP',
						facts: { releaseDate: today },
						artists: [{ provider: 'beatport', kind: 'artist', providerId: '77', name: 'Northfold' }],
						recordings: [
							{ provider: 'beatport', kind: 'recording', providerId: '21', name: 'Low Tide', identifiers: [{ namespace: 'isrc', value: 'GBAAA2600011' }], facts: { durationSec: 301, trackNumber: 1 } },
							{ provider: 'beatport', kind: 'recording', providerId: '22', name: 'Undertow', identifiers: [{ namespace: 'isrc', value: 'GBAAA2600012' }], facts: { durationSec: 288, trackNumber: 2 } },
						],
						label: { provider: 'beatport', kind: 'label', providerId: '804', name: 'Northfold Records' },
					},
				],
				{ reason: 'tracker' },
			);
			const releaseId = r.outcomes[0]!.objectId;
			await new Ingester(tx, { reason: 'enrichment' }).attachTo(releaseId, { provider: 'spotify', kind: 'release', providerId: 'al9', name: 'Low Tide EP' });
			await raiseReleaseEvent(tx, { releaseId, trackedId: w.watch.object.id, publishedAt: null }, { nowMs: Date.now(), windowDays: 14 });
			const recs = await tx.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'beatport' and kind = 'recording' order by provider_id`);
			return { releaseId, recIds: recs.map((x) => x.object_id) };
		});
		const { fetch, searches, albumReads } = fakeSpotify({}, {}, { al9: { name: 'Low Tide EP', tracks: [{ id: 'st21', name: 'Low Tide', duration_ms: 301_000 }, { id: 'st22', name: 'Undertow (feat. Northern Drift)', duration_ms: 288_400 }] } });
		const r = await runRecordingResolver({ db: app.db, log: quiet, spotify: new SpotifyTracker({ token: appCredentialsToken({ clientId: 'id', clientSecret: 'secret' }, fetch) }, fetch) });
		expect(r).toEqual({ attempted: 2, resolved: 2 });
		expect(searches).toEqual([]);
		expect(albumReads).toEqual([['al9']]);
		const reps = await app.db.query<{ object_id: string; provider_id: string }>(`select object_id, provider_id from curator.catalog_source_object where provider = 'spotify' and kind = 'recording' order by provider_id`);
		expect(reps).toEqual([
			{ object_id: recIds[0], provider_id: 'st21' },
			{ object_id: recIds[1], provider_id: 'st22' },
		]);
		const [tasks] = await app.db.query<{ n: unknown }>(`select count(*) as n from curator.catalog_enrich_task where need = 'representation' and provider = 'spotify'`);
		expect(Number(tasks!.n)).toBe(0);
		// The event's card now plays both rows.
		const [ev] = await app.db.query<{ card: string }>(`select card::text as card from curator.catalog_event where subject_id = $1`, [releaseId]);
		expect((JSON.parse(ev!.card) as CatalogEventCardV1).tracks.map((t) => t.handles.map((h) => h.provider).sort())).toEqual([['beatport', 'spotify'], ['beatport', 'spotify']]);
	});

	it('the ISRC fill gives Spotify-minted recordings their ISRCs, folding one onto the recording its ISRC already names', async () => {
		const app = await createTestApp();
		const { recordingId } = await seed(app);
		// A Spotify single read by its tracker: no ISRCs, and credits the
		// identity rules cannot join to Beatport's track (a second name).
		const spotifyReleaseId = await withSystemTx(app.db, async (tx) => {
			const r = await ingestClaims(
				tx,
				[
					{
						provider: 'spotify',
						kind: 'release',
						providerId: 'al2',
						name: 'Glass Rivers (Single)',
						identifiers: [{ namespace: 'upc', value: '0123456789099' }],
						facts: { releaseDate: today },
						artists: [{ provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'Northfold' }],
						recordings: [
							{ provider: 'spotify', kind: 'recording', providerId: 'st1', name: 'Glass Rivers', facts: { durationSec: 401.5, trackNumber: 1 }, artists: [{ provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'Northfold' }, { provider: 'spotify', kind: 'artist', providerId: 'sa2', name: 'Ilka Rane' }] },
							{ provider: 'spotify', kind: 'recording', providerId: 'st2', name: 'Glass Rivers (Dub)', facts: { durationSec: 380, trackNumber: 2 } },
							{ provider: 'spotify', kind: 'recording', providerId: 'st3', name: 'Glass Rivers (Tool)', facts: { durationSec: 120, trackNumber: 3 } },
						],
					},
				],
				{ reason: 'tracker' },
			);
			return r.outcomes[0]!.objectId;
		});
		const gaps = async () => Number((await app.db.query<{ n: unknown }>(`select count(*) as n from curator.catalog_enrich_task where need = 'isrc'`))[0]!.n);
		expect(await gaps()).toBe(3);
		// st1 is Beatport's track (its ISRC, 401 s); st2 has an ISRC of its own;
		// st3 Spotify knows no ISRC for.
		const { fetch, batches } = fakeSpotify({}, { st1: { isrc: 'GBAAA2600001', duration_ms: 401_500 }, st2: { isrc: 'GBAAA2600009', duration_ms: 380_000 }, st3: { duration_ms: 120_000 } });
		const r = await runIsrcFill({ db: app.db, log: quiet, spotify: new SpotifyTracker({ token: appCredentialsToken({ clientId: 'id', clientSecret: 'secret' }, fetch) }, fetch) });
		expect(r).toEqual({ attempted: 3, filled: 1, merged: 1 });
		expect(batches).toHaveLength(1);
		expect([...batches[0]!].sort()).toEqual(['st1', 'st2', 'st3']);
		expect(await gaps()).toBe(0);
		const reps = await app.db.query<{ provider_id: string; object_id: string }>(`select provider_id, object_id from curator.catalog_source_object where provider = 'spotify' and kind = 'recording' order by provider_id`);
		expect(reps.find((x) => x.provider_id === 'st1')!.object_id).toBe(recordingId);
		const isrcs = await app.db.query<{ value: string }>(`select value from curator.catalog_identifier where namespace = 'isrc' order by value`);
		expect(isrcs.map((x) => x.value)).toEqual(['GBAAA2600001', 'GBAAA2600009']);
		// The single holds three tracks still — one of them now Beatport's recording.
		const held = await app.db.query<{ n: unknown }>(`select count(*) as n from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst and o.merged_into is null where e.src = $1 and e.kind = 'release-recording'`, [spotifyReleaseId]);
		expect(Number(held[0]!.n)).toBe(3);
	});

	it('a miss, or a hit of a different length, backs off and keeps the task', async () => {
		const app = await createTestApp();
		await seed(app);
		const { fetch } = fakeSpotify({ GBAAA2600001: [{ id: 'st-long', duration_ms: 720_000 }] });
		const r = await runRecordingResolver({ db: app.db, log: quiet, spotify: new SpotifyTracker({ token: appCredentialsToken({ clientId: 'id', clientSecret: 'secret' }, fetch) }, fetch) });
		expect(r).toEqual({ attempted: 1, resolved: 0 });
		const [task] = await app.db.query<{ attempts: unknown; last_error: string; later: boolean }>(
			`select attempts, last_error, next_due_at > now() as later from curator.catalog_enrich_task where need = 'representation' and provider = 'spotify'`,
		);
		expect(task).toMatchObject({ last_error: 'not_found', later: true });
		expect(Number(task!.attempts)).toBe(1);
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'spotify'`)).toEqual([]);
	});
});
