import { describe, it, expect } from 'vitest';
import { ArtistDismissFilter, FeedDedupFilter, LibraryFilter, type FeedStage, type LibraryMembershipLookup } from './filters.js';
import type { FeedItemDraft } from './types.js';

const CTX = { producerId: 'test', mode: 'poll' as const };

function trackDraft(id: string, opts: { isrc?: string | null; artistId?: string } = {}): FeedItemDraft {
	return {
		type: 'track',
		source: 'spotify',
		sourceId: id,
		dedupeKey: opts.isrc ? `isrc:${opts.isrc}` : `spotify:track:${id}`,
		payload: { title: id, artists: ['A'], isrc: opts.isrc ?? null },
		origin: null,
		publishedAt: null,
		suppressKeys: ['source:spotify', ...(opts.artistId ? [`artist:${opts.artistId}`] : [])],
	};
}

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

describe('FeedDedupFilter', () => {
	it('drops drafts already in the feed after accruing their sources; keeps in-batch repeats for upsert to fold', async () => {
		const accrued: string[] = [];
		const stage: FeedStage = new FeedDedupFilter({
			existingDedupeKeys: async () => new Set(['isrc:OLD']),
			accrueSources: async (ds) => { accrued.push(...ds.map((d) => d.sourceId)); },
		});
		const out = await stage.run(
			[
				trackDraft('a', { isrc: 'OLD' }), // already in feed → accrue + drop
				trackDraft('b', { isrc: 'NEW' }), // keep
				trackDraft('c', { isrc: 'NEW' }), // in-batch repeat of b → kept; upsertItems folds it onto b
			],
			CTX,
		);
		expect(out.map((d) => d.sourceId)).toEqual(['b', 'c']);
		expect(accrued).toEqual(['a']);
	});
});

describe('ArtistDismissFilter', () => {
	it('drops TRACK items from a dismissed artist but keeps albums (chipped, not hidden)', async () => {
		const stage: FeedStage = new ArtistDismissFilter({
			suppressedKeys: async () => new Set(['artist:DISMISSED']),
		});
		const out = await stage.run(
			[trackDraft('t1', { artistId: 'DISMISSED' }), albumDraft('al1', 'DISMISSED'), trackDraft('t2', { artistId: 'OK' })],
			CTX,
		);
		// t1 (dismissed-artist track) drops; al1 survives even though its artist is
		// muted — a release isn't hidden over one credit (its tracks chip instead).
		expect(out.map((d) => d.sourceId)).toEqual(['al1', 't2']);
	});

	it("drops a muted FOLLOWED artist's own release (the album's origin), not one it is merely credited on", async () => {
		const stage: FeedStage = new ArtistDismissFilter({ suppressedKeys: async () => new Set(['artist:MUTED']) });
		const own = { ...albumDraft('own', 'MUTED'), origin: { kind: 'artist' as const, id: 'MUTED', name: 'Muted', catalogId: 'cat-1' } };
		const credited = { ...albumDraft('credited', 'MUTED'), origin: { kind: 'artist' as const, id: 'OTHER', name: 'Other' } };
		const out = await stage.run([own, credited], CTX);
		expect(out.map((d) => d.sourceId)).toEqual(['credited']);
	});

	it('is a no-op when nothing is dismissed', async () => {
		const stage: FeedStage = new ArtistDismissFilter({ suppressedKeys: async () => new Set() });
		expect(await stage.run([trackDraft('t1', { artistId: 'X' })], CTX)).toHaveLength(1);
	});
});

describe('LibraryFilter', () => {
	// Drop ONLY `local`-tier tracks; `streaming` / `followed` (and none) stay.
	// pinned/source are irrelevant to the filter (it keys on the raw `local`
	// tier); the per-page decorator is what consumes them.
	const lookup: LibraryMembershipLookup = async () => ({
		membershipByIsrc: { LOCAL_ISRC: 'local', STREAMING_ISRC: 'streaming' },
		membershipBySpotifyId: { localSpotifyId: 'local', followedSpotifyId: 'followed' },
		pinnedByIsrc: new Set(),
		pinnedBySpotifyId: new Set(),
		sourceByIsrc: {},
		sourceBySpotifyId: {},
	});

	it('drops only local-tier tracks (by ISRC or spotify id); keeps streaming/followed/none and all albums', async () => {
		const stage: FeedStage = new LibraryFilter(lookup);
		const out = await stage.run(
			[
				trackDraft('byLocalIsrc', { isrc: 'LOCAL_ISRC' }), // drop (local by ISRC)
				trackDraft('localSpotifyId', { isrc: 'UNSEEN' }), // drop (local by spotify id)
				trackDraft('byStreamingIsrc', { isrc: 'STREAMING_ISRC' }), // keep (streaming)
				trackDraft('followedSpotifyId', { isrc: 'UNSEEN2' }), // keep (followed)
				trackDraft('fresh', { isrc: 'UNSEEN3' }), // keep (none)
				albumDraft('al', 'A'), // album always kept
			],
			CTX,
		);
		expect(out.map((d) => d.sourceId).sort()).toEqual(['al', 'byStreamingIsrc', 'followedSpotifyId', 'fresh']);
	});
});

describe('catalogue drafts in the pipeline', () => {
	it('a draft held under one of its aliases is a repeat', async () => {
		const accrued: string[] = [];
		const stage: FeedStage = new FeedDedupFilter({
			existingDedupeKeys: async (keys) => new Set(keys.filter((k) => k === 'spotify:album:al1')),
			accrueSources: async (ds) => { accrued.push(...ds.map((d) => d.dedupeKey)); },
		});
		const d: FeedItemDraft = { ...albumDraft('al1', 'A'), dedupeKey: 'catalog:release:rel1', aliasKeys: ['spotify:album:al1'] };
		expect(await stage.run([d], CTX)).toEqual([]);
		expect(accrued).toEqual(['catalog:release:rel1']);
	});

	it('the library filter reads a catalogue track’s Spotify id from its handles, and never its catalogue id', async () => {
		const seen: string[][] = [];
		const stage: FeedStage = new LibraryFilter(async (keys) => {
			seen.push(keys.spotifyTrackIds);
			return { membershipByIsrc: {}, membershipBySpotifyId: { localSpotifyId: 'local' }, pinnedByIsrc: new Set(), pinnedBySpotifyId: new Set(), sourceByIsrc: {}, sourceBySpotifyId: {} };
		});
		const onSpotify: FeedItemDraft = { ...trackDraft('localSpotifyId'), payload: { title: 'x', artists: [], handles: [{ provider: 'spotify', id: 'localSpotifyId', url: null }] } };
		const offSpotify: FeedItemDraft = { ...trackDraft('rec-9'), source: 'catalog', payload: { title: 'y', artists: [], handles: [{ provider: 'beatport', id: '3', url: null }] } };
		const out = await stage.run([onSpotify, offSpotify], CTX);
		expect(out.map((d) => d.sourceId)).toEqual(['rec-9']);
		expect(seen).toEqual([['localSpotifyId']]);
	});
});
