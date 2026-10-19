// UtilityBackupHost — desktop implementation of core's BackupHost over an
// Electron utility process (worker.ts). Shape follows workspace/host.ts
// (lazy fork, id-correlated request/response) plus core-sidecar/host.ts
// (reverse host-call, forwarded log records).
//
// No watchdog on run/restore ops: a VACUUM INTO of mir.db legitimately
// blocks the worker for tens of seconds, and uploads of 190 GB take days.
// Cancel is cooperative (the engine's AbortController); if the worker does
// not come back within a grace period after cancel it is killed, and the
// journal in backup.db makes the next run resume.

import { utilityProcess, type UtilityProcess } from 'electron';
import type {
	BackupEngineConfig, BackupEvent, BackupHost, BackupRestorePreview, BackupRestoreRequest, BackupRunPlan, BackupRunResult,
	BackupSnapshotSummary, BackupTargetConfig, BackupTargetStat,
} from '@curator/core';
import { mainLog } from '../log.js';
import { getGoogleAccessToken } from './google-auth.js';

const blog = mainLog.for('backup-host');

const ADMIN_TIMEOUT_MS = 120_000;      // list/pin/delete/stat/preview: Drive listings can take a while
const CANCEL_GRACE_MS = 10_000;

interface Pending {
	resolve: (frame: Record<string, unknown>) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout | null;
}

