import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The fixture pipeline boots PGlite and spawns the Python rekordbox sidecar
// several times; one run takes tens of seconds.
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		testTimeout: 300_000,
		hookTimeout: 120_000,
		// The run-scoped temp root (scripts/test/tmp-root.mjs): mkdtemp dirs, and the
		// sidecars' own temp files, land under one directory this run removes.
		globalSetup: [fileURLToPath(new URL('../scripts/test/tmp-root.mjs', import.meta.url))],
	},
});
