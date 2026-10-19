// Beat-jump walk — mirrors the test suite in apps/audio/src/beatjump.rs
// case-for-case so the renderer fallback and the engine-side jump stay
// provably in agreement. If a case changes here, change it there too.

import { describe, expect, it } from 'vitest';
import { computeBeatJumpTarget } from './beatmath.js';

// Uniform 120 BPM grid (0.5 s/beat) starting 1 s into the track.
const uniformGrid = (): number[] => Array.from({ length: 64 }, (_, i) => 1.0 + i * 0.5);

// Ramping grid: beat length grows 10 ms per beat (variable tempo).
const rampGrid = (): number[] => {
	let t = 0;
	const out: number[] = [];
	for (let i = 0; i < 32; i++) {
		out.push(t);
		t += 0.40 + i * 0.01;
	}
	return out;
};

describe('computeBeatJumpTarget', () => {
	it('preserves sub-beat phase on a uniform grid', () => {
		const g = uniformGrid();
		// 0.2 beats into beat 8 (t = 5.0 + 0.1).
		expect(computeBeatJumpTarget(g, 5.1, 4, 600)).toBeCloseTo(7.1, 9);
		expect(computeBeatJumpTarget(g, 5.1, -4, 600)).toBeCloseTo(3.1, 9);
	});

	it('round-trips to identity', () => {
		const g = rampGrid();
		for (const pos of [0.05, 1.234, 7.7, 11.9]) {
			const there = computeBeatJumpTarget(g, pos, 16, 600);
			expect(computeBeatJumpTarget(g, there, -16, 600)).toBeCloseTo(pos, 9);
		}
	});

	it('carries the phase fraction across variable tempo', () => {
		const g = rampGrid();
		// Halfway through beat 3 (interval 0.43) lands halfway through
		// beat 8 (interval 0.48) after +5.
		const pos = g[3]! + 0.43 / 2;
		expect(computeBeatJumpTarget(g, pos, 5, 600)).toBeCloseTo(g[8]! + 0.48 / 2, 9);
	});

	it('extrapolates before the first beat — back-jump never moves forward', () => {
		const g = uniformGrid(); // starts at 1.0, 0.5 s/beat
		// From 0.35 s (beat index -1.3), -2 beats → -0.65 s → clamped to 0.
		// The old clamp-to-grid walk landed FORWARD on beat 0 here.
		const back = computeBeatJumpTarget(g, 0.35, -2, 600);
		expect(back).toBeLessThanOrEqual(0.35);
		expect(back).toBeCloseTo(0, 9);
		// +2 from 0.35: index -1.3 + 2 = 0.7 → 1.35 s.
		expect(computeBeatJumpTarget(g, 0.35, 2, 600)).toBeCloseTo(1.35, 9);
	});

	it('extrapolates past the last beat and clamps at track end', () => {
		const g = uniformGrid(); // last beat at 32.5, 0.5 s/beat
		// From 33.6 (index 65.2), +4 beats → 35.6 s.
		expect(computeBeatJumpTarget(g, 33.6, 4, 600)).toBeCloseTo(35.6, 9);
		expect(computeBeatJumpTarget(g, 33.6, 4, 34)).toBeCloseTo(34, 9);
	});

	it('clamps at track start', () => {
		expect(computeBeatJumpTarget(uniformGrid(), 2.1, -32, 600)).toBeCloseTo(0, 9);
	});

	it('composes: two +4 jumps equal one +8', () => {
		const g = rampGrid();
		const pos = g[10]! + 0.11;
		const twoSteps = computeBeatJumpTarget(g, computeBeatJumpTarget(g, pos, 4, 600), 4, 600);
		expect(twoSteps).toBeCloseTo(computeBeatJumpTarget(g, pos, 8, 600), 9);
	});

	it('supports fractional deltas', () => {
		expect(computeBeatJumpTarget(uniformGrid(), 5.0, 0.5, 600)).toBeCloseTo(5.25, 9);
	});

	it('accepts a Float32Array grid (analysisStore shape)', () => {
		const g = new Float32Array(uniformGrid());
		expect(computeBeatJumpTarget(g, 5.1, 4, 600)).toBeCloseTo(7.1, 4);
	});
});
