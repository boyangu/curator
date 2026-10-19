// listLocalTracks — the `tracks` backup set's enumeration, read from a
// generated curator.db. A local link flagged missing_at (the watcher saw the
// file vanish; the row waits as a re-bind hint) has no file to back up, and
// must not become a snapshot entry the restore would then look for.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { listLocalTracks } from './sets.js';

let dir: string;
let dbPath: string;
let sqlite: Database.Database;

function seedTrack(id: string, extra: Record<string, unknown> = {}): void {
	const cols: Record<string, unknown> = { id, title: `Title ${id}`, artists: '[]', state: 'unsorted', duration: 300, ...extra };
	const keys = Object.keys(cols);
	sqlite.prepare(`INSERT INTO track (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k]));
}
function localLink(trackId: string, filePath: string, missingAt: number | null = null): void {
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, file_size, missing_at) VALUES (?, ?, 'local', ?, ?, 1000, ?)`)
		.run(`local-${trackId}`, trackId, filePath, filePath, missingAt);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-backup-sets-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	sqlite = new Database(dbPath);
	// present: a file on disk.  gone: the watcher saw its file vanish.
	// deleted: soft-deleted track (already excluded).
	seedTrack('present'); localLink('present', 'c:/music/present.flac');
	seedTrack('gone'); localLink('gone', 'c:/music/gone.flac', Date.now());
	seedTrack('deleted', { deleted_at: 1 }); localLink('deleted', 'c:/music/deleted.flac');
});
afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* sibling DB handles on Windows */ }
});

describe('listLocalTracks', () => {
	it('skips links flagged missing_at (and soft-deleted tracks)', () => {
		const { files } = listLocalTracks(dbPath);
		expect(files.map((f) => f.path)).toEqual(['c:/music/present.flac']);
	});

	it('includes a re-bound link once missing_at is cleared', () => {
		sqlite.prepare(`UPDATE source_link SET missing_at = NULL, file_path = 'c:/moved/gone.flac' WHERE track_id = 'gone'`).run();
		const { files } = listLocalTracks(dbPath);
		expect(files.map((f) => f.path).sort()).toEqual(['c:/moved/gone.flac', 'c:/music/present.flac']);
	});
});
