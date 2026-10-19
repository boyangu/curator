import { describe, it, expect } from 'vitest';
import { applyOverrides, type OverridableFields } from './overrides.js';

const base: OverridableFields & { id: string } = {
	id: 't1',
	title: 'Canonical',
	artists: [{ name: 'A' }],
	albumTitle: null,
	label: 'Label',
	genre: null,
	bpm: 120,
	keyCamelot: '8A',
	releaseDate: '2021',
	overrides: null,
};

describe('applyOverrides', () => {
	it('returns the row untouched when there is no override', () => {
		expect(applyOverrides(base)).toBe(base);
	});

	it('shadows only the overridden fields and keeps extra row fields', () => {
		const out = applyOverrides({ ...base, overrides: { title: 'Mine', bpm: 122 } });
		expect(out.title).toBe('Mine');
		expect(out.bpm).toBe(122);
		expect(out.label).toBe('Label');
		expect(out.id).toBe('t1');
	});
});
