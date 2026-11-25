// sortLikeDb must hand back the order core's ORDER BY would: NULLs below
// every value, byte-wise text, ties in incoming order, and 'index' meaning
// playlist position only for a single-playlist read.

import { describe, expect, it } from 'vitest';
import type { Track } from '@curator/shared';
import { sortLikeDb } from './track-sort.js';

const t = (id: string, over: Partial<Track> = {}): Track => ({ id, createdAt: new Date(0), addedAt: null, ...over }) as unknown as Track;
const ids = (rows: Track[] | null): string[] | undefined => rows?.map((r) => r.id);
const flat = { playlistContext: false };

describe('sortLikeDb', () => {
	it('puts NULL first ascending and last descending, as SQLite does', () => {
		const rows = [t('a', { bpm: 124 }), t('b', { bpm: null }), t('c', { bpm: 120 })];
		expect(ids(sortLikeDb(rows, { column: 'bpm', dir: 'asc' }, flat))).toEqual(['b', 'c', 'a']);
		expect(ids(sortLikeDb(rows, { column: 'bpm', dir: 'desc' }, flat))).toEqual(['a', 'c', 'b']);
	});

	it('compares text byte-wise (BINARY collation: uppercase before lowercase)', () => {
		const rows = [t('a', { title: 'apple' }), t('b', { title: 'Zebra' }), t('c', { title: 'Apple' })];
		expect(ids(sortLikeDb(rows, { column: 'title', dir: 'asc' }, flat))).toEqual(['c', 'b', 'a']);
	});

	it('keeps ties in their incoming order in both directions', () => {
		const rows = [t('a', { genre: 'House' }), t('b', { genre: 'House' }), t('c', { genre: 'Deep' })];
		expect(ids(sortLikeDb(rows, { column: 'genre', dir: 'asc' }, flat))).toEqual(['c', 'a', 'b']);
		expect(ids(sortLikeDb(rows, { column: 'genre', dir: 'desc' }, flat))).toEqual(['a', 'b', 'c']);
	});

	it('sorts artist by the materialized artistSort fold', () => {
		const rows = [t('a', { artistSort: 'marsh' }), t('b', { artistSort: 'ben bohmer' })];
		expect(ids(sortLikeDb(rows, { column: 'artist', dir: 'asc' }, flat))).toEqual(['b', 'a']);
	});

	it('sorts Added by addedAt, falling back to createdAt', () => {
		const rows = [
			t('a', { createdAt: new Date(300) }),
			t('b', { createdAt: new Date(900), addedAt: new Date(100) }),
			t('c', { createdAt: new Date(200) }),
		];
		expect(ids(sortLikeDb(rows, { column: 'createdAt', dir: 'asc' }, flat))).toEqual(['b', 'c', 'a']);
	});

	it("sorts 'index' by playlist position in a playlist, by createdAt elsewhere", () => {
		const rows = [
			t('a', { playlistPosition: 2, createdAt: new Date(100) }),
			t('b', { playlistPosition: 0, createdAt: new Date(300) }),
			t('c', { playlistPosition: 1, createdAt: new Date(200) }),
		];
		expect(ids(sortLikeDb(rows, { column: 'index', dir: 'asc' }, { playlistContext: true }))).toEqual(['b', 'c', 'a']);
		expect(ids(sortLikeDb(rows, { column: 'index', dir: 'asc' }, flat))).toEqual(['a', 'c', 'b']);
	});

	it("leaves 'match' to the server", () => {
		expect(sortLikeDb([t('a')], { column: 'match', dir: 'desc' }, flat)).toBeNull();
	});
});
