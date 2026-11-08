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

	it('takes the draft’s url when the row moves to a playable source', () => {
		const row: FeedItemPayload = { title: 't', artists: [], url: 'https://x.bandcamp.com/album/t' };
		expect(mergeFeedPayload(row, { title: 't', artists: [], url: 'https://open.spotify.com/album/al1' }, { upgrade: true })?.url).toBe('https://open.spotify.com/album/al1');
		expect(mergeFeedPayload(row, { title: 't', artists: [], url: 'https://open.spotify.com/album/al1' })).toBeNull();
	});
});
