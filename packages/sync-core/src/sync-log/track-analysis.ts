// The analyzer's results on the op log (protocol v5 `library_track
// .set-analysis`, 2026-10-23). Until v5 a device's analysis reached the
// others only through the shared catalogue, keyed by audio hash and hydrated
// in 50-hash batches after the library had landed: the second profile still
// had ~2,400 tracks waiting 20 minutes after its bootstrap, and a track
// analysed after it was added never reached a secondary at all unless its
// catalogue pass came round. The analysis is now part of the library: the
// master states it like its meta, the snapshot carries it, a pull projects
// it. The catalogue keeps the waveform peaks (blobs, fetched one track at a
// time when the player asks, catalogue/layer.ts) and the cross-account
// reuse of results.
//
// Same machinery as track-attrs.ts: SQLite triggers mark a row dirty
// (migrate.ts track_analysis_dirty_*), the sync client drains the marks in
// time-sized chunks once the server reads v5, `track_analysis_seen` is the
// per-row digest baseline, a one-time backfill queues every own analysed
// row, and the founder's fold runs that backfill into the records.
//
// WHAT A ROW STATES. Its OWN-FILE analysis only: the Curator slot of
// track_analysis (never the rb_* slot — set-rb-analysis carries that) with a
// dotted analyzer version (not the importer's 'rekordbox' placeholder),
// stamped with the audio hash of one of the row's live local files, and not
// adopted from the account (below). That is the one analysis a device can
// vouch for: it decoded that file. A row whose file went missing, whose
// audio changed (the scanner clears the stamp) or whose slot came from
// elsewhere states nothing; a device that stated a recording and no longer
// holds such a row withdraws its cell (`analysis: null`). Per recording the
// device's first such row speaks (live first, then oldest, as track-attrs).
// On a secondary the role gate (role.ts) keeps it to recordings it created
// that the master does not describe; the master states everything.
//
// Never a broken analysis: a brightness without a power (the old raw
// centroid under a newer stamp — 341 tracks on the master, 2026-10-17, by a
// bundle missing its scoring models) goes as null, the catalogue's
// advancedLegacy rule; the protocol refuses it outright.
//
// RECEIVING (projectTrackAnalysis, called from project.ts for every
// recording a pull, a snapshot load or a merge touches). The winner is the
// master's cell, else the latest (protocol state.ts resolveTrackAnalysis).
// It is written onto every catalogue row of the recording that holds no
// own-file analysis (the definition above): a remote row, a streaming-only
// row, a row with a file of the SAME audio this device has not analysed. A
// row with a file of other audio is left to its own analyzer (the master's
// grid would not line up with it). Written as the analyzer would have
// written it — Float32 grid blobs, SegmentRecord JSON, the scalars, the
// stamp (audio_hash, so the catalogue's peaks still trust the row) — plus
// the track mirrors persist.ts keeps (the learned scores, the structure
// scalars) and the tempo / key through the attribute adoption
// (track-attrs.ts, `from: 'analysis'`): a value the row has from its own
// source, or the account's attributes, still wins there. The rb_* slot and
// features_json are never touched.
//
// ADOPTION. A slot written that way records `track_analysis.adopted_digest`
// (the digest of the payload as the row then reads). While the slot still
// reads that digest it is the account's: the drain never states it, the
// projection replaces it when the winner changes and clears it when the
// winner's cell is withdrawn. A local analysis of the file changes the
// digest, and the slot is the row's own from then on.

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
	ANALYSIS_CELL_PREFIX,
	decodeAnalysisSegments,
	decodeRbGrid,
	encodeAnalysisSegments,
	encodeRbGrid,
	fitTrackAnalysis,
	resolveTrackAnalysis,
	round3,
	ZTrackAnalysis,
	type AnalysisSegmentRecord,
	type LwwRecord,
	type TrackAnalysis,
} from '@curator/protocol';
import type { SegmentRecord } from '@curator/shared/schema';
import { log } from '../log.js';
import { decodeFloat32, float32Buffer, rbIntroOutro } from '../rekordbox/rb-slot.js';
import { INITIAL_PUSH_KEY } from './apply.js';
import { getDeviceId } from './device.js';
import { emitOps, type BatchLabel, type EmitOp } from './outbox.js';
import { leftToOthers, sourceRole, type SourceRole } from './role.js';
import { adoptedJson, parseAdopted } from './track-attrs.js';

