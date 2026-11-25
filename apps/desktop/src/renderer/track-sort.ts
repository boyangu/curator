// In-memory re-sort of a library list the renderer already holds, in the
// order core's `ORDER BY` would return it (apps/core/src/sync/sort.ts
// sortColumn + service.ts applyTrackSort — keep the two in step). A header
// click on a 39k source root used to re-run tracks:list: the query, the
// decorations and the ~59 MB clone back, all synchronous on main, for rows
// the renderer already had.
//
// SQLite semantics reproduced here: NULL sorts below every value (first on
// asc, last on desc); text compares byte-wise (BINARY collation, so case-
// sensitive — code-unit order matches UTF-8 byte order outside astral
// characters); ties keep the incoming order (SQL leaves them unspecified).
// Rows arrive with overrides already applied (applyOverrides), so the
// effective fields are the ones the SQL coalesces.

import type { Track } from '@curator/shared';
import type { SortColumn, SortDir } from './track-list.js';

type Key = string | number | null;

// Dates cross IPC as Date (structured clone); tolerate epoch numbers too.
const time = (v: Date | number | null | undefined): number | null =>
	v == null ? null : v instanceof Date ? v.getTime() : v;

const KEYS: Partial<Record<SortColumn, (t: Track) => Key>> = {
	title: (t) => t.title,
	artist: (t) => t.artistSort,
	album: (t) => t.albumTitle,
	releaseDate: (t) => t.releaseDate,
	label: (t) => t.label,
	genre: (t) => t.genre,
	bpm: (t) => t.bpm,
	keyCamelot: (t) => t.keyCamelot,
	duration: (t) => t.duration,
	// coalesce(added_at, created_at); a tag view's read already put
	// track_tag.added_at in addedAt.
	createdAt: (t) => time(t.addedAt) ?? time(t.createdAt),
	rating: (t) => t.rating,
	loudnessRangeLu: (t) => t.loudnessRangeLu,
	dissonance: (t) => t.dissonance,
	density: (t) => t.density,
	brightness: (t) => t.brightness,
	power: (t) => t.power,
	dynamicComplexity: (t) => t.dynamicComplexity,
	prodLufs: (t) => t.prodLufs,
	prodPlr: (t) => t.prodPlr,
	prodScore: (t) => t.prodScore,
	audioboxPq: (t) => t.audioboxPq,
};

// NULL < numbers < text, as SQLite orders mixed storage classes.
function compareKeys(a: Key, b: Key): number {
	if (a === b) return 0;
	if (a === null) return -1;
	if (b === null) return 1;
	const ta = typeof a, tb = typeof b;
	if (ta !== tb) return ta === 'number' ? -1 : 1;
	return a < b ? -1 : 1;
}

// `playlistContext`: the list was read for one playlist (filter.playlistId),
// where `index` is the playlist position; anywhere else it is createdAt.
// Returns null for an order only the server can produce ('match' is ranked
// inside a similarTo read).
export function sortLikeDb(
	tracks: readonly Track[],
	sort: { column: SortColumn; dir: SortDir },
	ctx: { playlistContext: boolean },
): Track[] | null {
	const key = sort.column === 'index'
		? ctx.playlistContext ? (t: Track) => t.playlistPosition ?? null : (t: Track) => time(t.createdAt)
		: KEYS[sort.column];
	if (!key) return null;
	const sign = sort.dir === 'asc' ? 1 : -1;
	return tracks
		.map((t, i) => ({ t, i, k: key(t) }))
		.sort((a, b) => compareKeys(a.k, b.k) * sign || a.i - b.i)
		.map((x) => x.t);
}
