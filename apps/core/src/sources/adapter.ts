// StreamingSourceAdapter — the contract every remote provider implements.
//
// Today nothing implements this directly: Spotify sync lives in
// sync/spotify.ts and Tidal read sync in sync/tidal.ts (official OAuth;
// only downloads still use the sniffed-session bearer).
// The interface exists so:
//
//   (1) the future poll-driven sync scheduler (planned: a single loop
//       in core that fans out to every registered adapter at its
//       per-source interval) has one shape to call against, and
//
//   (2) write operations triggered by the UI (drag-reorder today,
//       playlist CRUD tomorrow) route through one place that can
//       check capabilities + user settings + push upstream.
//
// Methods deliberately mirror what Spotify offers (since that's the
// most fleshed-out API surface). Providers that can't honour a method
// declare so via SourceCapabilities; the scheduler / write router
// short-circuits before calling.

import type { StreamingSource, SourceCapabilities } from '@curator/shared';

// Minimal shape of a remote playlist as seen on the wire. NOT the
// curator `Playlist` row — that's the canonical local representation
// with extra columns (favorite, sync metadata, etc.). The adapter
// returns this lean shape; the sync loop reconciles it into a Playlist.
export interface RemotePlaylistRef {
	// Stable id used by the provider — Spotify playlist id, Tidal uuid, etc.
	remoteId: string;
	name: string;
	// Provider's per-playlist version hash. Spotify exposes snapshot_id;
	// Tidal doesn't have an equivalent (we'd diff against trackCount +
	// lastUpdated instead). Adapters that can't supply one return null
	// and the scheduler falls back to always-refetch.
	snapshotId: string | null;
	// Total tracks per the remote — used to detect changes when snapshotId
	// is unavailable, and to size progress bars.
	trackCount: number;
}

// Minimal remote track payload. The sync loop turns these into local
// tracks (or attaches new source_links to existing matched tracks).
// Adapters return whatever they have — fields that the provider doesn't
// expose are null. ISRC is the prime cross-provider match key, so
// adapters should populate it when the API gives it.
export interface RemoteTrackRef {
	remoteId: string;
	title: string;
	artistNames: string[];
	albumTitle: string | null;
	durationSec: number | null;
	isrc: string | null;
}

export interface StreamingSourceAdapter {
	readonly source: StreamingSource;
	readonly displayName: string;
	readonly capabilities: SourceCapabilities;

	// ── Read ──────────────────────────────────────────────────────────
	// Walk the user's library on the provider. Adapters paginate
	// internally; returning the whole list keeps the caller simple.
	// Throws when the session is missing / expired — caller is
	// expected to surface a "reconnect" toast.
	listRemotePlaylists(): Promise<RemotePlaylistRef[]>;

	// Fetch every track of a single playlist. Same pagination contract
	// as above — adapter unrolls pages internally. Order matches the
	// remote's playlist order so we can mirror playlist_track.position.
	fetchPlaylistTracks(remoteId: string): Promise<RemoteTrackRef[]>;

	// ── Write ─────────────────────────────────────────────────────────
	// Every write throws if the corresponding capability is false; the
	// router should check capabilities before calling, but adapters
	// double-check as a defense-in-depth guard. Returning the new
	// snapshotId (when the provider exposes one) lets the caller
	// short-circuit the next poll for this playlist.
	createPlaylist(name: string, opts?: { description?: string; isPublic?: boolean }): Promise<RemotePlaylistRef>;
	deletePlaylist(remoteId: string): Promise<void>;
	renamePlaylist(remoteId: string, name: string): Promise<void>;
	addTracks(remoteId: string, remoteTrackIds: string[]): Promise<{ snapshotId: string | null }>;
	removeTracks(remoteId: string, remoteTrackIds: string[]): Promise<{ snapshotId: string | null }>;
	// Full replacement — sends the entire new ordering. Spotify's
	// PUT /playlists/{id}/tracks supports this in chunks of 100; the
	// adapter is responsible for chunking. CAUTION: a full replace
	// re-adds every item, which RESETS the provider's per-item added-at
	// (this flattened ~80 playlists' recency in the 2026-06-27 recovery).
	// Reorders must prefer reorderTracks; replace is the fallback for
	// providers without a positional API and for genuine replacement.
	replaceTracks(remoteId: string, remoteTrackIds: string[]): Promise<{ snapshotId: string | null }>;
	// Positional reorder — moves rows in place (Spotify's range_start /
	// insert_before form), so per-item added-at survives. Indices are
	// pre-move positions in the remote's current order; moves apply
	// sequentially. Optional: providers without a positional API omit it
	// and callers fall back to replaceTracks.
	reorderTracks?(
		remoteId: string,
		moves: Array<{ rangeStart: number; insertBefore: number }>,
		snapshotId?: string | null,
	): Promise<{ snapshotId: string | null }>;
}

