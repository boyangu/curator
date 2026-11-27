import { describe, expect, it } from 'vitest';
import { clearMatch, confirmRelease, listingsAgree, pairTracklists, titleKey, type MatchTrack } from './release-match.js';

const t = (title: string, durationSec: number | null = null, isrc: string | null = null): MatchTrack => ({ title, durationSec, isrc });

describe('titleKey', () => {
	it('drops the mix tags stores word differently', () => {
		expect(titleKey('Glass Rivers (Original Mix)')).toBe(titleKey('Glass Rivers'));
		expect(titleKey('Glass Rivers - Original Mix')).toBe(titleKey('Glass Rivers'));
		expect(titleKey('Glass Rivers [Northfold]')).toBe(titleKey('Glass Rivers'));
		expect(titleKey('Glass Rivers (Dub)')).not.toBe(titleKey('Glass Rivers'));
	});
});

describe('pairTracklists', () => {
	it('pairs by title and length, and the leftovers by position when the lists are as long', () => {
		const ours = [t('Glass Rivers (Original Mix)', 401), t('Glass Rivers (Dub)', 380), t('Interlude', 60)];
		const theirs = [t('Glass Rivers', 402), t('Glass Rivers - Dub', 381), t('Intro', 61)];
		const pairs = pairTracklists(ours, theirs)!;
		expect(pairs.get(ours[0]!)).toBe(theirs[0]);
		// "(Dub)" and "- Dub" fold alike; the third pairs by position.
		expect(pairs.get(ours[1]!)).toBe(theirs[1]);
		expect(pairs.get(ours[2]!)).toBe(theirs[2]);
	});

	it('refuses when fewer than half of ours are found', () => {
		expect(pairTracklists([t('A', 300), t('B', 300), t('C', 300)], [t('A', 300), t('X', 200), t('Y', 100), t('Z', 50)])).toBeNull();
		expect(pairTracklists([], [t('A', 300)])).toBeNull();
	});

	it('a length a store does not give agrees with anything, unless strict', () => {
		const ours = [t('A'), t('B', 300)];
		const theirs = [t('A', 250), t('B', 302)];
		expect(pairTracklists(ours, theirs)!.size).toBe(2);
		// Strict: A has no length on our side and no ISRC, so only B pairs.
		const strict = pairTracklists(ours, theirs, { strict: true })!;
		expect(strict.size).toBe(1);
		expect(strict.get(ours[1]!)).toBe(theirs[1]);
	});

	it('strict pairs by an ISRC both state, whatever the titles say, and never by position', () => {
		const ours = [t('Salvage', 340, 'GB-AAA-26-00001'), t('Second', 200)];
		const theirs = [t('Salvage (Extended)', 345, 'gbaaa2600001'), t('Other', 200)];
		const pairs = pairTracklists(ours, theirs, { strict: true })!;
		expect(pairs.get(ours[0]!)).toBe(theirs[0]);
		expect(pairs.has(ours[1]!)).toBe(false);
		// Lenient goes by title alone, and no title here is the other's.
		expect(pairTracklists(ours, theirs)).toBeNull();
	});
});

describe('confirmRelease', () => {
	it('a single on a long compilation is not that compilation', () => {
		const single = [t('Salvage', 340)];
		const compilation = [t('Salvage', 340), ...Array.from({ length: 19 }, (_, i) => t(`Other ${i}`, 300))];
		expect(pairTracklists(single, compilation)).not.toBeNull();
		expect(confirmRelease(single, compilation)).toBeNull();
		expect(confirmRelease(compilation, single)).toBeNull();
	});

	it('an edition with a bonus track is still the release', () => {
		const ep = [t('A', 300), t('B', 310), t('C', 320)];
		const deluxe = [t('A', 300), t('B', 311), t('C', 319), t('A (Dub)', 400)];
		expect(confirmRelease(ep, deluxe, { strict: true })!.size).toBe(3);
	});
});

describe('clearMatch', () => {
	const page = (name: string, shared: number) => ({ name, shared: Array.from({ length: shared }, (_, i) => `r${i}`) });

	it('takes the one page of that name sharing two releases and twice the runner-up', () => {
		const a = page('MONADA', 14);
		expect(clearMatch('Monada', [a, page('Monada', 3), page('Other', 20)])).toBe(a);
		expect(clearMatch('Monada', [page('Monada', 4), page('Monada', 3)])).toBeNull();
		expect(clearMatch('Monada', [page('Monada', 1)])).toBeNull();
		expect(clearMatch('Monada', [page('Monado', 9)])).toBeNull();
	});
});

describe('listingsAgree', () => {
	const anchor = ['Salvage', 'Do You Funk This Beat?', 'Ya Ghali', 'Psychedelic Safari'];

	it('agrees on two titles that are a quarter of the shorter listing, whichever way round', () => {
		expect(listingsAgree(anchor, ['Salvage (Original Mix)', 'Ya Ghali', 'Bandcamp Only'])).toEqual({ agrees: true, shared: 2 });
		expect(listingsAgree(['Salvage (Original Mix)', 'Ya Ghali', 'Bandcamp Only'], anchor)).toEqual({ agrees: true, shared: 2 });
	});

	it('agrees when one store carries a small share of the label: all five of its titles among the other\'s forty', () => {
		const five = Array.from({ length: 5 }, (_, i) => `Monada ${i}`);
		const forty = Array.from({ length: 40 }, (_, i) => `Monada ${i}`);
		expect(listingsAgree(five, forty)).toEqual({ agrees: true, shared: 5 });
		expect(listingsAgree(forty, five)).toEqual({ agrees: true, shared: 5 });
		// A label known by one release, and a page that lists it.
		expect(listingsAgree(anchor, ['Salvage'])).toEqual({ agrees: true, shared: 1 });
	});

	it('a bucket page listing the label among everyone else does not agree, nor a page sharing one title of several, nor an empty one', () => {
		const bucket = ['Salvage', 'Ya Ghali', ...Array.from({ length: 40 }, (_, i) => `Someone else ${i}`)];
		expect(listingsAgree(anchor, bucket)).toEqual({ agrees: false, shared: 2 });
		expect(listingsAgree(bucket, anchor)).toEqual({ agrees: false, shared: 2 });
		expect(listingsAgree(anchor, ['Salvage', 'Other', 'Another', 'More', 'And More'])).toEqual({ agrees: false, shared: 1 });
		expect(listingsAgree(anchor, [])).toEqual({ agrees: false, shared: 0 });
	});
});
