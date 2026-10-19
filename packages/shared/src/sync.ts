// Provider-neutral types for bidirectional DJ-app sync (Rekordbox today;
// Traktor / Serato later). The three-way merge engine, the baseline
// snapshots stored on each provider's link table, and the persisted
// conflict rows all speak these shapes — only the transport (sidecar,
// reader/writer) is provider-specific.

export const DJ_SYNC_PROVIDERS = ['rekordbox'] as const;
export type DjSyncProvider = (typeof DJ_SYNC_PROVIDERS)[number];

// The bidirectional metadata surface. Fields outside this set (bpm, key,
// playCount, lastPlayedAt, addedAt) are app-authoritative one-way pulls
// and never produce conflicts.
export const SYNC_FIELD_KEYS = [
	'title',
	'artist',
	'album',
	'genre',
	'label',
	'rating',
	'comment',
	'colorLabel',
] as const;
export type SyncFieldKey = (typeof SYNC_FIELD_KEYS)[number];

// Baseline snapshot: the external app's field values as of the last sync
// (pulled or pushed). `artist` is the joined display string — the external
// apps store a single artist entity, Curator joins TrackArtist[] with ", "
// on push, so string comparison is the contract. Partial: a missing key
// means "no baseline for this field yet" (bootstrap per field).
export type FieldsSeen = Partial<Record<SyncFieldKey, string | number | null>>;

// One user-visible cue as a merge unit — position/length/color/name move
// together. Hot cues are identified by slot (pad letter); memory cues by
// position (their slot is an ordinal-by-time that shifts when an earlier
// cue is inserted, so it is NOT identity).
export type CueUnit = {
	kind: 'hot' | 'memory';
	slot: number;
	positionSec: number;
	lengthSec: number | null;
	color: string | null;
	name: string | null;
};

// Stable identity key for a cue unit within one track. See CueUnit on why
// memory cues key by position instead of slot.
export function cueUnitKey(u: Pick<CueUnit, 'kind' | 'slot' | 'positionSec'>): string {
	return u.kind === 'hot' ? `hot:${u.slot}` : `memory:${Math.round(u.positionSec * 1000)}`;
}

// A pending both-sides-changed conflict, as surfaced to the renderer.
// `ours` = Curator's live value (resolved at listing time, not stored);
// `theirs` = the external app's value captured at detection time. For cue
// conflicts the values are CueUnit | null (null = deleted on that side).
export interface SyncConflict {
	id: string;
	provider: DjSyncProvider;
	// For track-scoped conflicts ('field'/'cue') this is the curator track id.
	// For playlist-scoped conflicts ('order') it's a synthetic `playlist:<rbId>`
	// grouping key — no track row exists for it.
	trackId: string;
	// For 'order' conflicts this carries the PLAYLIST name (the list groups by
	// trackId, so the playlist gets its own group header).
	trackTitle: string;
	trackArtist: string;
	kind: 'field' | 'cue' | 'order';
	fieldKey: string; // SyncFieldKey, cueUnitKey() for cue, or 'order'
	// For 'field'/'cue': scalar / CueUnit values. For 'order': string[] of
	// rb_content_ids in each side's order (the renderer shows a track-count
	// summary, not the raw ids).
	baseValue: unknown;
	theirsValue: unknown;
	oursValue: unknown;
	// Set only on 'order' conflicts — the rb-side playlist id resolution targets.
	rbPlaylistId?: string;
}

export type SyncConflictChoice = 'ours' | 'theirs';
