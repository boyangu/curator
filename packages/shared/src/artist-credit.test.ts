import { describe, it, expect } from 'vitest';
import { splitArtistCredit, normalizeArtistList, formatArtistCredit, artistCreditParts } from './artist-credit.js';
import { searchFold } from './search.js';

const names = (s: string) => splitArtistCredit(s).map((a) => a.name);

describe('splitArtistCredit', () => {
	it('splits on , ; and whitespace-padded /', () => {
		expect(names('A; B, C / D')).toEqual(['A', 'B', 'C', 'D']);
		expect(names('Rampa, Adam Port, &ME, Keinemusik')).toEqual(['Rampa', 'Adam Port', '&ME', 'Keinemusik']);
		expect(names('Re:Axis; Błażej Malinowski')).toEqual(['Re:Axis', 'Błażej Malinowski']);
		expect(names('Yusuf / Cat Stevens')).toEqual(['Yusuf', 'Cat Stevens']);
		expect(names('Yusuf/ Cat Stevens')).toEqual(['Yusuf', 'Cat Stevens']);
	});

	it('keeps a bare / inside a name', () => {
		expect(names('AC/DC')).toEqual(['AC/DC']);
	});

	it('never splits on & + x vs', () => {
		expect(names('Yohan & David')).toEqual(['Yohan & David']);
		expect(names('Sultan + Shepard')).toEqual(['Sultan + Shepard']);
		expect(names('Stimming x Lambert')).toEqual(['Stimming x Lambert']);
		expect(names('Alex James vs Alif Tree')).toEqual(['Alex James vs Alif Tree']);
		expect(names('Yohan & David, Cafe De Anatolia')).toEqual(['Yohan & David', 'Cafe De Anatolia']);
	});

	it('marks names after feat./featuring/ft. as featured', () => {
		expect(splitArtistCredit('Kanzyani feat Iury Lech')).toEqual([{ name: 'Kanzyani' }, { name: 'Iury Lech', role: 'featured' }]);
		expect(splitArtistCredit('Desert Dwellers feat. Darpan')).toEqual([{ name: 'Desert Dwellers' }, { name: 'Darpan', role: 'featured' }]);
		expect(splitArtistCredit('A featuring B')).toEqual([{ name: 'A' }, { name: 'B', role: 'featured' }]);
		expect(splitArtistCredit('A ft. B')).toEqual([{ name: 'A' }, { name: 'B', role: 'featured' }]);
		expect(splitArtistCredit('A, B feat. C, D')).toEqual([
			{ name: 'A' }, { name: 'B' }, { name: 'C', role: 'featured' }, { name: 'D', role: 'featured' },
		]);
		expect(splitArtistCredit('A feat. B feat. C')).toEqual([{ name: 'A' }, { name: 'B', role: 'featured' }, { name: 'C', role: 'featured' }]);
	});

	it('handles the parenthesised feat form', () => {
		expect(splitArtistCredit('Milk & Sugar (feat. John Paul Young)')).toEqual([
			{ name: 'Milk & Sugar' }, { name: 'John Paul Young', role: 'featured' },
		]);
		expect(splitArtistCredit('A [ft B]')).toEqual([{ name: 'A' }, { name: 'B', role: 'featured' }]);
	});

	it('does not treat feat-like substrings inside words as markers', () => {
		expect(names('FEATHERED SUN')).toEqual(['FEATHERED SUN']);
		expect(names('Craft')).toEqual(['Craft']);
	});

	it('inherits the credit role onto non-featured tokens', () => {
		expect(splitArtistCredit('A, B feat. C', { role: 'remixer' })).toEqual([
			{ name: 'A', role: 'remixer' }, { name: 'B', role: 'remixer' }, { name: 'C', role: 'featured' },
		]);
	});

	it('keeps a protected element whole', () => {
		const protect = (fold: string) => fold === searchFold('Tyler, The Creator');
		expect(splitArtistCredit('Tyler, The Creator', { protect })).toEqual([{ name: 'Tyler, The Creator' }]);
		expect(splitArtistCredit('Tyler, The Creator', {})).toEqual([{ name: 'Tyler' }, { name: 'The Creator' }]);
	});

	it('returns [] for empty input', () => {
		expect(splitArtistCredit('')).toEqual([]);
		expect(splitArtistCredit('  ,  ')).toEqual([]);
	});

	it('round-trips a comma-joined rb string (comma is a fixed point)', () => {
		for (const s of ['Murat, Guest', 'Rampa, Adam Port, &ME', 'Stil & Bense']) {
			expect(names(s).join(', ')).toBe(s);
		}
	});
});

describe('normalizeArtistList', () => {
	it('splits packed elements, keeps order, dedupes by fold', () => {
		expect(normalizeArtistList([{ name: 'A, B' }, { name: 'b' }, { name: 'C' }])).toEqual([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
	});

	it('returns the same instance when nothing changes', () => {
		const list = [{ name: 'A' }, { name: 'B', role: 'featured' as const }];
		expect(normalizeArtistList(list)).toBe(list);
	});

	it('is idempotent', () => {
		const once = normalizeArtistList([{ name: 'A; B feat. C' }]);
		expect(normalizeArtistList(once)).toBe(once);
	});

	it('drops empties and malformed elements', () => {
		expect(normalizeArtistList([{ name: '' }, { name: ' ' }, { name: 'A' }])).toEqual([{ name: 'A' }]);
	});
});

describe('formatArtistCredit', () => {
	it('lists names in credit order (remixers plain) with feat. last', () => {
		expect(formatArtistCredit([{ name: 'A' }, { name: 'B' }, { name: 'C', role: 'featured' }])).toBe('A, B feat. C');
		expect(formatArtistCredit([{ name: 'Liminal MX' }, { name: 'JAMIEE', role: 'remixer' }])).toBe('Liminal MX, JAMIEE');
		expect(formatArtistCredit([{ name: 'A' }, { name: 'D', role: 'remixer' }, { name: 'C', role: 'featured' }])).toBe('A, D feat. C');
		expect(formatArtistCredit([{ name: 'C', role: 'featured' }])).toBe('C');
		expect(formatArtistCredit([])).toBe('');
	});

	it('honours the separator setting; the remix style is the title\'s business', () => {
		const list = [{ name: 'A' }, { name: 'B' }, { name: 'D', role: 'remixer' as const }];
		expect(formatArtistCredit(list, { separator: '/', remixStyle: 'dash' })).toBe('A / B / D');
		expect(formatArtistCredit(list, { separator: ';', remixStyle: 'parenthesis' })).toBe('A; B; D');
	});

	it('exposes credit positions so ids stay aligned', () => {
		const parts = artistCreditParts([{ name: 'C', role: 'featured' }, { name: 'A' }]);
		expect(parts.filter((p) => p.kind === 'artist').map((p) => (p as { index: number }).index)).toEqual([1, 0]);
	});
});
