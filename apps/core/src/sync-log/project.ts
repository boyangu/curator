// Records → visible tables, for ops that arrived from elsewhere (apply.ts).
// The reducer has already decided every merge rule; this only writes what
// `materialize` would show for the touched entities into tag, track_tag,
// playlist, playlist_track, cue, … so every reader (the track list, the
// rekordbox exporter, Spotify's positional moves) keeps working unchanged.
//
// Rules that are the desktop's, not the protocol's:
//   - Tracks are catalogue/scanner rows. A record for a recording with no
//     local row is kept (the row may arrive later) but not projected.
//   - Local-only columns survive an upsert: playlist sync stamps, cue ids and
//     origin, membership source_track_id, pinned-search position.
//   - A container whose provider identity is already held by another local
//     row (two desktops each minted a row for one Spotify playlist, or
//     imported one rekordbox history) is skipped and logged rather than
//     failing the batch: stable cross-device ids for provider rows are
//     workstream E's.
//   - Derived columns are recomputed for the touched rows only: positions
//     from order keys, track_count, artists_ascii and the artist/album seams.
//     The membership tier is left to the caller (it needs the connected
//     Spotify id); `tracksTouched` names the rows to recompute.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
	cueAlive,
	decodeRbGrid,
	parseCueEntityId,
	parseTrackTagEntityId,
	pinnedSearchAlive,
	playlistAlive,
	playlistFolderAlive,
	playlistTrackAlive,
	tagAlive,
	tombstoneKey,
	trackTagAlive,
	type CueRecord,
	type EntityRef,
	type LwwRecord,
	type PlaylistTrackRecord,
	type SourceLink,
	type TrackTagRecord,
} from '@curator/protocol';
import { asciifyArtists, searchFold } from '@curator/shared';
import type { SegmentRecord, TrackArtist, TrackOverrides } from '@curator/shared/schema';
import { diffArtistAlias, projectArtistAliasChanges } from '../library/artist-alias.js';
import { recomputePositions } from '../library/playlist-order.js';
import { syncTrackArtistsByIdRaw } from '../library/artists.js';
import { syncTrackAlbumsRaw } from '../library/albums.js';
import { log } from '../log.js';
import { float32Buffer, rbIntroOutro, readRbSlot, writeRbSlot, type RbSlotPatch } from '../rekordbox/rb-slot.js';
import { OVERRIDE_KEY_OF, parseOverrides, RB_UNITS, rbSegmentsValue } from './rows.js';
import type { FlushResult, SyncStateStore } from './store.js';

type Raw = Database.Database;

const plog = log.for('sync-apply');

export type ProjectSummary = {
	tracksTouched: string[];
	playlistsTouched: string[];
	skipped: Array<{ entity: string; id: string; reason: string }>;
};

function field<T>(rec: LwwRecord, name: string, fallback: T): T {
	const c = rec.fields[name];
	return c === undefined ? fallback : (c.value as T);
}

export type MergeRowsHook = (loserTrackId: string, winnerTrackId: string) => void;

