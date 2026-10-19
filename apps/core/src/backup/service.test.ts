// BackupService against a fake host: settings validation (a cloud-sync
// folder is a legal TARGET), the run lifecycle + last-run bookkeeping, the
// scheduler's due/busy logic, and multi-phase restore folding.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { normalizePath } from '../local/scanner.js';
import { createBackupService, type BackupService } from './service.js';
import type { BackupEvent, BackupHost, BackupRunPlan, BackupRunResult } from './types.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Db;
let sqlite: Database.Database;
let host: FakeHost;
let busy: string | null;
let svc: BackupService;

class FakeHost implements BackupHost {
	runs: BackupRunPlan[] = [];
	restoreCalls: string[] = [];
	private listeners = new Set<(e: BackupEvent) => void>();
	// Resolve the next run with this result (default: a done snapshot).
	nextResult: Partial<BackupRunResult> = {};
	emit(e: BackupEvent): void { for (const l of this.listeners) l(e); }
	private result(op: 'backup' | 'restore', runId: string, extra: Partial<BackupRunResult>): BackupRunResult {
		const r: BackupRunResult = { snapshotId: op === 'backup' ? 'snap-1' : null, unchanged: false, cancelled: false, files: 3, bytes: 300, newObjects: 1, newBytes: 100, warnings: [], durationMs: 5, ...extra };
		this.emit({ kind: 'completed', runId, op, result: r });
		return r;
	}
	async run(plan: BackupRunPlan): Promise<BackupRunResult> {
		this.runs.push(plan);
		this.emit({ kind: 'started', runId: plan.runId, op: 'backup', sets: plan.sets });
		await Promise.resolve();
		return this.result('backup', plan.runId, this.nextResult);
	}
	async cancel(): Promise<void> {}
	async listSnapshots() { return []; }
	async pin(): Promise<void> {}
	async deleteSnapshot(): Promise<void> {}
	async targetStat() { return { quotaBytes: null, usedBytes: null, freeBytes: null, account: null }; }
	async restorePreview() {
		return { snapshotId: 's', createdAt: 0, hostname: 'h', sets: {} as never, roots: { userData: '', rekordboxDir: null, rekordboxSettingsDir: null, libraryFolders: [] }, tracksRoot: 'c:/music', freeBytes: null };
	}
	async restoreStage(runId: string): Promise<BackupRunResult> {
		this.restoreCalls.push('stage');
		this.emit({ kind: 'started', runId, op: 'restore', sets: ['core'] });
		return this.result('restore', runId, { relaunchRequired: true, files: 2, bytes: 20 });
	}
	async restoreTracks(runId: string): Promise<BackupRunResult> {
		this.restoreCalls.push('tracks');
		this.emit({ kind: 'started', runId, op: 'restore', sets: ['tracks'] });
		return this.result('restore', runId, { written: 4, skipped: 1, files: 5, bytes: 50 });
	}
	async restoreRekordbox(runId: string): Promise<BackupRunResult> {
		this.restoreCalls.push('rekordbox');
		return this.result('restore', runId, { files: 1, bytes: 10 });
	}
	onEvent(cb: (e: BackupEvent) => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
	async stop(): Promise<void> {}
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-backup-svc-'));
	migrate(join(dir, 'curator.db'));
	({ db, sqlite } = createDb(join(dir, 'curator.db')));
	host = new FakeHost();
	busy = null;
	svc = createBackupService({
		db,
		userDataDir: dir,
		host,
		engineConfig: () => ({ userDataDir: dir, dbDir: dir, peaksDir: join(dir, 'peaks'), coversDir: join(dir, 'covers'), libraryId: 'lib', hostname: 'h', platform: 'win32', appVersion: 't', rekordboxDbPath: null, rekordboxSettingsDir: null }),
		heavyJobInFlight: () => busy,
		rekordbox: { available: () => true, detect: async () => ({ dbPath: join(dir, 'master.db'), running: false }), preRestoreCopy: async () => {} },
		remapLibraryRoot: async () => ({ links: 1, folders: 1 }),
	});
});

