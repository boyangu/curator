// Pure classification helpers for the unified Organize modal. These pin the
// merge's contract: which of the three columns each item lands in (the whole
// point of combining the tag + playlist pickers), the per-source colour key,
// the folder-path shape used for the sub-label + search, and the three-state
// membership cycle ported from the two dialogs it replaces.

import { describe, expect, it } from 'vitest';
import { tristate, columnOf, dataSource, pathString, describeItem, balanceFirstPage, createKindFor, type OrganizeItem } from './organizeModel.js';

const item = (o: Partial<OrganizeItem> & Pick<OrganizeItem, 'kind' | 'source'>): OrganizeItem => ({
	id: 'x', name: 'n', ownedByMe: true, ...o,
});

describe('columnOf', () => {
	it('routes tags to the Tags column regardless of source', () => {
		expect(columnOf(item({ kind: 'tag', source: 'local' }))).toBe('tag');
	});
	it('routes Rekordbox + local playlists to the Local column', () => {
		expect(columnOf(item({ kind: 'playlist', source: 'rekordbox' }))).toBe('local');
		expect(columnOf(item({ kind: 'playlist', source: 'local' }))).toBe('local');
	});
	it('routes Spotify + Tidal playlists to the Streaming column', () => {
		expect(columnOf(item({ kind: 'playlist', source: 'spotify' }))).toBe('stream');
		expect(columnOf(item({ kind: 'playlist', source: 'tidal' }))).toBe('stream');
	});
});

describe('dataSource', () => {
	it('is "tag" for tags (accent colour) and the real source for playlists', () => {
		expect(dataSource(item({ kind: 'tag', source: 'local' }))).toBe('tag');
		expect(dataSource(item({ kind: 'playlist', source: 'spotify' }))).toBe('spotify');
		expect(dataSource(item({ kind: 'playlist', source: 'rekordbox' }))).toBe('rekordbox');
	});
});

describe('pathString', () => {
	it('joins folder ancestry with " / " and is empty at the root / for tags', () => {
		expect(pathString(item({ kind: 'playlist', source: 'rekordbox', folderPath: ['24 hrs', 'sets'] }))).toBe('24 hrs / sets');
		expect(pathString(item({ kind: 'playlist', source: 'rekordbox', folderPath: [] }))).toBe('');
		expect(pathString(item({ kind: 'tag', source: 'local' }))).toBe('');
	});
});

describe('describeItem', () => {
	it('names the source and prefixes the folder path for playlists', () => {
		expect(describeItem(item({ kind: 'playlist', source: 'rekordbox', name: 'Opening', folderPath: ['Sets', 'SetX'] }))).toBe('Rekordbox playlist: Sets / SetX / Opening');
		expect(describeItem(item({ kind: 'playlist', source: 'tidal', name: 'Warm hypnotic electronica', folderPath: [] }))).toBe('Tidal playlist: Warm hypnotic electronica');
		expect(describeItem(item({ kind: 'playlist', source: 'spotify', name: 'Night' }))).toBe('Spotify playlist: Night');
		expect(describeItem(item({ kind: 'playlist', source: 'local', name: 'Picks' }))).toBe('Curator playlist: Picks');
	});
	it('labels tags as tags', () => {
		expect(describeItem(item({ kind: 'tag', source: 'local', name: 'vocal' }))).toBe('Tag: vocal');
	});
});

describe('tristate', () => {
	it('none when zero carry it, all when every selected track carries it', () => {
		expect(tristate(0, 7)).toBe('none');
		expect(tristate(7, 7)).toBe('all');
	});
	it('some for partial coverage of a multi-track selection', () => {
		expect(tristate(3, 7)).toBe('some');
	});
	it('degrades to none on an empty selection (avoids divide-by-zero states)', () => {
		expect(tristate(0, 0)).toBe('none');
	});
	it('clamps over-counts to all (defensive against duplicate membership rows)', () => {
		expect(tristate(9, 7)).toBe('all');
	});
});

