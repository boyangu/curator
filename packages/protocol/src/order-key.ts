// Fractional order keys for playlist membership (design: "Ordered playlists").
//
// A re-implementation of the algorithm in David Greenspan's `fractional-indexing`
// package (https://github.com/rocicorp/fractional-indexing, MIT licence,
// copyright 2020 Rocicorp) and his essay "Implementing Fractional Indexing"
// (https://observablehq.com/@dgreensp/implementing-fractional-indexing). It is
// written in-house rather than depended on because desktop, server and phone
// must share one implementation and this package carries no runtime
// dependency beyond zod; the semantics (and the keys) are identical to the
// package's base-62 default, so a key made by either is valid for the other.
//
// Key shape: an integer part followed by an optional fractional part, all over
// the alphabet 0-9A-Za-z (ASCII order). The integer part's first character
// encodes its length so that longer integers still compare correctly as
// strings: 'a'..'z' are positive integers of 2..27 characters, 'A'..'Z'
// negative ones of 27..2. The fractional part never ends in '0' (a trailing
// zero would be a second spelling of the same value); the integer part may,
// which is why the very first key is "a0". Keys compare as plain strings, so
// every store must sort them byte-wise: SQLite's default BINARY collation does,
// JavaScript's `<` does, Postgres needs `COLLATE "C"` (a locale collation
// folds case at the first level and would interleave 'A' and 'a' keys).

export const ORDER_KEY_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Design: when a playlist's longest key exceeds this, the desktop that notices
// emits one `rekey` op with fresh evenly spaced keys (`rebalance`).
export const REKEY_THRESHOLD = 64;

const ZERO = '0';
const MAX_DIGIT = 'z';
const SMALLEST_INTEGER = 'A' + ZERO.repeat(26);

export class OrderKeyError extends Error {
	override readonly name = 'OrderKeyError';
}

function integerLength(head: string): number {
	if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
	if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
	throw new OrderKeyError(`invalid order key head: ${JSON.stringify(head)}`);
}

function integerPart(key: string): string {
	const len = integerLength(key.charAt(0));
	if (len > key.length) throw new OrderKeyError(`invalid order key: ${key}`);
	return key.slice(0, len);
}

function validateInteger(int: string): void {
	if (int.length !== integerLength(int.charAt(0))) throw new OrderKeyError(`invalid integer part of order key: ${int}`);
}

export function validateOrderKey(key: string): void {
	if (key === SMALLEST_INTEGER) throw new OrderKeyError(`invalid order key: ${key}`);
	for (let i = 0; i < key.length; i++) {
		if (ORDER_KEY_DIGITS.indexOf(key.charAt(i)) < 0) throw new OrderKeyError(`invalid order key: ${key}`);
	}
	const int = integerPart(key);
	const frac = key.slice(int.length);
	if (frac.endsWith(ZERO)) throw new OrderKeyError(`invalid order key: ${key}`);
}

export function isValidOrderKey(key: string): boolean {
	try {
		validateOrderKey(key);
		return true;
	} catch {
		return false;
	}
}

// Midpoint of two fractional parts. `a` may be empty (the open low end), `b`
// null (the open high end); `a < b` when both are given. The result is the
// shortest string strictly between them, preferring a single digit halfway
// when the first differing digits leave room.
function midpoint(a: string, b: string | null): string {
	if (b !== null && a >= b) throw new OrderKeyError(`${a} >= ${b}`);
	if (a.endsWith(ZERO) || (b !== null && b.endsWith(ZERO))) throw new OrderKeyError('trailing zero');
	if (b !== null) {
		// Strip the longest common prefix, padding `a` with zeros as we go;
		// `b` cannot end inside the prefix because it is the larger string.
		let n = 0;
		while ((a.charAt(n) || ZERO) === b.charAt(n)) n++;
		if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
	}
	const digitA = a ? ORDER_KEY_DIGITS.indexOf(a.charAt(0)) : 0;
	const digitB = b !== null ? ORDER_KEY_DIGITS.indexOf(b.charAt(0)) : ORDER_KEY_DIGITS.length;
	if (digitB - digitA > 1) return ORDER_KEY_DIGITS.charAt(Math.round(0.5 * (digitA + digitB)));
	// Consecutive first digits: either `b` has more digits to borrow from, or
	// we keep `a`'s digit and recurse into its tail against the open end
	// (midpoint('49', '5') → '4' + midpoint('9', null) → '495' in base 10).
	if (b !== null && b.length > 1) return b.slice(0, 1);
	return ORDER_KEY_DIGITS.charAt(digitA) + midpoint(a.slice(1), null);
}

