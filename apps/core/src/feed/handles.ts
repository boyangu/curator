// Which Spotify track or album a feed item is, if any.
//
// A catalogue item carries its provider handles (payload.handles,
// FeedTrackRef.handles); an item from a local Spotify producer has none and
// is Spotify by construction (source 'spotify', sourceId = the Spotify id).
// The two meet on one row (store.ts aliases), and a legacy row can gain
// handles that do not list Spotify (a Beatport chart entry for the same
// ISRC), so the handle wins when it names Spotify and the row's own identity
// answers otherwise. Every "which Spotify track is this" question goes
// through here, so a `catalog`-source item never hands its catalogue id to
// the Spotify player.

import type { FeedHandle, FeedItemDraft, FeedItem, FeedTrackRef } from './types.js';

type ItemLike = Pick<FeedItem | FeedItemDraft, 'source' | 'sourceId' | 'payload'>;

export const spotifyHandleId = (hs: readonly FeedHandle[] | undefined): string | null => hs?.find((h) => h.provider === 'spotify')?.id ?? null;

// The Spotify track (track item) or album (album item) id, or null when the
// item is not on Spotify (yet). `source` is 'spotify' only when `sourceId` is
// a Spotify id (cloud-producer.ts).
export function spotifyIdOf(item: ItemLike): string | null {
	return spotifyHandleId(item.payload.handles) ?? (item.source === 'spotify' ? item.sourceId : null);
}

// An album track's Spotify id. A catalogue ref the Spotify player cannot
// play carries its catalogue recording id in sourceTrackId (sourceTrackId ===
// catalogId); any other ref on a Spotify album is a Spotify id.
export function trackSpotifyIdOf(ref: Pick<FeedTrackRef, 'sourceTrackId' | 'handles' | 'catalogId'>, album: Pick<FeedItem | FeedItemDraft, 'source'>): string | null {
	return spotifyHandleId(ref.handles) ?? (album.source === 'spotify' && ref.sourceTrackId !== ref.catalogId ? ref.sourceTrackId : null);
}
