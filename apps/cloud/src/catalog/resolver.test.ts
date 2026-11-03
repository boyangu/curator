// The recording resolver: a track a tracker found elsewhere gets its Spotify
// id by ISRC, its release the album's, and the events about them are
// re-announced with the new handles. Fake Spotify, made-up names.

import { describe, expect, it } from 'vitest';
import type { CatalogEventCardV1 } from '@curator/protocol';
import { withSystemTx } from '../db/system-tx.js';
import { createLogger } from '../log.js';
import { createTestApp } from '../test/harness.js';
import { raiseReleaseEvent } from './events.js';
import { ingestClaims } from './ingest.js';
import { runRecordingResolver } from './planner.js';
import type { FetchLike } from './trackers/http.js';
import { SpotifyAppTracker } from './trackers/spotify-app.js';

const quiet = createLogger(() => {});
const today = new Date().toISOString().slice(0, 10);

function fakeSpotify(hits: Record<string, { id: string; duration_ms: number; isrc?: string }[]>): { fetch: FetchLike; searches: string[] } {
	const searches: string[] = [];
	const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
	const fetch: FetchLike = async (input) => {
		const u = new URL(input);
		if (u.hostname === 'accounts.spotify.com') return json({ access_token: 'tok', expires_in: 3600 });
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
	return { fetch, searches };
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

		const { fetch, searches } = fakeSpotify({ GBAAA2600001: [{ id: 'st-wrong', duration_ms: 601_000 }, { id: 'st1', duration_ms: 401_500 }] });
		const r = await runRecordingResolver({ db: app.db, log: quiet, spotify: new SpotifyAppTracker({ clientId: 'id', clientSecret: 'secret' }, fetch) });
		expect(r).toEqual({ attempted: 1, resolved: 1 });
		expect(searches).toEqual(['GBAAA2600001']);
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

	it('a miss, or a hit of a different length, backs off and keeps the task', async () => {
		const app = await createTestApp();
		await seed(app);
		const { fetch } = fakeSpotify({ GBAAA2600001: [{ id: 'st-long', duration_ms: 720_000 }] });
		const r = await runRecordingResolver({ db: app.db, log: quiet, spotify: new SpotifyAppTracker({ clientId: 'id', clientSecret: 'secret' }, fetch) });
		expect(r).toEqual({ attempted: 1, resolved: 0 });
		const [task] = await app.db.query<{ attempts: unknown; last_error: string; later: boolean }>(
			`select attempts, last_error, next_due_at > now() as later from curator.catalog_enrich_task where need = 'representation' and provider = 'spotify'`,
		);
		expect(task).toMatchObject({ last_error: 'not_found', later: true });
		expect(Number(task!.attempts)).toBe(1);
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'spotify'`)).toEqual([]);
	});
});
