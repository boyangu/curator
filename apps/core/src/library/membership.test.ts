// Precedence + auth-gating coverage for the materialized membership tier, run
// against a migrated temp curator.db (real schema, real CASE SQL) so the
// local > streaming > followed ordering and the Liked-Songs / no-auth edge
// cases are pinned, not just typechecked.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { memberOrder } from '../test-support/playlist-track.js';
import { MembershipClassifier } from './membership.js';

let dir: string;
let sqlite: Database.Database;
const MY_ID = 'me-real-id';

let seq = 0;
function track(id: string, opts?: { deleted?: boolean }): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state, deleted_at) VALUES (?, ?, '[]', 'unsorted', ?)`)
		.run(id, id, opts?.deleted ? Date.now() : null);
}
function localFile(trackId: string): void {
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path) VALUES (?, ?, 'local', ?, ?)`)
		.run(`sl-${trackId}-${seq++}`, trackId, `${trackId}-file`, `/music/${trackId}.flac`);
}
// Create a playlist and add the given tracks to it. ownerId null + non-liked =
// "ambiguous ownership"; sourceId 'liked-songs' = Spotify Liked Songs.
function playlist(id: string, ownerId: string | null, trackIds: string[], sourceId = id): void {
	sqlite.prepare(`INSERT INTO playlist (id, source, source_id, name, owner_id) VALUES (?, 'spotify', ?, ?, ?)`)
		.run(id, sourceId, id, ownerId);
	trackIds.forEach((tid, i) =>
		sqlite.prepare(`INSERT INTO playlist_track (id, order_key, playlist_id, track_id, position, source_track_id) VALUES (?, ?, ?, ?, ?, ?)`)
			.run(...memberOrder(i), id, tid, i, `${tid}-sid`));
}
function tierOf(id: string): string | null {
	return (sqlite.prepare(`SELECT membership FROM track WHERE id = ?`).get(id) as { membership: string | null }).membership;
}
function classifier(myId: string | null = MY_ID): MembershipClassifier {
	return new MembershipClassifier(sqlite, () => myId);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-membership-'));
	migrate(join(dir, 'curator.db'));
	sqlite = new Database(join(dir, 'curator.db'));
});
afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('MembershipClassifier precedence', () => {
	it('classifies each tier and applies local > streaming > followed precedence', () => {
		track('local');        localFile('local');
		track('owned');        playlist('p-owned', MY_ID, ['owned']);
		track('liked');        playlist('p-liked', 'me', ['liked'], 'liked-songs');
		track('followed');     playlist('p-foll', 'someone-else', ['followed']);
		track('both');         playlist('p-owned2', MY_ID, ['both']); playlist('p-foll2', 'other', ['both']);
		track('localWins');    localFile('localWins'); playlist('p-owned3', MY_ID, ['localWins']); playlist('p-foll3', 'other', ['localWins']);
		track('none');
		track('ambiguous');    playlist('p-amb', null, ['ambiguous']); // null owner, not liked

		classifier().recomputeAll();

		expect(tierOf('local')).toBe('local');
		expect(tierOf('owned')).toBe('streaming');
		expect(tierOf('liked')).toBe('streaming');          // matched via source_id='liked-songs', not owner
		expect(tierOf('followed')).toBe('followed');
		expect(tierOf('both')).toBe('streaming');           // owned beats followed
		expect(tierOf('localWins')).toBe('local');          // local beats both
		expect(tierOf('none')).toBeNull();
		expect(tierOf('ambiguous')).toBeNull();             // null owner, non-liked → neither
	});

	it('a local link flagged missing_at does not count as local (the row is a re-bind hint, not presence)', () => {
		track('gone');     localFile('gone');     playlist('p-gone', MY_ID, ['gone']);
		track('present');  localFile('present');
		sqlite.prepare(`UPDATE source_link SET missing_at = ? WHERE track_id = 'gone'`).run(Date.now());

		classifier().recomputeAll();

		expect(tierOf('gone')).toBe('streaming');   // falls through to the playlist tier
		expect(tierOf('present')).toBe('local');
	});

	it('without auth (no connected account) only local classifies; streaming/followed collapse to null', () => {
		track('local');    localFile('local');
		track('owned');    playlist('p-owned', MY_ID, ['owned']);
		track('liked');    playlist('p-liked', 'me', ['liked'], 'liked-songs');
		track('followed'); playlist('p-foll', 'other', ['followed']);

		classifier(null).recomputeAll();

		expect(tierOf('local')).toBe('local');
		expect(tierOf('owned')).toBeNull();
		expect(tierOf('liked')).toBeNull();
		expect(tierOf('followed')).toBeNull();
	});

	it('skips soft-deleted rows (their tier is meaningless and readers gate on deleted_at)', () => {
		track('gone', { deleted: true }); localFile('gone');
		classifier().recomputeAll();
		expect(tierOf('gone')).toBeNull(); // never written despite the local file
	});

	it('recomputeForTracks updates only the named ids (and chunks past 500)', () => {
		const ids: string[] = [];
		for (let i = 0; i < 600; i++) { const id = `t${i}`; ids.push(id); track(id); playlist(`p${i}`, MY_ID, [id]); }
		// A track left out of the id list stays unclassified.
		track('untouched'); playlist('p-untouched', MY_ID, ['untouched']);

		classifier().recomputeForTracks(ids);

		expect(tierOf('t0')).toBe('streaming');
		expect(tierOf('t599')).toBe('streaming');   // proves the >500 second chunk ran
		expect(tierOf('untouched')).toBeNull();      // not in the list → not recomputed
	});

	it('reclassifies my-vs-followed when the account id changes (recomputeAll re-reads getMyId)', () => {
		track('t'); playlist('p', 'account-A', ['t']);
		// As account-A this is my own playlist → streaming.
		classifier('account-A').recomputeAll();
		expect(tierOf('t')).toBe('streaming');
		// Switch account → same playlist is now someone else's → followed.
		classifier('account-B').recomputeAll();
		expect(tierOf('t')).toBe('followed');
	});
});
