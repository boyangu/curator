import { defineConfig } from 'vitest/config';

// PGlite boots a WASM Postgres per test file (~1.5 s); the default 5 s
// timeout is too tight for the first query on a cold CI runner.
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
