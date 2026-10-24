// The compact parts of a `library_track.set-analysis` payload (ops.ts
// ZTrackAnalysis, since v5), shared by every writer and reader so a phone
// decodes exactly what a desktop encoded. The grid's form is rb-grid.ts's.

import { ANALYSIS_SEGMENT_LABELS, MAX_OP_PAYLOAD_BYTES, opPayloadBytes, type AnalysisSegment, type TrackAnalysis } from './ops.js';

// Three decimals: a millisecond for times, a thousandth for the 0..1 and
// small-range scores. Below what any view shows or sorts by, and what keeps
// a 200-segment structure near 6 KB.
export function round3(v: number | null | undefined): number | null {
	if (v === null || v === undefined || !Number.isFinite(v)) return null;
	const r = Math.round(v * 1000) / 1000;
	// -0 serialises as 0 but compares unequal under Object.is.
	return r === 0 ? 0 : r;
}

// A segment as the analyzer stores it (desktop SegmentRecord, analyzer source).
export type AnalysisSegmentRecord = { startSec: number; endSec: number; label: string; confidence?: number; energy?: number };

const LABEL_INDEX: ReadonlyMap<string, number> = new Map(ANALYSIS_SEGMENT_LABELS.map((l, i) => [l, i]));

export function encodeAnalysisSegments(segs: readonly AnalysisSegmentRecord[]): AnalysisSegment[] {
	const out: AnalysisSegment[] = [];
	for (const s of segs) {
		const start = round3(s.startSec);
		const end = round3(s.endSec);
		if (start === null || end === null || start < 0 || end < 0 || typeof s.label !== 'string' || s.label.length === 0) continue;
		out.push([start, end, LABEL_INDEX.get(s.label) ?? s.label.slice(0, 32), round3(s.confidence), round3(s.energy)]);
	}
	return out;
}

// Back to the analyzer's records; an absent confidence / energy stays absent
// (the analyzer omits them, it never writes null).
export function decodeAnalysisSegments(tuples: readonly AnalysisSegment[]): Array<AnalysisSegmentRecord & { source: 'analyzer' }> {
	return tuples.map(([startSec, endSec, label, confidence, energy]) => ({
		startSec,
		endSec,
		label: typeof label === 'number' ? ANALYSIS_SEGMENT_LABELS[label] ?? 'unknown' : label,
		source: 'analyzer' as const,
		...(confidence !== null ? { confidence } : {}),
		...(energy !== null ? { energy } : {}),
	}));
}

// Fits an analysis under the op cap: the structure goes first (the bulkiest
// part after a long recording's grid, and the least load-bearing), then the
// grid; the scalars always fit. `dropped` names what was left out.
export function fitTrackAnalysis(a: TrackAnalysis): { analysis: TrackAnalysis; dropped: Array<'segments' | 'grid'> } {
	const dropped: Array<'segments' | 'grid'> = [];
	let cur = a;
	const fits = (x: TrackAnalysis): boolean => opPayloadBytes({ payload: { analysis: x } }) <= MAX_OP_PAYLOAD_BYTES;
	if (!fits(cur) && cur.segments !== null) { cur = { ...cur, segments: null }; dropped.push('segments'); }
	if (!fits(cur) && cur.grid !== null) { cur = { ...cur, grid: null }; dropped.push('grid'); }
	return { analysis: cur, dropped };
}
