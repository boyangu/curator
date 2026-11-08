import { describe, expect, it } from 'vitest';
import { creditFolds, creditsShareAct, nameFold } from './name-fold.js';

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

describe('creditFolds / creditsShareAct', () => {
	it('names the whole credit and each act of a compound, never one-letter pieces or Various Artists', () => {
		expect(creditFolds('Frankey & Sandrino')).toEqual(['frankey and sandrino', 'frankey', 'sandrino']);
		expect(creditFolds('Jepe & Bar.ba')).toEqual(['jepe and bar ba', 'jepe', 'bar ba']);
		expect(creditFolds('Ame, Dixon / Trikk feat. Kiasmos x Bonobo')).toEqual(['ame dixon trikk feat kiasmos x bonobo', 'ame', 'dixon', 'trikk', 'kiasmos', 'bonobo']);
		expect(creditFolds('A & B')).toEqual(['a and b']);
		expect(creditFolds('Various Artists')).toEqual(['various artists']);
		expect(creditFolds('Kölsch')).toEqual(['kolsch']);
		expect(creditFolds('')).toEqual([]);
	});

	it('a duo credited as one act by one store and as two people by another shares an act', () => {
		expect(creditsShareAct(['Frankey & Sandrino'], ['Frankey', 'Sandrino', 'Premiere: Jepe'])).toBe(true);
		expect(creditsShareAct(['Frankey', 'Sandrino'], ['Frankey & Sandrino'])).toBe(true);
		expect(creditsShareAct(['Frankey & Sandrino'], ['Someone & Else'])).toBe(false);
		expect(creditsShareAct(['Sum Over Histories'], ['Frankey', 'Sandrino'])).toBe(false);
	});
});
