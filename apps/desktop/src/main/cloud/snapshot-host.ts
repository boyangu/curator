// The desktop's SnapshotBuilder (core sync-log/snapshot-build.ts): each build
// in a fresh Electron utility process (snapshot-worker.ts), killed when it
// answers. One build at a time (the sync client single-flights its publish),
// at most a few a day, so there is nothing to gain from keeping the process:
// a fresh one also hands the build's memory back as soon as it is done.
//
// The parts land in a directory under `tmpRoot` (userData/snapshot-build);
// the sync client removes it after the upload. A build a crash or the
// watchdog cut short leaves its directory behind: the next build clears
// whatever is there first (nothing else writes under it).

import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { utilityProcess } from 'electron';
import type { SnapshotBuilder, SnapshotBuildResult } from '@curator/core';
import { mainLog } from '../log.js';

const slog = mainLog.for('snapshot-host');

// The main library's build is seconds; past this the worker is stuck
// (a locked file, a dead disk) and is killed.
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

export function createUtilitySnapshotBuilder(opts: { workerPath: string; dbPath: string; tmpRoot: string }): SnapshotBuilder {
	return async ({ userId }) => {
		await mkdir(opts.tmpRoot, { recursive: true });
		for (const name of await readdir(opts.tmpRoot)) await rm(join(opts.tmpRoot, name), { recursive: true, force: true }).catch(() => { /* in use: next time */ });
		const outDir = await mkdtemp(join(opts.tmpRoot, 'build-'));
		const proc = utilityProcess.fork(opts.workerPath, [], { serviceName: 'curator-snapshot', stdio: 'pipe' });
		if (proc.stderr) {
			proc.stderr.setEncoding('utf8');
			proc.stderr.on('data', (chunk: string) => process.stderr.write(`[snapshot] ${chunk}`));
		}
		try {
			const result = await new Promise<SnapshotBuildResult>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`snapshot build timed out after ${BUILD_TIMEOUT_MS} ms`)), BUILD_TIMEOUT_MS);
				proc.on('message', (data: unknown) => {
					const frame = data as Record<string, unknown>;
					if (frame['kind'] === 'log') { mainLog.emit(frame['record'] as Parameters<typeof mainLog.emit>[0]); return; }
					if (frame['id'] !== 1) return;
					clearTimeout(timer);
					if (frame['ok']) resolve(frame['result'] as SnapshotBuildResult);
					else reject(new Error(String(frame['message'] ?? 'snapshot worker error')));
				});
				// After an answer this is the kill below: the promise is settled.
				proc.on('exit', (code: number) => { clearTimeout(timer); reject(new Error(`snapshot worker exited (code ${code})`)); });
				proc.on('error', (type: string, location: string) => slog.error('worker fatal', undefined, { type, location }));
				proc.postMessage({ id: 1, op: 'build', dbPath: opts.dbPath, outDir, userId });
			});
			if (!result.ok) await rm(outDir, { recursive: true, force: true });
			return result;
		} catch (err) {
			await rm(outDir, { recursive: true, force: true }).catch(() => { /* next build clears it */ });
			throw err;
		} finally {
			try { proc.kill(); } catch { /* already gone */ }
		}
	};
}