// Null when `x` is the largest representable integer.
function incrementInteger(x: string): string | null {
	validateInteger(x);
	const head = x.charAt(0);
	const digs = x.slice(1).split('');
	let carry = true;
	for (let i = digs.length - 1; carry && i >= 0; i--) {
		const d = ORDER_KEY_DIGITS.indexOf(digs[i]!) + 1;
		if (d === ORDER_KEY_DIGITS.length) {
			digs[i] = ZERO;
		} else {
			digs[i] = ORDER_KEY_DIGITS.charAt(d);
			carry = false;
		}
	}
	if (!carry) return head + digs.join('');
	if (head === 'Z') return 'a' + ZERO;
	if (head === 'z') return null;
	const next = String.fromCharCode(head.charCodeAt(0) + 1);
	if (next > 'a') digs.push(ZERO);
	else digs.pop();
	return next + digs.join('');
}

// Null when `x` is the smallest representable integer.
function decrementInteger(x: string): string | null {
	validateInteger(x);
	const head = x.charAt(0);
	const digs = x.slice(1).split('');
	let borrow = true;
	for (let i = digs.length - 1; borrow && i >= 0; i--) {
		const d = ORDER_KEY_DIGITS.indexOf(digs[i]!) - 1;
		if (d === -1) {
			digs[i] = MAX_DIGIT;
		} else {
			digs[i] = ORDER_KEY_DIGITS.charAt(d);
			borrow = false;
		}
	}
	if (!borrow) return head + digs.join('');
	if (head === 'a') return 'Z' + MAX_DIGIT;
	if (head === 'A') return null;
	const prev = String.fromCharCode(head.charCodeAt(0) - 1);
	if (prev < 'Z') digs.push(MAX_DIGIT);
	else digs.pop();
	return prev + digs.join('');
}

// A key strictly between `a` and `b`; null is the open end on either side.
// Between two keys with the same integer part the result extends the
// fractional part; otherwise it prefers the next whole integer, which keeps
// append-at-end keys short ("a0", "a1", ...) and leaves room for later
// inserts between them.
export function keyBetween(a: string | null, b: string | null): string {
	if (a !== null) validateOrderKey(a);
	if (b !== null) validateOrderKey(b);
	if (a !== null && b !== null && a >= b) throw new OrderKeyError(`${a} >= ${b}`);
	if (a === null) {
		if (b === null) return 'a' + ZERO;
		const ib = integerPart(b);
		const fb = b.slice(ib.length);
		if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb);
		if (ib < b) return ib;
		const prev = decrementInteger(ib);
		if (prev === null) throw new OrderKeyError('cannot decrement any more');
		return prev;
	}
	if (b === null) {
		const ia = integerPart(a);
		const fa = a.slice(ia.length);
		const next = incrementInteger(ia);
		return next === null ? ia + midpoint(fa, null) : next;
	}
	const ia = integerPart(a);
	const fa = a.slice(ia.length);
	const ib = integerPart(b);
	const fb = b.slice(ib.length);
	if (ia === ib) return ia + midpoint(fa, fb);
	const next = incrementInteger(ia);
	if (next === null) throw new OrderKeyError('cannot increment any more');
	if (next < b) return next;
	return ia + midpoint(fa, null);
}

// `n` distinct keys in ascending order, all strictly between `a` and `b`.
// Against an open end they are consecutive integers; between two keys the
// gap is split recursively so the keys stay short.
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
	if (!Number.isInteger(n) || n < 0) throw new OrderKeyError(`invalid count: ${n}`);
	if (n === 0) return [];
	if (n === 1) return [keyBetween(a, b)];
	if (b === null) {
		let c = keyBetween(a, b);
		const out = [c];
		for (let i = 0; i < n - 1; i++) {
			c = keyBetween(c, b);
			out.push(c);
		}
		return out;
	}
	if (a === null) {
		let c = keyBetween(a, b);
		const out = [c];
		for (let i = 0; i < n - 1; i++) {
			c = keyBetween(a, c);
			out.push(c);
		}
		out.reverse();
		return out;
	}
	const mid = Math.floor(n / 2);
	const c = keyBetween(a, b);
	return [...keysBetween(a, c, mid), c, ...keysBetween(c, b, n - mid - 1)];
}

export function firstKey(): string {
	return keyBetween(null, null);
}

// Fresh keys for a whole playlist of `n` rows: consecutive integers from
// "a0", each with the full fractional space free between it and the next.
// The `rekey` op carries these.
export function rebalance(n: number): string[] {
	return keysBetween(null, null, n);
}

// Keys sort as plain strings (see the header for the collation requirement).
export function compareKeys(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function needsRekey(keys: Iterable<string>): boolean {
	for (const k of keys) if (k.length > REKEY_THRESHOLD) return true;
	return false;
}
