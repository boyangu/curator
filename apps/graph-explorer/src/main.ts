import './styles.css';
import { buildGraph, entityCounts } from './model/buildGraph.js';
import type { GraphData, NodeKind } from './model/types.js';
import { SigmaView } from './render/sigmaView.js';
import { Controls } from './ui/controls.js';
import type { FilterState } from './ui/controls.js';

const statusEl = document.getElementById('status') as HTMLElement;
const panelEl = document.getElementById('panel') as HTMLElement;
const sigmaEl = document.getElementById('sigma') as HTMLElement;

const setStatus = (msg: string) => {
	statusEl.textContent = msg;
	statusEl.style.opacity = msg ? '1' : '0';
};

async function main() {
	setStatus('Loading curator.db dump…');
	let data: GraphData;
	try {
		const res = await fetch('/graph-data.json');
		if (!res.ok) throw new Error(String(res.status));
		data = await res.json();
	} catch {
		setStatus('No graph-data.json — run `pnpm --filter @curator/graph-explorer export` first.');
		return;
	}

	const view = new SigmaView(sigmaEl, () => {
		setStatus('Layout settled');
		setTimeout(() => setStatus(''), 1500);
	});

	// Per-label / per-genre counts drive the filter panes AND the threshold
	// predicates fed to buildGraph.
	const entities = entityCounts(data);
	const artistCount = new Map(entities.artists.map((e) => [e.name, e.count]));
	const labelCount = new Map(entities.labels.map((e) => [e.name, e.count]));
	const genreCount = new Map(entities.genres.map((e) => [e.name, e.count]));

	// Default: tracks OFF (33k nodes is a deliberate opt-in); projected
	// artist/label/genre view is the readable default.
	const initial = new Set<NodeKind>(['artist', 'label', 'genre']);

	const rebuild = (state: FilterState) => {
		const t0 = performance.now();
		setStatus('Building graph…');
		requestAnimationFrame(() => {
			const { graph, stats } = buildGraph(data, {
				visible: state.visible,
				artistEnabled: (n) => (artistCount.get(n) ?? 0) >= state.artist.minTracks && !state.artist.disabled.has(n),
				labelEnabled: (n) => (labelCount.get(n) ?? 0) >= state.label.minTracks && !state.label.disabled.has(n),
				genreEnabled: (n) => (genreCount.get(n) ?? 0) >= state.genre.minTracks && !state.genre.disabled.has(n),
			});
			view.setGraph(graph);
			controls.updateStats(stats);
			const ms = Math.round(performance.now() - t0);
			setStatus(`${stats.nodeCount.toLocaleString()} nodes · ${stats.edgeCount.toLocaleString()} edges · built in ${ms}ms`);
			setTimeout(() => setStatus(''), 2500);
		});
	};

	// Coalesce rapid filter changes (bulk all/none, fast toggling) into one
	// rebuild so we don't restart the layout per click.
	let timer: number | undefined;
	const debouncedRebuild = (state: FilterState) => {
		clearTimeout(timer);
		timer = window.setTimeout(() => rebuild(state), 120);
	};

	const controls = new Controls(panelEl, initial, entities, {
		onChange: debouncedRebuild,
		onSearch: (q) => {
			const id = view.findNode(q);
			if (id) view.focusNode(id);
			else setStatus(`No node matching "${q}"`);
		},
	});

	rebuild(controls.state);
}

main();
