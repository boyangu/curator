// The desktop's SnapshotBuilder (core sync-log/snapshot-build.ts) and
// ReplicaBuilder (core sync-log/replica.ts): each build in a fresh Electron
// utility process (snapshot-worker.ts), killed when it answers. One build at
// a time (the sync client single-flights its publish, and builds the replica
// inside it), at most a few a day, so there is nothing to gain from keeping
// the process: a fresh one also hands the build's memory back as soon as it
// is done.
//
// Each kind of build has a directory of its own under userData
// (snapshot-build, replica-build): a replica is built from the snapshot's
// parts while they are still on disk, so the two must not clear each other's.
// The sync client removes a build's directory after the upload; one a crash
// or the watchdog cut short is left behind, and the next build of that kind
// clears whatever is there first (nothing else writes under it). A
// digest-only build (a secondary's check against the master's snapshot) runs
// the same way and writes nothing.

import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { utilityProcess } from 'electron';
import type { ReplicaBuilder, ReplicaBuildOk, SnapshotBuilder, SnapshotBuildResult } from '@curator/core';
import { mainLog } from '../log.js';

const slog = mainLog.for('snapshot-host');

// The main library's snapshot build is seconds; past this the worker is
// stuck (a locked file, a dead disk) and is killed.
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
// A replica is the whole join of the snapshot: ~2 minutes for the main
// library on a laptop (2026-11-21), more on a busy one.
const REPLICA_TIMEOUT_MS = 30 * 60 * 1000;

// A fresh directory under `tmpRoot`, after clearing what earlier builds left.
async function freshDir(tmpRoot: string): Promise<string> {
	await mkdir(tmpRoot, { recursive: true });
	for (const name of await readdir(tmpRoot)) await rm(join(tmpRoot, name), { recursive: true, force: true }).catch(() => { /* in use: next time */ });
	return mkdtemp(join(tmpRoot, 'build-'));
}

// One request to a fresh worker, its answer, and the worker killed.
async function runWorker<T>(workerPath: string, request: Record<string, unknown>, timeoutMs: number): Promise<T> {
	const proc = utilityProcess.fork(workerPath, [], { serviceName: 'curator-snapshot', stdio: 'pipe' });
	if (proc.stderr) {
		proc.stderr.setEncoding('utf8');
		proc.stderr.on('data', (chunk: string) => process.stderr.write(`[snapshot] ${chunk}`));
	}
	try {
		return await new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${String(request['op'])} timed out after ${timeoutMs} ms`)), timeoutMs);
			proc.on('message', (data: unknown) => {
				const frame = data as Record<string, unknown>;
				if (frame['kind'] === 'log') { mainLog.emit(frame['record'] as Parameters<typeof mainLog.emit>[0]); return; }
				if (frame['id'] !== 1) return;
				clearTimeout(timer);
				if (frame['ok']) resolve(frame['result'] as T);
				else reject(new Error(String(frame['message'] ?? 'snapshot worker error')));
			});
			// After an answer this is the kill below: the promise is settled.
			proc.on('exit', (code: number) => { clearTimeout(timer); reject(new Error(`snapshot worker exited (code ${code})`)); });
			proc.on('error', (type: string, location: string) => slog.error('worker fatal', undefined, { type, location }));
			proc.postMessage({ id: 1, ...request });
		});
	} finally {
		try { proc.kill(); } catch { /* already gone */ }
	}
}

export function createUtilitySnapshotBuilder(opts: { workerPath: string; dbPath: string; tmpRoot: string }): SnapshotBuilder {
	return async ({ userId, digestOnly }) => {
		const outDir = await freshDir(opts.tmpRoot);
		try {
			const result = await runWorker<SnapshotBuildResult>(opts.workerPath, { op: 'build', dbPath: opts.dbPath, outDir, userId, digestOnly: !!digestOnly }, BUILD_TIMEOUT_MS);
			if (!result.ok || result.digestOnly) await rm(outDir, { recursive: true, force: true });
			return result;
		} catch (err) {
			await rm(outDir, { recursive: true, force: true }).catch(() => { /* next build clears it */ });
			throw err;
		}
	};
}

export function createUtilityReplicaBuilder(opts: { workerPath: string; tmpRoot: string }): ReplicaBuilder {
	return async ({ userId, masterDeviceId, snapshotSeq, snapshotFiles }) => {
		const outDir = await freshDir(opts.tmpRoot);
		try {
			return await runWorker<ReplicaBuildOk>(opts.workerPath, { op: 'replica', outDir, userId, masterDeviceId, snapshotSeq, snapshotFiles: [...snapshotFiles] }, REPLICA_TIMEOUT_MS);
		} catch (err) {
			await rm(outDir, { recursive: true, force: true }).catch(() => { /* next build clears it */ });
			throw err;
		}
	};
}
