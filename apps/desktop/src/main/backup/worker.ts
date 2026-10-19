// Backup worker — Electron utility process hosting the backup engine
// (apps/core/src/backup/engine.ts). Runs out-of-process because a backup
// run is the heaviest thing the app does: VACUUM INTO of a 1 GB mir.db is a
// synchronous better-sqlite3 call, hashing 190 GB of FLAC is pure I/O + CPU,
// and zstd + uploads saturate a core — none of it may touch main's event
// loop. Bundled to backup-worker.cjs (electron.vite.config.ts); driven by
// UtilityBackupHost (host.ts) over parentPort.
//
// What crosses the port: requests {id, op, …} → replies {id, ok, …};
// engine progress as {kind:'progress'}; log records as {kind:'log'}; and
// a reverse host-call for the short-lived Drive access token (the refresh
// token never leaves main). Config arrives in `init`, never via env.

import { setPriority, constants as osConstants } from 'node:os';
import { BackupEngine, setCoreLogger, type BackupEngineConfig, type BackupRestoreRequest, type BackupRunPlan, type BackupTargetConfig } from '@curator/core';
import { createLogger, isLogLevel } from '@curator/shared/log';

type WorkerRequest =
	| { id: number; op: 'init'; cfg: BackupEngineConfig; hasGoogle: boolean }
	| { id: number; op: 'run'; plan: BackupRunPlan }
	| { id: number; op: 'cancel'; runId: string }
	| { id: number; op: 'list-snapshots'; target: BackupTargetConfig; refresh?: boolean }
	| { id: number; op: 'pin'; target: BackupTargetConfig; snapshotId: string; label: string | null }
	| { id: number; op: 'delete-snapshot'; target: BackupTargetConfig; snapshotId: string }
	| { id: number; op: 'target-stat'; target: BackupTargetConfig }
	| { id: number; op: 'restore-preview'; target: BackupTargetConfig; snapshotId: string }
	| { id: number; op: 'restore-stage' | 'restore-tracks' | 'restore-rekordbox'; runId: string; target: BackupTargetConfig; req: BackupRestoreRequest }
	| { id: number; op: 'stop' }
	| { kind: 'host-result'; id: number; value: unknown }
	| { kind: 'host-error'; id: number; message: string };

function post(frame: Record<string, unknown>): void {
	process.parentPort.postMessage(frame);
}

// Port-forwarding logger: main owns the single JSONL timeline. Records are
// stamped proc:'core' (the engine IS core code; the area is 'backup').
setCoreLogger(createLogger({
	proc: 'core',
	level: isLogLevel(process.env['CURATOR_LOG_LEVEL']) ? process.env['CURATOR_LOG_LEVEL'] : process.env['ELECTRON_RENDERER_URL'] ? 'debug' : 'info',
	sinks: [{ write: (record) => post({ kind: 'log', record }) }],
}));

// Hashing 190 GB should never make the UI stutter.
try { setPriority(osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted — fine */ }

// Reverse RPC (worker → main): one pending map, correlated by id.
let nextHostCallId = 1;
const hostCalls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function hostCall<T>(method: string, args: unknown[] = []): Promise<T> {
	const id = nextHostCallId++;
	return new Promise<T>((resolve, reject) => {
		hostCalls.set(id, { resolve: resolve as (v: unknown) => void, reject });
		post({ kind: 'host-call', id, method, args });
	});
}

let engine: BackupEngine | null = null;

process.parentPort.on('message', (e) => {
	const msg = e.data as WorkerRequest;
	if ('kind' in msg) {
		const p = hostCalls.get(msg.id);
		if (!p) return;
		hostCalls.delete(msg.id);
		if (msg.kind === 'host-result') p.resolve(msg.value);
		else p.reject(new Error(msg.message));
		return;
	}
	void dispatch(msg);
});

async function dispatch(msg: Exclude<WorkerRequest, { kind: string }>): Promise<void> {
	try {
		if (msg.op === 'init') {
			engine?.close();
			engine = new BackupEngine(msg.cfg, msg.hasGoogle ? { googleAccessToken: () => hostCall<string>('google.accessToken') } : {});
			engine.subscribe((event) => post({ kind: 'progress', event }));
			post({ id: msg.id, ok: true });
			return;
		}
		if (msg.op === 'stop') {
			engine?.cancelActive();
			engine?.close();
			engine = null;
			post({ id: msg.id, ok: true });
			return;
		}
		if (!engine) throw new Error('backup worker not initialized');
		switch (msg.op) {
			case 'run':
				post({ id: msg.id, ok: true, result: await engine.run(msg.plan) });
				return;
			case 'cancel':
				engine.cancel(msg.runId);
				post({ id: msg.id, ok: true });
				return;
			case 'list-snapshots':
				post({ id: msg.id, ok: true, result: await engine.listSnapshots(msg.target, { refresh: msg.refresh }) });
				return;
			case 'pin':
				await engine.pin(msg.target, msg.snapshotId, msg.label);
				post({ id: msg.id, ok: true });
				return;
			case 'delete-snapshot':
				await engine.deleteSnapshot(msg.target, msg.snapshotId);
				post({ id: msg.id, ok: true });
				return;
			case 'target-stat':
				post({ id: msg.id, ok: true, result: await engine.targetStat(msg.target) });
				return;
			case 'restore-preview':
				post({ id: msg.id, ok: true, result: await engine.restorePreview(msg.target, msg.snapshotId) });
				return;
			case 'restore-stage':
				post({ id: msg.id, ok: true, result: await engine.restoreStage(msg.runId, msg.target, msg.req) });
				return;
			case 'restore-tracks':
				post({ id: msg.id, ok: true, result: await engine.restoreTracks(msg.runId, msg.target, msg.req) });
				return;
			case 'restore-rekordbox':
				post({ id: msg.id, ok: true, result: await engine.restoreRekordbox(msg.runId, msg.target, msg.req) });
				return;
		}
	} catch (err) {
		post({ id: msg.id, ok: false, message: err instanceof Error ? err.message : String(err) });
	}
}