type Raw = Database.Database;

const alog = log.for('track-analysis');

// One-time: every own analysed row is queued once the server first reads v5
// (and by the founder's fold, which marks it).
export const TRACK_ANALYSIS_BACKFILL_KEY = 'sync.backfill.track_analysis_v5_at';

// ── the payload ─────────────────────────────────────────────────────────────

export type SlotRow = {
	track_id: string;
	analyzer_version: string | null;
	analyzed_at: number | null;
	duration: number | null;
	bpm: number | null;
	key_camelot: string | null;
	key_strength: number | null;
	brightness: number | null;
	power: number | null;
	dynamic_complexity: number | null;
	loudness_range_lu: number | null;
	dissonance: number | null;
	density: number | null;
	intro_length_sec: number | null;
	outro_length_sec: number | null;
	first_drop_sec: number | null;
	drop_count: number | null;
	breakdown_count: number | null;
	beatgrid: Buffer | null;
	downbeats: Buffer | null;
	segments_json: string | null;
	audio_hash: string | null;
	adopted_digest: string | null;
};

const SLOT_COLUMNS = `ta.track_id, ta.analyzer_version, ta.analyzed_at, ta.duration, ta.bpm, ta.key_camelot, ta.key_strength, ta.brightness, ta.power,
	ta.dynamic_complexity, ta.loudness_range_lu, ta.dissonance, ta.density, ta.intro_length_sec, ta.outro_length_sec, ta.first_drop_sec,
	ta.drop_count, ta.breakdown_count, ta.beatgrid, ta.downbeats, ta.segments_json, ta.audio_hash, ta.adopted_digest`;

const DOTTED = /^\d+(\.\d+)*$/;
// A live local file of the row whose audio the slot is stamped with.
const OWN_FILE = `EXISTS (SELECT 1 FROM source_link s WHERE s.track_id = t.id AND s.source = 'local' AND s.missing_at IS NULL AND s.audio_hash = ta.audio_hash)`;

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

function segmentsOf(json: string | null): TrackAnalysis['segments'] {
	if (json === null) return null;
	let v: unknown;
	try { v = JSON.parse(json); } catch { return null; }
	if (!Array.isArray(v)) return null;
	// The analyzer's labelling only; a rekordbox phrase in this slot (none
	// known) makes the structure unstatable rather than half-stated, as the
	// catalogue's structure unit does.
	const segs = v as Array<SegmentRecord | null>;
	if (!segs.every((s) => s && typeof s === 'object' && (s.source === undefined || s.source === 'analyzer'))) return null;
	return encodeAnalysisSegments(segs as AnalysisSegmentRecord[]);
}

// The row's Curator slot as a payload, fitted under the op cap (`dropped`:
// what did not fit), or null when the slot holds nothing statable (no dotted
// version, no stamp, a shape the protocol refuses).
export function analysisOf(row: SlotRow): { analysis: TrackAnalysis; dropped: Array<'segments' | 'grid'> } | null {
	const version = row.analyzer_version;
	if (!version || !DOTTED.test(version) || version.length > 32 || !row.audio_hash) return null;
	const bpm = round3(row.bpm);
	const key = typeof row.key_camelot === 'string' && row.key_camelot.length > 0 && row.key_camelot.length <= 8 ? row.key_camelot : null;
	const power = round3(row.power);
	const duration = round3(row.duration);
	const raw: TrackAnalysis = {
		audio_hash: row.audio_hash,
		analyzer_version: version,
		analyzed_at: typeof row.analyzed_at === 'number' && Number.isFinite(row.analyzed_at) && row.analyzed_at >= 0 ? Math.trunc(row.analyzed_at) : 0,
		duration: duration !== null && duration > 0 ? duration : null,
		bpm: bpm !== null && bpm > 0 && bpm <= 1000 ? bpm : null,
		key_camelot: key,
		key_strength: round3(row.key_strength),
		// advancedLegacy (header).
		brightness: power === null ? null : round3(row.brightness),
		power,
		dynamic_complexity: round3(row.dynamic_complexity),
		loudness_range_lu: round3(row.loudness_range_lu),
		dissonance: round3(row.dissonance),
		density: round3(row.density),
		intro_length_sec: round3(row.intro_length_sec),
		outro_length_sec: round3(row.outro_length_sec),
		first_drop_sec: round3(row.first_drop_sec),
		drop_count: count(row.drop_count),
		breakdown_count: count(row.breakdown_count),
		grid: encodeRbGrid(decodeFloat32(row.beatgrid), decodeFloat32(row.downbeats)),
		segments: segmentsOf(row.segments_json),
	};
	const fit = fitTrackAnalysis(raw);
	if (!ZTrackAnalysis.safeParse(fit.analysis).success) return null;
	return fit;
}

