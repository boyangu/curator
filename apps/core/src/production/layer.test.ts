// ProductionLayer over a temp curator.db: profile (flags, cohort, notes),
// pair drawing with loudness gains, judgments, the probe fit and rescoring.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProductionMeasurements } from '@curator/shared/schema';
import { migrate } from '../db/migrate.js';
import { createProductionLayer, type ProductionLayer } from './layer.js';
import type { ProductionModelInfo } from './types.js';

let dir: string;
let sqlite: Database.Database;
let layer: ProductionLayer;
let model: ProductionModelInfo | null;
const abx = new Map<string, Float32Array>();

function measurements(over: Partial<ProductionMeasurements> = {}): ProductionMeasurements {
	return {
		version: 1, stereo_source: true, duration_sec: 360,
		lufs_i: -8, lra: 4, lufs_m_max: -5, true_peak_dbtp: -0.5, plr: 9, clip_pct: 0, dc_offset: 0,
		crest_db: 12, crest_st_p50: 10, noise_floor_db: -70,
		bands_db: { sub: -6, bass: -5, lowmid: -12, mid: -8, himid: -16, high: -20 },
		centroid_hz: 900, tilt_db_oct: -5, cutoff_hz: 22050, cutoff_depth_db: 0,
		phase_corr: 0.95, sub_corr: 0.98, width_db: { low: -30, mid: -12, high: -8 },
		kick_punch_db: 12, sub_under_kick_db: 8,
		sections: [{ label: 'drop', startSec: 60, endSec: 120, lufs: -7, crest_db: 9, sub_corr: 0.98, bands_db: { sub: -6, bass: -5, lowmid: -12, mid: -8, himid: -16, high: -20 }, width_db: { low: -30, mid: -12, high: -8 }, tilt_db_oct: -5 }],
		...over,
	};
}

