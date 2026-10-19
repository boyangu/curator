// Library mutators (cloud plan B4): one function per entity change, each
// performing the local write AND emitting its ops in ONE transaction, so the
// outbox can never disagree with the tables. This finally honours the
// 2026-05 stack rule — "every write goes through one mutator per entity" —
// for the state the op log carries (design: "Syncs through the op log").
//
// Conventions:
//   - Take the ROOT Db (rawOf throws on a drizzle tx handle). The writes run
//     on its connection, so inside a caller's transaction they join it (the
//     mutator's own transaction becomes a savepoint) — bulk importers keep
//     their chunked transactions and emit inside them.
//   - Ops address tracks by recording_id, never track.id (rows.ts resolves
//     and heals it; derived WAV copies resolve to null and emit nothing).
//   - Writers whose patch logic lives elsewhere (the rekordbox three-way
//     merge, conflict resolution, artist credit rewrites) go through the
//     record* helpers: snapshot the synced fields, run the write, emit the
//     diff. Same transaction, so the result is the same as a hand-written
//     mutator and the patch logic keeps one home.
//
// What is NOT here (device-local, never an op — cloud decisions 2026-10-17
// and design "Does not"): derived WAV copies and their playlist
// (wav/materialize.ts, wav/convert-run.ts), analysis rows, the album/artist
// derived tables (an artist rename travels as an artist_alias rule, see
// emitArtistAliases, and each device projects it onto its own table), cover caches, rekordbox link/baseline/conflict tables,
// source_link file columns, playlist sync stamps and per-device settings.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isAccountSettingKey, keysBetween, rebalance, type JsonValue, type NewOp } from '@curator/protocol';
import { artistKey, searchFold } from '@curator/shared';
import { appSetting, playlist as playlistTable, pinnedSearch as pinnedSearchTable, type NewPlaylist, type NewPlaylistTrack } from '@curator/shared/schema';
import type { Db } from '../db/client.js';
import { rawOf } from './artists.js';
import { appendRows, planReorderKeys, recomputePositions, type MemberDraft } from './playlist-order.js';
import { emitOps, type EmitOp } from '../sync-log/outbox.js';
import {
	cueDeleteOp,
	cueDiffOps,
	cueUpsertOp,
	folderCreateOp,
	isDeviceLocalPlaylist,
	readCues,
	readTrackState,
	readTrackTags,
	recordingOf,
	recordingResolver,
	trackStateDiffOps,
	trackStateOps,
	trackTagOp,
	type CueRow,
	type TrackStateRow,
	playlistCreateOps,
	pinnedCreateOp,
	tagCreateOp,
} from '../sync-log/rows.js';

type Raw = Database.Database;

// Who is writing. Everything but 'remote' emits; 'remote' is the apply side
// (an op that already exists must not be echoed back as a new edit).
export type MutationOrigin = 'user' | 'spotify' | 'tidal' | 'rekordbox' | 'scanner' | 'migrate' | 'remote';

function tx<T>(db: Db, fn: (raw: Raw) => T): T {
	const raw = rawOf(db);
	return raw.transaction(() => fn(raw))();
}

const CHUNK = 500;
function chunks<T>(xs: readonly T[], size = CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
	return out;
}

// ── tag ─────────────────────────────────────────────────────────────────────

export function createTag(db: Db, t: { id?: string; name: string; kind?: 'user' | 'system'; color?: string | null; sortOrder?: number }): string {
	const id = t.id ?? randomUUID();
	tx(db, (raw) => {
		raw.prepare(`INSERT INTO tag (id, name, kind, color, sort_order) VALUES (?, ?, ?, ?, ?)`).run(id, t.name, t.kind ?? 'user', t.color ?? null, t.sortOrder ?? 0);
		emitOps(raw, [{ entity: 'tag', entity_id: id, kind: 'create', payload: { name: t.name, kind: t.kind ?? 'user', color: t.color ?? null } }]);
	});
	return id;
}

export function renameTag(db: Db, id: string, name: string): boolean {
	return tx(db, (raw) => {
		const changed = raw.prepare(`UPDATE tag SET name = ? WHERE id = ? AND name != ?`).run(name, id, name).changes > 0;
		if (changed && name.trim()) emitOps(raw, [{ entity: 'tag', entity_id: id, kind: 'rename', payload: { name } }]);
		return changed;
	});
}

export function setTagColour(db: Db, id: string, color: string | null): void {
	tx(db, (raw) => {
		if (raw.prepare(`UPDATE tag SET color = ? WHERE id = ?`).run(color, id).changes > 0) {
			emitOps(raw, [{ entity: 'tag', entity_id: id, kind: 'set-colour', payload: { color } }]);
		}
	});
}

// Same shape as recordPlaylistWrite, for tag upserts (rekordbox MyTags).
export function recordTagWrite<T>(db: Db, tagId: string, write: () => T): T {
	return tx(db, (raw) => {
		type Row = { name: string; color: string | null };
		const read = raw.prepare(`SELECT name, color FROM tag WHERE id = ?`);
		const before = read.get(tagId) as Row | undefined;
		const result = write();
		const after = read.get(tagId) as Row | undefined;
		if (!after) return result;
		if (!before) {
			const op = tagCreateOp(raw, tagId);
			if (op) emitOps(raw, [op]);
			return result;
		}
		const ops: EmitOp[] = [];
		if (after.name !== before.name && after.name.trim()) ops.push({ entity: 'tag', entity_id: tagId, kind: 'rename', payload: { name: after.name } });
		if ((after.color ?? null) !== (before.color ?? null)) ops.push({ entity: 'tag', entity_id: tagId, kind: 'set-colour', payload: { color: after.color ?? null } });
		emitOps(raw, ops);
		return result;
	});
}

