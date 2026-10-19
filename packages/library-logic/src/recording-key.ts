// Recording identity for cross-item collapse — "is this the same song?" across
// a playlist TRACK item and an artist-release ALBUM item that carries it.
//
// Why not ISRC / source id: album tracklists are resolved WITHOUT ISRCs at
// ingest (fetching them doubles the per-album Spotify call volume — see
// resolveAlbumTracks), and a playlist often adds the track from a different
// release than the one the artist feed surfaces (different Spotify track id).
// Title + artist set is the identity both sides always have.
//
// Version text is KEPT ("Extended Mix" ≠ "Radio Edit" ≠ "X Remix") — those are
// distinct recordings a DJ cares about. Only formatting noise is normalized:
// Spotify writes versions as "Title - X Remix" on tracks and "Title (X Remix)"
// on releases, and "Original Mix" is the unmarked default.

function norm(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		// "Title - Version" → "Title (Version)" shape-equivalent: both reduce to
		// "title version" once punctuation becomes whitespace.
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+original mix$/, '')
		.trim();
}

export function recordingKey(title: string, artists: string[]): string {
	const names = [...new Set(artists.map(norm).filter(Boolean))].sort();
	return `${norm(title)}|${names.join(',')}`;
}
