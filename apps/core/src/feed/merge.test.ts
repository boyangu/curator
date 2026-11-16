import { describe, expect, it } from 'vitest';
import { mergeFeedPayload } from './merge.js';
import type { FeedItemPayload } from './types.js';

describe('mergeFeedPayload', () => {
	it('fills what the row lacks and keeps what it has', () => {
		const row: FeedItemPayload = { title: 'Glass Rivers', artists: ['Northfold'], genre: 'House' };
		const next = mergeFeedPayload(row, { title: 'x', artists: [], genre: 'Deep House', label: 'Cat', catalogId: 'rel-1' })!;
		expect(next).toMatchObject({ title: 'Glass Rivers', genre: 'House', label: 'Cat', catalogId: 'rel-1' });
		expect(mergeFeedPayload(next, { title: 'x', artists: [], genre: 'Techno' })).toBeNull();
	});

	it('gains every new handle, so a re-announced release learns its Spotify id', () => {
		const row: FeedItemPayload = { title: 't', artists: [], handles: [{ provider: 'bandcamp', id: '9', url: 'https://x.bandcamp.com/album/t' }] };
		const next = mergeFeedPayload(row, { title: 't', artists: [], handles: [{ provider: 'spotify', id: 'al1', url: null }, { provider: 'bandcamp', id: '9', url: null }] })!;
		expect(next.handles?.map((h) => h.provider)).toEqual(['bandcamp', 'spotify']);
	});

	it('matches album rows by catalogue id, then ISRC, and upgrades a row the player could not play', () => {
		const row: FeedItemPayload = {
			title: 't',
			artists: [],
			tracks: [
				{ sourceTrackId: 'r1', catalogId: 'r1', title: 'One', artists: [], durationSec: 1 },
				{ sourceTrackId: 'st2', title: 'Two', artists: [], durationSec: 1, isrc: 'X2' },
			],
		};
		const next = mergeFeedPayload(row, {
			title: 't',
			artists: [],
			tracks: [
				{ sourceTrackId: 'st1', catalogId: 'r1', title: 'One', artists: [], durationSec: 1, handles: [{ provider: 'spotify', id: 'st1', url: null }] },
				{ sourceTrackId: 'r2', catalogId: 'r2', title: 'Two', artists: [], durationSec: 1, isrc: 'X2', bpm: 124 },
			],
		})!;
		expect(next.tracks?.map((t) => [t.sourceTrackId, t.catalogId, t.bpm ?? null])).toEqual([
			['st1', 'r1', null],
			// A legacy Spotify row stays on its Spotify id.
			['st2', 'r2', 124],
		]);
	});

	it('the catalogue’s own card replaces the tracklist, each track keeping what the row found about it', () => {
		// The row: the catalogue's release with "Run Away" held twice (two
		// recordings on one slot), one matched on Spotify and enriched, the
		// other Deezer-only; "Soma" enriched too.
		const row: FeedItemPayload = {
			title: 'Home',
			artists: ['Marsh'],
			catalogId: 'rel-1',
			trackCount: 3,
			tracks: [
				{ sourceTrackId: 'st1', catalogId: 'r-sp', title: 'Run Away', artists: ['Marsh', 'ALLKNIGHT'], durationSec: 267.2, bpm: 124, keyCamelot: '4A', enrichStatus: 'ok', handles: [{ provider: 'spotify', id: 'st1', url: null }] },
				{ sourceTrackId: 'r-dz', catalogId: 'r-dz', title: 'Run Away', artists: ['Marsh'], durationSec: 267, isrc: 'QMDA62691879', handles: [{ provider: 'deezer', id: 'dz1', url: null }] },
				{ sourceTrackId: 'r-soma', catalogId: 'r-soma', title: 'Soma', artists: ['Marsh'], durationSec: 352, bpm: 91, enrichStatus: 'ok' },
			],
		};
		// The catalogue merged the Spotify copy into the Deezer one (the ISRC's
		// holder), whose handles now carry the Spotify id.
		const card: FeedItemPayload = {
			title: 'Home',
			artists: ['Marsh'],
			catalogId: 'rel-1',
			trackCount: 2,
			tracks: [
				{ sourceTrackId: 'st1', catalogId: 'r-dz', title: 'Run Away', artists: ['Marsh', 'ALLKNIGHT'], durationSec: 267, isrc: 'QMDA62691879', trackNumber: 1, handles: [{ provider: 'deezer', id: 'dz1', url: null }, { provider: 'spotify', id: 'st1', url: null }] },
				{ sourceTrackId: 'r-soma', catalogId: 'r-soma', title: 'Soma', artists: ['Marsh'], durationSec: 352, trackNumber: 2 },
			],
		};
		const next = mergeFeedPayload(row, card)!;
		expect(next.trackCount).toBe(2);
		expect(next.tracks!.map((t) => [t.sourceTrackId, t.catalogId, t.bpm ?? null, t.keyCamelot ?? null, t.enrichStatus ?? null, t.handles?.map((h) => h.provider)])).toEqual([
			['st1', 'r-dz', 124, '4A', 'ok', ['deezer', 'spotify']],
			['r-soma', 'r-soma', 91, null, 'ok', undefined],
		]);
		// The same card again changes nothing.
		expect(mergeFeedPayload(next, card)).toBeNull();
	});

	it('a draft that is not the catalogue’s card for the row stays fill-only', () => {
		const row: FeedItemPayload = { title: 't', artists: [], catalogId: 'rel-1', tracks: [{ sourceTrackId: 'r1', catalogId: 'r1', title: 'One', artists: [], durationSec: 1 }, { sourceTrackId: 'r2', catalogId: 'r2', title: 'Two', artists: [], durationSec: 1 }] };
		// Another release's card, and a local producer's draft without catalogue ids.
		expect(mergeFeedPayload(row, { title: 't', artists: [], catalogId: 'rel-2', tracks: [{ sourceTrackId: 'r1', catalogId: 'r1', title: 'One', artists: [], durationSec: 1 }] })).toBeNull();
		expect(mergeFeedPayload(row, { title: 't', artists: [], catalogId: 'rel-1', tracks: [{ sourceTrackId: 'st1', title: 'One', artists: [], durationSec: 1 }] })).toBeNull();
	});

	it('takes the draft’s url when the row moves to a playable source', () => {
		const row: FeedItemPayload = { title: 't', artists: [], url: 'https://x.bandcamp.com/album/t' };
		expect(mergeFeedPayload(row, { title: 't', artists: [], url: 'https://open.spotify.com/album/al1' }, { upgrade: true })?.url).toBe('https://open.spotify.com/album/al1');
		expect(mergeFeedPayload(row, { title: 't', artists: [], url: 'https://open.spotify.com/album/al1' })).toBeNull();
	});
});