// Key-sorted JSON: a record that went through a snapshot comes back with its
// keys sorted (protocol snapshot.ts canonical), one built here does not, and
// the two must compare and digest alike.
function canonicalJson(v: unknown): string {
	return JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x)
		? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
		: x));
}

// What a slot reads as (adoption), and what a row last stated (baseline).
export function slotDigest(a: TrackAnalysis | null): string {
	return createHash('sha1').update(canonicalJson(a)).digest('hex');
}

function stateDigest(recordingId: string, a: TrackAnalysis | null): string {
	return createHash('sha1').update(recordingId).update('\u0000').update(canonicalJson(a)).digest('hex');
}

// Whether a slot is the account's (adopted) rather than the row's own: it
// still reads the digest the projection recorded.
function readsAdopted(row: SlotRow): boolean {
	if (row.adopted_digest === null) return false;
	return slotDigest(analysisOf(row)?.analysis ?? null) === row.adopted_digest;
}

// ── the drain ───────────────────────────────────────────────────────────────

const CHUNK = 100;
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(',');

export function trackAnalysisDirtyCount(raw: Raw): number {
	return raw.prepare(`SELECT count(*) FROM track_analysis_dirty`).pluck().get() as number;
}

// `kept`: rows the role gate held back although their own analysis is not
// what the master's cell says (differs, or the master states none) — counts
// for the drain's one log line.
export type TrackAnalysisDrain = { rows: number; emitted: number; done: boolean; dropped: number; kept: { rows: number; recordings: number } };

type Candidate = SlotRow & { recording_id: string; own_file: number };

