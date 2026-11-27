// Catalogue rows — a page of the Global Catalog as track-list rows: a
// recording the library holds is the library's own row (once, on the release
// that stands for it), every other is a synthetic row nothing in the library
// may act on, ids never collide across releases, and the in-memory sort
// reads like the database's. Pure functions, no DOM.

import { describe, expect, it } from 'vitest';
import type { EntityTracksPage, EntityWorldAlbum, EntityWorldTrack, Track } from '@curator/shared';
import { albumSummaryOf, canSortCatalogRows, catalogArtistId, catalogStreamId, heldTrackIds, isCatalogRow, isLibraryTrackId, patchRow, sortRows, toRows } from './catalogRows.js';
import { buildDisplayList } from './trackGroups.js';

const template = { id: '', recordingId: '', title: '', artists: [], state: 'unsorted', playCount: 0, remoteOnly: false, rating: null, albumId: null, label: null, bpm: null } as unknown as Track;

const album = (id: string, title: string, date: string | null, over: Partial<EntityWorldAlbum> = {}): EntityWorldAlbum => ({
	id, title, date, type: 'single', coverUrl: `https://img.test/${id}.jpg`, label: { id: 'lab-1', name: 'Anjunadeep' }, artists: [{ id: 'art-1', name: 'Marsh' }], genres: ['Melodic House & Techno'], trackCount: 2, appearance: false, links: [], ...over,
});
const rec = (recordingId: string, releaseId: string, title: string, over: Partial<EntityWorldTrack> = {}): EntityWorldTrack => ({
	recordingId, releaseId, title, artists: [{ id: 'art-1', name: 'Marsh' }], position: 1, disc: null, durationSec: 300, isrc: null, bpm: null, keyCamelot: null, genre: null, links: [], streamIds: {}, libraryTrackId: null, libraryPrimary: false, ...over,
});

const page = (albums: EntityWorldAlbum[], tracks: EntityWorldTrack[]): EntityTracksPage => ({ albums, tracks, nextCursor: null, template });

