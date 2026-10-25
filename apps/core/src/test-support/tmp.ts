// Temp directories for tests, and the handles that live in them.
//
// On Windows a directory cannot be removed while anything holds a file in it
// open: a better-sqlite3 handle (curator.db and its -wal/-shm, but also the
// sibling feed/knowledge/agent/mir DBs a CoreService opens next to it), a
// chokidar watcher, a child process's cwd. Suites used to `rmSync` in a
// try/catch that swallowed the EBUSY, and 38k leaked dirs (104 GB) filled
// the disk. So a test registers what it opens on the dir that holds it, and
// cleanup() closes those in reverse order of opening — awaiting a
// CoreService's close(), whose sidecar DBs and watchers close after it
// returns — before it removes the directory. A removal that still fails is
// reported on stderr rather than swallowed; the run's global teardown
// (test-support/tmp-root.ts) removes what is left and counts it.

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// better-sqlite3 handles, CoreService, stores, rigs: anything with close().
export type Closable = { close(): unknown };

export class TmpDir {
	readonly path: string;
	private readonly handles: Closable[] = [];

	constructor(prefix: string) {
		this.path = mkdtempSync(join(tmpdir(), prefix));
	}

	// Registers `h` to be closed before the directory goes; returns it.
	track<T extends Closable>(h: T): T {
		this.handles.push(h);
		return h;
	}

	// Closes everything tracked, newest first (a service before the raw
	// handle the test opened beside it is fine either way; reverse order
	// keeps dependents ahead of what they depend on), then removes the
	// directory. Closing twice is harmless for every Closable here (a
	// better-sqlite3 close() on a closed handle is a no-op), so a test that
	// closed something itself can still have registered it.
	async cleanup(): Promise<void> {
		for (const h of this.handles.splice(0).reverse()) {
			try { await h.close(); } catch (err) { process.stderr.write(`[test tmp] close failed in ${this.path}: ${String(err)}\n`); }
		}
		await removeDir(this.path);
	}
}

export function tmpDir(prefix: string): TmpDir {
	return new TmpDir(prefix);
}

// The async rm waits between retries on the event loop, so a handle closing
// in a microtask or a watcher's late callback gets to finish (rmSync's
// retries block the thread that would close it). Returns whether it went.
export async function removeDir(path: string): Promise<boolean> {
	try {
		await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		return true;
	} catch (err) {
		process.stderr.write(`[test tmp] could not remove ${path}: ${(err as NodeJS.ErrnoException).code ?? String(err)}\n`);
		return false;
	}
}
