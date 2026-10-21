// What this device holds for one track, read for the catalogue: the file's
// audio hash, whether each unit is present in the Curator slot, and the
// translation between that slot and catalogue items in both directions.
//
// Keying rule (plan "Key and what is shared"): an item belongs to an audio
// hash, and a track speaks for a hash only through its single live local
// link. A track with two live local files is ambiguous (which one was
// analysed?) and takes no part, the same rule the audio_hash backfill uses.
//
// "Never overwrite local": every reader here answers "is it present", and
// the hydrator and pull-before-compute only ever fill what is absent. A row
// stamped with another audio (or unstamped while holding Curator data) is
// untrusted: its values describe something else, so nothing is added to it
// and nothing in it is shared.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
	CATALOGUE_UNIT_SCHEMA,
	DEFAULT_VARIANT,
	catalogueAllows,
	compareVersions,
	parseVersionString,
	type CatalogueItem,
	type CataloguePolicy,
	type CatalogueUnit,
	type StoredCatalogueItem,
	type StructureSegment,
} from '@curator/protocol';
import type { SegmentRecord } from '@curator/shared/schema';
import { MIN_FULL_REANALYSIS_VERSION } from '../analyzer/queue.js';
import type { AnalyzeResult, AnalyzerSegment } from '../analyzer/sidecar.js';
import { stmt } from './stmt.js';

type Raw = Database.Database;

// ── keys ────────────────────────────────────────────────────────────────────

export type UnitKey = { unit: CatalogueUnit; variant: string };
export const keyId = (k: UnitKey): string => `${k.unit}:${k.variant}`;

export type InlineKeyUnit = 'rhythm' | 'key' | 'structure' | 'advanced' | 'fingerprint';
export const INLINE_KEYS: readonly UnitKey[] = (['rhythm', 'key', 'structure', 'advanced', 'fingerprint'] as const)
	.map((unit) => ({ unit, variant: DEFAULT_VARIANT }));
export const PEAKS_LO: UnitKey = { unit: 'peaks', variant: 'lo' };
export const PEAKS_HI: UnitKey = { unit: 'peaks', variant: 'hi' };

// Every key the analyzer side of the catalogue can move. Vectors are the MIR
// layer's (stage D-b) and are not wired here yet, whatever the policy says.
export const ANALYSIS_KEYS: readonly UnitKey[] = [...INLINE_KEYS, PEAKS_LO, PEAKS_HI];

// Which of them this server accepts: the D-a / D-b switch is the server's
// advertised policy, never a desktop constant. `peaks` false = this device
// has no peaks directory (headless), so tiers are out.
export function allowedKeys(policy: CataloguePolicy | null, opts: { peaks: boolean }): UnitKey[] {
	if (!policy) return [];
	return ANALYSIS_KEYS.filter((k) => (k.unit !== 'peaks' || opts.peaks) && catalogueAllows(policy, k.unit, k.variant));
}

// The oldest analysis a reader accepts per unit, next to the analyzer's own
// re-analysis floor: what is older than MIN_FULL_REANALYSIS_VERSION would be
// recomputed here anyway, and the fingerprint stage only exists from 2.4.0.
export const FINGERPRINT_MIN_VERSION = '2.4.0';
const BASE_FLOOR = parseVersionString(MIN_FULL_REANALYSIS_VERSION)!;
const FP_FLOOR = parseVersionString(FINGERPRINT_MIN_VERSION)!;
export function unitFloor(unit: CatalogueUnit): number[] {
	return unit === 'fingerprint' ? FP_FLOOR : BASE_FLOOR;
}

export function acceptable(item: { unit: CatalogueUnit; version: number[]; unitSchema: number }): boolean {
	return compareVersions(item.version, unitFloor(item.unit)) >= 0 && item.unitSchema <= CATALOGUE_UNIT_SCHEMA[item.unit];
}

// ── local state ─────────────────────────────────────────────────────────────

export type Presence = Record<InlineKeyUnit, boolean>;

