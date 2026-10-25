// Coverage for missing-file orphan detection + cleanup. An "orphan" is a
// track that carries a rekordbox_link but whose local file is gone (no
// source='local' source_link AND the link's rb_file_path missing on disk).
// findRekordboxMissingFiles surfaces them; removeRekordboxMissingFiles turns
// them into Curator deletes that propagate to rekordbox (tombstone + drop
// link + soft-delete), never touching streaming. Runs the REAL CoreService
// (rb sidecar disabled — the cleanup path is pure local DB + fs).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createCoreService, type CoreService } from '../service.js';
import { tmpDir, type TmpDir } from '../test-support/tmp.js';

let tmp: TmpDir;
let dir: string;
let dbPath: string;
let sqlite: Database.Database;
let svc: CoreService;

function seedTrack(id: string): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES (?, ?, '[{"name":"A"}]', 'unsorted')`).run(id, id);
}
function linkRb(id: string, rbContentId: string, filePath: string | null): void {
	sqlite.prepare(
		`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, rb_file_path, imported_at, last_synced_at) VALUES (?, ?, 0, ?, 0, 0)`,
	).run(id, rbContentId, filePath);
}
function linkLocal(id: string, filePath: string): void {
	sqlite.prepare(
		`INSERT INTO source_link (id, track_id, source, source_track_id, file_path) VALUES (?, ?, 'local', ?, ?)`,
	).run(`sl-${id}`, id, id, filePath);
}
function linkSpotify(id: string): void {
	sqlite.prepare(
		`INSERT INTO source_link (id, track_id, source, source_track_id) VALUES (?, ?, 'spotify', ?)`,
	).run(`sp-${id}`, id, `sp${id}`);
}

beforeEach(() => {
	tmp = tmpDir('curator-missing-');
	dir = tmp.path;
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	sqlite = tmp.track(new Database(dbPath));
	svc = tmp.track(createCoreService(dbPath, { peaksDir: join(dir, 'peaks') }));
});

afterEach(async () => {
	await tmp.cleanup();
});

describe('rekordbox missing-file orphans', () => {
	it('detects rb-linked tracks whose file is gone, ignoring ones with a present local file', async () => {
		// Orphan: rb link points at a path that doesn't exist, no local link.
		seedTrack('orphan');
		linkRb('orphan', 'RB1', join(dir, 'gone.flac'));
		linkSpotify('orphan'); // streaming survives — still identifiable

		// Present: rb link + a real local file on disk → NOT an orphan.
		const realFile = join(dir, 'present.flac');
		writeFileSync(realFile, 'x');
		seedTrack('present');
		linkRb('present', 'RB2', realFile);
		linkLocal('present', realFile);

		// rb link with a local source_link → never an orphan even if the rb
		// path is stale (the local link is the authority).
		const realFile2 = join(dir, 'present2.flac');
		writeFileSync(realFile2, 'x');
		seedTrack('haslocal');
		linkRb('haslocal', 'RB3', join(dir, 'stale.flac'));
		linkLocal('haslocal', realFile2);

		const missing = await svc.findRekordboxMissingFiles();
		expect(missing.map((m) => m.trackId)).toEqual(['orphan']);
		expect(missing[0]).toMatchObject({ rbContentId: 'RB1', artist: 'A' });
	});

	it('removeRekordboxMissingFiles tombstones, drops the link, and soft-deletes — no streaming write', async () => {
		seedTrack('orphan');
		linkRb('orphan', 'RB1', join(dir, 'gone.flac'));
		linkSpotify('orphan');

		const { removed } = await svc.removeRekordboxMissingFiles(['orphan']);
		expect(removed).toBe(1);

		// Tombstone queued for propagation (pushed_at NULL).
		const tomb = sqlite.prepare(`SELECT pushed_at AS p FROM rekordbox_deleted_content WHERE rb_content_id = 'RB1'`).get() as { p: number | null } | undefined;
		expect(tomb).toBeDefined();
		expect(tomb!.p).toBeNull();

		// Link dropped → gone from the Rekordbox tab.
		const link = sqlite.prepare(`SELECT 1 FROM rekordbox_link WHERE track_id = 'orphan'`).get();
		expect(link).toBeUndefined();

		// Track soft-deleted, but its streaming source_link survives (no remote write).
		const t = sqlite.prepare(`SELECT deleted_at AS d FROM track WHERE id = 'orphan'`).get() as { d: number | null };
		expect(t.d).not.toBeNull();
		const sp = sqlite.prepare(`SELECT 1 FROM source_link WHERE track_id = 'orphan' AND source = 'spotify'`).get();
		expect(sp).toBeDefined();
	});

	it('re-validates ids server-side — a track whose file reappeared is never deleted', async () => {
		// Caller passes a stale id, but the file exists now → not an orphan.
		const realFile = join(dir, 'back.flac');
		writeFileSync(realFile, 'x');
		seedTrack('back');
		linkRb('back', 'RB9', realFile);
		linkLocal('back', realFile);

		const { removed } = await svc.removeRekordboxMissingFiles(['back']);
		expect(removed).toBe(0);
		// Link + track untouched.
		expect(sqlite.prepare(`SELECT 1 FROM rekordbox_link WHERE track_id = 'back'`).get()).toBeDefined();
		expect((sqlite.prepare(`SELECT deleted_at AS d FROM track WHERE id = 'back'`).get() as { d: number | null }).d).toBeNull();
	});
});
