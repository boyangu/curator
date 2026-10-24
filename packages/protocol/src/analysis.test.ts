// library_track.set-analysis (protocol v5): the compact encodings round-trip,
// the worst real row fits the op cap (and a synthetic worse one is fitted by
// dropping structure, then grid), the cell is per device with the master's
// winning whole, a restated value is suppressed, a withdrawal clears, and a
// recording merge folds the cells like any other.

import { describe, it, expect } from 'vitest';
import { decodeAnalysisSegments, encodeAnalysisSegments, fitTrackAnalysis, round3, type AnalysisSegmentRecord } from './analysis.js';
import { MASTER_DEVICE_SETTING, MAX_OP_PAYLOAD_BYTES, opPayloadBytes, parseOp, SCHEMA_VERSION, ZTrackAnalysis, type Op, type TrackAnalysis } from './ops.js';
import { decodeRbGrid, encodeRbGrid } from './rb-grid.js';
import { applyOp, isRestatement } from './reduce.js';
import { analysisCellName, createLibraryState, materialize, resolveTrackAnalysis } from './state.js';

const REC = '00000000-0000-4000-8000-0000000000a1';
const REC2 = '00000000-0000-4000-8000-0000000000a2';
let n = 0;
const op = (device: string, ts: number, entity: string, kind: string, entityId: string, payload: unknown): Op =>
	parseOp({ op_id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, device_id: device, client_ts: ts, schema_version: SCHEMA_VERSION, entity, entity_id: entityId, kind, payload });

// Beats at `bpm` for `minutes` with sub-ms jitter (the analyzer's grid is not
// on whole ms), a downbeat every four.
function grid(minutes: number, bpm = 128): { beats: number[]; downs: number[] } {
	const beats: number[] = [];
	const step = 60 / bpm;
	for (let i = 0, t = 0.137; t < minutes * 60; i++, t += step) beats.push(Math.fround(t + ((i * 7919) % 9) * 0.0001));
	return { beats, downs: beats.filter((_, i) => i % 4 === 0) };
}

function segments(count: number): AnalysisSegmentRecord[] {
	const labels = ['intro', 'build', 'drop', 'breakdown', 'main', 'outro', 'unknown'];
	return Array.from({ length: count }, (_, i) => ({ startSec: i * 7.123456, endSec: (i + 1) * 7.123456, label: labels[i % labels.length]!, confidence: 0.123456 + (i % 10) / 13, energy: 0.987654 - (i % 10) / 17 }));
}

function analysis(over: Partial<TrackAnalysis> = {}): TrackAnalysis {
	const g = grid(7);
	return {
		audio_hash: 'pcm-md5:' + 'ab'.repeat(16), analyzer_version: '2.4.0', analyzed_at: 1_760_000_000_000, duration: round3(421.123456),
		bpm: round3(127.99987), key_camelot: '8A', key_strength: round3(0.81234), brightness: round3(1.23456), power: round3(0.5432), dynamic_complexity: round3(3.14159),
		loudness_range_lu: round3(6.2), dissonance: round3(0.44), density: round3(12.1), intro_length_sec: 16, outro_length_sec: 24.5, first_drop_sec: 64,
		drop_count: 2, breakdown_count: 1, grid: encodeRbGrid(g.beats, g.downs), segments: encodeAnalysisSegments(segments(12)),
		...over,
	};
}

