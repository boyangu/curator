// Curator's "ours" side of the bidirectional sync, as effective values
// (override ?? canonical). Both the rb exporter (push) and the rb importer
// (pull/merge) read THIS view — if they computed "ours" independently they
// could disagree about whether a field changed, and the merge engine's
// zero-override guarantee falls apart.

import { DEFAULT_ARTIST_CREDIT_FORMAT, formatArtistCredit, formatTrackTitle, type ArtistCreditFormat, type FieldsSeen, type TrackArtist, type TrackOverrides } from '@curator/shared';

export interface CuratorTrackView {
	title: string;
	artists: TrackArtist[];
	albumTitle: string | null;
	label: string | null;
	genre: string | null;
	rating: number | null;
	comment: string | null;
	colorLabel: string | null;
	overrides: TrackOverrides | null;
}

// Title as rekordbox should hold it: the effective title with its remix
// segment re-wrapped in the user's style (Settings → User Interface,
// stored in core's app_setting so every renderer origin and the push agree).
// The stored title keeps the release wording; see formatTrackTitle.
export function effectiveTitle(t: Pick<CuratorTrackView, 'title' | 'artists' | 'overrides'>, fmt: ArtistCreditFormat = DEFAULT_ARTIST_CREDIT_FORMAT): string {
	return formatTrackTitle(t.overrides?.title ?? t.title, t.overrides?.artists ?? t.artists, fmt.remixStyle);
}

export function effectiveAlbum(t: Pick<CuratorTrackView, 'albumTitle' | 'overrides'>): string | null {
	return t.overrides?.albumTitle ?? t.albumTitle;
}

export function effectiveLabel(t: Pick<CuratorTrackView, 'label' | 'overrides'>): string | null {
	return t.overrides?.label ?? t.label;
}

export function effectiveGenre(t: Pick<CuratorTrackView, 'genre' | 'overrides'>): string | null {
	return t.overrides?.genre ?? t.genre;
}

/**
 * Curator carries multiple artists per track ({name, role}[]). Rekordbox
 * has a single DjmdArtist FK per content, so the line is the same string
 * the app displays: every credited name in credit order (remixers as plain
 * names — the title says who remixed) joined by the user's separator,
 * featured last with "feat.". The format comes from core's app_setting,
 * never from a renderer, so push and pull-side comparison can't drift.
 */
export function effectiveArtistName(t: Pick<CuratorTrackView, 'artists' | 'overrides'>, fmt: ArtistCreditFormat = DEFAULT_ARTIST_CREDIT_FORMAT): string | null {
	const arr = t.overrides?.artists ?? t.artists;
	if (!arr || arr.length === 0) return null;
	return formatArtistCredit(arr, fmt) || null;
}

// The full merge surface as a FieldsSeen-shaped map. Keys mirror what the
// rb delta row carries on the pull side and what buildWriteOps pushes.
export function curatorFieldsView(t: CuratorTrackView, fmt: ArtistCreditFormat = DEFAULT_ARTIST_CREDIT_FORMAT): FieldsSeen {
	return {
		title: effectiveTitle(t, fmt),
		artist: effectiveArtistName(t, fmt),
		album: effectiveAlbum(t),
		genre: effectiveGenre(t),
		label: effectiveLabel(t),
		rating: t.rating,
		comment: t.comment,
		colorLabel: t.colorLabel,
	};
}
