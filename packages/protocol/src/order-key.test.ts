import { describe, it, expect } from 'vitest';
import {
	compareKeys,
	firstKey,
	isValidOrderKey,
	keyBetween,
	keysBetween,
	needsRekey,
	ORDER_KEY_DIGITS,
	OrderKeyError,
	rebalance,
	REKEY_THRESHOLD,
	validateOrderKey,
} from './order-key.js';

// Deterministic PRNG so a property failure reproduces.
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function assertStrictlyOrdered(keys: string[]): void {
	for (let i = 1; i < keys.length; i++) {
		expect(compareKeys(keys[i - 1]!, keys[i]!), `${keys[i - 1]} < ${keys[i]}`).toBe(-1);
	}
}

function assertValid(key: string): void {
	expect(() => validateOrderKey(key)).not.toThrow();
	for (const ch of key) expect(ORDER_KEY_DIGITS.includes(ch), `digit ${ch} in ${key}`).toBe(true);
}

describe('keyBetween', () => {
	it('starts at a0 and appends short integer keys', () => {
		expect(firstKey()).toBe('a0');
		expect(keyBetween(null, null)).toBe('a0');
		expect(keyBetween('a0', null)).toBe('a1');
		expect(keyBetween('a1', null)).toBe('a2');
		expect(keyBetween('az', null)).toBe('b00');
	});

	it('prepends by decrementing the integer part', () => {
		expect(keyBetween(null, 'a0')).toBe('Zz');
		expect(keyBetween(null, 'Zz')).toBe('Zy');
		expect(keyBetween(null, 'a1')).toBe('a0');
	});

	it('splits a gap with the shortest fractional part', () => {
		expect(keyBetween('a0', 'a1')).toBe('a0V');
		expect(keyBetween('a0', 'a0V')).toBe('a0G');
		expect(keyBetween('a0V', 'a1')).toBe('a0l');
	});

	it('matches the reference implementation on its documented cases', () => {
		// From the fractional-indexing package's own tests (base-62 digits).
		expect(keyBetween('a0', 'a0V')).toBe('a0G');
		expect(keyBetween('a0', 'a1')).toBe('a0V');
		expect(keyBetween('Zz', 'a0')).toBe('ZzV');
		expect(keyBetween('Zz', 'a1')).toBe('a0');
		expect(keyBetween(null, 'Y00')).toBe('Xzzz');
		expect(keyBetween('bzz', null)).toBe('c000');
		expect(keyBetween('a0', 'a0G')).toBe('a08');
		expect(keyBetween('b125', 'b129')).toBe('b127');
		expect(keyBetween('a0', 'a1V')).toBe('a1');
		expect(keyBetween('Zz', 'a01')).toBe('a0');
		expect(keyBetween(null, 'a0V')).toBe('a0');
		expect(keyBetween(null, 'b999')).toBe('b99');
	});

	it('is strictly between its bounds', () => {
		const cases: [string | null, string | null][] = [
			[null, null],
			['a0', null],
			[null, 'a0'],
			['a0', 'a1'],
			['a0', 'a0V'],
			['Zz', 'a0'],
			['a0', 'b00'],
		];
		for (const [a, b] of cases) {
			const k = keyBetween(a, b);
			assertValid(k);
			if (a !== null) expect(compareKeys(a, k)).toBe(-1);
			if (b !== null) expect(compareKeys(k, b)).toBe(-1);
		}
	});

	it('rejects a >= b and malformed keys', () => {
		expect(() => keyBetween('a1', 'a0')).toThrow(OrderKeyError);
		expect(() => keyBetween('a0', 'a0')).toThrow(OrderKeyError);
		expect(() => keyBetween('a00', null)).toThrow(OrderKeyError); // trailing zero in the fraction
		expect(() => keyBetween('0', null)).toThrow(OrderKeyError); // no integer head
		expect(() => keyBetween('a', null)).toThrow(OrderKeyError); // integer part too short
		expect(() => keyBetween('a0-', null)).toThrow(OrderKeyError); // digit outside the alphabet
		expect(() => keyBetween(null, 'A' + '0'.repeat(26))).toThrow(OrderKeyError); // nothing is smaller
		expect(isValidOrderKey('a0')).toBe(true);
		expect(isValidOrderKey('a00')).toBe(false);
	});
});

