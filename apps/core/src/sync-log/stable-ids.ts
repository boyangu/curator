// Deterministic ids for rows two devices create independently from the same
// upstream source (cloud plan: streaming identity §2). A Spotify or Tidal
// read-sync on two desktops reads the same provider list; when each minted
// random ids for the playlist and its rows, the op log ended with two
// playlists (one skipped as a provider clash) or two rows per item (the
// 2026-10-20 second-desktop incident: every entry an `add` with a fresh
// UUID). Ids derived from what both devices read make the two imports the
// same ops on the same ids, which the reducer folds into one.
//
// Only the provider-owned rows are derived. A user's own add to a streaming
// playlist, local and rekordbox playlists keep random ids: nothing upstream
// names them, so there is nothing for two devices to agree on. Existing
// random-id rows are not migrated: a read-sync matches rows by track, and the
// streaming dedupe (playlist-dedupe.ts) folds the doubles two devices left.

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

type Raw = Database.Database;

// RFC 4122 version-5 UUID of `name` under `namespace`.
export function uuidv5(namespace: string, name: string): string {
	const hash = createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(name, 'utf8').digest();
	const b = hash.subarray(0, 16);
	b[6] = (b[6]! & 0x0f) | 0x50; // version 5
	b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
	const hex = b.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Fixed namespaces. Changing one would give every device's next import new
// ids for rows it already holds under the old ones, so they never change.
const MEMBER_NAMESPACE = '3b9f6d2a-8c41-5e7a-b0d3-4f2e1a6c9d85';
const PLAYLIST_NAMESPACE = '0c7e5a19-2f64-5d83-9b1a-e6d4c2f08a37';

// NUL separates the parts: none of them can contain it, so no two
// (playlist, track, occurrence) triples share a name.
const SEP = '\u0000';

// A streaming playlist's row for the `occurrence`-th time (0-based) the
// provider list holds `providerTrackId`. `bump` > 0 only when that id is
// already held by another row here (see memberIdAllocator).
export function streamingMemberId(playlistId: string, providerTrackId: string, occurrence: number, bump = 0): string {
	return uuidv5(MEMBER_NAMESPACE, [playlistId, providerTrackId, String(occurrence), ...(bump > 0 ? [`b${bump}`] : [])].join(SEP));
}

// A streaming playlist's id. `generation` moves past a deleted one: a
// playlist the user deleted keeps its tombstone (a container delete wins
// over everything), so following the same provider playlist again must
// land on a new id, and every device that sees the same tombstone picks the
// same one.
export function streamingPlaylistId(source: string, sourceId: string, generation = 0): string {
	return uuidv5(PLAYLIST_NAMESPACE, [source, sourceId, ...(generation > 0 ? [String(generation)] : [])].join(SEP));
}

// The id a newly imported provider playlist takes: the smallest generation
// with no tombstone and no local row of another provider playlist. Callers
// have already looked the playlist up by (source, source_id), so a row under
// that id here is a stale one this device cannot reuse.
export function nextStreamingPlaylistId(raw: Raw, source: string, sourceId: string): string {
	const tomb = raw.prepare(`SELECT 1 FROM tombstone WHERE entity = 'playlist' AND entity_id = ?`).pluck();
	const row = raw.prepare(`SELECT 1 FROM playlist WHERE id = ?`).pluck();
	for (let g = 0; ; g++) {
		const id = streamingPlaylistId(source, sourceId, g);
		if (tomb.get(id) === undefined && row.get(id) === undefined) return id;
	}
}

// Ids for the rows one reconcile inserts. `taken` is a row id already in
// playlist_track here (bound to another track: the same id from another
// device whose recording this device has not merged yet would collide on
// the primary key); the next bump is tried. A tombstoned id is reused on
// purpose: a re-add with a later clock wins over the old remove, and every
// device that re-imports the item reaches the same id.
export function memberIdAllocator(raw: Raw, playlistId: string): (providerTrackId: string, occurrence: number) => string {
	const held = raw.prepare(`SELECT 1 FROM playlist_track WHERE id = ?`).pluck();
	const used = new Set<string>();
	return (providerTrackId, occurrence) => {
		for (let bump = 0; ; bump++) {
			const id = streamingMemberId(playlistId, providerTrackId, occurrence, bump);
			if (used.has(id) || held.get(id) !== undefined) continue;
			used.add(id);
			return id;
		}
	};
}

// The ids a recording's rows in a streaming playlist would have if a
// read-sync minted them (any of its provider ids, the first `occurrences`
// occurrences, the first few bumps). The dedupe never removes such a row:
// it is the provider's own, and every device converges on it.
export function isStreamingMemberId(rowId: string, playlistId: string, providerTrackIds: readonly string[], occurrences: number): boolean {
	for (const p of providerTrackIds) {
		for (let k = 0; k < occurrences; k++) {
			for (let bump = 0; bump < 3; bump++) if (streamingMemberId(playlistId, p, k, bump) === rowId) return true;
		}
	}
	return false;
}
