// Bundles the sidecar into dist/main.js, the file the desktop spawns under
// ELECTRON_RUN_AS_NODE (apps/desktop/src/main/index.ts getAgentSpec).
//
// Everything is bundled: @curator/agent-core (TypeScript source, which plain
// Node will not load from node_modules) and the AI SDK + zod (pure JS). A
// packaged app ships resources/agent/dist/main.js alone, with no
// node_modules beside it (scripts/build-sidecars.mjs stages it).

import { build } from 'esbuild';

await build({
	entryPoints: { main: 'src/main.ts' },
	outdir: 'dist',
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'esm',
	sourcemap: true,
	external: [],
	logLevel: 'info',
});
