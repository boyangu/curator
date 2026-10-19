// ─── THE EXPERIMENT SEAM ───────────────────────────────────────────────────
// Raw curator.db rows → an in-memory graphology graph. This is the file to
// hack on when trying different knowledge-graph modelings. Everything above
// (render, UI) is model-agnostic.
//
// Two modeling modes, chosen by whether `track` is among the visible kinds:
//
//   • tracks VISIBLE  — bipartite-ish: every track is a node, joined by an
//     edge to each of its artists / its label / its genre. This is the literal
//     curator.db shape. High node count (~33k tracks) — WebGL territory.
//
//   • tracks HIDDEN   — PROJECTION: collapse each track into co-occurrence
//     edges among its entities (artist↔artist collab, artist↔genre,
//     artist↔label, label↔genre). This is where the "what does the library
//     look like as a network of artists/labels/genres" picture lives, and the
//     projection rule is itself a modeling choice worth iterating on.
//
// Edge weights accumulate co-occurrence counts; node `weight` accumulates how
// many tracks touch the entity (drives node size downstream).

import Graph from 'graphology';
import type { GraphData, NodeKind } from './types.js';
import { KIND_COLOR } from './types.js';

export type VisibleKinds = Set<NodeKind>;

export type BuildOptions = {
	visible: VisibleKinds;
	// Per-entity include predicates (artist/label/genre filter panes). Default =
	// include all. An entity that fails its predicate is dropped from the graph —
	// in track-mode the track keeps its other neighbors; a track left with no
	// visible neighbor is skipped (same as before). Artist predicates run against
	// the SPLIT artist names (see splitArtists), matching the filter-pane counts.
	artistEnabled?: (name: string) => boolean;
	labelEnabled?: (name: string) => boolean;
	genreEnabled?: (name: string) => boolean;
};

export type EntityCount = { name: string; count: number };

// Per-artist / per-label / per-genre track counts over the (already local-only)
// dump, sorted by count descending. Drives the filter panes' ordering +
// thresholds. Artists use the SAME split as the graph (one increment per unique
// artist per track); a track carries at most one label/genre, so those are plain
// tallies.
export function entityCounts(data: GraphData): {
	artists: EntityCount[];
	labels: EntityCount[];
	genres: EntityCount[];
} {
	const artists = new Map<string, number>();
	const labels = new Map<string, number>();
	const genres = new Map<string, number>();
	for (const t of data.tracks) {
		for (const name of splitArtists(t.artists)) artists.set(name, (artists.get(name) ?? 0) + 1);
		if (t.label) labels.set(t.label, (labels.get(t.label) ?? 0) + 1);
		if (t.genre) genres.set(t.genre, (genres.get(t.genre) ?? 0) + 1);
	}
	const sorted = (m: Map<string, number>): EntityCount[] =>
		[...m.entries()]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
	return { artists: sorted(artists), labels: sorted(labels), genres: sorted(genres) };
}

// Multi-artist separators seen in curator.db artist strings. Deliberately
// excludes '&' (duo/act names: "Yohan & David", "&ME").
const ARTIST_DELIM = /[;,/]/;
function splitArtists(names: string[]): string[] {
	const out = new Set<string>();
	for (const raw of names) {
		for (const part of raw.split(ARTIST_DELIM)) {
			const n = part.trim();
			if (n) out.add(n);
		}
	}
	return [...out];
}

const artistId = (name: string) => `artist:${name}`;
const labelId = (name: string) => `label:${name}`;
const genreId = (name: string) => `genre:${name}`;
const trackId = (id: string) => `track:${id}`;

export type BuildStats = {
	nodesByKind: Record<NodeKind, number>;
	nodeCount: number;
	edgeCount: number;
};

export function buildGraph(data: GraphData, opts: BuildOptions): { graph: Graph; stats: BuildStats } {
	const graph = new Graph({ multi: false, type: 'undirected' });

	const { visible } = opts;
	const artistEnabled = opts.artistEnabled ?? (() => true);
	const labelEnabled = opts.labelEnabled ?? (() => true);
	const genreEnabled = opts.genreEnabled ?? (() => true);

	const showArtist = visible.has('artist');
	const showLabel = visible.has('label');
	const showGenre = visible.has('genre');
	const showTrack = visible.has('track');

	const ensureEntity = (id: string, kind: NodeKind, label: string) => {
		if (!graph.hasNode(id)) {
			graph.addNode(id, { kind, label, weight: 0, color: KIND_COLOR[kind] });
		}
		graph.updateNodeAttribute(id, 'weight', (w) => (w ?? 0) + 1);
		return id;
	};

	const link = (a: string, b: string) => {
		if (a === b) return;
		if (graph.hasEdge(a, b)) {
			graph.updateEdgeAttribute(a, b, 'weight', (w) => (w ?? 1) + 1);
		} else {
			graph.addEdge(a, b, { weight: 1 });
		}
	};

	for (const t of data.tracks) {
		// Collect the visible entity nodes this track contributes. A single
		// `artists` entry can pack several artists ("Rampa, Adam Port, &ME") —
		// split into individuals so each is its own node. `&` is NOT a delimiter
		// (it belongs to duo names like "Yohan & David" / "&ME").
		const artistNodes = showArtist
			? splitArtists(t.artists)
					.filter(artistEnabled)
					.map((n) => ensureEntity(artistId(n), 'artist', n))
			: [];
		const labelNode =
			showLabel && t.label && labelEnabled(t.label) ? ensureEntity(labelId(t.label), 'label', t.label) : null;
		const genreNode =
			showGenre && t.genre && genreEnabled(t.genre) ? ensureEntity(genreId(t.genre), 'genre', t.genre) : null;

		if (showTrack) {
			// Track-mediated (bipartite) edges. Only materialize the track node if
			// it has at least one visible neighbor — orphan tracks add noise.
			const neighbors = [...artistNodes];
			if (labelNode) neighbors.push(labelNode);
			if (genreNode) neighbors.push(genreNode);
			if (neighbors.length === 0) continue;
			const tn = trackId(t.id);
			graph.addNode(tn, { kind: 'track', label: t.title, weight: 1, color: KIND_COLOR.track });
			for (const n of neighbors) link(tn, n);
		} else {
			// Projection: connect every visible entity of this track to every other.
			const ents: string[] = [...artistNodes];
			if (labelNode) ents.push(labelNode);
			if (genreNode) ents.push(genreNode);
			for (let i = 0; i < ents.length; i++) {
				for (let j = i + 1; j < ents.length; j++) link(ents[i], ents[j]);
			}
		}
	}

	const nodesByKind: Record<NodeKind, number> = { artist: 0, label: 0, genre: 0, track: 0 };
	graph.forEachNode((_id, attrs) => {
		nodesByKind[attrs.kind as NodeKind]++;
	});

	return {
		graph,
		stats: { nodesByKind, nodeCount: graph.order, edgeCount: graph.size },
	};
}
