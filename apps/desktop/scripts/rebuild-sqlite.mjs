// Re-runs better-sqlite3's install script with env vars that point
// prebuild-install at the Electron-targeted prebuilds on GitHub.
// Without these, `pnpm rebuild` would target Node (the runtime we're
// executing under) and either fetch a Node-ABI prebuild (wrong) or fall
// back to a from-source compile (needs MSVC — not what we want).
//
// The Electron version is read from the installed package's package.json
// so this stays accurate when we bump castlabs/electron-releases.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const electronPkg = JSON.parse(
	readFileSync(join(here, '..', 'node_modules', 'electron', 'package.json'), 'utf8')
);
// castlabs versions look like "38.8.6+wvcus" — strip the build metadata.
const electronVersion = electronPkg.version.split('+')[0];

console.log(`[rebuild-sqlite] targeting Electron ${electronVersion}`);

execSync('pnpm rebuild better-sqlite3', {
	stdio: 'inherit',
	cwd: join(here, '..'),
	env: {
		...process.env,
		// prebuild-install reads these. Together they make it look up
		// better-sqlite3-vX.Y.Z-electron-vNN-platform-arch.tar.gz on the
		// project's GitHub releases page rather than the Node ABI variant.
		npm_config_runtime: 'electron',
		npm_config_target: electronVersion,
		npm_config_disturl: 'https://electronjs.org/headers',
		// If a matching prebuild isn't found, fall through to a source compile
		// (which will still fail on machines without MSVC, but the error is
		// clearer than a silent Node-prebuild fallback that crashes at runtime).
		npm_config_build_from_source: 'false',
	},
});