// The tag and every assignment of it. The tombstone (container delete) is
// what keeps a late assignment from another device from resurrecting it.
export function deleteTag(db: Db, id: string): boolean {
	return tx(db, (raw) => {
		raw.prepare(`DELETE FROM track_tag WHERE tag_id = ?`).run(id);
		const gone = raw.prepare(`DELETE FROM tag WHERE id = ?`).run(id).changes > 0;
		if (gone) emitOps(raw, [{ entity: 'tag', entity_id: id, kind: 'delete', payload: {} }]);
		return gone;
	});
}

// ── track_tag ───────────────────────────────────────────────────────────────

// Assign `tagId` to each track not already carrying it. Returns the track ids
// that gained the tag. `bump` marks them dirty for the rekordbox incremental
// sweep (track.updated_at), which user edits want and imports must not do.
export function tagTracks(db: Db, trackIds: readonly string[], tagId: string, opts: { addedAt?: Date; bump?: boolean } = {}): string[] {
	if (trackIds.length === 0) return [];
	return tx(db, (raw) => {
		const at = (opts.addedAt ?? new Date()).getTime();
		const ins = raw.prepare(`INSERT OR IGNORE INTO track_tag (track_id, tag_id, added_at) VALUES (?, ?, ?)`);
		const added: string[] = [];
		for (const id of trackIds) if (ins.run(id, tagId, at).changes > 0) added.push(id);
		if (added.length === 0) return added;
		if (opts.bump) bumpTracks(raw, added);
		const rec = recordingResolver(raw);
		const ops: EmitOp[] = [];
		for (const id of added) { const r = rec(id); if (r) ops.push(trackTagOp(r, tagId, true)); }
		emitOps(raw, ops);
		return added;
	});
}

export function untagTracks(db: Db, trackIds: readonly string[], tagId: string, opts: { bump?: boolean } = {}): string[] {
	if (trackIds.length === 0) return [];
	return tx(db, (raw) => {
		const del = raw.prepare(`DELETE FROM track_tag WHERE track_id = ? AND tag_id = ?`);
		const removed: string[] = [];
		for (const id of trackIds) if (del.run(id, tagId).changes > 0) removed.push(id);
		if (removed.length === 0) return removed;
		if (opts.bump) bumpTracks(raw, removed);
		const rec = recordingResolver(raw);
		const ops: EmitOp[] = [];
		for (const id of removed) { const r = rec(id); if (r) ops.push(trackTagOp(r, tagId, false)); }
		emitOps(raw, ops);
		return removed;
	});
}

// Tag-set diff for writers that rewrite a track's assignments wholesale (the
// rekordbox MyTag reconcile). Runs `write` and emits add/remove for what it
// changed on `trackIds`.
export function recordTrackTagChanges<T>(db: Db, trackIds: readonly string[], write: () => T): T {
	return tx(db, (raw) => {
		const before = new Map(trackIds.map((id) => [id, new Set(readTrackTags(raw, id).map((r) => r.tag_id))]));
		const result = write();
		const rec = recordingResolver(raw);
		const ops: EmitOp[] = [];
		for (const id of trackIds) {
			const r = rec(id);
			if (!r) continue;
			const was = before.get(id)!;
			const now = new Set(readTrackTags(raw, id).map((x) => x.tag_id));
			for (const t of now) if (!was.has(t)) ops.push(trackTagOp(r, t, true));
			for (const t of was) if (!now.has(t)) ops.push(trackTagOp(r, t, false));
		}
		emitOps(raw, ops);
		return result;
	});
}

function bumpTracks(raw: Raw, ids: readonly string[]): void {
	const now = Date.now();
	for (const c of chunks(ids)) raw.prepare(`UPDATE track SET updated_at = ? WHERE id IN (${c.map(() => '?').join(',')})`).run(now, ...c);
}

// ── library_track ───────────────────────────────────────────────────────────

export function setRating(db: Db, trackIds: readonly string[], rating: number | null): void {
	if (trackIds.length === 0) return;
	recordTrackStateChanges(db, trackIds, (raw) => {
		const now = Date.now();
		for (const c of chunks(trackIds)) {
			raw.prepare(`UPDATE track SET rating = ?, updated_at = ? WHERE id IN (${c.map(() => '?').join(',')})`).run(rating, now, ...c);
		}
	});
}

// Snapshot rating / state / overrides / deleted_at of `trackIds`, run
// `write`, emit one op per field it changed. The seam every patch-shaped
// writer uses (feedPromote's backlog flip included).
export function recordTrackStateChanges<T>(db: Db, trackIds: readonly string[], write: (raw: Raw) => T): T {
	return tx(db, (raw) => {
		const before = new Map<string, TrackStateRow>();
		for (const id of trackIds) { const s = readTrackState(raw, id); if (s) before.set(id, s); }
		const result = write(raw);
		const ops: EmitOp[] = [];
		for (const [id, was] of before) {
			const now = readTrackState(raw, id);
			if (!now) continue;
			const r = recordingOf(raw, id);
			if (r) ops.push(...trackStateDiffOps(r, was, now));
		}
		emitOps(raw, ops);
		return result;
	});
}

// Soft delete (library_track delete; LWW on deleted_at). Returns the ids that
// were live and are now tombstoned.
export function softDeleteTracks(db: Db, trackIds: readonly string[], at: Date = new Date()): string[] {
	if (trackIds.length === 0) return [];
	return tx(db, (raw) => {
		const ms = at.getTime();
		const stamp = raw.prepare(`UPDATE track SET deleted_at = ?, membership = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL`);
		const done: string[] = [];
		for (const id of trackIds) if (stamp.run(ms, ms, id).changes > 0) done.push(id);
		const rec = recordingResolver(raw);
		const ops: EmitOp[] = [];
		for (const id of done) { const r = rec(id); if (r) ops.push({ entity: 'library_track', entity_id: r, kind: 'delete', payload: {} }); }
		emitOps(raw, ops);
		return done;
	});
}

