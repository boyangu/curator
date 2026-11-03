// A library track as the Global Catalog knows it (seeded temp library, fake
// catalogue client; never the live database): resolved once through the
// library's provider refs, kept in catalog_ref, asked again only when stale.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogObjectSummary, CatalogRef } from '@curator/protocol';
import { migrate } from '../db/migrate.js';
import { refsForTrack, writeRefs } from './catalog-refs.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-catalog-refs-'));
	const p = join(dir, 'c.db');
	migrate(p);
	db = new Database(p);
	db.prepare(`insert into artist (id, name, name_ascii, created_at, updated_at) values ('a1', 'Glass Rivers', 'glass rivers', 1, 1), ('a2', 'Kaske', 'kaske', 1, 1)`).run();
	db.prepare(`insert into artist_link (artist_id, source, source_id, url) values ('a1', 'spotify', 'spA1', null)`).run();
	db.prepare(`insert into album (id, title, title_key, album_key, label) values ('al1', 'Low Tide EP', 'low tide ep', 'k', 'Northfold Records')`).run();
	db.prepare(`insert into album_link (album_id, source, source_id, url) values ('al1', 'spotify', 'spAL1', null)`).run();
	db.prepare(`insert into track (id, title, artists, album_id, membership, state, created_at, updated_at) values ('t1', 'Low Tide', '[]', 'al1', 'local', 'backlog', 1, 1)`).run();
	db.prepare(`insert into source_link (id, track_id, source, source_track_id) values ('s1', 't1', 'spotify', 'spT1')`).run();
	db.prepare(`insert into track_artist (track_id, artist_id, role, position) values ('t1', 'a1', null, 0), ('t1', 'a2', null, 1)`).run();
});
afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

// The catalogue: one object per ref it holds.
function fakeClient(held: Record<string, string>) {
	const asked: CatalogRef[][] = [];
	return {
		asked,
		async resolve(refs: CatalogRef[]): Promise<(CatalogObjectSummary | null)[]> {
			asked.push(refs);
			return refs.map((r) => {
				const id = held[`${r.provider}:${r.kind}:${r.providerId}`];
				return id ? { id, kind: r.kind, name: `${r.kind} ${id}`, handles: [], coverUrl: null, watchCount: 0 } : null;
			});
		},
	};
}

describe('catalog refs', () => {
	it("resolves a track's recording, release, label and artists by the library's refs, keeps them, and asks again only when stale", async () => {
		const client = fakeClient({ 'spotify:recording:spT1': 'rec-1', 'spotify:release:spAL1': 'rel-1', 'user:label:name:northfold records': 'lab-1', 'spotify:artist:spA1': 'art-1' });
		const now = 1_000_000_000_000;
		const r = await refsForTrack(db, client, 't1', now);
		expect(r).toMatchObject({
			recording: { objectId: 'rec-1', provider: 'spotify', providerId: 'spT1' },
			release: { objectId: 'rel-1', providerId: 'spAL1' },
			label: { objectId: 'lab-1', provider: 'user', providerId: 'name:northfold records' },
			// Kaske has no Spotify id: nothing to ask the catalogue by.
			artists: [{ objectId: 'art-1', artistId: 'a1' }],
		});
		expect(client.asked).toHaveLength(1);
		expect(db.prepare(`select entity_kind, entity_id, object_id from catalog_ref order by entity_kind`).all()).toEqual([
			{ entity_kind: 'album', entity_id: 'al1', object_id: 'rel-1' },
			{ entity_kind: 'artist', entity_id: 'a1', object_id: 'art-1' },
			{ entity_kind: 'label', entity_id: 'northfold records', object_id: 'lab-1' },
			{ entity_kind: 'track', entity_id: 't1', object_id: 'rec-1' },
		]);

		// Asked again within the week: from catalog_ref, no call.
		await refsForTrack(db, client, 't1', now + 86400_000);
		expect(client.asked).toHaveLength(1);

		// A week on, the release merged away: the catalogue answers with the winner.
		const merged = fakeClient({ 'spotify:recording:spT1': 'rec-1', 'spotify:release:spAL1': 'rel-WINNER', 'user:label:name:northfold records': 'lab-1', 'spotify:artist:spA1': 'art-1' });
		const later = await refsForTrack(db, merged, 't1', now + 8 * 86400_000);
		expect(later.release?.objectId).toBe('rel-WINNER');
		expect(merged.asked[0]!.length).toBe(4);
	});

	it('keeps what the import wrote and asks only for what is missing', async () => {
		writeRefs(db, [
			{ entityKind: 'album', entityId: 'al1', objectId: 'rel-imported', objectKind: 'release', provider: 'spotify', providerId: 'spAL1' },
			{ entityKind: 'label', entityId: 'northfold records', objectId: 'lab-imported', objectKind: 'label', provider: 'user', providerId: 'name:northfold records' },
		]);
		const client = fakeClient({ 'spotify:recording:spT1': 'rec-1', 'spotify:artist:spA1': 'art-1' });
		const r = await refsForTrack(db, client, 't1');
		expect(r.release?.objectId).toBe('rel-imported');
		expect(r.label?.objectId).toBe('lab-imported');
		expect(client.asked[0]!.map((x) => x.kind).sort()).toEqual(['artist', 'recording']);
	});
});
