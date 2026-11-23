// Local rows → ops. One place that knows how a desktop row reads on the wire,
// shared by the mutators, emitOps' prerequisites (a pre-sync container gets
// its create recorded the first time an op references it) and the D10
// initial push. Every builder returns ops that pass `parseOp`: values the
// schemas would refuse but the local tables tolerate (an empty name, a
// negative cue position from an old import) are coerced here, because a
// refused op throws and rolls the user's write back with it.
//
// Device-local rows yield nothing (cloud decisions 2026-10-17):
//   - derived tracks (derived_from_track_id: the "Convert to WAV" copies) and
//     derived playlists (derived_from_playlist_id: their "[WAV]" playlist);
//   - rekordbox smart playlists (is_smart): the op has no smart flag, and an
//     empty plain playlist on another desktop would be pushed into that
//     machine's rekordbox by its exporter.

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
	CLAIM_KINDS,
	cueEntityId,
	encodeRbGrid,
	MAX_OP_PAYLOAD_BYTES,
	opPayloadBytes,
	trackTagEntityId,
	TRACK_STATES as WIRE_TRACK_STATES,
	type JsonValue,
	type NewOp,
	type PayloadOf,
	type TrackStateValue,
} from '@curator/protocol';
import { TRACK_STATES, type TrackState } from '@curator/shared';
import type { TrackOverrides } from '@curator/shared/schema';
import { decodeFloat32, rbIntroOutro, type RbSlotPatch, type RbSlotRow } from '../rekordbox/rb-slot.js';
import { recordingIdForTrack } from './recording-id.js';

type Raw = Database.Database;

type Stmts = {
	track: Database.Statement<[string], { recording_id: string | null; derived_from_track_id: string | null }>;
	healRecording: Database.Statement<[string, string]>;
	tag: Database.Statement<[string], { name: string; kind: string; color: string | null }>;
	playlist: Database.Statement<[string], PlaylistRow>;
	folder: Database.Statement<[string], FolderRow>;
	pinned: Database.Statement<[string], PinnedRow>;
	member: Database.Statement<[string], { playlist_id: string; track_id: string; order_key: string; added_at: number | null }>;
	trackState: Database.Statement<[string], TrackStateRow>;
	cuesOf: Database.Statement<[string], CueRow>;
	tagsOf: Database.Statement<[string], { tag_id: string; added_at: number }>;
};

type PlaylistRow = {
	name: string;
	source: string;
	source_id: string;
	url: string | null;
	parent_folder_id: string | null;
	is_favorite: number;
	is_smart: number;
	derived_from_playlist_id: string | null;
	created_at: number;
};
type FolderRow = { name: string; source: string; source_id: string; parent_folder_id: string | null; created_at: number };
type PinnedRow = { name: string; query: string; sort_column: string | null; sort_dir: string | null; created_at: number };
export type TrackStateRow = { rating: number | null; state: string; overrides: string | null; deleted_at: number | null };
// `origin` (cue.origin: 'rekordbox' | 'curator') rides only a v4 upsert2.
export type CueRow = { slot: number; kind: 'hot' | 'memory'; position_sec: number; length_sec: number | null; color: string | null; name: string | null; origin?: string | null };

const STMTS = new WeakMap<Raw, Stmts>();