// ── Remote-write gate ───────────────────────────────────────────────────────
// Every mutation of a user's live streaming account (playlist CRUD, track
// add/remove/reorder, unfollow) is a "remote write". These are DEFAULT-DENY:
// they execute only when a RemoteWritePolicy is injected — and that injection
// happens in exactly one place, the desktop main process, where the UI has
// already taken the user's confirmation. Off-product code (one-off scripts,
// tests, the headless CLI, the read-only core-sidecar) constructs the service
// without a policy, so its remote writes throw before any HTTP call. This is the
// hard floor that stops an agent (or a stray sync) from mutating the real
// account by "simply running some off-product code" — see CLAUDE.md.

export type RemoteWriteOp =
	| 'createPlaylist' | 'deletePlaylist' | 'renamePlaylist'
	| 'addTracks' | 'removeTracks' | 'replaceTracks' | 'reorderTracks'
	| 'unfollowPlaylist' | 'unfollowArtist';

export interface RemoteWriteRequest {
	source: StreamingSource;
	op: RemoteWriteOp;
	remoteId?: string;  // playlist / artist id
	name?: string;      // for create/rename
	count?: number;     // # tracks affected, where relevant
}

// Injected ONLY by the desktop main process. Absent ⇒ default-deny.
export interface RemoteWritePolicy {
	allow(req: RemoteWriteRequest): boolean;
}

export class RemoteWriteDeniedError extends Error {
	constructor(public readonly request: RemoteWriteRequest) {
		super(
			`Remote write denied: ${request.op} on ${request.source}` +
			`${request.remoteId ? ` (${request.remoteId})` : ''} — no RemoteWritePolicy. ` +
			`Remote streaming writes only run inside the desktop app; off-product code is default-deny.`,
		);
		this.name = 'RemoteWriteDeniedError';
	}
}

// Throws RemoteWriteDeniedError unless the injected policy permits the write.
// A missing policy denies everything. `onAudit` (when provided) records every
// attempt — allowed AND denied; a denial is exactly the suspicious event a
// forensics pass wants — and must never be able to break the write path, so
// it's wrapped in its own try/catch.
export type RemoteWriteGate = (req: RemoteWriteRequest) => void;
export function makeRemoteWriteGate(
	policy: RemoteWritePolicy | undefined,
	onAudit?: (entry: Record<string, unknown>) => void,
): RemoteWriteGate {
	return (req) => {
		const allowed = !!policy && policy.allow(req);
		try {
			onAudit?.({ kind: 'remote-write', allowed, ...req });
		} catch { /* audit must never block the gate */ }
		if (!allowed) throw new RemoteWriteDeniedError(req);
	};
}

// Wrap an adapter so every MUTATING method passes through the gate before
// delegating; read methods (listRemotePlaylists / fetchPlaylistTracks) pass
// straight through. Wrapping the adapter — rather than gating at each call site
// — means a new write method can't be added without going through the gate.
export function guardRemoteWrites(adapter: StreamingSourceAdapter, gate: RemoteWriteGate): StreamingSourceAdapter {
	const source = adapter.source;
	return {
		source: adapter.source,
		displayName: adapter.displayName,
		capabilities: adapter.capabilities,
		listRemotePlaylists: () => adapter.listRemotePlaylists(),
		fetchPlaylistTracks: (remoteId) => adapter.fetchPlaylistTracks(remoteId),
		createPlaylist: (name, opts) => {
			gate({ source, op: 'createPlaylist', name });
			return adapter.createPlaylist(name, opts);
		},
		deletePlaylist: (remoteId) => {
			gate({ source, op: 'deletePlaylist', remoteId });
			return adapter.deletePlaylist(remoteId);
		},
		renamePlaylist: (remoteId, name) => {
			gate({ source, op: 'renamePlaylist', remoteId, name });
			return adapter.renamePlaylist(remoteId, name);
		},
		addTracks: (remoteId, ids) => {
			gate({ source, op: 'addTracks', remoteId, count: ids.length });
			return adapter.addTracks(remoteId, ids);
		},
		removeTracks: (remoteId, ids) => {
			gate({ source, op: 'removeTracks', remoteId, count: ids.length });
			return adapter.removeTracks(remoteId, ids);
		},
		replaceTracks: (remoteId, ids) => {
			gate({ source, op: 'replaceTracks', remoteId, count: ids.length });
			return adapter.replaceTracks(remoteId, ids);
		},
		// Spread-conditional so the wrapped adapter's `reorderTracks` stays
		// undefined when the provider has none — callers feature-detect it.
		...(adapter.reorderTracks ? {
			reorderTracks: (remoteId: string, moves: Array<{ rangeStart: number; insertBefore: number }>, snapshotId?: string | null) => {
				gate({ source, op: 'reorderTracks', remoteId, count: moves.length });
				return adapter.reorderTracks!(remoteId, moves, snapshotId);
			},
		} : {}),
	};
}
