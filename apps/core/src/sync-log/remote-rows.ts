// Remote rows: the account's tracks this device holds no source for (cloud
// plan: streaming identity §3, "materialise"; decided 2026-10-20: every
// device shows the account's union library, own-source-less tracks marked
// "not on this device"). Before this a recording with no local row was kept
// in the records but shown nowhere (project.ts), which left a fresh second
// desktop with an empty library and every other device blind to what the
// first one held.
//
// A remote row is a track row with `remote_only = 1` and id
// `remoteTrackId(R)`, made from the recording's winning base metadata
// (`library_track.set-meta`, master device first: protocol state.ts
// resolveTrackMeta) — credits mapped through the converged artist alias
// rules from the source credits the meta carries, which become its
// artists_base cell, so a later rule re-derives them like any row's. Its
// rating, state, overrides, delete, tags, cues, playlist rows and plays are
// the records', projected like any row's (project.ts).
//
// It is a pure projection. Nothing device-local hangs off it (no file, no
// link, no analysis, no rekordbox entry), so every operation on it is "drop
// and re-derive": a merge drops the loser's, and a row of this device's own
// absorbs one (the remote row goes, the recording's records re-project onto
// the own row). It NEVER touches an own row: a device's own copy keeps its
// own ingested metadata (the master wins on the rows it supplies, not on a
// device's files). A source arriving on a remote row turns it into an own
// row in place (the source_link / rekordbox_link triggers in migrate.ts).
//
// When: projection step 1c (project.ts) for every recording a batch
// touched; the one-time sweep (MATERIALIZE_KEY), which also re-picks every
// remote row after a master change. A deleted recording gets its row too,
// deleted (projection step 5 writes deleted_at like on any row): the
// device that deleted it still shows it, with the "deleted" chip, in the
// followed playlists that hold it (service.ts getTracksImpl), and so must
// every other device (the 2026-10-20 dry run: 70 followed playlists short
// of their deleted rows on the second desktop without it).

import type Database from 'better-sqlite3';
import { resolveTrackMeta, type ArtistAliasTarget, type EntityRef, type LwwRecord, type TrackMeta } from '@curator/protocol';
import { asciifyArtists, searchFold } from '@curator/shared';
import type { TrackArtist, TrackOverrides } from '@curator/shared/schema';
import { syncTrackAlbumsRaw } from '../library/albums.js';
import { loadArtistAliasMap, mapCredits } from '../library/artist-alias.js';
import { artistsBaseCell, syncTrackArtistsByIdRaw } from '../library/artists.js';
import { upsertArtistLinksRaw, type ProviderArtistRef } from '../library/artist-links.js';
import { recomputePositions } from '../library/playlist-order.js';
import { refsOfRecordings } from './claim-bind.js';
import { remoteTrackId } from './stable-ids.js';
import { masterDevice } from './track-meta.js';

type Raw = Database.Database;

// The one-time sweep over every record (and the re-pick after a master
// change, which clears it).
export const MATERIALIZE_KEY = 'sync.materialize_remote_at';

const CHUNK = 400;

export type MaterializeResult = {
	// Remote rows made, updated (meta changed) and dropped (absorbed).
	created: string[];
	updated: string[];
	dropped: string[];
	// Recordings whose records must be projected onto their (new) row.
	adopt: string[];
	playlistsTouched: string[];
	// Creations past the batch's budget, queued for the drain.
	queued: number;
};

type RemoteRowRead = {
	id: string;
	remote_only: number;
	title: string;
	artists: string;
	artists_base: string | null;
	album_title: string | null;
	duration: number | null;
	isrc: string | null;
	release_date: string | null;
	label: string | null;
	genre: string | null;
	cover_url: string | null;
	track_number: number | null;
	disc_number: number | null;
	remote_source: string | null;
	overrides: string | null;
};

// The columns a remote row takes from meta.
function columnsOf(meta: TrackMeta, alias: ReadonlyMap<string, ArtistAliasTarget>): Omit<RemoteRowRead, 'id' | 'remote_only' | 'overrides'> {
	const artists = mapCredits(meta.artists, (k) => alias.get(k)?.name).list;
	const base = artistsBaseCell(meta.artists, artists);
	return {
		title: meta.title,
		artists: JSON.stringify(artists),
		artists_base: base ? JSON.stringify(base) : null,
		album_title: meta.album_title,
		duration: meta.duration_sec,
		isrc: meta.isrc,
		release_date: meta.release_date,
		label: meta.label,
		genre: meta.genre,
		cover_url: meta.cover_url,
		track_number: meta.track_number ?? null,
		disc_number: meta.disc_number ?? null,
		remote_source: meta.source,
	};
}

