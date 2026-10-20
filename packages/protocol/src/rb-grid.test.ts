// The rekordbox grid's wire form (rb-grid.ts): lossless against the desktop's
// Float32 blob, small enough for an ordinary track under the op cap, and
// refused by the op schema in any other shape.

import { describe, it, expect } from 'vitest';
import { decodeRbGrid, encodeRbGrid, isRbGridValue, RB_GRID_FORMAT } from './rb-grid.js';
import { MAX_OP_PAYLOAD_BYTES, opPayloadBytes, parseOp, SCHEMA_VERSION } from './ops.js';

// A rekordbox-shaped grid: whole-ms beat times at `bpm`, downbeat every 4th.
function grid(bpm: number, seconds: number, firstMs = 87): { beats: number[]; downs: number[] } {
	const beats: number[] = [];
	for (let k = 0; firstMs + (k * 60_000) / bpm < seconds * 1000; k++) beats.push(Math.round(firstMs + (k * 60_000) / bpm) / 1000);
	return { beats, downs: beats.filter((_, i) => i % 4 === 1) };
}

const f32 = (xs: readonly number[]): number[] => [...new Float32Array(xs)];

describe('rb grid codec', () => {
	it('round-trips a steady grid and its downbeats exactly', () => {
		const { beats, downs } = grid(128, 420);
		const v = encodeRbGrid(beats, downs)!;
		expect(v[0]).toBe(RB_GRID_FORMAT);
		expect(isRbGridValue(v)).toBe(true);
		const back = decodeRbGrid(v)!;
		expect(back.beatsSec).toEqual(beats);
		expect(back.downbeatsSec).toEqual(downs);
	});

	it('reproduces the Float32 blob bytes the desktop stores, so a replica equals its source', () => {
		const { beats, downs } = grid(174, 600, 1234);
		// The source stores Float32; encoding is read back from that.
		const stored = f32(beats);
		const v = encodeRbGrid(stored, f32(downs))!;
		const back = decodeRbGrid(v)!;
		expect(f32(back.beatsSec)).toEqual(stored);
		expect(f32(back.downbeatsSec)).toEqual(f32(downs));
		// …and re-encoding the replica's blob gives the same wire value.
		expect(encodeRbGrid(f32(back.beatsSec), f32(back.downbeatsSec))).toEqual(v);
	});

	it('keeps a variable-tempo grid (tempo seams) exact', () => {
		const a = grid(120, 60, 0).beats;
		const last = Math.round(a[a.length - 1]! * 1000);
		const b = Array.from({ length: 64 }, (_, k) => Math.round(last + 400 + (k * 60_000) / 133) / 1000);
		const beats = [...a, ...b];
		const back = decodeRbGrid(encodeRbGrid(beats, [beats[0]!, beats[a.length]!])!)!;
		expect(back.beatsSec).toEqual(beats);
		expect(back.downbeatsSec).toEqual([beats[0], beats[a.length]]);
	});

	it('a downbeat that is not one of the beats lands on the nearest beat', () => {
		const back = decodeRbGrid(encodeRbGrid([1, 1.5, 2, 2.5], [1.97])!)!;
		expect(back.downbeatsSec).toEqual([2]);
	});

	it('no beats is no grid', () => {
		expect(encodeRbGrid([], [1])).toBeNull();
	});

	it('an ordinary track fits the op cap with room to spare; an hour-long mix does not', () => {
		const track = grid(128, 7 * 60);
		const small = { payload: { unit: 'grid', value: encodeRbGrid(track.beats, track.downs) } };
		expect(opPayloadBytes(small)).toBeLessThan(4 * 1024);
		const forty = grid(128, 40 * 60);
		expect(opPayloadBytes({ payload: { unit: 'grid', value: encodeRbGrid(forty.beats, forty.downs) } })).toBeLessThan(MAX_OP_PAYLOAD_BYTES);
		const mix = grid(128, 90 * 60);
		expect(opPayloadBytes({ payload: { unit: 'grid', value: encodeRbGrid(mix.beats, mix.downs) } })).toBeGreaterThan(MAX_OP_PAYLOAD_BYTES);
	});

	it('rejects other shapes: another format, a wrong length, fractions, a downbeat past the end', () => {
		expect(isRbGridValue([1, 3, 1, 123, 468, 1, 0])).toBe(true);
		expect(isRbGridValue([2, 3, 1, 123, 468, 1, 0])).toBe(false);
		expect(isRbGridValue([1, 3, 1, 123, 468, 1])).toBe(false);
		expect(isRbGridValue([1, 3, 0, 123, 468.5, 1])).toBe(false);
		expect(isRbGridValue([1, 3, 1, 123, 468, 1, 3])).toBe(false);
		expect(isRbGridValue([1, 3, 2, 123, 468, 1, 1, 0])).toBe(false);
		expect(isRbGridValue([0.123, 0.591, 1.06])).toBe(false);
		expect(decodeRbGrid([2, 1, 0, 5])).toBeNull();
	});

	it('the op schema refuses a grid that is not in this form', () => {
		const env = (value: unknown) => ({
			op_id: '00000000-0000-4000-8000-000000000001', device_id: 'd', client_ts: 1, schema_version: SCHEMA_VERSION,
			entity: 'library_track', entity_id: 'rec', kind: 'set-rb-analysis', payload: { unit: 'grid', value },
		});
		expect(() => parseOp(env([0.123, 0.591, 1.06]))).toThrow(/invalid_payload/);
		expect(parseOp(env(null)).payload).toEqual({ unit: 'grid', value: null });
		expect(parseOp(env([1, 1, 0, 0])).payload).toEqual({ unit: 'grid', value: [1, 1, 0, 0] });
	});
});