function stmts(raw: Raw): Stmts {
	let s = STMTS.get(raw);
	if (!s) {
		s = {
			track: raw.prepare(`SELECT recording_id, derived_from_track_id FROM track WHERE id = ?`),
			healRecording: raw.prepare(`UPDATE track SET recording_id = ? WHERE id = ? AND recording_id IS NULL`),
			tag: raw.prepare(`SELECT name, kind, color FROM tag WHERE id = ?`),
			playlist: raw.prepare(`SELECT name, source, source_id, url, parent_folder_id, is_favorite, is_smart, derived_from_playlist_id, created_at FROM playlist WHERE id = ?`),
			folder: raw.prepare(`SELECT name, source, source_id, parent_folder_id, created_at FROM playlist_folder WHERE id = ?`),
			pinned: raw.prepare(`SELECT name, query, sort_column, sort_dir, created_at FROM pinned_search WHERE id = ?`),
			member: raw.prepare(`SELECT playlist_id, track_id, order_key, added_at FROM playlist_track WHERE id = ?`),
			trackState: raw.prepare(`SELECT rating, state, overrides, deleted_at FROM track WHERE id = ?`),
			cuesOf: raw.prepare(`SELECT slot, kind, position_sec, length_sec, color, name, origin FROM cue WHERE track_id = ? ORDER BY kind, slot`),
			tagsOf: raw.prepare(`SELECT tag_id, added_at FROM track_tag WHERE track_id = ?`),
		};
		STMTS.set(raw, s);
	}
	return s;
}

// ── identity ────────────────────────────────────────────────────────────────

// The recording a local track row speaks for on the wire, or null when the
// row is device-local (a derived WAV copy) or gone. A row an older writer left
// without a recording id is healed to the deterministic fallback — the same
// value migrate() would give it on the next boot.
export function recordingOf(raw: Raw, trackId: string): string | null {
	const s = stmts(raw);
	const row = s.track.get(trackId);
	if (!row || row.derived_from_track_id) return null;
	if (row.recording_id) return row.recording_id;
	const minted = recordingIdForTrack(trackId);
	s.healRecording.run(minted, trackId);
	return minted;
}

