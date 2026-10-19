// In-memory cosine index over one model's track vectors.
//
// Brute force on purpose: the playable library is ~5k tracks (x 1024 dims =
// 20 MB), and a full scan is a few milliseconds — an ANN structure would add
// build cost, approximation and a dependency for nothing. Revisit when segment
// x stem vectors (v2) push a single matrix past ~100k rows.
//
// Two copies of every row, both L2-normalised so cosine = dot product:
//   'centred' — the library mean subtracted first. Foundation-model vectors
//               share a strong common direction; removing it lifted agreement
//               with the user's own tags ~10-25% in the Phase 0 bake-off
//               (research/mir/FINDINGS.md). Used for track-to-track queries.
//   'raw'     — as the model emits them. Text queries use this space: text and
//               audio towers were trained against each other uncentred.
// Multi-seed queries use the normalised centroid of the seeds.

import { type VectorMatrix } from './store.js';

export type Space = 'centred' | 'raw';

export interface Ranked {
	id: string;
	score: number;
}

export class VectorIndex {
	readonly ids: string[];
	readonly dim: number;
	private readonly raw: Float32Array;
	private readonly centred: Float32Array;
	private readonly row = new Map<string, number>();

	constructor(m: VectorMatrix) {
		this.ids = m.ids;
		this.dim = m.dim;
		const n = m.ids.length, dim = m.dim;
		this.raw = new Float32Array(m.data);
		this.centred = new Float32Array(m.data);
		const mean = new Float64Array(dim);
		for (let i = 0; i < n; i++) for (let d = 0; d < dim; d++) mean[d]! += m.data[i * dim + d]! / n;
		for (let i = 0; i < n; i++) {
			this.row.set(m.ids[i]!, i);
			for (let d = 0; d < dim; d++) this.centred[i * dim + d]! -= mean[d]!;
			normalise(this.raw, i * dim, dim);
			normalise(this.centred, i * dim, dim);
		}
	}

	private buf(space: Space): Float32Array { return space === 'raw' ? this.raw : this.centred; }

	get size(): number { return this.ids.length; }

	has(id: string): boolean { return this.row.has(id); }

	vector(id: string, space: Space = 'centred'): Float32Array | null {
		const r = this.row.get(id);
		return r === undefined ? null : this.buf(space).subarray(r * this.dim, (r + 1) * this.dim);
	}

	// Normalised mean of the seeds that have vectors; null when none do.
	centroid(seedIds: string[], space: Space = 'centred'): Float32Array | null {
		const acc = new Float32Array(this.dim);
		let n = 0;
		for (const id of seedIds) {
			const v = this.vector(id, space);
			if (!v) continue;
			for (let d = 0; d < this.dim; d++) acc[d]! += v[d]!;
			n++;
		}
		if (n === 0) return null;
		normalise(acc, 0, this.dim);
		return acc;
	}

	// Top-k by cosine to `query` (already normalised), optionally restricted to
	// `allow` and skipping `exclude`. Partial selection keeps it O(n log k).
	topK(query: Float32Array, k: number, allow?: ReadonlySet<string> | null, exclude?: ReadonlySet<string>,
		space: Space = 'centred'): Ranked[] {
		if (query.length !== this.dim || k <= 0) return [];
		const heap: Ranked[] = []; // min-heap on score
		const dim = this.dim;
		const data = this.buf(space);
		for (let i = 0; i < this.ids.length; i++) {
			const id = this.ids[i]!;
			if (allow && !allow.has(id)) continue;
			if (exclude?.has(id)) continue;
			let s = 0;
			const off = i * dim;
			for (let d = 0; d < dim; d++) s += data[off + d]! * query[d]!;
			if (heap.length < k) { heap.push({ id, score: s }); siftUp(heap, heap.length - 1); }
			else if (s > heap[0]!.score) { heap[0] = { id, score: s }; siftDown(heap, 0); }
		}
		return heap.sort((a, b) => b.score - a.score);
	}

	// Cosine of `query` against every row (aligned with `ids`) — the per-model
	// leg of a multi-model blend.
	scoreAll(query: Float32Array, space: Space = 'centred'): Float32Array {
		const out = new Float32Array(this.ids.length);
		const data = this.buf(space);
		for (let i = 0; i < this.ids.length; i++) {
			let s = 0;
			const off = i * this.dim;
			for (let d = 0; d < this.dim; d++) s += data[off + d]! * query[d]!;
			out[i] = s;
		}
		return out;
	}
}

export function normalise(buf: Float32Array, off: number, dim: number): void {
	let n = 0;
	for (let d = 0; d < dim; d++) n += buf[off + d]! * buf[off + d]!;
	const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
	for (let d = 0; d < dim; d++) buf[off + d]! *= inv;
}

function siftUp(h: Ranked[], i: number): void {
	while (i > 0) {
		const p = (i - 1) >> 1;
		if (h[p]!.score <= h[i]!.score) return;
		[h[p], h[i]] = [h[i]!, h[p]!];
		i = p;
	}
}

function siftDown(h: Ranked[], i: number): void {
	for (;;) {
		const l = 2 * i + 1, r = l + 1;
		let m = i;
		if (l < h.length && h[l]!.score < h[m]!.score) m = l;
		if (r < h.length && h[r]!.score < h[m]!.score) m = r;
		if (m === i) return;
		[h[m], h[i]] = [h[i]!, h[m]!];
		i = m;
	}
}
