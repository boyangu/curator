// Analysis queue — the boot-time backfills (stale-version floor + fingerprint
// sweep) and the enqueue options rule. Runs the real queue against a
// generated DB with a fake sidecar that records what it was asked to run and
// answers with a fingerprint-bearing result — never the live library
// (CLAUDE.md), and never a real Python process.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import {
	AnalysisQueue,
	EXPECTED_ANALYZER_VERSION,
	FINGERPRINT_BACKFILL_PRIORITY,
	FINGERPRINT_ONLY_OPTIONS,
	MIN_FULL_REANALYSIS_VERSION,
	needsFullReanalysis,
} from './queue.js';
import type { AnalyzerSidecar, AnalyzeOptions, AnalyzeParams, AnalyzeResult } from './sidecar.js';

const FAKE_PRINT = 'AQADtEmSJEuSJMmRHMnxHMlxJEdyJEdyJEeSJEmSJEmSJEmSJEmSJEmS';

// Minimal sidecar stand-in: records every analyze() call and resolves with a
// result that carries a fingerprint but no grid/key/segments — the shape a
// fingerprint-only pass produces, and (for this test) what the "full" pass
// produces too, so persistResult's write-when-produced guards are exercised.
class FakeSidecar extends EventEmitter {
	calls: AnalyzeParams[] = [];
	analyze(p: AnalyzeParams): Promise<AnalyzeResult> {
		this.calls.push(p);
		return Promise.resolve({
			track_id: p.trackId,
			duration: 30,
			bpm: null,
			beatgrid: [],
			downbeats: [],
			key_camelot: null,
			key_strength: null,
			brightness: null,
			power: null,
			dynamic_complexity: null,
			loudness_range_lu: null,
			dissonance: null,
			density: null,
			segments: [],
			intro_length_sec: null,
			outro_length_sec: null,
			first_drop_sec: null,
			drop_count: null,
			breakdown_count: null,
			fingerprint: p.options?.skipFingerprint ? null : FAKE_PRINT,
			fingerprint_duration_sec: p.options?.skipFingerprint ? null : 30,
			features: {},
			peaks_lo_path: p.outPeaksLoPath,
			peaks_hi_path: p.outPeaksHiPath,
			analyzer_version: EXPECTED_ANALYZER_VERSION,
		});
	}
	cancel(): void { /* nothing in flight to cancel */ }
}

let dir: string;
let db: Db;
let sqlite: Database.Database;
let fake: FakeSidecar;
let queue: AnalysisQueue;

const row = <T = Record<string, unknown>>(sqlText: string, ...args: unknown[]): T | undefined =>
	sqlite.prepare(sqlText).get(...args) as T | undefined;

function seedTrack(id: string): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state, duration) VALUES (?, ?, '[{"name":"Artist"}]', 'unsorted', 30)`).run(id, `Title ${id}`);
}
// A local link pointing at a real file in the temp dir (or a path that does
// not exist, for the stat guard), with or without a stored fingerprint.
function seedLocalLink(trackId: string, opts: { exists?: boolean; fingerprint?: string | null } = {}): string {
	const path = join(dir, `${trackId}.flac`);
	if (opts.exists !== false) writeFileSync(path, 'not really flac');
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, fingerprint, fingerprint_duration_sec) VALUES (?, ?, 'local', ?, ?, ?, ?)`)
		.run(`sl-${trackId}`, trackId, `local-${trackId}`, path, opts.fingerprint ?? null, opts.fingerprint ? 30 : null);
	return path;
}
function seedAnalysis(trackId: string, version: string): void {
	sqlite.prepare(`INSERT INTO track_analysis (track_id, analyzer_version, analyzed_at) VALUES (?, ?, 1)`).run(trackId, version);
}
function seedJob(trackId: string, state: string, priority = 0): void {
	sqlite.prepare(`INSERT INTO analysis_job (track_id, state, priority, enqueued_at) VALUES (?, ?, ?, 1)`).run(trackId, state, priority);
}
function job(trackId: string): { state: string; priority: number } | undefined {
	return row<{ state: string; priority: number }>(`SELECT state, priority FROM analysis_job WHERE track_id = ?`, trackId);
}
function link(trackId: string): { fingerprint: string | null; fingerprint_duration_sec: number | null } {
	return row(`SELECT fingerprint, fingerprint_duration_sec FROM source_link WHERE track_id = ?`, trackId)!;
}
function pendingJobs(): number {
	return row<{ n: number }>(`SELECT COUNT(*) n FROM analysis_job WHERE state IN ('queued', 'running')`)!.n;
}