export function undeleteTracks(db: Db, trackIds: readonly string[]): string[] {
	if (trackIds.length === 0) return [];
	return tx(db, (raw) => {
		const now = Date.now();
		const clear = raw.prepare(`UPDATE track SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL`);
		const done: string[] = [];
		for (const id of trackIds) if (clear.run(now, id).changes > 0) done.push(id);
		const rec = recordingResolver(raw);
		const ops: EmitOp[] = [];
		for (const id of done) { const r = rec(id); if (r) ops.push({ entity: 'library_track', entity_id: r, kind: 'undelete', payload: {} }); }
		emitOps(raw, ops);
		return done;
	});
}

// The hard "burn the row" path (feed un-promotion): the cascade takes the
// row's assignments and cues, so their removal is stated before it — other
// devices keep their own row (a catalogue identity) and see it deleted.
export function emitHardDelete(db: Db, trackIds: readonly string[]): void {
	if (trackIds.length === 0) return;
	tx(db, (raw) => {
		const rec = recordingResolver(raw);
		const ops: EmitOp[] = [];
		for (const id of trackIds) {
			const r = rec(id);
			if (!r) continue;
			for (const t of readTrackTags(raw, id)) ops.push(trackTagOp(r, t.tag_id, false));
			for (const c of readCues(raw, id)) if (c.slot >= 0) ops.push(cueDeleteOp(r, c.slot, c.kind));
			ops.push({ entity: 'library_track', entity_id: r, kind: 'delete', payload: {} });
		}
		emitOps(raw, ops);
	});
}

// A new library row (scanner, streaming ingest): its existence plus the
// claims the catalogue resolver will read (design: `recording_claim`).
export type Claim = { kind: 'isrc' | 'audio_hash' | 'fingerprint' | 'spotify' | 'tidal' | 'beatport'; value: string; confidence?: number; durationSec?: number };

function claimOps(recordingId: string, claims: readonly Claim[]): EmitOp[] {
	return claims
		.filter((c) => c.value)
		.map((c) => ({
			entity: 'recording_claim' as const,
			entity_id: recordingId,
			kind: 'add' as const,
			payload: {
				kind: c.kind,
				value: c.value,
				confidence: c.confidence ?? 1,
				...(c.durationSec !== undefined ? { duration_sec: Math.max(0, Math.round(c.durationSec)) } : {}),
			},
		}));
}

export function recordTrackCreated(db: Db, trackId: string, claims: readonly Claim[], addedAt: Date = new Date()): void {
	tx(db, (raw) => {
		const r = recordingOf(raw, trackId);
		if (!r) return;
		emitOps(raw, [{ entity: 'library_track', entity_id: r, kind: 'create', payload: { added_at: addedAt.getTime() } }, ...claimOps(r, claims)]);
	});
}

export function addClaims(db: Db, trackId: string, claims: readonly Claim[]): void {
	if (claims.length === 0) return;
	tx(db, (raw) => {
		const r = recordingOf(raw, trackId);
		if (r) emitOps(raw, claimOps(r, claims));
	});
}

// ── playlist ────────────────────────────────────────────────────────────────

// Insert a playlist row (drizzle shape, so callers keep their column
// literals) and record its create from the row as stored.
export function createPlaylist(db: Db, row: NewPlaylist): string {
	tx(db, (raw) => {
		db.insert(playlistTable).values(row).run();
		emitOps(raw, playlistCreateOps(raw, row.id));
	});
	return row.id;
}

// Record a playlist row a writer inserted itself (the provider syncs build
// rows with sync stamps the create does not carry).
export function recordPlaylistCreated(db: Db, playlistId: string): void {
	tx(db, (raw) => { emitOps(raw, playlistCreateOps(raw, playlistId)); });
}

export function renamePlaylist(db: Db, playlistId: string, name: string): boolean {
	return tx(db, (raw) => {
		const changed = raw.prepare(`UPDATE playlist SET name = ?, name_ascii = ?, updated_at = ? WHERE id = ? AND name != ?`)
			.run(name, searchFold(name), Date.now(), playlistId, name).changes > 0;
		// A provider can hand back an empty name; the wire refuses one, and a
		// refused op would roll back the sync that carried it.
		if (changed && name.trim() && !isDeviceLocalPlaylist(raw, playlistId)) emitOps(raw, [{ entity: 'playlist', entity_id: playlistId, kind: 'rename', payload: { name } }]);
		return changed;
	});
}

export function movePlaylistToFolder(db: Db, playlistId: string, folderId: string | null): void {
	tx(db, (raw) => {
		const changed = raw.prepare(`UPDATE playlist SET parent_folder_id = ?, updated_at = ? WHERE id = ? AND parent_folder_id IS NOT ?`)
			.run(folderId, Date.now(), playlistId, folderId).changes > 0;
		if (changed && !isDeviceLocalPlaylist(raw, playlistId)) emitOps(raw, [{ entity: 'playlist', entity_id: playlistId, kind: 'move-to-folder', payload: { folder_id: folderId } }]);
	});
}

export function setPlaylistFavorite(db: Db, playlistId: string, favourite: boolean): void {
	tx(db, (raw) => {
		const changed = raw.prepare(`UPDATE playlist SET is_favorite = ?, updated_at = ? WHERE id = ? AND is_favorite != ?`)
			.run(favourite ? 1 : 0, Date.now(), playlistId, favourite ? 1 : 0).changes > 0;
		if (changed && !isDeviceLocalPlaylist(raw, playlistId)) emitOps(raw, [{ entity: 'playlist', entity_id: playlistId, kind: 'set-favourite', payload: { favourite } }]);
	});
}

