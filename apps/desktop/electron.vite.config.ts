import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite';
import solid from 'vite-plugin-solid';

const repoRoot = resolve(__dirname, '../..');

// Vendor credentials and project identifiers the main bundle carries. Each
// is replaced at build time where the source reads `process.env.<NAME>`
// (apps/core/src/config.ts, src/main/cloud-config.ts) — set or `undefined`,
// so a packaged app never consults the end user's shell. Values come from
// the build machine: `.env` at the repo root, then apps/desktop/.env, then
// the shell (closer wins; Vite's loadEnv already prefers the shell). The
// same path serves `electron-vite dev`, so a git-ignored .env is all a dev
// checkout needs. Unset ⇒ that feature reports "not configured".
//
// A build refuses to run with any REQUIRED one unset unless the builder says
// CURATOR_ALLOW_UNCONFIGURED_BUILD=1, so a release is never silently
// local-only. The cloud API URL is the exception: empty is the documented
// "sign-in works, library sync off" state until the API is deployed, so it
// only warns.
const REQUIRED_ENV = [
	'CURATOR_SPOTIFY_CLIENT_ID',
	'CURATOR_TIDAL_CLIENT_ID',
	'CURATOR_TIDAL_CLIENT_SECRET',
	'CURATOR_GOOGLE_CLIENT_ID',
	'CURATOR_GOOGLE_CLIENT_SECRET',
	'CURATOR_SUPABASE_URL',
	'CURATOR_SUPABASE_PUBLISHABLE_KEY',
] as const;
const OPTIONAL_ENV = ['CURATOR_CLOUD_API_URL'] as const;

function bakedEnv(mode: string, command: 'build' | 'serve'): Record<string, string> {
	const env = { ...loadEnv(mode, repoRoot, 'CURATOR_'), ...loadEnv(mode, __dirname, 'CURATOR_') };
	const value = (k: string): string => (env[k] ?? '').trim();
	const verb = command === 'build' ? 'building' : 'running';
	const missing = REQUIRED_ENV.filter((k) => !value(k));
	if (missing.length) {
		const list = missing.join(', ');
		if (command === 'build' && process.env['CURATOR_ALLOW_UNCONFIGURED_BUILD'] !== '1') {
			throw new Error(
				`[curator] refusing to build with unset ${list}. ` +
				`Put them in .env at the repo root (see .env.example) or set them in the shell; ` +
				`for a deliberately local-only build set CURATOR_ALLOW_UNCONFIGURED_BUILD=1.`,
			);
		}
		console.warn(`[curator] ${verb} without ${list}: those features will report "not configured"`);
	}
	for (const k of OPTIONAL_ENV) {
		if (!value(k)) console.warn(`[curator] ${verb} without ${k}: library sync will be off`);
	}
	return Object.fromEntries([...REQUIRED_ENV, ...OPTIONAL_ENV].map((k) => [`process.env.${k}`, value(k) ? JSON.stringify(value(k)) : 'undefined']));
}

export default defineConfig(({ mode, command }) => ({
	main: {
		// workspace packages are TS source — bundle them. native modules
		// (better-sqlite3) + electron stay external.
		plugins: [
			externalizeDepsPlugin({
				exclude: ['@curator/core', '@curator/shared', '@curator/protocol', '@curator/spotify', '@curator/tidal', '@curator/matcher', '@curator/musicbrainz', '@curator/beatport', '@curator/google-drive'],
			}),
		],
		define: bakedEnv(mode, command),
		build: {
			outDir: 'out/main',
			rollupOptions: {
				input: {
					// Electron `main` process entry.
					index: resolve(__dirname, 'src/main/index.ts'),
					// Utility-process script for off-main audio metadata parsing.
					// Forked from the main process via app.utilityProcess.fork
					// (see src/main/ingest/pool.ts). Bundled as a separate CJS
					// file so the worker has its own minimal module graph.
					'ingest-worker': resolve(__dirname, 'src/main/ingest/worker.ts'),
					// Utility-process script that hosts @curator/core entirely
					// off the main event loop. Talks to main via the protocol
					// in src/main/core-sidecar/protocol.ts. Enabled at runtime
					// when CORE_SIDECAR=1 — see src/main/index.ts boot path.
					'core-sidecar': resolve(__dirname, 'src/main/core-sidecar/entry.ts'),
					// Utility-process script hosting the agent workspace's
					// SQLite engine — OS-killable so runaway agent SQL can't
					// wedge the main loop (src/main/workspace/host.ts).
					'workspace-worker': resolve(__dirname, 'src/main/workspace/worker.ts'),
					// Utility-process script hosting the backup engine — DB
					// snapshots, hashing, zstd and uploads stay off the main loop
					// (src/main/backup/host.ts).
					'backup-worker': resolve(__dirname, 'src/main/backup/worker.ts'),
					// Utility-process script that builds the account snapshot this
					// device publishes as its master — reading every sync record and
					// gzipping ~227 MB of JSON stays off the main loop
					// (src/main/cloud/snapshot-host.ts).
					'snapshot-worker': resolve(__dirname, 'src/main/cloud/snapshot-worker.ts'),
				},
				output: { format: 'cjs', entryFileNames: '[name].cjs' },
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin({ exclude: ['@curator/shared'] })],
		build: {
			outDir: 'out/preload',
			rollupOptions: {
				input: resolve(__dirname, 'src/preload/index.ts'),
				output: { format: 'cjs' },
			},
		},
	},
	renderer: {
		root: resolve(__dirname, 'src/renderer'),
		// vite-plugin-solid handles .tsx/.jsx — no-op for the existing .ts
		// files but ready for the incremental Solid migration (see
		// MEMORY/curator-refactor-phases). solid-js itself is also used in
		// .ts files via createSignal / createMutable / createEffect to
		// replace hand-rolled pub/sub without introducing JSX yet.
		plugins: [solid()],
		build: {
			outDir: 'out/renderer',
			// Electron 33 ships Chromium 130 — safe to target a modern baseline.
			// @tidal-music/player uses top-level await (chrome 89+); without
			// this override electron-vite falls back to es2020 and esbuild
			// throws "Top-level await is not available" during bundling.
			target: 'chrome130',
			rollupOptions: {
				input: resolve(__dirname, 'src/renderer/index.html'),
			},
		},
		// Dev server / optimizeDeps must use the same target so pre-bundling
		// of node_modules (which is where TLA actually lives) doesn't choke.
		optimizeDeps: { esbuildOptions: { target: 'chrome130' } },
		esbuild: { target: 'chrome130' },
	},
}));
