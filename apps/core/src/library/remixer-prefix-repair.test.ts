// The one-time repair of remixer credits the artist backfill cut to a
// one-word prefix ("(Patrice Bäumel Remix)" → "Patrice"), on a generated DB.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import type { Db } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { tmpDir, type TmpDir } from '../test-support/tmp.js';
import { syncTrackArtistsByIdRaw } from './artists.js';
import { planRemixerPrefixRepair, runRemixerPrefixRepair } from './remixer-prefix-repair.js';

let tmp: TmpDir;
let dbPath: string;
let db: Db;
let sqlite: Database.Database;

beforeEach(() => {
	tmp = tmpDir('curator-remixer-repair-');
	dbPath = join(tmp.path, 'curator.db');
	migrate(dbPath);
	const c = createDb(dbPath);
	db = c.db;
	sqlite = tmp.track(c.sqlite);
});
afterEach(async () => {
	await tmp.cleanup();
});

function seed(id: string, title: string, artists: unknown[], extra: Record<string, unknown> = {}): void {
	const cols: Record<string, unknown> = { id, title, artists: JSON.stringify(artists), state: 'unsorted', duration: 300, ...extra };
	const keys = Object.keys(cols);
	sqlite.prepare(`INSERT INTO track (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k]));
	syncTrackArtistsByIdRaw(sqlite, [id]);
}
const credits = (id: string, col: 'artists' | 'overrides' = 'artists'): unknown => {
	const v = (sqlite.prepare(`SELECT ${col} AS v FROM track WHERE id = ?`).get(id) as { v: string }).v;
	const parsed = JSON.parse(v) as { artists?: unknown };
	return col === 'overrides' ? parsed.artists : parsed;
};
const artistNames = (): string[] => (sqlite.prepare(`SELECT name FROM artist ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);

// The library as the backfill left it: the full name credited as an artist on
// its own records, a singer whose one-word name is its prefix, and a remix
// credited to that prefix.
function library(): void {
	seed('own', 'Glass Rivers', [{ name: 'Marten Vohl' }]);
	seed('singer', 'Harbour Song', [{ name: 'Tessaly' }, { name: 'Marten' }]);
	seed('remix', 'Lanterns (Marten Vohl Remix)', [{ name: 'Ilka Rane' }, { name: 'Marten', role: 'remixer' }]);
}

describe('remixer prefix repair', () => {
	it('gives the remix to the full name, keeps the real one-word artist, and bumps updated_at', () => {
		library();
		const report = runRemixerPrefixRepair(db, dbPath)!;
		expect(report.fixes.map((f) => [f.from, f.to])).toEqual([['Marten', 'Marten Vohl']]);
		expect(credits('remix')).toEqual([{ name: 'Ilka Rane' }, { name: 'Marten Vohl', role: 'remixer' }]);
		expect(credits('singer')).toEqual([{ name: 'Tessaly' }, { name: 'Marten' }]);
		expect(artistNames()).toEqual(['Ilka Rane', 'Marten', 'Marten Vohl', 'Tessaly']);
		expect((sqlite.prepare(`SELECT updated_at FROM track WHERE id = 'remix'`).get() as { updated_at: number }).updated_at).toBeGreaterThan(0);
		// The junction follows the credits.
		const linked = sqlite.prepare(`SELECT a.name, ta.role FROM track_artist ta JOIN artist a ON a.id = ta.artist_id WHERE ta.track_id = 'remix' ORDER BY ta.position`).all();
		expect(linked).toEqual([{ name: 'Ilka Rane', role: null }, { name: 'Marten Vohl', role: 'remixer' }]);
		// A backup was taken before the write.
		expect(readdirSync(tmp.path).some((f) => f.startsWith('curator.db.pre-remixer-repair-'))).toBe(true);
	});

	it('drops the prefix when the full name is already credited, and prunes an artist left with no credit', () => {
		seed('own', 'Glass Rivers', [{ name: 'Marten Vohl' }]);
		seed('remix', 'Lanterns (Marten Vohl Extended Remix)', [{ name: 'Ilka Rane' }, { name: 'Marten Vohl' }, { name: 'Marten', role: 'remixer' }]);
		const report = runRemixerPrefixRepair(db, dbPath)!;
		expect(credits('remix')).toEqual([{ name: 'Ilka Rane' }, { name: 'Marten Vohl', role: 'remixer' }]);
		expect(report.prunedArtists).toEqual(['Marten']);
		expect(artistNames()).toEqual(['Ilka Rane', 'Marten Vohl']);
	});

	it('leaves a named remix alone when the longer name is only ever a remixer', () => {
		seed('own', 'Star People', [{ name: 'Ae:lun' }]);
		seed('named', 'Higher (Ae:lun Dreaming Dub Remix)', [{ name: 'Oro Vale' }, { name: 'Ae:lun', role: 'remixer' }]);
		seed('bogus', 'Higher - Ae:lun Dreaming Dub Remix', [{ name: 'Oro Vale' }, { name: 'Ae:lun Dreaming', role: 'remixer' }]);
		expect(planRemixerPrefixRepair(sqlite).report.fixes).toEqual([]);
	});

	it('leaves a duo split into its two halves, and an alias of the same artist', () => {
		seed('duo', 'Harbour Song', [{ name: 'Ferrin & Lusk' }]);
		seed('a', 'One', [{ name: 'Ferrin' }]);
		seed('b', 'Two', [{ name: 'Lusk' }]);
		seed('split', 'Lanterns (Ferrin & Lusk Remix)', [{ name: 'Ilka Rane' }, { name: 'Ferrin', role: 'remixer' }, { name: 'Lusk', role: 'remixer' }]);
		expect(planRemixerPrefixRepair(sqlite).report.fixes).toEqual([]);
	});

	it('repairs a name cut at a word that reads as a mix word', () => {
		seed('own', 'Glass Rivers', [{ name: 'Ferrin Dark' }]);
		seed('singer', 'Harbour Song', [{ name: 'Ferrin' }]);
		seed('remix', 'Lanterns - Ferrin Dark Remix', [{ name: 'Ilka Rane' }, { name: 'Ferrin', role: 'remixer' }]);
		expect(planRemixerPrefixRepair(sqlite).report.fixes.map((f) => [f.from, f.to])).toEqual([['Ferrin', 'Ferrin Dark']]);
	});

	it('fixes an edited credit list and states it as a set-override op', () => {
		library();
		sqlite.prepare(`UPDATE track SET overrides = ? WHERE id = 'remix'`).run(JSON.stringify({ artists: [{ name: 'Ilka Rane' }, { name: 'Marten', role: 'remixer' }] }));
		syncTrackArtistsByIdRaw(sqlite, ['remix']);
		const report = runRemixerPrefixRepair(db, dbPath)!;
		expect(report.fixes.map((f) => f.list).sort()).toEqual(['artists', 'overrides']);
		expect(credits('remix', 'overrides')).toEqual([{ name: 'Ilka Rane' }, { name: 'Marten Vohl', role: 'remixer' }]);
		const ops = sqlite.prepare(`SELECT kind FROM sync_outbox WHERE entity = 'library_track' AND kind = 'set-override'`).all();
		expect(ops.length).toBeGreaterThan(0);
	});

	it('runs once, skips remote rows, and writes nothing (no backup) on a clean library', () => {
		library();
		seed('remote', 'Lanterns (Marten Vohl Remix)', [{ name: 'Ilka Rane' }, { name: 'Marten', role: 'remixer' }], { remote_only: 1 });
		expect(runRemixerPrefixRepair(db, dbPath)!.tracks).toBe(1);
		expect(credits('remote')).toEqual([{ name: 'Ilka Rane' }, { name: 'Marten', role: 'remixer' }]);
		expect(runRemixerPrefixRepair(db, dbPath)).toBeNull();

		const fresh = join(tmp.path, 'fresh.db');
		migrate(fresh);
		const c = createDb(fresh);
		tmp.track(c.sqlite);
		expect(runRemixerPrefixRepair(c.db, fresh)).toEqual({ fixes: [], tracks: 0, prunedArtists: [] });
		expect(readdirSync(tmp.path).some((f) => f.startsWith('fresh.db.pre-remixer-repair-'))).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});
});
