// The rekordbox Title/Artist line is the app's own display string: names in
// credit order joined by the user's separator (remixers plain, feat. last),
// and the title's remix segment in the user's style. Pinned here because
// push-omit-empty.test.ts only covers the role-less default join.

import { describe, it, expect } from 'vitest';
import { effectiveArtistName, effectiveTitle, curatorFieldsView } from './curator-view.js';

const rmx = { name: 'Massano', role: 'remixer' as const };

describe('effectiveArtistName', () => {
	it('joins every credited name with the default ", ", remixers included, feat. last', () => {
		expect(effectiveArtistName({ artists: [{ name: 'Lane 8' }, rmx], overrides: null })).toBe('Lane 8, Massano');
		expect(effectiveArtistName({ artists: [{ name: 'A' }, { name: 'B', role: 'featured' }, { name: 'C', role: 'remixer' }], overrides: null })).toBe('A, C feat. B');
	});
	it('honours the separator setting; overrides win; empty is null', () => {
		expect(effectiveArtistName({ artists: [{ name: 'Lane 8' }, rmx], overrides: null }, { separator: '/', remixStyle: 'dash' })).toBe('Lane 8 / Massano');
		expect(effectiveArtistName({ artists: [{ name: 'A' }], overrides: { artists: [{ name: 'Z' }] } })).toBe('Z');
		expect(effectiveArtistName({ artists: [], overrides: null })).toBeNull();
	});
});

describe('effectiveTitle', () => {
	it('re-wraps the remix segment in the chosen style, wording intact', () => {
		const t = { title: 'Drown - Massano Remix', artists: [{ name: 'Lane 8' }, rmx], overrides: null };
		expect(effectiveTitle(t)).toBe('Drown (Massano Remix)');
		expect(effectiveTitle(t, { separator: ',', remixStyle: 'dash' })).toBe('Drown - Massano Remix');
		expect(effectiveTitle({ title: 'Plain', artists: [{ name: 'A' }], overrides: null })).toBe('Plain');
	});
	it('curatorFieldsView carries the same formatting so merge and push agree', () => {
		const t = { title: 'Drown - Massano Remix', artists: [{ name: 'Lane 8' }, rmx], albumTitle: null, label: null, genre: null, rating: null, comment: null, colorLabel: null, overrides: null };
		const v = curatorFieldsView(t, { separator: ';', remixStyle: 'parenthesis' });
		expect(v.title).toBe('Drown (Massano Remix)');
		expect(v.artist).toBe('Lane 8; Massano');
	});
});
