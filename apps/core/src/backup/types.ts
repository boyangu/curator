// Backup & restore — shared shapes for the engine, the CoreService surface,
// the IPC contract, the worker protocol and the renderer. See
// planning/tech/backup.md for the design; engine.ts for the run flow.

// ─── Data sets ───────────────────────────────────────────────────────────────

// One toggle each in "which data to backup". `core` is always on while backup
// is enabled — it is the library itself. Ids + labels live in @curator/shared
// (the renderer needs them as values); re-exported here for core callers.
import { BACKUP_SET_IDS, BACKUP_SET_LABELS, type BackupSetId } from '@curator/shared';
export { BACKUP_SET_IDS, BACKUP_SET_LABELS };
export type { BackupSetId };

// ─── Settings (app_setting 'backup.settings') ───────────────────────────────

export type BackupTargetConfig =
	| { kind: 'folder'; path: string }                 // normalized absolute path
	| { kind: 'googledrive'; folderName: string };    // folder the app creates under My Drive

export interface BackupSettings {
	enabled: boolean;
	target: BackupTargetConfig | null;
	sets: Record<BackupSetId, boolean>;
	// Newest N snapshots survive retention (pinned ones always do).
	keep: number;
	intervalHours: number;
	// Rekordbox master.db override (null → OS default). Mirrors the renderer's
	// localStorage override because the scheduler runs without a renderer.
	rekordboxDbPath: string | null;
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
	enabled: false,
	target: null,
	sets: { core: true, peaks: true, embeddings: true, covers: false, rekordboxDb: true, rekordboxAnalysis: true, tracks: false },
	keep: 7,
	intervalHours: 24,
	rekordboxDbPath: null,
};

// ─── Status (renderer-facing snapshot) ──────────────────────────────────────

export type BackupRunStatus = 'done' | 'unchanged' | 'cancelled' | 'failed' | 'interrupted';

export interface BackupLastRun {
	at: number;
	op: 'backup' | 'restore';
	status: BackupRunStatus;
	snapshotId: string | null;
	message: string | null;
	durationMs: number;
	newBytes: number;
}

export interface BackupTargetStat {
	quotaBytes: number | null;
	usedBytes: number | null;
	freeBytes: number | null;
	account: string | null;
}

export interface BackupRunning {
	runId: string;
	op: 'backup' | 'restore';
	phase: BackupPhase;
	done: number;
	total: number;
	bytesDone: number;
	bytesTotal: number;
	current: string | null;
	stopping: boolean;
}

// The Drive connection as the desktop main reports it. `configured` is false
// when the build carries no Google OAuth client (CURATOR_GOOGLE_CLIENT_ID /
// _SECRET): Connect is refused and the Backup tab says so.
export interface GoogleAuthStatus {
	configured: boolean;
	connected: boolean;
	email: string | null;
}

export interface BackupStatus {
	// false when no engine host was injected (tests/CLI) — the tab says so.
	available: boolean;
	settings: BackupSettings;
	google: GoogleAuthStatus;
	lastRun: BackupLastRun | null;
	lastSuccessAt: number | null;
	nextDueAt: number | null;
	running: BackupRunning | null;
	// Name of the heavy job the scheduler is yielding to, when a run is due.
	waitingFor: string | null;
	// Google refresh token rejected (expired Testing-mode token, revoked…).
	needsReconnect: boolean;
	// A staged Curator-data restore is waiting for a relaunch.
	pendingRestore: { snapshotId: string; stagedAt: number } | null;
	// A restore was applied at the last boot; the previous files are kept here.
	restoreApplied: { snapshotId: string; preRestoreDir: string; error: string | null } | null;
}

export interface BackupSnapshotSummary {
	id: string;
	createdAt: number;
	bytes: number;          // logical bytes of every file in the snapshot
	files: number;
	sets: BackupSetId[];
	pinned: boolean;
	label: string | null;
	hostname: string | null;
}

// ─── Manifest (one per snapshot, zstd JSON on the target) ───────────────────

export type BackupEncoding = 'raw' | 'zstd';

export interface BackupManifestEntry {
	set: BackupSetId;
	// Path relative to the set's root (userData / rekordbox dir / rekordbox
	// settings dir). Tracks carry `abs` + the owning library root instead —
	// the basis for a path remap on restore.
	rel?: string;
	abs?: string;
	root?: string;
	sha256: string;
	size: number;
	mtimeMs: number;
	enc: BackupEncoding;
	storedSize: number;
}

export interface BackupManifest {
	formatVersion: 1;
	snapshotId: string;
	createdAt: number;
	libraryId: string;
	machine: { hostname: string; platform: string; appVersion: string };
	sets: Record<BackupSetId, boolean>;
	roots: {
		userData: string;
		rekordboxDir: string | null;
		rekordboxSettingsDir: string | null;
		libraryFolders: string[];
	};
	warnings: string[];
	files: BackupManifestEntry[];
	stats: { files: number; bytes: number; storedBytes: number; newObjects: number; newBytes: number };
}

// ─── Runs + events ──────────────────────────────────────────────────────────

