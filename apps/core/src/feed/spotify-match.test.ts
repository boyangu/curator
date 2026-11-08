// The lazy Spotify match: evidence before a hit, the upgrade draft, and the
// outcomes recorded.

import { describe, expect, it } from 'vitest';
import type { SpotifyAlbum, SpotifySimplifiedTrack, SpotifyTrack } from '@curator/spotify';
import { albumDraft, matchSpotify, needsMatch, pairTracks, titleKey, type SpotifyMatchClient } from './spotify-match.js';
import type { FeedItem, FeedItemDraft, FeedTrackRef } from './types.js';

const NOW = 1_800_000_000_000;

const ref = (title: string, durationSec: number, over: Partial<FeedTrackRef> = {}): FeedTrackRef => ({ sourceTrackId: `cat-${title}`, catalogId: `cat-${title}`, title, artists: ['Northfold'], durationSec, ...over });
const sp = (id: string, name: string, sec: number): SpotifySimplifiedTrack => ({ id, name, duration_ms: sec * 1000, explicit: false, track_number: 1, disc_number: 1, artists: [{ id: 'a', name: 'Northfold' }] });
const album = (id: string, name: string, total: number, artist = 'Northfold'): SpotifyAlbum => ({ id, name, album_type: 'single', release_date: '2026-11-06', total_tracks: total, images: [], artists: [{ id: 'a', name: artist }], external_urls: { spotify: `https://open.spotify.com/album/${id}` } });

const item = (over: Partial<FeedItem> = {}): FeedItem => ({
	id: 'i1',
	dedupeKey: 'catalog:release:rel-1',
	type: 'album',
	source: 'catalog',
	sourceId: 'rel-1',
	payload: { title: 'Glass Rivers', artists: ['Northfold'], artistIds: [], tracks: [ref('Glass Rivers (Original Mix)', 401), ref('Glass Rivers (Dub)', 380)] },
	origin: { kind: 'label', id: 'l1', name: 'Northfold Records' },
	publishedAt: NOW,
	fetchedAt: NOW,
	score: 0,
	state: 'fresh',
	playedAt: null,
	archivedAt: null,
	enrichedAt: null,
	enrichStatus: null,
	matchStatus: null,
	matchedAt: null,
	promotedTrackId: null,
	...over,
});

describe('needsMatch / titleKey', () => {
	it('tries a catalogue item once, a miss again after three days, an error after an hour', () => {
		expect(needsMatch(item(), NOW)).toBe(true);
		expect(needsMatch(item({ source: 'spotify' }), NOW)).toBe(false);
		expect(needsMatch(item({ matchStatus: 'ok', matchedAt: NOW }), NOW)).toBe(false);
		expect(needsMatch(item({ matchStatus: 'none', matchedAt: NOW - 86400_000 }), NOW)).toBe(false);
		expect(needsMatch(item({ matchStatus: 'none', matchedAt: NOW - 4 * 86400_000 }), NOW)).toBe(true);
		expect(needsMatch(item({ matchStatus: 'err', matchedAt: NOW - 2 * 3600_000 }), NOW)).toBe(true);
	});

	it('folds the mix tags stores add', () => {
		expect(titleKey('Glass Rivers (Original Mix)')).toBe(titleKey('Glass Rivers'));
		expect(titleKey('Glass Rivers - Original Mix')).toBe(titleKey('glass rivers'));
		expect(titleKey('Juicy Float (Original Mix) [SEVEN VILLAS MUSIC]')).toBe(titleKey('Juicy Float'));
		expect(titleKey('Glass Rivers (Dub)')).not.toBe(titleKey('Glass Rivers'));
	});
});

describe('pairTracks', () => {
	it('pairs by title and length, the rest by position when the counts agree, and refuses a tracklist that does not confirm', () => {
		const ours = [ref('One', 300), ref('Two (Original Mix)', 250), ref('Three', 200)];
		const theirs = [sp('s1', 'One', 301), sp('s2', 'Two', 249), sp('s3', 'Three (Extended)', 200)];
		const pairs = pairTracks(ours, theirs)!;
		expect([...pairs.values()].map((t) => t.id)).toEqual(['s1', 's2', 's3']);
		// Lengths far apart: no pair; one of three is not half.
		expect(pairTracks(ours, [sp('x1', 'One', 420), sp('x2', 'Two', 250), sp('x3', 'Nine', 200)])).toBeNull();
		expect(pairTracks([], theirs)).toBeNull();
	});
});

