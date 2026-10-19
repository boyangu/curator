// Raw dump shape (produced by scripts/export-graph.mjs). This is intentionally
// close to curator.db rows — all graph MODELING happens in buildGraph.ts.

export type RawTrack = {
	id: string;
	title: string;
	artists: string[];
	genre: string | null;
	label: string | null;
	bpm: number | null;
	key: string | null;
	year: string | null;
};

export type GraphData = {
	meta: { source: string; trackCount: number; generatedAtMs: number };
	tracks: RawTrack[];
};

// The four node kinds the toggles expose. `track` is the high-cardinality one
// (tens of thousands); the rest are derived entities.
export type NodeKind = 'artist' | 'label' | 'genre' | 'track';
export const NODE_KINDS: NodeKind[] = ['artist', 'label', 'genre', 'track'];

export const KIND_COLOR: Record<NodeKind, string> = {
	artist: '#5b8def', // blue
	label: '#e0a93b', // amber
	genre: '#3fb27f', // green
	track: '#8a8f98', // grey (recedes — there are a lot of them)
};

export const KIND_LABEL: Record<NodeKind, string> = {
	artist: 'Artists',
	label: 'Labels',
	genre: 'Genres',
	track: 'Tracks',
};
