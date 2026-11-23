import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '@curator/sync-core/db/migrate';
import { createAudienceUp, libraryArtists } from './audience-up.js';
import type { CatalogArtistRef, CatalogClient } from './service.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-audience-'));
	const p = join(dir, 'c.db');
	migrate(p);
	db = new Database(p);
	db.prepare(
		`insert into artist (id, name, name_ascii, created_at, updated_at) values
			('a1', 'Marsh', 'marsh', 1, 1), ('a2', 'Nox Vahn', 'noxvahn', 1, 1), ('a3', 'Tidal Only', 'tidalonly', 1, 1),
			('a4', 'Streamed', 'streamed', 1, 1), ('a5', 'No Links', 'nolinks', 1, 1)`,
	).run();
	db.prepare(
		`insert into artist_link (artist_id, source, source_id, url) values
			('a1', 'spotify', 'spA1', null), ('a1', 'tidal', 'tdA1', null), ('a2', 'spotify', 'spA2', null), ('a3', 'tidal', 'tdA3', null), ('a4', 'spotify', 'spA4', null)`,
	).run();
	const track = db.prepare(`insert into track (id, title, artists, membership, state, created_at, updated_at) values (?, ?, '[]', 'local', 'backlog', 1, 1)`);
	for (const t of ['t1', 't2', 't3', 't4', 't5']) track.run(t, t);
	db.prepare(
		`insert into source_link (id, track_id, source, source_track_id) values
			('s1', 't1', 'local', 'c:/m/1.flac'), ('s2', 't2', 'rekordbox', '12'), ('s3', 't3', 'local', 'c:/m/3.flac'), ('s4', 't4', 'spotify', 'spT4'), ('s5', 't5', 'local', 'c:/m/5.flac')`,
	).run();
	// a2 only remixes a file of ours; a4 is on a streaming-only row; a5 has no store id.
	db.prepare(
		`insert into track_artist (track_id, artist_id, role, position) values
			('t1', 'a1', null, 0), ('t2', 'a1', null, 0), ('t1', 'a2', 'remixer', 1), ('t3', 'a3', null, 0), ('t4', 'a4', null, 0), ('t5', 'a5', null, 0)`,
	).run();
});
afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function client(offers = true): CatalogClient & { sent: CatalogArtistRef[][] } {
	const sent: CatalogArtistRef[][] = [];
	return {
		sent,
		offersAudience: () => offers,
		enrichArtists: async (artists: CatalogArtistRef[]) => {
			sent.push(artists);
			return { artists: artists.length, registered: artists.length, queued: artists.length, objects: artists.map((a) => ({ artistId: a.artistId, objectId: `obj-${a.artistId}` })) };
		},
	} as unknown as CatalogClient & { sent: CatalogArtistRef[][] };
}

describe('library artists up', () => {
	it('sends the main credits of our own files by their store id, Spotify first', () => {
		expect(libraryArtists(db)).toEqual([
			{ artistId: 'a1', name: 'Marsh', provider: 'spotify', providerId: 'spA1' },
			{ artistId: 'a3', name: 'Tidal Only', provider: 'tidal', providerId: 'tdA3' },
		]);
	});

	it("remembers the catalogue's artist for each, and waits a month before sending again", async () => {
		const c = client();
		const up = createAudienceUp({ raw: db, client: () => c, now: () => 1_000 });
		expect(await up.sendNow()).toBe(true);
		expect(c.sent).toHaveLength(1);
		expect(db.prepare(`select entity_id, object_id, provider, provider_id from catalog_ref where entity_kind = 'artist' order by entity_id`).all()).toEqual([
			{ entity_id: 'a1', object_id: 'obj-a1', provider: 'spotify', provider_id: 'spA1' },
			{ entity_id: 'a3', object_id: 'obj-a3', provider: 'tidal', provider_id: 'tdA3' },
		]);
		expect(db.prepare(`select value from app_setting where key = 'catalog.audience_sent_at'`).get()).toEqual({ value: '1000' });
	});

	it('sends nothing to a server without the feature, or signed out, and tries again later', async () => {
		const old = client(false);
		expect(await createAudienceUp({ raw: db, client: () => old }).sendNow()).toBe(false);
		expect(await createAudienceUp({ raw: db, client: () => null }).sendNow()).toBe(false);
		expect(old.sent).toEqual([]);
		expect(db.prepare(`select 1 from app_setting where key = 'catalog.audience_sent_at'`).get()).toBeUndefined();
	});
});
