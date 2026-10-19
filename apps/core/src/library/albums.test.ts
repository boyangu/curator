// The album seam against a migrated temp curator.db: provider album ids,
// the title + album-artist key, Various Artists detection (provider id and
// local folder), the title guard on provider ids, cross-source merging,
// overrides, the boot backfill (order + idempotence) and repair, the
// albumIds filter and the header summaries.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { migrate } from '../db/migrate.js';
import { createCoreService, type CoreService } from '../service.js';
import { syncTrackArtistsByIdRaw } from './artists.js';
import { syncTrackAlbumsRaw } from './albums.js';

let dir: string;
let dbPath: string;
let sqlite: Database.Database;

interface SeedOpts {
	album?: string | null;
	artists?: Array<{ name: string; role?: string }>;
	overrides?: Record<string, unknown> | null;
	deleted?: boolean;
	label?: string | null;
	genre?: string | null;
}

function seedTrack(id: string, o: SeedOpts = {}): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, album_title, overrides, state, duration, label, genre, deleted_at)
		VALUES (?, ?, ?, ?, ?, 'unsorted', 300, ?, ?, ?)`)
		.run(id, `Title ${id}`, JSON.stringify(o.artists ?? [{ name: 'Mira Kessel' }]), o.album === undefined ? 'Night Cartography' : o.album,
			o.overrides ? JSON.stringify(o.overrides) : null, o.label ?? null, o.genre ?? null, o.deleted ? Date.now() : null);
	syncTrackArtistsByIdRaw(sqlite, [id]);
}

function link(trackId: string, source: 'spotify' | 'tidal' | 'local', payload: unknown, filePath?: string): void {
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, payload, file_path) VALUES (?, ?, ?, ?, ?, ?)`)
		.run(randomUUID(), trackId, source, filePath ?? randomUUID(), payload == null ? null : JSON.stringify(payload), filePath ?? null);
}

const spotify = (albumId: string, name: string, extra: Record<string, unknown> = {}, track: Record<string, unknown> = {}): unknown =>
	({ id: randomUUID(), name: 't', album: { id: albumId, name, release_date: '2024-03-08', images: [{ url: `https://img/${albumId}` }], ...extra }, ...track });

const sync = (...ids: string[]): void => syncTrackAlbumsRaw(sqlite, ids);
const albumOf = (id: string): string | null => (sqlite.prepare(`SELECT album_id FROM track WHERE id = ?`).get(id) as { album_id: string | null }).album_id;
const posOf = (id: string): { track_number: number | null; disc_number: number | null } =>
	sqlite.prepare(`SELECT track_number, disc_number FROM track WHERE id = ?`).get(id) as never;
const album = (id: string): { title: string; artists_source: string; release_date: string | null; cover_url: string | null; album_type: string | null; total_tracks: number | null } =>
	sqlite.prepare(`SELECT title, artists_source, release_date, cover_url, album_type, total_tracks FROM album WHERE id = ?`).get(id) as never;
const albumArtists = (id: string): string[] =>
	(sqlite.prepare(`SELECT ar.name FROM album_artist aa JOIN artist ar ON ar.id = aa.artist_id WHERE aa.album_id = ? ORDER BY aa.position`).all(id) as Array<{ name: string }>).map((r) => r.name);
const links = (id: string): string[] =>
	(sqlite.prepare(`SELECT source || ':' || source_id AS l FROM album_link WHERE album_id = ? ORDER BY l`).all(id) as Array<{ l: string }>).map((r) => r.l);
const liveAlbums = (): number => (sqlite.prepare(`SELECT count(*) AS n FROM album WHERE merged_into IS NULL`).get() as { n: number }).n;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-albums-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	sqlite = new Database(dbPath);
});
afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* sibling handles on Windows */ }
});

