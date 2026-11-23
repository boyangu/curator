// What a phone would run: the desktop's sync client and what it stands on,
// imported from the product source, never copied — the point of the spike is
// that it is the same code. src/driver.ts is the run itself.

import { main } from './driver.js';

export { main };
export { dumpLibrary } from '@curator/sync-core/sync-log/dump';

// On the QuickJS host the bundle is the program: it runs the driver with the
// host's arguments. On Node the script that imports it calls main().
const host = (globalThis as { __host?: { args: string[] } }).__host;
if (host) {
	main(host.args).catch((err: unknown) => {
		console.error(err);
		(globalThis as { __exitCode?: number }).__exitCode = 1;
	});
}

// For scripts that poke at the fold directly (debugging a difference).
export { SyncStateStore } from '@curator/sync-core/sync-log/store';
export { applyOp, parseOp } from '../../../../packages/protocol/src/index.js';
export { default as Database } from 'better-sqlite3';
