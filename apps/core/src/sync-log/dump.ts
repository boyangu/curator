// A normalised dump of the library state the op log carries, for comparing
// two databases (replay.test.ts, scripts/replay-check.ts) and a database
// against the protocol reducer's materialised view.
//
// Normalised means: tracks are named by recording_id (track.id is per
// device), playlist rows are listed per playlist in (order_key, id) order,
// overrides are compared as canonical JSON, deletion as a flag (its ms is
// the op's clock on one side and the local stamp on the other), and
// device-local rows are left out on both sides — derived WAV copies and their
// playlist, rekordbox smart playlists, and the soft-deleted loser of a
// recording merge (its recording is an alias; its state lives on the winner).

import type Database from 'better-sqlite3';
import { isAccountSettingKey, type LibraryView } from '@curator/protocol';
import type { RbSlotRow } from '../rekordbox/rb-slot.js';
import { OVERRIDE_KEYS, parseOverrides, rbUnitOp, rbUnitValue, type RbUnit } from './rows.js';

type Raw = Database.Database;

export type LibraryDump = {
	tags: Array<{ id: string; name: string; kind: string; color: string | null }>;
	trackTags: Array<{ recordingId: string; tagId: string }>;
	playlists: Array<{ id: string; name: string; folderId: string | null; source: string; sourceId: string; url: string | null; favourite: boolean }>;
	playlistFolders: Array<{ id: string; name: string; parentFolderId: string | null; source: string; sourceId: string }>;
	playlistTracks: Array<{ id: string; playlistId: string; recordingId: string; orderKey: string }>;
	cues: Array<{ recordingId: string; slot: number; kind: string; positionSec: number; lengthSec: number | null; color: string | null; name: string | null }>;
	pinnedSearches: Array<{ id: string; name: string; query: string; sortColumn: string | null; sortDir: string | null }>;
	tracks: Array<{ recordingId: string; rating: number | null; state: string; overrides: string; deleted: boolean }>;
	// The rekordbox slot in wire form: the grid encoded (rb-grid.ts), phrases
	// as canonical JSON, the key. A unit too large to ride an op is
	// device-local and left out, as the emitter leaves it out.
	rbAnalysis: Array<{ recordingId: string; grid: number[] | null; key: string | null; segments: string | null }>;
	settings: Record<string, unknown>;
};

export const DUMP_TABLES = ['tags', 'trackTags', 'playlists', 'playlistFolders', 'playlistTracks', 'cues', 'pinnedSearches', 'tracks', 'rbAnalysis', 'settings'] as const;

// A row's schema default, and what a view without a state cell means.
const DEFAULT_STATE = 'unsorted';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Overrides as canonical JSON: known fields only, sorted, nulls dropped.
export function canonicalOverrides(v: string | Record<string, unknown> | null): string {
	const o = typeof v === 'string' || v === null ? parseOverrides(v) : v;
	const out: Record<string, unknown> = {};
	for (const k of [...OVERRIDE_KEYS].sort()) {
		const x = (o as Record<string, unknown>)[k];
		if (x !== undefined && x !== null) out[k] = x;
	}
	return JSON.stringify(out);
}