// The playlist and its rows. Container delete wins over every membership op
// on it, so the rows need no ops of their own.
export function deletePlaylist(db: Db, playlistId: string): boolean {
	return tx(db, (raw) => {
		const local = isDeviceLocalPlaylist(raw, playlistId);
		raw.prepare(`DELETE FROM playlist_track WHERE playlist_id = ?`).run(playlistId);
		const gone = raw.prepare(`DELETE FROM playlist WHERE id = ?`).run(playlistId).changes > 0;
		if (gone && !local) emitOps(raw, [{ entity: 'playlist', entity_id: playlistId, kind: 'delete', payload: {} }]);
		return gone;
	});
}

// For writers that upsert a playlist row themselves (the provider and
// rekordbox imports carry columns the create does not): snapshot the synced
// fields, run `write`, emit create (a new row) or rename / move-to-folder /
// set-favourite for what it changed.
export function recordPlaylistWrite<T>(db: Db, playlistId: string, write: () => T): T {
	return tx(db, (raw) => {
		type Row = { name: string; parent_folder_id: string | null; is_favorite: number };
		const read = raw.prepare(`SELECT name, parent_folder_id, is_favorite FROM playlist WHERE id = ?`);
		const before = read.get(playlistId) as Row | undefined;
		const result = write();
		const after = read.get(playlistId) as Row | undefined;
		if (!after || isDeviceLocalPlaylist(raw, playlistId)) return result;
		if (!before) {
			emitOps(raw, playlistCreateOps(raw, playlistId));
			return result;
		}
		const ops: EmitOp[] = [];
		if (after.name !== before.name && after.name.trim()) ops.push({ entity: 'playlist', entity_id: playlistId, kind: 'rename', payload: { name: after.name } });
		if (after.parent_folder_id !== before.parent_folder_id) ops.push({ entity: 'playlist', entity_id: playlistId, kind: 'move-to-folder', payload: { folder_id: after.parent_folder_id } });
		if (!!after.is_favorite !== !!before.is_favorite) ops.push({ entity: 'playlist', entity_id: playlistId, kind: 'set-favourite', payload: { favourite: !!after.is_favorite } });
		emitOps(raw, ops);
		return result;
	});
}

// ── playlist_folder ─────────────────────────────────────────────────────────

export function recordFolderWrite<T>(db: Db, folderId: string, write: () => T): T {
	return tx(db, (raw) => {
		type Row = { name: string; parent_folder_id: string | null };
		const read = raw.prepare(`SELECT name, parent_folder_id FROM playlist_folder WHERE id = ?`);
		const before = read.get(folderId) as Row | undefined;
		const result = write();
		const after = read.get(folderId) as Row | undefined;
		if (!after) return result;
		if (!before) {
			const op = folderCreateOp(raw, folderId);
			if (op) emitOps(raw, [op]);
			return result;
		}
		const ops: EmitOp[] = [];
		if (after.name !== before.name && after.name.trim()) ops.push({ entity: 'playlist_folder', entity_id: folderId, kind: 'rename', payload: { name: after.name } });
		if (after.parent_folder_id !== before.parent_folder_id) ops.push({ entity: 'playlist_folder', entity_id: folderId, kind: 'move-to-folder', payload: { parent_folder_id: after.parent_folder_id } });
		emitOps(raw, ops);
		return result;
	});
}

export function recordFolderCreated(db: Db, folderId: string): void {
	tx(db, (raw) => {
		const op = folderCreateOp(raw, folderId);
		if (op) emitOps(raw, [op]);
	});
}

export function renamePlaylistFolder(db: Db, folderId: string, name: string): void {
	tx(db, (raw) => {
		const changed = raw.prepare(`UPDATE playlist_folder SET name = ?, name_ascii = ?, updated_at = ? WHERE id = ? AND name != ?`)
			.run(name, searchFold(name), Date.now(), folderId, name).changes > 0;
		if (changed && name.trim()) emitOps(raw, [{ entity: 'playlist_folder', entity_id: folderId, kind: 'rename', payload: { name } }]);
	});
}

export function movePlaylistFolder(db: Db, folderId: string, parentId: string | null): void {
	tx(db, (raw) => {
		const changed = raw.prepare(`UPDATE playlist_folder SET parent_folder_id = ?, updated_at = ? WHERE id = ? AND parent_folder_id IS NOT ?`)
			.run(parentId, Date.now(), folderId, parentId).changes > 0;
		if (changed) emitOps(raw, [{ entity: 'playlist_folder', entity_id: folderId, kind: 'move-to-folder', payload: { parent_folder_id: parentId } }]);
	});
}

// Children are re-parented to the root first (the importer's rule), so the
// ops for them are moves, then the folder's delete.
export function deletePlaylistFolder(db: Db, folderId: string): boolean {
	return tx(db, (raw) => {
		const playlists = raw.prepare(`SELECT id FROM playlist WHERE parent_folder_id = ?`).pluck().all(folderId) as string[];
		const folders = raw.prepare(`SELECT id FROM playlist_folder WHERE parent_folder_id = ?`).pluck().all(folderId) as string[];
		raw.prepare(`UPDATE playlist SET parent_folder_id = NULL WHERE parent_folder_id = ?`).run(folderId);
		raw.prepare(`UPDATE playlist_folder SET parent_folder_id = NULL WHERE parent_folder_id = ?`).run(folderId);
		const gone = raw.prepare(`DELETE FROM playlist_folder WHERE id = ?`).run(folderId).changes > 0;
		const ops: EmitOp[] = [];
		for (const p of playlists) if (!isDeviceLocalPlaylist(raw, p)) ops.push({ entity: 'playlist', entity_id: p, kind: 'move-to-folder', payload: { folder_id: null } });
		for (const f of folders) ops.push({ entity: 'playlist_folder', entity_id: f, kind: 'move-to-folder', payload: { parent_folder_id: null } });
		if (gone) ops.push({ entity: 'playlist_folder', entity_id: folderId, kind: 'delete', payload: {} });
		emitOps(raw, ops);
		return gone;
	});
}

