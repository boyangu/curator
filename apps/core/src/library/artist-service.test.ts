// CoreService artist surface against the real service on a generated DB:
// list/get/resolve, rename (plain, fold-changing alias, collision → merge),
// merge, the artistIds filter pushdown, the indexed Artist sort, and the
// override paths keeping the junction + artists_ascii in step.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createCoreService, type CoreService } from '../service.js';
import { syncTrackArtistsByIdRaw } from './artists.js';
import { tmpDir, type TmpDir } from '../test-support/tmp.js';

let tmp: TmpDir;
let dir: string;
let dbPath: string;
let sqlite: Database.Database;
let svc: CoreService;

function seedTrack(id: string, artists: unknown[], extra: Record<string, unknown> = {}): void {
	const cols: Record<string, unknown> = { id, title: `Title ${id}`, artists: JSON.stringify(artists), state: 'unsorted', duration: 300, ...extra };
	const keys = Object.keys(cols);
	sqlite.prepare(`INSERT INTO track (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k]));
	syncTrackArtistsByIdRaw(sqlite, [id]);
}
const artistsOf = (id: string): unknown => JSON.parse((sqlite.prepare(`SELECT artists FROM track WHERE id = ?`).get(id) as { artists: string }).artists);
const asciiOf = (id: string): string => (sqlite.prepare(`SELECT artists_ascii FROM track WHERE id = ?`).get(id) as { artists_ascii: string }).artists_ascii;

beforeEach(() => {
	tmp = tmpDir('curator-artist-svc-');
	dir = tmp.path;
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	sqlite = tmp.track(new Database(dbPath));
	svc = tmp.track(createCoreService(dbPath, { peaksDir: join(dir, 'peaks') }));
});
afterEach(async () => {
	await tmp.cleanup();
});

describe('listArtists / getArtist / resolveArtistByName', () => {
	it('lists live artists with live-track counts, count-desc then name', async () => {
		seedTrack('a', [{ name: 'Ben Böhmer' }, { name: 'Nils Hoffmann' }]);
		seedTrack('b', [{ name: 'ben bohmer' }]);
		seedTrack('c', [{ name: 'Ghost' }], { deleted_at: 1 });
		seedTrack('d', [{ name: 'Adam Port' }]);
		const list = await svc.listArtists();
		expect(list.map((a) => [a.name, a.trackCount])).toEqual([['Ben Böhmer', 2], ['Adam Port', 1], ['Nils Hoffmann', 1]]);
		expect((await svc.listArtists({ search: 'bohm' })).map((a) => a.name)).toEqual(['Ben Böhmer']);
		expect((await svc.listArtists({ sort: 'name' })).map((a) => a.name)).toEqual(['Adam Port', 'Ben Böhmer', 'Nils Hoffmann']);
		const ben = list[0]!;
		expect(await svc.getArtist(ben.id)).toMatchObject({ name: 'Ben Böhmer', trackCount: 2, mergedInto: null });
		expect((await svc.resolveArtistByName('BEN BOHMER'))?.id).toBe(ben.id);
		expect(await svc.resolveArtistByName('nobody')).toBeNull();
	});
});

describe('renameArtist', () => {
	it('rewrites every credit, curates the spelling, and re-mirrors search', async () => {
		seedTrack('a', [{ name: 'ben bohmer' }, { name: 'X' }]);
		seedTrack('b', [{ name: 'Ben Bohmer', role: 'featured' }]);
		const ben = (await svc.resolveArtistByName('ben bohmer'))!;
		const res = await svc.renameArtist(ben.id, 'Ben Böhmer');
		expect(res.tracksRewritten).toBe(2);
		expect(res.artist).toMatchObject({ id: ben.id, name: 'Ben Böhmer', trackCount: 2 });
		expect(res.artist.nameCuratedAt).not.toBeNull();
		expect(artistsOf('a')).toEqual([{ name: 'Ben Böhmer' }, { name: 'X' }]);
		expect(artistsOf('b')).toEqual([{ name: 'Ben Böhmer', role: 'featured' }]);
		expect(asciiOf('a')).toBe('ben bohmer | x');
		// Sticky: a later sync spelling it the old way lands on the curated name.
		const upd = await svc.setTrackOverrides('a', { artists: [{ name: 'BEN BOHMER' }] });
		expect(upd?.artists).toEqual([{ name: 'Ben Böhmer' }]);
	});

	it('leaves an alias under the old fold when the fold changes', async () => {
		seedTrack('a', [{ name: 'Boehmer' }]);
		const old = (await svc.resolveArtistByName('Boehmer'))!;
		await svc.renameArtist(old.id, 'Böhmer');
		expect((await svc.resolveArtistByName('boehmer'))?.id).toBe(old.id);
		expect((await svc.listArtists()).map((a) => a.name)).toEqual(['Böhmer']);
		seedTrack('b', [{ name: 'Boehmer' }]);
		expect((await svc.getArtist(old.id))?.trackCount).toBe(2);
	});

	it('renaming back to an earlier spelling reclaims its own alias', async () => {
		seedTrack('a', [{ name: 'Boehmer' }]);
		const id = (await svc.resolveArtistByName('Boehmer'))!.id;
		await svc.renameArtist(id, 'Böhmer');
		const back = await svc.renameArtist(id, 'Boehmer');
		expect(back.artist).toMatchObject({ id, name: 'Boehmer', trackCount: 1 });
		expect(artistsOf('a')).toEqual([{ name: 'Boehmer' }]);
		// Old-old fold ("bohmer") now aliases back; the reclaimed fold is live.
		expect((await svc.resolveArtistByName('Böhmer'))?.id).toBe(id);
		expect((await svc.listArtists()).map((a) => a.name)).toEqual(['Boehmer']);
	});

	it('renaming onto an existing artist merges into it', async () => {
		seedTrack('a', [{ name: 'Ben Bohmer' }]);
		seedTrack('b', [{ name: 'Ben Böhmer' }]);
		const dup = (await svc.resolveArtistByName('Ben Bohmer'))!;
		const target = (await svc.resolveArtistByName('Ben Böhmer'))!;
		expect(dup.id).toBe(target.id); // same fold already — pick a real collision instead
		seedTrack('c', [{ name: 'Benjamin B' }]);
		const other = (await svc.resolveArtistByName('Benjamin B'))!;
		const res = await svc.renameArtist(other.id, 'Ben Böhmer');
		expect(res.artist.id).toBe(target.id);
		expect(res.artist.trackCount).toBe(3);
		expect(artistsOf('c')).toEqual([{ name: 'Ben Böhmer' }]);
		expect((await svc.listArtists()).map((a) => a.name)).toEqual(['Ben Böhmer']);
	});

	it('rejects an empty name', async () => {
		seedTrack('a', [{ name: 'A' }]);
		const a = (await svc.resolveArtistByName('A'))!;
		await expect(svc.renameArtist(a.id, '   ')).rejects.toThrow();
	});
});

describe('mergeArtists', () => {
	it('drop becomes an alias, credits rewrite to keep, duplicates collapse', async () => {
		seedTrack('a', [{ name: 'Kidsø' }]);
		seedTrack('b', [{ name: 'Kidso Music' }, { name: 'Kidsø' }]);
		seedTrack('c', [{ name: 'Kidso Music' }]);
		const keep = (await svc.resolveArtistByName('Kidsø'))!;
		const drop = (await svc.resolveArtistByName('Kidso Music'))!;
		expect(keep.id).not.toBe(drop.id);
		const res = await svc.mergeArtists(keep.id, drop.id);
		expect(res.tracksRewritten).toBe(2);
		expect(res.artist).toMatchObject({ id: keep.id, trackCount: 3 });
		expect(artistsOf('b')).toEqual([{ name: 'Kidsø' }]);
		expect(artistsOf('c')).toEqual([{ name: 'Kidsø' }]);
		expect((await svc.listArtists()).map((a) => a.name)).toEqual(['Kidsø']);
		expect((await svc.resolveArtistByName('kidso music'))?.id).toBe(keep.id);
		// Merging into itself (or an alias of itself) is a no-op.
		expect((await svc.mergeArtists(keep.id, drop.id)).tracksRewritten).toBe(0);
	});
});

describe('getArtistLinks', () => {
	it('returns provider identities, following aliases', async () => {
		seedTrack('a', [{ name: 'Pig & Dan' }]);
		const pig = (await svc.resolveArtistByName('Pig&Dan'))!;
		sqlite.prepare(`INSERT INTO artist_link (artist_id, source, source_id, url) VALUES (?, 'spotify', 'sp1', 'https://open.spotify.com/artist/sp1')`).run(pig.id);
		expect(await svc.getArtistLinks(pig.id)).toEqual([{ source: 'spotify', sourceId: 'sp1', url: 'https://open.spotify.com/artist/sp1' }]);
		expect(await svc.getArtistLinks('nope')).toEqual([]);
	});
});

describe('artist scope (per-tab counts)', () => {
	it('counts only tracks in the scope and drops artists with none; suggestions keep pairs with a side in scope', async () => {
		seedTrack('a', [{ name: 'Maz' }]); seedTrack('b', [{ name: 'Maz' }]); seedTrack('c', [{ name: 'Maz (EG)' }]); seedTrack('d', [{ name: 'Onlylocal' }]);
		sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id) VALUES ('s1', 'a', 'spotify', 'sp-a'), ('s2', 'c', 'spotify', 'sp-c'), ('s3', 'd', 'local', 'f')`).run();
		sqlite.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at) VALUES ('b', 'rb-b', 1, 1, 1)`).run();
		expect((await svc.listArtists({ scope: { sources: ['spotify'] } })).map((x) => [x.name, x.trackCount])).toEqual([['Maz', 1], ['Maz (EG)', 1]]);
		expect((await svc.listArtists({ scope: { sources: ['rekordbox'] } })).map((x) => [x.name, x.trackCount])).toEqual([['Maz', 1]]);
		expect((await svc.listArtists({ scope: { sources: ['local'] } })).map((x) => x.name)).toEqual(['Onlylocal']);
		// The Rekordbox tab's scope is the union: the collection plus local files not in rekordbox.
		expect((await svc.listArtists({ scope: { sources: ['rekordbox', 'local'] } })).map((x) => [x.name, x.trackCount])).toEqual([['Maz', 1], ['Onlylocal', 1]]);
		expect((await svc.listArtists()).map((x) => [x.name, x.trackCount])).toEqual([['Maz', 2], ['Maz (EG)', 1], ['Onlylocal', 1]]);
		// Rekordbox collection: "Maz (EG)" has no rekordbox track but the pair stays (Maz does), with its side at 0.
		const rb = await svc.listArtistMergeSuggestions({ sources: ['rekordbox'] });
		expect(rb.map((x) => [x.a.name, x.a.trackCount, x.b.name, x.b.trackCount])).toEqual([['Maz', 1, 'Maz (EG)', 0]]);
		expect(await svc.listArtistMergeSuggestions({ sources: ['local'] })).toEqual([]);
	});
});

describe('listArtistMergeSuggestions', () => {
	it('pairs bare names with tagged spellings; dismissals persist; merges drop the pair', async () => {
		seedTrack('a', [{ name: 'Maz' }]); seedTrack('a2', [{ name: 'Maz' }]); seedTrack('b', [{ name: 'Maz (EG)' }]);
		seedTrack('c', [{ name: 'Kadosh (IL)' }]); seedTrack('d', [{ name: 'Kadosh' }]); seedTrack('e', [{ name: 'Solo' }]);
		seedTrack('f', [{ name: 'Newman (I Love)' }]); seedTrack('g', [{ name: 'Newman' }]);
		const s = await svc.listArtistMergeSuggestions();
		expect(s.map((x) => [x.a.name, x.b.name, x.suggestedKeepId === x.a.id ? x.a.name : x.b.name])).toEqual([
			['Maz', 'Maz (EG)', 'Maz'],          // more-credited spelling survives
			['Kadosh', 'Kadosh (IL)', 'Kadosh (IL)'], // tie → the tagged one
		]);
		await svc.dismissArtistMergeSuggestion(s[1]!.b.id, s[1]!.a.id);
		const again = tmp.track(createCoreService(dbPath, { peaksDir: join(dir, 'peaks') }));
		expect((await again.listArtistMergeSuggestions()).map((x) => x.a.name)).toEqual(['Maz']);
		await svc.mergeArtists(s[0]!.a.id, s[0]!.b.id);
		expect(await svc.listArtistMergeSuggestions()).toEqual([]);
		expect((await svc.resolveArtistByName('Maz (EG)'))?.name).toBe('Maz');
	});
});

describe('artist scope + sort on getTracksPage', () => {
	it('artistIds filter is an exact pushdown; artist sort follows the effective primary artist', async () => {
		seedTrack('a', [{ name: 'Zed' }, { name: 'Alpha' }]);
		seedTrack('b', [{ name: 'Alpha' }]);
		seedTrack('c', [{ name: 'Mid' }]);
		const alpha = (await svc.resolveArtistByName('Alpha'))!;
		const page = await svc.getTracksPage({ artistIds: [alpha.id] }, { column: 'title', dir: 'asc' });
		expect(page.total).toBe(2);
		expect(page.items.map((t) => t.id)).toEqual(['a', 'b']);
		expect(page.items[0]!.artistIds).toHaveLength(2);
		expect(page.items[0]!.artistIds![1]).toBe(alpha.id);
		const sorted = await svc.getTracksPage(undefined, { column: 'artist', dir: 'asc' });
		expect(sorted.items.map((t) => t.id)).toEqual(['b', 'c', 'a']);
		// Override changes the effective primary → sort and junction follow.
		await svc.setTrackOverrides('a', { artists: [{ name: 'Aardvark' }] });
		const resorted = await svc.getTracksPage(undefined, { column: 'artist', dir: 'asc' });
		expect(resorted.items.map((t) => t.id)).toEqual(['a', 'b', 'c']);
		expect((await svc.getTracksPage({ artistIds: [alpha.id] })).total).toBe(1);
		expect(asciiOf('a')).toBe('aardvark');
		// Clearing the override falls back to canonical everywhere.
		await svc.clearTrackFields('a', ['artists']);
		expect((await svc.getTracksPage({ artistIds: [alpha.id] })).total).toBe(2);
		expect(asciiOf('a')).toBe('zed | alpha');
	});
});