describe('provider album ids', () => {
	it('groups every track a provider files under one album id, with links and positions', () => {
		seedTrack('a');
		seedTrack('b');
		link('a', 'spotify', spotify('S1', 'Night Cartography', {}, { track_number: 1, disc_number: 1 }));
		link('b', 'spotify', spotify('S1', 'Night Cartography', {}, { track_number: 3, disc_number: 1 }));
		sync('a', 'b');
		const id = albumOf('a')!;
		expect(id).toBeTruthy();
		expect(albumOf('b')).toBe(id);
		expect(links(id)).toEqual(['spotify:S1']);
		expect(album(id)).toMatchObject({ title: 'Night Cartography', artists_source: 'derived', release_date: '2024-03-08', cover_url: 'https://img/S1' });
		expect(albumArtists(id)).toEqual(['Mira Kessel']);
		expect(posOf('b')).toEqual({ track_number: 3, disc_number: 1 });
	});

	it('marks a release Various Artists when its members disagree on the main artist', () => {
		seedTrack('a', { album: 'Anjunadeep 15', artists: [{ name: 'Ben Böhmer' }] });
		seedTrack('b', { album: 'Anjunadeep 15', artists: [{ name: 'Lane 8' }] });
		link('a', 'spotify', spotify('C1', 'Anjunadeep 15'));
		link('b', 'spotify', spotify('C1', 'Anjunadeep 15'));
		sync('a', 'b');
		const id = albumOf('a')!;
		expect(albumOf('b')).toBe(id);
		expect(album(id).artists_source).toBe('various');
		expect(albumArtists(id)).toEqual([]);
	});

	it('takes provider album artists as authoritative and lets a local copy by one of them join', () => {
		seedTrack('a', { artists: [{ name: 'Mira Kessel' }] });
		link('a', 'spotify', spotify('S2', 'Night Cartography', { artists: [{ id: 'x', name: 'Mira Kessel' }, { id: 'y', name: 'Juno Halde' }], album_type: 'album', total_tracks: 9 }));
		seedTrack('b', { artists: [{ name: 'Juno Halde' }] });
		sync('a', 'b');
		const id = albumOf('a')!;
		expect(album(id)).toMatchObject({ artists_source: 'source', album_type: 'album', total_tracks: 9 });
		expect(albumArtists(id)).toEqual(['Mira Kessel', 'Juno Halde']);
		expect(albumOf('b')).toBe(id);
	});

	it('ignores a provider album whose name is not the track\'s album title', () => {
		// The ISRC match bound a compilation version's link onto the EP row.
		seedTrack('a', { album: 'Field Notes EP' });
		link('a', 'spotify', spotify('COMP', 'Ministry of Sound Annual'));
		sync('a');
		const id = albumOf('a')!;
		expect(album(id).title).toBe('Field Notes EP');
		expect(links(id)).toEqual([]);
	});

	it('merges the same release from two providers on title + artist', () => {
		seedTrack('a');
		seedTrack('b');
		link('a', 'spotify', spotify('S1', 'Night Cartography'));
		link('b', 'tidal', { id: 't', album: { id: 'T9', title: 'Night Cartography' } });
		sync('a', 'b');
		expect(albumOf('b')).toBe(albumOf('a'));
		expect(links(albumOf('a')!)).toEqual(['spotify:S1', 'tidal:T9']);
	});
});

describe('local / link-less tracks', () => {
	it('groups by title + main artist and separates other artists', () => {
		seedTrack('a', { artists: [{ name: 'Mira Kessel' }] });
		seedTrack('b', { artists: [{ name: 'mira kessel' }, { name: 'Juno Halde', role: 'remixer' }] });
		seedTrack('c', { artists: [{ name: 'Tamsin Rae' }] });
		sync('a', 'b', 'c');
		expect(albumOf('b')).toBe(albumOf('a'));
		expect(albumOf('c')).not.toBe(albumOf('a'));
		expect(liveAlbums()).toBe(2);
	});

	it('groups a local compilation by folder into one Various Artists release', () => {
		seedTrack('a', { album: 'Late Night Tales', artists: [{ name: 'Bonobo' }] });
		seedTrack('b', { album: 'Late Night Tales', artists: [{ name: 'Nils Frahm' }] });
		seedTrack('c', { album: 'Late Night Tales', artists: [{ name: 'Floating Points' }] });
		link('a', 'local', null, 'D:/Music/LNT/01.flac');
		link('b', 'local', null, 'D:/Music/LNT/02.flac');
		link('c', 'local', null, 'D:/Music/Other/03.flac');
		sync('a', 'b', 'c');
		const id = albumOf('a')!;
		expect(albumOf('b')).toBe(id);
		expect(album(id).artists_source).toBe('various');
		// A different folder is a different release.
		expect(albumOf('c')).not.toBe(id);
	});

	it('leaves tracks without an album title unassigned', () => {
		seedTrack('a', { album: null });
		seedTrack('b', { album: '  ' });
		sync('a', 'b');
		expect(albumOf('a')).toBeNull();
		expect(albumOf('b')).toBeNull();
	});
});

describe('overrides', () => {
	it('an album-title override moves the track and prunes the release it left', () => {
		seedTrack('a', { album: 'Old Title' });
		sync('a');
		const old = albumOf('a')!;
		sqlite.prepare(`UPDATE track SET overrides = ? WHERE id = 'a'`).run(JSON.stringify({ albumTitle: 'New Title' }));
		sync('a');
		const next = albumOf('a')!;
		expect(next).not.toBe(old);
		expect(album(next).title).toBe('New Title');
		expect(sqlite.prepare(`SELECT 1 FROM album WHERE id = ?`).get(old)).toBeUndefined();
	});
});

