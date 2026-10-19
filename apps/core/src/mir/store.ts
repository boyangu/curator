// MirStore — mir.db, the AI engine's vector store (the fifth sibling DB file).
//
// Why its own file: vectors are derived and fully rebuildable, tens to
// hundreds of MB, and churn on every model change — the opposite of the
// sacred curator.db, whose VACUUM INTO backups must not carry them. No foreign
// keys cross files (feed/knowledge convention): track ids are plain text here,
// and the lifecycle hooks below (delete / merge / orphan sweep) keep them in
// step with the library.
//
// Shape is ready for v2 without a migration: a vector row is keyed by
// (track, model, scope, segment, stem) — v1 writes scope='track' plus one
// 'segment' row per analysed segment; stems add rows with stem='bass' etc.
//
// Synchronous like KnowledgeStore: writes are single-track transactions and
// reads feed the in-memory index; there is nothing to await.

import Database from 'better-sqlite3';
import type { MirModelCoverage, MirModelInfo } from './types.js';

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS mir_meta (
	key TEXT PRIMARY KEY,
	value TEXT
);
CREATE TABLE IF NOT EXISTS mir_model (
	id TEXT PRIMARY KEY,           -- "<key>@<version>"
	key TEXT NOT NULL,
	dim INTEGER NOT NULL,
	sample_rate INTEGER,
	text INTEGER NOT NULL DEFAULT 0,
	license TEXT,
	repo TEXT,
	first_seen_at INTEGER NOT NULL
);
-- One row per (track, model, stage): provenance + the "done" marker. Pending
-- work is DERIVED (local tracks x enabled models - done - given-up), never
-- queued, so it survives restarts and a model bump re-embeds by itself.
CREATE TABLE IF NOT EXISTS mir_run (
	track_id TEXT NOT NULL,
	model_id TEXT NOT NULL,
	stage TEXT NOT NULL,
	executor TEXT NOT NULL,
	status TEXT NOT NULL,          -- 'done' | 'error'
	error_kind TEXT,
	error TEXT,
	attempts INTEGER NOT NULL DEFAULT 1,
	ms INTEGER,
	finished_at INTEGER NOT NULL,
	PRIMARY KEY (track_id, model_id, stage)
);
CREATE INDEX IF NOT EXISTS idx_mir_run_model ON mir_run (model_id, stage, status);
CREATE TABLE IF NOT EXISTS mir_vector (
	track_id TEXT NOT NULL,
	model_id TEXT NOT NULL,
	scope TEXT NOT NULL,           -- 'track' | 'segment' (v2: 'stem')
	seg_idx INTEGER NOT NULL DEFAULT -1,
	stem TEXT NOT NULL DEFAULT '',
	start_sec REAL,
	end_sec REAL,
	label TEXT,
	vec BLOB NOT NULL,             -- Float32 LE, as emitted by the engine
	created_at INTEGER NOT NULL,
	PRIMARY KEY (track_id, model_id, scope, seg_idx, stem)
);
CREATE INDEX IF NOT EXISTS idx_mir_vector_model_scope ON mir_vector (model_id, scope);
`;

export interface SegmentVector {
	index: number;
	startSec: number;
	endSec: number;
	label: string | null;
	vec: Buffer;
}

export interface VectorMatrix {
	ids: string[];
	dim: number;
	data: Float32Array; // row-major ids.length x dim
}

// Copy a BLOB into an aligned Float32Array (better-sqlite3 Buffers can sit at
// any byteOffset inside Node's pool; Float32Array views need 4-byte alignment).
export function blobToF32(b: Buffer): Float32Array {
	const out = new Float32Array(b.byteLength >>> 2);
	new Uint8Array(out.buffer).set(b.subarray(0, out.length * 4));
	return out;
}

export class SqliteMirStore {
	private readonly db: Database.Database;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma('journal_mode = WAL');
		this.db.exec(DDL);
		this.db
			.prepare(`INSERT OR REPLACE INTO mir_meta (key, value) VALUES ('schema_version', ?)`)
			.run(String(SCHEMA_VERSION));
	}

	// Monotonic counter bumped on every vector write/delete; the in-memory
	// index compares it to decide when to reload (the core-sidecar runs a
	// second CoreService over the same file, so writes can come from either).
	indexVersion(): number {
		const r = this.db.prepare(`SELECT value FROM mir_meta WHERE key = 'index_version'`).get() as { value: string } | undefined;
		return r ? Number(r.value) : 0;
	}

	private bumpIndexVersion(): void {
		this.db.prepare(`
			INSERT INTO mir_meta (key, value) VALUES ('index_version', '1')
			ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
		`).run();
	}

	upsertModel(m: MirModelInfo): void {
		this.db.prepare(`
			INSERT INTO mir_model (id, key, dim, sample_rate, text, license, repo, first_seen_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET dim = excluded.dim, sample_rate = excluded.sample_rate,
				text = excluded.text, license = excluded.license, repo = excluded.repo
		`).run(m.modelId, m.key, m.dim, m.sampleRate, m.text ? 1 : 0, m.license, m.repo, Date.now());
	}

	// Models seen in earlier runs — lets seed-based similarity work from stored
	// vectors even while the engine is down or not yet started.
	knownModels(): { modelId: string; key: string; dim: number; text: boolean }[] {
		return (this.db.prepare(`SELECT id, key, dim, text FROM mir_model ORDER BY first_seen_at`).all() as
			{ id: string; key: string; dim: number; text: number }[])
			.map((r) => ({ modelId: r.id, key: r.key, dim: r.dim, text: r.text === 1 }));
	}

	// Replace every vector of (track, model) with this run's output and mark
	// the run done — one transaction, so a half-written track never exists.
	putResult(trackId: string, modelId: string, executor: string, ms: number | null,
		trackVec: Buffer, segments: SegmentVector[]): void {
		const now = Date.now();
		const del = this.db.prepare(`DELETE FROM mir_vector WHERE track_id = ? AND model_id = ?`);
		const ins = this.db.prepare(`
			INSERT INTO mir_vector (track_id, model_id, scope, seg_idx, stem, start_sec, end_sec, label, vec, created_at)
			VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)
		`);
		const run = this.db.prepare(`
			INSERT INTO mir_run (track_id, model_id, stage, executor, status, error_kind, error, attempts, ms, finished_at)
			VALUES (?, ?, 'embed', ?, 'done', NULL, NULL, 1, ?, ?)
			ON CONFLICT(track_id, model_id, stage) DO UPDATE SET executor = excluded.executor, status = 'done',
				error_kind = NULL, error = NULL, ms = excluded.ms, finished_at = excluded.finished_at
		`);
		this.db.transaction(() => {
			del.run(trackId, modelId);
			ins.run(trackId, modelId, 'track', -1, null, null, null, trackVec, now);
			for (const s of segments) ins.run(trackId, modelId, 'segment', s.index, s.startSec, s.endSec, s.label, s.vec, now);
			run.run(trackId, modelId, executor, ms, now);
			this.bumpIndexVersion();
		})();
	}

	putFailure(trackId: string, modelId: string, executor: string, errorKind: string, message: string): void {
		this.db.prepare(`
			INSERT INTO mir_run (track_id, model_id, stage, executor, status, error_kind, error, attempts, ms, finished_at)
			VALUES (?, ?, 'embed', ?, 'error', ?, ?, 1, NULL, ?)
			ON CONFLICT(track_id, model_id, stage) DO UPDATE SET executor = excluded.executor, status = 'error',
				error_kind = excluded.error_kind, error = excluded.error, attempts = attempts + 1,
				finished_at = excluded.finished_at
		`).run(trackId, modelId, executor, errorKind, message.slice(0, 2000), Date.now());
	}

	// Tracks the scheduler should not (re)try for this model: done, or failed
	// `maxAttempts` times (a corrupt file stays failed until the user forces it).
	settledTrackIds(modelId: string, maxAttempts: number): Set<string> {
		const rows = this.db.prepare(`
			SELECT track_id FROM mir_run WHERE model_id = ? AND stage = 'embed'
				AND (status = 'done' OR attempts >= ?)
		`).all(modelId, maxAttempts) as { track_id: string }[];
		return new Set(rows.map((r) => r.track_id));
	}

	isSettled(trackId: string, modelId: string, maxAttempts: number): boolean {
		return this.db.prepare(`
			SELECT 1 FROM mir_run WHERE track_id = ? AND model_id = ? AND stage = 'embed'
				AND (status = 'done' OR attempts >= ?)
		`).get(trackId, modelId, maxAttempts) !== undefined;
	}

	clearFailures(trackIds: string[], modelId: string): void {
		const del = this.db.prepare(`DELETE FROM mir_run WHERE track_id = ? AND model_id = ? AND status = 'error'`);
		this.db.transaction(() => { for (const id of trackIds) del.run(id, modelId); })();
	}

	coverage(): Record<string, MirModelCoverage> {
		const out: Record<string, MirModelCoverage> = {};
		const rows = this.db.prepare(`
			SELECT model_id, SUM(status = 'done') AS done, SUM(status = 'error') AS failed
			FROM mir_run WHERE stage = 'embed' GROUP BY model_id
		`).all() as { model_id: string; done: number; failed: number }[];
		for (const r of rows) out[r.model_id] = { done: r.done ?? 0, failed: r.failed ?? 0 };
		return out;
	}

	trackVector(trackId: string, modelId: string): Float32Array | null {
		const r = this.db.prepare(`
			SELECT vec FROM mir_vector WHERE track_id = ? AND model_id = ? AND scope = 'track' AND seg_idx = -1 AND stem = ''
		`).get(trackId, modelId) as { vec: Buffer } | undefined;
		return r ? blobToF32(r.vec) : null;
	}

	// Every track-level vector of a model as one matrix (the index's backing).
	loadTrackMatrix(modelId: string): VectorMatrix {
		const rows = this.db.prepare(`
			SELECT track_id, vec FROM mir_vector WHERE model_id = ? AND scope = 'track' AND seg_idx = -1 AND stem = ''
		`).all(modelId) as { track_id: string; vec: Buffer }[];
		const dim = rows.length ? rows[0]!.vec.byteLength >>> 2 : 0;
		const data = new Float32Array(rows.length * dim);
		const ids: string[] = [];
		for (const r of rows) {
			if (r.vec.byteLength >>> 2 !== dim) continue; // defensive: never mix dims in one matrix
			data.set(blobToF32(r.vec), ids.length * dim);
			ids.push(r.track_id);
		}
		return { ids, dim, data: data.subarray(0, ids.length * dim) };
	}

	// ── Library lifecycle hooks (curator.db stays the identity authority) ──

	deleteTracks(trackIds: string[]): void {
		if (trackIds.length === 0) return;
		const dv = this.db.prepare(`DELETE FROM mir_vector WHERE track_id = ?`);
		const dr = this.db.prepare(`DELETE FROM mir_run WHERE track_id = ?`);
		this.db.transaction(() => {
			for (const id of trackIds) { dv.run(id); dr.run(id); }
			this.bumpIndexVersion();
		})();
	}

	// Merge: the winner keeps its own analysis; models only the loser had are
	// carried over (same audio identity, no reason to re-embed).
	moveTrack(loserId: string, winnerId: string): void {
		this.db.transaction(() => {
			const winnerModels = new Set((this.db.prepare(
				`SELECT DISTINCT model_id FROM mir_run WHERE track_id = ? AND status = 'done'`,
			).all(winnerId) as { model_id: string }[]).map((r) => r.model_id));
			const loserModels = (this.db.prepare(
				`SELECT DISTINCT model_id FROM mir_run WHERE track_id = ? AND status = 'done'`,
			).all(loserId) as { model_id: string }[]).map((r) => r.model_id);
			for (const m of loserModels) {
				if (winnerModels.has(m)) continue;
				this.db.prepare(`DELETE FROM mir_vector WHERE track_id = ? AND model_id = ?`).run(winnerId, m);
				this.db.prepare(`UPDATE mir_vector SET track_id = ? WHERE track_id = ? AND model_id = ?`).run(winnerId, loserId, m);
				this.db.prepare(`DELETE FROM mir_run WHERE track_id = ? AND model_id = ?`).run(winnerId, m);
				this.db.prepare(`UPDATE mir_run SET track_id = ? WHERE track_id = ? AND model_id = ?`).run(winnerId, loserId, m);
			}
			this.db.prepare(`DELETE FROM mir_vector WHERE track_id = ?`).run(loserId);
			this.db.prepare(`DELETE FROM mir_run WHERE track_id = ?`).run(loserId);
			this.bumpIndexVersion();
		})();
	}

	// Drop rows for ids the library no longer has (deleted outside the hooks,
	// e.g. by a direct repair script). Returns how many tracks were swept.
	pruneOrphans(isLive: (trackId: string) => boolean): number {
		const ids = (this.db.prepare(`SELECT DISTINCT track_id FROM mir_run`).all() as { track_id: string }[])
			.map((r) => r.track_id)
			.filter((id) => !isLive(id));
		this.deleteTracks(ids);
		return ids.length;
	}

	close(): void {
		this.db.close();
	}
}
