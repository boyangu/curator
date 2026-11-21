// What the phone bundle's closure reaches outside plain JS: node:* modules and
// npm packages, and the product files that import them.
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '../../..');
const entry = process.argv[2] ?? 'src/entry.core.ts';
const r = await build({
	entryPoints: [join(root, entry)], bundle: true, write: false, metafile: true, logLevel: 'error',
	platform: 'neutral', mainFields: ['module', 'main'], conditions: ['import', 'default'], format: 'esm', target: 'es2022',
	absWorkingDir: repo, external: ['node:*', 'better-sqlite3'],
});
const ext = new Map();
let files = 0, bytes = 0;
for (const [file, info] of Object.entries(r.metafile.inputs)) {
	files++; bytes += info.bytes;
	for (const imp of info.imports) if (imp.external) (ext.get(imp.path) ?? ext.set(imp.path, []).get(imp.path)).push(file);
}
console.log(`${entry}: ${files} files, ${(bytes / 1024).toFixed(0)} KB source, ${(r.outputFiles[0].contents.length / 1024).toFixed(0)} KB bundled`);
for (const [k, v] of [...ext].sort()) console.log(`\n${k}  (${v.length})\n  ${v.sort().join('\n  ')}`);
const npm = new Map();
for (const [file, info] of Object.entries(r.metafile.inputs)) { const m = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(file); if (m) npm.set(m[1], (npm.get(m[1]) ?? 0) + info.bytes); }
console.log('\nnpm packages inside:', [...npm].map(([k, n]) => `${k} ${(n / 1024).toFixed(0)}KB`).join(', '));
