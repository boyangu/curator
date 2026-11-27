// The mobile app's gate: CI's mobile job runs it on every push that touches
// the app, and scripts/release-mobile.mjs runs it on the commit it ships.
// Typecheck the sync core's JS side, fetch the pinned toolchain inputs,
// bundle the core to Hermes bytecode, then the Kotlin unit tests and the
// release build (the only step that compiles the native side). Arguments
// pass to Gradle: `node scripts/check.mjs -PcuratorVersion=1.2.3`.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
	console.log(`\n== ${[cmd, ...args].join(' ')}`);
	// shell on Windows: pnpm is a .cmd there.
	const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'pnpm' });
	if (r.status !== 0) process.exit(r.status ?? 1);
}

run('pnpm', ['exec', 'tsc', '--noEmit']);
run('pnpm', ['exec', 'vitest', 'run', '--dir', 'js']);
run(process.execPath, [join(root, 'scripts', 'fetch-vendor.mjs')]);
run(process.execPath, [join(root, 'scripts', 'bundle.mjs')]);
run(process.execPath, [join(root, 'scripts', 'gradle.mjs'), 'testDebugUnitTest', 'assembleRelease', ...process.argv.slice(2)]);