export type LocalTrack = {
	trackId: string;
	// The single live local link (null: none, or more than one).
	path: string | null;
	hash: string | null;
	// A row with no file here (a remote row, a streaming-only row) whose
	// hash is its recording's audio-hash claim, not a link's
	// (readFilelessTracksByHash). Hydrate-only: it never uploads, never takes
	// a fingerprint (that belongs to a file) and is never analysed.
	fileless?: boolean;
	fingerprint: string | null;
	fingerprintDurationSec: number | null;
	// Decoded duration when analysed, else what the tags/parser said.
	duration: number | null;
	row: {
		audioHash: string | null;
		version: string;
		duration: number | null;
		// Brightness without power: a pre-2.3.0 brightness on the old
		// centroid scale under a newer stamp (re-analysed without the
		// advanced stage). Never shared.
		advancedLegacy: boolean;
	} | null;
	has: Presence;
};

type PresenceRow = {
	track_id: string;
	track_duration: number | null;
	n_links: number;
	file_path: string | null;
	link_hash: string | null;
	fingerprint: string | null;
	fingerprint_duration_sec: number | null;
	duration_local: number | null;
	ta_track: string | null;
	ta_hash: string | null;
	analyzer_version: string | null;
	ta_duration: number | null;
	has_rhythm: number;
	has_key: number;
	has_structure: number;
	has_advanced: number;
	advanced_legacy: number;
};

// Presence as SQL so a batch read moves no grid or feature blob.
const PRESENCE_SELECT = `
	SELECT t.id AS track_id, t.duration AS track_duration,
		(SELECT count(*) FROM source_link s WHERE s.track_id = t.id AND s.source = 'local' AND s.missing_at IS NULL) AS n_links,
		sl.file_path, sl.audio_hash AS link_hash, sl.fingerprint, sl.fingerprint_duration_sec, sl.duration_local,
		ta.track_id AS ta_track, ta.audio_hash AS ta_hash, ta.analyzer_version, ta.duration AS ta_duration,
		(ta.bpm IS NOT NULL AND ta.beatgrid IS NOT NULL AND length(ta.beatgrid) > 0) AS has_rhythm,
		(ta.key_camelot IS NOT NULL) AS has_key,
		(ta.segments_json IS NOT NULL AND ta.segments_json NOT IN ('null')
			AND (ta.drop_count IS NOT NULL OR ta.segments_json NOT IN ('[]'))) AS has_structure,
		(ta.brightness IS NOT NULL OR ta.power IS NOT NULL OR ta.dynamic_complexity IS NOT NULL
			OR ta.loudness_range_lu IS NOT NULL OR ta.dissonance IS NOT NULL OR ta.density IS NOT NULL
			OR (ta.features_json IS NOT NULL AND ta.features_json NOT IN ('{}', 'null'))) AS has_advanced,
		(ta.brightness IS NOT NULL AND ta.power IS NULL) AS advanced_legacy
	FROM track t
	LEFT JOIN source_link sl ON sl.track_id = t.id AND sl.source = 'local' AND sl.missing_at IS NULL
	LEFT JOIN track_analysis ta ON ta.track_id = t.id
	WHERE t.deleted_at IS NULL`;

function toLocal(r: PresenceRow): LocalTrack {
	const single = r.n_links === 1;
	const row = r.ta_track
		? { audioHash: r.ta_hash, version: r.analyzer_version ?? '', duration: r.ta_duration, advancedLegacy: r.advanced_legacy === 1 }
		: null;
	return {
		trackId: r.track_id,
		path: single ? r.file_path : null,
		hash: single ? r.link_hash : null,
		fingerprint: single ? r.fingerprint : null,
		fingerprintDurationSec: single ? r.fingerprint_duration_sec : null,
		duration: r.ta_duration ?? r.duration_local ?? r.track_duration,
		row,
		has: {
			rhythm: r.has_rhythm === 1,
			key: r.has_key === 1,
			structure: r.has_structure === 1,
			advanced: r.has_advanced === 1,
			fingerprint: single && r.fingerprint != null,
		},
	};
}

