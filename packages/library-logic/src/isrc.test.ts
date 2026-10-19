import { describe, it, expect } from 'vitest';
import { ISRC_RE, normalizeIsrc } from './isrc.js';

describe('normalizeIsrc', () => {
	it('keeps a canonical ISRC as is', () => {
		expect(normalizeIsrc('GBSMU1676261')).toBe('GBSMU1676261');
	});

	it('uppercases a lowercase tag value', () => {
		expect(normalizeIsrc('gbsmu1676261')).toBe('GBSMU1676261');
	});

	it('strips the printed hyphens', () => {
		expect(normalizeIsrc('GB-SMU-16-76261')).toBe('GBSMU1676261');
	});

	it('handles mixed case, inner spaces and surrounding whitespace together', () => {
		expect(normalizeIsrc('  gB sMu-16 76261\t')).toBe('GBSMU1676261');
	});

	it('accepts a numeric registrant code', () => {
		expect(normalizeIsrc('us1112233344')).toBe('US1112233344');
	});

	it('rejects a value that is too short', () => {
		expect(normalizeIsrc('GBSMU167626')).toBeNull();
	});

	it('rejects a value that is too long', () => {
		expect(normalizeIsrc('GBSMU16762611')).toBeNull();
	});

	it('rejects the right length in the wrong shape', () => {
		// Letter in the designation/year tail; digit in the country code.
		expect(normalizeIsrc('GBSMU167626A')).toBeNull();
		expect(normalizeIsrc('1BSMU1676261')).toBeNull();
		expect(normalizeIsrc('not-an-isrc!')).toBeNull();
	});

	it('rejects empty and blank values', () => {
		expect(normalizeIsrc('')).toBeNull();
		expect(normalizeIsrc('   ')).toBeNull();
		expect(normalizeIsrc('--')).toBeNull();
	});

	it('passes null and undefined through as null', () => {
		expect(normalizeIsrc(null)).toBeNull();
		expect(normalizeIsrc(undefined)).toBeNull();
	});
});

describe('ISRC_RE', () => {
	it('matches only the canonical form', () => {
		expect(ISRC_RE.test('GBSMU1676261')).toBe(true);
		expect(ISRC_RE.test('gbsmu1676261')).toBe(false);
		expect(ISRC_RE.test('GB-SMU-16-76261')).toBe(false);
	});
});
