// The one-shot artist backfill: packed credits split, roles dropped, the
// protect set keeps known duo/alias names whole, the tables populate, the
// gate makes a second migrate() a no-op, and a backup lands beside the DB.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrate.js';

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-artist-backfill-'));
	path = join(dir, 'curator.db');
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function seedLegacy(): void {
	// A pre-backfill library: first migrate() creates the schema and marks
	// the (empty) backfill done; roll the gate back so the seeded rows go
	// through the real split pass on the next migrate().
	migrate(path);
	const db = new Database(path);
	const ins = db.prepare(`INSERT INTO track (id, title, artists, overrides, state) VALUES (?, ?, ?, ?, 'unsorted')`);
	ins.run('packed', 'P', JSON.stringify([{ name: 'Rampa, Adam Port, &ME', role: 'main' }]), null);
	ins.run('semi', 'S', JSON.stringify([{ name: 'Re:Axis; Blazej' }]), null);
	ins.run('feat', 'F', JSON.stringify([{ name: 'Kanzyani feat Iury Lech' }]), null);
	ins.run('duo', 'D', JSON.stringify([{ name: 'Yohan & David, Cafe De Anatolia' }]), null);
	// Positional roles from the old Spotify writer — must be dropped.
	ins.run('spot', 'Sp', JSON.stringify([{ name: 'Nils', role: 'main' }, { name: 'Ben', role: 'featured' }]), null);
	// A packed name a provider ENTITY vouches for (Spotify artist object with
	// an id) stays whole; a packed name that only sits in artists_local or in
	// a multi-element array beside a clean one does not.
	ins.run('alias', 'A', JSON.stringify([{ name: 'Yusuf / Cat Stevens' }]), null);
	db.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, artists_local, payload) VALUES ('sl1', 'alias', 'spotify', 'sp1', ?, ?)`)
		.run(JSON.stringify([{ name: 'Yusuf / Cat Stevens' }]), JSON.stringify({ artists: [{ id: 'sp-yusuf', name: 'Yusuf / Cat Stevens' }] }));
	ins.run('frames', 'Fr', JSON.stringify([{ name: 'Natascha Polké, Night Talk' }, { name: 'Night Talk' }]), null);
	db.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, artists_local) VALUES ('sl4', 'frames', 'beatport', 'bp4', ?)`)
		.run(JSON.stringify([{ name: 'CIOZ' }, { name: 'Cioz, Nairobi D' }]));
	ins.run('bp', 'Bp', JSON.stringify([{ name: 'Cioz, Nairobi D' }]), null);
	// An override list carrying a packed credit.
	ins.run('ov', 'O', JSON.stringify([{ name: 'Canon' }]), JSON.stringify({ artists: [{ name: 'X, Y' }], title: 'T' }));
	// Remixers: Spotify-style listed credit gets the role; a known library
	// artist named only in the title is added; a weak-word unknown is not.
	ins.run('rmx1', 'Drown (Massano Remix)', JSON.stringify([{ name: 'Lane 8' }, { name: 'Massano' }]), null);
	ins.run('rmx2', 'Breezeblocks - Nils Extended Mix', JSON.stringify([{ name: 'alt-J' }]), null);
	ins.run('rmx3', 'Radian - Cercle Version', JSON.stringify([{ name: 'Someone' }]), null);
	// Spelling variants collapse to one artist named by the most-credited spelling.
	ins.run('sp1', 'S1', JSON.stringify([{ name: 'Pig&Dan' }]), null);
	ins.run('sp2', 'S2', JSON.stringify([{ name: 'Pig & Dan' }]), null);
	ins.run('sp3', 'S3', JSON.stringify([{ name: 'Pig & Dan' }]), null);
	db.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, payload) VALUES ('sl2', 'sp2', 'spotify', 'sp2', ?)`)
		.run(JSON.stringify({ artists: [{ id: 'spid-pig', name: 'Pig & Dan', external_urls: { spotify: 'https://open.spotify.com/artist/spid-pig' } }] }));
	db.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, payload) VALUES ('sl3', 'sp3', 'tidal', 'td3', ?)`)
		.run(JSON.stringify({ artists: [{ id: 12345, name: 'Pig&Dan', main: true }] }));
	ins.run('deleted', 'Del', JSON.stringify([{ name: 'Ghost' }]), null);
	db.prepare(`UPDATE track SET deleted_at = 1 WHERE id = 'deleted'`).run();
	db.prepare(`DELETE FROM app_setting WHERE key = 'artist_backfill_version'`).run();
	db.prepare(`DELETE FROM track_artist`).run();
	db.prepare(`DELETE FROM artist`).run();
	db.close();
}

const artistsOf = (db: Database.Database, id: string): unknown =>
	JSON.parse((db.prepare(`SELECT artists FROM track WHERE id = ?`).get(id) as { artists: string }).artists);

