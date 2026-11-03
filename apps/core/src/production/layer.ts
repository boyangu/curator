// ProductionLayer — profiles, pairwise judgments and the learned probe over
// the analyzer's production measurements. CoreService delegates to it.
//
// Reads curator.db directly (better-sqlite3, like mir/library-port.ts): the
// profile needs a whole cohort's measurements in one go, which is a single
// SELECT over track ⋈ track_analysis, parsed once and cached until the
// measured set changes. Audiobox scores come from the mir layer's stored
// vectors — never copied into curator.db, so the two stores stay independent.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { productionFlags } from '@curator/library-logic';
import type { ProductionMeasurements, SegmentRecord } from '@curator/shared/schema';
import { log } from '../log.js';
import { AUDIOBOX_MODEL_KEY } from '../mir/types.js';
import { PRODUCTION_FEATURES, PROBE_FEATURE_KEYS, probeVector } from './features.js';
import { fitProbe, MIN_PAIRS_TO_FIT, scoreRow, type JudgmentRow } from './model.js';
import type {
	ProductionCohort, ProductionDeviation, ProductionModelInfo, ProductionPair, ProductionPairSide,
	ProductionProfile, ProductionStats, ProductionWinner,
} from './types.js';

const plog = log.for('production');
export const PRODUCTION_MODEL_KEY = 'production.model';
const MIN_COHORT = 30;
const ERA_HALF_SPAN = 4;        // years either side of the track's release
const NOTE_MIN_Z = 1.5;         // robust z before a deviation earns an explanation
const PAIR_MAX_LUFS_GAP = 8;    // beyond this the master-volume match can't bring the sides level
const MIN_GENRE_POOL = 6;       // measured tracks a genre needs before pairs are drawn inside it
const DEFAULT_AUDITION_FRACTION = 0.35;

export interface ProductionLayerDeps {
	sqlite: Database.Database;
	audioboxVectors: () => Map<string, Float32Array>;
	audioboxVector: (trackId: string) => number[] | null;
	loadModel: () => ProductionModelInfo | null;
	saveModel: (m: ProductionModelInfo) => void;
}

export interface ProductionLayer {
	profile(trackId: string): ProductionProfile;
	nextPair(opts?: { genre?: string | null; playlistId?: string | null }): ProductionPair | null;
	recordJudgment(aTrackId: string, bTrackId: string, winner: ProductionWinner): ProductionStats;
	stats(): ProductionStats;
	fitModel(): ProductionModelInfo;
	// New measurements after a fit get scored with the stored parameters so
	// the Score column never waits for the next fit.
	scoreTrack(trackId: string): void;
}

interface MeasuredRow {
	id: string;
	genre: string | null;
	year: number | null;
	m: ProductionMeasurements;
}

interface StoredModel extends ProductionModelInfo { mean: number[]; std: number[] }

function percentileOf(values: number[], v: number): number {
	if (values.length === 0) return 50;
	let below = 0, equal = 0;
	for (const x of values) { if (x < v) below++; else if (x === v) equal++; }
	return (100 * (below + equal / 2)) / values.length;
}

// Median / MAD z, with the scale floored at half the standard deviation:
// on a feature where most peers sit on one value (sub correlation ≈ 0.99 on
// every clean master) the MAD collapses and an ordinary outlier reads as
// z -20. Clamped to ±10 — beyond that the number stops meaning anything.
function robustZ(values: number[], v: number): number {
	if (values.length < 3) return 0;
	const s = [...values].sort((a, b) => a - b);
	const med = s[s.length >> 1]!;
	const dev = s.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
	const mad = dev[dev.length >> 1]! * 1.4826;
	const mean = s.reduce((a, b) => a + b, 0) / s.length;
	const std = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
	const scale = Math.max(mad, std / 2, 1e-6);
	return Math.max(-10, Math.min(10, (v - med) / scale));
}

function yearOf(releaseDate: string | null): number | null {
	if (!releaseDate) return null;
	const y = Number.parseInt(releaseDate.slice(0, 4), 10);
	return Number.isFinite(y) && y > 1900 && y < 2200 ? y : null;
}

