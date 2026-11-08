// Per-artist library facts for the Discover feed's artist lenses
// (feed/lenses.ts): which artists the library holds and how often each was
// played in rekordbox sets. The library side of LibraryPort.artistSignals —
// feed/ never sees curator.db's schema.
//
// Keys match what a feed credit can carry: `name:<artist.name_ascii>` (the
// artistKey fold) for the live row AND its alias rows (a merged spelling is
// still the same artist), and `id:<spotify artist id>` from artist_link.
//
// "Holds" = a live track with an own local file (membership 'local'), the
// same "own" rule as the catalogue's follow candidates
// (catalog-client/library-candidates.ts): a track that only sits in a
// streaming playlist is not in the DJ library.

import type Database from 'better-sqlite3';

const LIBRARY_BASE = `
	SELECT DISTINCT ta.artist_id AS id, 1 AS n
	FROM track t JOIN track_artist ta ON ta.track_id = t.id
	WHERE t.deleted_at IS NULL AND t.membership = 'local'
`;

// kind 'set' = a USB/CDJ set the rekordbox history import detected (or the
// user marked); prep sessions and in-app plays don't count. Plays whose track
// isn't matched yet (track_id NULL) drop out.
//
// Sessions first, then only the tracks they played (CROSS JOIN pins that
// order): left to itself the planner walks every live track through
// track_deleted_at_idx and reads each wide row — ~215 ms on the live library
// (2026-11-04) against ~40 ms this way, same result.
const SET_PLAYS_BASE = `
	WITH plays AS (
		SELECT pe.track_id AS tid, COUNT(*) AS n
		FROM play_session ps CROSS JOIN play_event pe ON pe.session_id = ps.id
		WHERE ps.kind = 'set' AND pe.track_id IS NOT NULL
		GROUP BY pe.track_id
	)
	SELECT ta.artist_id AS id, SUM(p.n) AS n
	FROM plays p
	CROSS JOIN track t ON t.id = p.tid AND t.deleted_at IS NULL
	CROSS JOIN track_artist ta ON ta.track_id = p.tid
	GROUP BY ta.artist_id
`;

function keyCounts(raw: Database.Database, base: string): Map<string, number> {
	const rows = raw.prepare(`
		WITH base AS (SELECT * FROM (${base}))
		SELECT 'name:' || a.name_ascii AS k, base.n AS n FROM base JOIN artist a ON a.id = base.id WHERE a.name_ascii <> ''
		UNION ALL
		SELECT 'name:' || a.name_ascii, base.n FROM base JOIN artist a ON a.merged_into = base.id WHERE a.name_ascii <> ''
		UNION ALL
		SELECT 'id:' || l.source_id, base.n FROM base JOIN artist_link l ON l.artist_id = base.id AND l.source = 'spotify'
	`).all() as { k: string; n: number }[];
	const out = new Map<string, number>();
	for (const r of rows) out.set(r.k, Math.max(out.get(r.k) ?? 0, r.n));
	return out;
}

// Two synchronous scans (~50-80 ms and ~40 ms on the live library), so the
// caller yields to the event loop between them rather than holding the main
// loop for both; the feed caches the result for ten minutes.
export function libraryArtistKeys(raw: Database.Database): Set<string> {
	return new Set(keyCounts(raw, LIBRARY_BASE).keys());
}

export function setPlayCounts(raw: Database.Database): Map<string, number> {
	return keyCounts(raw, SET_PLAYS_BASE);
}