describe('properties', () => {
	it('random inserts at random positions keep keys strictly ordered and unique', () => {
		const rnd = mulberry32(7);
		for (let round = 0; round < 20; round++) {
			const keys: string[] = [];
			for (let i = 0; i < 200; i++) {
				const at = Math.floor(rnd() * (keys.length + 1));
				const a = at === 0 ? null : keys[at - 1]!;
				const b = at === keys.length ? null : keys[at]!;
				const k = keyBetween(a, b);
				assertValid(k);
				keys.splice(at, 0, k);
			}
			assertStrictlyOrdered(keys);
			expect(new Set(keys).size).toBe(keys.length);
			// The sorted order is the insertion order (string sort agrees).
			expect([...keys].sort(compareKeys)).toEqual(keys);
		}
	});

	it('no fractional part ends in the smallest digit', () => {
		const rnd = mulberry32(11);
		const keys: string[] = [];
		for (let i = 0; i < 500; i++) {
			const at = Math.floor(rnd() * (keys.length + 1));
			keys.splice(at, 0, keyBetween(at === 0 ? null : keys[at - 1]!, at === keys.length ? null : keys[at]!));
		}
		for (const k of keys) expect(isValidOrderKey(k)).toBe(true);
	});

	it('repeated inserts into one gap grow monotonically in length', () => {
		let lo = 'a0';
		const hi = 'a1';
		let prevLen = lo.length;
		let crossedThreshold: number | null = null;
		for (let i = 0; i < 500; i++) {
			const k = keyBetween(lo, hi);
			expect(compareKeys(lo, k)).toBe(-1);
			expect(compareKeys(k, hi)).toBe(-1);
			expect(k.length).toBeGreaterThanOrEqual(prevLen);
			prevLen = k.length;
			lo = k;
			if (crossedThreshold === null && needsRekey([k])) crossedThreshold = i + 1;
		}
		// Roughly one character per five inserts into the same gap (the
		// midpoint rounds toward the fixed upper bound, so the gap shrinks a
		// little faster than halving): 500 inserts ≈ 100 chars, and the rekey
		// threshold (64) trips after ~300 of them.
		expect(lo.length).toBeGreaterThan(REKEY_THRESHOLD);
		expect(lo.length).toBeLessThan(2 * REKEY_THRESHOLD);
		expect(crossedThreshold).toBeGreaterThan(200);
		expect(crossedThreshold).toBeLessThan(450);
	});

	it('appending at the end stays short', () => {
		let last: string | null = null;
		for (let i = 0; i < 5_000; i++) last = keyBetween(last, null);
		expect(last!.length).toBeLessThanOrEqual(4);
	});
});

describe('keysBetween / rebalance', () => {
	it('returns n ordered keys strictly inside the bounds', () => {
		for (const [a, b] of [
			['a0', 'a1'],
			[null, 'a0'],
			['a5', null],
			['a0', 'a0V'],
		] as [string | null, string | null][]) {
			const ks = keysBetween(a, b, 7);
			expect(ks).toHaveLength(7);
			assertStrictlyOrdered(ks);
			for (const k of ks) {
				assertValid(k);
				if (a !== null) expect(compareKeys(a, k)).toBe(-1);
				if (b !== null) expect(compareKeys(k, b)).toBe(-1);
			}
		}
		expect(keysBetween('a0', 'a1', 0)).toEqual([]);
		expect(() => keysBetween('a0', 'a1', -1)).toThrow(OrderKeyError);
	});

	it('rebalance keys are ordered, unique and short', () => {
		for (const n of [1, 2, 10, 100, 1_000, 5_000]) {
			const ks = rebalance(n);
			expect(ks).toHaveLength(n);
			assertStrictlyOrdered(ks);
			expect(new Set(ks).size).toBe(n);
			expect(Math.max(...ks.map((k) => k.length))).toBeLessThanOrEqual(4);
			expect(needsRekey(ks)).toBe(false);
		}
		expect(rebalance(3)).toEqual(['a0', 'a1', 'a2']);
	});

	it('rebalanced keys leave room between every pair', () => {
		const ks = rebalance(50);
		for (let i = 1; i < ks.length; i++) {
			const mid = keyBetween(ks[i - 1]!, ks[i]!);
			expect(mid.length).toBeLessThanOrEqual(ks[i]!.length + 1);
		}
	});
});

describe('compareKeys', () => {
	it('is plain string order, consistent with the digit alphabet', () => {
		expect(compareKeys('a0', 'a1')).toBe(-1);
		expect(compareKeys('a1', 'a0')).toBe(1);
		expect(compareKeys('a0', 'a0')).toBe(0);
		// Digits < upper < lower, as in the alphabet.
		expect(compareKeys('a0', 'a0A')).toBe(-1);
		expect(compareKeys('a0A', 'a0a')).toBe(-1);
		expect(compareKeys('Zz', 'a0')).toBe(-1);
		for (let i = 1; i < ORDER_KEY_DIGITS.length; i++) {
			expect(ORDER_KEY_DIGITS.charCodeAt(i - 1)).toBeLessThan(ORDER_KEY_DIGITS.charCodeAt(i));
		}
	});

	it('needsRekey trips just past the threshold', () => {
		expect(needsRekey(['a0', 'a' + '1'.repeat(REKEY_THRESHOLD - 1)])).toBe(false);
		expect(needsRekey(['a0', 'a' + '1'.repeat(REKEY_THRESHOLD)])).toBe(true);
	});
});
