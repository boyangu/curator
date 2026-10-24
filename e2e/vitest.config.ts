import { defineConfig } from 'vitest/config';

// The fixture pipeline boots PGlite and spawns the Python rekordbox sidecar
// several times; one run takes tens of seconds.
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		testTimeout: 300_000,
		hookTimeout: 120_000,
	},
});
