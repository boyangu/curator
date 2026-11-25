// Bundles the server and the two CLIs into dist/ for the image.
//
// Workspace packages (`@curator/protocol`) export TypeScript source, which
// plain Node will not load from node_modules, so they are bundled in; npm
// dependencies stay external and are installed by `pnpm deploy --prod`.
// That is also why `@curator/protocol` is a devDependency: the image ships
// the compiled copy, not the package.

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).flatMap((name) => [name, `${name}/*`]);

await build({
	entryPoints: {
		server: 'src/server.ts',
		migrate: 'src/cli/migrate.ts',
		snapshot: 'src/cli/snapshot.ts',
	},
	outdir: 'dist',
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'esm',
	sourcemap: true,
	external,
	logLevel: 'info',
});