const COLUMN_NAMES = ['title', 'artists', 'artists_base', 'album_title', 'duration', 'isrc', 'release_date', 'label', 'genre', 'cover_url', 'track_number', 'disc_number', 'remote_source'] as const;

// Takes a remote row off this device's tables: its visible children (the
// records keep them; a re-projection puts them back on whichever row now
// speaks for the recording) and the row. Returns the playlists it was in.
export function dropRemoteRow(raw: Raw, trackId: string): string[] {
	const playlists = raw.prepare(`SELECT DISTINCT playlist_id FROM playlist_track WHERE track_id = ?`).pluck().all(trackId) as string[];
	raw.prepare(`DELETE FROM playlist_track WHERE track_id = ?`).run(trackId);
	raw.prepare(`UPDATE play_event SET track_id = NULL WHERE track_id = ?`).run(trackId);
	raw.prepare(`DELETE FROM track_derive_pending WHERE track_id = ?`).run(trackId);
	// The rest (tags, cues, the artist junction, the rb slot) cascades.
	raw.prepare(`DELETE FROM track WHERE id = ? AND remote_only = 1`).run(trackId);
	return playlists;
}

// The records of these recordings, read in batches.
function readRecords(raw: Raw, recordings: readonly string[]): Map<string, LwwRecord> {
	const out = new Map<string, LwwRecord>();
	for (let i = 0; i < recordings.length; i += CHUNK) {
		const chunk = recordings.slice(i, i + CHUNK);
		for (const r of raw.prepare(`SELECT key, value FROM sync_state WHERE map = 'libraryTracks' AND key IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ key: string; value: string }>) {
			out.set(r.key, JSON.parse(r.value) as LwwRecord);
		}
	}
	return out;
}

// Make, refresh or absorb the remote rows of these recordings, against the
// records as flushed. Runs inside the caller's transaction; the caller
// projects `adopt` (project.ts step 1c does it in the same pass).
//
// `createBudget`: how many rows this call may make; the rest are queued
// (track_remote_pending) for the sync client's sliced drain. A row costs
// ~2-3 ms with its projection on the real library (the track table carries
// ~30 indexes; measured 2026-10-20), so a pull page or snapshot chunk that
// brings a fresh device the whole account must not make them inline. A
// handful (another device's new track) still shows in the same commit.
export const INLINE_CREATE_ROWS = 25;

export function materializeRemoteRows(
	raw: Raw,
	recordingIds: Iterable<string>,
	ctx: { master?: string | null; alias?: ReadonlyMap<string, ArtistAliasTarget>; createBudget?: number } = {},
): MaterializeResult {
	const out: MaterializeResult = { created: [], updated: [], dropped: [], adopt: [], playlistsTouched: [], queued: 0 };
	const all = [...new Set(recordingIds)];
	const losers = new Set<string>();
	for (let i = 0; i < all.length; i += CHUNK) {
		const chunk = all.slice(i, i + CHUNK);
		for (const l of raw.prepare(`SELECT loser FROM recording_alias WHERE loser IN (${chunk.map(() => '?').join(',')})`).pluck().all(...chunk) as string[]) losers.add(l);
	}
	const ids = all.filter((r) => !losers.has(r));
	if (ids.length === 0) return out;
	let budget = ctx.createBudget ?? Infinity;
	const queue = raw.prepare(`INSERT OR IGNORE INTO track_remote_pending (recording_id) VALUES (?)`);
	const unqueue = raw.prepare(`DELETE FROM track_remote_pending WHERE recording_id = ?`);
	const records = readRecords(raw, ids);
	const master = ctx.master !== undefined ? ctx.master : masterDevice(raw);
	let alias = ctx.alias ?? null;
	const rowsOf = new Map<string, RemoteRowRead[]>();
	// `+derived_from_track_id`: with an IN list SQLite otherwise walks the
	// derived-copy index — every catalogue row, ~20 ms per read on a 40k
	// library — instead of the recording index.
	for (let i = 0; i < ids.length; i += CHUNK) {
		const chunk = ids.slice(i, i + CHUNK);
		for (const r of raw.prepare(`SELECT recording_id AS rec, id, remote_only, title, artists, artists_base, album_title, duration, isrc, release_date, label, genre,
				cover_url, track_number, disc_number, remote_source, overrides
			FROM track WHERE recording_id IN (${chunk.map(() => '?').join(',')}) AND +derived_from_track_id IS NULL`).all(...chunk) as Array<RemoteRowRead & { rec: string }>) {
			let list = rowsOf.get(r.rec);
			if (!list) rowsOf.set(r.rec, (list = []));
			list.push(r);
		}
	}
	const insert = raw.prepare(`INSERT INTO track (id, recording_id, remote_only, remote_source, title, artists, artists_base, album_title, duration, isrc,
			release_date, label, genre, cover_url, track_number, disc_number, title_ascii, album_title_ascii, label_ascii, genre_ascii, artists_ascii,
			added_at, created_at, updated_at)
		VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	const update = raw.prepare(`UPDATE track SET remote_source = ?, title = ?, artists = ?, artists_base = ?, album_title = ?, duration = ?, isrc = ?,
			release_date = ?, label = ?, genre = ?, cover_url = ?, track_number = ?, disc_number = ?, title_ascii = ?, album_title_ascii = ?,
			label_ascii = ?, genre_ascii = ?, artists_ascii = ?, updated_at = ?
		WHERE id = ? AND remote_only = 1`);
	const pending = raw.prepare(`INSERT OR IGNORE INTO track_derive_pending (track_id) VALUES (?)`);
	const playlists = new Set<string>();
	const now = Date.now();
	for (const rec of ids) {
		const rows = rowsOf.get(rec) ?? [];
		const own = rows.filter((r) => r.remote_only === 0);
		const remote = rows.filter((r) => r.remote_only !== 0);
		if (own.length > 0) {
			// This device holds the track itself: its own row speaks.
			unqueue.run(rec);
			if (remote.length > 0) {
				for (const r of remote) { for (const p of dropRemoteRow(raw, r.id)) playlists.add(p); out.dropped.push(r.id); }
				out.adopt.push(rec);
			}
			continue;
		}
		const record = records.get(rec);
		const won = resolveTrackMeta(record, master);
		if (!won) continue;
		alias ??= loadArtistAliasMap(raw);
		const cols = columnsOf(won.meta, alias);
		if (remote.length === 0) {
			// A device's set-meta is itself the evidence that the recording
			// exists (it states only rows it holds), so no create is needed:
			// a row from before the op log may never have had one pushed.
			if (budget <= 0) { queue.run(rec); out.queued++; continue; }
			budget--;
			unqueue.run(rec);
			const id = remoteTrackId(rec);
			const added = record!.fields['added_at']?.value;
			const addedAt = typeof added === 'number' ? added : (record!.created ?? won.clock).ts;
			insert.run(
				id, rec, cols.remote_source, cols.title, cols.artists, cols.artists_base, cols.album_title, cols.duration, cols.isrc,
				cols.release_date, cols.label, cols.genre, cols.cover_url, cols.track_number, cols.disc_number,
				searchFold(cols.title), searchFold(cols.album_title), searchFold(cols.label), searchFold(cols.genre),
				asciifyArtists(JSON.parse(cols.artists) as TrackArtist[]), addedAt, now, now,
			);
			pending.run(id);
			out.created.push(id);
			out.adopt.push(rec);
			continue;
		}
		// Every extra remote row of one recording (a merge re-pointed one
		// before its own was dropped) goes; the first speaks.
		const [keep, ...extra] = remote;
		for (const r of extra) { for (const p of dropRemoteRow(raw, r.id)) playlists.add(p); out.dropped.push(r.id); }
		if (extra.length > 0) out.adopt.push(rec);
		const same = COLUMN_NAMES.every((c) => (keep![c] ?? null) === (cols[c] ?? null));
		if (same) continue;
		const ov = (() => { try { return keep!.overrides ? JSON.parse(keep!.overrides) as TrackOverrides : null; } catch { return null; } })();
		update.run(
			cols.remote_source, cols.title, cols.artists, cols.artists_base, cols.album_title, cols.duration, cols.isrc,
			cols.release_date, cols.label, cols.genre, cols.cover_url, cols.track_number, cols.disc_number,
			searchFold(cols.title), searchFold(cols.album_title), searchFold(cols.label), searchFold(cols.genre),
			asciifyArtists(ov?.artists ?? (JSON.parse(cols.artists) as TrackArtist[])), now, keep!.id,
		);
		if (keep!.artists !== cols.artists || keep!.album_title !== cols.album_title) pending.run(keep!.id);
		out.updated.push(keep!.id);
	}
	out.playlistsTouched = [...playlists];
	return out;
}

// After drops: positions and counts of the playlists the rows left (a
// re-projection that puts rows back recomputes again).
export function settlePlaylists(raw: Raw, playlistIds: Iterable<string>): void {
	const now = Date.now();
	for (const pid of new Set(playlistIds)) {
		if (raw.prepare(`SELECT 1 FROM playlist WHERE id = ?`).get(pid) === undefined) continue;
		recomputePositions(raw, pid);
		raw.prepare(`UPDATE playlist SET track_count = (SELECT count(*) FROM playlist_track WHERE playlist_id = ?), updated_at = ? WHERE id = ?`).run(pid, now, pid);
	}
}

// The playlists a sliced projection deferred (project.ts
// hooks.deferPositions), settled once each: one playlist per transaction, a
// yield between. Returns the longest slice.
export async function settlePlaylistsAsync(raw: Raw, playlistIds: Iterable<string>): Promise<number> {
	let maxSliceMs = 0;
	for (const pid of new Set(playlistIds)) {
		const t0 = performance.now();
		raw.transaction(() => settlePlaylists(raw, [pid]))();
		maxSliceMs = Math.max(maxSliceMs, performance.now() - t0);
		await yieldToLoop();
	}
	return maxSliceMs;
}

// Refs of every record of `recordings`, for the caller's projection.
export function adoptRefs(raw: Raw, recordings: readonly string[]): EntityRef[] {
	return recordings.length > 0 ? refsOfRecordings(raw, recordings) : [];
}

// ── the derived tables, drained ─────────────────────────────────────────────

// Up to this many remote rows a projection derives inline (~1 ms a row);
// more are left to the client's yielding drain.
export const INLINE_DERIVE_ROWS = 25;

export function remotePendingCount(raw: Raw): number {
	return raw.prepare(`SELECT count(*) FROM track_remote_pending`).pluck().get() as number;
}

export function derivePendingCount(raw: Raw): number {
	return raw.prepare(`SELECT count(*) FROM track_derive_pending`).pluck().get() as number;
}

// One chunk: the artist junction (and artist_sort) and the album of each
// queued remote row. Returns the rows done.
// 75 rows per slice: deriving the artist junction and the album is ~1 ms a
// row on the real library (measured 2026-10-20: 250 rows took up to 312 ms).
export function drainTrackDerivations(raw: Raw, opts: { max?: number } = {}): string[] {
	const max = Math.max(1, opts.max ?? 75);
	return raw.transaction((): string[] => {
		const ids = raw.prepare(`SELECT track_id FROM track_derive_pending LIMIT ?`).pluck().all(max) as string[];
		if (ids.length === 0) return [];
		const live = raw.prepare(`SELECT id FROM track WHERE id IN (${ids.map(() => '?').join(',')})`).pluck().all(...ids) as string[];
		if (live.length > 0) {
			syncTrackArtistsByIdRaw(raw, live);
			syncTrackAlbumsRaw(raw, live);
			// Provider artist ids the account's attributes carry for a row
			// without listings of its own (track-attrs.ts), as a sync would
			// have linked them from its payload.
			for (const r of raw.prepare(`SELECT source, json_extract(payload, '$.artists') AS artists FROM track_provider_ref WHERE track_id IN (${live.map(() => '?').join(',')}) AND json_valid(payload)`).all(...live) as Array<{ source: string; artists: string | null }>) {
				try { upsertArtistLinksRaw(raw, r.source, JSON.parse(r.artists ?? '[]') as ProviderArtistRef[]); } catch { /* a malformed ref links nothing */ }
			}
		}
		raw.prepare(`DELETE FROM track_derive_pending WHERE track_id IN (${ids.map(() => '?').join(',')})`).run(...ids);
		return live;
	})();
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function drainTrackDerivationsAsync(raw: Raw, opts: { chunk?: number } = {}): Promise<{ tracks: string[]; chunks: number; maxSliceMs: number }> {
	const tracks: string[] = [];
	let chunks = 0;
	let maxSliceMs = 0;
	for (;;) {
		const t0 = performance.now();
		const done = drainTrackDerivations(raw, { max: opts.chunk });
		maxSliceMs = Math.max(maxSliceMs, performance.now() - t0);
		if (done.length === 0 && derivePendingCount(raw) === 0) break;
		chunks++;
		tracks.push(...done);
		await yieldToLoop();
	}
	return { tracks, chunks, maxSliceMs };
}

export function remoteRowCount(raw: Raw): number {
	return raw.prepare(`SELECT count(*) FROM track WHERE remote_only = 1 AND deleted_at IS NULL`).pluck().get() as number;
}

export function materializeSwept(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(MATERIALIZE_KEY) !== undefined;
}

// A master change re-picks every remote row: the sweep runs again.
export function requestRematerialize(raw: Raw): void {
	raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(MATERIALIZE_KEY);
}
