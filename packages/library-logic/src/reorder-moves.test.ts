import { describe, it, expect } from 'vitest';
import { computePositionalMoves, type PositionalMove } from './reorder-moves.js';

// Re-play the moves with Spotify's semantics (indices pre-move, sequential)
// and assert the result equals the requested permutation — the property that
// actually matters on the wire.
function apply(n: number, moves: PositionalMove[]): number[] {
	const list = Array.from({ length: n }, (_, i) => i);
	for (const m of moves) {
		const [item] = list.splice(m.rangeStart, 1);
		list.splice(m.insertBefore > m.rangeStart ? m.insertBefore - 1 : m.insertBefore, 0, item!);
	}
	return list;
}

describe('computePositionalMoves', () => {
	it('no-op permutation → no moves', () => {
		expect(computePositionalMoves([0, 1, 2, 3])).toEqual([]);
	});

	it('single item dragged down is ONE move (not a rotation of everything after it)', () => {
		// old [A,B,C,D] → new [B,C,A,D]: only A moved.
		const perm = [1, 2, 0, 3];
		const moves = computePositionalMoves(perm);
		expect(moves).toHaveLength(1);
		expect(apply(4, moves)).toEqual(perm);
	});

	it('single item dragged up is ONE move', () => {
		// old [A,B,C,D] → new [D,A,B,C]
		const perm = [3, 0, 1, 2];
		const moves = computePositionalMoves(perm);
		expect(moves).toHaveLength(1);
		expect(apply(4, moves)).toEqual(perm);
	});

	it('contiguous block drag costs blockSize moves', () => {
		// old [A,B,C,D,E] → new [C,D,A,B,E]: block [C,D] moved before A.
		const perm = [2, 3, 0, 1, 4];
		const moves = computePositionalMoves(perm);
		expect(moves).toHaveLength(2);
		expect(apply(5, moves)).toEqual(perm);
	});

	it('replays correctly on arbitrary permutations', () => {
		// Deterministic pseudo-shuffles (no Math.random in tests).
		const cases = [
			[4, 2, 0, 3, 1],
			[1, 0, 3, 2, 5, 4],
			[6, 5, 4, 3, 2, 1, 0],
			[0, 2, 4, 6, 1, 3, 5],
		];
		for (const perm of cases) {
			expect(apply(perm.length, computePositionalMoves(perm))).toEqual(perm);
		}
	});
});