export function project(
	raw: Raw,
	store: SyncStateStore,
	changed: readonly EntityRef[],
	flushed: FlushResult,
	hooks: { mergeRows?: MergeRowsHook; containersCreated?: ReadonlySet<string> } = {},
): ProjectSummary {
	const state = store.state;
	const now = Date.now();
	const summary: ProjectSummary = { tracksTouched: [], playlistsTouched: [], skipped: [] };
	const tracksTouched = new Set<string>();
	const playlistsTouched = new Set<string>();

	const by = new Map<string, Set<string>>();
	const add = (entity: string, id: string): void => {
		let s = by.get(entity);
		if (!s) by.set(entity, (s = new Set()));
		s.add(id);
	};
	for (const r of changed) add(r.entity, r.id);
	const ids = (entity: string): string[] => [...(by.get(entity) ?? [])];

	// recording → local track row. Live rows first: a merge loser keeps its
	// recording id on a soft-deleted row.
	const trackCache = new Map<string, string | null>();
	const trackStmt = raw.prepare(`SELECT id FROM track WHERE recording_id = ? ORDER BY deleted_at IS NOT NULL, created_at, id LIMIT 1`);
	const trackFor = (recordingId: string | null): string | null => {
		if (!recordingId) return null;
		let v = trackCache.get(recordingId);
		if (v === undefined) {
			v = (trackStmt.get(recordingId) as { id: string } | undefined)?.id ?? null;
			trackCache.set(recordingId, v);
		}
		return v;
	};
	const exists = (table: string, id: string): boolean => raw.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;

	// ── 1. recording merges: fold the local rows first ───────────────────
	// Records already moved to the winner; the local rows follow: when both
	// recordings have a row here, the desktop's own merge moves links,
	// analysis and the rest (hook; emission off) and soft-deletes the loser;
	// when only the loser has one, it simply becomes the winner's row.
	for (const id of ids('recording')) {
		const target = state.recordingAlias.get(id);
		if (!target) continue;
		const loserRows = raw.prepare(`SELECT id FROM track WHERE recording_id = ?`).all(id) as Array<{ id: string }>;
		if (loserRows.length === 0) continue;
		const winner = trackFor(target);
		if (!winner) {
			raw.prepare(`UPDATE track SET recording_id = ? WHERE recording_id = ?`).run(target, id);
			for (const r of loserRows) tracksTouched.add(r.id);
		} else {
			for (const r of loserRows) {
				if (r.id === winner) continue;
				try {
					if (hooks.mergeRows) hooks.mergeRows(r.id, winner);
					else raw.prepare(`UPDATE track SET deleted_at = COALESCE(deleted_at, ?), membership = NULL, updated_at = ? WHERE id = ?`).run(now, now, r.id);
				} catch (err) {
					// A blocked local merge (both rows rekordbox-linked) leaves
					// both rows; the records still fold onto the winner.
					plog.warn('recording merge: local rows left unmerged', { loser: r.id, winner, error: err instanceof Error ? err.message : String(err) });
					summary.skipped.push({ entity: 'recording', id, reason: 'local merge blocked' });
				}
				tracksTouched.add(r.id);
			}
			tracksTouched.add(winner);
		}
		trackCache.clear();
	}

	// ── 1b. artist alias rules: the artist table follows the resolved map ─
	// Diffed against the map as it stood before this batch, so a rule whose
	// effect changed only through another (the head of a chain whose middle
	// moved, the loser of a cycle) is projected too. The credit rewrite this
	// queues is drained by the caller, in chunks.
	{
		const changes = diffArtistAlias(store.artistAliasBefore, state.artistAlias, (k) => state.artistAliases.get(k)?.value?.from ?? null);
		projectArtistAliasChanges(raw, changes);
	}

	// ── 2. containers ────────────────────────────────────────────────────
	const cascade = (map: 'trackTags' | 'playlistTracks' | 'playEvents', parentId: string, entity: string): void => {
		for (const k of store.ensureChildren(map, parentId)) add(entity, k);
	};
	// A container's children are re-projected when its visibility may have
	// flipped: its row appeared or vanished here, or a create/delete for it
	// arrived in this batch (a system tag's row predates its create record,
	// so its assignments that arrived first were held back until now).
	const flipped = (entity: string, id: string, alive: boolean, was: boolean): boolean =>
		alive !== was || (hooks.containersCreated?.has(`${entity}:${id}`) ?? false);

	for (const id of ids('tag')) {
		store.ensure('tags', id);
		store.ensureTombstone(tombstoneKey('tag', id));
		const alive = tagAlive(state, id);
		const was = exists('tag', id);
		if (alive) {
			const r = state.tags.get(id)!;
			raw.prepare(`INSERT INTO tag (id, name, kind, color) VALUES (?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, color = excluded.color`)
				.run(id, field(r, 'name', 'Untitled'), field(r, 'kind', 'user'), field(r, 'color', null));
		} else if (was) {
			// Explicit, not left to the FK cascade: a raw handle opened
			// without PRAGMA foreign_keys would keep the assignments.
			raw.prepare(`DELETE FROM track_tag WHERE tag_id = ?`).run(id);
			raw.prepare(`DELETE FROM tag WHERE id = ?`).run(id);
		}
		if (flipped('tag', id, alive, was)) cascade('trackTags', id, 'track_tag');
	}

	const providerClash = (table: 'playlist' | 'playlist_folder', id: string, link: SourceLink | null): boolean => {
		if (!link) return false;
		const other = raw.prepare(`SELECT id FROM ${table} WHERE source = ? AND source_id = ? AND id != ?`).get(link.source, link.source_id, id);
		return other !== undefined;
	};

	for (const id of ids('playlist_folder')) {
		store.ensure('playlistFolders', id);
		store.ensureTombstone(tombstoneKey('playlist_folder', id));
		if (playlistFolderAlive(state, id)) {
			const r = state.playlistFolders.get(id)!;
			const name = field(r, 'name', 'Untitled');
			const link = field<SourceLink | null>(r, 'source_link', null);
			if (providerClash('playlist_folder', id, link)) {
				summary.skipped.push({ entity: 'playlist_folder', id, reason: 'provider folder held by another row' });
				continue;
			}
			raw.prepare(`INSERT INTO playlist_folder (id, source, source_id, parent_folder_id, name, name_ascii) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET source = excluded.source, source_id = excluded.source_id,
					parent_folder_id = excluded.parent_folder_id, name = excluded.name, name_ascii = excluded.name_ascii, updated_at = ?`)
				.run(id, link?.source ?? 'local', link?.source_id ?? id, field(r, 'parent_folder_id', null), name, searchFold(name), now);
		} else {
			raw.prepare(`UPDATE playlist SET parent_folder_id = NULL WHERE parent_folder_id = ?`).run(id);
			raw.prepare(`UPDATE playlist_folder SET parent_folder_id = NULL WHERE parent_folder_id = ?`).run(id);
			raw.prepare(`DELETE FROM playlist_folder WHERE id = ?`).run(id);
		}
	}

	for (const id of ids('playlist')) {
		store.ensure('playlists', id);
		store.ensureTombstone(tombstoneKey('playlist', id));
		const alive = playlistAlive(state, id);
		const was = exists('playlist', id);
		if (alive) {
			const r = state.playlists.get(id)!;
			const name = field(r, 'name', 'Untitled');
			const link = field<SourceLink | null>(r, 'source_link', null);
			if (providerClash('playlist', id, link)) {
				summary.skipped.push({ entity: 'playlist', id, reason: 'provider playlist held by another row' });
				continue;
			}
			const source = link?.source ?? 'local';
			raw.prepare(`INSERT INTO playlist (id, source, source_id, url, name, name_ascii, is_favorite, parent_folder_id, sync_status)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET source = excluded.source, source_id = excluded.source_id, url = excluded.url,
					name = excluded.name, name_ascii = excluded.name_ascii, is_favorite = excluded.is_favorite,
					parent_folder_id = excluded.parent_folder_id, updated_at = ?`)
				.run(
					id, source, link?.source_id ?? id, link?.url ?? null, name, searchFold(name),
					field(r, 'favourite', false) ? 1 : 0, field(r, 'folder_id', null),
					// A streaming playlist that arrives from elsewhere has no
					// membership here yet: 'pending' lets the lazy read-sync pull it.
					source === 'spotify' || source === 'tidal' ? 'pending' : 'synced',
					now,
				);
		} else if (was) {
			raw.prepare(`DELETE FROM playlist_track WHERE playlist_id = ?`).run(id);
			raw.prepare(`DELETE FROM playlist WHERE id = ?`).run(id);
		}
		if (flipped('playlist', id, alive, was)) cascade('playlistTracks', id, 'playlist_track');
	}

	for (const id of ids('pinned_search')) {
		store.ensure('pinnedSearches', id);
		store.ensureTombstone(tombstoneKey('pinned_search', id));
		if (pinnedSearchAlive(state, id)) {
			const r = state.pinnedSearches.get(id)!;
			raw.prepare(`INSERT INTO pinned_search (id, name, query, sort_column, sort_dir, position)
				VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM pinned_search))
				ON CONFLICT(id) DO UPDATE SET name = excluded.name, query = excluded.query, sort_column = excluded.sort_column, sort_dir = excluded.sort_dir`)
				.run(id, field(r, 'name', 'Untitled'), field(r, 'query', ''), field(r, 'sort_column', null), field(r, 'sort_dir', null));
		} else {
			raw.prepare(`DELETE FROM pinned_search WHERE id = ?`).run(id);
		}
	}

	for (const key of ids('setting')) {
		const cell = state.settings.get(key);
		if (!cell) continue;
		raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
			.run(key, JSON.stringify(cell.value), now);
	}

	for (const id of ids('play_session')) {
		const r = state.playSessions.get(id);
		if (!r || r.created === null) continue;
		const rbId = field<string | null>(r, 'rb_history_id', null);
		if (rbId && raw.prepare(`SELECT 1 FROM play_session WHERE rb_history_id = ? AND id != ?`).get(rbId, id)) {
			summary.skipped.push({ entity: 'play_session', id, reason: 'rekordbox history held by another session' });
			continue;
		}
		const was = exists('play_session', id);
		raw.prepare(`INSERT INTO play_session (id, origin, kind, kind_source, name, started_at, ended_at, rb_history_id, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET origin = excluded.origin, kind = excluded.kind, kind_source = excluded.kind_source,
				name = excluded.name, started_at = excluded.started_at, ended_at = excluded.ended_at,
				rb_history_id = excluded.rb_history_id, updated_at = excluded.updated_at`)
			.run(id, field(r, 'origin', 'curator'), field(r, 'kind', 'unknown'), field(r, 'kind_source', 'auto'), field(r, 'name', null),
				field(r, 'started_at', 0), field(r, 'ended_at', null), rbId, now);
		if (!was) cascade('playEvents', id, 'play_event');
	}

	// ── 3. records a merge fold removed: their rows go with them ─────────
	// The key names the LOSER recording; its local row (if the merge above
	// left one) loses the row the winner now holds.
	for (const r of flushed.removed) {
		const v = r.value as Record<string, unknown>;
		if (r.map === 'trackTags') {
			const rec = v as unknown as TrackTagRecord;
			const t = trackFor(rec.recordingId);
			if (t && raw.prepare(`DELETE FROM track_tag WHERE track_id = ? AND tag_id = ?`).run(t, rec.tagId).changes > 0) tracksTouched.add(t);
		} else if (r.map === 'cues') {
			const rec = v as unknown as CueRecord;
			const t = trackFor(rec.recordingId);
			if (t && raw.prepare(`DELETE FROM cue WHERE track_id = ? AND slot = ? AND kind = ?`).run(t, rec.slot, rec.kind).changes > 0) tracksTouched.add(t);
		}
	}

	// ── 4. children ──────────────────────────────────────────────────────
	for (const key of ids('track_tag')) {
		const rec = store.ensure('trackTags', key) as TrackTagRecord | undefined;
		const parts = rec ?? (() => {
			const p = parseTrackTagEntityId(key);
			return p ? { recordingId: p.recordingId, tagId: p.tagId } : null;
		})();
		if (!parts) continue;
		store.ensure('tags', parts.tagId);
		store.ensureTombstone(tombstoneKey('tag', parts.tagId));
		store.ensureTombstone(tombstoneKey('track_tag', key));
		const t = trackFor(parts.recordingId);
		if (!t) continue;
		if (trackTagAlive(state, key) && exists('tag', parts.tagId)) {
			const r = raw.prepare(`INSERT OR IGNORE INTO track_tag (track_id, tag_id, added_at) VALUES (?, ?, ?)`).run(t, parts.tagId, rec?.added.ts ?? now);
			if (r.changes > 0) tracksTouched.add(t);
		} else if (raw.prepare(`DELETE FROM track_tag WHERE track_id = ? AND tag_id = ?`).run(t, parts.tagId).changes > 0) {
			tracksTouched.add(t);
		}
	}

	const memberUpdate = raw.prepare(`UPDATE playlist_track SET playlist_id = ?, track_id = ?, order_key = ? WHERE id = ?`);
	const memberInsert = raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, source_track_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
	const memberRow = raw.prepare(`SELECT playlist_id, track_id, order_key FROM playlist_track WHERE id = ?`);
	const playlistSource = raw.prepare(`SELECT source FROM playlist WHERE id = ?`);
	const providerTrackId = raw.prepare(`SELECT source_track_id FROM source_link WHERE track_id = ? AND source = ? LIMIT 1`);
	// Inserts park on distinct negative positions (the unique (playlist,
	// position) index), recomputePositions then restamps 0..n-1. Its own
	// parking spots are -1..-n, so these start well below.
	let parked = -1_000_000;
	for (const id of ids('playlist_track')) {
		const rec = store.ensure('playlistTracks', id) as PlaylistTrackRecord | undefined;
		store.ensureTombstone(tombstoneKey('playlist_track', id));
		if (rec?.playlistId) {
			store.ensure('playlists', rec.playlistId);
			store.ensureTombstone(tombstoneKey('playlist', rec.playlistId));
		}
		const cur = memberRow.get(id) as { playlist_id: string; track_id: string; order_key: string } | undefined;
		const t = rec ? trackFor(rec.recordingId) : null;
		const alive = playlistTrackAlive(state, id) && t !== null && exists('playlist', rec!.playlistId!);
		if (alive) {
			const pid = rec!.playlistId!;
			const key = rec!.orderKey!.value;
			if (cur) {
				if (cur.playlist_id !== pid || cur.track_id !== t || cur.order_key !== key) {
					memberUpdate.run(pid, t, key, id);
					playlistsTouched.add(cur.playlist_id);
					playlistsTouched.add(pid);
					tracksTouched.add(cur.track_id);
				}
			} else {
				const src = (playlistSource.get(pid) as { source: string } | undefined)?.source;
				const provider = src === 'spotify' || src === 'tidal'
					? (providerTrackId.get(t, src) as { source_track_id: string } | undefined)?.source_track_id
					: undefined;
				memberInsert.run(id, pid, t, key, parked--, rec!.added!.ts, provider ?? t);
				playlistsTouched.add(pid);
			}
			tracksTouched.add(t!);
		} else if (cur) {
			raw.prepare(`DELETE FROM playlist_track WHERE id = ?`).run(id);
			playlistsTouched.add(cur.playlist_id);
			tracksTouched.add(cur.track_id);
		}
	}

	for (const key of ids('cue')) {
		const rec = store.ensure('cues', key) as CueRecord | undefined;
		store.ensureTombstone(tombstoneKey('cue', key));
		const parts = rec ?? parseCueEntityId(key);
		if (!parts) continue;
		const t = trackFor(parts.recordingId);
		if (!t) continue;
		if (rec && cueAlive(state, key)) {
			const b = rec.cell.value;
			raw.prepare(`INSERT INTO cue (id, track_id, slot, position_sec, length_sec, color, name, kind, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'curator')
				ON CONFLICT(track_id, slot, kind) DO UPDATE SET position_sec = excluded.position_sec, length_sec = excluded.length_sec,
					color = excluded.color, name = excluded.name`)
				.run(randomUUID(), t, rec.slot, b.position_sec, b.length_sec, b.color, b.name, rec.kind);
			tracksTouched.add(t);
		} else if (raw.prepare(`DELETE FROM cue WHERE track_id = ? AND slot = ? AND kind = ?`).run(t, parts.slot, parts.kind).changes > 0) {
			tracksTouched.add(t);
		}
	}

	for (const id of ids('play_event')) {
		const cell = state.playEvents.get(id);
		if (!cell) continue;
		const e = cell.value;
		if (!exists('play_session', e.session_id)) continue;
		if (e.rb_song_history_id && raw.prepare(`SELECT 1 FROM play_event WHERE rb_song_history_id = ? AND id != ?`).get(e.rb_song_history_id, id)) {
			summary.skipped.push({ entity: 'play_event', id, reason: 'rekordbox song history held by another event' });
			continue;
		}
		raw.prepare(`INSERT INTO play_event (id, session_id, track_id, source, played_at, played_ms, duration_ms, max_position_ms, played75,
				ended_reason, context_type, context_id, track_no, rb_song_history_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, track_id = excluded.track_id, source = excluded.source,
				played_at = excluded.played_at, played_ms = excluded.played_ms, duration_ms = excluded.duration_ms,
				max_position_ms = excluded.max_position_ms, played75 = excluded.played75, ended_reason = excluded.ended_reason,
				context_type = excluded.context_type, context_id = excluded.context_id, track_no = excluded.track_no,
				rb_song_history_id = excluded.rb_song_history_id`)
			.run(id, e.session_id, trackFor(e.recording_id), e.source, e.played_at, e.played_ms, e.duration_ms, e.max_position_ms,
				e.played75 === null ? null : e.played75 ? 1 : 0, e.ended_reason, e.context_type, e.context_id, e.track_no, e.rb_song_history_id);
	}

	// ── 5. library_track: rating, state, overrides, deleted_at, rb units ─
	// Only fields the records hold are written: a recording with no rating
	// cell keeps whatever the local row had before the op log existed.
	const trackRows = raw.prepare(`SELECT id, rating, state, overrides, deleted_at, artists FROM track WHERE recording_id = ?`);
	const rbTargets = raw.prepare(`SELECT id FROM track WHERE recording_id = ? AND derived_from_track_id IS NULL`).pluck();
	for (const recId of ids('library_track')) {
		const rec = store.ensure('libraryTracks', recId) as LwwRecord | undefined;
		if (!rec) continue;
		for (const row of trackRows.all(recId) as Array<{ id: string; rating: number | null; state: string; overrides: string | null; deleted_at: number | null; artists: string }>) {
			let rating = row.rating;
			if (rec.fields['rating']) rating = rec.fields['rating'].value as number | null;
			// No state cell: never set anywhere, the row keeps what it has
			// (a new row's default). The change stamp is the op's clock, the
			// same instant on every device.
			const stateCell = rec.fields['state'];
			const state = stateCell ? (stateCell.value as string) : row.state;
			const ov: Record<string, unknown> = { ...parseOverrides(row.overrides) };
			for (const [name, cell] of Object.entries(rec.fields)) {
				if (!name.startsWith('override.')) continue;
				const key = OVERRIDE_KEY_OF[name.slice('override.'.length)];
				if (!key) continue;
				if (cell.value === null) delete ov[key];
				else ov[key] = cell.value;
			}
			const overrides = Object.keys(ov).length > 0 ? JSON.stringify(ov) : null;
			let deletedAt = row.deleted_at;
			if (rec.fields['deleted_at']) {
				const v = rec.fields['deleted_at'].value as number | null;
				deletedAt = v === null ? null : (row.deleted_at ?? v);
			}
			const overridesChanged = JSON.stringify(parseOverrides(overrides)) !== JSON.stringify(parseOverrides(row.overrides));
			if (rating === row.rating && state === row.state && !overridesChanged && deletedAt === row.deleted_at) continue;
			const parsedArtists = (() => { try { return JSON.parse(row.artists) as TrackArtist[]; } catch { return []; } })();
			const effective = (ov as TrackOverrides).artists ?? parsedArtists;
			raw.prepare(`UPDATE track SET rating = ?, overrides = ?, deleted_at = ?, artists_ascii = ?, updated_at = ?,
					state = ?, state_changed_at = CASE WHEN state = ? THEN state_changed_at ELSE ? END,
					membership = CASE WHEN ? IS NOT NULL THEN NULL ELSE membership END
				WHERE id = ?`)
				.run(rating, overrides, deletedAt, asciifyArtists(effective), now, state, state, stateCell?.clock.ts ?? now, deletedAt, row.id);
			if (overridesChanged) {
				syncTrackArtistsByIdRaw(raw, [row.id]);
				syncTrackAlbumsRaw(raw, [row.id]);
			}
			tracksTouched.add(row.id);
		}
		// The rekordbox units, into the rb slot the importer writes. Only the
		// catalogue row, never a derived WAV copy (its slot is copied locally
		// when it is made).
		if (RB_UNITS.some((u) => rec.fields[`rb.${u}`] !== undefined)) {
			for (const id of rbTargets.all(recId) as string[]) if (projectRbUnits(raw, id, rec)) tracksTouched.add(id);
		}
	}

	// ── 6. derived: positions + counts for every playlist touched ────────
	for (const pid of playlistsTouched) {
		if (!exists('playlist', pid)) continue;
		recomputePositions(raw, pid);
		raw.prepare(`UPDATE playlist SET track_count = (SELECT count(*) FROM playlist_track WHERE playlist_id = ?), updated_at = ? WHERE id = ?`).run(pid, now, pid);
	}
	// Mirror the local mutators: a tag or cue edit bumps the track so the
	// rekordbox exporter's incremental sweep carries it.
	const bump = raw.prepare(`UPDATE track SET updated_at = ? WHERE id = ?`);
	for (const t of tracksTouched) bump.run(now, t);

	summary.tracksTouched = [...tracksTouched];
	summary.playlistsTouched = [...playlistsTouched];
	if (summary.skipped.length > 0) plog.warn('apply skipped rows', { count: summary.skipped.length, sample: summary.skipped.slice(0, 5) });
	return summary;
}