describe('the compact parts', () => {
	it('round-trips the grid to the millisecond and the segments to three decimals', () => {
		const g = grid(7);
		const back = decodeRbGrid(encodeRbGrid(g.beats, g.downs)!)!;
		expect(back.beatsSec.length).toBe(g.beats.length);
		back.beatsSec.forEach((t, i) => expect(Math.abs(t - g.beats[i]!)).toBeLessThanOrEqual(0.0005));
		expect(back.downbeatsSec.length).toBe(g.downs.length);
		const segs = segments(5);
		const tuples = encodeAnalysisSegments(segs);
		expect(tuples[0]).toEqual([0, 7.123, 0, 0.123, 0.988]);
		const decoded = decodeAnalysisSegments(tuples);
		decoded.forEach((s, i) => {
			expect(s.label).toBe(segs[i]!.label);
			expect(s.source).toBe('analyzer');
			expect(Math.abs(s.startSec - segs[i]!.startSec)).toBeLessThanOrEqual(0.0005);
		});
		// A label outside the analyzer's vocabulary rides as itself; an absent
		// confidence stays absent.
		const odd = encodeAnalysisSegments([{ startSec: 1, endSec: 2, label: 'riser' }]);
		expect(odd).toEqual([[1, 2, 'riser', null, null]]);
		expect(decodeAnalysisSegments(odd)).toEqual([{ startSec: 1, endSec: 2, label: 'riser', source: 'analyzer' }]);
		// Stable: encoding the decoded form gives the same tuples.
		expect(encodeAnalysisSegments(decoded)).toEqual(tuples);
	});

	it('an ordinary track is a few KB and parses', () => {
		const a = analysis();
		expect(ZTrackAnalysis.safeParse(a).success).toBe(true);
		const bytes = opPayloadBytes({ payload: { analysis: a } });
		expect(bytes).toBeLessThan(4_500);
		expect(op('m', 1, 'library_track', 'set-analysis', REC, { analysis: a }).payload).toEqual({ analysis: a });
	});

	it('the worst real row (6.2 KB structure, 9.2 KB grid) fits; a worse one drops structure, then grid, never the scalars', () => {
		// The master's largest (2026-10-23, read-only): a 9,241-byte grid and a
		// 6,236-byte structure, never on one row — together they still fit.
		const long = grid(24);
		const worst = analysis({ grid: encodeRbGrid(long.beats, long.downs), segments: encodeAnalysisSegments(segments(210)) });
		const gridBytes = JSON.stringify(worst.grid).length;
		const segBytes = JSON.stringify(worst.segments).length;
		expect(gridBytes).toBeGreaterThan(8_000);
		expect(segBytes).toBeGreaterThan(6_000);
		const fit = fitTrackAnalysis(worst);
		expect(opPayloadBytes({ payload: { analysis: fit.analysis } })).toBeLessThanOrEqual(MAX_OP_PAYLOAD_BYTES);
		expect(fit.dropped).toEqual([]);
		// A recorded mix: structure goes first…
		const mix = grid(40);
		const big = fitTrackAnalysis(analysis({ grid: encodeRbGrid(mix.beats, mix.downs), segments: encodeAnalysisSegments(segments(400)) }));
		expect(big.dropped[0]).toBe('segments');
		expect(opPayloadBytes({ payload: { analysis: big.analysis } })).toBeLessThanOrEqual(MAX_OP_PAYLOAD_BYTES);
		// …then the grid of a mix too long for any op; the scalars always stay.
		const set = grid(120);
		const huge = fitTrackAnalysis(analysis({ grid: encodeRbGrid(set.beats, set.downs), segments: encodeAnalysisSegments(segments(400)) }));
		expect(huge.dropped).toEqual(['segments', 'grid']);
		expect(huge.analysis.bpm).toBe(128);
		expect(huge.analysis.power).toBe(0.543);
		expect(() => op('m', 1, 'library_track', 'set-analysis', REC, { analysis: huge.analysis })).not.toThrow();
	});
});