export function createProductionLayer(deps: ProductionLayerDeps): ProductionLayer {
	const { sqlite } = deps;

	const measuredStmt = sqlite.prepare(`
		SELECT t.id, coalesce(json_extract(t.overrides, '$.genre'), t.genre) AS genre,
			coalesce(json_extract(t.overrides, '$.releaseDate'), t.release_date) AS release_date,
			ta.production_json
		FROM track t JOIN track_analysis ta ON ta.track_id = t.id
		WHERE t.deleted_at IS NULL AND ta.production_json IS NOT NULL
	`);
	const measuredStamp = sqlite.prepare(`
		SELECT count(*) AS n, max(ta.analyzed_at) AS at FROM track t JOIN track_analysis ta ON ta.track_id = t.id
		WHERE t.deleted_at IS NULL AND ta.production_json IS NOT NULL
	`);
	let cache: { stamp: string; rows: MeasuredRow[] } | null = null;
	const measured = (): MeasuredRow[] => {
		const st = measuredStamp.get() as { n: number; at: number | null };
		const stamp = `${st.n}:${st.at ?? 0}`;
		if (cache && cache.stamp === stamp) return cache.rows;
		const rows: MeasuredRow[] = [];
		for (const r of measuredStmt.all() as { id: string; genre: string | null; release_date: string | null; production_json: string }[]) {
			try {
				const m = JSON.parse(r.production_json) as ProductionMeasurements;
				if (m && typeof m === 'object') rows.push({ id: r.id, genre: r.genre, year: yearOf(r.release_date), m });
			} catch { /* a malformed row is not a peer */ }
		}
		cache = { stamp, rows };
		return rows;
	};

	const oneStmt = sqlite.prepare(`
		SELECT t.id, t.title, t.artists, t.overrides, t.duration, coalesce(json_extract(t.overrides, '$.genre'), t.genre) AS genre,
			coalesce(json_extract(t.overrides, '$.releaseDate'), t.release_date) AS release_date,
			ta.production_json, ta.segments_json, ta.rb_segments_json, ta.first_drop_sec, t.prod_score
		FROM track t LEFT JOIN track_analysis ta ON ta.track_id = t.id
		WHERE t.id = ? AND t.deleted_at IS NULL
	`);
	type OneRow = {
		id: string; title: string; artists: string; overrides: string | null; duration: number | null; genre: string | null;
		release_date: string | null; production_json: string | null; segments_json: string | null; rb_segments_json: string | null;
		first_drop_sec: number | null; prod_score: number | null;
	};
	const one = (trackId: string): OneRow | null => (oneStmt.get(trackId) as OneRow | undefined) ?? null;

	const artistsOf = (r: OneRow): string => {
		const names = (raw: string | null | undefined): string[] | null => {
			if (!raw) return null;
			try {
				const v = JSON.parse(raw) as unknown;
				const list = Array.isArray(v) ? v : (v && typeof v === 'object' && Array.isArray((v as { artists?: unknown }).artists)) ? (v as { artists: unknown[] }).artists : null;
				if (!list) return null;
				const out = list.map((a) => (a && typeof a === 'object' ? String((a as { name?: unknown }).name ?? '') : String(a))).filter(Boolean);
				return out.length ? out : null;
			} catch { return null; }
		};
		return (names(r.overrides) ?? names(r.artists) ?? []).join(', ');
	};

	const cohortFor = (self: MeasuredRow | { id: string; genre: string | null; year: number | null }): { cohort: ProductionCohort; peers: MeasuredRow[] } => {
		const all = measured().filter((r) => r.id !== self.id);
		if (self.genre) {
			const genre = self.genre.toLowerCase();
			const sameGenre = all.filter((r) => r.genre?.toLowerCase() === genre);
			if (self.year != null) {
				const from = self.year - ERA_HALF_SPAN, to = self.year + ERA_HALF_SPAN;
				const era = sameGenre.filter((r) => r.year != null && r.year >= from && r.year <= to);
				if (era.length >= MIN_COHORT) return { cohort: { kind: 'genre+era', genre: self.genre, yearFrom: from, yearTo: to, size: era.length }, peers: era };
			}
			if (sameGenre.length >= MIN_COHORT) return { cohort: { kind: 'genre', genre: self.genre, yearFrom: null, yearTo: null, size: sameGenre.length }, peers: sameGenre };
		}
		return { cohort: { kind: 'library', genre: null, yearFrom: null, yearTo: null, size: all.length }, peers: all };
	};

	const scoredStmt = sqlite.prepare(`SELECT prod_score FROM track WHERE deleted_at IS NULL AND prod_score IS NOT NULL`);

	function profile(trackId: string): ProductionProfile {
		const r = one(trackId);
		if (!r) throw new Error(`track ${trackId} not found`);
		let m: ProductionMeasurements | null = null;
		if (r.production_json) { try { m = JSON.parse(r.production_json) as ProductionMeasurements; } catch { m = null; } }
		const abxVec = deps.audioboxVector(trackId);
		const empty: ProductionProfile = {
			trackId, measured: false, measurements: null, cohort: null, flags: [], deviations: [], audiobox: null, learned: null, sections: [],
		};
		if (!m) {
			if (abxVec && abxVec.length >= 4) empty.audiobox = { ce: abxVec[0]!, cu: abxVec[1]!, pc: abxVec[2]!, pq: abxVec[3]!, pqPercentile: null };
			return empty;
		}
		const self = { id: r.id, genre: r.genre, year: yearOf(r.release_date), m };
		const { cohort, peers } = cohortFor(self);
		const deviations: ProductionDeviation[] = [];
		for (const f of PRODUCTION_FEATURES) {
			const v = f.get(m);
			if (v == null) continue;
			const vals = peers.map((p) => f.get(p.m)).filter((x): x is number => x != null);
			const z = robustZ(vals, v);
			const direction: 'high' | 'low' = z >= 0 ? 'high' : 'low';
			const defect = f.defect === 'either' || f.defect === direction;
			const note = defect && Math.abs(z) >= NOTE_MIN_Z && vals.length >= MIN_COHORT
				? (direction === 'high' ? f.noteHigh : f.noteLow) ?? null
				: null;
			deviations.push({ key: f.key, label: f.label, unit: f.unit, value: v, percentile: percentileOf(vals, v), z, direction, note });
		}
		deviations.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

		let audiobox: ProductionProfile['audiobox'] = null;
		if (abxVec && abxVec.length >= 4) {
			const all = deps.audioboxVectors();
			const peerPq = peers.map((p) => all.get(p.id)?.[3]).filter((x): x is number => x != null && Number.isFinite(x));
			audiobox = { ce: abxVec[0]!, cu: abxVec[1]!, pc: abxVec[2]!, pq: abxVec[3]!, pqPercentile: peerPq.length >= MIN_COHORT ? percentileOf(peerPq, abxVec[3]!) : null };
		}
		let learned: ProductionProfile['learned'] = null;
		if (r.prod_score != null) {
			const all = (scoredStmt.all() as { prod_score: number }[]).map((x) => x.prod_score);
			learned = { score: r.prod_score, percentile: all.length >= 10 ? percentileOf(all, r.prod_score) : null };
		}
		return {
			trackId, measured: true, measurements: m, cohort,
			flags: productionFlags({
				prodCutoffHz: m.cutoff_hz, prodCutoffDepthDb: m.cutoff_depth_db, prodClipPct: m.clip_pct, prodSubCorr: m.sub_corr,
				prodPlr: m.plr, prodLufs: m.lufs_i, prodTruePeak: m.true_peak_dbtp, phaseCorr: m.phase_corr, stereoSource: m.stereo_source,
			}),
			deviations, audiobox, learned, sections: m.sections ?? [],
		};
	}

	// ── Pairs ──

	const playableStmt = sqlite.prepare(`
		SELECT t.id FROM track t JOIN track_analysis ta ON ta.track_id = t.id
		WHERE t.deleted_at IS NULL AND t.derived_from_track_id IS NULL AND ta.production_json IS NOT NULL
			AND EXISTS (SELECT 1 FROM source_link sl WHERE sl.track_id = t.id AND sl.source = 'local' AND sl.file_path IS NOT NULL AND sl.missing_at IS NULL)
	`);
	const judgedCountStmt = sqlite.prepare(`
		SELECT track_id, count(*) AS n FROM (
			SELECT a_track_id AS track_id FROM production_judgment UNION ALL SELECT b_track_id FROM production_judgment
		) GROUP BY track_id
	`);
	const pairedWithStmt = sqlite.prepare(`
		SELECT CASE WHEN a_track_id = ? THEN b_track_id ELSE a_track_id END AS other FROM production_judgment WHERE a_track_id = ? OR b_track_id = ?
	`);

	const auditionStart = (r: OneRow, m: ProductionMeasurements): number => {
		const drop = m.sections?.find((s) => s.label === 'drop');
		if (drop) return drop.startSec;
		for (const raw of [r.segments_json, r.rb_segments_json]) {
			if (!raw) continue;
			try {
				const segs = JSON.parse(raw) as SegmentRecord[];
				const d = segs.find((s) => s.label === 'drop');
				if (d) return d.startSec;
			} catch { /* fall through */ }
		}
		if (r.first_drop_sec != null) return r.first_drop_sec;
		return (r.duration ?? m.duration_sec ?? 0) * DEFAULT_AUDITION_FRACTION;
	};

	const side = (id: string): ProductionPairSide | null => {
		const r = one(id);
		if (!r?.production_json) return null;
		let m: ProductionMeasurements;
		try { m = JSON.parse(r.production_json) as ProductionMeasurements; } catch { return null; }
		return { trackId: id, title: r.title, artists: artistsOf(r), genre: r.genre, lufs: m.lufs_i, durationSec: r.duration ?? m.duration_sec ?? null, auditionStartSec: auditionStart(r, m) };
	};

	const playlistMembers = sqlite.prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = ?`);

	function nextPair(opts?: { genre?: string | null; playlistId?: string | null }): ProductionPair | null {
		const playable = new Set((playableStmt.all() as { id: string }[]).map((r) => r.id));
		// A playlist scope keeps the pairs inside a set the user chose to
		// compare (a sound-test crate) instead of the whole measured library.
		const members = opts?.playlistId ? new Set((playlistMembers.all(opts.playlistId) as { track_id: string }[]).map((r) => r.track_id)) : null;
		const pool = measured().filter((r) => playable.has(r.id) && (!members || members.has(r.id)));
		if (pool.length < 2) return null;
		const judged = new Map<string, number>();
		for (const r of judgedCountStmt.all() as { track_id: string; n: number }[]) judged.set(r.track_id, r.n);
		const byGenre = new Map<string, MeasuredRow[]>();
		for (const r of pool) {
			const g = r.genre?.toLowerCase();
			if (!g) continue;
			(byGenre.get(g) ?? byGenre.set(g, []).get(g)!).push(r);
		}
		// A is always the least-judged track of the whole pool (random among
		// equals), so coverage spreads over everything measured instead of
		// locking onto whichever genre happens to be the biggest. B comes from
		// A's genre when that genre has enough measured tracks to compare
		// inside, else from the whole pool; a playlist scope is its own cohort.
		const wanted = opts?.genre?.toLowerCase();
		const groupFor = (a: MeasuredRow): { candidates: MeasuredRow[]; cohortGenre: string | null } => {
			if (members) return { candidates: pool, cohortGenre: null };
			const g = (wanted ?? a.genre?.toLowerCase()) ?? null;
			const group = g ? byGenre.get(g) : undefined;
			if (group && group.length >= MIN_GENRE_POOL) return { candidates: group, cohortGenre: group[0]!.genre };
			return { candidates: pool, cohortGenre: null };
		};
		const base = wanted && (byGenre.get(wanted)?.length ?? 0) >= 2 ? byGenre.get(wanted)! : pool;
		// B: an unpaired peer within the loudness gap the volume match can
		// close, random. Tries the ten least-judged A's before giving up.
		const shuffled = [...base].sort(() => Math.random() - 0.5).sort((x, y) => (judged.get(x.id) ?? 0) - (judged.get(y.id) ?? 0));
		for (const a of shuffled.slice(0, 10)) {
			const { candidates, cohortGenre } = groupFor(a);
			const seen = new Set((pairedWithStmt.all(a.id, a.id, a.id) as { other: string }[]).map((r) => r.other));
			const bs = candidates.filter((b) => b.id !== a.id && !seen.has(b.id) && Math.abs(b.m.lufs_i - a.m.lufs_i) <= PAIR_MAX_LUFS_GAP);
			if (bs.length === 0) continue;
			const b = bs[Math.floor(Math.random() * bs.length)]!;
			const sa = side(a.id), sb = side(b.id);
			if (!sa || !sb) continue;
			// Bring both to the quieter side: attenuate the louder one.
			const target = Math.min(sa.lufs, sb.lufs);
			const gain = (lufs: number): number => Math.min(1, Math.pow(10, (target - lufs) / 20));
			// Present in random order so A is not always the least-judged track.
			const flip = Math.random() < 0.5;
			const [x, y] = flip ? [sb, sa] : [sa, sb];
			return { a: x, b: y, cohortGenre, gainA: gain(x.lufs), gainB: gain(y.lufs) };
		}
		return null;
	}

	const insertJudgment = sqlite.prepare(`INSERT INTO production_judgment (id, a_track_id, b_track_id, winner, created_at) VALUES (?, ?, ?, ?, ?)`);
	const judgmentsStmt = sqlite.prepare(`SELECT a_track_id, b_track_id, winner, created_at FROM production_judgment ORDER BY created_at, id`);
	const countsStmt = sqlite.prepare(`SELECT count(*) AS n, sum(winner = 'tie') AS ties, sum(created_at > ?) AS since FROM production_judgment`);
	const judgedTracksStmt = sqlite.prepare(`SELECT count(DISTINCT track_id) AS n FROM (SELECT a_track_id AS track_id FROM production_judgment UNION SELECT b_track_id FROM production_judgment)`);

	function recordJudgment(aTrackId: string, bTrackId: string, winner: ProductionWinner): ProductionStats {
		if (aTrackId === bTrackId) throw new Error('a pair needs two different tracks');
		if (!one(aTrackId) || !one(bTrackId)) throw new Error('unknown track in pair');
		insertJudgment.run(randomUUID(), aTrackId, bTrackId, winner, Date.now());
		return stats();
	}

	function stats(): ProductionStats {
		const model = deps.loadModel();
		const c = countsStmt.get(model?.fittedAt ?? 0) as { n: number; ties: number | null; since: number | null };
		return {
			judgments: c.n, ties: c.ties ?? 0,
			measuredTracks: measured().length,
			playableMeasured: (playableStmt.all() as unknown[]).length,
			judgedTracks: (judgedTracksStmt.get() as { n: number }).n,
			model: model ? { ...model } : null,
			judgmentsSinceFit: model ? (c.since ?? 0) : c.n,
			minPairsToFit: MIN_PAIRS_TO_FIT,
		};
	}

	// ── Probe ──

	const writeScore = sqlite.prepare(`UPDATE track SET prod_score = ? WHERE id = ?`);
	const clearScores = sqlite.prepare(`UPDATE track SET prod_score = NULL WHERE prod_score IS NOT NULL`);

	function fitModel(): ProductionModelInfo {
		const rows = measured();
		const index = new Map(rows.map((r, i) => [r.id, i]));
		const abx = deps.audioboxVectors();
		const vectors = rows.map((r) => probeVector(r.m, abx.get(r.id) ?? null));
		const pairs: JudgmentRow[] = [];
		let ties = 0;
		for (const j of judgmentsStmt.all() as { a_track_id: string; b_track_id: string; winner: ProductionWinner }[]) {
			const a = index.get(j.a_track_id), b = index.get(j.b_track_id);
			if (a == null || b == null) continue; // a side lost its measurements since
			if (j.winner === 'tie') ties++;
			pairs.push({ a, b, y: j.winner === 'a' ? 1 : j.winner === 'b' ? 0 : 0.5 });
		}
		if (pairs.length < MIN_PAIRS_TO_FIT) throw new Error(`Need at least ${MIN_PAIRS_TO_FIT} judgments to fit (have ${pairs.length})`);
		const dim = PROBE_FEATURE_KEYS.length;
		const fit = fitProbe(vectors, pairs, dim);
		const info: StoredModel = {
			version: 1, fittedAt: Date.now(), pairs: pairs.length, ties, features: [...PROBE_FEATURE_KEYS],
			trainAccuracy: fit.trainAccuracy, cvAccuracy: fit.cvAccuracy, scoredTracks: rows.length,
			weights: fit.weights, mean: fit.mean, std: fit.std,
		};
		sqlite.transaction(() => {
			clearScores.run();
			for (let i = 0; i < rows.length; i++) writeScore.run(fit.scores[i]!, rows[i]!.id);
		})();
		deps.saveModel(info);
		plog.info('production probe fitted', { pairs: pairs.length, ties, trainAccuracy: fit.trainAccuracy, cvAccuracy: fit.cvAccuracy, tracks: rows.length });
		const { mean: _m, std: _s, ...pub } = info;
		return pub;
	}

	function scoreTrack(trackId: string): void {
		const model = deps.loadModel() as StoredModel | null;
		if (!model || !Array.isArray(model.mean) || !Array.isArray(model.std)) return;
		const r = one(trackId);
		if (!r?.production_json) return;
		let m: ProductionMeasurements;
		try { m = JSON.parse(r.production_json) as ProductionMeasurements; } catch { return; }
		const v = probeVector(m, deps.audioboxVector(trackId));
		if (v.length !== model.weights.length) return; // feature set changed: wait for a refit
		writeScore.run(scoreRow(v, model.mean, model.std, model.weights), trackId);
	}

	return { profile, nextPair, recordJudgment, stats, fitModel, scoreTrack };
}
