// UtilityWorkspaceHost — desktop implementation of core's WorkspaceHost over
// an Electron utility process (worker.ts). The whole point vs the inline
// host: proc.kill() is an OS-level kill that stops better-sqlite3 mid-
// sqlite3_step, so a runaway agent query costs one watchdog timeout, not a
// wedged main loop. A kill loses every session's workspace (TEMP schemas die
// with their connections) — surfaced as WorkspaceResetError, which the tool
// layer turns into an honest "workspace was reset, re-load your tables".
//
// Spawn/respawn shape mirrors the ingest pool; lazy: the worker is forked on
// first use and re-forked on the call after a kill.

import { utilityProcess, type UtilityProcess } from 'electron';
import { WorkspaceResetError, type WorkspaceColumn, type WorkspaceDbPaths, type WorkspaceHost, type WorkspaceQueryResult } from '@curator/core';
import { mainLog } from '../log.js';

const wlog = mainLog.for('workspace');

const QUERY_TIMEOUT_MS = 10_000;
const LOAD_TIMEOUT_MS = 30_000;
const ADMIN_TIMEOUT_MS = 10_000;

interface Pending {
	resolve: (frame: Record<string, unknown>) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

export class UtilityWorkspaceHost implements WorkspaceHost {
	private proc: UtilityProcess | null = null;
	private ready: Promise<void> | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private stopped = false;

	constructor(
		private readonly workerPath: string,
		private readonly paths: WorkspaceDbPaths,
	) {}

	private async spawnIfNeeded(): Promise<void> {
		if (this.stopped) throw new Error('workspace host stopped');
		if (this.proc && this.ready) return this.ready;
		const proc = utilityProcess.fork(this.workerPath, [], { serviceName: 'curator-workspace', stdio: 'pipe' });
		this.proc = proc;
		proc.on('message', (data: unknown) => this.onMessage(data as Record<string, unknown>));
		proc.on('exit', (code: number) => this.onExit(proc, code));
		proc.on('error', (type: string, location: string) => {
			wlog.error('worker fatal', undefined, { type, location });
		});
		if (proc.stderr) {
			proc.stderr.setEncoding('utf8');
			proc.stderr.on('data', (chunk: string) => process.stderr.write(`[workspace] ${chunk}`));
		}
		this.ready = this.request({ op: 'init', paths: this.paths }, ADMIN_TIMEOUT_MS).then(() => undefined);
		return this.ready;
	}

	private request(body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
		const proc = this.proc;
		if (!proc) return Promise.reject(new WorkspaceResetError('workspace worker not running'));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				// Watchdog: the only way to stop a sync SQLite call is to kill
				// the process. Everything in flight (and every session's TEMP
				// schema) goes with it — reject all as reset.
				wlog.warn('watchdog timeout — killing workspace worker', { op: String(body['op']), timeoutMs });
				this.killAndReset('watchdog timeout');
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				proc.postMessage({ id, ...body });
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private onMessage(frame: Record<string, unknown>): void {
		const id = frame['id'];
		if (typeof id !== 'number') return;
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		clearTimeout(p.timer);
		if (frame['ok']) p.resolve(frame);
		else p.reject(new Error(String(frame['message'] ?? 'workspace error')));
	}

	private killAndReset(reason: string): void {
		const proc = this.proc;
		this.proc = null;
		this.ready = null;
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new WorkspaceResetError(`workspace was reset (${reason}) — all loaded tables are gone; re-load what you need`));
		}
		this.pending.clear();
		try { proc?.kill(); } catch { /* already dying */ }
	}

	private onExit(proc: UtilityProcess, code: number): void {
		if (this.proc !== proc) return; // already replaced/killed by the watchdog
		wlog.warn('worker exited', { code, inFlight: this.pending.size });
		this.killAndReset(`worker exited, code=${code}`);
	}

	async ensure(sessionId: string): Promise<{ tables: string[] }> {
		await this.spawnIfNeeded();
		const frame = await this.request({ op: 'ensure', sessionId }, ADMIN_TIMEOUT_MS);
		return { tables: (frame['tables'] as string[]) ?? [] };
	}

	async loadBegin(sessionId: string, table: string, columns: WorkspaceColumn[]): Promise<void> {
		await this.spawnIfNeeded();
		await this.request({ op: 'load-begin', sessionId, table, columns }, LOAD_TIMEOUT_MS);
	}

	async loadRows(sessionId: string, table: string, rows: unknown[][]): Promise<void> {
		await this.spawnIfNeeded();
		await this.request({ op: 'load-rows', sessionId, table, rows }, LOAD_TIMEOUT_MS);
	}

	async loadEnd(sessionId: string, table: string): Promise<{ rowCount: number }> {
		await this.spawnIfNeeded();
		const frame = await this.request({ op: 'load-end', sessionId, table }, LOAD_TIMEOUT_MS);
		return { rowCount: frame['rowCount'] as number };
	}

	async query(sessionId: string, sql: string, maxRows: number): Promise<WorkspaceQueryResult> {
		await this.spawnIfNeeded();
		const frame = await this.request({ op: 'query', sessionId, sql, maxRows }, QUERY_TIMEOUT_MS);
		return frame['result'] as WorkspaceQueryResult;
	}

	async drop(sessionId: string): Promise<void> {
		if (!this.proc) return; // nothing live — nothing to drop
		await this.request({ op: 'drop', sessionId }, ADMIN_TIMEOUT_MS);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.killAndReset('shutdown');
	}
}
