// The one ladder both apps' pages use (identify.ts): the artist's own
// Spotify id names the catalogue object whatever name the catalogue gives
// it; without one, a recording of its own tracks and the credit there.
//
// Generated DBs only (CLAUDE.md): mkdtempSync + migrate(), synthetic rows.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { CatalogBrowseResult, CatalogObjectSummary, CatalogRef } from '@curator/protocol';
import { migrate } from '../db/migrate.js';
import { syncTrackArtistsByIdRaw } from '../library/artists.js';
import { hintsOf, identifyLocal, identifyRemote, settleIds, type IdentifyCatalog } from './identify.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-identify-'));
	const path = join(dir, 'curator.db');
	migrate(path);
	db = new Database(path);
});
afterEach(() => {
	db.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

const COMPOUND = 'obj-compound';
const summary = (id: string, name: string, kind: CatalogObjectSummary['kind'] = 'artist', handles: CatalogObjectSummary['handles'] = []) => ({ id, kind, name, handles }) as CatalogObjectSummary;

// A track of the library, credited to `artist`; returns the artist's id.
function track(id: string, artist: string): string {
	db.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration) VALUES (?, ?, 'Move', ?, 'unsorted', 300)`).run(id, `rec-${id}`, JSON.stringify([{ name: artist }]));
	syncTrackArtistsByIdRaw(db, [id]);
	return db.prepare(`SELECT artist_id FROM track_artist WHERE track_id = ?`).pluck().get(id) as string;
}

// The catalogue as the ladder sees it: Spotify ids to objects, objects' credits.
function catalogue(objects: Record<string, CatalogObjectSummary>, credits: Record<string, CatalogObjectSummary[]> = {}) {
	const asked: CatalogRef[][] = [];
	const client: IdentifyCatalog = {
		async resolve(refs) {
			asked.push(refs);
			return refs.map((r) => objects[`${r.provider}:${r.kind}:${r.providerId}`] ?? null);
		},
		async browse(id) {
			return { object: summary(id, id), artists: credits[id] ?? [] } as unknown as CatalogBrowseResult;
		},
		async find() {
			return [];
		},
	};
	return { client, asked };
}

describe('identify', () => {
	it("goes by the artist's own Spotify id, whatever name the catalogue gives the object", async () => {
		const artist = track('t1', 'MODBIT');
		db.prepare(`INSERT INTO artist_link (artist_id, source, source_id) VALUES (?, 'spotify', 'spMODBIT')`).run(artist);
		const ids = identifyLocal(db, { kind: 'artist', name: 'MODBIT', libraryId: artist });
		expect(ids.spotifyId).toBe('spMODBIT');
		expect(hintsOf(ids)).toEqual([{ provider: 'spotify', kind: 'artist', providerId: 'spMODBIT' }]);
		const { client } = catalogue({ 'spotify:artist:spMODBIT': summary(COMPOUND, 'MODBIT, Pay May & Sokko') });
		expect(await identifyRemote(db, client, ids, {})).toEqual({ catalogId: COMPOUND });
	});

	it("without one, reads the credit on a recording of its own tracks: the device's own link before a claimed one", async () => {
		const artist = track('t1', 'Northfold');
		db.prepare(`INSERT INTO claim_link (track_id, source, source_track_id, recording_id, rank) VALUES ('t1', 'spotify', 'spClaimed', 'rec-t1', 0)`).run();
		db.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id) VALUES ('l1', 't1', 'spotify', 'spOwn')`).run();
		const { client, asked } = catalogue(
			{ 'spotify:recording:spOwn': summary('obj-rec', 'Move', 'recording') },
			{ 'obj-rec': [summary('obj-guest', 'Guest'), summary('obj-north', 'Northfold')] },
		);
		const ids = identifyLocal(db, { kind: 'artist', name: 'Northfold', libraryId: artist });
		expect(await identifyRemote(db, client, ids, {})).toEqual({ catalogId: 'obj-north' });
		expect(asked.at(-1)!.map((r) => r.providerId)).toEqual(['spOwn']);
	});

	it('a phone row with no link of its own reads the claimed one; a credit by another name is no match', async () => {
		const artist = track('t1', 'MODBIT');
		db.prepare(`INSERT INTO claim_link (track_id, source, source_track_id, recording_id, rank) VALUES ('t1', 'spotify', 'spClaimed', 'rec-t1', 0)`).run();
		const { client, asked } = catalogue({ 'spotify:recording:spClaimed': summary('obj-rec', 'Move', 'recording') }, { 'obj-rec': [summary(COMPOUND, 'MODBIT, Pay May & Sokko')] });
		const ids = identifyLocal(db, { kind: 'artist', name: 'MODBIT', libraryId: artist });
		expect(await identifyRemote(db, client, ids, {})).toEqual({ reason: 'unknown' });
		expect(asked.at(-1)!.map((r) => r.providerId)).toEqual(['spClaimed']);
	});

	it("settles the library artist from the object's Spotify handle and remembers it for the next page", async () => {
		const artist = track('t1', 'MODBIT');
		db.prepare(`INSERT INTO artist_link (artist_id, source, source_id) VALUES (?, 'spotify', 'spMODBIT')`).run(artist);
		const b = { object: summary(COMPOUND, 'MODBIT, Pay May & Sokko', 'artist', [{ provider: 'spotify', id: 'spMODBIT', url: null }]) } as unknown as CatalogBrowseResult;
		const full = settleIds(db, { kind: 'artist', name: 'MODBIT', libraryId: null, spotifyId: null, catalogId: COMPOUND }, b, 1);
		// The library's spelling, not the catalogue's credit line.
		expect(full).toMatchObject({ libraryId: artist, name: 'MODBIT', spotifyId: 'spMODBIT', catalogId: COMPOUND });
		expect(identifyLocal(db, { kind: 'artist', name: 'MODBIT', libraryId: artist }).catalogId).toBe(COMPOUND);
	});
});