async function waitFor(cond: () => boolean, label: string, ms = 5000): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-queue-'));
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
	fake = new FakeSidecar();
	queue = new AnalysisQueue(db, fake as unknown as AnalyzerSidecar, { peaksDir: join(dir, 'peaks'), concurrency: 8 });
});

afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* sibling handles on Windows */ }
});

describe('needsFullReanalysis', () => {
	it('is a numeric compare against the floor, not a string compare', () => {
		expect(needsFullReanalysis('2.2.0')).toBe(true);
		expect(needsFullReanalysis('2.1.0')).toBe(true);
		expect(needsFullReanalysis('1.9.9')).toBe(true);
		expect(needsFullReanalysis('2.3.0')).toBe(false);
		expect(needsFullReanalysis('2.4.0')).toBe(false);
		expect(needsFullReanalysis('2.10.0')).toBe(false);
		expect(needsFullReanalysis('3.0.0')).toBe(false);
	});

	it('never flags the paired version or the floor itself', () => {
		expect(needsFullReanalysis(EXPECTED_ANALYZER_VERSION)).toBe(false);
		expect(needsFullReanalysis(MIN_FULL_REANALYSIS_VERSION)).toBe(false);
	});

	it('excludes the rekordbox marker and treats other non-versions as stale', () => {
		expect(needsFullReanalysis('rekordbox')).toBe(false);
		expect(needsFullReanalysis('test')).toBe(true);
		expect(needsFullReanalysis('')).toBe(true);
	});
});

describe('setAutoEnabled backfills', () => {
	it('re-runs only rows below the floor and fingerprints the rest with the decode-only pass', async () => {
		// Below the floor → full pass (priority 0). Its link already has a
		// print so the fingerprint sweep must not touch it.
		seedTrack('stale'); seedLocalLink('stale', { fingerprint: 'OLDPRINT' }); seedAnalysis('stale', '2.2.0'); seedJob('stale', 'done');
		// At the floor, no print → fingerprint-only pass at the lowest priority.
		seedTrack('current'); seedLocalLink('current'); seedAnalysis('current', '2.3.0'); seedJob('current', 'done');
		// At the floor, already printed → nothing to do.
		seedTrack('printed'); seedLocalLink('printed', { fingerprint: 'HASPRINT' }); seedAnalysis('printed', '2.3.0'); seedJob('printed', 'done');
		// rekordbox-marked rows never get the full pass, but do get printed.
		seedTrack('rb'); seedLocalLink('rb'); seedAnalysis('rb', 'rekordbox'); seedJob('rb', 'done');
		// File gone from disk → skipped by the stat pass, no job minted.
		seedTrack('gone'); seedLocalLink('gone', { exists: false }); seedAnalysis('gone', '2.3.0'); seedJob('gone', 'done');
		// Never analysed → printed, but no hollow track_analysis row.
		seedTrack('fresh'); seedLocalLink('fresh');
		// Sticky error → left alone until an explicit re-analysis.
		seedTrack('errored'); seedLocalLink('errored'); seedAnalysis('errored', '2.3.0'); seedJob('errored', 'error');

		queue.setAutoEnabled(true);
		await waitFor(() => fake.calls.length === 4 && pendingJobs() === 0, 'four dispatches to settle');

		const byId = new Map(fake.calls.map((c) => [c.trackId, c] as const));
		expect([...byId.keys()].sort()).toEqual(['current', 'fresh', 'rb', 'stale']);

		// The stale row got the default (full) pipeline, not the print-only one.
		expect(byId.get('stale')!.options?.skipBeatgrid).toBeUndefined();
		expect(job('stale')).toEqual({ state: 'done', priority: 0 });
		// The print-only pass sends exactly the decode-only option set.
		for (const id of ['current', 'rb', 'fresh']) {
			expect(byId.get(id)!.options, id).toEqual(FINGERPRINT_ONLY_OPTIONS);
			expect(job(id), id).toEqual({ state: 'done', priority: FINGERPRINT_BACKFILL_PRIORITY });
		}
		expect(job('printed')).toEqual({ state: 'done', priority: 0 });
		expect(job('gone')).toEqual({ state: 'done', priority: 0 });
		expect(job('errored')).toEqual({ state: 'error', priority: 0 });
		expect(job('fresh')).toEqual({ state: 'done', priority: FINGERPRINT_BACKFILL_PRIORITY });

		// persistResult wrote the print onto the dispatched link only.
		for (const id of ['current', 'rb', 'fresh', 'stale']) {
			expect(link(id), id).toEqual({ fingerprint: FAKE_PRINT, fingerprint_duration_sec: 30 });
		}
		expect(link('printed').fingerprint).toBe('HASPRINT');
		expect(link('gone').fingerprint).toBeNull();
		expect(link('errored').fingerprint).toBeNull();

		// The full pass restamped the stale row; the print-only pass over a
		// never-analysed track minted no track_analysis row.
		expect(row(`SELECT analyzer_version FROM track_analysis WHERE track_id = 'stale'`)).toEqual({ analyzer_version: EXPECTED_ANALYZER_VERSION });
		expect(row(`SELECT 1 FROM track_analysis WHERE track_id = 'fresh'`)).toBeUndefined();
		// Housekeeping still lands on an existing row the print-only pass touched.
		expect(row(`SELECT analyzer_version FROM track_analysis WHERE track_id = 'current'`)).toEqual({ analyzer_version: EXPECTED_ANALYZER_VERSION });
	});

	it('leaves everything parked while auto-analyze is off', async () => {
		seedTrack('current'); seedLocalLink('current'); seedAnalysis('current', '2.3.0'); seedJob('current', 'done');
		queue.setAutoEnabled(false);
		await new Promise((r) => setTimeout(r, 50));
		expect(fake.calls).toHaveLength(0);
		expect(job('current')).toEqual({ state: 'done', priority: 0 });
	});
});

