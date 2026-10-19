import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Minimal Electron app: a headless Spotify Web Playback SDK host. Three
// rollup targets mirror the desktop app's layout (main / preload / renderer)
// so the output lands at out/{main,preload,renderer} where main.ts expects it.
export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			outDir: 'out/main',
			rollupOptions: {
				input: { index: resolve(__dirname, 'src/main.ts') },
				output: { format: 'cjs', entryFileNames: '[name].cjs' },
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			outDir: 'out/preload',
			rollupOptions: {
				input: resolve(__dirname, 'src/preload.ts'),
				// main.ts loads ../preload/index.cjs — pin the name (the input is
				// preload.ts, which would otherwise emit preload.cjs).
				output: { format: 'cjs', entryFileNames: 'index.cjs' },
			},
		},
	},
	renderer: {
		root: resolve(__dirname, 'src/renderer'),
		build: {
			outDir: 'out/renderer',
			// castlabs v38 ships Chromium 13x — a modern baseline is safe.
			target: 'chrome130',
			rollupOptions: {
				input: resolve(__dirname, 'src/renderer/index.html'),
			},
		},
	},
});
