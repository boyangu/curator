import { describe, expect, it } from 'vitest';
import { nameFold } from './name-fold.js';

describe('nameFold', () => {
	it('folds case, accents, punctuation and spacing', () => {
		expect(nameFold('Âme')).toBe('ame');
		expect(nameFold('  Kölsch ')).toBe('kolsch');
		expect(nameFold('Northfold Records.')).toBe('northfold records');
		expect(nameFold('Tri/xon')).toBe('tri xon');
	});

	it('reads & as and', () => {
		expect(nameFold('Melodic House & Techno')).toBe(nameFold('melodic house and techno'));
	});

	it('keeps letters of other scripts', () => {
		expect(nameFold('坂本 龍一')).toBe('坂本 龍一');
	});

	it('treats missing as empty', () => {
		expect(nameFold(null)).toBe('');
		expect(nameFold(undefined)).toBe('');
	});
});
