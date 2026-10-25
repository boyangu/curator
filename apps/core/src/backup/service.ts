// BackupService — the CoreService-facing half of backup & restore: settings
// (app_setting), status, the scheduler and its busy gate, and restore
// orchestration. Talks to the engine only through BackupHost, so it is the
// same code whether the engine runs inline (tests) or in the desktop's
// utilityProcess. Cheap by construction — nothing here reads a file bigger
// than a JSON marker.

import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appSetting } from '@curator/shared/schema';
import type { Db } from '../db/client.js';
import { log } from '../log.js';
import { setSetting } from '../library/mutators.js';
import { normalizePath } from '../local/scanner.js';
import { clearRestoreApplied, readPendingRestore, readRestoreApplied } from './apply.js';
import { probeFolderTarget } from './targets/folder.js';
import {
	BACKUP_SET_IDS, DEFAULT_BACKUP_SETTINGS,
	type BackupEngineConfig, type BackupEvent, type BackupHost, type BackupLastRun, type BackupRestorePreview, type BackupRestoreRequest,
	type BackupRunResult, type BackupRunning, type BackupSetId, type BackupSettings, type BackupSnapshotSummary, type BackupStatus, type GoogleAuthStatus,
} from './types.js';

const slog = log.for('backup-service');

const SETTINGS_KEY = 'backup.settings';
const LAST_RUN_KEY = 'backup.last_run';
const LAST_SUCCESS_KEY = 'backup.last_success_at';

// Overdue-at-launch check waits for the scanner + feed poll to settle; then
// a coarse tick — the interval is hours, so minutes of slack are fine.
const FIRST_CHECK_MS = 2 * 60_000;
const TICK_MS = 5 * 60_000;

const CURATOR_DATA_SETS: readonly BackupSetId[] = ['core', 'peaks', 'embeddings', 'covers'];
const REKORDBOX_SETS: readonly BackupSetId[] = ['rekordboxDb', 'rekordboxAnalysis'];

export interface BackupServiceDeps {
	db: Db;
	userDataDir: string;
	// null ⇒ no engine host injected: the feature reports unavailable.
	host: BackupHost | null;
	engineConfig: () => BackupEngineConfig;
	heavyJobInFlight: () => string | null;
	// Desktop-only pre-run work (renderer settings export, token sidecar).
	beforeRun?: () => Promise<void>;
	google?: { status(): GoogleAuthStatus; needsReconnect(): boolean };
	rekordbox: {
		available: () => boolean;
		detect: () => Promise<{ dbPath: string | null; running: boolean }>;
		// The existing pre-write copy (master_<ts>.db beside master.db).
		preRestoreCopy: (dbPath: string) => Promise<void>;
	};
	remapLibraryRoot: (from: string, to: string) => Promise<{ links: number; folders: number }>;
	now?: () => number;
}

export interface BackupService {
	getSettings(): BackupSettings;
	setSettings(patch: Partial<BackupSettings>): Promise<BackupSettings>;
	getStatus(): Promise<BackupStatus>;
	listSnapshots(opts?: { refresh?: boolean }): Promise<BackupSnapshotSummary[]>;
	runNow(): Promise<{ runId: string }>;
	cancel(runId: string): Promise<void>;
	pin(snapshotId: string, label: string | null): Promise<void>;
	deleteSnapshot(snapshotId: string): Promise<void>;
	restorePreview(snapshotId: string): Promise<BackupRestorePreview>;
	restore(req: BackupRestoreRequest): Promise<{ runId: string; relaunchRequired: boolean }>;
	startScheduler(): void;
	subscribe(cb: (e: BackupEvent) => void): () => void;
	// Settles once the engine host has stopped; never rejects.
	stop(): Promise<void>;
}

