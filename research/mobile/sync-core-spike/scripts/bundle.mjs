// Two bundles of the same product source:
//   dist/desktop.mjs — Node, the real better-sqlite3 (the reference run);
//   dist/core.js     — one script for QuickJS: no Node, no npm at run time.
//                      better-sqlite3 and node:* resolve to shim/, which talk
//                      to the C host (host/host.c).
// `--why` prints what each node:* / npm import of the phone bundle is pulled in by.

import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const repo = resolve(root, '../../..');
const out = join(root, 'dist');
mkdirSync(out, { recursive: true });

const shim = (name) => join(root, 'shim', name);

const common = {
	bundle: true,
	sourcemap: false,
	logLevel: 'warning',
	metafile: true,
	// The workspace packages are TypeScript sources resolved through
	// apps/core's node_modules.
	absWorkingDir: repo,
	tsconfig: join(repo, 'apps/core/tsconfig.json'),
};

const desktop = await build({
	...common,
	entryPoints: [join(root, 'src/entry.desktop.ts')],
	outfile: join(out, 'desktop.mjs'),
	platform: 'node',
	format: 'esm',
	target: 'node22',
	// Left as an import: Node finds the spike's own copy (Node ABI) from dist/.
	// The workspace's copy is built for Electron and is in use by the running app.
	external: ['better-sqlite3'],
	alias: { 'spike-platform': shim('platform.node.ts') },
	banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
// migrate.ts migrates ./curator.db when it is the program run: this file is only ever imported.
if ((process.argv[1] ?? '').replaceAll('\\\\', '/').endsWith('/dist/desktop.mjs')) throw new Error('import dist/desktop.mjs, do not run it');` },
});

const core = await build({
	...common,
	entryPoints: [join(root, 'src/entry.core.ts')],
	outfile: join(out, 'core.js'),
	platform: 'neutral',
	mainFields: ['module', 'main'],
	conditions: ['import', 'default'],
	format: 'iife',
	globalName: 'CuratorCore',
	target: 'es2022',
	alias: {
		'better-sqlite3': shim('better-sqlite3.ts'),
		'node:crypto': shim('node-crypto.ts'),
		'node:zlib': shim('node-zlib.ts'),
		'node:fs/promises': shim('node-fs-promises.ts'),
		'spike-platform': shim('platform.qjs.ts'),
	},
	inject: [shim('globals.ts')],
});

const report = (name, meta) => {
	const o = Object.values(meta.outputs)[0];
	const inputs = Object.entries(o.inputs).map(([p, v]) => [p, v.bytesInOutput]).filter(([, n]) => n > 0);
	const by = new Map();
	for (const [p, n] of inputs) {
		const m = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(p);
		const key = m ? `npm:${m[1]}` : p.replace(/^(apps|packages)\/([^/]+)\/.*/, '$1/$2').replace(/^research\/.*\/(shim|src)\/.*/, 'spike/$1');
		by.set(key, (by.get(key) ?? 0) + n);
	}
	console.log(`${name}: ${(o.bytes / 1024).toFixed(0)} KB from ${inputs.length} files`);
	for (const [k, n] of [...by].sort((a, b) => b[1] - a[1])) console.log(`  ${String((n / 1024).toFixed(0)).padStart(6)} KB  ${k}`);
};
report('desktop.mjs', desktop.metafile);
report('core.js', core.metafile);

writeFileSync(join(out, 'core.meta.json'), JSON.stringify(core.metafile));

if (process.argv.includes('--why')) {
	// Every input that is a shim or an npm package, and the product files importing it.
	const why = new Map();
	for (const [file, info] of Object.entries(core.metafile.inputs)) {
		for (const imp of info.imports) {
			if (!/shim\/|node_modules/.test(imp.path) || /node_modules/.test(file)) continue;
			const key = /shim\//.test(imp.path) ? relative(root, resolve(repo, imp.path)).replace(/\\/g, '/') : imp.path.replace(/.*node_modules\//, 'npm:');
			(why.get(key) ?? why.set(key, []).get(key)).push(file);
		}
	}
	for (const [k, files] of [...why].sort()) console.log(`\n${k}\n  ${files.sort().join('\n  ')}`);
}
