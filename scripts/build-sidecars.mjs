// Build + stage the three sidecars into apps/desktop/resources/ so
// electron-builder's extraResources picks them up and the packaged app's
// production spec resolution (process.resourcesPath/{analyzer,rekordbox,audio})
// finds real binaries. Dev runs never need this — getXSpec() falls back to
// source-tree execution when ELECTRON_RENDERER_URL is set.
//
// Usage:
//   node scripts/build-sidecars.mjs               build everything available
//   node scripts/build-sidecars.mjs --ensure-dirs only create the resource
//                                                 dirs (used by prepackage so
//                                                 electron-builder doesn't
//                                                 error on a missing `from`)
//
// Each sidecar is best-effort with a loud skip message — a missing toolchain
// (no PyInstaller, no cargo) produces an empty resource dir, and the packaged
// app treats a missing bundle as "sidecar disabled" rather than crashing
// (see the existsSync gates in apps/desktop/src/main/index.ts).
//
// Windows caveat: the analyzer needs Essentia, which has no Windows wheel —
// it runs under WSL in dev and CANNOT be PyInstaller-bundled from Windows.
// A Windows analyzer bundle requires either building inside WSL and shipping
// a Linux binary + WSL requirement, or a future Essentia Windows build. The
// script skips it with an explanation rather than producing a broken bundle.

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resourcesDir = join(root, 'apps', 'desktop', 'resources');
const dirs = {
	analyzer: join(resourcesDir, 'analyzer'),
	rekordbox: join(resourcesDir, 'rekordbox'),
	audio: join(resourcesDir, 'audio'),
	spotify: join(resourcesDir, 'spotify-player'),
	mir: join(resourcesDir, 'mir'),
};

for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

if (process.argv.includes('--ensure-dirs')) {
	console.log('[sidecars] resource dirs ensured');
	process.exit(0);
}

const run = (cmd, cwd) => {
	console.log(`[sidecars] $ ${cmd}  (in ${cwd})`);
	execSync(cmd, { cwd, stdio: 'inherit' });
};

const exeSuffix = process.platform === 'win32' ? '.exe' : '';

// ─── audio (Rust) ───────────────────────────────────────────────────────────
try {
	const audioDir = join(root, 'apps', 'audio');
	run('cargo build --release', audioDir);
	const built = join(audioDir, 'target', 'release', `curator-audio${exeSuffix}`);
	cpSync(built, join(dirs.audio, `curator-audio${exeSuffix}`));
	console.log('[sidecars] audio: staged');
} catch (err) {
	console.warn(`[sidecars] audio: SKIPPED (${err.message?.split('\n')[0]}) — packaged app will run without native audio`);
}

// ─── spotify (Electron / electron-builder + castlabs VMP sign) ──────────────
// The ONLY VMP-signed artifact in the build: a headless Electron app hosting
// the Spotify Web Playback SDK + Widevine. The main desktop app no longer needs
// to embed the SDK, so isolating it here means this signed bundle is built once
// and re-staged; everyday `pnpm dev` spawns apps/spotify-player/out directly and
// never signs anything. Best-effort like the others — a missing castlabs_evs /
// EVS login produces no bundle, and the app treats that as Spotify-disabled.
try {
	const spDir = join(root, 'apps', 'spotify-player');
	// package:signed = electron-vite build → electron-builder --dir → vmp sign.
	run('pnpm package:signed', spDir);
	// electron-builder's unpacked output dir is platform-specific.
	const unpackedName = process.platform === 'win32'
		? 'win-unpacked'
		: process.platform === 'darwin' ? 'mac' : 'linux-unpacked';
	const distDir = join(spDir, 'dist', unpackedName);
	rmSync(dirs.spotify, { recursive: true, force: true });
	cpSync(distDir, dirs.spotify, { recursive: true });
	console.log('[sidecars] spotify: staged (signed)');
} catch (err) {
	console.warn(`[sidecars] spotify: SKIPPED (${err.message?.split('\n')[0]}) — packaged app will run without Spotify playback. Needs castlabs_evs (VMP signing) + an EVS login; build apps/spotify-player to enable.`);
}

