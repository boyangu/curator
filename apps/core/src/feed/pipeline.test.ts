import { describe, it, expect } from 'vitest';
import type { SpotifyClient } from '@curator/spotify';
import {
	AlbumExpanderStage,
	ArtistDismissFilter,
	FeedDedupFilter,
	LibraryFilter,
	fillAlbumTrackIsrcs,
	type FeedStage,
	type LibraryMembershipLookup,
} from './pipeline.js';
import type { FeedTrackRef } from './types.js';
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
