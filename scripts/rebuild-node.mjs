// Rebuild better-sqlite3 for the current Node version. Needed when switching
// back from Electron-ABI (used by `pnpm dev`/`pnpm build`) to Node-ABI (used
// by CLI scripts like `pnpm db:seed`).

import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { glob } from 'node:fs';
import { promisify } from 'node:util';

const globAsync = promisify(glob);

const matches = await globAsync('node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3');
if (matches.length === 0) {
	console.error('better-sqlite3 not found in node_modules');
	process.exit(1);
}

const target = matches[0];
console.log(`rebuilding ${target} for Node ${process.versions.node}`);

rmSync(`${target}/build`, { recursive: true, force: true });
execSync('npx prebuild-install --runtime=node', { cwd: target, stdio: 'inherit' });
console.log('done — better-sqlite3 is now Node-ABI compatible');
