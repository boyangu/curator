// Sigma (WebGL) view over a graphology graph, with a ForceAtlas2 worker layout.
// The worker keeps layout off the main thread so panning/zoom stay smooth even
// while tens of thousands of nodes settle (Curator's perf ethos applied here).

import Graph from 'graphology';
import Sigma from 'sigma';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import { inferSettings } from 'graphology-layout-forceatlas2';
import type { NodeKind } from '../model/types.js';

export class SigmaView {
	private sigma: Sigma;
	private layout: FA2Layout | null = null;
	private graph: Graph;
	private hovered: string | null = null;
	private convergeTimer: number | null = null;
	private prevPos: Map<string, [number, number]> | null = null;

	// Fired once per layout when it settles (or hits the convergence cap).
	constructor(container: HTMLElement, private onSettled?: () => void) {
		this.graph = new Graph({ multi: false, type: 'undirected' });
		this.sigma = new Sigma(this.graph, container, {
			labelRenderedSizeThreshold: 12,
			labelDensity: 0.6,
			labelGridCellSize: 80,
			defaultEdgeColor: '#262a30',
			minCameraRatio: 0.02,
			maxCameraRatio: 12,
		});
		this.wireHighlight();
	}

	// Swap in a freshly-built graph. We seed positions (circle by kind) so FA2
	// has a non-degenerate start, size nodes by degree, then kick the worker.
	setGraph(graph: Graph): void {
		this.stopLayout();
		seedPositions(graph);
		sizeByDegree(graph);
		sizeEdgesByWeight(graph);
		this.graph = graph;
		this.sigma.setGraph(graph);
		this.sigma.getCamera().animatedReset();

		const settings = inferSettings(graph);
		this.layout = new FA2Layout(graph, {
			settings: { ...settings, slowDown: 1 + Math.log(graph.order + 1) },
		});
		this.layout.start();
		this.watchConvergence();
	}

	stopLayout(): void {
		if (this.convergeTimer !== null) {
			clearInterval(this.convergeTimer);
			this.convergeTimer = null;
		}
		this.prevPos = null;
		if (this.layout) {
			this.layout.kill();
			this.layout = null;
		}
	}

	// FA2 runs indefinitely on its own; poll node movement and pause the worker
	// once the layout settles. FA2 motion starts large (nodes expanding from the
	// seed rings) and decays toward residual jiggle — so we stop RELATIVE to the
	// peak motion seen, not at an absolute epsilon (a fixed threshold either
	// never triggers on a big graph or fires too early on a tiny one). Stop when
	// mean per-node move stays below a small fraction of the peak for a couple of
	// samples; an absolute extent-normalized floor and a hard time cap are
	// backstops. This is what keeps the canvas from churning CPU forever.
	private watchConvergence(): void {
		const SETTLE_FRACTION = 0.06; // mean move < 6% of peak ⇒ decayed
		const ABS_FLOOR = 0.0008; // …or < 0.08% of extent (truly still)
		const STABLE_SAMPLES = 2;
		const MIN_MS = 1200; // don't declare victory before forces ramp up
		const SAMPLE_MS = 400;
		const MAX_MS = 20000;
		const started = performance.now();
		let stable = 0;
		let peak = 0;
		this.prevPos = this.snapshotPositions();

		this.convergeTimer = window.setInterval(() => {
			if (!this.layout || !this.prevPos) return;
			const { mean, extent } = this.displacementSince(this.prevPos);
			this.prevPos = this.snapshotPositions();
			peak = Math.max(peak, mean);

			const elapsed = performance.now() - started;
			const decayed = peak > 0 && mean < SETTLE_FRACTION * peak;
			const still = extent > 0 && mean / extent < ABS_FLOOR;
			if (elapsed > MIN_MS && (decayed || still)) stable++;
			else stable = 0;

			if (stable >= STABLE_SAMPLES || elapsed > MAX_MS) {
				this.layout.stop();
				if (this.convergeTimer !== null) clearInterval(this.convergeTimer);
				this.convergeTimer = null;
				this.prevPos = null;
				this.onSettled?.();
			}
		}, SAMPLE_MS);
	}

	private snapshotPositions(): Map<string, [number, number]> {
		const m = new Map<string, [number, number]>();
		this.graph.forEachNode((id, a) => m.set(id, [a.x as number, a.y as number]));
		return m;
	}

