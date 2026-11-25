// Event cards v2: the facts a DJ card shows ride on the card itself — BPM,
// key and genres per track, the catalogue number and UPC per release, the
// label on a track card — so a device renders them with no call back and no
// scrape of its own. Made-up names.

import { describe, expect, it } from 'vitest';
import type { CatalogEventCardV2, CatalogEventTrackCardV2 } from '@curator/protocol';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp } from '../test/harness.js';
import { mergeObjects } from './admin.js';
import { raisePlaylistAdds, raiseReleaseEvent, reannounce, reannounceCard, releaseCard } from './events.js';
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

	it('a playlist addition’s track card carries the recording’s facts and its release’s label', async () => {
		const { app, playlistId, recordingId, labelId } = await seed();
		const card = await withSystemTx(app.db, async (tx) => {
			const seq = (await raisePlaylistAdds(tx, [{ playlistId, recordingId, sourceObjectId: null, addedAt: Date.now(), position: 0 }], { nowMs: Date.now(), windowDays: 14 }))[0]!;
			const [ev] = await tx.query<{ card: string }>(`select card::text as card from curator.catalog_event where seq = $1::bigint`, [String(seq)]);
			return JSON.parse(ev!.card) as CatalogEventTrackCardV2;
		});
		expect(card).toMatchObject({ version: 2, kind: 'track', bpm: 122, key: 'A Minor', genres: ['Melodic House & Techno', 'Progressive House'], label: { id: labelId, name: 'Northfold Records' } });
	});

	it('a release whose tracklist shrank is re-announced with the shorter card, once', async () => {
		const { app, releaseId, labelId, recordingId } = await seed();
		const r = await withSystemTx(app.db, async (tx) => {
			const seq = await raiseReleaseEvent(tx, { releaseId, trackedId: labelId, publishedAt: null }, { nowMs: Date.now(), windowDays: 14 });
			expect(await reannounceCard(tx, releaseId)).toEqual([]);
			const [other] = await tx.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'beatport' and kind = 'recording' and provider_id = '12'`);
			await mergeObjects(tx, other!.object_id, recordingId, 'test', 'same slot');
			const moved = await reannounceCard(tx, releaseId);
			const [gone] = await tx.query(`select 1 from curator.catalog_event where seq = $1::bigint`, [String(seq)]);
			const [ev] = await tx.query<{ seq: unknown; card: string }>(`select seq, card::text as card from curator.catalog_event where subject_id = $1`, [releaseId]);
			const again = await reannounceCard(tx, releaseId);
			return { moved, again, gone, oldSeq: seq!, newSeq: Number(ev!.seq), card: JSON.parse(ev!.card) as CatalogEventCardV2 };
		});
		expect(r.moved).toEqual([r.newSeq]);
		expect(r.again).toEqual([]);
		expect(r.gone).toBeUndefined();
		expect(r.newSeq).toBeGreaterThan(r.oldSeq);
		expect(r.card.tracks.map((t) => t.title)).toEqual(['Glass Rivers']);
	});

	it('a track that gained a provider re-announces its release, through the tracker’s own path too', async () => {
		const { app, releaseId, labelId, recordingId } = await seed();
		const r = await withSystemTx(app.db, async (tx) => {
			const seq = (await raiseReleaseEvent(tx, { releaseId, trackedId: labelId, publishedAt: null }, { nowMs: Date.now(), windowDays: 14 }))!;
			// The release has Spotify already (card rebuilt), then a track gains it.
			await ingestClaims(tx, [{ provider: 'spotify', kind: 'release', providerId: 'al1', name: 'Glass Rivers', identifiers: [{ namespace: 'upc', value: '0123456789012' }], artists: [] }], { reason: 'enrichment' });
			const seq2 = await raiseReleaseEvent(tx, { releaseId, trackedId: labelId, publishedAt: null }, { nowMs: Date.now(), windowDays: 14 });
			await new Ingester(tx, { reason: 'enrichment' }).attachTo(recordingId, { provider: 'spotify', kind: 'recording', providerId: 'st1', name: 'Glass Rivers' });
			expect(await reannounceCard(tx, releaseId)).toHaveLength(1);
			// The same again through the tracker's path: another second tracker
			// reaching the release moves it only while something changed.
			const seq3 = await raiseReleaseEvent(tx, { releaseId, trackedId: labelId, publishedAt: null }, { nowMs: Date.now(), windowDays: 14 });
			const [ev] = await tx.query<{ card: string }>(`select card::text as card from curator.catalog_event where subject_id = $1`, [releaseId]);
			return { seq, seq2, seq3, card: JSON.parse(ev!.card) as CatalogEventCardV2 };
		});
		expect(r.seq2).toBeGreaterThan(r.seq);
		expect(r.seq3).toBeNull();
		expect(r.card.tracks[0]!.handles.map((h) => h.provider).sort()).toEqual(['beatport', 'spotify']);
	});

	it('a stored v1 card is rebuilt as v2 when the release gains a provider', async () => {
		const { app, releaseId, labelId } = await seed();
		const card = await withSystemTx(app.db, async (tx) => {
			const seq = await raiseReleaseEvent(tx, { releaseId, trackedId: labelId, publishedAt: null }, { nowMs: Date.now(), windowDays: 14 });
			// As a pre-v2 server stored it: no facts, and no provider yet.
			const [ev] = await tx.query<{ card: string }>(`select card::text as card from curator.catalog_event where seq = $1::bigint`, [String(seq)]);
			const { catalogNumber: _c, upc: _u, ...v1 } = JSON.parse(ev!.card) as CatalogEventCardV2;
			const old = { ...v1, version: 1, handles: [], tracks: v1.tracks.map(({ bpm: _b, key: _k, genres: _g, ...t }) => t) };
			await tx.query(`update curator.catalog_event set card = $2::text::jsonb where seq = $1::bigint`, [String(seq), JSON.stringify(old)]);
			const next = await reannounce(tx, seq!, releaseId);
			const [moved] = await tx.query<{ card: string }>(`select card::text as card from curator.catalog_event where seq = $1::bigint`, [String(next)]);
			return JSON.parse(moved!.card) as CatalogEventCardV2;
		});
		expect(card.version).toBe(2);
		expect(card.catalogNumber).toBe('NFR042');
		expect(card.tracks[0]!.bpm).toBe(122);
	});

	it('two credits merged into one re-announce the release with one name', async () => {
		const { app, releaseId, labelId } = await seed();
		const r = await withSystemTx(app.db, async (tx) => {
			// A second store credits the artist under another spelling, on the
			// release and on its first track.
			const credit = { provider: 'deezer', kind: 'artist', providerId: 'd77', name: 'North Fold' } as const;
			await ingestClaims(
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
			);
			const seq = (await raiseReleaseEvent(tx, { releaseId, trackedId: labelId, publishedAt: null }, { nowMs: Date.now(), windowDays: 14 }))!;
			const names = async () => {
				const [ev] = await tx.query<{ seq: unknown; card: string }>(`select seq, card::text as card from curator.catalog_event where subject_id = $1`, [releaseId]);
				const c = JSON.parse(ev!.card) as CatalogEventCardV2;
				return { seq: Number(ev!.seq), artists: c.artists.map((a) => a.name).sort(), track: c.tracks[0]!.artists };
			};
			const before = await names();
			const [fold] = await tx.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'deezer' and kind = 'artist' and provider_id = 'd77'`);
			const [keep] = await tx.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'beatport' and kind = 'artist' and provider_id = '77'`);
			await mergeObjects(tx, fold!.object_id, keep!.object_id, 'test', 'twins');
			return { seq, before, after: await names() };
		});
		expect(r.before.seq).toBe(r.seq);
		expect(r.before.artists).toEqual(['North Fold', 'Northfold']);
		expect(r.after.seq).toBeGreaterThan(r.before.seq);
		expect(r.after.artists).toEqual(['Northfold']);
		expect(r.after.track).toEqual(['Northfold']);
	});
});