// ── playlist_track ──────────────────────────────────────────────────────────

type MemberRow = { id: string; playlistId: string; trackId: string; orderKey: string };

function memberAdds(raw: Raw, rows: readonly MemberRow[]): EmitOp[] {
	const rec = recordingResolver(raw, [...new Set(rows.map((r) => r.trackId))]);
	const ops: EmitOp[] = [];
	for (const r of rows) {
		const recording = rec(r.trackId);
		if (recording) ops.push({ entity: 'playlist_track', entity_id: r.id, kind: 'add', payload: { playlist_id: r.playlistId, recording_id: recording, order_key: r.orderKey } });
	}
	return ops;
}

function insertMembers(raw: Raw, rows: readonly NewPlaylistTrack[]): void {
	const ins = raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, added_by, source_track_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
	for (const r of rows) ins.run(r.id, r.playlistId, r.trackId, r.orderKey, r.position, r.addedAt ? r.addedAt.getTime() : null, r.addedBy ?? null, r.sourceTrackId);
}

// Append rows after the playlist's current last row (one `add` each).
export function addMembers(db: Db, playlistId: string, drafts: readonly MemberDraft[]): NewPlaylistTrack[] {
	if (drafts.length === 0) return [];
	return tx(db, (raw) => {
		const rows = appendRows(raw, playlistId, drafts.map((d) => ({ ...d, playlistId })));
		insertMembers(raw, rows);
		recomputePositions(raw, playlistId);
		if (!isDeviceLocalPlaylist(raw, playlistId)) emitOps(raw, memberAdds(raw, rows as MemberRow[]));
		return rows;
	});
}

// Remove every row of `trackIds` from the playlist (one `remove` per row).
export function removeMembersByTrack(db: Db, playlistId: string, trackIds: readonly string[]): number {
	if (trackIds.length === 0) return 0;
	return tx(db, (raw) => {
		const ids: string[] = [];
		for (const c of chunks(trackIds)) {
			ids.push(...(raw.prepare(`SELECT id FROM playlist_track WHERE playlist_id = ? AND track_id IN (${c.map(() => '?').join(',')})`).pluck().all(playlistId, ...c) as string[]));
		}
		return removeRowsIn(raw, playlistId, ids);
	});
}

export function removeMemberRows(db: Db, playlistId: string, rowIds: readonly string[]): number {
	if (rowIds.length === 0) return 0;
	return tx(db, (raw) => removeRowsIn(raw, playlistId, rowIds));
}

function removeRowsIn(raw: Raw, playlistId: string, rowIds: readonly string[]): number {
	const del = raw.prepare(`DELETE FROM playlist_track WHERE id = ? AND playlist_id = ?`);
	const gone: string[] = [];
	for (const id of rowIds) if (del.run(id, playlistId).changes > 0) gone.push(id);
	if (gone.length === 0) return 0;
	recomputePositions(raw, playlistId);
	if (!isDeviceLocalPlaylist(raw, playlistId)) {
		emitOps(raw, gone.map((id) => ({ entity: 'playlist_track' as const, entity_id: id, kind: 'remove' as const, payload: {} })));
	}
	return gone.length;
}

// Put the playlist's rows in `orderedIds` order: only displaced rows get new
// keys (planReorderKeys), one `move` each — a drag is one op, a reverse sort
// N. Returns the number of rows moved.
export function reorderMembers(db: Db, playlistId: string, orderedIds: readonly string[]): number {
	return tx(db, (raw) => {
		const current = raw.prepare('SELECT id, order_key AS orderKey FROM playlist_track WHERE playlist_id = ? ORDER BY order_key, id').all(playlistId) as Array<{ id: string; orderKey: string }>;
		if (current.length !== orderedIds.length) throw new Error(`reorderMembers: ${orderedIds.length} ids for ${current.length} rows`);
		const indexOf = new Map(current.map((r, i) => [r.id, i]));
		const perm = orderedIds.map((id) => {
			const i = indexOf.get(id);
			if (i === undefined) throw new Error(`reorderMembers: unknown row ${id}`);
			return i;
		});
		if (new Set(perm).size !== perm.length) throw new Error('reorderMembers: duplicate row id');
		const rekey = planReorderKeys(current, perm);
		const setKey = raw.prepare('UPDATE playlist_track SET order_key = ? WHERE id = ?');
		for (const [id, key] of rekey) setKey.run(key, id);
		recomputePositions(raw, playlistId);
		if (rekey.size > 0 && !isDeviceLocalPlaylist(raw, playlistId)) {
			emitOps(raw, [...rekey].map(([id, key]) => ({ entity: 'playlist_track' as const, entity_id: id, kind: 'move' as const, payload: { order_key: key } })));
		}
		return rekey.size;
	});
}

export type DesiredMember = { trackId: string; sourceTrackId: string; addedAt: Date | null; addedBy?: string | null };
export type ReconcileResult = { added: number; removed: number; moved: number };