export function dumpLibrary(raw: Raw, opts: { includeSystemTags?: boolean } = {}): LibraryDump {
	const localPlaylist = `(p.is_smart = 1 OR p.derived_from_playlist_id IS NOT NULL)`;
	const liveTrack = `t.derived_from_track_id IS NULL AND t.recording_id NOT IN (SELECT loser FROM recording_alias)`;
	const tags = (raw.prepare(`SELECT id, name, kind, color FROM tag ${opts.includeSystemTags === false ? `WHERE kind != 'system'` : ''} ORDER BY id`).all() as LibraryDump['tags']);
	const trackTags = raw.prepare(`SELECT t.recording_id AS recordingId, tt.tag_id AS tagId FROM track_tag tt JOIN track t ON t.id = tt.track_id
		WHERE ${liveTrack} ORDER BY recordingId, tagId`).all() as LibraryDump['trackTags'];
	const playlists = (raw.prepare(`SELECT p.id, p.name, p.parent_folder_id AS folderId, p.source, p.source_id AS sourceId, p.url, p.is_favorite AS favourite
		FROM playlist p WHERE NOT ${localPlaylist} ORDER BY p.id`).all() as Array<Omit<LibraryDump['playlists'][number], 'favourite'> & { favourite: number }>)
		.map((r) => ({ ...r, favourite: !!r.favourite }));
	const playlistFolders = raw.prepare(`SELECT id, name, parent_folder_id AS parentFolderId, source, source_id AS sourceId FROM playlist_folder ORDER BY id`).all() as LibraryDump['playlistFolders'];
	// Order is (order_key, id); `position` is derived from it and left out,
	// since a device-local row (a WAV copy) in a synced playlist shifts the
	// positions on one side only.
	const playlistTracks = raw.prepare(`SELECT pt.id, pt.playlist_id AS playlistId, t.recording_id AS recordingId, pt.order_key AS orderKey
		FROM playlist_track pt JOIN playlist p ON p.id = pt.playlist_id JOIN track t ON t.id = pt.track_id
		WHERE NOT ${localPlaylist} AND t.derived_from_track_id IS NULL ORDER BY pt.playlist_id, pt.order_key, pt.id`).all() as LibraryDump['playlistTracks'];
	const cues = raw.prepare(`SELECT t.recording_id AS recordingId, c.slot, c.kind, c.position_sec AS positionSec, c.length_sec AS lengthSec, c.color, c.name
		FROM cue c JOIN track t ON t.id = c.track_id WHERE ${liveTrack} AND c.slot >= 0 ORDER BY recordingId, c.kind, c.slot`).all() as LibraryDump['cues'];
	const pinnedSearches = raw.prepare(`SELECT id, name, query, sort_column AS sortColumn, sort_dir AS sortDir FROM pinned_search ORDER BY id`).all() as LibraryDump['pinnedSearches'];
	const tracks = (raw.prepare(`SELECT t.recording_id AS recordingId, t.rating, t.state, t.overrides, t.deleted_at FROM track t WHERE ${liveTrack} ORDER BY recordingId`).all() as Array<{ recordingId: string; rating: number | null; state: string; overrides: string | null; deleted_at: number | null }>)
		.map((r) => ({ recordingId: r.recordingId, rating: r.rating, state: r.state, overrides: canonicalOverrides(r.overrides), deleted: r.deleted_at != null }))
		// Only rows carrying synced state: a pristine catalogue row says nothing.
		.filter((r) => r.rating != null || r.state !== DEFAULT_STATE || r.overrides !== '{}' || r.deleted);
	const rbAnalysis: LibraryDump['rbAnalysis'] = [];
	for (const r of raw.prepare(`SELECT t.recording_id AS recordingId, ta.rb_beatgrid, ta.rb_downbeats, ta.rb_key_camelot, ta.rb_segments_json
		FROM track_analysis ta JOIN track t ON t.id = ta.track_id WHERE ${liveTrack} ORDER BY recordingId`).all() as Array<RbSlotRow & { recordingId: string }>) {
		const unit = (u: RbUnit): unknown => { const v = rbUnitValue(r, u); return v !== null && rbUnitOp(r.recordingId, u, v) ? v : null; };
		const row = rbRow(r.recordingId, unit('grid'), unit('key'), unit('segments'));
		if (row) rbAnalysis.push(row);
	}
	const settings: Record<string, unknown> = {};
	for (const r of raw.prepare(`SELECT key, value FROM app_setting ORDER BY key`).all() as Array<{ key: string; value: string }>) {
		if (isAccountSettingKey(r.key)) settings[r.key] = JSON.parse(r.value);
	}
	return { tags, trackTags, playlists, playlistFolders, playlistTracks, cues, pinnedSearches, tracks, rbAnalysis, settings };
}

function rbRow(recordingId: string, grid: unknown, key: unknown, segments: unknown): LibraryDump['rbAnalysis'][number] | null {
	const segs = Array.isArray(segments) && segments.length > 0 ? JSON.stringify(segments) : null;
	const g = Array.isArray(grid) ? (grid as number[]) : null;
	const k = typeof key === 'string' && key ? key : null;
	return g || k || segs ? { recordingId, grid: g, key: k, segments: segs } : null;
}

