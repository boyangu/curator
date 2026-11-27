// Event cards v2: the facts a DJ card shows ride on the card itself — BPM,
// key and genres per track, the catalogue number and UPC per release, the
// label on a track card — so a device renders them with no call back and no
// scrape of its own. Made-up names.

import { describe, expect, it } from 'vitest';
import type { CatalogEventCardV2, CatalogEventTrackCardV2 } from '@curator/protocol';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp } from '../test/harness.js';
import { mergeObjects } from './admin.js';
import { rebuildCards } from './card-rebuild.js';
import { markCards, raisePlaylistAdds, raiseReleaseEvent, releaseCard } from './events.js';
import { ingestClaims, Ingester } from './ingest.js';

const today = new Date().toISOString().slice(0, 10);

async function seed() {
	const app = await createTestApp();
	const ids = await withSystemTx(app.db, async (tx) => {
		const r = await ingestClaims(
			tx,
			[
				{
					provider: 'beatport',
					kind: 'release',
					providerId: '1',
					name: 'Glass Rivers',
					identifiers: [{ namespace: 'upc', value: '0123456789012' }],
					facts: { releaseDate: today, catalogNumber: 'NFR042' },
					artists: [{ provider: 'beatport', kind: 'artist', providerId: '77', name: 'Northfold' }],
					label: { provider: 'beatport', kind: 'label', providerId: '804', name: 'Northfold Records' },
					genres: ['Melodic House & Techno'],
					recordings: [
						{
							provider: 'beatport',
							kind: 'recording',
							providerId: '11',
							name: 'Glass Rivers',
							identifiers: [{ namespace: 'isrc', value: 'GBAAA2600001' }],
							facts: { durationSec: 401, bpm: 122, key: 'A Minor' },
							genres: ['Melodic House & Techno', 'Progressive House'],
						},
						{ provider: 'beatport', kind: 'recording', providerId: '12', name: 'Low Tide', facts: { durationSec: 380 } },
					],
				},
				{ provider: 'spotify', kind: 'playlist', providerId: 'pl1', name: 'Deep Picks' },
			],
			{ reason: 'tracker' },
		);
		const releaseId = r.outcomes[0]!.objectId;
		const playlistId = r.outcomes[1]!.objectId;
		const [label] = await tx.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'beatport' and kind = 'label' and provider_id = '804'`);
		const [rec] = await tx.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'beatport' and kind = 'recording' and provider_id = '11'`);
		return { releaseId, playlistId, labelId: label!.object_id, recordingId: rec!.object_id };
	});
	return { app, ...ids };
}

describe('event cards v2', () => {
	it('a release card carries its catalogue number, UPC and each track’s BPM, key and genres', async () => {
		const { app, releaseId } = await seed();
		const card = await withSystemTx(app.db, (tx) => releaseCard(tx, releaseId));
		expect(card).toMatchObject({ version: 2, kind: 'release', title: 'Glass Rivers', catalogNumber: 'NFR042', upc: '123456789012', label: { name: 'Northfold Records' } });
		expect(card.tracks.map((t) => [t.title, t.bpm, t.key, t.genres])).toEqual([
			['Glass Rivers', 122, 'A Minor', ['Melodic House & Techno', 'Progressive House']],
			['Low Tide', null, null, []],
		]);
	});

	it('lists the genres Beatport states first, so a track’s first genre is Beatport’s', async () => {
		const { app, releaseId } = await seed();
		await withSystemTx(app.db, (tx) => ingestClaims(
			tx,
			[{ provider: 'traxsource', kind: 'recording', providerId: 't11', name: 'Glass Rivers', identifiers: [{ namespace: 'isrc', value: 'GBAAA2600001' }], facts: { durationSec: 401 }, artists: [{ provider: 'traxsource', kind: 'artist', providerId: 't77', name: 'Northfold' }], genres: ['House'] }],
			{ reason: 'tracker' },
		));
		const card = await withSystemTx(app.db, (tx) => releaseCard(tx, releaseId));
		expect(card.tracks[0]!.genres).toEqual(['Melodic House & Techno', 'Progressive House', 'House']);
	});

	it('a playlist addition’s track card carries the recording’s facts and its release’s label', async () => {
		const { app, playlistId, recordingId, labelId } = await seed();
		const card = await withSystemTx(app.db, async (tx) => {
			const seq = (await raisePlaylistAdds(tx, [{ playlistId, recordingId, sourceObjectId: null, addedAt: Date.now(), position: 0 }], { nowMs: Date.now(), windowDays: 14 }))[0]!;
			const [ev] = await tx.query<{ card: string }>(`select card::text as card from curator.catalog_event where seq = $1::bigint`, [String(seq)]);
			return JSON.parse(ev!.card) as CatalogEventTrackCardV2;
		});
		expect(card).toMatchObject({ version: 2, kind: 'track', bpm: 122, key: 'A Minor', genres: ['Melodic House & Techno', 'Progressive House'], label: { id: labelId, name: 'Northfold Records' } });
	});
});

