import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// PGlite boots a WASM Postgres per test file (~1.5 s); the default 5 s
// timeout is too tight for the first query on a cold CI runner.
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		// The run-scoped temp root (scripts/test/tmp-root.mjs): mkdtemp dirs land
		// under one directory this run owns and removes.
		globalSetup: [fileURLToPath(new URL('../../scripts/test/tmp-root.mjs', import.meta.url))],
	},
});