// The reducer's materialised view in the same shape.
export function dumpView(view: LibraryView): LibraryDump {
	const OVERRIDE_FIELD_TO_KEY: Record<string, string> = {
		title: 'title', artists: 'artists', album_title: 'albumTitle', label: 'label', genre: 'genre', bpm: 'bpm', key_camelot: 'keyCamelot', release_date: 'releaseDate',
	};
	return {
		tags: view.tags.map((t) => ({ id: t.id, name: t.name ?? '', kind: t.kind ?? '', color: t.color })).sort((a, b) => cmp(a.id, b.id)),
		trackTags: [...view.trackTags].sort((a, b) => cmp(a.recordingId, b.recordingId) || cmp(a.tagId, b.tagId)),
		playlists: view.playlists.map((p) => ({
			id: p.id,
			name: p.name ?? '',
			folderId: p.folderId,
			source: p.sourceLink?.source ?? 'local',
			sourceId: p.sourceLink?.source_id ?? p.id,
			url: p.sourceLink?.url ?? null,
			favourite: p.favourite,
		})).sort((a, b) => cmp(a.id, b.id)),
		playlistFolders: view.playlistFolders.map((f) => ({
			id: f.id, name: f.name ?? '', parentFolderId: f.parentFolderId, source: f.sourceLink?.source ?? 'local', sourceId: f.sourceLink?.source_id ?? f.id,
		})).sort((a, b) => cmp(a.id, b.id)),
		playlistTracks: view.playlistTracks.map((r) => ({ id: r.id, playlistId: r.playlistId, recordingId: r.recordingId, orderKey: r.orderKey })),
		cues: view.cues.map((c) => ({ recordingId: c.recordingId, slot: c.slot, kind: c.kind, positionSec: c.position_sec, lengthSec: c.length_sec, color: c.color, name: c.name }))
			.sort((a, b) => cmp(a.recordingId, b.recordingId) || cmp(a.kind, b.kind) || a.slot - b.slot),
		pinnedSearches: view.pinnedSearches.map((p) => ({ id: p.id, name: p.name ?? '', query: p.query ?? '', sortColumn: p.sortColumn, sortDir: p.sortDir })).sort((a, b) => cmp(a.id, b.id)),
		tracks: view.libraryTracks
			.filter((t) => !(t.recordingId in view.recordingAlias))
			.map((t) => {
				const ov: Record<string, unknown> = {};
				for (const [f, v] of Object.entries(t.overrides)) { const k = OVERRIDE_FIELD_TO_KEY[f]; if (k) ov[k] = v; }
				return { recordingId: t.recordingId, rating: t.rating, state: t.state ?? DEFAULT_STATE, overrides: canonicalOverrides(ov), deleted: t.deletedAt != null };
			})
			.filter((r) => r.rating != null || r.state !== DEFAULT_STATE || r.overrides !== '{}' || r.deleted)
			.sort((a, b) => cmp(a.recordingId, b.recordingId)),
		rbAnalysis: view.libraryTracks
			.filter((t) => !(t.recordingId in view.recordingAlias))
			.map((t) => rbRow(t.recordingId, t.rb['grid'], t.rb['key'], t.rb['segments']))
			.filter((r): r is LibraryDump['rbAnalysis'][number] => r !== null)
			.sort((a, b) => cmp(a.recordingId, b.recordingId)),
		settings: Object.fromEntries(Object.entries(view.settings).filter(([k]) => isAccountSettingKey(k))),
	};
}

export type TableReport = { table: string; left: number; right: number; equal: boolean; onlyLeft: unknown[]; onlyRight: unknown[] };

// Per-table set comparison (order is part of each row where it matters:
// playlist rows carry order_key and position).
export function compareDumps(a: LibraryDump, b: LibraryDump, sample = 5): TableReport[] {
	const out: TableReport[] = [];
	for (const t of DUMP_TABLES) {
		const left = t === 'settings' ? Object.entries(a.settings).map(([k, v]) => ({ k, v })) : (a[t] as unknown[]);
		const right = t === 'settings' ? Object.entries(b.settings).map(([k, v]) => ({ k, v })) : (b[t] as unknown[]);
		const ls = new Set(left.map((x) => JSON.stringify(x)));
		const rs = new Set(right.map((x) => JSON.stringify(x)));
		const onlyLeft = [...ls].filter((x) => !rs.has(x));
		const onlyRight = [...rs].filter((x) => !ls.has(x));
		out.push({
			table: t,
			left: left.length,
			right: right.length,
			equal: onlyLeft.length === 0 && onlyRight.length === 0 && left.length === right.length,
			onlyLeft: onlyLeft.slice(0, sample).map((x) => JSON.parse(x)),
			onlyRight: onlyRight.slice(0, sample).map((x) => JSON.parse(x)),
		});
	}
	return out;
}