export type BackupPhase =
	| 'collect' | 'snapshot' | 'hash' | 'upload' | 'manifest' | 'retention' | 'gc'
	| 'download' | 'verify' | 'write' | 'apply';

export interface BackupRunResult {
	snapshotId: string | null;
	unchanged: boolean;
	cancelled: boolean;
	files: number;
	bytes: number;
	newObjects: number;
	newBytes: number;
	warnings: string[];
	durationMs: number;
	// Restore of Curator data: staged, the app must relaunch to apply.
	relaunchRequired?: boolean;
	// Restore of tracks: how many files were written / skipped as identical.
	written?: number;
	skipped?: number;
}

export type BackupEvent =
	| { kind: 'started'; runId: string; op: 'backup' | 'restore'; sets: BackupSetId[] }
	| { kind: 'progress'; runId: string; op: 'backup' | 'restore'; phase: BackupPhase; done: number; total: number; bytesDone: number; bytesTotal: number; current: string | null }
	| { kind: 'completed'; runId: string; op: 'backup' | 'restore'; result: BackupRunResult }
	| { kind: 'failed'; runId: string; op: 'backup' | 'restore'; message: string }
	// Coalesced status snapshot — drives the settings tab (mir pattern).
	| { kind: 'status'; status: BackupStatus };

// ─── Restore ────────────────────────────────────────────────────────────────

export interface BackupRestorePreview {
	snapshotId: string;
	createdAt: number;
	hostname: string | null;
	sameMachine: boolean;
	sets: Record<BackupSetId, { present: boolean; files: number; bytes: number }>;
	roots: BackupManifest['roots'];
	// null when the rekordbox sidecar is disabled (the gate can't be verified).
	rekordboxRunning: boolean | null;
	// The library root the tracks were backed up from (first library folder
	// that owns a track), for the "restore to a different folder" remap.
	tracksRoot: string | null;
	// Free bytes under userData (restore staging) or null if unreadable.
	freeBytes: number | null;
}

export interface BackupRestoreRequest {
	snapshotId: string;
	sets: BackupSetId[];
	// Only read when `sets` includes 'tracks'.
	tracks?: { mode: 'original' } | { mode: 'root'; root: string };
}

// Marker written by restore-stage, consumed at the next boot before any DB
// opens (apply.ts). Paths are relative to userData.
export interface PendingRestore {
	snapshotId: string;
	stagedAt: number;
	sets: BackupSetId[];
	// Staged relative path → live relative path (file or directory).
	moves: Array<{ from: string; to: string; kind: 'file' | 'dir' }>;
	// Prefix remap for source_link.file_path / library_folder.path, applied
	// to the restored curator.db at boot.
	remap: { from: string; to: string } | null;
	rendererSettings: string | null;   // staged renderer-settings.json
	tokens: string | null;             // staged tokens.enc
}

// ─── Engine configuration (worker `init` / inline host) ─────────────────────

export interface BackupEngineConfig {
	userDataDir: string;
	// Directory holding curator.db + siblings (differs from userData under
	// CURATOR_DB_URL).
	dbDir: string;
	peaksDir: string;
	coversDir: string;
	libraryId: string;
	hostname: string;
	platform: string;
	appVersion: string;
	rekordboxDbPath: string | null;
	rekordboxSettingsDir: string | null;
}

export interface BackupRunPlan {
	runId: string;
	target: BackupTargetConfig;
	sets: BackupSetId[];
	keep: number;
}

// ─── Host seam (engine in-process vs in the worker) ─────────────────────────

export interface BackupHost {
	run(plan: BackupRunPlan): Promise<BackupRunResult>;
	cancel(runId: string): Promise<void>;
	listSnapshots(target: BackupTargetConfig, opts?: { refresh?: boolean }): Promise<BackupSnapshotSummary[]>;
	pin(target: BackupTargetConfig, snapshotId: string, label: string | null): Promise<void>;
	deleteSnapshot(target: BackupTargetConfig, snapshotId: string): Promise<void>;
	targetStat(target: BackupTargetConfig): Promise<BackupTargetStat>;
	restorePreview(target: BackupTargetConfig, snapshotId: string): Promise<Omit<BackupRestorePreview, 'rekordboxRunning' | 'sameMachine'>>;
	restoreStage(runId: string, target: BackupTargetConfig, req: BackupRestoreRequest): Promise<BackupRunResult>;
	restoreTracks(runId: string, target: BackupTargetConfig, req: BackupRestoreRequest): Promise<BackupRunResult>;
	restoreRekordbox(runId: string, target: BackupTargetConfig, req: BackupRestoreRequest): Promise<BackupRunResult>;
	// Progress for every op above; returns the unsubscribe fn.
	onEvent(cb: (e: BackupEvent) => void): () => void;
	stop(): Promise<void>;
}

// Token rows exported for the machine-bound sidecar (main-side only).
export interface ExportedTokenRow {
	source: string;
	kind: string;
	scope: string;
	value: string;
	expiresAt: number | null;
	fetchedAt: number;
	meta: Record<string, unknown> | null;
}
