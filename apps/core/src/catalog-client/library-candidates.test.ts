// The Manage following tabs over a seeded temp library: only the user's local
// tracks count, each list is sorted by appearance, and the follow target is
// what the cloud can track (a provider id for artists, a name for labels).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { artistCandidates, genreCandidates, labelCandidates, playlistCandidates } from './library-candidates.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-follow-cands-'));
	const p = join(dir, 'c.db');
	migrate(p);
	db = new Database(p);
});
afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

let n = 0;
function track(opts: { membership: 'local' | 'streaming' | 'followed' | null; artists?: string[]; label?: string; genre?: string; deleted?: boolean }): string {
	const id = `t${++n}`;
	db.prepare(`insert into track (id, title, artists, label, genre, membership, deleted_at, state, created_at, updated_at) values (?, ?, '[]', ?, ?, ?, ?, 'backlog', 1, 1)`).run(
		id,
		`Song ${n}`,
		opts.label ?? null,
		opts.genre ?? null,
		opts.membership,
		opts.deleted ? 1 : null,
	);
	(opts.artists ?? []).forEach((a, i) => db.prepare(`insert into track_artist (track_id, artist_id, role, position) values (?, ?, 'main', ?)`).run(id, a, i));
	return id;
}
function artist(id: string, name: string, links: { spotify?: string; tidal?: string } = {}): void {
	db.prepare(`insert into artist (id, name, name_ascii, created_at, updated_at) values (?, ?, ?, 1, 1)`).run(id, name, name.toLowerCase());
	for (const [source, sid] of Object.entries(links)) db.prepare(`insert into artist_link (artist_id, source, source_id, url) values (?, ?, ?, null)`).run(id, source, sid);
}

describe('library follow candidates', () => {
	it('ranks artists by local tracks; streaming, followed-only and deleted tracks do not count', () => {
		artist('a1', 'Northfold', { spotify: 'sp1' });
		artist('a2', 'Kaske', { tidal: 'td2' });
		artist('a3', 'Elsewhere', { spotify: 'sp3' });
		track({ membership: 'local', artists: ['a1'] });
		track({ membership: 'local', artists: ['a1', 'a2'] });
		track({ membership: 'streaming', artists: ['a1', 'a2'] });
		track({ membership: 'local', artists: ['a2'] });
		track({ membership: 'local', artists: ['a2'] });
		track({ membership: 'followed', artists: ['a3'] });
		track({ membership: null, artists: ['a3'] });
		track({ membership: 'local', artists: ['a3'], deleted: true });
		const list = artistCandidates(db);
		expect(list.map((c) => [c.name, c.count])).toEqual([
			['Kaske', 3],
			['Northfold', 2],
		]);
		expect(list[1]!.target).toEqual({ claim: { provider: 'spotify', kind: 'artist', providerId: 'sp1', name: 'Northfold', url: 'https://open.spotify.com/artist/sp1' } });
		expect(list[0]).toMatchObject({ target: null, blocked: expect.stringContaining('Tidal') });
	});

	it('folds label and genre spellings together under the most used one', () => {
		track({ membership: 'local', label: 'Northfold Records', genre: 'Melodic House & Techno' });
		track({ membership: 'local', label: 'Northfold Records', genre: 'Melodic House & Techno' });
		track({ membership: 'local', label: 'northfold records.', genre: 'Organic House' });
		track({ membership: 'streaming', label: 'Northfold Records', genre: 'Organic House' });
		track({ membership: 'local', label: 'Elsewhere Music' });
		track({ membership: 'followed', label: 'Elsewhere Music' });
		expect(labelCandidates(db).map((c) => [c.name, c.count, c.matchKey])).toEqual([
			['Northfold Records', 3, 'name:northfold records'],
			['Elsewhere Music', 1, 'name:elsewhere music'],
		]);
		expect(genreCandidates(db).map((c) => [c.name, c.count])).toEqual([
			['Melodic House & Techno', 2],
			['Organic House', 1],
		]);
		expect(labelCandidates(db)[0]!.target).toEqual({ labelName: 'Northfold Records' });
	});

	it("lists followed playlists, not the user's own, by how much of the library is in them", () => {
		const pl = (id: string, owner: string, name: string) =>
			db.prepare(`insert into playlist (id, source, source_id, name, name_ascii, owner_id, owner_name, track_count, created_at, updated_at) values (?, 'spotify', ?, ?, ?, ?, ?, 50, 1, 1)`).run(id, `sp-${id}`, name, name.toLowerCase(), owner, owner);
		pl('p1', 'me', 'My Set');
		pl('p2', 'curator-x', 'Deep Picks');
		pl('p3', 'curator-y', 'Peak Time');
		const add = (playlist: string, trackId: string, pos: number) =>
			db.prepare(`insert into playlist_track (id, playlist_id, track_id, order_key, position, source_track_id) values (?, ?, ?, ?, ?, ?)`).run(`${playlist}-${pos}`, playlist, trackId, `a${pos}`, pos, trackId);
		const mine = [track({ membership: 'local' }), track({ membership: 'local' })];
		add('p2', track({ membership: 'streaming' }), 1);
		add('p2', mine[0]!, 0);
		add('p3', mine[0]!, 0);
		add('p3', mine[1]!, 1);
		add('p3', track({ membership: 'followed' }), 2);
		const list = playlistCandidates(db, { spotify: 'me', tidal: null });
		expect(list.map((c) => [c.name, c.count])).toEqual([
			['Peak Time', 2],
			['Deep Picks', 1],
		]);
		expect(list[0]).toMatchObject({ matchKey: 'spotify:sp-p3', target: { claim: { provider: 'spotify', kind: 'playlist', providerId: 'sp-p3' } } });
	});
});
