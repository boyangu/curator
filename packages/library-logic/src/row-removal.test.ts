import { describe, it, expect } from 'vitest';
import { planRowRemoval, type RowRemovalPlan } from './row-removal.js';

// Re-play the plan with the provider's semantics — remove drops every
// occurrence of a URI, insert puts one item at an index — and return the
// resulting list. The property that matters on the wire is that this equals
// the list with just the chosen rows taken out.
function apply(items: ReadonlyArray<string | null>, plan: RowRemovalPlan): Array<string | null> {
	const gone = new Set(plan.removeUris);
	const list = items.filter((x) => x == null || !gone.has(x));
	for (const r of plan.reinserts) list.splice(r.index, 0, r.uri);
	return list;
}
const without = (items: ReadonlyArray<string | null>, rows: number[]) => items.filter((_, i) => !rows.includes(i));

describe('planRowRemoval', () => {
	it('a copy with its own URI is a plain remove', () => {
		const items = ['a', 'b', 'a2', 'c'];
		const plan = planRowRemoval(items, [2]);
		expect(plan).toEqual({ removeUris: ['a2'], reinserts: [] });
		expect(apply(items, plan)).toEqual(without(items, [2]));
	});

	it('the second copy of the same URI: remove, then put the first back in place', () => {
		const items = ['x', 'a', 'b', 'c', 'a', 'd'];
		const plan = planRowRemoval(items, [4]);
		expect(plan).toEqual({ removeUris: ['a'], reinserts: [{ uri: 'a', index: 1 }] });
		expect(apply(items, plan)).toEqual(without(items, [4]));
	});

	it('three copies, two removed, several URIs at once', () => {
		const items = ['r', 'r', 'p', 'q', 'r', 'q', 's', 'p'];
		const rows = [1, 4, 5, 7];
		const plan = planRowRemoval(items, rows);
		expect(apply(items, plan)).toEqual(without(items, rows));
		expect(plan.reinserts.map((r) => r.index)).toEqual([0, 1, 2]);
	});

	it('unaddressable rows keep their index and shift the inserts', () => {
		const items = [null, 'a', null, 'b', 'a'];
		const plan = planRowRemoval(items, [4]);
		expect(plan.reinserts).toEqual([{ uri: 'a', index: 1 }]);
		expect(apply(items, plan)).toEqual(without(items, [4]));
	});

	it('refuses a row out of range or without an id', () => {
		expect(() => planRowRemoval(['a'], [1])).toThrow(/outside/);
		expect(() => planRowRemoval([null, 'a'], [0])).toThrow(/no provider id/);
	});
});