describe('boot backfill + repair', () => {
	it('derives every live track once, provider-backed releases first, and is idempotent', () => {
		// A local copy seeded BEFORE its provider-backed sibling: the order
		// pass must still let the provider's two-artist release claim it.
		seedTrack('local', { artists: [{ name: 'Juno Halde' }] });
		seedTrack('sp', { artists: [{ name: 'Mira Kessel' }] });
		link('sp', 'spotify', spotify('S2', 'Night Cartography', { artists: [{ id: 'x', name: 'Mira Kessel' }, { id: 'y', name: 'Juno Halde' }] }));
		seedTrack('gone', { deleted: true });
		sqlite.prepare(`DELETE FROM app_setting WHERE key = 'album_backfill_version'`).run();
		migrate(dbPath);
		const id = albumOf('sp')!;
		expect(albumOf('local')).toBe(id);
		expect(albumOf('gone')).toBeNull();
		const before = liveAlbums();
		migrate(dbPath);
		expect(liveAlbums()).toBe(before);
		expect(albumOf('local')).toBe(id);
	});

	it('repairs a track a write site left without an album', () => {
		seedTrack('a');
		expect(albumOf('a')).toBeNull();
		migrate(dbPath);
		expect(albumOf('a')).toBeTruthy();
	});

	it('prunes releases nothing points at', () => {
		seedTrack('a');
		sync('a');
		sqlite.prepare(`UPDATE track SET album_title = NULL, album_id = NULL WHERE id = 'a'`).run();
		migrate(dbPath);
		expect(liveAlbums()).toBe(0);
	});
});

describe('CoreService album surface', () => {
	let svc: CoreService;
	beforeEach(() => { svc = createCoreService(dbPath, { peaksDir: join(dir, 'peaks') }); });
	afterEach(() => { svc.close(); });

	it('scopes tracks by album id (aliases followed) and summarises releases', async () => {
		seedTrack('a', { label: 'Northfold', genre: 'Melodic house' });
		seedTrack('b', { label: 'Northfold', genre: 'Organic house' });
		seedTrack('c', { album: 'Slow Weather', artists: [{ name: 'Ostrava Line' }] });
		link('a', 'spotify', spotify('S1', 'Night Cartography', {}, { track_number: 2 }));
		link('b', 'spotify', spotify('S1', 'Night Cartography', {}, { track_number: 1 }));
		sync('a', 'b', 'c');
		const id = albumOf('a')!;
		const scoped = await svc.getTracks({ albumIds: [id] });
		expect(scoped.map((t) => t.id).sort()).toEqual(['a', 'b']);
		expect(scoped.find((t) => t.id === 'a')?.albumId).toBe(id);

		const [s] = await svc.getAlbumsByIds([id, 'nope']);
		expect(s).toMatchObject({
			id, title: 'Night Cartography', various: false, label: 'Northfold', trackCount: 2,
			artists: [{ name: 'Mira Kessel' }], releaseDate: '2024-03-08',
		});
		expect(s!.genres.sort()).toEqual(['Melodic house', 'Organic house']);
		// Members come back in disc / track order — b is track 1.
		expect(s!.coverTrackId).toBe('b');

		// An alias id (a merged release) still scopes + summarises.
		const alias = randomUUID();
		sqlite.prepare(`INSERT INTO album (id, title, title_key, album_key, merged_into) VALUES (?, 'x', 'x', 'x|', ?)`).run(alias, id);
		expect((await svc.getTracks({ albumIds: [alias] })).length).toBe(2);
		expect((await svc.getAlbumsByIds([alias]))[0]).toMatchObject({ id: alias, title: 'Night Cartography' });
	});
});

describe('Spotify album fill (applySpotifyAlbumRaw)', () => {
	it('writes provider artists, metadata and member positions, merging releases that turn out to be one', async () => {
		const { applySpotifyAlbumRaw } = await import('./album-enrich.js');
		seedTrack('a', { artists: [{ name: 'Mira Kessel' }] });
		seedTrack('b', { artists: [{ name: 'Juno Halde' }] });
		link('a', 'spotify', { ...(spotify('S9', 'Night Cartography') as object), id: 'trA' });
		sqlite.prepare(`UPDATE source_link SET source_track_id = 'trA' WHERE track_id = 'a'`).run();
		sync('a', 'b');
		// Two guesses: "Mira Kessel" (via the Spotify id) and "Juno Halde".
		expect(albumOf('a')).not.toBe(albumOf('b'));
		const spotifyAlbum = albumOf('a')!;
		const survivor = applySpotifyAlbumRaw(sqlite, spotifyAlbum, {
			id: 'S9', name: 'Night Cartography', album_type: 'album', release_date: '2024-03-08', total_tracks: 9,
			images: [{ url: 'https://img/full', width: 640, height: 640 }],
			artists: [{ id: 'x', name: 'Mira Kessel' }, { id: 'y', name: 'Juno Halde' }],
			label: 'Northfold', external_ids: { upc: '123' },
			tracks: { items: [{ id: 'trA', track_number: 4, disc_number: 1 }], next: null },
		});
		expect(albumOf('a')).toBe(survivor);
		expect(albumArtists(survivor)).toEqual(['Mira Kessel', 'Juno Halde']);
		expect(album(survivor)).toMatchObject({ artists_source: 'source', album_type: 'album', total_tracks: 9 });
		expect(posOf('a')).toEqual({ track_number: 4, disc_number: 1 });
		const row = sqlite.prepare(`SELECT label, upc, enriched_at FROM album WHERE id = ?`).get(survivor) as { label: string; upc: string; enriched_at: number | null };
		expect(row).toMatchObject({ label: 'Northfold', upc: '123' });
		expect(row.enriched_at).toBeTruthy();
		// The local "Juno Halde" guess joins on the next derivation.
		sync('b');
		expect(albumOf('b')).toBe(survivor);
	});
});