describe('balanceFirstPage', () => {
	const kindOf = (s: string): string => s[0]!; // 'p1' → 'p', 't1' → 't'

	it('pulls buried tags into a first page that raw scores made all-playlists', () => {
		// 10 playlists lead the ranking, 3 tags trail. Page of 8, min 2/kind:
		// the last 2 page slots must go to the top tags.
		const list = [...Array.from({ length: 10 }, (_, i) => `p${i}`), 't0', 't1', 't2'];
		const out = balanceFirstPage(list, kindOf, 8, 2);
		const page = out.slice(0, 8);
		expect(page.filter((s) => s[0] === 't')).toEqual(['t0', 't1']);
		expect(page.filter((s) => s[0] === 'p')).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
		// nothing lost — the displaced playlists follow for the pager
		expect(out).toHaveLength(list.length);
		expect(new Set(out)).toEqual(new Set(list));
	});

	it('is a no-op when the page is already balanced', () => {
		const list = ['t0', 'p0', 't1', 'p1', 'p2', 't2', 'p3', 'p4'];
		expect(balanceFirstPage(list, kindOf, 6, 2)).toEqual(list);
	});

	it('reserves page slots for a third kind that would otherwise miss the page', () => {
		// 3 kinds, min 2 each, page of 6 — the page must carry 2 of each, so
		// the lowest-ranked t/p overflow to the pager to make room for x.
		const list = ['t0', 'p0', 't1', 'p1', 't2', 'p2', 'x0', 'x1'];
		const out = balanceFirstPage(list, kindOf, 6, 2);
		expect(out.slice(0, 6)).toEqual(['t0', 'p0', 't1', 'p1', 'x0', 'x1']);
		expect(out.slice(6)).toEqual(['t2', 'p2']);
	});

	it('caps a kind quota by availability (single tag never blocks slots)', () => {
		const list = [...Array.from({ length: 6 }, (_, i) => `p${i}`), 't0'];
		const out = balanceFirstPage(list, kindOf, 4, 3);
		// only one tag exists → quota 1; page = p0..p2 + t0
		expect(out.slice(0, 4)).toEqual(['p0', 'p1', 'p2', 't0']);
	});

	it('returns short lists untouched', () => {
		const list = ['p0', 'p1', 't0'];
		expect(balanceFirstPage(list, kindOf, 16, 4)).toEqual(list);
	});
});

describe('createKindFor', () => {
	const items: OrganizeItem[] = [
		item({ id: 't', kind: 'tag', source: 'local', name: 'Deep' }),
		item({ id: 'l', kind: 'playlist', source: 'local', name: 'Night' }),
		item({ id: 's', kind: 'playlist', source: 'spotify', name: 'Sunset' }),
		item({ id: 'td', kind: 'playlist', source: 'tidal', name: 'Morning' }),
	];
	it('offers nothing for an empty / whitespace query', () => {
		expect(createKindFor('tag', '  ', items, true)).toBeNull();
		expect(createKindFor('stream', '', items, true)).toBeNull();
	});
	it('keeps tag + local create semantics (exact, case-insensitive)', () => {
		expect(createKindFor('tag', 'deep', items, true)).toBeNull();
		expect(createKindFor('tag', 'Night', items, true)).toBe('tag');
		expect(createKindFor('local', 'NIGHT', items, true)).toBeNull();
		expect(createKindFor('local', 'sunset', items, true)).toBeNull(); // any playlist blocks local create
		expect(createKindFor('local', 'Fresh', items, true)).toBe('playlist');
	});
	it('offers a Spotify create only when Spotify is connected', () => {
		expect(createKindFor('stream', 'Fresh', items, false)).toBeNull();
		expect(createKindFor('stream', 'Fresh', items, true)).toBe('spotify-playlist');
	});
	it('dedupes the Spotify create against Spotify playlists only', () => {
		expect(createKindFor('stream', 'sunset', items, true)).toBeNull();
		expect(createKindFor('stream', 'Night', items, true)).toBe('spotify-playlist');
		expect(createKindFor('stream', 'Morning', items, true)).toBe('spotify-playlist');
	});
});