// An event's card kept current (card-rebuild.ts): the catalogue's tables mark
// what was written, and the marks are drained into refreshEvents.
describe('event cards kept current', () => {
	type App = Awaited<ReturnType<typeof createTestApp>>;
	const raise = (app: App, releaseId: string, trackedId: string) =>
		withSystemTx(app.db, (tx) => raiseReleaseEvent(tx, { releaseId, trackedId, publishedAt: null }, { nowMs: Date.now(), windowDays: 14 }));
	const eventOf = async (app: App, releaseId: string) => {
		const [ev] = await app.db.query<{ seq: unknown; card: string }>(`select seq, card::text as card from curator.catalog_event where subject_id = $1`, [releaseId]);
		const subjects = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_event_subject where seq = $1::bigint`, [String(ev!.seq)]);
		return { seq: Number(ev!.seq), card: JSON.parse(ev!.card) as CatalogEventCardV2, subjects: subjects.map((s) => s.object_id) };
	};
	const moved = async (app: App) => (await rebuildCards(app.db)).moved;

	it('a release whose tracklist shrank is sent again with the shorter card, once', async () => {
		const { app, releaseId, labelId, recordingId } = await seed();
		const seq = (await raise(app, releaseId, labelId))!;
		// The ingest that made the release marked it; its card reads the same.
		expect(await moved(app)).toBe(0);
		await withSystemTx(app.db, async (tx) => {
			const [other] = await tx.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'beatport' and kind = 'recording' and provider_id = '12'`);
			await mergeObjects(tx, other!.object_id, recordingId, 'test', 'same slot');
		});
		expect(await moved(app)).toBe(1);
		const ev = await eventOf(app, releaseId);
		expect(ev.seq).toBeGreaterThan(seq);
		expect(await app.db.query(`select 1 from curator.catalog_event where seq = $1::bigint`, [String(seq)])).toEqual([]);
		expect(ev.card.tracks.map((t) => t.title)).toEqual(['Glass Rivers']);
		expect(await moved(app)).toBe(0);
	});

	it('a track that gained a store sends its release again; the same poll once more moves nothing', async () => {
		const { app, releaseId, labelId, recordingId } = await seed();
		const seq = (await raise(app, releaseId, labelId))!;
		// The release gains Spotify, then a track of it does.
		await withSystemTx(app.db, (tx) =>
			ingestClaims(tx, [{ provider: 'spotify', kind: 'release', providerId: 'al1', name: 'Glass Rivers', identifiers: [{ namespace: 'upc', value: '0123456789012' }], artists: [] }], { reason: 'enrichment' }),
		);
		expect(await moved(app)).toBe(1);
		const second = await eventOf(app, releaseId);
		expect(second.seq).toBeGreaterThan(seq);
		expect(second.card.handles.map((h) => h.provider).sort()).toEqual(['beatport', 'spotify']);
		await withSystemTx(app.db, (tx) => new Ingester(tx, { reason: 'enrichment' }).attachTo(recordingId, { provider: 'spotify', kind: 'recording', providerId: 'st1', name: 'Glass Rivers' }));
		expect(await moved(app)).toBe(1);
		// The tracker reaching the announced release again raises nothing and,
		// with nothing changed, sends nothing.
		expect(await raise(app, releaseId, labelId)).toBeNull();
		expect(await moved(app)).toBe(0);
		expect((await eventOf(app, releaseId)).card.tracks[0]!.handles.map((h) => h.provider).sort()).toEqual(['beatport', 'spotify']);
	});

	it('a stored v1 card is rebuilt as v2 when its release is touched', async () => {
		const { app, releaseId, labelId } = await seed();
		const seq = await raise(app, releaseId, labelId);
		await moved(app);
		await withSystemTx(app.db, async (tx) => {
			// As a pre-v2 server stored it: no facts, and no provider yet.
			const [ev] = await tx.query<{ card: string }>(`select card::text as card from curator.catalog_event where seq = $1::bigint`, [String(seq)]);
			const { catalogNumber: _c, upc: _u, ...v1 } = JSON.parse(ev!.card) as CatalogEventCardV2;
			const old = { ...v1, version: 1, handles: [], tracks: v1.tracks.map(({ bpm: _b, key: _k, genres: _g, ...t }) => t) };
			await tx.query(`update curator.catalog_event set card = $2::text::jsonb where seq = $1::bigint`, [String(seq), JSON.stringify(old)]);
			await markCards(tx, [releaseId]);
		});
		expect(await moved(app)).toBe(1);
		const { card } = await eventOf(app, releaseId);
		expect(card.version).toBe(2);
		expect(card.catalogNumber).toBe('NFR042');
		expect(card.tracks[0]!.bpm).toBe(122);
	});

	it('two credits merged into one send the release again with one name', async () => {
		const { app, releaseId, labelId } = await seed();
		// A second store credits the artist under another spelling, on the
		// release and on its first track.
		const credit = { provider: 'deezer', kind: 'artist', providerId: 'd77', name: 'North Fold' } as const;
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					{
						provider: 'deezer',
						kind: 'release',
						providerId: 'dz1',
						name: 'Glass Rivers',
						identifiers: [{ namespace: 'upc', value: '0123456789012' }],
						artists: [credit],
						recordings: [{ provider: 'deezer', kind: 'recording', providerId: 'dt1', name: 'Glass Rivers', identifiers: [{ namespace: 'isrc', value: 'GBAAA2600001' }], facts: { durationSec: 401 }, artists: [credit] }],
					},
				],
				{ reason: 'tracker' },
			),
		);
		await raise(app, releaseId, labelId);
		await moved(app);
		const before = await eventOf(app, releaseId);
		expect(before.card.artists.map((a) => a.name).sort()).toEqual(['North Fold', 'Northfold']);
		await withSystemTx(app.db, async (tx) => {
			const [fold] = await tx.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'deezer' and kind = 'artist' and provider_id = 'd77'`);
			const [keep] = await tx.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'beatport' and kind = 'artist' and provider_id = '77'`);
			await mergeObjects(tx, fold!.object_id, keep!.object_id, 'test', 'twins');
		});
		expect(await moved(app)).toBe(1);
		const after = await eventOf(app, releaseId);
		expect(after.seq).toBeGreaterThan(before.seq);
		expect(after.card.artists.map((a) => a.name)).toEqual(['Northfold']);
		expect(after.card.tracks[0]!.artists).toEqual(['Northfold']);
	});

	it('a fact the card shows moves the event; a scan stamp marks nothing', async () => {
		const { app, releaseId, labelId } = await seed();
		const seq = (await raise(app, releaseId, labelId))!;
		await moved(app);
		// What a desktop found at the store for the second track.
		await withSystemTx(app.db, (tx) =>
			ingestClaims(tx, [{ provider: 'beatport', kind: 'recording', providerId: '12', name: 'Low Tide', facts: { bpm: 124, key: 'F Minor' } }], { reason: 'enrichment' }),
		);
		expect(await moved(app)).toBe(1);
		const ev = await eventOf(app, releaseId);
		expect(ev.seq).toBeGreaterThan(seq);
		expect([ev.card.tracks[1]!.bpm, ev.card.tracks[1]!.key]).toEqual([124, 'F Minor']);
		await app.db.query(`update curator.catalog_object set scanned_at = now() where id = $1`, [releaseId]);
		expect(await app.db.query(`select 1 from curator.catalog_card_dirty`)).toEqual([]);
	});

	it('a label linked afterwards joins the event, and its watchers read it', async () => {
		const { app, releaseId, labelId } = await seed();
		const seq = (await raise(app, releaseId, labelId))!;
		await moved(app);
		const second = await withSystemTx(app.db, async (tx) => {
			const r = await ingestClaims(tx, [{ provider: 'bandcamp', kind: 'label', providerId: 'bc9', name: 'Second Home' }], { reason: 'manual_registration' });
			await tx.query(`insert into curator.catalog_edge (src, kind, dst) values ($1, 'release-label', $2)`, [releaseId, r.outcomes[0]!.objectId]);
			return r.outcomes[0]!.objectId;
		});
		expect(await moved(app)).toBe(1);
		const ev = await eventOf(app, releaseId);
		expect(ev.seq).toBeGreaterThan(seq);
		expect(ev.subjects).toEqual(expect.arrayContaining([labelId, second]));
	});

	it('a second tracker’s object joins an announced event and the event is sent again, once', async () => {
		const { app, releaseId, labelId, playlistId } = await seed();
		const seq = (await raise(app, releaseId, labelId))!;
		await moved(app);
		// Any other watched object whose tracker lists the release.
		expect(await raise(app, releaseId, playlistId)).toBeNull();
		expect(await moved(app)).toBe(1);
		const ev = await eventOf(app, releaseId);
		expect(ev.seq).toBeGreaterThan(seq);
		expect(ev.subjects).toContain(playlistId);
		expect(await raise(app, releaseId, playlistId)).toBeNull();
		expect(await moved(app)).toBe(0);
	});

	it('an event long past its release is left as it was', async () => {
		const { app, releaseId, labelId } = await seed();
		const seq = (await raise(app, releaseId, labelId))!;
		await moved(app);
		await withSystemTx(app.db, async (tx) => {
			await tx.query(`update curator.catalog_event set release_at = now() - interval '90 days' where seq = $1::bigint`, [String(seq)]);
			await markCards(tx, [releaseId], { force: true });
		});
		expect(await moved(app)).toBe(0);
		expect((await eventOf(app, releaseId)).seq).toBe(seq);
	});
});