// Make the playlist's rows equal `desired`, in order, by diff (design:
// "External pulls"): rows are matched to desired entries by track, k-th
// occurrence to k-th, so duplicates keep their identity; unmatched rows are
// removed, unmatched entries added between their final neighbours, and only
// the kept rows the provider displaced are rekeyed. A re-sync with nothing
// changed upstream writes nothing and emits nothing — where the old
// delete-all-plus-reinsert rewrote every row and would have emitted 2N ops.
//
// Per-row columns the provider owns (added_at, added_by, source_track_id)
// follow `desired` on kept rows too; they are local columns, not op fields.
// `origin` 'remote' writes without emitting.
export function reconcileMembership(db: Db, playlistId: string, desired: readonly DesiredMember[], origin: MutationOrigin): ReconcileResult {
	return tx(db, (raw) => {
		type Cur = { id: string; track_id: string; order_key: string; position: number; source_track_id: string; added_at: number | null; added_by: string | null };
		const current = raw.prepare(`SELECT id, track_id, order_key, position, source_track_id, added_at, added_by FROM playlist_track WHERE playlist_id = ? ORDER BY order_key, id`).all(playlistId) as Cur[];
		const queue = new Map<string, Cur[]>();
		for (const r of current) {
			const q = queue.get(r.track_id);
			if (q) q.push(r); else queue.set(r.track_id, [r]);
		}
		const matched: Array<Cur | null> = desired.map((d) => queue.get(d.trackId)?.shift() ?? null);
		const keptIds = new Set(matched.filter((m): m is Cur => m !== null).map((m) => m.id));
		const removed = current.filter((r) => !keptIds.has(r.id));
		const kept = current.filter((r) => keptIds.has(r.id));

		// Kept rows: the minimal rekey that puts them in desired order.
		const keptIndex = new Map(kept.map((r, i) => [r.id, i]));
		const perm = matched.filter((m): m is Cur => m !== null).map((m) => keptIndex.get(m.id)!);
		const rekey = planReorderKeys(kept.map((r) => ({ id: r.id, orderKey: r.order_key })), perm);
		const finalKey = (r: Cur): string => rekey.get(r.id) ?? r.order_key;

		// New entries: keys between their final neighbours, run by run.
		const keys: string[] = new Array(desired.length);
		let fallback = false;
		for (let k = 0; k < desired.length && !fallback;) {
			const m = matched[k];
			if (m) { keys[k] = finalKey(m); k++; continue; }
			let j = k;
			while (j < desired.length && !matched[j]) j++;
			const lo = k > 0 ? keys[k - 1]! : null;
			const hi = j < desired.length ? finalKey(matched[j]!) : null;
			try {
				const fresh = keysBetween(lo, hi, j - k);
				for (let x = 0; x < fresh.length; x++) keys[k + x] = fresh[x]!;
			} catch {
				fallback = true; // no room between equal neighbour keys
			}
			k = j;
		}
		if (!fallback) {
			for (let k = 1; k < keys.length; k++) if (!(keys[k - 1]! < keys[k]!)) { fallback = true; break; }
		}
		if (fallback) {
			// Rekey the whole playlist evenly: every kept row whose key moves
			// is a `move`, which is still correct, only larger.
			const even = rebalance(desired.length);
			for (let k = 0; k < desired.length; k++) keys[k] = even[k]!;
		}

		const del = raw.prepare(`DELETE FROM playlist_track WHERE id = ?`);
		for (const r of removed) del.run(r.id);
		const setKey = raw.prepare(`UPDATE playlist_track SET order_key = ? WHERE id = ?`);
		const setMeta = raw.prepare(`UPDATE playlist_track SET source_track_id = ?, added_at = ?, added_by = ? WHERE id = ?`);
		const ins = raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, added_by, source_track_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
		const moves: Array<{ id: string; key: string }> = [];
		const adds: MemberRow[] = [];
		// A new row goes straight to its final position (its index in
		// `desired`) when no kept row holds it, which is every row of a fresh
		// import and every appended row of a growing playlist; otherwise it
		// parks on a distinct negative position under the unique (playlist_id,
		// position) index until recomputePositions restamps. Restamping a
		// whole fresh import (park, then target) used to cost more than the
		// inserts themselves.
		const held = new Set(kept.map((r) => r.position));
		let parked = -1_000_000;
		for (let k = 0; k < desired.length; k++) {
			const d = desired[k]!;
			const m = matched[k];
			const addedAt = d.addedAt ? d.addedAt.getTime() : null;
			if (m) {
				if (m.order_key !== keys[k]) { setKey.run(keys[k]!, m.id); moves.push({ id: m.id, key: keys[k]! }); }
				if (m.source_track_id !== d.sourceTrackId || m.added_at !== addedAt || m.added_by !== (d.addedBy ?? null)) {
					setMeta.run(d.sourceTrackId, addedAt, d.addedBy ?? null, m.id);
				}
			} else {
				const id = randomUUID();
				ins.run(id, playlistId, d.trackId, keys[k]!, held.has(k) ? parked-- : k, addedAt, d.addedBy ?? null, d.sourceTrackId);
				adds.push({ id, playlistId, trackId: d.trackId, orderKey: keys[k]! });
			}
		}
		if (removed.length > 0 || moves.length > 0 || adds.length > 0) recomputePositions(raw, playlistId);

		if (origin !== 'remote' && !isDeviceLocalPlaylist(raw, playlistId)) {
			const ops: EmitOp[] = [
				...removed.map((r) => ({ entity: 'playlist_track' as const, entity_id: r.id, kind: 'remove' as const, payload: {} })),
				...moves.map((m) => ({ entity: 'playlist_track' as const, entity_id: m.id, kind: 'move' as const, payload: { order_key: m.key } })),
				...memberAdds(raw, adds),
			];
			emitOps(raw, ops);
		}
		return { added: adds.length, removed: removed.length, moved: moves.length };
	});
}

// ── cue ─────────────────────────────────────────────────────────────────────

// Snapshot the cues of `trackIds`, run `write`, emit the whole-cue diff (one
// upsert per changed slot, one delete per vanished one). Every cue writer
// goes through here: the pad grid, the rekordbox cue merge, conflict
// resolution.
export function recordCueChanges<T>(db: Db, trackIds: readonly string[], write: (raw: Raw) => T): T {
	return tx(db, (raw) => {
		const before = new Map<string, CueRow[]>(trackIds.map((id) => [id, readCues(raw, id)]));
		const result = write(raw);
		const ops: EmitOp[] = [];
		for (const [id, was] of before) {
			const r = recordingOf(raw, id);
			if (r) ops.push(...cueDiffOps(r, was, readCues(raw, id)));
		}
		emitOps(raw, ops);
		return result;
	});
}

