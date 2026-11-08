// Event cards v2: the facts a DJ card shows ride on the card itself — BPM,
// key and genres per track, the catalogue number and UPC per release, the
// label on a track card — so a device renders them with no call back and no
// scrape of its own. Made-up names.

import { describe, expect, it } from 'vitest';
import type { CatalogEventCardV2, CatalogEventTrackCardV2 } from '@curator/protocol';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp } from '../test/harness.js';
import { raisePlaylistAdd, raiseReleaseEvent, reannounce, releaseCard } from './events.js';
import { ingestClaims } from './ingest.js';

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
			const seq = await raisePlaylistAdd(tx, { playlistId, recordingId, sourceObjectId: null, addedAt: Date.now(), position: 0 }, { nowMs: Date.now(), windowDays: 14 });
			const [ev] = await tx.query<{ card: string }>(`select card::text as card from curator.catalog_event where seq = $1::bigint`, [String(seq)]);
			return JSON.parse(ev!.card) as CatalogEventTrackCardV2;
		});
		expect(card).toMatchObject({ version: 2, kind: 'track', bpm: 122, key: 'A Minor', genres: ['Melodic House & Techno', 'Progressive House'], label: { id: labelId, name: 'Northfold Records' } });
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
});