	// Mean per-node move since `prev`, plus the current bounding-box extent used
	// to normalize it (so the epsilon is scale-independent).
	private displacementSince(prev: Map<string, [number, number]>): { mean: number; extent: number } {
		let sum = 0;
		let n = 0;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		this.graph.forEachNode((id, a) => {
			const x = a.x as number;
			const y = a.y as number;
			const p = prev.get(id);
			if (p) {
				sum += Math.hypot(x - p[0], y - p[1]);
				n++;
			}
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		});
		const extent = Math.max(maxX - minX, maxY - minY);
		return { mean: n > 0 ? sum / n : 0, extent: Number.isFinite(extent) ? extent : 0 };
	}

	private wireHighlight(): void {
		this.sigma.on('enterNode', ({ node }) => {
			this.hovered = node;
			this.sigma.refresh();
		});
		this.sigma.on('leaveNode', () => {
			this.hovered = null;
			this.sigma.refresh();
		});

		// Dim everything not adjacent to the hovered node.
		this.sigma.setSetting('nodeReducer', (node, data) => {
			if (!this.hovered) return data;
			if (node === this.hovered || this.graph.areNeighbors(node, this.hovered)) return data;
			return { ...data, color: '#1b1e24', label: '' };
		});
		this.sigma.setSetting('edgeReducer', (edge, data) => {
			if (!this.hovered) return data;
			if (this.graph.hasExtremity(edge, this.hovered)) return { ...data, color: '#3a4250' };
			return { ...data, hidden: true };
		});
	}

	// Center + zoom onto a node id (used by search).
	focusNode(id: string): boolean {
		if (!this.graph.hasNode(id)) return false;
		const { x, y } = this.sigma.getNodeDisplayData(id) ?? { x: 0, y: 0 };
		this.sigma.getCamera().animate({ x, y, ratio: 0.1 }, { duration: 500 });
		this.hovered = id;
		this.sigma.refresh();
		return true;
	}

	findNode(query: string): string | null {
		const q = query.trim().toLowerCase();
		if (!q) return null;
		let best: string | null = null;
		let bestW = -1;
		this.graph.forEachNode((id, attrs) => {
			if (String(attrs.label).toLowerCase().includes(q) && (attrs.weight ?? 0) > bestW) {
				best = id;
				bestW = attrs.weight ?? 0;
			}
		});
		return best;
	}
}

// Seed each kind on its own ring so FA2 doesn't start from a single point.
function seedPositions(graph: Graph): void {
	const ringRadius: Record<NodeKind, number> = { genre: 2, label: 5, artist: 9, track: 14 };
	const counters: Record<string, number> = {};
	const totals: Record<string, number> = {};
	graph.forEachNode((_id, a) => {
		totals[a.kind] = (totals[a.kind] ?? 0) + 1;
	});
	graph.forEachNode((id, a) => {
		const kind = a.kind as NodeKind;
		const i = (counters[kind] = (counters[kind] ?? 0) + 1);
		const n = totals[kind] ?? 1;
		const r = ringRadius[kind] ?? 8;
		const angle = (2 * Math.PI * i) / n;
		graph.setNodeAttribute(id, 'x', r * Math.cos(angle));
		graph.setNodeAttribute(id, 'y', r * Math.sin(angle));
	});
}

// Edge thickness ∝ weight (co-occurrence count). sqrt-scaled + normalized to the
// heaviest edge so a few dominant pairs don't drown everything else out.
function sizeEdgesByWeight(graph: Graph): void {
	let max = 1;
	graph.forEachEdge((_e, a) => {
		max = Math.max(max, a.weight ?? 1);
	});
	graph.forEachEdge((e, a) => {
		const w = a.weight ?? 1;
		graph.setEdgeAttribute(e, 'size', 0.4 + 5 * Math.sqrt(w / max));
	});
}

function sizeByDegree(graph: Graph): void {
	let max = 1;
	graph.forEachNode((id) => {
		max = Math.max(max, graph.degree(id));
	});
	graph.forEachNode((id) => {
		const d = graph.degree(id);
		// sqrt scale so a 1000-degree hub doesn't swallow the canvas.
		graph.setNodeAttribute(id, 'size', 1.5 + 7 * Math.sqrt(d / max));
	});
}