// A track with several live links appears once per link in the join; any
// copy says "ambiguous" through n_links, so the first one stands for all.
function collect(rows: PresenceRow[]): LocalTrack[] {
	const seen = new Map<string, LocalTrack>();
	for (const r of rows) if (!seen.has(r.track_id)) seen.set(r.track_id, toLocal(r));
	return [...seen.values()];
}

const IN_CHUNK = 500;

export function readLocalTracks(raw: Raw, trackIds: readonly string[]): LocalTrack[] {
	const out: LocalTrack[] = [];
	for (let i = 0; i < trackIds.length; i += IN_CHUNK) {
		const ids = trackIds.slice(i, i + IN_CHUNK);
		const rows = raw.prepare(`${PRESENCE_SELECT} AND t.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as PresenceRow[];
		out.push(...collect(rows));
	}
	return out;
}

export function readLocalTrack(raw: Raw, trackId: string): LocalTrack | null {
	return collect(stmt(raw, `${PRESENCE_SELECT} AND t.id = ?`).all(trackId) as PresenceRow[])[0] ?? null;
}

// Live tracks whose single live link carries one of these hashes.
export function readLocalTracksByHash(raw: Raw, hashes: readonly string[]): Map<string, LocalTrack[]> {
	const byHash = new Map<string, LocalTrack[]>();
	if (hashes.length === 0) return byHash;
	const ids = raw.prepare(`SELECT DISTINCT sl.track_id AS id FROM source_link sl
		WHERE sl.source = 'local' AND sl.missing_at IS NULL AND sl.audio_hash IN (${hashes.map(() => '?').join(',')})`)
		.all(...hashes) as Array<{ id: string }>;
	for (const t of readLocalTracks(raw, ids.map((r) => r.id))) {
		if (!t.hash) continue;
		const list = byHash.get(t.hash);
		if (list) list.push(t);
		else byHash.set(t.hash, [t]);
	}
	return byHash;
}

// ── file-less rows (2026-10-21 audit item 3) ────────────────────────────────
// A device without the file — a fresh second desktop, a streaming-only row —
// still knows which audio the account analysed for a recording: the
// recording's `audio_hash` claims (every device that holds the file states
// one). Exactly one hash names it. Several (a re-encoded or second copy
// merged into the recording) name it only if the master device
// (track-meta.ts masterDevice) claimed exactly one of them — its file is the
// one the account's metadata comes from; otherwise the recording is
// ambiguous and skipped, the same rule a track with two live files follows.

export type ClaimedHash = { hash: string | null; ambiguous: boolean };

export function claimedHashes(raw: Raw, recordingIds: readonly string[], master: string | null): Map<string, ClaimedHash> {
	const out = new Map<string, ClaimedHash>();
	for (let i = 0; i < recordingIds.length; i += IN_CHUNK) {
		const chunk = recordingIds.slice(i, i + IN_CHUNK);
		// `+map`: through the recording index (the claims map is ~100k rows).
		const rows = raw.prepare(`SELECT recording_id AS rec, substr(parent_id, 12) AS hash, json_extract(value, '$.cell.clock.device') AS dev
			FROM sync_state WHERE recording_id IN (${chunk.map(() => '?').join(',')}) AND +map = 'claims'
				AND parent_id >= 'audio_hash:' AND parent_id < 'audio_hash;'`).all(...chunk) as Array<{ rec: string; hash: string; dev: string | null }>;
		const by = new Map<string, Array<{ hash: string; dev: string | null }>>();
		for (const r of rows) { let l = by.get(r.rec); if (!l) by.set(r.rec, (l = [])); l.push(r); }
		for (const [rec, list] of by) {
			const all = new Set(list.map((c) => c.hash));
			if (all.size === 1) { out.set(rec, { hash: [...all][0]!, ambiguous: false }); continue; }
			const mine = new Set(list.filter((c) => master !== null && c.dev === master).map((c) => c.hash));
			out.set(rec, mine.size === 1 ? { hash: [...mine][0]!, ambiguous: false } : { hash: null, ambiguous: true });
		}
	}
	return out;
}

const HAS_LIVE_FILE = `EXISTS (SELECT 1 FROM source_link s WHERE s.track_id = t.id AND s.source = 'local' AND s.missing_at IS NULL)`;

function asFileless(t: LocalTrack, hash: string): LocalTrack {
	return { ...t, path: null, hash, fingerprint: null, fingerprintDurationSec: null, fileless: true, has: { ...t.has, fingerprint: false } };
}

// Live catalogue rows without a live local file whose recording's claimed
// hash is one of `hashes`. `ambiguous`: hashes some recording claims but
// whose rows here cannot take (several hashes and no master pick, or the
// master's pick is another of them) — the caller marks them rather than
// looking again every pass.
export function readFilelessTracksByHash(raw: Raw, hashes: readonly string[], master: string | null): { byHash: Map<string, LocalTrack[]>; ambiguous: Set<string>; ambiguousRecordings: number } {
	const byHash = new Map<string, LocalTrack[]>();
	const ambiguous = new Set<string>();
	if (hashes.length === 0) return { byHash, ambiguous, ambiguousRecordings: 0 };
	const alias = new Map<string, string>();
	const claimants = new Map<string, Set<string>>();
	for (let i = 0; i < hashes.length; i += IN_CHUNK) {
		const chunk = hashes.slice(i, i + IN_CHUNK);
		for (const r of raw.prepare(`SELECT substr(parent_id, 12) AS hash, recording_id AS rec FROM sync_state
			WHERE map = 'claims' AND parent_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk.map((h) => `audio_hash:${h}`)) as Array<{ hash: string; rec: string | null }>) {
			if (!r.rec) continue;
			let s = claimants.get(r.rec);
			if (!s) claimants.set(r.rec, (s = new Set()));
			s.add(r.hash);
		}
	}
	if (claimants.size === 0) return { byHash, ambiguous, ambiguousRecordings: 0 };
	const recs = [...claimants.keys()];
	for (let i = 0; i < recs.length; i += IN_CHUNK) {
		const chunk = recs.slice(i, i + IN_CHUNK);
		for (const r of raw.prepare(`SELECT loser, winner FROM recording_alias WHERE loser IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ loser: string; winner: string }>) alias.set(r.loser, r.winner);
	}
	const live = [...new Set(recs.map((r) => alias.get(r) ?? r))];
	const rowsOf = new Map<string, string[]>();
	for (let i = 0; i < live.length; i += IN_CHUNK) {
		const chunk = live.slice(i, i + IN_CHUNK);
		for (const r of raw.prepare(`SELECT t.id, t.recording_id AS rec FROM track t WHERE t.recording_id IN (${chunk.map(() => '?').join(',')})
			AND t.deleted_at IS NULL AND +t.derived_from_track_id IS NULL AND NOT ${HAS_LIVE_FILE}`).all(...chunk) as Array<{ id: string; rec: string }>) {
			let l = rowsOf.get(r.rec);
			if (!l) rowsOf.set(r.rec, (l = []));
			l.push(r.id);
		}
	}
	if (rowsOf.size === 0) return { byHash, ambiguous, ambiguousRecordings: 0 };
	const resolved = claimedHashes(raw, [...rowsOf.keys()], master);
	const want = new Set(hashes);
	const hashOfTrack = new Map<string, string>();
	let ambiguousRecordings = 0;
	// The requested hashes each (resolved) recording claims.
	const requested = new Map<string, Set<string>>();
	for (const [claimant, hs] of claimants) {
		const rec = alias.get(claimant) ?? claimant;
		let set = requested.get(rec);
		if (!set) requested.set(rec, (set = new Set()));
		for (const h of hs) set.add(h);
	}
	for (const [rec, ids] of rowsOf) {
		const c = resolved.get(rec);
		if (!c) continue;
		if (c.ambiguous || !c.hash) ambiguousRecordings++;
		// Every requested hash of this recording other than the one it takes.
		for (const h of requested.get(rec) ?? []) if (h !== c.hash) ambiguous.add(h);
		if (c.hash && want.has(c.hash)) for (const id of ids) hashOfTrack.set(id, c.hash);
	}
	for (const t of readLocalTracks(raw, [...hashOfTrack.keys()])) {
		const hash = hashOfTrack.get(t.trackId)!;
		const list = byHash.get(hash);
		if (list) list.push(asFileless(t, hash));
		else byHash.set(hash, [asFileless(t, hash)]);
	}
	// A hash one recording serves cleanly is not ambiguous for the pass.
	for (const h of byHash.keys()) ambiguous.delete(h);
	return { byHash, ambiguous, ambiguousRecordings };
}

// One file-less row again, at commit time, under the hash its plan used:
// null once a live file has arrived (the file's own rules take over).
export function readFilelessTrack(raw: Raw, trackId: string, hash: string): LocalTrack | null {
	if (stmt(raw, `SELECT 1 FROM track t WHERE t.id = ? AND ${HAS_LIVE_FILE}`).get(trackId) !== undefined) return null;
	const t = readLocalTrack(raw, trackId);
	return t ? asFileless(t, hash) : null;
}

// The row may be added to, and shared, under the file's hash.
export function trusted(t: LocalTrack): boolean {
	if (!t.hash) return false;
	if (!t.row) return true;
	if (t.row.audioHash === t.hash) return true;
	// Unstamped and empty of Curator data (a rekordbox-only row, a hollow
	// one): nothing in it can disagree with the file.
	return t.row.audioHash === null && !t.has.rhythm && !t.has.key && !t.has.structure && !t.has.advanced;
}

export function peaksPath(peaksDir: string, tier: string, trackId: string): string {
	return join(peaksDir, tier, `${trackId}.cpk`);
}

// Sync stat: used per track inside small batches (≤ 50) only.
export function hasPeaks(peaksDir: string | null, tier: string, trackId: string): boolean {
	return !!peaksDir && existsSync(peaksPath(peaksDir, tier, trackId));
}

export function presentLocally(t: LocalTrack, k: UnitKey, peaksDir: string | null): boolean {
	if (k.unit === 'peaks') return hasPeaks(peaksDir, k.variant, t.trackId);
	if (k.unit === 'vectors') return false;
	return t.has[k.unit];
}

// ±1 s between what the item was computed from and this file.
export const DURATION_TOLERANCE_SEC = 1;
export function durationMatches(t: LocalTrack, durationSec: number): boolean {
	return t.duration != null && Math.abs(t.duration - durationSec) <= DURATION_TOLERANCE_SEC;
}

// ── chromaprint text ───────────────────────────────────────────────────────

// Chromaprint's own base64 is the URL-safe alphabet without padding (what
// Essentia's Chromaprinter returns and source_link.fingerprint holds); the
// protocol's FingerprintData takes standard padded base64. Lossless both
// ways, so the server never sees the difference.
export function chromaprintToStd(fp: string): string {
	const s = fp.replace(/-/g, '+').replace(/_/g, '/');
	return s + '='.repeat((4 - (s.length % 4)) % 4);
}
export function chromaprintFromStd(std: string): string {
	return std.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// ── local → items ───────────────────────────────────────────────────────────

type FullRow = {
	analyzer_version: string;
	duration: number | null;
	bpm: number | null;
	beatgrid: Buffer | null;
	downbeats: Buffer | null;
	key_camelot: string | null;
	key_strength: number | null;
	segments_json: string | null;
	intro_length_sec: number | null;
	outro_length_sec: number | null;
	first_drop_sec: number | null;
	drop_count: number | null;
	breakdown_count: number | null;
	brightness: number | null;
	power: number | null;
	dynamic_complexity: number | null;
	loudness_range_lu: number | null;
	dissonance: number | null;
	density: number | null;
	features_json: string | null;
};

const CAMELOT_RE = /^(?:[1-9]|1[0-2])[AB]$/;
const finiteOrNull = (v: number | null): number | null => (v != null && Number.isFinite(v) ? v : null);
const b64 = (b: Buffer | null): string => (b && b.length > 0 ? b.toString('base64') : '');

function parseJson<T>(text: string | null): T | null {
	if (text == null) return null;
	try { return JSON.parse(text) as T; } catch { return null; }
}

// Inline items for the units in `units` this track holds and may share:
// trusted and stamped (the row must name the file's audio exactly — an
// unstamped row is never shared, even when it would be trusted for a fill),
// a dotted analyzer version (never the 'rekordbox' marker), at or above each
// unit's floor, a decoded duration. Rows only ever carry the analyzer's
// default method (the queue clears the stamp otherwise), and rekordbox data
// lives in rb_* columns this never reads.
export function inlineItemsFor(raw: Raw, t: LocalTrack, units: ReadonlySet<InlineKeyUnit>): CatalogueItem[] {
	if (!t.hash || !t.row || t.row.audioHash !== t.hash) return [];
	const version = parseVersionString(t.row.version);
	if (!version) return [];
	const r = stmt(raw, `SELECT analyzer_version, duration, bpm, beatgrid, downbeats, key_camelot, key_strength, segments_json,
		intro_length_sec, outro_length_sec, first_drop_sec, drop_count, breakdown_count,
		brightness, power, dynamic_complexity, loudness_range_lu, dissonance, density, features_json
		FROM track_analysis WHERE track_id = ?`).get(t.trackId) as FullRow | undefined;
	if (!r || r.duration == null || !(r.duration > 0)) return [];
	const durationSec = r.duration;
	const base = { audioHash: t.hash, version, durationSec, licence: null };
	const out: CatalogueItem[] = [];
	const at = (unit: CatalogueUnit): boolean => compareVersions(version, unitFloor(unit)) >= 0;

	if (units.has('rhythm') && t.has.rhythm && at('rhythm') && r.bpm != null && r.bpm > 0 && r.bpm <= 1000 && r.beatgrid) {
		out.push({ ...base, unit: 'rhythm', variant: 'default', unitSchema: CATALOGUE_UNIT_SCHEMA.rhythm, data: { bpm: r.bpm, beatgrid: b64(r.beatgrid), downbeats: b64(r.downbeats) } });
	}
	if (units.has('key') && t.has.key && at('key') && r.key_camelot && CAMELOT_RE.test(r.key_camelot)) {
		out.push({ ...base, unit: 'key', variant: 'default', unitSchema: CATALOGUE_UNIT_SCHEMA.key, data: { camelot: r.key_camelot, strength: finiteOrNull(r.key_strength) } });
	}
	if (units.has('structure') && t.has.structure && at('structure')) {
		const segs = parseJson<SegmentRecord[]>(r.segments_json);
		// Rekordbox phrases never ride here (they live in rb_segments_json);
		// a stray one makes the unit unshareable rather than half-shared.
		if (segs && segs.every((s) => s.source === undefined || s.source === 'analyzer')) {
			const segments: StructureSegment[] = segs.map((s) => ({
				startSec: s.startSec,
				endSec: s.endSec,
				label: s.label,
				...(s.source ? { source: 'analyzer' as const } : {}),
				...(s.confidence !== undefined ? { confidence: s.confidence } : {}),
				...(s.energy !== undefined ? { energy: s.energy } : {}),
			}));
			out.push({
				...base, unit: 'structure', variant: 'default', unitSchema: CATALOGUE_UNIT_SCHEMA.structure,
				data: {
					segments,
					introLengthSec: finiteOrNull(r.intro_length_sec),
					outroLengthSec: finiteOrNull(r.outro_length_sec),
					firstDropSec: finiteOrNull(r.first_drop_sec),
					dropCount: r.drop_count,
					breakdownCount: r.breakdown_count,
				},
			});
		}
	}
	if (units.has('advanced') && t.has.advanced && !t.row.advancedLegacy && at('advanced')) {
		const features = parseJson<Record<string, unknown>>(r.features_json);
		out.push({
			...base, unit: 'advanced', variant: 'default', unitSchema: CATALOGUE_UNIT_SCHEMA.advanced,
			data: {
				brightness: finiteOrNull(r.brightness),
				power: finiteOrNull(r.power),
				dynamicComplexity: finiteOrNull(r.dynamic_complexity),
				loudnessRangeLu: finiteOrNull(r.loudness_range_lu),
				dissonance: finiteOrNull(r.dissonance),
				density: finiteOrNull(r.density),
				features: features && typeof features === 'object' && !Array.isArray(features) && Object.keys(features).length > 0 ? features : null,
			},
		});
	}
	if (units.has('fingerprint') && t.has.fingerprint && at('fingerprint') && t.fingerprint && t.fingerprintDurationSec != null && t.fingerprintDurationSec >= 1) {
		out.push({
			...base, unit: 'fingerprint', variant: 'default', unitSchema: CATALOGUE_UNIT_SCHEMA.fingerprint,
			data: { chromaprint: chromaprintToStd(t.fingerprint), durationSec: t.fingerprintDurationSec },
		});
	}
	return out;
}

// ── items → a partial AnalyzeResult ─────────────────────────────────────────

function f32(b64text: string): number[] {
	if (!b64text) return [];
	const buf = Buffer.from(b64text, 'base64');
	return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

// The newest of the row's own version and the items', so a fill never
// restamps a row backwards.
export function stampVersion(t: LocalTrack, items: readonly { version: number[] }[]): string {
	let best: number[] | null = t.row ? parseVersionString(t.row.version) : null;
	for (const i of items) if (!best || compareVersions(i.version, best) > 0) best = i.version;
	return (best ?? [0]).join('.');
}

// Pulled units as the analyzer would have returned them, everything else
// "not produced this pass" — so persistAnalysisResult writes exactly these.
export function partialResult(t: LocalTrack, items: readonly StoredCatalogueItem[]): AnalyzeResult {
	const pick = <U extends CatalogueUnit>(unit: U): Extract<StoredCatalogueItem, { unit: U }> | undefined =>
		items.find((i) => i.unit === unit) as Extract<StoredCatalogueItem, { unit: U }> | undefined;
	const rhythm = pick('rhythm')?.data;
	const key = pick('key')?.data;
	const structure = pick('structure')?.data;
	const advanced = pick('advanced')?.data;
	const fp = pick('fingerprint')?.data;
	const duration = items.find((i) => i.unit !== 'peaks')?.durationSec ?? items[0]?.durationSec ?? t.duration ?? 0;
	return {
		track_id: t.trackId,
		duration,
		bpm: rhythm ? rhythm.bpm : null,
		beatgrid: rhythm ? f32(rhythm.beatgrid) : [],
		downbeats: rhythm ? f32(rhythm.downbeats) : [],
		key_camelot: key ? key.camelot : null,
		key_strength: key ? key.strength : null,
		brightness: advanced?.brightness ?? null,
		power: advanced?.power ?? null,
		dynamic_complexity: advanced?.dynamicComplexity ?? null,
		loudness_range_lu: advanced?.loudnessRangeLu ?? null,
		dissonance: advanced?.dissonance ?? null,
		density: advanced?.density ?? null,
		segments: structure ? (structure.segments as unknown as AnalyzerSegment[]) : [],
		intro_length_sec: structure?.introLengthSec ?? null,
		outro_length_sec: structure?.outroLengthSec ?? null,
		first_drop_sec: structure?.firstDropSec ?? null,
		drop_count: structure ? structure.dropCount : null,
		breakdown_count: structure?.breakdownCount ?? null,
		fingerprint: fp ? chromaprintFromStd(fp.chromaprint) : null,
		fingerprint_duration_sec: fp ? fp.durationSec : null,
		features: advanced?.features ?? {},
		peaks_lo_path: '',
		peaks_hi_path: '',
		analyzer_version: stampVersion(t, items),
	};
}
