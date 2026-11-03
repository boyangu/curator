// Bundles the regression set's provider: workspace packages (@curator/*)
// export TypeScript source, which promptfoo's loader will not read from
// node_modules, so they go into the bundle; npm dependencies stay external
// and resolve from apps/cloud/node_modules (as scripts/build.mjs does).

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).flatMap((name) => [name, `${name}/*`]);

await build({
	entryPoints: { provider: fileURLToPath(new URL('./provider.ts', import.meta.url)) },
	outdir: fileURLToPath(new URL('./dist', import.meta.url)),
	outExtension: { '.js': '.mjs' },
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'esm',
	external,
	logLevel: 'warning',
});