describe('matchSpotify', () => {
	function fake(opts: { tracksByIsrc?: Record<string, SpotifyTrack[]>; albums?: Record<string, SpotifyAlbum[]>; albumTracks?: Record<string, SpotifySimplifiedTrack[]>; throws?: boolean }) {
		const calls: string[] = [];
		const client: SpotifyMatchClient = {
			async searchTracks(q) { calls.push(q); if (opts.throws) throw new Error('boom'); return opts.tracksByIsrc?.[q] ?? []; },
			async searchAlbums(q) { calls.push(q); return opts.albums?.[q] ?? []; },
			async getAlbumTracks(id) { calls.push(`tracks:${id}`); return opts.albumTracks?.[id] ?? []; },
		};
		const upserts: FeedItemDraft[] = [];
		const marks: string[] = [];
		let current = item();
		const deps = {
			store: {
				upsertItems: async (d: FeedItemDraft[]) => { upserts.push(...d); current = { ...current, source: d[0]!.source, sourceId: d[0]!.sourceId, payload: d[0]!.payload }; return { inserted: 0 }; },
				markMatched: async (_id: string, s: string) => { marks.push(s); },
				getItem: async () => current,
			},
			client: async (): Promise<SpotifyMatchClient | null> => client,
			onActivity: (a: { activity: string | null }) => { calls.push(`activity:${a.activity}`); },
			now: () => NOW,
		};
		return { deps, calls, upserts, marks };
	}

	it('finds the album by a track’s ISRC, confirms the tracklist, and upgrades the row with every track’s Spotify id', async () => {
		const t: SpotifyTrack = { id: 's1', name: 'Glass Rivers', duration_ms: 401_000, explicit: false, external_ids: { isrc: 'GBAAA2600001' }, artists: [{ id: 'a', name: 'Northfold' }], album: { id: 'al1', name: 'Glass Rivers', release_date: '2026-11-06', images: [] } };
		const f = fake({ tracksByIsrc: { 'isrc:GBAAA2600001': [t] }, albumTracks: { al1: [sp('s1', 'Glass Rivers', 401), sp('s2', 'Glass Rivers (Dub)', 380)] } });
		const it0 = item({ payload: { ...item().payload, tracks: [ref('Glass Rivers (Original Mix)', 401, { isrc: 'GBAAA2600001' }), ref('Glass Rivers (Dub)', 380)] } });
		const out = await matchSpotify(f.deps, it0);
		expect(f.calls).toEqual(['activity:spotify', 'isrc:GBAAA2600001', 'tracks:al1', 'activity:null']);
		expect(f.marks).toEqual(['ok']);
		const d = f.upserts[0]!;
		expect(d).toMatchObject({ source: 'spotify', sourceId: 'al1', dedupeKey: 'catalog:release:rel-1', aliasKeys: ['spotify:album:al1'], suppressKeys: ['source:spotify'] });
		expect(d.payload.url).toBe('https://open.spotify.com/album/al1');
		expect(d.payload.tracks!.map((r) => [r.sourceTrackId, r.catalogId, r.handles?.[0]?.id])).toEqual([['s1', 'cat-Glass Rivers (Original Mix)', 's1'], ['s2', 'cat-Glass Rivers (Dub)', 's2']]);
		expect(out.source).toBe('spotify');
	});

	it('falls back to title + artist and refuses a namesake whose tracklist disagrees', async () => {
		const q = 'album:"Glass Rivers" artist:"Northfold"';
		const f = fake({
			albums: { [q]: [album('wrong', 'Glass Rivers', 2, 'Someone Else'), album('near', 'Glass Rivers', 2), album('right', 'Glass Rivers', 2)] },
			albumTracks: { near: [sp('n1', 'Other', 100), sp('n2', 'Thing', 120)], right: [sp('r1', 'Glass Rivers', 400), sp('r2', 'Glass Rivers (Dub)', 382)] },
		});
		const out = await matchSpotify(f.deps, item());
		expect(f.calls.filter((c) => c.startsWith('tracks:'))).toEqual(['tracks:near', 'tracks:right']);
		expect(out.sourceId).toBe('right');
	});

	it('records a miss, and an error, without touching the row', async () => {
		const miss = fake({});
		expect(await matchSpotify(miss.deps, item())).toMatchObject({ source: 'catalog', matchStatus: 'none', matchedAt: NOW });
		expect(miss.upserts).toEqual([]);
		const err = fake({ throws: true });
		const t = item({ type: 'track', payload: { title: 'Glass Rivers', artists: ['Northfold'], artistIds: [], isrc: 'GBAAA2600001', durationSec: 400 } });
		expect(await matchSpotify(err.deps, t)).toMatchObject({ matchStatus: 'err' });
		expect(err.marks).toEqual(['err']);
		expect(err.calls.at(-1)).toBe('activity:null');
	});

	it('does nothing while Spotify is not connected', async () => {
		const f = fake({});
		f.deps.client = async () => null;
		expect(await matchSpotify(f.deps, item())).toMatchObject({ matchStatus: null });
		expect(f.marks).toEqual([]);
	});
});

describe('albumDraft', () => {
	it('keeps unpaired refs as they are', () => {
		const it0 = item();
		const pairs = new Map<FeedTrackRef, SpotifySimplifiedTrack>([[it0.payload.tracks![0]!, sp('s1', 'Glass Rivers', 401)]]);
		const d = albumDraft(it0, { id: 'al1' }, pairs);
		expect(d.payload.tracks![1]).toEqual(it0.payload.tracks![1]);
		expect(d.payload.handles).toEqual([{ provider: 'spotify', id: 'al1', url: 'https://open.spotify.com/album/al1' }]);
	});
});
