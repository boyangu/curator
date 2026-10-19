// Shared sort-column resolver used by getTracks (display) AND the enrichment
// loops (so the visual indicator follows the user's current sort order rather
// than the natural storage order of the join).
//
// Each user-editable column coalesces the override over the canonical column,
// matching what the read path does — so an edited BPM also re-orders correctly.

import { sql } from 'drizzle-orm';
import { playlistTrack, track } from '@curator/shared/schema';
import type { ZTrackSortT } from '@curator/shared';

export function sortColumn(name: ZTrackSortT['column']) {
	switch (name) {
		case 'title':       return sql`coalesce(json_extract(overrides, '$.title'), title)`;
		case 'album':       return sql`coalesce(json_extract(overrides, '$.albumTitle'), album_title)`;
		// release_date is an ISO string ("2021" or "2021-03-15"); lexicographic
		// order is chronological for ISO dates. Null rows sort last on desc via
		// SQLite's NULLS-LAST default.
		case 'releaseDate': return sql`coalesce(json_extract(overrides, '$.releaseDate'), release_date)`;
		case 'label':       return sql`coalesce(json_extract(overrides, '$.label'), label)`;
		case 'genre':       return sql`coalesce(json_extract(overrides, '$.genre'), genre)`;
		case 'bpm':         return sql`coalesce(json_extract(overrides, '$.bpm'), bpm)`;
		case 'keyCamelot':  return sql`coalesce(json_extract(overrides, '$.keyCamelot'), key_camelot)`;
		case 'duration':    return track.duration;
		// The "Added" column displays added_at when set (Rekordbox-imported
		// rows), falling back to created_at (Curator scan time). The sort
		// must match what the user sees, so it coalesces in the same order.
		// Qualified: playlist views join playlist_track, which has its own
		// added_at — unqualified it's ambiguous.
		case 'createdAt':   return sql`coalesce(${track.addedAt}, ${track.createdAt})`;
		// Materialized fold of the effective primary artist, indexed — the
		// artist seam keeps it in step with overrides.artists ?? artists.
		case 'artist':      return track.artistSort;
		// Rekordbox-imported (0..5). No override layer; users edit ratings in
		// Rekordbox and re-sync. Null tracks (never imported from RB) sort to
		// the bottom on desc via SQLite's NULLS-LAST default.
		case 'rating':             return track.rating;
		// Analyzer-only scalars — populated by queue.persistResult on
		// every analysis. No override layer for these.
		case 'loudnessRangeLu':    return track.loudnessRangeLu;
		case 'dissonance':         return track.dissonance;
		case 'density':            return track.density;
		case 'brightness':         return track.brightness;
		case 'power':              return track.power;
		case 'dynamicComplexity':  return track.dynamicComplexity;
		// Phase 2A — segment-derived scalars. Only the three real-valued
		// columns are sortable; drop_count / breakdown_count are filtered
		// (= 0, >= 1), not sorted.
		case 'introLengthSec':     return track.introLengthSec;
		case 'outroLengthSec':     return track.outroLengthSec;
		case 'firstDropSec':       return track.firstDropSec;
		default: return null;
	}
}

// Resolves an "index"-sort to the right column for the context. In a playlist
// view that's the playlist_track position; outside that, fall back to createdAt
// so the column still sorts meaningfully when there's no playlist join.
export function indexSortColumn(opts: { playlistContext: boolean }) {
	return opts.playlistContext ? playlistTrack.position : track.createdAt;
}