export class UtilityBackupHost implements BackupHost {
	private proc: UtilityProcess | null = null;
	private ready: Promise<void> | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private listeners = new Set<(e: BackupEvent) => void>();
	private stopped = false;
	private cancelTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly workerPath: string,
		private readonly cfg: BackupEngineConfig,
		private readonly hasGoogle: boolean,
	) {}

	private async spawnIfNeeded(): Promise<void> {
		if (this.stopped) throw new Error('backup host stopped');
		if (this.proc && this.ready) return this.ready;
		const proc = utilityProcess.fork(this.workerPath, [], { serviceName: 'curator-backup', stdio: 'pipe' });
		this.proc = proc;
		proc.on('message', (data: unknown) => this.onMessage(data as Record<string, unknown>));
		proc.on('exit', (code: number) => this.onExit(proc, code));
		proc.on('error', (type: string, location: string) => blog.error('worker fatal', undefined, { type, location }));
		if (proc.stderr) {
			proc.stderr.setEncoding('utf8');
			proc.stderr.on('data', (chunk: string) => process.stderr.write(`[backup] ${chunk}`));
		}
		this.ready = this.request({ op: 'init', cfg: this.cfg, hasGoogle: this.hasGoogle }, ADMIN_TIMEOUT_MS).then(() => undefined);
		return this.ready;
	}

	private request(body: Record<string, unknown>, timeoutMs: number | null): Promise<Record<string, unknown>> {
		const proc = this.proc;
		if (!proc) return Promise.reject(new Error('backup worker not running'));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = timeoutMs == null ? null : setTimeout(() => {
				blog.warn('request timed out — killing backup worker', { op: String(body['op']), timeoutMs });
				this.killAndReset('request timeout');
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				proc.postMessage({ id, ...body });
			} catch (err) {
				if (timer) clearTimeout(timer);
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private onMessage(frame: Record<string, unknown>): void {
		switch (frame['kind']) {
			case 'progress':
				for (const l of this.listeners) { try { l(frame['event'] as BackupEvent); } catch (err) { blog.error('listener threw', err instanceof Error ? err : undefined); } }
				return;
			case 'log':
				mainLog.emit(frame['record'] as Parameters<typeof mainLog.emit>[0]);
				return;
			case 'host-call':
				void this.handleHostCall(frame as { id: number; method: string; args: unknown[] });
				return;
		}
		const id = frame['id'];
		if (typeof id !== 'number') return;
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		if (p.timer) clearTimeout(p.timer);
		if (frame['ok']) p.resolve(frame);
		else p.reject(new Error(String(frame['message'] ?? 'backup worker error')));
	}

	private async handleHostCall(frame: { id: number; method: string; args: unknown[] }): Promise<void> {
		const proc = this.proc;
		if (!proc) return;
		try {
			if (frame.method !== 'google.accessToken') throw new Error(`unknown host-call: ${frame.method}`);
			const value = await getGoogleAccessToken();
			proc.postMessage({ kind: 'host-result', id: frame.id, value });
		} catch (err) {
			try { proc.postMessage({ kind: 'host-error', id: frame.id, message: err instanceof Error ? err.message : String(err) }); } catch { /* worker gone */ }
		}
	}

	private killAndReset(reason: string): void {
		const proc = this.proc;
		this.proc = null;
		this.ready = null;
		for (const [, p] of this.pending) {
			if (p.timer) clearTimeout(p.timer);
			p.reject(new Error(`backup worker reset (${reason})`));
		}
		this.pending.clear();
		try { proc?.kill(); } catch { /* already dying */ }
	}

	private onExit(proc: UtilityProcess, code: number): void {
		if (this.proc !== proc) return;
		blog.warn('worker exited', { code, inFlight: this.pending.size });
		this.killAndReset(`worker exited, code=${code}`);
	}

	async run(plan: BackupRunPlan): Promise<BackupRunResult> {
		await this.spawnIfNeeded();
		const frame = await this.request({ op: 'run', plan }, null);
		return frame['result'] as BackupRunResult;
	}

	async cancel(runId: string): Promise<void> {
		if (!this.proc) return;
		await this.request({ op: 'cancel', runId }, ADMIN_TIMEOUT_MS);
		// Cooperative cancel should unwind the run promptly; a worker stuck
		// in a sync VACUUM finishes that first. Past the grace, kill it —
		// the journal makes the next run resume.
		if (this.cancelTimer) clearTimeout(this.cancelTimer);
		this.cancelTimer = setTimeout(() => {
			this.cancelTimer = null;
			const stillRunning = [...this.pending.values()].length > 0;
			if (stillRunning) { blog.warn('cancel grace elapsed — killing backup worker'); this.killAndReset('cancel grace elapsed'); }
		}, CANCEL_GRACE_MS * 6);
		this.cancelTimer.unref?.();
	}

	async listSnapshots(target: BackupTargetConfig, opts?: { refresh?: boolean }): Promise<BackupSnapshotSummary[]> {
		await this.spawnIfNeeded();
		const frame = await this.request({ op: 'list-snapshots', target, refresh: opts?.refresh }, ADMIN_TIMEOUT_MS);
		return frame['result'] as BackupSnapshotSummary[];
	}

	async pin(target: BackupTargetConfig, snapshotId: string, label: string | null): Promise<void> {
		await this.spawnIfNeeded();
		await this.request({ op: 'pin', target, snapshotId, label }, ADMIN_TIMEOUT_MS);
	}

	async deleteSnapshot(target: BackupTargetConfig, snapshotId: string): Promise<void> {
		await this.spawnIfNeeded();
		await this.request({ op: 'delete-snapshot', target, snapshotId }, ADMIN_TIMEOUT_MS);
	}

	async targetStat(target: BackupTargetConfig): Promise<BackupTargetStat> {
		await this.spawnIfNeeded();
		const frame = await this.request({ op: 'target-stat', target }, ADMIN_TIMEOUT_MS);
		return frame['result'] as BackupTargetStat;
	}

	async restorePreview(target: BackupTargetConfig, snapshotId: string): Promise<Omit<BackupRestorePreview, 'rekordboxRunning' | 'sameMachine'>> {
		await this.spawnIfNeeded();
		const frame = await this.request({ op: 'restore-preview', target, snapshotId }, ADMIN_TIMEOUT_MS);
		return frame['result'] as Omit<BackupRestorePreview, 'rekordboxRunning' | 'sameMachine'>;
	}

	private async restoreOp(op: 'restore-stage' | 'restore-tracks' | 'restore-rekordbox', runId: string, target: BackupTargetConfig, req: BackupRestoreRequest): Promise<BackupRunResult> {
		await this.spawnIfNeeded();
		const frame = await this.request({ op, runId, target, req }, null);
		return frame['result'] as BackupRunResult;
	}

	restoreStage(runId: string, target: BackupTargetConfig, req: BackupRestoreRequest): Promise<BackupRunResult> { return this.restoreOp('restore-stage', runId, target, req); }
	restoreTracks(runId: string, target: BackupTargetConfig, req: BackupRestoreRequest): Promise<BackupRunResult> { return this.restoreOp('restore-tracks', runId, target, req); }
	restoreRekordbox(runId: string, target: BackupTargetConfig, req: BackupRestoreRequest): Promise<BackupRunResult> { return this.restoreOp('restore-rekordbox', runId, target, req); }

	onEvent(cb: (e: BackupEvent) => void): () => void {
		this.listeners.add(cb);
		return () => { this.listeners.delete(cb); };
	}

	// Graceful: ask the worker to cancel + close its DB, then kill. Bounded
	// so app quit never waits on a stuck upload.
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.cancelTimer) { clearTimeout(this.cancelTimer); this.cancelTimer = null; }
		if (this.proc) {
			await Promise.race([
				this.request({ op: 'stop' }, null).catch(() => undefined),
				new Promise<void>((r) => setTimeout(r, 3000)),
			]);
		}
		this.killAndReset('shutdown');
	}
}