// ─── mcp shim (Node / tsc + .mcpb bundle) ───────────────────────────────────
// Not staged into desktop resources — Claude Desktop spawns it, Curator
// doesn't. Built here so the standalone-registered dist/main.js (and the
// one-click .mcpb bundle) can't go stale when shim code changes.
try {
	run('pnpm --filter @curator/mcp package:mcpb', root);
	console.log('[sidecars] mcp: built + .mcpb packed (apps/mcp/dist-mcpb)');
} catch (err) {
	console.warn(`[sidecars] mcp: SKIPPED (${err.message?.split('\n')[0]}) — Claude Desktop integration may be stale`);
}

// ─── rekordbox (Python / PyInstaller) ───────────────────────────────────────
try {
	const rbDir = join(root, 'apps', 'rekordbox');
	const venvPy = join(rbDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
	const py = existsSync(venvPy) ? venvPy : (process.platform === 'win32' ? 'python' : 'python3');
	// Pre-clean PyInstaller's output dirs ourselves. Its --noconfirm cleanup
	// uses Python's shutil.rmtree, which does NOT clear the read-only bit —
	// and dateutil's bundled zoneinfo data ships read-only, so a PRIOR build's
	// copy blocks the NEXT build with WinError 5 on
	// dist/curator-rekordbox/_internal/dateutil/zoneinfo. Node's rmSync chmods
	// on EPERM and retries, so starting from a clean slate avoids the crash.
	rmSync(join(rbDir, 'dist'), { recursive: true, force: true, maxRetries: 3 });
	rmSync(join(rbDir, 'build'), { recursive: true, force: true, maxRetries: 3 });
	// --onedir keeps startup fast (no self-extract) and matches the
	// bundleDir layout getRekordboxSpec() expects. Entry is sidecar_entry.py,
	// NOT src/curator_rekordbox/main.py — running main.py directly makes it
	// __main__ with no parent package, so its `from . import …` relative
	// imports fail at runtime. The launcher imports the package absolutely
	// (--paths src puts curator_rekordbox on the path).
	run(
		// No --add-data: the rekordbox package ships no data files. The old
		// curator_analyzer/data arg was a copy-paste from the analyzer step —
		// that path doesn't exist under apps/rekordbox, so PyInstaller errored
		// and the bundle silently skipped every rebuild, shipping stale code.
		`"${py}" -m PyInstaller --noconfirm --onedir --name curator-rekordbox `
			+ `--paths src sidecar_entry.py`,
		rbDir,
	);
	const distDir = join(rbDir, 'dist', 'curator-rekordbox');
	rmSync(dirs.rekordbox, { recursive: true, force: true });
	cpSync(distDir, dirs.rekordbox, { recursive: true });
	console.log('[sidecars] rekordbox: staged');
} catch (err) {
	console.warn(`[sidecars] rekordbox: SKIPPED (${err.message?.split('\n')[0]}) — packaged app will run without rekordbox sync. Install PyInstaller in apps/rekordbox/.venv to enable.`);
}

// ─── mir (AI audio engine — staged source + lockfile + uv, NOT a bundle) ────
// torch + transformers make a multi-GB env, so the packaged app ships the
// engine source, its uv.lock and a uv binary; the app provisions the env into
// userData on demand (apps/core/src/mir/provision.ts). Weights download lazily.
try {
	const mirDir = join(root, 'apps', 'mir');
	rmSync(dirs.mir, { recursive: true, force: true });
	mkdirSync(dirs.mir, { recursive: true });
	for (const f of ['pyproject.toml', 'uv.lock', '.python-version', 'README.md', 'modal_app.py']) {
		cpSync(join(mirDir, f), join(dirs.mir, f));
	}
	cpSync(join(mirDir, 'src', 'curator_mir'), join(dirs.mir, 'src', 'curator_mir'), {
		recursive: true,
		filter: (src) => !src.includes('__pycache__'),
	});
	const which = process.platform === 'win32' ? 'where uv' : 'command -v uv';
	const uvPath = execSync(which, { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
	cpSync(uvPath, join(dirs.mir, `uv${exeSuffix}`));
	console.log('[sidecars] mir: staged (source + uv.lock + uv)');
} catch (err) {
	console.warn(`[sidecars] mir: SKIPPED (${err.message?.split('\n')[0]}) — packaged app will run without the AI engine. Needs uv on PATH.`);
}

// ─── analyzer (Python / PyInstaller; Windows builds inside WSL) ─────────────
// Essentia has no Windows wheel, so a native Windows bundle is impossible.
// Instead, on Windows we run PyInstaller *inside WSL* using the same
// .venv-wsl the dev analyzer runs from, and stage the resulting Linux onedir.
// getAnalyzerSpec() spawns it via `wsl` with path translation — exactly the
// dev shape, minus the source tree. Requires WSL + PyInstaller in .venv-wsl
// (`VIRTUAL_ENV=.venv-wsl uv pip install pyinstaller` from apps/analyzer).
try {
	const anDir = join(root, 'apps', 'analyzer');
	// Same read-only-bit pre-clean as rekordbox above.
	rmSync(join(anDir, 'dist'), { recursive: true, force: true, maxRetries: 3 });
	rmSync(join(anDir, 'build'), { recursive: true, force: true, maxRetries: 3 });
	// Entry is sidecar_entry.py (same package-context reason as rekordbox);
	// it also calls multiprocessing.freeze_support() for the worker pool.
	// `:` in --add-data is correct on both paths — the Windows path runs
	// PyInstaller under Linux.
	const pyiCmd = '-m PyInstaller --noconfirm --onedir --name curator-analyzer '
		+ '--add-data src/curator_analyzer/data:curator_analyzer/data '
		+ '--paths src sidecar_entry.py';
	if (process.platform === 'win32') {
		const toWsl = (p) => p
			.replace(/^([A-Za-z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`)
			.replace(/\\/g, '/');
		run(`wsl bash -c "cd '${toWsl(anDir)}' && .venv-wsl/bin/python ${pyiCmd}"`, anDir);
		// Stage from inside WSL with `cp -rL`: the Linux bundle contains
		// symlinks (auditwheel-relocated .so's), which land on NTFS as WSL
		// reparse points that Windows-side copies (Node cpSync, robocopy)
		// hang or fail on. Dereferencing duplicates a few libs but leaves a
		// plain file tree that electron-builder can pack.
		rmSync(dirs.analyzer, { recursive: true, force: true });
		mkdirSync(dirs.analyzer, { recursive: true });
		run(`wsl bash -c "cp -rL '${toWsl(anDir)}/dist/curator-analyzer/.' '${toWsl(dirs.analyzer)}/'"`, anDir);
	} else {
		const venvPy = join(anDir, '.venv', 'bin/python');
		const py = existsSync(venvPy) ? venvPy : 'python3';
		run(`"${py}" ${pyiCmd}`, anDir);
		rmSync(dirs.analyzer, { recursive: true, force: true });
		cpSync(join(anDir, 'dist', 'curator-analyzer'), dirs.analyzer, { recursive: true });
	}
	console.log(`[sidecars] analyzer: staged${process.platform === 'win32' ? ' (Linux bundle — packaged app runs it via WSL)' : ''}`);
} catch (err) {
	console.warn(`[sidecars] analyzer: SKIPPED (${err.message?.split('\n')[0]}) — packaged app will run without analysis. `
		+ (process.platform === 'win32'
			? 'Needs WSL + apps/analyzer/.venv-wsl with PyInstaller (`VIRTUAL_ENV=.venv-wsl uv pip install pyinstaller`).'
			: 'Install PyInstaller in apps/analyzer/.venv to enable.'));
}

console.log('[sidecars] done');