describe('artist backfill', () => {
	it('splits packed credits, drops fabricated roles, keeps protected names, populates the tables', () => {
		seedLegacy();
		migrate(path);
		const db = new Database(path);
		expect(artistsOf(db, 'packed')).toEqual([{ name: 'Rampa' }, { name: 'Adam Port' }, { name: '&ME' }]);
		expect(artistsOf(db, 'semi')).toEqual([{ name: 'Re:Axis' }, { name: 'Blazej' }]);
		expect(artistsOf(db, 'feat')).toEqual([{ name: 'Kanzyani' }, { name: 'Iury Lech', role: 'featured' }]);
		expect(artistsOf(db, 'duo')).toEqual([{ name: 'Yohan & David' }, { name: 'Cafe De Anatolia' }]);
		expect(artistsOf(db, 'spot')).toEqual([{ name: 'Nils' }, { name: 'Ben' }]);
		expect(artistsOf(db, 'alias')).toEqual([{ name: 'Yusuf / Cat Stevens' }]);
		expect(artistsOf(db, 'frames')).toEqual([{ name: 'Natascha Polké' }, { name: 'Night Talk' }]);
		expect(artistsOf(db, 'bp')).toEqual([{ name: 'Cioz' }, { name: 'Nairobi D' }]);
		expect(artistsOf(db, 'rmx1')).toEqual([{ name: 'Lane 8' }, { name: 'Massano', role: 'remixer' }]);
		expect(artistsOf(db, 'rmx2')).toEqual([{ name: 'alt-J' }, { name: 'Nils', role: 'remixer' }]);
		expect(artistsOf(db, 'rmx3')).toEqual([{ name: 'Someone' }]);
		expect((db.prepare(`SELECT title FROM track WHERE id = 'rmx1'`).get() as { title: string }).title).toBe('Drown (Massano Remix)');
		expect(db.prepare(`SELECT role FROM track_artist ta JOIN artist a ON a.id = ta.artist_id WHERE ta.track_id = 'rmx1' AND a.name = 'Massano'`).get()).toEqual({ role: 'remixer' });
		const ov = JSON.parse((db.prepare(`SELECT overrides FROM track WHERE id = 'ov'`).get() as { overrides: string }).overrides);
		expect(ov).toEqual({ artists: [{ name: 'X' }, { name: 'Y' }], title: 'T' });
		// artists_ascii re-mirrored for rewritten rows.
		expect((db.prepare(`SELECT artists_ascii FROM track WHERE id = 'packed'`).get() as { artists_ascii: string }).artists_ascii)
			.toBe('rampa | adam port | &me');
		// Junction rows for every live track with artists; override list wins.
		const linked = (db.prepare(`SELECT track_id, count(*) AS n FROM track_artist GROUP BY track_id ORDER BY track_id`).all() as Array<{ track_id: string; n: number }>);
		expect(Object.fromEntries(linked.map((r) => [r.track_id, r.n]))).toEqual({
			alias: 1, bp: 2, deleted: 1, duo: 2, feat: 2, frames: 2, ov: 2, packed: 3, rmx1: 2, rmx2: 2, rmx3: 1, semi: 2, sp1: 1, sp2: 1, sp3: 1, spot: 2,
		});
		const names = (db.prepare(`SELECT name FROM artist ORDER BY name_ascii`).all() as Array<{ name: string }>).map((r) => r.name);
		expect(names).toContain('Yohan & David');
		expect(names).toContain('Yusuf / Cat Stevens');
		expect(names).not.toContain('Canon');
		expect((db.prepare(`SELECT artist_sort FROM track WHERE id = 'ov'`).get() as { artist_sort: string }).artist_sort).toBe('x');
		const pig = db.prepare(`SELECT id, name, name_ascii FROM artist WHERE name_ascii = 'pig&dan'`).all() as Array<{ id: string; name: string }>;
		expect(pig).toHaveLength(1);
		expect(pig[0]!.name).toBe('Pig & Dan');
		expect(db.prepare(`SELECT source, source_id, url FROM artist_link WHERE artist_id = ? ORDER BY source`).all(pig[0]!.id)).toEqual([
			{ source: 'spotify', source_id: 'spid-pig', url: 'https://open.spotify.com/artist/spid-pig' },
			{ source: 'tidal', source_id: '12345', url: 'https://tidal.com/browse/artist/12345' },
		]);
		expect((db.prepare(`SELECT value FROM app_setting WHERE key = 'artist_backfill_version'`).get() as { value: string }).value).toBe('1');
		db.close();
		expect(readdirSync(dir).some((f) => f.includes('.pre-artist-backfill-') && f.endsWith('.bak'))).toBe(true);
	});

	it('is a no-op on the second run and repairs rows written past the seam', () => {
		seedLegacy();
		migrate(path);
		let db = new Database(path);
		const before = db.prepare(`SELECT count(*) AS n FROM artist`).get() as { n: number };
		// A raw insert that bypasses the seam — the per-boot repair heals it.
		db.prepare(`INSERT INTO track (id, title, artists, state) VALUES ('raw', 'R', ?, 'unsorted')`).run(JSON.stringify([{ name: 'Late Comer' }]));
		db.close();
		const backups = readdirSync(dir).filter((f) => f.endsWith('.bak')).length;
		migrate(path);
		db = new Database(path);
		expect((db.prepare(`SELECT count(*) AS n FROM artist`).get() as { n: number }).n).toBe(before.n + 1);
		expect(db.prepare(`SELECT count(*) AS n FROM track_artist WHERE track_id = 'raw'`).get()).toEqual({ n: 1 });
		expect(artistsOf(db, 'packed')).toEqual([{ name: 'Rampa' }, { name: 'Adam Port' }, { name: '&ME' }]);
		db.close();
		// Gate held: no second backup.
		expect(readdirSync(dir).filter((f) => f.endsWith('.bak')).length).toBe(backups);
	});
});
