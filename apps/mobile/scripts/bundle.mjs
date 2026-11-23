// Builds the phone's sync core: js/entry.ts and @curator/sync-core as one
// script for Hermes, compiled to bytecode into the app's assets
// (android/app/src/main/assets/core.hbc). better-sqlite3 and node:* resolve
// to js/shim/, which talk to the native host. `--why` lists what pulls each
// shim or npm package in.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shim = (name) => join(root, 'js', 'shim', name);
const assets = join(root, 'android', 'app', 'src', 'main', 'assets');
const work = join(root, 'android', 'app', 'build', 'core');
mkdirSync(assets, { recursive: true });
mkdirSync(work, { recursive: true });

const result = await build({
	entryPoints: [join(root, 'js', 'entry.ts')],
	outfile: join(work, 'core.js'),
	bundle: true,
	platform: 'neutral',
	mainFields: ['module', 'main'],
	conditions: ['import', 'default'],
	format: 'iife',
	target: 'es2022',
	// Hermes compiles everything here but async generators (the streamed
	// snapshot load's): esbuild lowers those alone. Block scoping is the
	// compiler's, switched on below.
	supported: { 'async-generator': false },
	alias: {
		'better-sqlite3': shim('better-sqlite3.ts'),
		'node:crypto': shim('node-crypto.ts'),
		'node:zlib': shim('node-zlib.ts'),
		'node:fs': shim('node-fs.ts'),
		'node:fs/promises': shim('node-fs-promises.ts'),
		'node:path': shim('node-path.ts'),
	},
	inject: [shim('globals.ts')],
	metafile: true,
	logLevel: 'warning',
	absWorkingDir: root,
});

const hermesc = join(root, 'vendor', 'hermes', 'compiler', 'package', 'hermesc', process.platform === 'win32' ? 'win64-bin/hermesc.exe' : process.platform === 'darwin' ? 'osx-bin/hermesc' : 'linux64-bin/hermesc');
if (!existsSync(hermesc)) throw new Error('no hermesc: run `node scripts/fetch-vendor.mjs` first');
// Without -Xes6-block-scoping, `let` and `const` are function-scoped and a
// closure made in a loop sees the loop's last value.
execFileSync(hermesc, ['-emit-binary', '-O', '-Xes6-block-scoping', '-w', '-out', join(assets, 'core.hbc'), join(work, 'core.js')], { stdio: 'inherit' });

const out = Object.values(result.metafile.outputs)[0];
console.log(`core.js ${(out.bytes / 1024).toFixed(0)} KB from ${Object.keys(out.inputs).length} files → core.hbc ${(statSync(join(assets, 'core.hbc')).size / 1024).toFixed(0)} KB`);

if (process.argv.includes('--why')) {
	const why = new Map();
	for (const [file, info] of Object.entries(result.metafile.inputs)) {
		for (const imp of info.imports) {
			if (!/shim[\\/]|node_modules/.test(imp.path) || /node_modules/.test(file)) continue;
			const key = /shim[\\/]/.test(imp.path) ? relative(root, resolve(root, imp.path)).replace(/\\/g, '/') : imp.path.replace(/.*node_modules\//, 'npm:');
			(why.get(key) ?? why.set(key, []).get(key)).push(file);
		}
	}
	for (const [k, files] of [...why].sort()) console.log(`\n${k}\n  ${files.sort().join('\n  ')}`);
}
