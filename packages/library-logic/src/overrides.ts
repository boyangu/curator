// User-override merge — applied at every read path so the displayed values
// match the user's intent regardless of what sync/enrichment pulls in.
//
// The override layer (`track.overrides` JSON column) lives ABOVE canonical
// fields: canonical comes from providers (Spotify, Beatport, Tidal); the
// override is what the user explicitly typed in the Edit Track modal.
// Reads merge override → canonical so the user always sees their last word.
//
// Typed structurally rather than against the desktop's drizzle `Track` row so
// the cloud and the phone, which hold tracks in their own shapes, apply the
// same rule; any row carrying these fields keeps its own type through.

import type { TrackArtist, TrackOverrides } from '@curator/shared';

export interface OverridableFields {
	title: string;
	artists: TrackArtist[];
	albumTitle: string | null;
	label: string | null;
	genre: string | null;
	bpm: number | null;
	keyCamelot: string | null;
	releaseDate: string | null;
	overrides: TrackOverrides | null;
}

export function applyOverrides<T extends OverridableFields>(t: T): T {
	const o = t.overrides;
	if (!o) return t;
	return {
		...t,
		title:       o.title       ?? t.title,
		artists:     o.artists     ?? t.artists,
		albumTitle:  o.albumTitle  ?? t.albumTitle,
		label:       o.label       ?? t.label,
		genre:       o.genre       ?? t.genre,
		bpm:         o.bpm         ?? t.bpm,
		keyCamelot:  o.keyCamelot  ?? t.keyCamelot,
		releaseDate: o.releaseDate ?? t.releaseDate,
	};
}
