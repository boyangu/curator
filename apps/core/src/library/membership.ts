// Library-membership classifier — materializes track.membership (the tiered
// "how close is this to my owned library" signal). Precedence, strongest first:
//
//   local     — the track has a local-file source_link (source='local') whose
//               file is present. A link flagged missing_at (the watcher saw
//               the file vanish; the row waits for a re-bind) does not count.
//   streaming — NOT local, but in one of the user's OWN streaming playlists
//               (playlist.source in spotify/tidal AND owner_id = my spotify id,
//               OR Spotify "Liked Songs", which syncs as owner 'me' /
//               source_id 'liked-songs').
//   followed  — NOT local and NOT mine, but in a playlist the user follows
//               (a synced playlist whose owner_id is set and ≠ my id).
//   NULL      — none of the above.
//
// The whole tier is recomputed in SQLite in one CASE pass (cheap, indexed) and
// written back. Callers fire a recompute at every event that can change a
// track's local-file presence or playlist membership/ownership — see the wiring
// in createCoreService. Soft-deleted rows (deleted_at set) are skipped: their
// stored tier is meaningless (readers gate on deleted_at), and the soft-delete
// path clears it explicitly.
//
// `getMyId` resolves the connected Spotify user id (AuthService.getStatus). When
// it's null (Spotify not connected) only the `local` tier can be determined —
// "my streaming library" is undefined without an account — so streaming/followed
// collapse to NULL. The CASE's `? IS NOT NULL` guards encode exactly that.

import type Database from 'better-sqlite3';

const CHUNK = 500;

// The membership CASE expression, shared by the batched and full recompute.
// Two `?` bind the Spotify id (streaming + followed guards); the WHERE adds the
// id-chunk placeholders after them.
const MEMBERSHIP_CASE = `CASE
	WHEN EXISTS (
		SELECT 1 FROM source_link sl
		WHERE sl.track_id = track.id AND sl.source = 'local' AND sl.missing_at IS NULL
	) THEN 'local'
	WHEN ? IS NOT NULL AND EXISTS (
		SELECT 1 FROM playlist_track pt JOIN playlist p ON p.id = pt.playlist_id
		WHERE pt.track_id = track.id AND p.source IN ('spotify','tidal')
			AND (p.owner_id = ? OR p.source_id = 'liked-songs')
	) THEN 'streaming'
	WHEN ? IS NOT NULL AND EXISTS (
		SELECT 1 FROM playlist_track pt JOIN playlist p ON p.id = pt.playlist_id
		WHERE pt.track_id = track.id AND p.source IN ('spotify','tidal')
			AND p.owner_id IS NOT NULL AND p.owner_id <> ?
	) THEN 'followed'
	ELSE NULL END`;

export class MembershipClassifier {
	constructor(
		private readonly db: Database.Database,
		// Resolves the connected Spotify user id (or null when not connected).
		// Read once per recompute call so a mid-pass token change can't split it.
		private readonly getMyId: () => string | null,
	) {}

	// Recompute the tier for an explicit set of track ids (chunked at 500 to stay
	// under SQLite's bound-parameter limit). No-op on an empty list.
	recomputeForTracks(trackIds: string[]): void {
		if (trackIds.length === 0) return;
		const myId = this.getMyId();
		for (let i = 0; i < trackIds.length; i += CHUNK) {
			const chunk = trackIds.slice(i, i + CHUNK);
			const placeholders = chunk.map(() => '?').join(',');
			this.db
				.prepare(`UPDATE track SET membership = ${MEMBERSHIP_CASE}
					WHERE track.deleted_at IS NULL AND track.id IN (${placeholders})`)
				.run(myId, myId, myId, myId, ...chunk);
		}
	}

	recomputeForTrack(trackId: string): void {
		this.recomputeForTracks([trackId]);
	}

	// Full recompute over every non-deleted track. One indexed pass; used for the
	// boot seed and for events that flip the my-vs-followed split globally
	// (connect/disconnect/switch Spotify account).
	recomputeAll(): void {
		const myId = this.getMyId();
		this.db
			.prepare(`UPDATE track SET membership = ${MEMBERSHIP_CASE} WHERE track.deleted_at IS NULL`)
			.run(myId, myId, myId, myId);
	}
}