// One recording's rb.* cells onto a track's rekordbox slot, as the importer
// would have written them: grid + downbeats as Float32 blobs, phrases as the
// SegmentRecord JSON with intro/outro mirrored onto the track, and the key
// both into the slot and onto track.key_camelot (the importer treats rb's
// key as authoritative there). A null clears the slot's unit; it never
// clears the track's key, which the importer never does either. Writes only
// what differs; a grid in a format this build cannot read is left alone.
// Returns whether anything was written.
function projectRbUnits(raw: Raw, trackId: string, rec: LwwRecord): boolean {
	const cur = readRbSlot(raw, trackId);
	const patch: RbSlotPatch = {};
	let changed = false;

	const grid = rec.fields['rb.grid'];
	if (grid) {
		if (grid.value === null) {
			if (cur?.rb_beatgrid || cur?.rb_downbeats) { patch.beatgrid = null; patch.downbeats = null; }
		} else {
			const g = decodeRbGrid(grid.value as number[]);
			if (g) {
				const beats = float32Buffer(g.beatsSec);
				const downs = float32Buffer(g.downbeatsSec);
				if (!cur?.rb_beatgrid || !cur.rb_beatgrid.equals(beats) || !cur.rb_downbeats || !cur.rb_downbeats.equals(downs)) {
					patch.beatgrid = beats;
					patch.downbeats = downs;
				}
			} else {
				plog.warn('rb grid in an unknown format left alone', { trackId });
			}
		}
	}

	const key = rec.fields['rb.key'];
	if (key) {
		const v = (key.value as string | null) || null;
		if ((cur?.rb_key_camelot ?? null) !== v) patch.keyCamelot = v;
		if (v !== null && raw.prepare(`UPDATE track SET key_camelot = ? WHERE id = ? AND key_camelot IS NOT ?`).run(v, trackId, v).changes > 0) changed = true;
	}

	const segs = rec.fields['rb.segments'];
	if (segs) {
		const v = segs.value as SegmentRecord[] | null;
		const next = v && v.length > 0 ? JSON.stringify(v) : null;
		if (JSON.stringify(rbSegmentsValue(cur)) !== JSON.stringify(next === null ? null : v)) {
			patch.segmentsJson = next;
			if (v && v.length > 0) {
				const { introLengthSec, outroLengthSec } = rbIntroOutro(v);
				raw.prepare(`UPDATE track SET intro_length_sec = ?, outro_length_sec = ? WHERE id = ?`).run(introLengthSec, outroLengthSec, trackId);
			}
		}
	}

	if (Object.keys(patch).length > 0) {
		writeRbSlot(raw, trackId, patch);
		changed = true;
	}
	return changed;
}