describe('enqueue options rule', () => {
	const AUTO: AnalyzeOptions = { features: [], overrideBeatgrid: true, overrideBpm: true, overrideKey: true, overrideSegments: true, overridePeaks: true };

	it('does not let a lower-priority re-enqueue downgrade a queued pass', async () => {
		seedTrack('t'); seedLocalLink('t', { fingerprint: 'HASPRINT' });
		// Auto is off (default) so priority-0 work parks in `queued`.
		queue.enqueue(['t'], { priority: 0, analyzeOptions: AUTO });
		queue.enqueue(['t'], { priority: FINGERPRINT_BACKFILL_PRIORITY, analyzeOptions: FINGERPRINT_ONLY_OPTIONS });
		expect(job('t')).toEqual({ state: 'queued', priority: 0 });

		queue.setAutoEnabled(true);
		await waitFor(() => fake.calls.length === 1 && pendingJobs() === 0, 'dispatch');
		expect(fake.calls[0]!.options).toEqual(AUTO);
	});

	it('lets an equal-or-higher priority re-enqueue replace the options', async () => {
		seedTrack('t'); seedLocalLink('t', { fingerprint: 'HASPRINT' });
		queue.enqueue(['t'], { priority: 0, analyzeOptions: AUTO });
		const manual: AnalyzeOptions = { features: ['brightness'], skipBeatgrid: true, skipKey: true, skipSegments: true, skipPeaks: true };
		queue.enqueue(['t'], { priority: 100, analyzeOptions: manual });
		await waitFor(() => fake.calls.length === 1 && pendingJobs() === 0, 'dispatch');
		expect(fake.calls[0]!.options).toEqual(manual);
		expect(job('t')).toEqual({ state: 'done', priority: 100 });
	});

	it('skips a done track without force and keeps no ghost options for it', async () => {
		seedTrack('t'); seedLocalLink('t', { fingerprint: 'HASPRINT' }); seedJob('t', 'done');
		queue.enqueue(['t'], { priority: 100, analyzeOptions: FINGERPRINT_ONLY_OPTIONS });
		expect(job('t')).toEqual({ state: 'done', priority: 0 });
		// A later forced re-queue without options must run the default
		// pipeline, not the print-only one left behind by the skipped call.
		queue.enqueue(['t'], { priority: 100, force: true });
		await waitFor(() => fake.calls.length === 1 && pendingJobs() === 0, 'dispatch');
		expect(fake.calls[0]!.options).toBeUndefined();
	});
});