// ── play history ────────────────────────────────────────────────────────────
// Append-only. A curator play is emitted once, when the tracker finalises it
// (the progress upserts before that are local bookkeeping); its session is
// re-appended with it so the session's end time travels too.

type SessionRow = { origin: string; kind: string; kind_source: string; name: string | null; started_at: number; ended_at: number | null; rb_history_id: string | null };
type EventRow = {
	session_id: string; track_id: string | null; source: string; played_at: number | null; played_ms: number | null; duration_ms: number | null;
	max_position_ms: number | null; played75: number | null; ended_reason: string | null; context_type: string | null; context_id: string | null;
	track_no: number | null; rb_song_history_id: string | null;
};

// Prepared once per handle: the history import and the initial push read
// tens of thousands of these, and compiling the statement per row cost more
// than running it.
const PLAY_STMTS = new WeakMap<Raw, { session: Database.Statement; event: Database.Statement }>();
function playStmts(raw: Raw): { session: Database.Statement; event: Database.Statement } {
	let st = PLAY_STMTS.get(raw);
	if (!st) {
		st = {
			session: raw.prepare(`SELECT origin, kind, kind_source, name, started_at, ended_at, rb_history_id FROM play_session WHERE id = ?`),
			event: raw.prepare(`SELECT session_id, track_id, source, played_at, played_ms, duration_ms, max_position_ms, played75, ended_reason,
				context_type, context_id, track_no, rb_song_history_id FROM play_event WHERE id = ?`),
		};
		PLAY_STMTS.set(raw, st);
	}
	return st;
}

export function sessionAppendOp(raw: Raw, sessionId: string): EmitOp | null {
	const s = playStmts(raw).session.get(sessionId) as SessionRow | undefined;
	if (!s) return null;
	return {
		entity: 'play_session',
		entity_id: sessionId,
		kind: 'append',
		payload: {
			origin: s.origin === 'rekordbox' ? 'rekordbox' : 'curator',
			kind: s.kind === 'set' || s.kind === 'prep' ? s.kind : 'unknown',
			kind_source: s.kind_source === 'user' ? 'user' : 'auto',
			name: s.name,
			started_at: Math.max(0, s.started_at),
			ended_at: s.ended_at == null ? null : Math.max(0, s.ended_at),
			rb_history_id: s.rb_history_id,
		},
	};
}

const ENDED = new Set(['ended', 'replaced', 'stopped', 'queue_end', 'interrupted']);
const nonNegInt = (v: number | null): number | null => (v == null || !Number.isFinite(v) ? null : Math.max(0, Math.round(v)));

export function eventAppendOp(raw: Raw, eventId: string, recording: (trackId: string) => string | null = (t) => recordingOf(raw, t)): EmitOp | null {
	const e = playStmts(raw).event.get(eventId) as EventRow | undefined;
	if (!e) return null;
	return {
		entity: 'play_event',
		entity_id: eventId,
		kind: 'append',
		payload: {
			session_id: e.session_id,
			recording_id: e.track_id ? recording(e.track_id) : null,
			source: e.source === 'spotify' || e.source === 'rekordbox' ? e.source : 'local',
			played_at: nonNegInt(e.played_at),
			played_ms: nonNegInt(e.played_ms),
			duration_ms: nonNegInt(e.duration_ms),
			max_position_ms: nonNegInt(e.max_position_ms),
			played75: e.played75 == null ? null : !!e.played75,
			ended_reason: e.ended_reason && ENDED.has(e.ended_reason) ? (e.ended_reason as 'ended') : null,
			context_type: e.context_type,
			context_id: e.context_id,
			track_no: e.track_no == null ? null : Math.round(e.track_no),
			rb_song_history_id: e.rb_song_history_id,
		},
	};
}

export function recordPlayAppended(db: Db, eventIds: readonly string[], sessionIds: readonly string[]): void {
	if (eventIds.length === 0 && sessionIds.length === 0) return;
	tx(db, (raw) => {
		const rec = recordingResolver(raw);
		const ops: EmitOp[] = [];
		for (const s of new Set(sessionIds)) { const op = sessionAppendOp(raw, s); if (op) ops.push(op); }
		for (const e of eventIds) { const op = eventAppendOp(raw, e, rec); if (op) ops.push(op); }
		emitOps(raw, ops);
	});
}

export function setSessionKind(db: Db, sessionId: string, kind: 'set' | 'prep'): boolean {
	return tx(db, (raw) => {
		const changed = raw.prepare(`UPDATE play_session SET kind = ?, kind_source = 'user', updated_at = ? WHERE id = ?`).run(kind, Date.now(), sessionId).changes > 0;
		if (changed) emitOps(raw, [{ entity: 'play_session', entity_id: sessionId, kind: 'set-kind', payload: { kind } }]);
		return changed;
	});
}

// ── pinned_search ───────────────────────────────────────────────────────────

export function createPinnedSearch(db: Db, row: { id: string; name: string; query: string; sortColumn: string | null; sortDir: 'asc' | 'desc' | null; position: number }): void {
	tx(db, (raw) => {
		db.insert(pinnedSearchTable).values(row).run();
		const op = pinnedCreateOp(raw, row.id);
		if (op) emitOps(raw, [op]);
	});
}

export function renamePinnedSearch(db: Db, id: string, name: string): void {
	tx(db, (raw) => {
		if (raw.prepare(`UPDATE pinned_search SET name = ? WHERE id = ? AND name != ?`).run(name, id, name).changes > 0 && name.trim()) {
			emitOps(raw, [{ entity: 'pinned_search', entity_id: id, kind: 'rename', payload: { name } }]);
		}
	});
}