describe('toRows', () => {
	it('lays a recording the library lacks over the empty track: a synthetic row with the catalogue\'s facts', () => {
		const [row] = toRows(page([album('rel-1', 'Lailonie', '2026-03-01')], [rec('rec-1', 'rel-1', 'Lailonie', { position: 2, bpm: 122, keyCamelot: '8A', streamIds: { spotify: 'sp1' }, artists: [{ id: 'art-1', name: 'Marsh' }, { id: 'art-2', name: 'Nox Vahn', role: 'remixer' }] })]), new Map());
		expect(isCatalogRow(row!)).toBe(true);
		expect(row).toMatchObject({
			id: 'catalog:rel-1:rec-1', title: 'Lailonie', albumTitle: 'Lailonie', releaseDate: '2026-03-01', label: 'Anjunadeep', coverUrl: 'https://img.test/rel-1.jpg',
			trackNumber: 2, bpm: 122, keyCamelot: '8A', duration: 300, sources: [], claimSources: ['spotify'],
			artists: [{ name: 'Marsh' }, { name: 'Nox Vahn', role: 'remixer' }], artistIds: ['catalog:art-1', 'catalog:art-2'],
		});
		expect(row!.catalog).toMatchObject({ recordingId: 'rec-1', releaseId: 'rel-1', synthetic: true, libraryTrackId: null, albumArtistId: 'art-1', labelId: 'lab-1' });
		// Every column of the template is still there: the row is a whole Track.
		expect(row).toMatchObject({ state: 'unsorted', playCount: 0, remoteOnly: false, rating: null });
		expect(isLibraryTrackId(row!.id)).toBe(false);
		expect(catalogArtistId(row!.artistIds![0])).toBe('art-1');
		expect(catalogArtistId('a1')).toBeNull();
	});

	it("shows the library's own row where the library has the track — once; a repeat on another release stays a catalogue row", () => {
		const own = { ...template, id: 't1', title: 'Lailonie (my edit)', rating: 5, sources: ['local'], albumId: 'al1', albumTitle: 'Lailonie', trackNumber: null } as unknown as Track;
		const pg = page(
			[album('rel-2', 'Lailonie (Deluxe)', '2026-06-01'), album('rel-1', 'Lailonie', '2026-03-01')],
			[
				rec('rec-1', 'rel-2', 'Lailonie', { libraryTrackId: 't1', libraryPrimary: false }),
				rec('rec-1', 'rel-1', 'Lailonie', { position: 1, libraryTrackId: 't1', libraryPrimary: true }),
				rec('rec-2', 'rel-1', 'Eu Topos', { position: 2 }),
			],
		);
		const rows = toRows(pg, new Map([['t1', own]]));
		expect(rows.map((r) => [r.id, isCatalogRow(r), r.catalog?.libraryTrackId ?? null])).toEqual([
			['catalog:rel-2:rec-1', true, 't1'],
			['t1', false, null],
			['catalog:rel-1:rec-2', true, null],
		]);
		// The library's facts stay; the catalogue only places it on its release.
		expect(rows[1]).toMatchObject({ title: 'Lailonie (my edit)', rating: 5, sources: ['local'], trackNumber: 1, albumTitle: 'Lailonie' });
		// A synced row nobody analysed shows the catalogue's BPM, key and genre;
		// the library's own, once it has them, stand.
		const facts = { bpm: 122, keyCamelot: '8A', genre: 'Progressive House' };
		const bare = toRows(page([album('rel-1', 'Lailonie', '2026-03-01')], [rec('rec-1', 'rel-1', 'Lailonie', { libraryTrackId: 't1', libraryPrimary: true, ...facts })]), new Map([['t1', own]]));
		expect(bare[0]).toMatchObject({ id: 't1', ...facts, label: 'Anjunadeep' });
		const analysed = { ...own, bpm: 124, keyCamelot: '9A', genre: 'Deep House', label: 'Mine' } as Track;
		const mine = toRows(page([album('rel-1', 'Lailonie', '2026-03-01')], [rec('rec-1', 'rel-1', 'Lailonie', { libraryTrackId: 't1', libraryPrimary: true, ...facts })]), new Map([['t1', analysed]]));
		expect(mine[0]).toMatchObject({ bpm: 124, keyCamelot: '9A', genre: 'Deep House', label: 'Mine' });
		// The repeat keeps the catalogue's facts and shows the track's sources.
		expect(rows[0]).toMatchObject({ title: 'Lailonie', rating: null, sources: ['local'], albumTitle: 'Lailonie (Deluxe)' });
		expect(heldTrackIds(pg)).toEqual(['t1']);
		// A track the library read did not return (deleted since) is not held.
		expect(toRows(pg, new Map()).map((r) => [r.sources, r.catalog?.libraryTrackId ?? null])).toEqual([[[], null], [[], null], [[], null]]);
		// One id per row, though one recording sits on two releases.
		expect(new Set(rows.map((r) => r.id)).size).toBe(3);
		// Grouped by album, the library's row files with its catalogue siblings.
		const groups = buildDisplayList(rows, 'album').groups;
		expect(groups.map((g) => [g.title, g.albumId, g.tracks.map((t) => t.id)])).toEqual([
			['Lailonie (Deluxe)', 'catalog:rel-2', ['catalog:rel-2:rec-1']],
			['Lailonie', 'catalog:rel-1', ['t1', 'catalog:rel-1:rec-2']],
		]);
	});

	it("reads a catalogue release as an album header, and a row's stream id by the primary service", () => {
		expect(albumSummaryOf(album('rel-1', 'Lailonie', '2026-03-01'))).toMatchObject({ id: 'catalog:rel-1', title: 'Lailonie', artists: [{ id: 'catalog:art-1', name: 'Marsh' }], label: 'Anjunadeep', coverTrackId: null, coverUrl: 'https://img.test/rel-1.jpg' });
		const [row] = toRows(page([album('rel-1', 'Lailonie', null)], [rec('rec-1', 'rel-1', 'Lailonie', { streamIds: { tidal: 'td1' } })]), new Map());
		expect(catalogStreamId(row!, 'tidal')).toBe('td1');
		expect(catalogStreamId(row!, 'spotify')).toBeNull();
		expect(catalogStreamId(row!, null)).toBeNull();
	});
});

