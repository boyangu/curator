// BackupStore — userData/backup.db, the engine's local index: which objects
// a target already holds, file fingerprints (so unchanged files are never
// re-read), the DB-snapshot pre-check, a cache of the remote snapshot list,
// and the run/upload journal that makes an interrupted run resumable.
//
// Why its own file and not tables in curator.db: a restore REPLACES
// curator.db, and an index living inside it would be rolled back into lying
// about what the remote holds. It is owned by the backup worker alone (no
// cross-process write contention), excluded from every backup, and fully
// rebuildable from the manifests on the target — those are the truth.
//
// Synchronous like the other sibling stores (mir/knowledge): every call is a
// handful of indexed rows and the engine runs off the main loop anyway.

import Database from 'better-sqlite3';
import type { BackupSetId, BackupTargetConfig } from './types.js';
import type { ResumeToken } from './targets/types.js';

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS backup_meta (
	key TEXT PRIMARY KEY,
	value TEXT
);
CREATE TABLE IF NOT EXISTS target (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	config_json TEXT NOT NULL,
	-- null ⇒ the object index below is not trusted and must be rebuilt
	-- from target.listObjects() before the next run.
	index_built_at INTEGER
);
CREATE TABLE IF NOT EXISTS object (
	target_id TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	size INTEGER NOT NULL,
	stored_size INTEGER NOT NULL,
	enc TEXT NOT NULL,
	remote_id TEXT,
	uploaded_at INTEGER NOT NULL,
	PRIMARY KEY (target_id, sha256)
);
-- (size, mtime) → sha for every file seen; a hit skips the read + hash.
CREATE TABLE IF NOT EXISTS fingerprint (
	path TEXT PRIMARY KEY,
	size INTEGER NOT NULL,
	mtime_ms INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	seen_at INTEGER NOT NULL
);
-- A SQLite DB is snapshotted with VACUUM INTO (seconds for curator.db, tens
-- of seconds for mir.db). When db + wal are byte-for-byte unchanged since
-- the last snapshot we reuse its sha instead.
CREATE TABLE IF NOT EXISTS db_snapshot_fp (
	path TEXT PRIMARY KEY,
	db_size INTEGER NOT NULL,
	db_mtime_ms INTEGER NOT NULL,
	wal_size INTEGER NOT NULL,
	wal_mtime_ms INTEGER NOT NULL,
	sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot_cache (
	target_id TEXT NOT NULL,
	snapshot_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	bytes INTEGER NOT NULL DEFAULT 0,
	files INTEGER NOT NULL DEFAULT 0,
	sets_json TEXT NOT NULL DEFAULT '[]',
	pinned INTEGER NOT NULL DEFAULT 0,
	label TEXT,
	hostname TEXT,
	-- sha256 over the sorted (set, path, sha) list: equal ⇒ nothing changed.
	file_sig TEXT,
	PRIMARY KEY (target_id, snapshot_id)
);
CREATE TABLE IF NOT EXISTS run (
	id TEXT PRIMARY KEY,
	target_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	finished_at INTEGER,
	status TEXT NOT NULL,
	stats_json TEXT,
	error TEXT
);
CREATE TABLE IF NOT EXISTS run_item (
	run_id TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	state TEXT NOT NULL,
	staged_path TEXT,
	upload_session_uri TEXT,
	bytes_sent INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (run_id, sha256)
);
`;

export interface ObjectRow {
	sha256: string;
	size: number;
	storedSize: number;
	enc: string;
	remoteId: string | null;
	uploadedAt: number;
}

export interface FingerprintRow {
	size: number;
	mtimeMs: number;
	sha256: string;
}

export interface DbSnapshotFp {
	dbSize: number;
	dbMtimeMs: number;
	walSize: number;
	walMtimeMs: number;
	sha256: string;
}

export interface SnapshotCacheRow {
	snapshotId: string;
	createdAt: number;
	bytes: number;
	files: number;
	sets: BackupSetId[];
	pinned: boolean;
	label: string | null;
	hostname: string | null;
	fileSig: string | null;
}

export interface RunItemRow {
	sha256: string;
	state: 'pending' | 'uploading' | 'done';
	stagedPath: string | null;
	resume: ResumeToken | null;
}

export class BackupStore {
	private readonly db: Database.Database;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma('journal_mode = WAL');
		this.db.exec(DDL);
		this.db.prepare(`INSERT OR REPLACE INTO backup_meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
	}

	close(): void { this.db.close(); }

	meta(key: string): string | null {
		const r = this.db.prepare(`SELECT value FROM backup_meta WHERE key = ?`).get(key) as { value: string | null } | undefined;
		return r?.value ?? null;
	}

	setMeta(key: string, value: string): void {
		this.db.prepare(`INSERT OR REPLACE INTO backup_meta (key, value) VALUES (?, ?)`).run(key, value);
	}

	// ─── targets ─────────────────────────────────────────────────────────

	ensureTarget(id: string, cfg: BackupTargetConfig): { indexBuilt: boolean } {
		const row = this.db.prepare(`SELECT index_built_at FROM target WHERE id = ?`).get(id) as { index_built_at: number | null } | undefined;
		if (!row) {
			this.db.prepare(`INSERT INTO target (id, kind, config_json, index_built_at) VALUES (?, ?, ?, NULL)`).run(id, cfg.kind, JSON.stringify(cfg));
			return { indexBuilt: false };
		}
		return { indexBuilt: row.index_built_at != null };
	}

	markIndexBuilt(targetId: string): void {
		this.db.prepare(`UPDATE target SET index_built_at = ? WHERE id = ?`).run(Date.now(), targetId);
	}

	invalidateIndex(targetId: string): void {
		this.db.transaction(() => {
			this.db.prepare(`UPDATE target SET index_built_at = NULL WHERE id = ?`).run(targetId);
			this.db.prepare(`DELETE FROM object WHERE target_id = ?`).run(targetId);
		})();
	}

	// ─── objects ─────────────────────────────────────────────────────────

	objectShas(targetId: string): Set<string> {
		const rows = this.db.prepare(`SELECT sha256 FROM object WHERE target_id = ?`).all(targetId) as Array<{ sha256: string }>;
		return new Set(rows.map((r) => r.sha256));
	}

	getObject(targetId: string, sha256: string): ObjectRow | null {
		const r = this.db.prepare(`SELECT sha256, size, stored_size, enc, remote_id, uploaded_at FROM object WHERE target_id = ? AND sha256 = ?`).get(targetId, sha256) as
			{ sha256: string; size: number; stored_size: number; enc: string; remote_id: string | null; uploaded_at: number } | undefined;
		return r ? { sha256: r.sha256, size: r.size, storedSize: r.stored_size, enc: r.enc, remoteId: r.remote_id, uploadedAt: r.uploaded_at } : null;
	}

	putObject(targetId: string, o: ObjectRow): void {
		this.db.prepare(`INSERT OR REPLACE INTO object (target_id, sha256, size, stored_size, enc, remote_id, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run(targetId, o.sha256, o.size, o.storedSize, o.enc, o.remoteId, o.uploadedAt);
	}

	putObjects(targetId: string, rows: ObjectRow[]): void {
		const stmt = this.db.prepare(`INSERT OR REPLACE INTO object (target_id, sha256, size, stored_size, enc, remote_id, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
		this.db.transaction(() => {
			for (const o of rows) stmt.run(targetId, o.sha256, o.size, o.storedSize, o.enc, o.remoteId, o.uploadedAt);
		})();
	}

	deleteObjects(targetId: string, shas: string[]): void {
		const stmt = this.db.prepare(`DELETE FROM object WHERE target_id = ? AND sha256 = ?`);
		this.db.transaction(() => { for (const s of shas) stmt.run(targetId, s); })();
	}

	// ─── fingerprints ────────────────────────────────────────────────────

	// One SELECT for the whole run: 45k rows is a few MB in memory and far
	// cheaper than a lookup per file.
	allFingerprints(): Map<string, FingerprintRow> {
		const rows = this.db.prepare(`SELECT path, size, mtime_ms, sha256 FROM fingerprint`).all() as Array<{ path: string; size: number; mtime_ms: number; sha256: string }>;
		const m = new Map<string, FingerprintRow>();
		for (const r of rows) m.set(r.path, { size: r.size, mtimeMs: r.mtime_ms, sha256: r.sha256 });
		return m;
	}

	putFingerprints(rows: Array<{ path: string } & FingerprintRow>): void {
		const stmt = this.db.prepare(`INSERT OR REPLACE INTO fingerprint (path, size, mtime_ms, sha256, seen_at) VALUES (?, ?, ?, ?, ?)`);
		const now = Date.now();
		this.db.transaction(() => { for (const r of rows) stmt.run(r.path, r.size, r.mtimeMs, r.sha256, now); })();
	}

	getDbSnapshotFp(path: string): DbSnapshotFp | null {
		const r = this.db.prepare(`SELECT db_size, db_mtime_ms, wal_size, wal_mtime_ms, sha256 FROM db_snapshot_fp WHERE path = ?`).get(path) as
			{ db_size: number; db_mtime_ms: number; wal_size: number; wal_mtime_ms: number; sha256: string } | undefined;
		return r ? { dbSize: r.db_size, dbMtimeMs: r.db_mtime_ms, walSize: r.wal_size, walMtimeMs: r.wal_mtime_ms, sha256: r.sha256 } : null;
	}

	putDbSnapshotFp(path: string, fp: DbSnapshotFp): void {
		this.db.prepare(`INSERT OR REPLACE INTO db_snapshot_fp (path, db_size, db_mtime_ms, wal_size, wal_mtime_ms, sha256) VALUES (?, ?, ?, ?, ?, ?)`)
			.run(path, fp.dbSize, fp.dbMtimeMs, fp.walSize, fp.walMtimeMs, fp.sha256);
	}

	// ─── snapshot cache ──────────────────────────────────────────────────

	snapshots(targetId: string): SnapshotCacheRow[] {
		const rows = this.db.prepare(`SELECT snapshot_id, created_at, bytes, files, sets_json, pinned, label, hostname, file_sig FROM snapshot_cache WHERE target_id = ? ORDER BY created_at DESC, snapshot_id DESC`).all(targetId) as
			Array<{ snapshot_id: string; created_at: number; bytes: number; files: number; sets_json: string; pinned: number; label: string | null; hostname: string | null; file_sig: string | null }>;
		return rows.map((r) => ({
			snapshotId: r.snapshot_id, createdAt: r.created_at, bytes: r.bytes, files: r.files,
			sets: JSON.parse(r.sets_json) as BackupSetId[], pinned: r.pinned === 1, label: r.label, hostname: r.hostname, fileSig: r.file_sig,
		}));
	}

	putSnapshot(targetId: string, s: SnapshotCacheRow): void {
		this.db.prepare(`INSERT OR REPLACE INTO snapshot_cache (target_id, snapshot_id, created_at, bytes, files, sets_json, pinned, label, hostname, file_sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(targetId, s.snapshotId, s.createdAt, s.bytes, s.files, JSON.stringify(s.sets), s.pinned ? 1 : 0, s.label, s.hostname, s.fileSig);
	}

	// Replace the cache with what the target reports. Rows the listing no
	// longer mentions are gone (deleted elsewhere); known rows keep their
	// cached manifest-derived fields when the caller passes them through.
	replaceSnapshots(targetId: string, rows: SnapshotCacheRow[]): void {
		const del = this.db.prepare(`DELETE FROM snapshot_cache WHERE target_id = ?`);
		this.db.transaction(() => {
			del.run(targetId);
			for (const s of rows) this.putSnapshot(targetId, s);
		})();
	}

	setPinned(targetId: string, snapshotId: string, pinned: boolean, label: string | null): void {
		this.db.prepare(`UPDATE snapshot_cache SET pinned = ?, label = ? WHERE target_id = ? AND snapshot_id = ?`).run(pinned ? 1 : 0, label, targetId, snapshotId);
	}

	deleteSnapshot(targetId: string, snapshotId: string): void {
		this.db.prepare(`DELETE FROM snapshot_cache WHERE target_id = ? AND snapshot_id = ?`).run(targetId, snapshotId);
	}

	// ─── runs + journal ──────────────────────────────────────────────────

	beginRun(id: string, targetId: string, kind: 'backup' | 'restore'): void {
		this.db.prepare(`INSERT INTO run (id, target_id, kind, started_at, status) VALUES (?, ?, ?, ?, 'running')`).run(id, targetId, kind, Date.now());
	}

	finishRun(id: string, status: string, stats: unknown, error: string | null): void {
		this.db.prepare(`UPDATE run SET finished_at = ?, status = ?, stats_json = ?, error = ? WHERE id = ?`).run(Date.now(), status, JSON.stringify(stats ?? null), error, id);
	}

	// Runs the worker never finished (process died mid-upload). Marked
	// interrupted so the next run can adopt their journal rows.
	markStaleRuns(): string[] {
		const rows = this.db.prepare(`SELECT id FROM run WHERE status = 'running'`).all() as Array<{ id: string }>;
		if (rows.length) this.db.prepare(`UPDATE run SET status = 'interrupted', finished_at = ? WHERE status = 'running'`).run(Date.now());
		return rows.map((r) => r.id);
	}

	// Journal rows of the latest interrupted/cancelled backup run against
	// this target that are not yet done — adopted by the next run so a
	// resumable upload session is not thrown away.
	resumableItems(targetId: string): Map<string, RunItemRow> {
		const run = this.db.prepare(`SELECT id FROM run WHERE target_id = ? AND kind = 'backup' AND status IN ('interrupted', 'cancelled', 'failed') ORDER BY started_at DESC LIMIT 1`).get(targetId) as { id: string } | undefined;
		const out = new Map<string, RunItemRow>();
		if (!run) return out;
		const rows = this.db.prepare(`SELECT sha256, state, staged_path, upload_session_uri, bytes_sent FROM run_item WHERE run_id = ? AND state != 'done'`).all(run.id) as
			Array<{ sha256: string; state: RunItemRow['state']; staged_path: string | null; upload_session_uri: string | null; bytes_sent: number }>;
		for (const r of rows) {
			out.set(r.sha256, {
				sha256: r.sha256, state: r.state, stagedPath: r.staged_path,
				resume: r.upload_session_uri || r.bytes_sent ? { sessionUri: r.upload_session_uri ?? undefined, bytesSent: r.bytes_sent } : null,
			});
		}
		return out;
	}

	putRunItems(runId: string, items: RunItemRow[]): void {
		const stmt = this.db.prepare(`INSERT OR REPLACE INTO run_item (run_id, sha256, state, staged_path, upload_session_uri, bytes_sent) VALUES (?, ?, ?, ?, ?, ?)`);
		this.db.transaction(() => {
			for (const it of items) stmt.run(runId, it.sha256, it.state, it.stagedPath, it.resume?.sessionUri ?? null, it.resume?.bytesSent ?? 0);
		})();
	}

	updateRunItem(runId: string, sha256: string, patch: Partial<Pick<RunItemRow, 'state' | 'stagedPath' | 'resume'>>): void {
		const sets: string[] = [];
		const args: unknown[] = [];
		if (patch.state !== undefined) { sets.push('state = ?'); args.push(patch.state); }
		if (patch.stagedPath !== undefined) { sets.push('staged_path = ?'); args.push(patch.stagedPath); }
		if (patch.resume !== undefined) {
			sets.push('upload_session_uri = ?', 'bytes_sent = ?');
			args.push(patch.resume?.sessionUri ?? null, patch.resume?.bytesSent ?? 0);
		}
		if (!sets.length) return;
		args.push(runId, sha256);
		this.db.prepare(`UPDATE run_item SET ${sets.join(', ')} WHERE run_id = ? AND sha256 = ?`).run(...args);
	}

	// Staged temp files any unfinished run still references — the staging
	// sweep must keep these.
	referencedStagedPaths(): Set<string> {
		const rows = this.db.prepare(`SELECT ri.staged_path FROM run_item ri JOIN run r ON r.id = ri.run_id WHERE ri.staged_path IS NOT NULL AND ri.state != 'done' AND r.status IN ('running', 'interrupted', 'cancelled', 'failed')`).all() as Array<{ staged_path: string }>;
		return new Set(rows.map((r) => r.staged_path));
	}

	// Drop journals of finished runs older than the cutoff so the table
	// never grows unbounded.
	pruneRuns(olderThanMs: number): void {
		const cutoff = Date.now() - olderThanMs;
		this.db.transaction(() => {
			this.db.prepare(`DELETE FROM run_item WHERE run_id IN (SELECT id FROM run WHERE finished_at IS NOT NULL AND finished_at < ?)`).run(cutoff);
			this.db.prepare(`DELETE FROM run WHERE finished_at IS NOT NULL AND finished_at < ?`).run(cutoff);
		})();
	}
}