// One chunk of dirty rows, in one transaction: their set-analysis ops, the
// baseline, the marks cleared. Callers check the server feature first
// (features.ts featuresReadV5) — except the founder's fold (`local`), whose
// statements never leave the records. `batchLabel`: as drainTrackMeta's.
export function drainTrackAnalysis(raw: Raw, opts: { max?: number; batchLabel?: BatchLabel; role?: SourceRole; local?: boolean } = {}): TrackAnalysisDrain {
	const max = Math.max(1, opts.max ?? CHUNK);
	return raw.transaction((): TrackAnalysisDrain => {
		const role = opts.role ?? sourceRole(raw);
		if (role.speaks === 'none') return { rows: 0, emitted: 0, done: true, dropped: 0, kept: { rows: 0, recordings: 0 } };
		const ids = raw.prepare(`SELECT track_id FROM track_analysis_dirty LIMIT ?`).pluck().all(max) as string[];
		if (ids.length === 0) return { rows: 0, emitted: 0, done: true, dropped: 0, kept: { rows: 0, recordings: 0 } };
		const recs = [...new Set(raw.prepare(`SELECT recording_id FROM track WHERE id IN (${marks(ids.length)}) AND recording_id IS NOT NULL`).pluck().all(...ids) as string[])];
		const ops: EmitOp[] = [];
		const seen: Array<[string, string, string]> = [];
		let dropped = 0;
		const kept = { rows: 0, recordings: 0 };
		if (recs.length > 0) {
			const aliased = new Set(raw.prepare(`SELECT loser FROM recording_alias WHERE loser IN (${marks(recs.length)})`).pluck().all(...recs) as string[]);
			const others = role.speaks === 'own' ? leftToOthers(raw, role, recs) : new Set<string>();
			const rowsOf = new Map<string, Candidate[]>();
			for (const r of raw.prepare(`SELECT ${SLOT_COLUMNS}, t.recording_id, ${OWN_FILE} AS own_file
				FROM track t JOIN track_analysis ta ON ta.track_id = t.id
				WHERE t.recording_id IN (${marks(recs.length)}) AND t.remote_only = 0 AND +t.derived_from_track_id IS NULL
				ORDER BY t.recording_id, t.deleted_at IS NOT NULL, t.created_at, t.id`).all(...recs) as Candidate[]) {
				let l = rowsOf.get(r.recording_id);
				if (!l) rowsOf.set(r.recording_id, (l = []));
				l.push(r);
			}
			// This device's own cell per recording ('object' = it states one).
			const self = getDeviceId(raw);
			const mine = new Set(raw.prepare(`SELECT key FROM sync_state WHERE map = 'libraryTracks' AND key IN (${marks(recs.length)}) AND json_type(value, ?) = 'object'`)
				.pluck().all(...recs, `$.fields."${ANALYSIS_CELL_PREFIX}${self}".value`) as string[]);
			const allRows = [...rowsOf.values()].flat();
			const seenDigest = new Map<string, string>();
			if (allRows.length > 0) {
				for (const s of raw.prepare(`SELECT track_id, recording_id, digest FROM track_analysis_seen WHERE track_id IN (${marks(allRows.length)})`).all(...allRows.map((r) => r.track_id)) as Array<{ track_id: string; recording_id: string; digest: string }>) {
					seenDigest.set(`${s.track_id}\u0000${s.recording_id}`, s.digest);
				}
			}
			// What the master states of the recordings the gate keeps (one
			// read, only when some are kept): the drain's log compares the
			// device's own analysis against it.
			const gated = role.speaks === 'own' ? recs.filter((r) => others.has(r) && !aliased.has(r)) : [];
			const masterCell = new Map<string, string>();
			if (gated.length > 0 && role.speaks === 'own') {
				for (const m of raw.prepare(`SELECT key, json_extract(value, ?) AS cell FROM sync_state WHERE map = 'libraryTracks' AND key IN (${marks(gated.length)})`)
					.all(`$.fields."${ANALYSIS_CELL_PREFIX}${role.master}".value`, ...gated) as Array<{ key: string; cell: string | null }>) {
					if (typeof m.cell === 'string') masterCell.set(m.key, m.cell);
				}
			}
			for (const rec of gated) {
				let differs = 0;
				const theirs = masterCell.get(rec);
				const theirDigest = theirs === undefined ? null : (() => { try { return slotDigest(JSON.parse(theirs) as TrackAnalysis); } catch { return null; } })();
				for (const row of rowsOf.get(rec) ?? []) {
					if (row.own_file !== 1) continue;
					const a = analysisOf(row);
					if (!a || (row.adopted_digest !== null && slotDigest(a.analysis) === row.adopted_digest)) continue;
					if (theirDigest === null || slotDigest(a.analysis) !== theirDigest) differs++;
				}
				if (differs > 0) { kept.rows += differs; kept.recordings++; }
			}
			for (const rec of recs) {
				if (aliased.has(rec) || others.has(rec)) continue;
				let stated: { row: Candidate; analysis: TrackAnalysis } | null = null;
				for (const row of rowsOf.get(rec) ?? []) {
					if (row.own_file !== 1) continue;
					const a = analysisOf(row);
					if (!a) continue;
					if (row.adopted_digest !== null && slotDigest(a.analysis) === row.adopted_digest) continue;
					if (a.dropped.length > 0) dropped++;
					stated = { row, analysis: a.analysis };
					break;
				}
				if (stated) {
					const digest = stateDigest(rec, stated.analysis);
					if (seenDigest.get(`${stated.row.track_id}\u0000${rec}`) === digest) continue;
					ops.push({ entity: 'library_track', entity_id: rec, kind: 'set-analysis', payload: { analysis: stated.analysis } });
					seen.push([stated.row.track_id, rec, digest]);
				} else if (mine.has(rec)) {
					// Stated before, nothing to vouch for now: withdraw.
					ops.push({ entity: 'library_track', entity_id: rec, kind: 'set-analysis', payload: { analysis: null } });
				}
			}
		}
		if (ops.length > 0) emitOps(raw, ops, { batchLabel: opts.batchLabel, local: opts.local });
		const putSeen = raw.prepare(`INSERT INTO track_analysis_seen (track_id, recording_id, digest, seen_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(track_id) DO UPDATE SET recording_id = excluded.recording_id, digest = excluded.digest, seen_at = excluded.seen_at`);
		const now = Date.now();
		for (const [id, rec, digest] of seen) putSeen.run(id, rec, digest, now);
		raw.prepare(`DELETE FROM track_analysis_dirty WHERE track_id IN (${marks(ids.length)})`).run(...ids);
		return { rows: ids.length, emitted: ops.length, done: ids.length < max, dropped, kept };
	})();
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const SLICE_MS = 40;
const MIN_CHUNK = 20;
export async function drainTrackAnalysisAsync(raw: Raw, opts: { chunk?: number; signal?: { aborted: boolean }; batchLabel?: BatchLabel; role?: SourceRole; local?: boolean } = {}): Promise<{ rows: number; emitted: number; chunks: number; maxSliceMs: number }> {
	const out = { rows: 0, emitted: 0, chunks: 0, maxSliceMs: 0 };
	const fixed = opts.chunk !== undefined;
	let size = Math.max(1, opts.chunk ?? 20);
	let dropped = 0;
	const kept = { rows: 0, recordings: 0 };
	for (;;) {
		if (opts.signal?.aborted) break;
		const t0 = performance.now();
		const r = drainTrackAnalysis(raw, { max: size, batchLabel: opts.batchLabel, role: opts.role, local: opts.local });
		const ms = performance.now() - t0;
		out.maxSliceMs = Math.max(out.maxSliceMs, ms);
		if (!fixed && r.rows > 0) size = Math.max(MIN_CHUNK, Math.min(CHUNK * 5, Math.ceil(size * 1.5), Math.round(r.rows * SLICE_MS / Math.max(ms, 1))));
		dropped += r.dropped;
		kept.rows += r.kept.rows;
		kept.recordings += r.kept.recordings;
		if (r.rows === 0) break;
		out.chunks++;
		out.rows += r.rows;
		out.emitted += r.emitted;
		if (r.done) break;
		await yieldToLoop();
	}
	// Once per drain, not per chunk: a library of long mixes would otherwise
	// say it a hundred times.
	if (dropped > 0) alog.info('analyses too large for one op went without their structure or grid', { count: dropped });
	// The role gate is silent by design (the master speaks for what it
	// describes); this says, in counts, that it held back analyses this
	// device made itself — the trail when a secondary's tempo "will not sync".
	if (kept.rows > 0) alog.info('analysis kept on this device: the master describes these recordings', kept);
	return out;
}

export function trackAnalysisBackfillPending(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(INITIAL_PUSH_KEY) !== undefined
		&& raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(TRACK_ANALYSIS_BACKFILL_KEY) === undefined;
}

export function markTrackAnalysisBackfilled(raw: Raw): void {
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(TRACK_ANALYSIS_BACKFILL_KEY, JSON.stringify(Date.now()), Date.now());
}

// Every own row with an analyzer slot, in pages. Rows the drain finds
// nothing statable in cost one read each.
export async function queueTrackAnalysisBackfillAsync(raw: Raw, opts: { page?: number } = {}): Promise<number> {
	const page = Math.max(1, opts.page ?? 5_000);
	const ids = raw.prepare(`SELECT ta.rowid AS rowid, ta.track_id AS id FROM track_analysis ta JOIN track t ON t.id = ta.track_id
		WHERE ta.rowid > ? AND ta.analyzer_version != 'rekordbox' AND t.remote_only = 0 AND t.derived_from_track_id IS NULL ORDER BY ta.rowid LIMIT ?`);
	const put = raw.prepare(`INSERT OR IGNORE INTO track_analysis_dirty (track_id) VALUES (?)`);
	let queued = 0;
	for (let after = 0; ;) {
		const rows = ids.all(after, page) as Array<{ rowid: number; id: string }>;
		if (rows.length === 0) break;
		raw.transaction(() => { for (const r of rows) put.run(r.id); })();
		queued += rows.length;
		after = rows[rows.length - 1]!.rowid;
		await yieldToLoop();
	}
	markTrackAnalysisBackfilled(raw);
	return queued;
}

// ── the projection ──────────────────────────────────────────────────────────

type ProjectRow = Partial<SlotRow> & {
	id: string;
	ta_track: string | null;
	track_duration: number | null;
	t_bpm: number | null;
	t_key: string | null;
	attrs_adopted: string | null;
	rb_segments_json: string | null;
	has_rb: number;
	has_file: number;
	own_file: number;
	same_audio: number;
	dirty: number;
};

type ProjectStmts = {
	rows: Database.Statement<[string, string], ProjectRow>;
	slot: Database.Statement<[string], SlotRow>;
	upsert: Database.Statement<unknown[]>;
	adopt: Database.Statement<[string | null, string]>;
	toPlaceholder: Database.Statement<[string]>;
	drop: Database.Statement<[string]>;
	unmark: Database.Statement<[string]>;
};
const PSTMTS = new WeakMap<Raw, ProjectStmts>();
function pstmts(raw: Raw): ProjectStmts {
	let s = PSTMTS.get(raw);
	if (!s) {
		const live = `s.track_id = t.id AND s.source = 'local' AND s.missing_at IS NULL`;
		s = {
			rows: raw.prepare(`SELECT t.id, ta.track_id AS ta_track, t.duration AS track_duration, t.bpm AS t_bpm, t.key_camelot AS t_key, t.attrs_adopted,
					${SLOT_COLUMNS.replace('ta.track_id, ', '')}, ta.rb_segments_json,
					(ta.rb_beatgrid IS NOT NULL OR ta.rb_key_camelot IS NOT NULL OR ta.rb_segments_json IS NOT NULL OR ta.rb_bpm IS NOT NULL) AS has_rb,
					EXISTS (SELECT 1 FROM source_link s WHERE ${live}) AS has_file,
					EXISTS (SELECT 1 FROM source_link s WHERE ${live} AND s.audio_hash = ta.audio_hash) AS own_file,
					EXISTS (SELECT 1 FROM source_link s WHERE ${live} AND s.audio_hash = ?) AS same_audio,
					EXISTS (SELECT 1 FROM track_analysis_dirty d WHERE d.track_id = t.id) AS dirty
				FROM track t LEFT JOIN track_analysis ta ON ta.track_id = t.id
				WHERE t.recording_id = ? AND +t.derived_from_track_id IS NULL`),
			slot: raw.prepare(`SELECT ${SLOT_COLUMNS} FROM track_analysis ta WHERE ta.track_id = ?`),
			// The Curator slot only: rb_* and features_json keep what they hold.
			upsert: raw.prepare(`INSERT INTO track_analysis (track_id, bpm, beatgrid, downbeats, key_camelot, key_strength, brightness, power, dynamic_complexity,
					loudness_range_lu, dissonance, density, segments_json, intro_length_sec, outro_length_sec, first_drop_sec, drop_count, breakdown_count,
					duration, analyzer_version, analyzed_at, audio_hash)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(track_id) DO UPDATE SET bpm = excluded.bpm, beatgrid = excluded.beatgrid, downbeats = excluded.downbeats,
					key_camelot = excluded.key_camelot, key_strength = excluded.key_strength, brightness = excluded.brightness, power = excluded.power,
					dynamic_complexity = excluded.dynamic_complexity, loudness_range_lu = excluded.loudness_range_lu, dissonance = excluded.dissonance,
					density = excluded.density, segments_json = excluded.segments_json, intro_length_sec = excluded.intro_length_sec,
					outro_length_sec = excluded.outro_length_sec, first_drop_sec = excluded.first_drop_sec, drop_count = excluded.drop_count,
					breakdown_count = excluded.breakdown_count, duration = excluded.duration, analyzer_version = excluded.analyzer_version,
					analyzed_at = excluded.analyzed_at, audio_hash = excluded.audio_hash`),
			adopt: raw.prepare(`UPDATE track_analysis SET adopted_digest = ? WHERE track_id = ?`),
			// Back to what the rekordbox importer mints: rb data present, no
			// Curator analysis (rb-slot.ts).
			toPlaceholder: raw.prepare(`UPDATE track_analysis SET bpm = NULL, beatgrid = NULL, downbeats = NULL, key_camelot = NULL, key_strength = NULL,
					brightness = NULL, power = NULL, dynamic_complexity = NULL, loudness_range_lu = NULL, dissonance = NULL, density = NULL,
					segments_json = NULL, intro_length_sec = NULL, outro_length_sec = NULL, first_drop_sec = NULL, drop_count = NULL, breakdown_count = NULL,
					analyzer_version = 'rekordbox', audio_hash = NULL, adopted_digest = NULL WHERE track_id = ?`),
			drop: raw.prepare(`DELETE FROM track_analysis WHERE track_id = ?`),
			unmark: raw.prepare(`DELETE FROM track_analysis_dirty WHERE track_id = ?`),
		};
		PSTMTS.set(raw, s);
	}
	return s;
}

const DURATION_TOLERANCE_SEC = 1;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function slotRowOf(row: ProjectRow): SlotRow {
	return { ...(row as SlotRow), track_id: row.id };
}

// The account's tempo / key onto the row through the attribute adoption
// (track-attrs.ts): only into a field that is empty or holds another fill
// (the catalogue's, an earlier analysis); a value from the row's own source
// or from the account's attributes stays. Returns the column patch.
function adoptTempoKey(row: ProjectRow, won: TrackAnalysis | null): Record<string, unknown> {
	const adopted = parseAdopted(row.attrs_adopted);
	const set: Record<string, unknown> = {};
	for (const [field, cur, w] of [['bpm', row.t_bpm, won?.bpm ?? null], ['key_camelot', row.t_key, won?.key_camelot ?? null]] as const) {
		let held = adopted[field];
		// A local writer replaced the adopted value: the field is the row's.
		if (held && !same(held.v, cur)) { delete adopted[field]; held = undefined; }
		if (held?.from === 'account') continue;
		if (!held && cur !== null && cur !== '') continue;
		if (w !== null) {
			if (!same(cur, w)) set[field] = w;
			adopted[field] = { v: w, from: 'analysis' };
		} else if (held?.from === 'analysis') {
			set[field] = null;
			delete adopted[field];
		}
	}
	const next = adoptedJson(adopted);
	if (next !== row.attrs_adopted) set['attrs_adopted'] = next;
	return set;
}

function updateTrack(raw: Raw, id: string, set: Record<string, unknown>): void {
	const cols = Object.keys(set);
	if (cols.length === 0) return;
	raw.prepare(`UPDATE track SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c] as never), id);
}

// One recording's winning analysis onto every catalogue row of it without an
// own-file analysis (header). `master` is the account's master device.
// Returns the rows written.
export function projectTrackAnalysis(raw: Raw, recordingId: string, rec: LwwRecord, master: string | null): string[] {
	// Nothing was ever stated for it: nothing to write, nothing adopted to
	// clear. The common case, and free.
	if (!Object.keys(rec.fields).some((n) => n.startsWith(ANALYSIS_CELL_PREFIX))) return [];
	const s = pstmts(raw);
	const won = resolveTrackAnalysis(rec, master)?.analysis ?? null;
	const wonDigest = won ? slotDigest(won) : null;
	const touched: string[] = [];
	for (const row of s.rows.all(won?.audio_hash ?? '', recordingId)) {
		const hasSlot = row.ta_track !== null;
		const dotted = hasSlot && !!row.analyzer_version && DOTTED.test(row.analyzer_version);
		// Already the winner (the normal re-projection): nothing to do.
		if (hasSlot && wonDigest !== null && row.adopted_digest === wonDigest) continue;
		const adopted = hasSlot && readsAdopted(slotRowOf(row));
		// The row's own analysis of its own file stands.
		if (dotted && row.own_file === 1 && !adopted) continue;
		if (!won) {
			if (!adopted) continue;
			// The winner withdrew: the adopted slot empties, back to the rb
			// placeholder when the rekordbox slot is there.
			if (row.has_rb === 1) s.toPlaceholder.run(row.id);
			else s.drop.run(row.id);
			const rbSegs = (() => { try { return row.rb_segments_json ? (JSON.parse(row.rb_segments_json) as SegmentRecord[]) : null; } catch { return null; } })();
			const io = rbSegs && rbSegs.length > 0 ? rbIntroOutro(rbSegs) : { introLengthSec: null, outroLengthSec: null };
			updateTrack(raw, row.id, {
				brightness: null, power: null, dynamic_complexity: null, loudness_range_lu: null, dissonance: null, density: null,
				intro_length_sec: io.introLengthSec, outro_length_sec: io.outroLengthSec, first_drop_sec: null, drop_count: null, breakdown_count: null,
				...adoptTempoKey(row, null),
			});
			if (row.dirty !== 1) s.unmark.run(row.id);
			touched.push(row.id);
			continue;
		}
		// A file of other audio: this device's analyzer describes it, the
		// master's grid would not line up with it.
		if (row.has_file === 1 && row.same_audio !== 1) continue;
		// A row without the file: the same recording, but guard the duration
		// as the catalogue does (a mis-merge would otherwise take a grid of
		// another edit).
		if (row.has_file !== 1 && row.track_duration !== null && won.duration !== null && Math.abs(row.track_duration - won.duration) > DURATION_TOLERANCE_SEC) continue;
		// Same values under another digest (a slot written before by the
		// same projection, read back differently): only the stamp moves.
		const cur = hasSlot ? analysisOf(slotRowOf(row)) : null;
		if (!(cur && canonicalJson(cur.analysis) === canonicalJson(won))) {
			const grid = won.grid ? decodeRbGrid(won.grid) : null;
			const segs = won.segments ? decodeAnalysisSegments(won.segments) : null;
			s.upsert.run(
				row.id, won.bpm, grid ? float32Buffer(grid.beatsSec) : null, grid ? float32Buffer(grid.downbeatsSec) : null, won.key_camelot, won.key_strength,
				won.brightness, won.power, won.dynamic_complexity, won.loudness_range_lu, won.dissonance, won.density,
				segs ? JSON.stringify(segs) : null, won.intro_length_sec, won.outro_length_sec, won.first_drop_sec, won.drop_count, won.breakdown_count,
				won.duration, won.analyzer_version, won.analyzed_at, won.audio_hash,
			);
		}
		// The digest as the row now reads, so the drain's comparison (and the
		// next projection's) is against exactly what it will compute.
		const back = s.slot.get(row.id);
		s.adopt.run(back ? slotDigest(analysisOf(back)?.analysis ?? null) : null, row.id);
		// The mirrors persist.ts keeps on the track row: the learned scores
		// follow exactly (the account's, nulls included); the structure
		// scalars when the account's structure stage ran (persist's atomic
		// group), so a missing one leaves the rekordbox phrases' intro/outro.
		const structure = won.drop_count !== null || (won.segments?.length ?? 0) > 0;
		updateTrack(raw, row.id, {
			brightness: won.brightness, power: won.power, dynamic_complexity: won.dynamic_complexity, loudness_range_lu: won.loudness_range_lu,
			dissonance: won.dissonance, density: won.density,
			...(structure ? { intro_length_sec: won.intro_length_sec, outro_length_sec: won.outro_length_sec, first_drop_sec: won.first_drop_sec, drop_count: won.drop_count, breakdown_count: won.breakdown_count } : {}),
			...adoptTempoKey(row, won),
		});
		// The triggers marked an own row (a streaming-only one) dirty for a
		// write that is the account's; it has nothing of its own to state
		// unless it was dirty before.
		if (row.dirty !== 1) s.unmark.run(row.id);
		touched.push(row.id);
	}
	return touched;
}
