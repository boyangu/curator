import { describe, it, expect } from 'vitest';
import type { SpotifyClient } from '@curator/spotify';
import { AlbumExpanderStage, fillAlbumTrackIsrcs } from './pipeline.js';
import type { FeedStage } from '@curator/sync-core/feed/filters';
import type { FeedItemDraft, FeedTrackRef } from '@curator/sync-core/feed/types';

const CTX = { producerId: 'test', mode: 'poll' as const };

function albumDraft(id: string, artistId: string): FeedItemDraft {
	return {
		type: 'album',
		source: 'spotify',
		sourceId: id,
		dedupeKey: `spotify:album:${id}`,
		payload: { title: id, artists: ['A'], artistIds: [artistId] },
		origin: null,
		publishedAt: null,
		suppressKeys: ['source:spotify', `artist:${artistId}`],
	};
}

describe('AlbumExpanderStage', () => {
	it('resolves tracklists in one call, leaving ISRCs null (filled lazily on expand)', async () => {
		let isrcCalls = 0;
		const fake = {
			getAlbumTracks: async () => [
				{ id: 't1', name: 'One', duration_ms: 60000, explicit: false, track_number: 1, disc_number: 1, artists: [{ id: 'a', name: 'A' }] },
				{ id: 't2', name: 'Two', duration_ms: 120000, explicit: false, track_number: 2, disc_number: 1, artists: [{ id: 'a', name: 'A' }] },
			],
			getTracksByIds: async () => { isrcCalls++; return []; },
		} as unknown as SpotifyClient;
		const stage: FeedStage = new AlbumExpanderStage(async () => fake);
		const out = (await stage.run([albumDraft('al', 'A')], CTX))[0]!;
		expect(out.payload.tracks).toHaveLength(2);
		expect(out.payload.tracks?.[0]).toMatchObject({ sourceTrackId: 't1', isrc: null, durationSec: 60 });
		// Ingest must NOT spend the second /tracks call — that's the whole point.
		expect(isrcCalls).toBe(0);
	});

	it('leaves albums untouched when no client (Spotify disconnected)', async () => {
		const stage: FeedStage = new AlbumExpanderStage(async () => null);
		const out = (await stage.run([albumDraft('al', 'A')], CTX))[0]!;
		expect(out.payload.tracks).toBeUndefined();
	});
});

describe('fillAlbumTrackIsrcs', () => {
	it('fills ISRCs (and backfills artistIds) mapped by id, not position (drops missing)', async () => {
		const refs: FeedTrackRef[] = [
			{ sourceTrackId: 't1', title: 'One', artists: ['A'], durationSec: 60, isrc: null },
			{ sourceTrackId: 't2', title: 'Two', artists: ['A'], durationSec: 120, isrc: null },
		];
		const fake = {
			// Returned out of order and missing t2 — must map by id, not position.
			getTracksByIds: async () => [{ id: 't1', external_ids: { isrc: 'ISRC1' }, artists: [{ id: 'A1', name: 'A' }] }],
		} as unknown as SpotifyClient;
		const changed = await fillAlbumTrackIsrcs(fake, refs);
		expect(changed).toBe(true);
		// t1 gets its ISRC and its artist ids backfilled (these refs predate the
		// FeedTrackRef.artistIds field); t2 (absent from the response) stays null.
		expect(refs[0]).toMatchObject({ sourceTrackId: 't1', isrc: 'ISRC1', artistIds: ['A1'] });
		expect(refs[1]).toMatchObject({ sourceTrackId: 't2', isrc: null });
		expect(refs[1]!.artistIds).toBeUndefined();
	});
});
