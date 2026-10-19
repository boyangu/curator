// The artist seam against a migrated temp curator.db: fold identity, alias
// following, curated-spelling substitution, junction rewrite, artist_sort.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import type Database from 'better-sqlite3';
import { searchFold } from '@curator/shared';
import {
	syncTrackArtists, syncTrackArtistsById, normalizeIncomingArtists, lookupArtistRaw, upsertArtistRaw, artistProtect,
} from './artists.js';

let dir: string;
let db: Db;
let sqlite: Database.Database;

function insertTrack(id: string, artists: unknown[], overrides: unknown = null): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, overrides, state) VALUES (?, ?, ?, ?, 'unsorted')`)
		.run(id, id, JSON.stringify(artists), overrides ? JSON.stringify(overrides) : null);
}
function links(trackId: string): Array<{ artist_id: string; role: string | null; position: number }> {
	return sqlite.prepare(`SELECT artist_id, role, position FROM track_artist WHERE track_id = ? ORDER BY position`).all(trackId) as never;
}
function artists(): Array<{ id: string; name: string; name_ascii: string; merged_into: string | null }> {
	return sqlite.prepare(`SELECT id, name, name_ascii, merged_into FROM artist ORDER BY name_ascii`).all() as never;
}
function sortOf(trackId: string): string | null {
	return (sqlite.prepare(`SELECT artist_sort FROM track WHERE id = ?`).get(trackId) as { artist_sort: string | null }).artist_sort;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-artists-'));
	const path = join(dir, 'curator.db');
	migrate(path);
	({ db, sqlite } = createDb(path));
});
afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('syncTrackArtists', () => {
	it('mints one artist per fold and links by position with roles', () => {
		insertTrack('t1', [{ name: 'Ben Böhmer' }, { name: 'Nils Hoffmann', role: 'featured' }]);
		insertTrack('t2', [{ name: 'ben bohmer' }]);
		syncTrackArtistsById(db, ['t1', 't2']);
		const all = artists();
		expect(all.map((a) => a.name)).toEqual(['Ben Böhmer', 'Nils Hoffmann']);
		const ben = all[0]!;
		expect(links('t1')).toEqual([
			{ artist_id: ben.id, role: null, position: 0 },
			{ artist_id: all[1]!.id, role: 'featured', position: 1 },
		]);
		// Case/diacritic variant resolves to the same artist row.
		expect(links('t2')).toEqual([{ artist_id: ben.id, role: null, position: 0 }]);
		expect(sortOf('t1')).toBe('ben bohmer');
	});

	it('derives from the override list when present, and clears on empty', () => {
		insertTrack('t1', [{ name: 'Canonical' }], { artists: [{ name: 'Overridden' }] });
		syncTrackArtistsById(db, ['t1']);
		expect(artists().map((a) => a.name)).toEqual(['Overridden']);
		expect(sortOf('t1')).toBe('overridden');
		syncTrackArtists(db, [{ id: 't1', artists: [], overrides: null }]);
		expect(links('t1')).toEqual([]);
		expect(sortOf('t1')).toBeNull();
	});

	it('identity ignores punctuation and spacing (Pig & Dan / Pig&Dan / Hunter_Game / Hunter/Game)', () => {
		insertTrack('t1', [{ name: 'Pig & Dan' }, { name: 'Hunter/Game' }, { name: 'Ae:ther' }]);
		insertTrack('t2', [{ name: 'Pig&Dan' }, { name: 'Hunter_Game' }, { name: 'Aether' }]);
		syncTrackArtistsById(db, ['t1', 't2']);
		expect(artists().map((a) => [a.name, a.name_ascii])).toEqual([['Ae:ther', 'aether'], ['Hunter/Game', 'huntergame'], ['Pig & Dan', 'pig&dan']]);
		expect(links('t2').map((l) => l.artist_id)).toEqual(links('t1').map((l) => l.artist_id));
		// "&ME" keeps its ampersand — it is not "Me".
		insertTrack('t3', [{ name: '&ME' }, { name: 'Me' }]);
		syncTrackArtistsById(db, ['t3']);
		expect(links('t3')).toHaveLength(2);
	});

	it('collapses a credit naming the same artist twice', () => {
		insertTrack('t1', [{ name: 'A' }, { name: 'a' }]);
		syncTrackArtistsById(db, ['t1']);
		expect(links('t1')).toHaveLength(1);
	});

	it('follows merged_into so an alias credit links to the live artist', () => {
		const keep = upsertArtistRaw(sqlite, 'Ben Böhmer');
		const drop = upsertArtistRaw(sqlite, 'Ben Boehmer');
		sqlite.prepare(`UPDATE artist SET merged_into = ? WHERE id = ?`).run(keep.id, drop.id);
		insertTrack('t1', [{ name: 'Ben Boehmer' }]);
		syncTrackArtistsById(db, ['t1']);
		expect(links('t1')).toEqual([{ artist_id: keep.id, role: null, position: 0 }]);
		expect(lookupArtistRaw(sqlite, 'ben boehmer')?.id).toBe(keep.id);
	});
});

describe('normalizeIncomingArtists', () => {
	it('splits packed credits unless the library knows the packed name', () => {
		expect(normalizeIncomingArtists(db, [{ name: 'A, B' }])).toEqual([{ name: 'A' }, { name: 'B' }]);
		upsertArtistRaw(sqlite, 'Tyler, The Creator');
		expect(normalizeIncomingArtists(db, [{ name: 'Tyler, The Creator' }])).toEqual([{ name: 'Tyler, The Creator' }]);
		expect(artistProtect(db)(searchFold('Tyler, The Creator'))).toBe(true);
	});

	it('substitutes the curated spelling and the merge target, then dedupes', () => {
		const keep = upsertArtistRaw(sqlite, 'Ben Böhmer');
		sqlite.prepare(`UPDATE artist SET name_curated_at = ? WHERE id = ?`).run(Date.now(), keep.id);
		const drop = upsertArtistRaw(sqlite, 'Ben Boehmer');
		sqlite.prepare(`UPDATE artist SET merged_into = ? WHERE id = ?`).run(keep.id, drop.id);
		expect(normalizeIncomingArtists(db, [{ name: 'ben bohmer' }, { name: 'Ben Boehmer', role: 'featured' }, { name: 'X' }]))
			.toEqual([{ name: 'Ben Böhmer' }, { name: 'X' }]);
	});

	it('leaves an uncurated known spelling alone', () => {
		upsertArtistRaw(sqlite, 'KIDSØ');
		expect(normalizeIncomingArtists(db, [{ name: 'Kidsø' }])).toEqual([{ name: 'Kidsø' }]);
	});

	it('reads the remixer off the title: tags a listed credit, adds a known one, never touches the title', () => {
		expect(normalizeIncomingArtists(db, [{ name: 'Lane 8' }, { name: 'Massano' }], { title: 'Drown (Massano Remix)' }))
			.toEqual([{ name: 'Lane 8' }, { name: 'Massano', role: 'remixer' }]);
		upsertArtistRaw(sqlite, 'Tinlicker');
		expect(normalizeIncomingArtists(db, [{ name: 'alt-J' }], { title: 'Breezeblocks (Tinlicker Extended Mix)' }))
			.toEqual([{ name: 'alt-J' }, { name: 'Tinlicker', role: 'remixer' }]);
		// Weak word + unknown name → nothing invented.
		expect(normalizeIncomingArtists(db, [{ name: 'A' }], { title: 'Radian - Cercle Version' })).toEqual([{ name: 'A' }]);
	});

	it('split:false keeps a provider entity whole even when unknown', () => {
		expect(normalizeIncomingArtists(db, [{ name: 'Crosby, Stills & Nash' }], { split: false })).toEqual([{ name: 'Crosby, Stills & Nash' }]);
		expect(normalizeIncomingArtists(db, [{ name: 'Crosby, Stills & Nash' }])).toEqual([{ name: 'Crosby' }, { name: 'Stills & Nash' }]);
	});

	it('does not mint artist rows', () => {
		normalizeIncomingArtists(db, [{ name: 'Nobody Yet' }]);
		expect(artists()).toEqual([]);
	});
});
