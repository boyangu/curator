import { describe, expect, it } from 'vitest';
import { keyToCamelot } from './keys.js';

describe('keyToCamelot', () => {
	it('reads the notations the catalogue folds in', () => {
		expect(keyToCamelot('A Minor')).toBe('8A');
		expect(keyToCamelot('F♯ Minor')).toBe('11A');
		expect(keyToCamelot('B♭ Major')).toBe('6B');
		expect(keyToCamelot('Eb min')).toBe('2A');
		expect(keyToCamelot('8a')).toBe('8A');
		expect(keyToCamelot('12B')).toBe('12B');
	});

	it('returns null for what is not a key', () => {
		expect(keyToCamelot(null)).toBeNull();
		expect(keyToCamelot('')).toBeNull();
		expect(keyToCamelot('13A')).toBeNull();
		expect(keyToCamelot('H minor')).toBeNull();
	});
});
