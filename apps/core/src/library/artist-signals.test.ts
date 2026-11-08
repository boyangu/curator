// The library side of the feed's artist lenses, on a generated DB: who the
// library holds (own local files only, live tracks, alias spellings and
// Spotify ids keyed), rekordbox set plays per artist, and the lens setting
// round trip through CoreService (stored, stated to the op log at v6, and
// applied to the feed page).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createCoreService, type CoreService } from '../service.js';
import { syncTrackArtistsByIdRaw } from './artists.js';
import { libraryArtistKeys, setPlayCounts } from './artist-signals.js';
import { tmpDir, type TmpDir } from '../test-support/tmp.js';

let tmp: TmpDir;
let dbPath: string;
let sqlite: Database.Database;

function seedTrack(id: string, artists: string[], extra: Record<string, unknown> = {}): void {
	const cols: Record<string, unknown> = { id, title: `T ${id}`, artists: JSON.stringify(artists.map((name) => ({ name }))), state: 'unsorted', duration: 300, membership: 'local', ...extra };
	const keys = Object.keys(cols);
	sqlite.prepare(`INSERT INTO track (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k]));
	syncTrackArtistsByIdRaw(sqlite, [id]);
}
const artistId = (nameAscii: string): string => (sqlite.prepare(`SELECT id FROM artist WHERE name_ascii = ?`).get(nameAscii) as { id: string }).id;

beforeEach(() => {
	tmp = tmpDir('curator-artist-signals-');
	dbPath = join(tmp.path, 'curator.db');
	migrate(dbPath);
	sqlite = tmp.track(new Database(dbPath));
});
afterEach(async () => {
	await tmp.cleanup();
});

describe('library artist signals', () => {
	it('holds artists of live local tracks only, with alias spellings and Spotify ids', () => {
		seedTrack('a', ['Ben Böhmer', 'Nils Hoffmann']);
		seedTrack('b', ['Streaming Only'], { membership: 'streaming' });
		seedTrack('c', ['Deleted Guy'], { deleted_at: 1 });
		const ben = artistId('benbohmer');
		sqlite.prepare(`INSERT INTO artist (id, name, name_ascii, merged_into) VALUES ('alias1', 'Ben Bohmer DJ', 'benbohmerdj', ?)`).run(ben);
		sqlite.prepare(`INSERT INTO artist_link (artist_id, source, source_id) VALUES (?, 'spotify', 'sp-ben')`).run(ben);
		const library = libraryArtistKeys(sqlite);
		expect([...library].sort()).toEqual(['id:sp-ben', 'name:benbohmer', 'name:benbohmerdj', 'name:nilshoffmann']);
	});

	it('counts plays in rekordbox sets per artist, not prep sessions', () => {
		seedTrack('a', ['Ben Böhmer']);
		seedTrack('b', ['Adam Port']);
		sqlite.prepare(`INSERT INTO play_session (id, origin, kind, started_at) VALUES ('s1', 'rekordbox', 'set', 1), ('s2', 'rekordbox', 'set', 2), ('p1', 'rekordbox', 'prep', 3)`).run();
		const play = sqlite.prepare(`INSERT INTO play_event (id, session_id, track_id, source) VALUES (?, ?, ?, 'rekordbox')`);
		play.run('e1', 's1', 'a');
		play.run('e2', 's2', 'a');
		play.run('e3', 'p1', 'b');
		play.run('e4', 's1', null);
		const setPlays = setPlayCounts(sqlite);
		expect(Object.fromEntries(setPlays)).toEqual({ 'name:benbohmer': 2 });
	});
});

describe('CoreService feed lenses', () => {
	let svc: CoreService;
	beforeEach(() => {
		svc = tmp.track(createCoreService(dbPath, { peaksDir: join(tmp.path, 'peaks') }));
	});

	it('stores lenses, one per kind, states them to the op log at v6, and notifies', async () => {
		const seen: number[] = [];
		const off = svc.subscribeFeedLenses((l) => seen.push(l.length));
		await svc.addFeedLens({ rule: { kind: 'library-artist', has: false }, label: 'artists I don’t have', by: 'assistant' });
		const two = await svc.addFeedLens({ rule: { kind: 'genre', value: 'House' }, by: 'user' });
		const replaced = await svc.addFeedLens({ rule: { kind: 'genre', value: 'Techno' }, by: 'user' });
		expect(replaced.map((l) => [l.rule.kind, l.label])).toEqual([['library-artist', 'artists I don’t have'], ['genre', 'Techno']]);
		await expect(svc.addFeedLens({ rule: { kind: 'genre', value: '' }, by: 'user' })).rejects.toThrow('invalid lens rule');

		const stored = JSON.parse((sqlite.prepare(`SELECT value FROM app_setting WHERE key = 'feed.lenses'`).get() as { value: string }).value);
		expect(stored).toHaveLength(2);
		const ops = sqlite.prepare(`SELECT schema_version FROM sync_outbox WHERE entity = 'setting' AND entity_id = 'feed.lenses'`).all() as { schema_version: number }[];
		expect(ops.length).toBeGreaterThan(0);
		expect(ops.every((o) => o.schema_version === 6)).toBe(true);

		const after = await svc.removeFeedLens(two[0]!.id);
		expect(after.map((l) => l.rule.kind)).toEqual(['genre']);
		expect(await svc.getFeedLenses()).toEqual(after);
		expect(seen).toEqual([1, 2, 2, 1]);
		off();
	});
});
