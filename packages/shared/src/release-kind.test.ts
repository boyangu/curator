import { describe, expect, it } from 'vitest';
import { releaseKind } from './release-kind.js';

describe('releaseKind', () => {
	it('takes the store\'s word for an album and a short single', () => {
		expect(releaseKind({ type: 'album', title: 'Gaxyda', trackCount: 11 })).toBe('album');
		expect(releaseKind({ type: 'single', title: 'Gaxyda', trackCount: 3 })).toBe('single');
		expect(releaseKind({ type: 'single', title: 'Gaxyda' })).toBe('single');
	});

	it('reads an EP off the store, the title, or four to six tracks filed as a single', () => {
		expect(releaseKind({ type: 'ep', title: 'Aria' })).toBe('ep');
		expect(releaseKind({ type: 'single', title: 'Aria EP', trackCount: 2 })).toBe('ep');
		expect(releaseKind({ type: 'album', title: 'Aria E.P.', trackCount: 4 })).toBe('ep');
		expect(releaseKind({ type: 'single', title: 'Aria', trackCount: 4 })).toBe('ep');
		expect(releaseKind({ type: 'single', title: 'Aria', trackCount: 6 })).toBe('ep');
		// A word that only contains the letters is not the format.
		expect(releaseKind({ type: 'single', title: 'Deep', trackCount: 1 })).toBe('single');
		expect(releaseKind({ type: 'album', title: 'Epic Steps', trackCount: 9 })).toBe('album');
		// The store's "album" holds for a short album without the word.
		expect(releaseKind({ type: 'album', title: 'Aria', trackCount: 5 })).toBe('album');
	});

	it('sizes a release no store typed, and says nothing when it has nothing', () => {
		expect(releaseKind({ title: 'Aria', trackCount: 2 })).toBe('single');
		expect(releaseKind({ title: 'Aria', trackCount: 5 })).toBe('ep');
		expect(releaseKind({ title: 'Aria', trackCount: 12 })).toBe('album');
		expect(releaseKind({ title: 'Aria' })).toBeNull();
		expect(releaseKind({ title: 'Aria', trackCount: 0 })).toBeNull();
	});

	it('knows a compilation by the store\'s word or its credit', () => {
		expect(releaseKind({ type: 'compilation', title: 'Summer Sampler', trackCount: 20 })).toBe('va');
		expect(releaseKind({ type: 'compile', title: 'Summer Sampler' })).toBe('va');
		expect(releaseKind({ type: 'album', title: 'Summer Sampler', artists: ['Various Artists'] })).toBe('va');
		expect(releaseKind({ type: 'album', title: 'Summer Sampler', various: true })).toBe('va');
		expect(releaseKind({ type: 'album', title: 'Vacation', artists: ['Vaal'] })).toBe('album');
	});

	it('knows a DJ mix by its title or by its tracks being mixed cuts, before anything else', () => {
		expect(releaseKind({ type: 'compilation', title: 'Anjunadeep 14 (DJ Mix)', trackCount: 60 })).toBe('mix');
		expect(releaseKind({ type: 'album', title: 'Global Underground #41: James Lavelle (Mixed)' })).toBe('mix');
		expect(releaseKind({ type: 'album', title: 'Balance 029 - Mixed by Guy J' })).toBe('mix');
		expect(releaseKind({ type: 'compilation', title: 'fabric 99', trackTitles: ['One (Mixed)', 'Two - Mixed', 'Three (Mixed)', 'Intro'] })).toBe('mix');
		// A remix or an "Extended Mix" is not a DJ mix.
		expect(releaseKind({ type: 'single', title: 'Aria (Gorkiz Remix)', trackCount: 1 })).toBe('single');
		expect(releaseKind({ type: 'single', title: 'Aria', trackCount: 2, trackTitles: ['Aria (Extended Mix)', 'Aria (Original Mix)'] })).toBe('single');
		expect(releaseKind({ type: 'album', title: 'Mixed Emotions', trackCount: 10 })).toBe('album');
	});
});