export function createBackupService(deps: BackupServiceDeps): BackupService {
	const { db } = deps;
	const now = deps.now ?? (() => Date.now());
	// The host is resolved on first use, never at construction: building it
	// reads this service's settings (rekordbox path), and the desktop's
	// utilityProcess host forks lazily anyway.
	let hostRef: BackupHost | null = null;
	const getHost = (): BackupHost | null => {
		if (!hostRef) {
			hostRef = deps.host;
			hostRef?.onEvent(onHostEvent);
		}
		return hostRef;
	};
	const subscribers = new Set<(e: BackupEvent) => void>();
	let running: BackupRunning | null = null;
	let waitingFor: string | null = null;
	let firstTimer: ReturnType<typeof setTimeout> | null = null;
	let tickTimer: ReturnType<typeof setInterval> | null = null;
	// A multi-phase restore (tracks → rekordbox → Curator data) reports as
	// ONE run: intermediate `completed` frames are folded, the last one is
	// forwarded with merged counts.
	let restoreFold: { runId: string; remaining: number; merged: BackupRunResult } | null = null;

	// ─── settings ───────────────────────────────────────────────────────

	const readJson = <T>(key: string): T | null => {
		const row = db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, key)).get();
		return (row?.value ?? null) as T | null;
	};
	const writeJson = (key: string, value: unknown): void => {
		const at = new Date();
		db.insert(appSetting).values({ key, value, updatedAt: at }).onConflictDoUpdate({ target: appSetting.key, set: { value, updatedAt: at } }).run();
	};
	const loadSettings = (): BackupSettings => {
		const stored = readJson<Partial<BackupSettings>>(SETTINGS_KEY) ?? {};
		const sets = { ...DEFAULT_BACKUP_SETTINGS.sets, ...(stored.sets ?? {}) };
		sets.core = true;
		return { ...DEFAULT_BACKUP_SETTINGS, ...stored, sets };
	};
	let settings = loadSettings();

	const emit = (e: BackupEvent): void => {
		for (const cb of subscribers) { try { cb(e); } catch (err) { slog.error('subscriber threw', err); } }
	};
	const emitStatus = (): void => {
		void getStatus().then((status) => emit({ kind: 'status', status })).catch(() => { /* status is best-effort */ });
	};

	const lastRun = (): BackupLastRun | null => readJson<BackupLastRun>(LAST_RUN_KEY);
	const lastSuccessAt = (): number | null => readJson<number>(LAST_SUCCESS_KEY);
	const recordRun = (run: BackupLastRun): void => {
		writeJson(LAST_RUN_KEY, run);
		if (run.op === 'backup' && (run.status === 'done' || run.status === 'unchanged')) writeJson(LAST_SUCCESS_KEY, run.at);
	};
	const nextDueAt = (): number | null => {
		if (!settings.enabled || !settings.target) return null;
		const last = lastSuccessAt();
		return last == null ? now() : last + settings.intervalHours * 3600_000;
	};

	// ─── host events → status + fan-out ─────────────────────────────────

	function onHostEvent(e: BackupEvent): void {
		if (e.kind === 'started') {
			running = { runId: e.runId, op: e.op, phase: 'collect', done: 0, total: 0, bytesDone: 0, bytesTotal: 0, current: null, stopping: false };
		} else if (e.kind === 'progress') {
			if (running?.runId === e.runId) running = { ...running, phase: e.phase, done: e.done, total: e.total, bytesDone: e.bytesDone, bytesTotal: e.bytesTotal, current: e.current };
		} else if (e.kind === 'completed' || e.kind === 'failed') {
			if (restoreFold && restoreFold.runId === e.runId) {
				if (e.kind === 'completed') {
					const m = restoreFold.merged;
					m.files += e.result.files; m.bytes += e.result.bytes; m.warnings.push(...e.result.warnings);
					m.written = (m.written ?? 0) + (e.result.written ?? 0); m.skipped = (m.skipped ?? 0) + (e.result.skipped ?? 0);
					m.cancelled ||= e.result.cancelled; m.relaunchRequired ||= e.result.relaunchRequired;
					if (--restoreFold.remaining > 0 && !e.result.cancelled) { emit({ kind: 'status', status: statusSync() }); return; }
					e = { kind: 'completed', runId: e.runId, op: 'restore', result: m };
				}
				restoreFold = null;
			}
			if (running?.runId === e.runId) running = null;
			const base = { at: now(), op: e.op, durationMs: e.kind === 'completed' ? e.result.durationMs : 0 };
			if (e.kind === 'completed') {
				recordRun({ ...base, status: e.result.cancelled ? 'cancelled' : e.result.unchanged ? 'unchanged' : 'done', snapshotId: e.result.snapshotId, message: e.result.warnings[0] ?? null, newBytes: e.result.newBytes });
			} else {
				recordRun({ ...base, status: 'failed', snapshotId: null, message: e.message, newBytes: 0 });
			}
		}
		emit(e);
		if (e.kind !== 'progress') emitStatus();
	}

	// ─── status ─────────────────────────────────────────────────────────

	const statusSync = (): BackupStatus => ({
		available: getHost() != null,
		settings: { ...settings, sets: { ...settings.sets } },
		google: deps.google?.status() ?? { configured: false, connected: false, email: null },
		lastRun: lastRun(),
		lastSuccessAt: lastSuccessAt(),
		nextDueAt: nextDueAt(),
		running,
		waitingFor,
		needsReconnect: deps.google?.needsReconnect() ?? false,
		pendingRestore: (() => { const m = readPendingRestore(deps.userDataDir); return m ? { snapshotId: m.snapshotId, stagedAt: m.stagedAt } : null; })(),
		restoreApplied: null,
	});

	async function getStatus(): Promise<BackupStatus> {
		const s = statusSync();
		const applied = await readRestoreApplied(deps.userDataDir);
		if (applied) {
			// The banner tells the user the old files are parked in the
			// pre-restore folder; once that folder is gone, so is the notice.
			if (!existsSync(applied.preRestoreDir)) await clearRestoreApplied(deps.userDataDir);
			else s.restoreApplied = { snapshotId: applied.snapshotId, preRestoreDir: applied.preRestoreDir, error: applied.error };
		}
		return s;
	}

	// ─── runs ───────────────────────────────────────────────────────────

	const requireHost = (): BackupHost => {
		const h = getHost();
		if (!h) throw new Error('Backup is not available in this build');
		return h;
	};
	const requireTarget = (): NonNullable<BackupSettings['target']> => {
		if (!settings.target) throw new Error('Choose a backup location first');
		return settings.target;
	};

	const startBackup = async (): Promise<{ runId: string }> => {
		const h = requireHost();
		const target = requireTarget();
		if (running) throw new Error(`A ${running.op} is already running`);
		await deps.beforeRun?.();
		const runId = randomUUID();
		const sets = BACKUP_SET_IDS.filter((s) => settings.sets[s]);
		running = { runId, op: 'backup', phase: 'collect', done: 0, total: 0, bytesDone: 0, bytesTotal: 0, current: null, stopping: false };
		waitingFor = null;
		h.run({ runId, target, sets, keep: settings.keep }).catch((err) => {
			// 'failed' already went out as an event; the promise rejection is
			// the same failure seen twice.
			slog.debug('run rejected', { runId, message: err instanceof Error ? err.message : String(err) });
		}).finally(() => { if (running?.runId === runId) running = null; });
		return { runId };
	};

	const tick = (): void => {
		if (!settings.enabled || !settings.target || running || !getHost()) return;
		if (readPendingRestore(deps.userDataDir)) return; // a relaunch is pending; don't snapshot a half-state
		const due = nextDueAt();
		if (due == null || now() < due) { waitingFor = null; return; }
		const busy = deps.heavyJobInFlight();
		if (busy) {
			if (waitingFor !== busy) { waitingFor = busy; emitStatus(); }
			return;
		}
		slog.info('scheduled backup due — starting');
		startBackup().catch((err) => slog.warn('scheduled backup could not start', undefined, err));
	};

	// ─── restore ────────────────────────────────────────────────────────

	async function restorePreview(snapshotId: string): Promise<BackupRestorePreview> {
		const h = requireHost();
		const target = requireTarget();
		const base = await h.restorePreview(target, snapshotId);
		const cfg = deps.engineConfig();
		const rb = deps.rekordbox.available() ? await deps.rekordbox.detect() : null;
		return { ...base, sameMachine: base.hostname === cfg.hostname, rekordboxRunning: rb ? rb.running : null };
	}

	async function restore(req: BackupRestoreRequest): Promise<{ runId: string; relaunchRequired: boolean }> {
		const h = requireHost();
		const target = requireTarget();
		if (running) throw new Error(`A ${running.op} is already running`);
		if (!req.sets.length) throw new Error('Nothing selected to restore');
		const curatorSets = req.sets.filter((s) => CURATOR_DATA_SETS.includes(s));
		const rbSets = req.sets.filter((s) => REKORDBOX_SETS.includes(s));
		const tracks = req.sets.includes('tracks');
		if (curatorSets.length && readPendingRestore(deps.userDataDir)) throw new Error('A restore is already staged — restart Curator to apply it first');
		let rbDbPath: string | null = null;
		if (rbSets.length) {
			if (!deps.rekordbox.available()) throw new Error('Restoring rekordbox data needs the rekordbox sidecar (it verifies rekordbox is closed)');
			const d = await deps.rekordbox.detect();
			if (d.running) throw new Error('Close rekordbox before restoring its data');
			rbDbPath = settings.rekordboxDbPath ?? d.dbPath;
			if (!rbDbPath) throw new Error('Rekordbox master.db not found; configure the path in Settings → Rekordbox');
		}
		const runId = randomUUID();
		const phases: Array<() => Promise<BackupRunResult>> = [];
		if (tracks) phases.push(() => h.restoreTracks(runId, target, req));
		if (rbSets.length) phases.push(async () => {
			if (existsSync(rbDbPath!)) await deps.rekordbox.preRestoreCopy(rbDbPath!);
			return h.restoreRekordbox(runId, target, { ...req, sets: rbSets });
		});
		if (curatorSets.length) phases.push(() => h.restoreStage(runId, target, req));
		restoreFold = { runId, remaining: phases.length, merged: { snapshotId: req.snapshotId, unchanged: false, cancelled: false, files: 0, bytes: 0, newObjects: 0, newBytes: 0, warnings: [], durationMs: 0, written: 0, skipped: 0 } };
		running = { runId, op: 'restore', phase: 'download', done: 0, total: 0, bytesDone: 0, bytesTotal: 0, current: null, stopping: false };
		void (async () => {
			try {
				for (const phase of phases) {
					const r = await phase();
					if (r.cancelled) return;
				}
				// Tracks moved to a new root without a DB restore: remap the
				// live DB now. (With a DB restore the marker carries the remap
				// and apply.ts does it against the restored file at boot.)
				if (tracks && !curatorSets.length && req.tracks?.mode === 'root') {
					const preview = await h.restorePreview(target, req.snapshotId);
					if (preview.tracksRoot) {
						const to = normalizePath(req.tracks.root).replace(/\/+$/, '');
						if (to !== preview.tracksRoot) {
							const r = await deps.remapLibraryRoot(preview.tracksRoot, to);
							slog.info('library root remapped', { from: preview.tracksRoot, to, ...r });
						}
					}
				}
			} catch (err) {
				slog.debug('restore phase rejected', { runId, message: err instanceof Error ? err.message : String(err) });
				restoreFold = null;
			} finally {
				if (running?.runId === runId) running = null;
			}
		})();
		return { runId, relaunchRequired: curatorSets.length > 0 };
	}

	// ─── public surface ─────────────────────────────────────────────────

	return {
		getSettings: () => ({ ...settings, sets: { ...settings.sets } }),

		async setSettings(patch) {
			const next: BackupSettings = { ...settings, ...patch, sets: { ...settings.sets, ...(patch.sets ?? {}) } };
			next.sets.core = true;
			next.keep = Math.max(1, Math.min(100, Math.round(Number(next.keep) || DEFAULT_BACKUP_SETTINGS.keep)));
			next.intervalHours = Math.max(1, Math.min(24 * 30, Math.round(Number(next.intervalHours) || DEFAULT_BACKUP_SETTINGS.intervalHours)));
			if (next.target?.kind === 'folder') {
				const raw = next.target.path.trim();
				if (!/^([A-Za-z]:[\\/]|\/)/.test(raw)) throw new Error('Backup folder must be an absolute path');
				const path = normalizePath(raw).replace(/\/+$/, '');
				// Deliberately NOT isCloudSyncPath(): a Drive-for-desktop /
				// Dropbox folder is a fine backup target — objects are
				// immutable, so the sync client's mtime games don't matter.
				await probeFolderTarget(path);
				next.target = { kind: 'folder', path };
			} else if (next.target?.kind === 'googledrive') {
				const folderName = next.target.folderName.trim().replace(/[\\/]/g, '-');
				if (!folderName) throw new Error('Google Drive folder name cannot be empty');
				next.target = { kind: 'googledrive', folderName };
			}
			if (next.rekordboxDbPath != null) next.rekordboxDbPath = next.rekordboxDbPath.trim() || null;
			settings = next;
			// Through the mutator: 'backup.settings' is an account-level key,
			// so the write also lands in the sync outbox.
			setSetting(db, SETTINGS_KEY, settings);
			emitStatus();
			return this.getSettings();
		},

		getStatus,

		async listSnapshots(opts) {
			return requireHost().listSnapshots(requireTarget(), opts);
		},

		runNow: startBackup,

		async cancel(runId) {
			if (running?.runId === runId) running = { ...running, stopping: true };
			await requireHost().cancel(runId);
			emitStatus();
		},

		async pin(snapshotId, label) {
			await requireHost().pin(requireTarget(), snapshotId, label);
		},

		async deleteSnapshot(snapshotId) {
			await requireHost().deleteSnapshot(requireTarget(), snapshotId);
		},

		restorePreview,
		restore,

		startScheduler() {
			if (firstTimer || tickTimer || !getHost()) return;
			firstTimer = setTimeout(() => { firstTimer = null; tick(); }, FIRST_CHECK_MS);
			tickTimer = setInterval(tick, TICK_MS);
			// Never keep the process alive for a backup tick.
			firstTimer.unref?.(); tickTimer.unref?.();
		},

		subscribe(cb) {
			subscribers.add(cb);
			return () => { subscribers.delete(cb); };
		},

		async stop() {
			if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
			if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
			await hostRef?.stop().catch(() => { /* best effort */ });
		},
	};
}

