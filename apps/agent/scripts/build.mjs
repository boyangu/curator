// Bundles the sidecar into dist/main.js, the file the desktop spawns under
// ELECTRON_RUN_AS_NODE (apps/desktop/src/main/index.ts getAgentSpec).
//
// @curator/agent-core exports TypeScript source, which plain Node will not
// load from node_modules, so it is bundled in (hence a devDependency, as
// apps/cloud does with @curator/protocol); the AI SDK packages stay external
// and are resolved from node_modules at run time.

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).flatMap((name) => [name, `${name}/*`]);

await build({
	entryPoints: { main: 'src/main.ts' },
	outdir: 'dist',
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'esm',
	sourcemap: true,
	external,
	logLevel: 'info',
});
