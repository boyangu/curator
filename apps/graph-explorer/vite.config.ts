import { defineConfig } from 'vite';

// Plain Vite SPA. `public/graph-data.json` is served statically and fetched at
// boot — there is no backend in this experiment by design (see README in this
// app's dir / the app's purpose: pure in-memory graph over a static dump).
export default defineConfig({
	server: { port: 5180, open: true },
	// The graph dump can be tens of MB; don't inline-warn on it.
	build: { chunkSizeWarningLimit: 4096 },
});
