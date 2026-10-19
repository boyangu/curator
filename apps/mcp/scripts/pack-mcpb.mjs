// Package the shim as a .mcpb bundle (MCP Bundle, ex-.dxt) for one-click
// install in Claude Desktop (Settings → Extensions → drag the file in).
//
// Staging installs production deps with NPM, not pnpm: pnpm layouts are
// symlink forests (and `pnpm deploy --prod` was observed dragging dev deps
// in anyway), while `npm install --omit=dev` yields a flat, real-file
// node_modules that survives a zip. The manifest follows spec 0.3
// (github.com/anthropics/mcpb):
// Claude Desktop runs `node ${__dirname}/dist/main.js` with its own managed
// Node, so the bundle has no runtime prerequisites. The app-must-be-running
// contract is unchanged — the bundle still discovers the live app via
// userData/mcp-bridge.json.
//
// Packing prefers the official CLI (`npx @anthropic-ai/mcpb pack`) for its
// manifest validation; if npx/network is unavailable it falls back to a
// plain zip via PowerShell/zip — a .mcpb IS a zip archive.

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pkgDir, '..', '..');
const outDir = join(pkgDir, 'dist-mcpb');
const staging = join(outDir, 'staging');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

const run = (cmd, cwd, timeout) => {
	console.log(`[mcpb] $ ${cmd}`);
	execSync(cmd, { cwd, stdio: 'inherit', ...(timeout ? { timeout } : {}) });
};

if (!existsSync(join(pkgDir, 'dist', 'main.js'))) {
	console.error('[mcpb] dist/main.js missing — run `pnpm --filter @curator/mcp build` first');
	process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Stage: built shim + widget + a minimal package.json holding only the
// runtime deps, then a flat npm install of exactly those.
mkdirSync(staging, { recursive: true });
cpSync(join(pkgDir, 'dist'), join(staging, 'dist'), { recursive: true });
cpSync(join(pkgDir, 'widget'), join(staging, 'widget'), { recursive: true });
cpSync(join(pkgDir, 'skills'), join(staging, 'skills'), { recursive: true });
writeFileSync(join(staging, 'package.json'), JSON.stringify({
	name: 'curator-mcp',
	version: pkg.version,
	private: true,
	type: 'module',
	main: 'dist/main.js',
	dependencies: pkg.dependencies,
}, null, '\t'));
run('npm install --omit=dev --no-audit --no-fund --no-package-lock', staging);

const manifest = {
	manifest_version: '0.3',
	name: 'curator',
	display_name: 'Curator',
	version: pkg.version,
	description: 'Search and curate your Curator DJ library from Claude — library/feed/knowledge-base search, workspace SQL, playlists, tags, ratings. The Curator desktop app must be running.',
	author: { name: 'boyangu' },
	server: {
		type: 'node',
		entry_point: 'dist/main.js',
		mcp_config: {
			command: 'node',
			args: ['${__dirname}/dist/main.js'],
		},
	},
};
writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, '\t'));

const outFile = join(outDir, `curator-${pkg.version}.mcpb`);
try {
	// Timeout guard: the CLI has been observed hanging after "validation
	// passes" — validation is the part we want from it anyway.
	run(`npx --yes @anthropic-ai/mcpb pack "${staging}" "${outFile}"`, repoRoot, 120_000);
} catch (err) {
	console.warn(`[mcpb] official CLI failed (${err.message?.split('\n')[0]}) — falling back to plain zip`);
	if (process.platform === 'win32') {
		// Compress-Archive on the staging CONTENTS (manifest.json at archive root).
		run(`powershell -NoProfile -Command "Compress-Archive -Path '${staging}\\*' -DestinationPath '${outFile}.zip' -Force; Move-Item -Force '${outFile}.zip' '${outFile}'"`, repoRoot);
	} else {
		run(`cd "${staging}" && zip -qr "${outFile}" .`, repoRoot);
	}
}

console.log(`[mcpb] bundle ready: ${outFile}`);
console.log('[mcpb] install: Claude Desktop → Settings → Extensions → drag the .mcpb in');

// Skills ride along in the .mcpb (harmless if the host ignores them), but the
// supported install path today is a separate upload: Claude Desktop / claude.ai
// → Settings → Capabilities → Skills. Zip each skill folder individually.
for (const skill of ['identify-tracks']) {
	const skillDir = join(pkgDir, 'skills', skill);
	const skillZip = join(outDir, `curator-${skill}-skill.zip`);
	try {
		if (process.platform === 'win32') {
			run(`powershell -NoProfile -Command "Compress-Archive -Path '${skillDir}' -DestinationPath '${skillZip}' -Force"`, repoRoot);
		} else {
			run(`cd "${join(pkgDir, 'skills')}" && zip -qr "${skillZip}" "${skill}"`, repoRoot);
		}
		console.log(`[mcpb] skill ready: ${skillZip} (upload via Settings → Capabilities → Skills)`);
	} catch (err) {
		console.warn(`[mcpb] skill zip failed (${err.message?.split('\n')[0]})`);
	}
}