export function setPinnedSearchQuery(db: Db, id: string, query: string, sort: { column: string | null; dir: 'asc' | 'desc' | null }): void {
	tx(db, (raw) => {
		if (raw.prepare(`UPDATE pinned_search SET query = ?, sort_column = ?, sort_dir = ? WHERE id = ?`).run(query, sort.column, sort.dir, id).changes > 0) {
			emitOps(raw, [{ entity: 'pinned_search', entity_id: id, kind: 'set-query', payload: { query, sort_column: sort.column, sort_dir: sort.dir } }]);
		}
	});
}

export function deletePinnedSearch(db: Db, id: string): void {
	tx(db, (raw) => {
		if (raw.prepare(`DELETE FROM pinned_search WHERE id = ?`).run(id).changes > 0) {
			emitOps(raw, [{ entity: 'pinned_search', entity_id: id, kind: 'delete', payload: {} }]);
		}
	});
}

// ── artist_alias ────────────────────────────────────────────────────────────

// The rules of a local artist rename or merge: "credits spelled `from` (by
// artist key) are written `to`". Call inside the transaction that did the
// local rewrite; the rewrite itself is the caller's (service.ts
// rewriteArtistCredits), and other devices replay it from these rules
// (library/artist-alias.ts). Rules with an empty key on either side are
// skipped: a name of only punctuation has no identity to alias.
export function emitArtistAliases(db: Db, rules: ReadonlyArray<{ from: string; to: string }>): void {
	const ops: EmitOp[] = [];
	const seen = new Set<string>();
	for (const r of rules) {
		const key = artistKey(r.from);
		const toKey = artistKey(r.to);
		const to = r.to.trim();
		if (!key || !toKey || !to || seen.has(key)) continue;
		seen.add(key);
		ops.push({ entity: 'artist_alias', entity_id: key, kind: 'set', payload: { from: r.from.trim() || to, to, to_key: toKey } });
	}
	if (ops.length > 0) tx(db, (raw) => { emitOps(raw, ops); });
}

// ── setting ─────────────────────────────────────────────────────────────────

// Write an app_setting; emit only for account-level keys (the protocol's
// allow-list). Device keys — sourceSync.* write toggles (the 2026-09
// incident), wav.output_dir, library folders, device.id, backup run stamps —
// go through here too and simply never ride an op.
export function setSetting(db: Db, key: string, value: unknown): void {
	// JSON round trip: what is stored is what the op carries (no undefined).
	const json = value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);
	tx(db, (raw) => {
		const now = new Date();
		db.insert(appSetting).values({ key, value: json, updatedAt: now }).onConflictDoUpdate({ target: appSetting.key, set: { value: json, updatedAt: now } }).run();
		if (isAccountSettingKey(key)) emitOps(raw, [{ entity: 'setting', entity_id: key, kind: 'set', payload: { value: json as JsonValue } }]);
	});
}

// ── recording merge ─────────────────────────────────────────────────────────

// The merge op plus the RE-ASSERT (cloud plan B1 note): the reducer's fold
// takes the later write per field and per cue slot, so the desktop's "kept
// side wins" only survives every arrival order if this device states the
// kept side's final values at the merge's own clock — beating every loser
// write made before the merge, losing to any made after. Stated for the
// winner: rating, every override field (cleared ones as null), deleted
// state, every cue, a delete for each slot only the loser had, and a remove
// for each loser membership row the local merge dropped (the reducer keeps
// both rows of a playlist that held both tracks; the desktop keeps one).
//
// Call inside the transaction that did the local merge, AFTER it.
export type RecordingMergeInput = {
	loserRecordingId: string;
	winnerTrackId: string;
	droppedMemberRows: ReadonlyArray<{ id: string; playlistId: string }>;
	loserCueSlots: ReadonlyArray<{ slot: number; kind: 'hot' | 'memory' }>;
};

export function mergeRecordingRaw(raw: Raw, m: RecordingMergeInput): void {
	const winner = recordingOf(raw, m.winnerTrackId);
	if (!winner || winner === m.loserRecordingId) return;
	const ops: EmitOp[] = [{ entity: 'recording', entity_id: m.loserRecordingId, kind: 'merge', payload: { winner } }];
	const state = readTrackState(raw, m.winnerTrackId);
	if (state) ops.push(...trackStateOps(winner, state, { allOverrides: true, deleted: true }));
	const cues = readCues(raw, m.winnerTrackId).filter((c) => c.slot >= 0);
	const have = new Set(cues.map((c) => `${c.kind}:${c.slot}`));
	for (const c of cues) ops.push(cueUpsertOp(winner, c));
	for (const c of m.loserCueSlots) if (c.slot >= 0 && !have.has(`${c.kind}:${c.slot}`)) ops.push(cueDeleteOp(winner, c.slot, c.kind));
	for (const r of m.droppedMemberRows) {
		if (!isDeviceLocalPlaylist(raw, r.playlistId)) ops.push({ entity: 'playlist_track', entity_id: r.id, kind: 'remove', payload: {} });
	}
	emitOps(raw, ops, { sameClock: true });
}

export function mergeRecording(db: Db, m: RecordingMergeInput): void {
	tx(db, (raw) => mergeRecordingRaw(raw, m));
}

// Single-cue helpers for the pad grid (service upsertCue/updateCue/deleteCue).
export function cueOpsFor(raw: Raw, trackId: string, slot: number, kind: 'hot' | 'memory'): NewOp[] {
	const r = recordingOf(raw, trackId);
	if (!r || slot < 0) return [];
	const c = readCues(raw, trackId).find((x) => x.slot === slot && x.kind === kind);
	return [c ? cueUpsertOp(r, c) : cueDeleteOp(r, slot, kind)];
}