describe('patchRow', () => {
	const rows = () => toRows(
		page([album('rel-1', 'Lailonie', '2026-03-01', { label: null, genres: ['Electro'] })], [
			rec('rec-1', 'rel-1', 'Lailonie', { genre: 'Electro' }),
			rec('rec-2', 'rel-1', 'Held', { bpm: 122, streamIds: { spotify: 'sp-own' }, libraryTrackId: 'lib-1', libraryPrimary: true }),
		]),
		new Map([['lib-1', { ...template, id: 'lib-1', title: 'Held', bpm: 121 } as Track]]),
	);

	it('fills what a catalogue row lacks and where it plays, as a new row; the row it had is kept where it had one', () => {
		const [row] = rows();
		const next = patchRow(row!, { recordingId: 'rec-1', bpm: 124, keyCamelot: '8A', genre: 'Melodic House & Techno', label: 'Anjunadeep', streamIds: { spotify: 'sp1' } });
		expect(next).not.toBe(row);
		expect(next).toMatchObject({ id: row!.id, bpm: 124, keyCamelot: '8A', genre: 'Melodic House & Techno', label: 'Anjunadeep', claimSources: ['spotify'] });
		expect(catalogStreamId(next, 'spotify')).toBe('sp1');
		// A second finding never replaces the first's facts or the catalogue's page.
		const again = patchRow(next, { recordingId: 'rec-1', bpm: 99, streamIds: { spotify: 'other' } });
		expect(again).toBe(next);
	});

	it("leaves the library's own row and another recording's row as they are", () => {
		const [row, own] = rows();
		expect(patchRow(own!, { recordingId: 'rec-2', bpm: 130, streamIds: { tidal: 't1' } })).toBe(own);
		expect(patchRow(row!, { recordingId: 'rec-9', bpm: 130 })).toBe(row);
	});
});

describe('sortRows', () => {
	const rows = toRows(
		page(
			[album('a', 'B Side', '2026-01-01'), album('b', 'A Side', '2025-01-01', { label: null })],
			[rec('r1', 'a', 'Zeta', { bpm: 128 }), rec('r2', 'a', 'alpha', { bpm: null }), rec('r3', 'b', 'Mid', { bpm: 120 })],
		),
		new Map(),
	);
	const titles = (column: string, dir: 'asc' | 'desc') => sortRows(rows, { column, dir }).map((r) => r.title);

	it('sorts in memory on the columns the catalogue has, folded, stable, with empty values last either way', () => {
		expect(titles('title', 'asc')).toEqual(['alpha', 'Mid', 'Zeta']);
		expect(titles('bpm', 'asc')).toEqual(['Mid', 'Zeta', 'alpha']);
		expect(titles('bpm', 'desc')).toEqual(['Zeta', 'Mid', 'alpha']);
		expect(titles('label', 'asc')).toEqual(['Zeta', 'alpha', 'Mid']);
		expect(titles('releaseDate', 'desc')).toEqual(['Zeta', 'alpha', 'Mid']);
		// The catalogue's own order, and columns it has nothing for.
		expect(titles('index', 'asc')).toEqual(['Zeta', 'alpha', 'Mid']);
		expect(titles('index', 'desc')).toEqual(['Mid', 'alpha', 'Zeta']);
		expect(titles('rating', 'desc')).toEqual(['Zeta', 'alpha', 'Mid']);
		expect(canSortCatalogRows('bpm')).toBe(true);
		expect(canSortCatalogRows('rating')).toBe(false);
	});
});
