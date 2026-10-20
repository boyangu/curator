// `pnpm desktop:profile <name> [--no-build] [--rebuild]` — run the desktop app
// as a second, isolated instance (CURATOR_PROFILE=<name>, own userData, safety
// rails on; see src/main/profile.ts) next to a running `pnpm dev`.
//
// Why a production build into its own out dir instead of a second dev server:
// `pnpm dev` owns port 5173 and rewrites out/main + out/preload on every save.
// A profile instance loading from out/ would lazily read chunks (workers,
// parsers) that dev has since replaced under it. out-profile-<name>/ keeps the
// same depth as out/, so the main bundle's __dirname-relative lookups
// (../../resources, ../../../<sidecar>) resolve exactly as in dev.
//
// Electron is pointed at the out dir, not at a file: default_app takes the app
// name from the package.json it finds there, and userData derives from that
// name — so the dir gets a package.json with productName "Curator".

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => a !== '--');
const flags = new Set(args.filter((a) => a.startsWith('--')));
const name = args.find((a) => !a.startsWith('--'));

// Mirrors PROFILE_NAME_RE in src/main/profile.ts (the app re-validates and
// refuses to start on a bad name; checking here saves a pointless build).
if (!name || !/^[a-z0-9-]{1,32}$/.test(name)) {
	console.error('usage: pnpm desktop:profile <name> [--no-build] [--rebuild]   (name: a-z 0-9 -, max 32)');
	process.exit(2);
}

const outDir = join(desktopDir, `out-profile-${name}`);

function run(cmd, cmdArgs, opts = {}) {
	const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: desktopDir, shell: process.platform === 'win32', ...opts });
	if (r.status !== 0) {
		console.error(`[desktop:profile] ${cmd} ${cmdArgs.join(' ')} failed (exit ${r.status ?? r.signal})`);
		process.exit(r.status ?? 1);
	}
}

// better-sqlite3 must carry Electron's ABI. `predev` rebuilds it
// unconditionally, but here that would fight a running `pnpm dev`: its
// Electron holds the .node file open and Windows refuses the overwrite
// (EPERM), possibly mid-rebuild. So probe first, in a throwaway Node process
// (loading the addon here would lock the file for the rebuild below): if Node
// can't load it because of NODE_MODULE_VERSION, it's already an Electron
// build — the one dev is using — and nothing needs to change.
function ensureElectronAbi() {
	if (flags.has('--rebuild')) {
		run(process.execPath, [join(desktopDir, 'scripts', 'rebuild-sqlite.mjs')], { shell: false });
		return;
	}
	const probe = spawnSync(process.execPath, ['-e', "new (require('better-sqlite3'))(':memory:').close()"], { cwd: desktopDir, encoding: 'utf8' });
	if (probe.status !== 0 && /NODE_MODULE_VERSION/.test(probe.stderr ?? '')) {
		console.log('[desktop:profile] better-sqlite3 already built for Electron — skipping rebuild');
		return;
	}
	console.log('[desktop:profile] better-sqlite3 is not an Electron build — rebuilding (close any running Curator first if this fails with EPERM)');
	run(process.execPath, [join(desktopDir, 'scripts', 'rebuild-sqlite.mjs')], { shell: false });
}

// Same folder Electron will resolve for app.getPath('userData') + '-<name>'
// (appData + productName). Only used to aim core's download folders inside
// the profile; the app re-checks and blocks downloads if this ever disagrees.
function profileUserData() {
	const base = process.platform === 'win32'
		? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
		: process.platform === 'darwin'
			? join(homedir(), 'Library', 'Application Support')
			: (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
	return join(base, `Curator-${name}`);
}

if (!flags.has('--no-build')) {
	ensureElectronAbi();
	// Absolute: electron-vite resolves a relative --outDir against each
	// sub-build's root, and the renderer's root is src/renderer.
	// shell:true (needed for pnpm.cmd on Windows) joins args unquoted.
	run('pnpm', ['exec', 'electron-vite', 'build', '--outDir', /\s/.test(outDir) ? `"${outDir}"` : outDir]);
	const pkg = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'));
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, 'package.json'), JSON.stringify({
		name: pkg.name,
		productName: pkg.productName,
		version: pkg.version,
		private: true,
		main: './main/index.cjs',
	}, null, '\t') + '\n');
	// Build output, never source: ignore the whole dir (this file included)
	// without touching the repo's .gitignore.
	writeFileSync(join(outDir, '.gitignore'), '*\n');
}

const electronExe = createRequire(join(desktopDir, 'package.json'))('electron');
const userData = profileUserData();
const env = {
	...process.env,
	CURATOR_PROFILE: name,
	CURATOR_DOWNLOAD_DIR: join(userData, 'downloads'),
	CURATOR_REDOWNLOAD_DIR: join(userData, 'redownloads'),
};
// A dev shell may carry these: the first would make the profile load the dev
// server's renderer, the second would boot Electron as plain Node.
delete env.ELECTRON_RENDERER_URL;
delete env.ELECTRON_RUN_AS_NODE;

console.log(`[desktop:profile] launching profile "${name}" from ${outDir} (userData ${userData})`);
const child = spawn(electronExe, [outDir], { stdio: 'inherit', cwd: desktopDir, env });
// Ctrl+C reaches Electron directly (same console); stay alive until it has
// torn its sidecars down, then mirror its exit code.
process.on('SIGINT', () => {});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