afterEach(() => {
	svc.stop();
	vi.useRealTimers();
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('settings', () => {
	it('starts disabled with the documented defaults and reports available', async () => {
		const s = svc.getSettings();
		expect(s.enabled).toBe(false);
		expect(s.target).toBeNull();
		expect(s.keep).toBe(7);
		expect(s.intervalHours).toBe(24);
		expect(s.sets).toEqual({ core: true, peaks: true, embeddings: true, covers: false, rekordboxDb: true, rekordboxAnalysis: true, tracks: false });
		expect((await svc.getStatus()).available).toBe(true);
	});

	it('normalizes + probes a folder target, accepts a cloud-sync folder, forces core on and clamps numbers', async () => {
		const target = join(dir, 'Google Drive', 'Curator Backups');
		const s = await svc.setSettings({ target: { kind: 'folder', path: target }, sets: { core: false } as never, keep: 500, intervalHours: 0 });
		expect(s.target).toEqual({ kind: 'folder', path: normalizePath(target) });
		expect(s.sets.core).toBe(true);
		expect(s.keep).toBe(100);
		expect(s.intervalHours).toBe(24);
		// Persisted: a fresh service over the same DB sees it.
		const again = createBackupService({ db, userDataDir: dir, host: null, engineConfig: () => { throw new Error('unused'); }, heavyJobInFlight: () => null, rekordbox: { available: () => false, detect: async () => ({ dbPath: null, running: false }), preRestoreCopy: async () => {} }, remapLibraryRoot: async () => ({ links: 0, folders: 0 }) });
		expect(again.getSettings().target).toEqual(s.target);
		expect((await again.getStatus()).available).toBe(false);
		await expect(svc.setSettings({ target: { kind: 'folder', path: 'relative/path' } })).rejects.toThrow(/absolute/);
	});
});

describe('runs', () => {
	it('runs now with the enabled sets and records the last run + success time', async () => {
		await svc.setSettings({ target: { kind: 'folder', path: join(dir, 'target') }, sets: { tracks: true } as never });
		await expect(svc.runNow()).resolves.toEqual({ runId: expect.any(String) });
		expect(host.runs).toHaveLength(1);
		expect(host.runs[0]!.sets).toEqual(['core', 'peaks', 'embeddings', 'rekordboxDb', 'rekordboxAnalysis', 'tracks']);
		expect(host.runs[0]!.keep).toBe(7);
		await flush();
		const st = await svc.getStatus();
		expect(st.running).toBeNull();
		expect(st.lastRun?.status).toBe('done');
		expect(st.lastRun?.snapshotId).toBe('snap-1');
		expect(st.lastSuccessAt).toBeTypeOf('number');
	});

	it('refuses without a target and while a run is active', async () => {
		await expect(svc.runNow()).rejects.toThrow(/location/);
		await svc.setSettings({ target: { kind: 'folder', path: join(dir, 'target') } });
		// Hold the fake host's run open.
		let release!: () => void;
		host.run = async (plan) => { host.emit({ kind: 'started', runId: plan.runId, op: 'backup', sets: plan.sets }); await new Promise<void>((r) => { release = r; }); return { snapshotId: null, unchanged: true, cancelled: false, files: 0, bytes: 0, newObjects: 0, newBytes: 0, warnings: [], durationMs: 0 }; };
		await svc.runNow();
		expect((await svc.getStatus()).running?.op).toBe('backup');
		await expect(svc.runNow()).rejects.toThrow(/already running/);
		release();
	});

	it('an unchanged run still counts as a success for the schedule', async () => {
		await svc.setSettings({ target: { kind: 'folder', path: join(dir, 'target') } });
		host.nextResult = { unchanged: true, snapshotId: null, newObjects: 0, newBytes: 0 };
		await svc.runNow();
		await flush();
		const st = await svc.getStatus();
		expect(st.lastRun?.status).toBe('unchanged');
		expect(st.lastSuccessAt).toBeTypeOf('number');
	});
});

describe('scheduler', () => {
	it('runs when overdue after the launch delay, yields to heavy jobs, and respects the interval', async () => {
		vi.useFakeTimers();
		await svc.setSettings({ enabled: true, target: { kind: 'folder', path: join(dir, 'target') }, intervalHours: 24 });
		svc.startScheduler();
		busy = 'audio analysis';
		await vi.advanceTimersByTimeAsync(2 * 60_000 + 10);
		expect(host.runs).toHaveLength(0);
		expect((await svc.getStatus()).waitingFor).toBe('audio analysis');
		busy = null;
		await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
		expect(host.runs).toHaveLength(1);
		await flush();
		expect((await svc.getStatus()).waitingFor).toBeNull();
		// Not due again for 24 h.
		await vi.advanceTimersByTimeAsync(12 * 3600_000);
		expect(host.runs).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(13 * 3600_000);
		expect(host.runs).toHaveLength(2);
	});

	it('does nothing while disabled', async () => {
		vi.useFakeTimers();
		await svc.setSettings({ enabled: false, target: { kind: 'folder', path: join(dir, 'target') } });
		svc.startScheduler();
		await vi.advanceTimersByTimeAsync(48 * 3600_000);
		expect(host.runs).toHaveLength(0);
	});
});

describe('restore', () => {
	it('runs tracks → rekordbox → stage as one run and reports a single merged completion', async () => {
		await svc.setSettings({ target: { kind: 'folder', path: join(dir, 'target') } });
		const events: BackupEvent[] = [];
		svc.subscribe((e) => events.push(e));
		const r = await svc.restore({ snapshotId: 's', sets: ['core', 'tracks', 'rekordboxDb'], tracks: { mode: 'original' } });
		expect(r.relaunchRequired).toBe(true);
		await flush();
		expect(host.restoreCalls).toEqual(['tracks', 'rekordbox', 'stage']);
		const completed = events.filter((e) => e.kind === 'completed');
		expect(completed).toHaveLength(1);
		const result = (completed[0] as Extract<BackupEvent, { kind: 'completed' }>).result;
		expect(result.files).toBe(8);
		expect(result.written).toBe(4);
		expect(result.relaunchRequired).toBe(true);
		expect((await svc.getStatus()).lastRun?.op).toBe('restore');
	});

	it('refuses rekordbox sets while rekordbox runs', async () => {
		const running = createBackupService({ db, userDataDir: dir, host, engineConfig: () => { throw new Error('unused'); }, heavyJobInFlight: () => null, rekordbox: { available: () => true, detect: async () => ({ dbPath: 'x', running: true }), preRestoreCopy: async () => {} }, remapLibraryRoot: async () => ({ links: 0, folders: 0 }) });
		await running.setSettings({ target: { kind: 'folder', path: join(dir, 'target') } });
		await expect(running.restore({ snapshotId: 's', sets: ['rekordboxDb'] })).rejects.toThrow(/Close rekordbox/);
		running.stop();
	});
});
