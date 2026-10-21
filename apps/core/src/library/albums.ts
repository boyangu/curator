// The album seam — the ONE place that derives `album` + `album_artist` +
// `album_link` + `track.album_id` (and fills `track_number` / `disc_number`
// from provider payloads). Every write site that touches a track's album
// title, artists, overrides or source links calls syncTrackAlbums* after
// the artist seam has run; nothing else writes those tables except the
// background provider fill (album-enrich.ts), which goes through the
// exported helpers here. Identity rules: see the ALBUM comment in
// packages/shared/src/schema.ts.
//
// Same mechanics as the artist seam (artists.ts): raw better-sqlite3 with
// cached prepared statements, never opens its own transaction.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { artistKey } from '@curator/shared';
import type { TrackOverrides } from '@curator/shared/schema';
import type { Db } from '../db/client.js';
import { effectiveArtists, lookupArtistRaw, rawOf, upsertArtistRaw } from './artists.js';

type Raw = Database.Database;
type ArtistsSource = 'source' | 'derived' | 'various';

interface AlbumRow {
	id: string;
	title: string;
	title_key: string;
	album_key: string;
	artists_source: ArtistsSource;
	merged_into: string | null;
}

interface TrackRow {
	id: string;
	album_title: string | null;
	overrides: string | null;
	artists: string;
	album_id: string | null;
	release_date: string | null;
	cover_url: string | null;
}

// One provider album reference read off a source_link payload. Spotify full
// track objects carry the whole album (artists, type, total) plus the
// track's position; playlist-sync payloads are field-masked down to id /
// name / date / images; Tidal v2 carries id + title.
interface RefRow {
	source: string;
	album_id: string | number | null;
	album_name: string | null;
	album_artists: string | null;
	release_date: string | null;
	cover: string | null;
	album_type: string | null;
	total_tracks: number | null;
	track_number: number | null;
	disc_number: number | null;
}

interface Stmts {
	track: Database.Statement<[string], TrackRow>;
	refs: Database.Statement<[string, string], RefRow>;
	localPaths: Database.Statement<[string], { file_path: string | null }>;
	albumById: Database.Statement<[string], AlbumRow>;
	albumByKey: Database.Statement<[string], AlbumRow>;
	albumByKeyOther: Database.Statement<[string, string], AlbumRow>;
	albumByTitleArtist: Database.Statement<[string, string], { id: string }>;
	albumsByTitleInRange: Database.Statement<[string, string, string, string], { id: string; file_path: string }>;
	linkGet: Database.Statement<[string, string], { album_id: string }>;
	linkIns: Database.Statement<[string, string, string, string | null]>;
	insAlbum: Database.Statement<[string, string, string, string, ArtistsSource, string | null, string | null, string | null, number | null]>;
	albumArtistDel: Database.Statement<[string]>;
	albumArtistIns: Database.Statement<[string, string, number]>;
	albumArtistHas: Database.Statement<[string, string], { one: number }>;
	albumArtistIds: Database.Statement<[string], { artist_id: string }>;
	setArtistsMeta: Database.Statement<[ArtistsSource, string, number, string]>;
	fillGaps: Database.Statement<[string | null, string | null, string | null, number | null, string]>;
	setTrack: Database.Statement<[string | null, number | null, number | null, string]>;
	prune: Database.Statement<[string, string]>;
	pruneAliases: Database.Statement<[string]>;
}

const STMTS = new WeakMap<Raw, Stmts>();

