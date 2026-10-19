import { describe, it, expect } from 'vitest';
import { scrubLoneSurrogates, isWellFormedString } from './wellformed.js';

describe('scrubLoneSurrogates', () => {
	it('replaces lone lead and trail surrogates with U+FFFD', () => {
		expect(scrubLoneSurrogates('a\uD800b')).toBe('a�b');
		// The production incident's exact shape: trail half of 💐 at index 1.
		expect(scrubLoneSurrogates('T\uDC90itle')).toBe('T�itle');
	});

	it('leaves valid surrogate pairs (emoji) untouched', () => {
		const s = 'a day at the beach 🌴 💐';
		expect(scrubLoneSurrogates(s)).toBe(s);
	});

	it('walks nested arrays, objects, and object keys', () => {
		const input = {
			fields: { Title: 'T\uDC90itle', ArtistName: 'ok' },
			list: ['fine', 'x\uD800'],
			['k\uDC90ey']: 1,
		};
		const out = scrubLoneSurrogates(input);
		expect(out.fields.Title).toBe('T�itle');
		expect(out.fields.ArtistName).toBe('ok');
		expect(out.list).toEqual(['fine', 'x�']);
		expect((out as Record<string, unknown>)['k�ey']).toBe(1);
		expect((out as Record<string, unknown>)['k\uDC90ey']).toBeUndefined();
	});

	it('copy-on-write: clean input returns the same references', () => {
		const clean = { a: 'hello', b: ['🌴', { c: 'world' }], n: 42, u: null };
		expect(scrubLoneSurrogates(clean)).toBe(clean);
		const arr = ['x', 'y'];
		expect(scrubLoneSurrogates(arr)).toBe(arr);
	});

	it('rebuilds only the dirty branch, preserving clean sibling references', () => {
		const cleanChild = { keep: 'me' };
		const input = { cleanChild, dirty: '\uDC90' };
		const out = scrubLoneSurrogates(input);
		expect(out).not.toBe(input);
		expect(out.cleanChild).toBe(cleanChild);
	});

	it('passes non-string primitives through', () => {
		expect(scrubLoneSurrogates(42)).toBe(42);
		expect(scrubLoneSurrogates(null)).toBe(null);
		expect(scrubLoneSurrogates(undefined)).toBe(undefined);
	});

	it('survives the exact wire composition: scrub → stringify → parse is well-formed', () => {
		const params = { ops: [{ kind: 'track', fields: { Title: 'Ti\uDC90tle' } }] };
		const wire = JSON.stringify(scrubLoneSurrogates(params));
		const roundTripped = JSON.parse(wire) as typeof params;
		expect(isWellFormedString(roundTripped.ops[0]!.fields.Title)).toBe(true);
	});
});

describe('isWellFormedString', () => {
	it('detects lone surrogates and accepts valid pairs', () => {
		expect(isWellFormedString('plain')).toBe(true);
		expect(isWellFormedString('💐')).toBe(true);
		expect(isWellFormedString('\uD800')).toBe(false);
		expect(isWellFormedString('x\uDC90')).toBe(false);
	});
});
