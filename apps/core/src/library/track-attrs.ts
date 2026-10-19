// Pinned + owning-streaming-source resolution for the feed's library-membership
// chips. The materialized track.membership column (see membership.ts) carries
// only the coarse tier (local/streaming/followed); these are the two extra
// signals the Discover chips need on top of it:
//   • PINNED  — the track carries the `interested` ("Pinned") tag, which the
//     feed surfaces as "In Library" however the track entered the library.
//   • SOURCE  — for a track in one of the user's OWN streaming playlists, which
//     source holds it (names the "In {Spotify|Tidal} Library" chip). Spotify
//     wins over Tidal when both hold it.
//
// Read-only curator.db query — lives on the core (library) side, NOT in feed/,
// so the feed module stays free of curator.db schema (the cloud seam). The two
// feed LibraryPort probes in service.ts call this and fan the result onto their
// ISRC / spotify-id keyed maps. Chunked at 500 to stay under SQLite's bound-
// parameter cap.

import { and, eq, inArray, or } from 'drizzle-orm';
import type { StreamingSource } from '@curator/shared';
import { playlist, playlistTrack, trackTag } from '@curator/shared/schema';
import type { Db } from '../db/client.js';

const CHUNK = 500;

export interface LibraryTrackAttrs {
	pinned: Set<string>;
	source: Map<string, StreamingSource>;
}

export function libraryTrackAttrs(db: Db, myId: string | null, trackIds: string[]): LibraryTrackAttrs {
	const pinned = new Set<string>();
	const source = new Map<string, StreamingSource>();
	if (trackIds.length === 0) return { pinned, source };
	// Mirror the MembershipClassifier's own-playlist predicate. Without a
	// connected Spotify id "my library" is undefined (the classifier's
	// `? IS NOT NULL` guard), so only the "Liked Songs" pseudo-playlist qualifies.
	const ownership = myId != null
		? or(eq(playlist.ownerId, myId), eq(playlist.sourceId, 'liked-songs'))
		: eq(playlist.sourceId, 'liked-songs');
	for (let i = 0; i < trackIds.length; i += CHUNK) {
		const chunk = trackIds.slice(i, i + CHUNK);
		for (const r of db
			.select({ tid: trackTag.trackId })
			.from(trackTag)
			.where(and(eq(trackTag.tagId, 'interested'), inArray(trackTag.trackId, chunk)))
			.all())
			pinned.add(r.tid);
		const rows = db
			.select({ tid: playlistTrack.trackId, src: playlist.source })
			.from(playlistTrack)
			.innerJoin(playlist, eq(playlist.id, playlistTrack.playlistId))
			.where(and(inArray(playlistTrack.trackId, chunk), inArray(playlist.source, ['spotify', 'tidal']), ownership))
			.all();
		for (const r of rows) {
			if (r.src !== 'spotify' && r.src !== 'tidal') continue;
			if (source.get(r.tid) === 'spotify') continue; // spotify already wins
			source.set(r.tid, r.src);
		}
	}
	return { pinned, source };
}