describe('the cell', () => {
	it('is per device; the master\'s wins whole, else the later write; a withdrawal clears', () => {
		const s = createLibraryState();
		applyOp(s, op('m', 10, 'library_track', 'create', REC, {}));
		applyOp(s, op('lap', 20, 'library_track', 'set-analysis', REC, { analysis: analysis({ bpm: 120, power: 0.1 }) }));
		applyOp(s, op('m', 15, 'library_track', 'set-analysis', REC, { analysis: analysis({ bpm: 124, segments: null }) }));
		const rec = s.libraryTracks.get(REC)!;
		expect(Object.keys(rec.fields).sort()).toEqual([analysisCellName('lap'), analysisCellName('m')]);
		// No master stated: the later write.
		expect(resolveTrackAnalysis(rec, null)!.device).toBe('lap');
		// The master's, whole: its grid with its (absent) structure, not mixed.
		const won = resolveTrackAnalysis(rec, 'm')!;
		expect([won.device, won.analysis.bpm, won.analysis.segments]).toEqual(['m', 124, null]);
		applyOp(s, op('m', 1, 'setting', 'set', MASTER_DEVICE_SETTING, { value: 'm' }));
		expect(materialize(s).libraryTracks[0]!.analysis).toMatchObject({ device: 'm', bpm: 124 });
		// The master withdraws: the other device's cell shows.
		applyOp(s, op('m', 30, 'library_track', 'set-analysis', REC, { analysis: null }));
		expect(materialize(s).libraryTracks[0]!.analysis).toMatchObject({ device: 'lap', bpm: 120 });
		applyOp(s, op('lap', 31, 'library_track', 'set-analysis', REC, { analysis: null }));
		expect(materialize(s).libraryTracks[0]!.analysis).toBeNull();
	});

	it('a restated analysis is suppressed; a changed one (a re-analysis) is not', () => {
		const s = createLibraryState();
		const a = analysis();
		applyOp(s, op('m', 10, 'library_track', 'set-analysis', REC, { analysis: a }));
		const again = { entity: 'library_track', entity_id: REC, kind: 'set-analysis', device_id: 'm', payload: { analysis: { ...a } } } as never;
		expect(isRestatement(s, again)).toBe(true);
		// Another device's identical cell is its own statement.
		expect(isRestatement(s, { entity: 'library_track', entity_id: REC, kind: 'set-analysis', device_id: 'lap', payload: { analysis: a } } as never)).toBe(false);
		expect(isRestatement(s, { entity: 'library_track', entity_id: REC, kind: 'set-analysis', device_id: 'm', payload: { analysis: { ...a, analyzed_at: a.analyzed_at + 1 } } } as never)).toBe(false);
		expect(isRestatement(s, { entity: 'library_track', entity_id: REC, kind: 'set-analysis', device_id: 'm', payload: { analysis: null } } as never)).toBe(false);
	});

	it('a merge folds the cells onto the winner by clock, in either order', () => {
		const ops = [
			op('m', 10, 'library_track', 'set-analysis', REC, { analysis: analysis({ bpm: 120 }) }),
			op('m', 20, 'library_track', 'set-analysis', REC2, { analysis: analysis({ bpm: 125 }) }),
			op('x', 30, 'recording', 'merge', REC, { winner: REC2 }),
		];
		const views = [ops, [...ops].reverse(), [ops[2]!, ops[0]!, ops[1]!]].map((order) => {
			const s = createLibraryState();
			for (const o of order) applyOp(s, o);
			return resolveTrackAnalysis(s.libraryTracks.get(REC2), 'm');
		});
		for (const v of views) expect(v!.analysis.bpm).toBe(125);
		// The loser's later analysis would have won: the fold keeps clocks.
		const s = createLibraryState();
		applyOp(s, op('m', 50, 'library_track', 'set-analysis', REC, { analysis: analysis({ bpm: 99 }) }));
		applyOp(s, op('m', 40, 'library_track', 'set-analysis', REC2, { analysis: analysis({ bpm: 125 }) }));
		applyOp(s, op('x', 60, 'recording', 'merge', REC, { winner: REC2 }));
		expect(resolveTrackAnalysis(s.libraryTracks.get(REC2), 'm')!.analysis.bpm).toBe(99);
		expect(s.libraryTracks.has(REC)).toBe(false);
	});
});