// Batch form with a per-call cache, for the bulk writers. `preload` reads
// those ids in a few IN (...) queries up front instead of one lookup each.
export function recordingResolver(raw: Raw, preload: readonly string[] = []): (trackId: string) => string | null {
	const cache = new Map<string, string | null>();
	for (let i = 0; i < preload.length; i += 400) {
		const chunk = preload.slice(i, i + 400);
		const rows = raw.prepare(`SELECT id, recording_id, derived_from_track_id FROM track WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ id: string; recording_id: string | null; derived_from_track_id: string | null }>;
		for (const r of rows) if (r.recording_id || r.derived_from_track_id) cache.set(r.id, r.derived_from_track_id ? null : r.recording_id);
	}
	return (trackId) => {
		let v = cache.get(trackId);
		if (v === undefined) {
			v = recordingOf(raw, trackId);
			cache.set(trackId, v);
		}
		return v;
	};
}

export function isDeviceLocalPlaylist(raw: Raw, playlistId: string): boolean {
	const row = stmts(raw).playlist.get(playlistId);
	return !row || !!row.is_smart || !!row.derived_from_playlist_id;
}

const nonEmpty = (s: string | null | undefined, fallback: string): string => (s && s.trim() ? s : fallback);

// ── containers ──────────────────────────────────────────────────────────────

export function tagCreateOp(raw: Raw, tagId: string): NewOp | null {
	const row = stmts(raw).tag.get(tagId);
	if (!row) return null;
	return {
		entity: 'tag',
		entity_id: tagId,
		kind: 'create',
		payload: { name: nonEmpty(row.name, 'Untitled'), kind: row.kind === 'system' ? 'system' : 'user', color: row.color ?? null },
	};
}

function playlistSourceLink(row: { source: string; source_id: string; url?: string | null }): PayloadOf<'playlist', 'create'>['source_link'] {
	if (!row.source_id) return null;
	const source = row.source as 'spotify' | 'tidal' | 'rekordbox' | 'local';
	return 'url' in row ? { source, source_id: row.source_id, url: row.url ?? null } : { source, source_id: row.source_id };
}

// The create plus the favourite flag when set: together they are the
// playlist as this device holds it.
export function playlistCreateOps(raw: Raw, playlistId: string): NewOp[] {
	const row = stmts(raw).playlist.get(playlistId);
	if (!row || row.is_smart || row.derived_from_playlist_id) return [];
	const ops: NewOp[] = [{
		entity: 'playlist',
		entity_id: playlistId,
		kind: 'create',
		payload: { name: nonEmpty(row.name, 'Untitled'), folder_id: row.parent_folder_id ?? null, source_link: playlistSourceLink(row) },
	}];
	if (row.is_favorite) ops.push({ entity: 'playlist', entity_id: playlistId, kind: 'set-favourite', payload: { favourite: true } });
	return ops;
}

export function folderCreateOp(raw: Raw, folderId: string): NewOp | null {
	const row = stmts(raw).folder.get(folderId);
	if (!row) return null;
	return {
		entity: 'playlist_folder',
		entity_id: folderId,
		kind: 'create',
		payload: { name: nonEmpty(row.name, 'Untitled'), parent_folder_id: row.parent_folder_id ?? null, source_link: playlistSourceLink({ source: row.source, source_id: row.source_id }) },
	};
}

export function pinnedCreateOp(raw: Raw, id: string): NewOp | null {
	const row = stmts(raw).pinned.get(id);
	if (!row) return null;
	return {
		entity: 'pinned_search',
		entity_id: id,
		kind: 'create',
		payload: {
			name: nonEmpty(row.name, 'Untitled'),
			query: row.query ?? '',
			sort_column: row.sort_column ?? null,
			sort_dir: row.sort_dir === 'asc' || row.sort_dir === 'desc' ? row.sort_dir : null,
		},
	};
}

// The add for an existing membership row, at its current key.
export function memberAddOp(raw: Raw, rowId: string, recording: (trackId: string) => string | null = (t) => recordingOf(raw, t)): NewOp | null {
	const row = stmts(raw).member.get(rowId);
	if (!row) return null;
	const rec = recording(row.track_id);
	if (!rec) return null;
	return { entity: 'playlist_track', entity_id: rowId, kind: 'add', payload: { playlist_id: row.playlist_id, recording_id: rec, order_key: row.order_key } };
}

// ── track state ─────────────────────────────────────────────────────────────

// TrackOverrides key ↔ op field.
export const OVERRIDE_FIELD_OF = {
	title: 'title',
	artists: 'artists',
	albumTitle: 'album_title',
	label: 'label',
	genre: 'genre',
	bpm: 'bpm',
	keyCamelot: 'key_camelot',
	releaseDate: 'release_date',
} as const satisfies Record<keyof TrackOverrides, string>;
export type OverrideKey = keyof typeof OVERRIDE_FIELD_OF;
export const OVERRIDE_KEYS = Object.keys(OVERRIDE_FIELD_OF) as OverrideKey[];
export const OVERRIDE_KEY_OF: Record<string, OverrideKey> = Object.fromEntries(OVERRIDE_KEYS.map((k) => [OVERRIDE_FIELD_OF[k], k]));

export function parseOverrides(json: string | null): TrackOverrides {
	if (!json) return {};
	try {
		const v = JSON.parse(json) as unknown;
		return v && typeof v === 'object' ? (v as TrackOverrides) : {};
	} catch {
		return {};
	}
}

export function readTrackState(raw: Raw, trackId: string): TrackStateRow | null {
	return stmts(raw).trackState.get(trackId) ?? null;
}

// The op value of one override field, or null (cleared) when the stored
// value is missing or not in the wire shape.
function overrideValue(key: OverrideKey, v: unknown): unknown {
	if (v === undefined || v === null) return null;
	switch (key) {
		case 'artists': {
			if (!Array.isArray(v)) return null;
			const list = v
				.filter((a): a is { name: string; role?: unknown } => !!a && typeof (a as { name?: unknown }).name === 'string' && (a as { name: string }).name.length > 0)
				.map((a) => (a.role === 'main' || a.role === 'featured' || a.role === 'remixer' ? { name: a.name, role: a.role } : { name: a.name }));
			return list;
		}
		case 'bpm':
			return typeof v === 'number' && Number.isFinite(v) ? v : null;
		default:
			return typeof v === 'string' ? v : null;
	}
}

export function overrideOp(recordingId: string, key: OverrideKey, value: unknown): NewOp {
	return {
		entity: 'library_track',
		entity_id: recordingId,
		kind: 'set-override',
		payload: { field: OVERRIDE_FIELD_OF[key], value: overrideValue(key, value) } as PayloadOf<'library_track', 'set-override'>,
	};
}

export function ratingOp(recordingId: string, rating: number | null): NewOp {
	const r = rating == null || !Number.isFinite(rating) ? null : Math.max(0, Math.min(5, Math.round(rating)));
	return { entity: 'library_track', entity_id: recordingId, kind: 'set-rating', payload: { rating: r } };
}

// The protocol keeps its own copy of the curation stages (it may import only
// zod); these two lines fail the build if the lists drift apart.
const _wireCoversLocal: readonly TrackStateValue[] = TRACK_STATES;
const _localCoversWire: readonly TrackState[] = WIRE_TRACK_STATES;
void _wireCoversLocal;
void _localCoversWire;

const isTrackState = (v: string): v is TrackStateValue => (WIRE_TRACK_STATES as readonly string[]).includes(v);

// Null for a value the wire refuses (a hand-edited row): nothing is emitted
// rather than rolling the user's write back.
export function stateOp(recordingId: string, state: string): NewOp | null {
	return isTrackState(state) ? { entity: 'library_track', entity_id: recordingId, kind: 'set-state', payload: { state } } : null;
}

export function deletedOp(recordingId: string, deleted: boolean): NewOp {
	return deleted
		? { entity: 'library_track', entity_id: recordingId, kind: 'delete', payload: {} }
		: { entity: 'library_track', entity_id: recordingId, kind: 'undelete', payload: {} };
}

// Ops that move a track's synced fields from `before` to `after`: one per
// changed field. Used by every writer that patches rating / overrides /
// deleted_at, so a writer cannot change one without the other devices
// hearing about it.
export function trackStateDiffOps(recordingId: string, before: TrackStateRow, after: TrackStateRow): NewOp[] {
	const ops: NewOp[] = [];
	if ((before.rating ?? null) !== (after.rating ?? null)) ops.push(ratingOp(recordingId, after.rating));
	if (before.state !== after.state) { const op = stateOp(recordingId, after.state); if (op) ops.push(op); }
	const a = parseOverrides(before.overrides);
	const b = parseOverrides(after.overrides);
	for (const key of OVERRIDE_KEYS) {
		const va = overrideValue(key, a[key]);
		const vb = overrideValue(key, b[key]);
		if (JSON.stringify(va) !== JSON.stringify(vb)) ops.push(overrideOp(recordingId, key, b[key]));
	}
	if ((before.deleted_at == null) !== (after.deleted_at == null)) ops.push(deletedOp(recordingId, after.deleted_at != null));
	return ops;
}

// The track's whole synced state as ops — for the merge re-assert and the
// initial push. Every override field is stated, cleared ones as null, so the
// set wins over whatever the other side of a merge carried; so is the
// state, even the default, for the same reason.
export function trackStateOps(recordingId: string, row: TrackStateRow, opts: { allOverrides: boolean; deleted: boolean }): NewOp[] {
	const ops: NewOp[] = [ratingOp(recordingId, row.rating)];
	const st = stateOp(recordingId, row.state);
	if (st) ops.push(st);
	const ov = parseOverrides(row.overrides);
	for (const key of OVERRIDE_KEYS) {
		if (opts.allOverrides || ov[key] !== undefined) ops.push(overrideOp(recordingId, key, ov[key]));
	}
	if (opts.deleted || row.deleted_at != null) ops.push(deletedOp(recordingId, row.deleted_at != null));
	return ops;
}

// ── cues ────────────────────────────────────────────────────────────────────

export function readCues(raw: Raw, trackId: string): CueRow[] {
	return stmts(raw).cuesOf.all(trackId);
}

// `v4`: the server reads protocol v4 (sync-log/features.ts emitV4) — the cue
// then rides as an upsert2 with its origin, so another device's rekordbox
// import knows a rekordbox cue for one.
export function cueUpsertOp(recordingId: string, c: CueRow, v4 = false): NewOp {
	const pos = Number.isFinite(c.position_sec) ? Math.max(0, c.position_sec) : 0;
	const len = c.length_sec != null && Number.isFinite(c.length_sec) && c.length_sec >= 0 ? c.length_sec : null;
	const body = { slot: c.slot, kind: c.kind, position_sec: pos, length_sec: len, color: c.color ?? null, name: c.name ?? null };
	const entity_id = cueEntityId(recordingId, c.slot, c.kind);
	if (v4) return { entity: 'cue', entity_id, kind: 'upsert2', payload: { ...body, origin: c.origin === 'rekordbox' ? 'rekordbox' : 'curator' } };
	return { entity: 'cue', entity_id, kind: 'upsert', payload: body };
}

export function cueDeleteOp(recordingId: string, slot: number, kind: 'hot' | 'memory'): NewOp {
	return { entity: 'cue', entity_id: cueEntityId(recordingId, slot, kind), kind: 'delete', payload: {} };
}

const cueSlotKey = (c: { slot: number; kind: string }): string => `${c.kind}:${c.slot}`;

// Whole-cue LWW: a changed cue is one upsert, a vanished one one delete.
// Under v4 a change of origin alone (an edit taking a rekordbox cue over) is
// a change too.
export function cueDiffOps(recordingId: string, before: readonly CueRow[], after: readonly CueRow[], v4 = false): NewOp[] {
	const ops: NewOp[] = [];
	const was = new Map(before.filter((c) => c.slot >= 0).map((c) => [cueSlotKey(c), c]));
	const now = new Map(after.filter((c) => c.slot >= 0).map((c) => [cueSlotKey(c), c]));
	for (const [k, c] of now) {
		const p = was.get(k);
		if (!p || p.position_sec !== c.position_sec || (p.length_sec ?? null) !== (c.length_sec ?? null) || (p.color ?? null) !== (c.color ?? null) || (p.name ?? null) !== (c.name ?? null)
			|| (v4 && (p.origin ?? null) !== (c.origin ?? null))) {
			ops.push(cueUpsertOp(recordingId, c, v4));
		}
	}
	for (const [k, c] of was) if (!now.has(k)) ops.push(cueDeleteOp(recordingId, c.slot, c.kind));
	return ops;
}

// ── tags ────────────────────────────────────────────────────────────────────

export function readTrackTags(raw: Raw, trackId: string): Array<{ tag_id: string; added_at: number }> {
	return stmts(raw).tagsOf.all(trackId);
}

export function trackTagOp(recordingId: string, tagId: string, add: boolean): NewOp {
	return { entity: 'track_tag', entity_id: trackTagEntityId(recordingId, tagId), kind: add ? 'add' : 'remove', payload: {} };
}

// ── recording claims ────────────────────────────────────────────────────────
// What a row says identifies its recording (design: `recording_claim`): the
// file's audio hash and Chromaprint, the ISRC, the streaming ids. Shared by
// the scanner/streaming/analyzer mutators and the initial push's backfill.

export type ClaimKind = (typeof CLAIM_KINDS)[number];
export type RecordingClaim = { kind: ClaimKind; value: string; confidence?: number; durationSec?: number };

// Null for an empty value, or one too large to ride an op (a Chromaprint is
// a few KB; the cap is 16 KB, so this is a guard, not a policy).
export function claimOp(recordingId: string, c: RecordingClaim): NewOp | null {
	if (!c.value) return null;
	const op: NewOp = {
		entity: 'recording_claim',
		entity_id: recordingId,
		kind: 'add',
		payload: {
			kind: c.kind,
			value: c.value,
			confidence: c.confidence ?? 1,
			...(c.durationSec !== undefined ? { duration_sec: Math.max(0, Math.round(c.durationSec)) } : {}),
		},
	};
	return opPayloadBytes(op) > MAX_OP_PAYLOAD_BYTES ? null : op;
}

// ── rekordbox analysis units ────────────────────────────────────────────────
// The rb slot (rekordbox/rb-slot.ts) as `set-rb-analysis` ops, one per unit:
// the grid in the protocol's compact form (rb-grid.ts), the phrases as the
// stored SegmentRecord rows, the key as rb's Camelot string. A unit whose op
// would pass MAX_OP_PAYLOAD_BYTES (a recorded mix's grid) yields nothing and
// stays device-local: it cannot ride the log, and rekordbox data is kept out
// of the catalogue by decision.

export type RbUnit = 'grid' | 'key' | 'segments' | 'bpm' | 'key_strength';
// The v3 units: what the importer diffs and every server reads.
export const RB_UNITS: readonly RbUnit[] = ['grid', 'key', 'segments'];
// Since protocol v4 (ops.ts RB_UNIT_SINCE): stated only once the server reads
// v4 (features.ts) — by the v4 backfill and a merge's re-assert.
export const RB_UNITS_V4: readonly RbUnit[] = ['bpm', 'key_strength'];
export function rbUnitsFor(v4: boolean): readonly RbUnit[] {
	return v4 ? [...RB_UNITS, ...RB_UNITS_V4] : RB_UNITS;
}

const rbScalar = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function rbGridValue(row: RbSlotRow | null): number[] | null {
	if (!row?.rb_beatgrid) return null;
	return encodeRbGrid(decodeFloat32(row.rb_beatgrid), decodeFloat32(row.rb_downbeats));
}

// Null for no phrases: an empty list and a missing one are the same unit.
export function rbSegmentsValue(row: RbSlotRow | null): Array<Record<string, JsonValue>> | null {
	if (!row?.rb_segments_json) return null;
	try {
		const v = JSON.parse(row.rb_segments_json) as unknown;
		if (!Array.isArray(v)) return null;
		const segs = v.filter((s): s is Record<string, JsonValue> => !!s && typeof s === 'object' && !Array.isArray(s));
		return segs.length > 0 ? segs : null;
	} catch {
		return null;
	}
}

export function rbUnitValue(row: RbSlotRow | null, unit: RbUnit): unknown {
	switch (unit) {
		case 'grid': return rbGridValue(row);
		case 'key': return row?.rb_key_camelot || null;
		case 'segments': return rbSegmentsValue(row);
		case 'bpm': return rbScalar(row?.rb_bpm);
		case 'key_strength': return rbScalar(row?.rb_key_strength);
	}
}

// The op for one unit, or null when it is too large to ride the log.
export function rbUnitOp(recordingId: string, unit: RbUnit, value: unknown): NewOp | null {
	const op = { entity: 'library_track', entity_id: recordingId, kind: 'set-rb-analysis', payload: { unit, value } } as NewOp;
	return opPayloadBytes(op) > MAX_OP_PAYLOAD_BYTES ? null : op;
}

// Whether two slot rows hold the same unit. The grid compares the stored
// bytes (no encode for the common unchanged case).
export function sameUnit(a: RbSlotRow | null, b: RbSlotRow | null, unit: RbUnit): boolean {
	switch (unit) {
		case 'grid': {
			const eq = (x: Buffer | null | undefined, y: Buffer | null | undefined): boolean => (!x || x.byteLength === 0 ? !y || y.byteLength === 0 : !!y && x.equals(y));
			return eq(a?.rb_beatgrid, b?.rb_beatgrid) && eq(a?.rb_downbeats, b?.rb_downbeats);
		}
		case 'key': return (a?.rb_key_camelot || null) === (b?.rb_key_camelot || null);
		case 'segments': return (a?.rb_segments_json ?? null) === (b?.rb_segments_json ?? null) || JSON.stringify(rbSegmentsValue(a)) === JSON.stringify(rbSegmentsValue(b));
		case 'bpm': return rbScalar(a?.rb_bpm) === rbScalar(b?.rb_bpm);
		case 'key_strength': return rbScalar(a?.rb_key_strength) === rbScalar(b?.rb_key_strength);
	}
}

// A unit's fingerprint for the per-device rekordbox baseline
// (rekordbox_unit_seen): cheap to compute on every import, equal exactly
// when the stored unit is. The grid hashes its stored bytes rather than the
// encoded grid, so an unchanged re-import costs no encode.
export function rbUnitDigest(row: RbSlotRow | null, unit: RbUnit): string {
	const h = createHash('sha1');
	switch (unit) {
		case 'grid':
			h.update(row?.rb_beatgrid ?? Buffer.alloc(0));
			h.update('|');
			h.update(row?.rb_downbeats ?? Buffer.alloc(0));
			return h.digest('hex');
		case 'key':
			return row?.rb_key_camelot || '';
		case 'segments':
			return h.update(JSON.stringify(rbSegmentsValue(row))).digest('hex');
		case 'bpm':
			return String(rbScalar(row?.rb_bpm));
		case 'key_strength':
			return String(rbScalar(row?.rb_key_strength));
	}
}

// The slot patch that puts `row`'s value of one unit back.
export function rbUnitPatch(row: RbSlotRow | null, unit: RbUnit): RbSlotPatch {
	switch (unit) {
		case 'grid': return { beatgrid: row?.rb_beatgrid ?? null, downbeats: row?.rb_downbeats ?? null };
		case 'key': return { keyCamelot: row?.rb_key_camelot || null };
		case 'segments': return { segmentsJson: row?.rb_segments_json ?? null };
		case 'bpm': return { bpm: rbScalar(row?.rb_bpm) };
		case 'key_strength': return { keyStrength: rbScalar(row?.rb_key_strength) };
	}
}

// The track-row mirrors a unit carries (the importer and the projection
// both write them): rb's key onto key_camelot, phrase intro/outro lengths.
export function rbUnitMirrors(raw: Raw, trackId: string, row: RbSlotRow | null, unit: RbUnit): void {
	if (unit === 'key') {
		const v = row?.rb_key_camelot || null;
		if (v !== null) raw.prepare(`UPDATE track SET key_camelot = ? WHERE id = ? AND key_camelot IS NOT ?`).run(v, trackId, v);
	} else if (unit === 'segments') {
		const segs = rbSegmentsValue(row);
		if (segs) {
			const { introLengthSec, outroLengthSec } = rbIntroOutro(segs as unknown as Parameters<typeof rbIntroOutro>[0]);
			raw.prepare(`UPDATE track SET intro_length_sec = ?, outro_length_sec = ? WHERE id = ?`).run(introLengthSec, outroLengthSec, trackId);
		}
	}
}

// One op per unit the write changed. `skipped` counts units too large to
// emit (the caller logs them). `v4`: the server reads protocol v4, so the
// tempo / key-strength units are diffed too (an importer that writes them
// goes through the same baseline as the grid, key and phrases).
export function rbAnalysisDiffOps(recordingId: string, before: RbSlotRow | null, after: RbSlotRow | null, v4 = false): { ops: NewOp[]; skipped: number } {
	const ops: NewOp[] = [];
	let skipped = 0;
	for (const unit of rbUnitsFor(v4)) {
		if (sameUnit(before, after, unit)) continue;
		const op = rbUnitOp(recordingId, unit, rbUnitValue(after, unit));
		if (op) ops.push(op); else skipped++;
	}
	return { ops, skipped };
}