function addTrack(id: string, genre: string, year: number, m: ProductionMeasurements | null, withFile = true): void {
	const now = Date.now();
	sqlite.prepare(`INSERT INTO track (id, title, artists, genre, release_date, duration, state) VALUES (?, ?, ?, ?, ?, 360, 'unsorted')`)
		.run(id, `Title ${id}`, JSON.stringify([{ name: `Artist ${id}` }]), genre, `${year}-01-01`);
	if (withFile) {
		const f = join(dir, `${id}.flac`);
		writeFileSync(f, 'x');
		sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, fetched_at) VALUES (?, ?, 'local', ?, ?, ?)`).run(`sl-${id}`, id, f, f, now);
	}
	if (m) {
		sqlite.prepare(`INSERT INTO track_analysis (track_id, production_json, prod_lufs, prod_plr, prod_cutoff_hz, prod_sub_corr, prod_clip_pct, analyzer_version, analyzed_at) VALUES (?, ?, ?, ?, ?, ?, ?, '2.5.0', ?)`)
			.run(id, JSON.stringify(m), m.lufs_i, m.plr, m.cutoff_hz, m.sub_corr, m.clip_pct, now);
	}
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-production-'));
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	sqlite = new Database(dbPath);
	model = null;
	abx.clear();
	layer = createProductionLayer({
		sqlite,
		audioboxVectors: () => abx,
		audioboxVector: (id) => (abx.has(id) ? Array.from(abx.get(id)!) : null),
		loadModel: () => model,
		saveModel: (m) => { model = m; },
	});
});
afterEach(() => { sqlite.close(); });

describe('profile', () => {
	it('reports not-measured and flags + cohort notes when measured', () => {
		addTrack('bare', 'Techno', 2022, null);
		expect(layer.profile('bare').measured).toBe(false);

		// 40 clean techno peers in the same era + one offender.
		for (let i = 0; i < 40; i++) addTrack(`p${i}`, 'Techno', 2020 + (i % 5), measurements({ lufs_i: -8 + (i % 7) * 0.3, plr: 9 + (i % 5) * 0.4 }));
		addTrack('bad', 'techno', 2023, measurements({
			plr: 4.5, true_peak_dbtp: 1.2, lufs_i: -3.3, clip_pct: 0.5, cutoff_hz: 16000, cutoff_depth_db: 30, sub_corr: -0.2,
			bands_db: { sub: -6, bass: -5, lowmid: -6, mid: -8, himid: -16, high: -20 },
		}));
		abx.set('bad', Float32Array.from([5, 5, 3, 4.2]));
		for (let i = 0; i < 40; i++) abx.set(`p${i}`, Float32Array.from([6, 6, 3, 7 + (i % 3) * 0.2]));

		const p = layer.profile('bad');
		expect(p.measured).toBe(true);
		expect(p.cohort).toMatchObject({ kind: 'genre+era', genre: 'techno', size: 40 });
		expect(p.flags.map((f) => f.kind).sort()).toEqual(['clipping', 'crushed', 'overs', 'stereo_sub', 'transcode']);
		const notes = p.deviations.filter((d) => d.note);
		expect(notes.map((d) => d.key)).toContain('band_lowmid');
		expect(notes.find((d) => d.key === 'band_lowmid')!.note).toMatch(/mud/i);
		expect(notes.map((d) => d.key)).toContain('plr');
		// Loudness: louder than peers, in the "either" direction.
		expect(notes.find((d) => d.key === 'lufs_i')!.direction).toBe('high');
		expect(p.audiobox!.pq).toBeCloseTo(4.2, 3);
		expect(p.audiobox!.pqPercentile).toBeLessThan(5);
		expect(p.sections).toHaveLength(1);
		expect(p.learned).toBeNull();
	});

	it('falls back from genre+era to genre to library', () => {
		for (let i = 0; i < 35; i++) addTrack(`h${i}`, 'House', 1995 + i, measurements());
		addTrack('x', 'House', 2024, measurements());
		expect(layer.profile('x').cohort!.kind).toBe('genre');
		addTrack('y', 'Dub', 2024, measurements());
		expect(layer.profile('y').cohort!.kind).toBe('library');
	});
});

describe('pairs, judgments and the probe', () => {
	it('draws loudness-matched pairs within a genre, records judgments and fits', () => {
		for (let i = 0; i < 20; i++) addTrack(`t${i}`, 'Techno', 2022, measurements({ lufs_i: -10 + (i % 4), plr: 6 + i * 0.3, kick_punch_db: 6 + i * 0.4 }));
		addTrack('nofile', 'Techno', 2022, measurements(), false);
		const pair = layer.nextPair();
		expect(pair).not.toBeNull();
		expect(pair!.cohortGenre).toBe('Techno');
		expect([pair!.a.trackId, pair!.b.trackId]).not.toContain('nofile');
		expect(Math.abs(pair!.a.lufs - pair!.b.lufs)).toBeLessThanOrEqual(8);
		// The louder side is attenuated to the quieter one; the quieter plays at unity.
		const quieter = pair!.a.lufs <= pair!.b.lufs ? 'a' : 'b';
		expect(quieter === 'a' ? pair!.gainA : pair!.gainB).toBe(1);
		expect(quieter === 'a' ? pair!.gainB : pair!.gainA).toBeLessThanOrEqual(1);
		expect(pair!.a.auditionStartSec).toBe(60); // the drop section
		expect(pair!.a.artists).toBe(`Artist ${pair!.a.trackId}`);

		// Judge 40 pairs: higher PLR wins (what the probe should pick up).
		let n = 0;
		const seen = new Set<string>();
		while (n < 40) {
			const p = layer.nextPair();
			if (!p) break;
			const key = [p.a.trackId, p.b.trackId].sort().join('|');
			expect(seen.has(key)).toBe(false); // never the same pair twice
			seen.add(key);
			const pa = Number(p.a.trackId.slice(1)), pb = Number(p.b.trackId.slice(1));
			layer.recordJudgment(p.a.trackId, p.b.trackId, pa === pb ? 'tie' : pa > pb ? 'a' : 'b');
			n++;
		}
		expect(n).toBe(40);
		const st = layer.stats();
		expect(st.judgments).toBe(40);
		expect(st.model).toBeNull();
		expect(st.judgmentsSinceFit).toBe(40);

		const info = layer.fitModel();
		expect(info.pairs).toBe(40);
		expect(info.trainAccuracy!).toBeGreaterThan(0.8);
		expect(info.scoredTracks).toBe(21);
		const plrIdx = info.features.indexOf('plr');
		expect(info.weights[plrIdx]!).toBeGreaterThan(0);
		const scores = sqlite.prepare(`SELECT id, prod_score FROM track WHERE prod_score IS NOT NULL ORDER BY prod_score DESC`).all() as { id: string; prod_score: number }[];
		expect(scores).toHaveLength(21);
		expect(scores[0]!.id).toBe('t19');
		expect(layer.profile('t19').learned!.percentile).toBeGreaterThan(90);
		expect(layer.stats().judgmentsSinceFit).toBe(0);

		// A new measurement is scored from the stored parameters.
		addTrack('new', 'Techno', 2022, measurements({ plr: 14, kick_punch_db: 16 }));
		layer.scoreTrack('new');
		const fresh = sqlite.prepare(`SELECT prod_score FROM track WHERE id = 'new'`).get() as { prod_score: number };
		expect(fresh.prod_score).toBeGreaterThan(scores[0]!.prod_score);
	});

	it('refuses to fit under the minimum and rejects degenerate pairs', () => {
		addTrack('a', 'Techno', 2022, measurements());
		addTrack('b', 'Techno', 2022, measurements());
		expect(() => layer.recordJudgment('a', 'a', 'a')).toThrow();
		expect(() => layer.recordJudgment('a', 'zzz', 'a')).toThrow();
		layer.recordJudgment('a', 'b', 'tie');
		expect(() => layer.fitModel()).toThrow(/at least/);
	});
});