function stmts(raw: Raw): Stmts {
	let s = STMTS.get(raw);
	if (!s) {
		s = {
			track: raw.prepare(`SELECT id, album_title, overrides, artists, album_id, release_date, cover_url FROM track WHERE id = ?`),
			// json_valid guards the extracts: one malformed payload must not
			// abort a whole sync or the boot backfill.
			// The row's own listings, then the ones the account's winning
			// attributes carry for a row without any (track_provider_ref,
			// sync-log/track-attrs.ts: written only for such a row), so a
			// device without the Spotify link files the track under the same
			// release as the one that has it.
			refs: raw.prepare(`
				SELECT source,
					json_extract(payload, '$.album.id') AS album_id,
					coalesce(json_extract(payload, '$.album.name'), json_extract(payload, '$.album.title')) AS album_name,
					json_extract(payload, '$.album.artists') AS album_artists,
					json_extract(payload, '$.album.release_date') AS release_date,
					json_extract(payload, '$.album.images[0].url') AS cover,
					json_extract(payload, '$.album.album_type') AS album_type,
					json_extract(payload, '$.album.total_tracks') AS total_tracks,
					json_extract(payload, '$.track_number') AS track_number,
					json_extract(payload, '$.disc_number') AS disc_number
				FROM (
					SELECT source, payload, 0 AS derived, fetched_at, 0 AS ord FROM source_link
					WHERE track_id = ? AND source IN ('spotify', 'tidal') AND payload IS NOT NULL AND json_valid(payload)
					UNION ALL
					SELECT source, payload, 1 AS derived, 0 AS fetched_at, ord FROM track_provider_ref
					WHERE track_id = ? AND json_valid(payload)
				)
				ORDER BY derived, CASE source WHEN 'spotify' THEN 0 ELSE 1 END, fetched_at DESC, ord`),
			// Live links only (missing_at IS NULL): a vanished file's folder is
			// no evidence of where the track's release siblings live.
			localPaths: raw.prepare(`SELECT file_path FROM source_link WHERE track_id = ? AND source = 'local' AND missing_at IS NULL`),
			albumById: raw.prepare(`SELECT id, title, title_key, album_key, artists_source, merged_into FROM album WHERE id = ?`),
			albumByKey: raw.prepare(`SELECT id, title, title_key, album_key, artists_source, merged_into FROM album WHERE album_key = ? AND merged_into IS NULL ORDER BY created_at, id LIMIT 1`),
			albumByKeyOther: raw.prepare(`SELECT id, title, title_key, album_key, artists_source, merged_into FROM album WHERE album_key = ? AND id != ? AND merged_into IS NULL ORDER BY created_at, id LIMIT 1`),
			albumByTitleArtist: raw.prepare(`
				SELECT a.id FROM album a JOIN album_artist aa ON aa.album_id = a.id
				WHERE a.title_key = ? AND aa.artist_id = ? AND a.merged_into IS NULL
				ORDER BY a.created_at, a.id LIMIT 1`),
			// Releases with this title that already hold a local file under
			// [lo, hi) — the caller narrows to the exact folder. A path range
			// (not LIKE) so the unique file_path index serves it.
			albumsByTitleInRange: raw.prepare(`
				SELECT a.id, sl.file_path FROM source_link sl
				JOIN track t ON t.id = sl.track_id
				JOIN album a ON a.id = t.album_id
				WHERE sl.source = 'local' AND sl.missing_at IS NULL AND sl.file_path >= ? AND sl.file_path < ?
					AND a.title_key = ? AND a.merged_into IS NULL AND t.id != ?
				LIMIT 50`),
			linkGet: raw.prepare(`SELECT album_id FROM album_link WHERE source = ? AND source_id = ?`),
			linkIns: raw.prepare(`INSERT OR IGNORE INTO album_link (album_id, source, source_id, url) VALUES (?, ?, ?, ?)`),
			insAlbum: raw.prepare(`
				INSERT INTO album (id, title, title_key, album_key, artists_source, release_date, cover_url, album_type, total_tracks)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
			albumArtistDel: raw.prepare(`DELETE FROM album_artist WHERE album_id = ?`),
			albumArtistIns: raw.prepare(`INSERT OR IGNORE INTO album_artist (album_id, artist_id, position) VALUES (?, ?, ?)`),
			albumArtistHas: raw.prepare(`SELECT 1 AS one FROM album_artist WHERE album_id = ? AND artist_id = ?`),
			albumArtistIds: raw.prepare(`SELECT artist_id FROM album_artist WHERE album_id = ? ORDER BY position`),
			setArtistsMeta: raw.prepare(`UPDATE album SET artists_source = ?, album_key = ?, updated_at = ? WHERE id = ?`),
			// A provider value fills a gap; it never overwrites (the enrich
			// pass owns authoritative rewrites).
			fillGaps: raw.prepare(`
				UPDATE album SET
					release_date = coalesce(release_date, ?),
					cover_url = coalesce(cover_url, ?),
					album_type = coalesce(album_type, ?),
					total_tracks = coalesce(total_tracks, ?)
				WHERE id = ?`),
			setTrack: raw.prepare(`
				UPDATE track SET album_id = ?, track_number = coalesce(?, track_number), disc_number = coalesce(?, disc_number)
				WHERE id = ?`),
			// An album nothing points at any more (its last track moved or was
			// re-titled). Aliases keep their row so merged ids stay resolvable;
			// links and album_artist rows cascade.
			prune: raw.prepare(`DELETE FROM album WHERE id = ? AND merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM track WHERE album_id = ?)`),
			pruneAliases: raw.prepare(`DELETE FROM album WHERE merged_into = ?`),
		};
		STMTS.set(raw, s);
	}
	return s;
}

function parseOverrides(v: string | null): TrackOverrides | null {
	if (!v) return null;
	try { return JSON.parse(v) as TrackOverrides; } catch { return null; }
}

// The album title the user sees: an override wins over the canonical text.
export function effectiveAlbumTitle(row: { album_title: string | null; overrides: string | null }): string | null {
	const t = (parseOverrides(row.overrides)?.albumTitle ?? row.album_title ?? '').trim();
	return t || null;
}

// The track's main artist: the first credit that isn't a remixer or a
// featured guest (Spotify/Tidal write no roles, so this is usually just the
// first name), else the first credit at all.
function mainArtistName(row: { artists: string; overrides: string | null }): string | null {
	const list = effectiveArtists(row).filter((a) => a && typeof a.name === 'string' && a.name.trim());
	const main = list.find((a) => a.role !== 'remixer' && a.role !== 'featured') ?? list[0];
	return main ? main.name.trim() : null;
}

// Identity: folded title + sorted album-artist ids, `*` for Various Artists.
// Artist ids (not names) so a rename or merge of the artist keeps the key.
export function albumKeyOf(titleKey: string, artistIds: readonly string[], various: boolean): string {
	return `${titleKey}|${various ? '*' : [...new Set(artistIds)].sort().join(',')}`;
}

function parseArtistNames(v: string | null): string[] {
	if (!v) return [];
	try {
		const arr = JSON.parse(v) as unknown;
		if (!Array.isArray(arr)) return [];
		return arr
			.map((a) => (a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string' ? (a as { name: string }).name.trim() : ''))
			.filter(Boolean);
	} catch {
		return [];
	}
}

function albumUrl(source: string, id: string): string | null {
	if (source === 'spotify') return `https://open.spotify.com/album/${id}`;
	if (source === 'tidal') return `https://tidal.com/browse/album/${id}`;
	return null;
}

function toIntOrNull(v: unknown): number | null {
	const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
	return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

// Follow the alias chain to the live album. Bounded like the artist one.
function liveAlbum(s: Stmts, id: string): AlbumRow | null {
	let cur = s.albumById.get(id);
	for (let hops = 0; cur?.merged_into && hops < 8; hops++) cur = s.albumById.get(cur.merged_into);
	return cur && !cur.merged_into ? cur : null;
}

export function liveAlbumIdRaw(raw: Raw, id: string): string | null {
	return liveAlbum(stmts(raw), id)?.id ?? null;
}

// Fold `dropId` into `keepId`: members, links and missing metadata move;
// the dropped row stays as an alias so a stale `albumid={…}` scope still
// resolves.
export function mergeAlbumsRaw(raw: Raw, keepId: string, dropId: string): void {
	if (keepId === dropId) return;
	const now = Date.now();
	raw.prepare(`UPDATE track SET album_id = ? WHERE album_id = ?`).run(keepId, dropId);
	raw.prepare(`UPDATE OR IGNORE album_link SET album_id = ? WHERE album_id = ?`).run(keepId, dropId);
	raw.prepare(`DELETE FROM album_link WHERE album_id = ?`).run(dropId);
	raw.prepare(`
		UPDATE album SET
			release_date = coalesce(release_date, (SELECT release_date FROM album WHERE id = @drop)),
			cover_url = coalesce(cover_url, (SELECT cover_url FROM album WHERE id = @drop)),
			album_type = coalesce(album_type, (SELECT album_type FROM album WHERE id = @drop)),
			total_tracks = coalesce(total_tracks, (SELECT total_tracks FROM album WHERE id = @drop)),
			label = coalesce(label, (SELECT label FROM album WHERE id = @drop)),
			upc = coalesce(upc, (SELECT upc FROM album WHERE id = @drop)),
			updated_at = @now
		WHERE id = @keep`).run({ keep: keepId, drop: dropId, now });
	raw.prepare(`DELETE FROM album_artist WHERE album_id = ?`).run(dropId);
	raw.prepare(`UPDATE album SET merged_into = ?, updated_at = ? WHERE id = ?`).run(keepId, now, dropId);
	raw.prepare(`UPDATE album SET merged_into = ?, updated_at = ? WHERE merged_into = ?`).run(keepId, now, dropId);
}

// Rewrite an album's artists (provider answer, compilation detection) and
// its identity key. When the new key is already held by another live album
// the two are the same release: the older one survives. Returns the
// surviving id.
export function setAlbumArtistsRaw(raw: Raw, albumId: string, artistIds: readonly string[], source: ArtistsSource): string {
	const s = stmts(raw);
	const a = s.albumById.get(albumId);
	if (!a) return albumId;
	const various = source === 'various';
	const ids = various ? [] : [...new Set(artistIds)];
	s.albumArtistDel.run(albumId);
	ids.forEach((id, i) => s.albumArtistIns.run(albumId, id, i));
	const key = albumKeyOf(a.title_key, ids, various);
	s.setArtistsMeta.run(source, key, Date.now(), albumId);
	const other = s.albumByKeyOther.get(key, albumId);
	if (other) {
		mergeAlbumsRaw(raw, other.id, albumId);
		return other.id;
	}
	if (source === 'source' && ids.length > 0) absorbGuessesRaw(raw, albumId, a.title_key, ids);
	return albumId;
}

// The provider just named this release's artists. Releases with the same
// title that were only GUESSED (one album artist = the track's main artist)
// and name one of those artists are the same release seen through another
// source — a local rip, a Tidal copy — so they fold in. A guess holding its
// own Spotify album id is a different release on the provider (two
// "Remixes" EPs by one artist) and stays.
function absorbGuessesRaw(raw: Raw, albumId: string, titleKey: string, artistIds: readonly string[]): void {
	const ph = artistIds.map(() => '?').join(',');
	const guesses = raw.prepare(`
		SELECT DISTINCT a.id FROM album a JOIN album_artist aa ON aa.album_id = a.id
		WHERE a.title_key = ? AND a.id != ? AND a.merged_into IS NULL AND a.artists_source = 'derived'
			AND aa.artist_id IN (${ph})
			AND NOT EXISTS (SELECT 1 FROM album_link l WHERE l.album_id = a.id AND l.source = 'spotify')`)
		.all(titleKey, albumId, ...artistIds) as Array<{ id: string }>;
	for (const g of guesses) mergeAlbumsRaw(raw, albumId, g.id);
}

// A track joining a release whose artists were only GUESSED: if the
// provider now names them, adopt that; if this track's main artist isn't
// among the guessed ones, the release is a compilation.
function reconcileArtists(raw: Raw, s: Stmts, albumId: string, sourceArtistIds: string[] | null, mainId: string | null): string {
	const a = s.albumById.get(albumId);
	if (!a) return albumId;
	if (sourceArtistIds && sourceArtistIds.length > 0 && a.artists_source !== 'source') {
		return setAlbumArtistsRaw(raw, albumId, sourceArtistIds, 'source');
	}
	if (!sourceArtistIds && a.artists_source === 'derived' && mainId && !s.albumArtistHas.get(albumId, mainId)) {
		return setAlbumArtistsRaw(raw, albumId, [], 'various');
	}
	return albumId;
}

function dirOf(path: string): { dir: string; sep: string } | null {
	const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	if (i <= 0) return null;
	return { dir: path.slice(0, i), sep: path[i]! };
}

// A local rip of a compilation files every track under one folder with
// one album tag but different artists. A release with the same title
// already holding a file in this exact folder is the one this track joins.
function albumBySiblingFile(s: Stmts, trackId: string, titleKey: string): string | null {
	for (const { file_path } of s.localPaths.all(trackId)) {
		if (!file_path) continue;
		const d = dirOf(file_path);
		if (!d) continue;
		const lo = d.dir + d.sep;
		const hi = d.dir + String.fromCharCode(d.sep.charCodeAt(0) + 1);
		for (const hit of s.albumsByTitleInRange.all(lo, hi, titleKey, trackId)) {
			if (dirOf(hit.file_path)?.dir === d.dir) return hit.id;
		}
	}
	return null;
}

interface Derived { albumId: string | null; trackNumber: number | null; discNumber: number | null }
const NO_ALBUM: Derived = { albumId: null, trackNumber: null, discNumber: null };

// Derive one track's release (and its position on it, when a provider
// payload says). albumId null ⇔ the track has no album title.
function deriveTrackAlbum(raw: Raw, s: Stmts, row: TrackRow): Derived {
	const title = effectiveAlbumTitle(row);
	if (!title) return NO_ALBUM;
	const titleKey = artistKey(title);
	if (!titleKey) return NO_ALBUM;

	// A provider album id only counts when that album IS the one this track
	// is titled under: playlist versions of a track often live on a
	// compilation, and the ISRC match binds that link to the original
	// release's canonical row. A user-overridden album title is the user
	// saying which release this is, so provider ids are ignored then.
	const overridden = parseOverrides(row.overrides)?.albumTitle != null;
	const refs = overridden
		? []
		: s.refs.all(row.id, row.id).filter((r) => r.album_id != null && String(r.album_id) !== '' && artistKey(r.album_name ?? '') === titleKey);

	const main = mainArtistName(row);
	const mainId = main ? lookupArtistRaw(raw, main)?.id ?? null : null;
	const sourceNames = refs.map((r) => parseArtistNames(r.album_artists)).find((n) => n.length > 0) ?? null;
	const sourceIds = sourceNames ? sourceNames.map((n) => upsertArtistRaw(raw, n).id) : null;

	let albumId: string | null = null;
	for (const r of refs) {
		const hit = s.linkGet.get(r.source, String(r.album_id));
		const live = hit ? liveAlbum(s, hit.album_id) : null;
		if (live) { albumId = live.id; break; }
	}
	if (albumId) {
		albumId = reconcileArtists(raw, s, albumId, sourceIds, mainId);
	} else {
		const ids = sourceIds ?? (mainId ? [mainId] : []);
		albumId = s.albumByKey.get(albumKeyOf(titleKey, ids, false))?.id ?? null;
		if (!albumId && !sourceIds && mainId) {
			// A release the track's main artist is credited on (created from a
			// richer source that named several album artists).
			albumId = s.albumByTitleArtist.get(titleKey, mainId)?.id ?? null;
		}
		if (!albumId && !sourceIds && refs.length === 0) {
			const sibling = albumBySiblingFile(s, row.id, titleKey);
			if (sibling) albumId = reconcileArtists(raw, s, sibling, null, mainId);
		}
		if (!albumId) {
			const r0 = refs[0];
			albumId = randomUUID();
			s.insAlbum.run(
				albumId,
				r0?.album_name?.trim() || title,
				titleKey,
				albumKeyOf(titleKey, ids, false),
				sourceIds ? 'source' : 'derived',
				r0?.release_date ?? row.release_date ?? null,
				r0?.cover ?? row.cover_url ?? null,
				r0?.album_type ?? null,
				toIntOrNull(r0?.total_tracks),
			);
			ids.forEach((id, i) => s.albumArtistIns.run(albumId!, id, i));
		}
	}

	let linked = false;
	for (const r of refs) if (s.linkIns.run(albumId, r.source, String(r.album_id), albumUrl(r.source, String(r.album_id))).changes > 0) linked = true;
	const r0 = refs[0];
	s.fillGaps.run(r0?.release_date ?? row.release_date ?? null, r0?.cover ?? row.cover_url ?? null, r0?.album_type ?? null, toIntOrNull(r0?.total_tracks), albumId);
	// A release just linked that this device never asked its provider about:
	// the account may already know what the provider says (album.set-meta).
	if (linked) {
		for (const r of refs) {
			const live = applySyncedAlbumMetaRaw(raw, albumId, r.source, String(r.album_id));
			if (live !== albumId) { albumId = live; break; }
		}
	}
	const pos = refs.find((r) => r.track_number != null);
	return { albumId, trackNumber: toIntOrNull(pos?.track_number), discNumber: toIntOrNull(pos?.disc_number) };
}

// Re-derive the release of each track and point track.album_id at it. An
// album its last track left is pruned.
export function syncTrackAlbumsRaw(raw: Raw, trackIds: readonly string[]): void {
	const s = stmts(raw);
	for (const id of trackIds) {
		const row = s.track.get(id);
		if (!row) continue;
		const d = deriveTrackAlbum(raw, s, row);
		s.setTrack.run(d.albumId, d.trackNumber, d.discNumber, row.id);
		if (row.album_id && row.album_id !== d.albumId) pruneAlbumRaw(raw, row.album_id);
	}
}

export function syncTrackAlbumsById(db: Db, trackIds: readonly string[]): void {
	syncTrackAlbumsRaw(rawOf(db), trackIds);
}

// ── provider release metadata from the op log (protocol v4) ─────────────────

// The record the account holds for a provider release (`album.set-meta`,
// keyed `${source}:${id}`), or null.
type AlbumMetaRecord = { album_type?: string | null; total_tracks?: number | null; release_date?: string | null; label?: string | null; upc?: string | null; cover_url?: string | null; artists?: string[]; various?: boolean };
export function syncedAlbumMetaRaw(raw: Raw, source: string, providerId: string): { meta: AlbumMetaRecord; at: number } | null {
	const json = raw.prepare(`SELECT value FROM sync_state WHERE map = 'albums' AND key = ?`).pluck().get(`${source}:${providerId}`) as string | undefined;
	if (!json) return null;
	try {
		const rec = JSON.parse(json) as { fields?: Record<string, { value: unknown; clock: { ts: number } }> };
		const meta: Record<string, unknown> = {};
		let at = 0;
		for (const [k, c] of Object.entries(rec.fields ?? {})) { meta[k] = c.value; at = Math.max(at, c.clock?.ts ?? 0); }
		return { meta: meta as AlbumMetaRecord, at };
	} catch {
		return null;
	}
}

// What another device's provider fill said about a release this device
// links (album-enrich.ts applySpotifyAlbumRaw's writes, from the record
// instead of the provider): artists through the seam (which may merge two
// releases — the survivor's id is returned), the scalars provider-first,
// and enriched_at so this device's own fill does not ask again. No-op when
// the account holds nothing for it, or for an album already merged away.
export function applySyncedAlbumMetaRaw(raw: Raw, albumId: string, source: string, providerId: string): string {
	const rec = syncedAlbumMetaRaw(raw, source, providerId);
	if (!rec) return albumId;
	const live = raw.prepare(`SELECT id FROM album WHERE id = ? AND merged_into IS NULL`).get(albumId) as { id: string } | undefined;
	if (!live) return albumId;
	const m = rec.meta;
	let id = albumId;
	const names = (m.artists ?? []).map((n) => (typeof n === 'string' ? n.trim() : '')).filter(Boolean);
	if (m.various) id = setAlbumArtistsRaw(raw, albumId, [], 'various');
	else if (names.length > 0) id = setAlbumArtistsRaw(raw, albumId, names.map((n) => upsertArtistRaw(raw, n).id), 'source');
	raw.prepare(`
		UPDATE album SET
			album_type = coalesce(?, album_type),
			total_tracks = coalesce(?, total_tracks),
			release_date = coalesce(?, release_date),
			label = coalesce(?, label),
			upc = coalesce(?, upc),
			cover_url = coalesce(?, cover_url),
			enriched_at = coalesce(enriched_at, ?),
			updated_at = ?
		WHERE id = ?`).run(
		m.album_type ?? null, typeof m.total_tracks === 'number' ? m.total_tracks : null, m.release_date ?? null, m.label ?? null, m.upc ?? null,
		m.cover_url ?? null, rec.at || Date.now(), Date.now(), id,
	);
	return id;
}

export function pruneAlbumRaw(raw: Raw, albumId: string): void {
	const s = stmts(raw);
	if (s.prune.run(albumId, albumId).changes > 0) s.pruneAliases.run(albumId);
}

// Album-artist rows still pointing at an artist that has since been merged
// into another (mergeArtists / a rename onto an existing spelling) move to
// the live artist, and the album keys follow.
export function healAlbumArtistAliasesRaw(raw: Raw): number {
	const rows = raw.prepare(`
		SELECT DISTINCT aa.album_id FROM album_artist aa JOIN artist ar ON ar.id = aa.artist_id
		WHERE ar.merged_into IS NOT NULL`).all() as Array<{ album_id: string }>;
	if (rows.length === 0) return 0;
	const s = stmts(raw);
	const resolveArtist = raw.prepare(`SELECT id, merged_into FROM artist WHERE id = ?`);
	const live = (id: string): string => {
		let cur = resolveArtist.get(id) as { id: string; merged_into: string | null } | undefined;
		for (let hops = 0; cur?.merged_into && hops < 8; hops++) {
			cur = resolveArtist.get(cur.merged_into) as { id: string; merged_into: string | null } | undefined;
		}
		return cur?.id ?? id;
	};
	for (const { album_id } of rows) {
		const a = s.albumById.get(album_id);
		if (!a || a.merged_into) continue;
		const ids = s.albumArtistIds.all(album_id).map((r) => live(r.artist_id));
		setAlbumArtistsRaw(raw, album_id, ids, a.artists_source);
	}
	return rows.length;
}

// Every boot, cheap: live tracks with an album title but no album (a write
// site bypassed the seam), tracks parked on a merged alias, album artists
// on merged artists, and albums nothing points at. Returns how many tracks
// had to be re-derived.
export function repairAlbumTablesRaw(raw: Raw): number {
	const stale = raw.prepare(`
		SELECT t.id FROM track t
		WHERE t.deleted_at IS NULL AND (
			(t.album_id IS NULL AND (
				(t.album_title IS NOT NULL AND trim(t.album_title) != '')
				OR (t.overrides IS NOT NULL AND json_valid(t.overrides) AND json_extract(t.overrides, '$.albumTitle') IS NOT NULL)))
			OR t.album_id IN (SELECT id FROM album WHERE merged_into IS NOT NULL)
			OR (t.album_id IS NOT NULL AND t.album_id NOT IN (SELECT id FROM album))
		)`).all() as Array<{ id: string }>;
	let fixed = 0;
	raw.transaction(() => {
		if (stale.length > 0) {
			const before = raw.prepare(`SELECT count(*) AS n FROM track WHERE deleted_at IS NULL AND album_id IS NOT NULL`).get() as { n: number };
			syncTrackAlbumsRaw(raw, stale.map((r) => r.id));
			const after = raw.prepare(`SELECT count(*) AS n FROM track WHERE deleted_at IS NULL AND album_id IS NOT NULL`).get() as { n: number };
			fixed = after.n - before.n;
		}
		healAlbumArtistAliasesRaw(raw);
		raw.prepare(`DELETE FROM album WHERE merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM track t WHERE t.album_id = album.id)`).run();
	})();
	return fixed;
}

// Tracks the boot backfill derives, in the order that lets the best-informed
// source claim each release first: tracks whose provider payload names the
// album artists, then tracks with any provider album id, then the rest.
export function albumBackfillOrderRaw(raw: Raw): string[] {
	const rows = raw.prepare(`
		SELECT t.id,
			EXISTS (SELECT 1 FROM source_link sl WHERE sl.track_id = t.id AND sl.source = 'spotify'
				AND sl.payload IS NOT NULL AND json_valid(sl.payload)
				AND json_type(sl.payload, '$.album.artists') = 'array'
				AND json_array_length(sl.payload, '$.album.artists') > 0) AS rich,
			EXISTS (SELECT 1 FROM source_link sl WHERE sl.track_id = t.id AND sl.source IN ('spotify', 'tidal')) AS linked
		FROM track t
		WHERE t.deleted_at IS NULL
		ORDER BY rich DESC, linked DESC, t.created_at, t.id`).all() as Array<{ id: string }>;
	return rows.map((r) => r.id);
}
