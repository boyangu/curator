// The 2026-10-17 damage (a bundle without its scoring models: brightness
// kept on the raw-centroid scale, no power, stamped 2.4.0) and its two fixes:
// persist clears such a brightness when a pass ran the advanced stage and
// got no learned scores, instead of preserving it; the one-time repair
// re-analyses the rows already damaged, and marks itself done once none are
// left. Generated temp DB only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createDb, type Db } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { fullResult } from '../test-support/catalogue-fakes.js';
import { MODELS_REPAIR_KEY, modelsRepairCandidates, modelsRepairDone, runModelsRepair } from './models-repair.js';
import { persistAnalysisResult } from './persist.js';
import type { AnalyzeParams } from './sidecar.js';

let dir: string;
let db: Db;
let sqlite: Database.Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-models-repair-'));
	migrate(join(dir, 'curator.db'));
	({ db, sqlite } = createDb(join(dir, 'curator.db')));
});
afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

// A track with a local file (or not) and an analysis row as the broken
// bundle left it.
function seed(id: string, o: { version?: string; brightness: number | null; power: number | null; file?: boolean; deleted?: boolean }): string {
	const path = `/music/${id}.flac`;
	sqlite.prepare(`INSERT INTO track (id, title, artists, state, duration, brightness, power, deleted_at) VALUES (?, ?, '[]', 'unsorted', 30, ?, ?, ?)`)
		.run(id, id, o.brightness, o.power, o.deleted ? 1 : null);
	if (o.file !== false) sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, audio_hash) VALUES (?, ?, 'local', ?, ?, 'h')`).run(`sl-${id}`, id, path, path);
	sqlite.prepare(`INSERT INTO track_analysis (track_id, bpm, brightness, power, analyzer_version, analyzed_at, audio_hash) VALUES (?, 124, ?, ?, ?, 1760000000000, 'h')`)
		.run(id, o.brightness, o.power, o.version ?? '2.4.0');
	return path;
}

const scores = (table: 'track' | 'track_analysis', id: string) =>
	sqlite.prepare(`SELECT brightness, power FROM ${table} WHERE ${table === 'track' ? 'id' : 'track_id'} = ?`).get(id);

// A pass whose advanced stage ran (the Essentia scalars) without the models.
const noModels = (trackId: string) => ({
	...fullResult({ trackId, outPeaksLoPath: '', outPeaksHiPath: '', options: { features: ['brightness'] } } as unknown as AnalyzeParams),
	brightness: null,
	power: null,
});

describe('persist guard: an advanced pass with no learned scores', () => {
	it('clears a brightness that has no power, keeps a real one, and leaves a basic pass alone', () => {
		const broken = seed('broken', { brightness: 812.4, power: null });
		persistAnalysisResult(db, noModels('broken'), broken, { audioHash: 'h' });
		expect(scores('track_analysis', 'broken')).toEqual({ brightness: null, power: null });
		expect(scores('track', 'broken')).toEqual({ brightness: null, power: null });
		// The Essentia scalars of the pass still land.
		expect(sqlite.prepare(`SELECT dynamic_complexity FROM track_analysis WHERE track_id = 'broken'`).pluck().get()).toBe(3.1);

		const good = seed('good', { brightness: 1.25, power: 0.4 });
		persistAnalysisResult(db, noModels('good'), good, { audioHash: 'h' });
		expect(scores('track_analysis', 'good')).toEqual({ brightness: 1.25, power: 0.4 });
		expect(scores('track', 'good')).toEqual({ brightness: 1.25, power: 0.4 });

		// A basic pass (no advanced stage) preserves everything, legacy too:
		// it says nothing about the models.
		const basic = seed('basic', { brightness: 640, power: null });
		persistAnalysisResult(db, fullResult({ trackId: 'basic', outPeaksLoPath: '', outPeaksHiPath: '', options: {} } as unknown as AnalyzeParams), basic, { audioHash: 'h' });
		expect(scores('track_analysis', 'basic')).toEqual({ brightness: 640, power: null });

		// A pass with the models replaces the legacy value with real scores.
		const fixed = seed('fixed', { brightness: 900, power: null });
		persistAnalysisResult(db, fullResult({ trackId: 'fixed', outPeaksLoPath: '', outPeaksHiPath: '', options: { features: ['brightness'] } } as unknown as AnalyzeParams), fixed, { audioHash: 'h' });
		expect(scores('track_analysis', 'fixed')).toEqual({ brightness: 0.42, power: 0.66 });
	});
});

describe('the one-time repair', () => {
	it('enqueues every ≥ 2.3 brightness-without-power row with a file here, until none are left', async () => {
		seed('t1', { brightness: 812.4, power: null });
		seed('t2', { brightness: 248, power: null, version: '2.3.0' });
		seed('old', { brightness: 1500, power: null, version: '2.2.0' });
		seed('ok', { brightness: 1.1, power: 0.3 });
		seed('nofile', { brightness: 700, power: null, file: false });
		seed('gone', { brightness: 700, power: null, deleted: true });
		sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES ('rb', 'rb', '[]', 'unsorted')`).run();
		sqlite.prepare(`INSERT INTO track_analysis (track_id, brightness, analyzer_version, analyzed_at) VALUES ('rb', 5, 'rekordbox', 1)`).run();
		expect(modelsRepairCandidates(sqlite).sort()).toEqual(['t1', 't2']);

		const asked: string[][] = [];
		expect(await runModelsRepair(sqlite, async (ids) => { asked.push([...ids].sort()); })).toBe(2);
		expect(asked).toEqual([['t1', 't2']]);
		// Not done until a launch finds nothing: the queue drops its backlog
		// on close, so an interrupted repair is enqueued again.
		expect(modelsRepairDone(sqlite)).toBe(false);
		expect(await runModelsRepair(sqlite, async (ids) => { asked.push([...ids].sort()); })).toBe(2);

		// The passes ran (one with the models, one still without: the guard).
		persistAnalysisResult(db, fullResult({ trackId: 't1', outPeaksLoPath: '', outPeaksHiPath: '', options: { features: ['brightness'] } } as unknown as AnalyzeParams), '/music/t1.flac', { audioHash: 'h' });
		persistAnalysisResult(db, noModels('t2'), '/music/t2.flac', { audioHash: 'h' });
		expect(modelsRepairCandidates(sqlite)).toEqual([]);
		expect(await runModelsRepair(sqlite, async () => { throw new Error('nothing to enqueue'); })).toBe(0);
		expect(modelsRepairDone(sqlite)).toBe(true);
		expect(sqlite.prepare(`SELECT count(*) FROM app_setting WHERE key = ?`).pluck().get(MODELS_REPAIR_KEY)).toBe(1);
	});
});
