// Streaming-source abstraction. Spotify and Tidal are the v1 sources;
// the types here are written so a third (Apple Music, Beatport library,
// SoundCloud, …) slots in without re-plumbing the sync loop or the UI.
//
// Three concerns are separated on purpose:
//
//   - StreamingSource — the identifier. A string union, extended when a
//     new provider lands.
//
//   - SourceCapabilities — what the provider's API supports. Hard truths
//     about the wire, not user preference. The renderer uses these to
//     decide which toggles are even shown; the core uses them to short-
//     circuit calls into adapters that wouldn't honour them.
//
//   - SourceSyncSettings — what the user chose. Layered on top of the
//     capabilities (a user can't enable a setting whose capability is
//     false). Stored renderer-side in localStorage; pushed to core when
//     core needs to gate something at the boundary.
//
// Adapter implementations themselves live in apps/core/src/sources/.
// This file is just the contract.

export type StreamingSource = 'spotify' | 'tidal';

export const STREAMING_SOURCES: readonly StreamingSource[] = ['spotify', 'tidal'] as const;

export interface SourceCapabilities {
	// Can we pull remote state (playlists + tracks) at all? false would
	// mean the provider has no read API we can use — currently every
	// source returns true here, but the flag stays for clarity + future
	// providers behind a hard paywall.
	canReadSync: boolean;
	// Can we push local changes (track add/remove, playlist create/delete,
	// reorder) back to the provider? When false, write-sync toggles are
	// disabled in the UI and the renderer disables in-place editing of
	// the provider's playlists (drag-reorder, future add/remove buttons).
	canWriteSync: boolean;
	// Sub-capabilities — checked individually so a future provider with
	// e.g. add/remove but no reorder still gets a useful UI. All are
	// gated by canWriteSync; if that's false, these are all effectively
	// false too.
	canReorder: boolean;
	canCreatePlaylist: boolean;
	canDeletePlaylist: boolean;
	canAddTracks: boolean;
	canRemoveTracks: boolean;
	canRename: boolean;
}

export interface SourceSyncSettings {
	// Pull remote changes automatically on a poll loop. When false, the
	// user has to hit "Sync now" in the connections panel.
	readSyncAuto: boolean;
	// Poll interval in minutes when readSyncAuto is true. Constrained to
	// the values in SYNC_INTERVAL_OPTIONS so the UI dropdown stays
	// finite. Ignored when readSyncAuto is false.
	readIntervalMin: number;
	// Push local changes upstream automatically as they happen. When
	// false, the local UI disables in-place edits to the provider's
	// playlists — drift between local and remote would otherwise
	// accumulate silently.
	writeSyncAuto: boolean;
}

// Discrete poll intervals the UI offers. Keeping these short keeps the
// API budget predictable; 5min is the sweet spot for Spotify (snapshot_id
// makes the "what changed?" check ~1 req per 50 playlists). 60min is
// there for users who want sync without burning quota.
export const SYNC_INTERVAL_OPTIONS = [1, 5, 15, 30, 60] as const;
export type SyncIntervalOption = typeof SYNC_INTERVAL_OPTIONS[number];

// Defaults applied at first-run / when a new key is added to the settings
// shape. Read-sync default is on at 5min; write-sync default is OFF so a
// user can't accidentally push the first local edit before they've thought
// about whether they want that.
export const DEFAULT_SOURCE_SYNC_SETTINGS: SourceSyncSettings = {
	readSyncAuto: true,
	readIntervalMin: 5,
	writeSyncAuto: false,
};

// ─── Capabilities (per-provider, static) ─────────────────────────────────
// What each provider's API actually supports. Hard-coded rather than
// probed because none of these change at runtime: it's a fact about the
// adapter we'll eventually build for that source, not about the user's
// session. Lives in shared (not core) so the renderer's settings UI can
// short-circuit toggles for capabilities a provider can't honour, without
// an IPC roundtrip.
//
// Tidal write-side is intentionally false until we commit to either the
// official developer-portal API (proper OAuth, write scopes) or the
// sniffed listen.tidal.com bearer (TOS-grey, brittle). Flipping any
// canWriteSync from false→true means the corresponding adapter MUST be
// implemented end-to-end first.

const SPOTIFY_CAPS: SourceCapabilities = {
	canReadSync:        true,
	canWriteSync:       true,
	canReorder:         true,
	canCreatePlaylist:  true,
	canDeletePlaylist:  true,
	canAddTracks:       true,
	canRemoveTracks:    true,
	canRename:          true,
};

const TIDAL_CAPS: SourceCapabilities = {
	canReadSync:        true,
	canWriteSync:       false,
	canReorder:         false,
	canCreatePlaylist:  false,
	canDeletePlaylist:  false,
	canAddTracks:       false,
	canRemoveTracks:    false,
	canRename:          false,
};

const CAPABILITIES: Record<StreamingSource, SourceCapabilities> = {
	spotify: SPOTIFY_CAPS,
	tidal:   TIDAL_CAPS,
};

export function getSourceCapabilities(source: StreamingSource): SourceCapabilities {
	return CAPABILITIES[source];
}

export function getAllSourceCapabilities(): Readonly<Record<StreamingSource, SourceCapabilities>> {
	return CAPABILITIES;
}
