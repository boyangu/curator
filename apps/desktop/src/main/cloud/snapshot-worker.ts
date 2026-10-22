// Snapshot worker — Electron utility process that builds the account snapshot
// this device publishes as its master ('snapshot_storage'; core
// sync-log/snapshot-build.ts). Off main because the build reads every reducer
// record (~570k rows on the main library), serialises ~227 MB of JSON and
// gzips it: seconds of synchronous better-sqlite3 and CPU that must not touch
// main's event loop. Bundled to snapshot-worker.cjs (electron.vite.config.ts);
// driven by snapshot-host.ts, one build per fork: the process exits after
// it, so the memory a build touched goes back to the OS at once.
//
// What crosses the port: { id, op: 'build', dbPath, outDir, userId } →
// { id, ok, result | message }; log records as { kind: 'log' }. The database
// is opened read-only; the parts are written under `outDir` (userData).

import { setPriority, constants as osConstants } from 'node:os';
import { buildSnapshotParts, setCoreLogger } from '@curator/core';
import { createLogger, isLogLevel } from '@curator/shared/log';

type BuildRequest = { id: number; op: 'build'; dbPath: string; outDir: string; userId: string };

function post(frame: Record<string, unknown>): void {
	process.parentPort.postMessage(frame);
}

// Main owns the single JSONL timeline.
setCoreLogger(createLogger({
	proc: 'core',
	level: isLogLevel(process.env['CURATOR_LOG_LEVEL']) ? process.env['CURATOR_LOG_LEVEL'] : process.env['ELECTRON_RENDERER_URL'] ? 'debug' : 'info',
	sinks: [{ write: (record) => post({ kind: 'log', record }) }],
}));

// gzip of 227 MB saturates a core for a few seconds; the UI must not notice.
try { setPriority(osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted — fine */ }

process.parentPort.on('message', (e) => {
	const msg = e.data as BuildRequest;
	if (msg?.op !== 'build') return;
	void (async () => {
		try {
			const result = await buildSnapshotParts({ dbPath: msg.dbPath, outDir: msg.outDir, userId: msg.userId });
			// Peak resident set of this process (KiB on every platform).
			const peakRssBytes = process.resourceUsage().maxRSS * 1024;
			post({ id: msg.id, ok: true, result: result.ok ? { ...result, peakRssBytes } : result });
		} catch (err) {
			post({ id: msg.id, ok: false, message: err instanceof Error ? err.message : String(err) });
		}
	})();
});
