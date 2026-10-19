// sqliteLibraryPort over a generated curator.db: what the engine may embed.
// A local link flagged missing_at (the watcher saw the file vanish; the row
// waits as a re-bind hint) is not a file, so the track is neither playable
// nor resolvable until the link re-binds.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { sqliteLibraryPort } from './library-port.js';

let dir: string;
let sqlite: Database.Database;

function seedTrack(id: string, extra: Record<string, unknown> = {}): void {
	const cols: Record<string, unknown> = { id, title: `Title ${id}`, artists: '[]', state: 'unsorted', duration: 300, ...extra };
	const keys = Object.keys(cols);
	sqlite.prepare(`INSERT INTO track (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k]));
}
function localLink(trackId: string, filePath: string, missingAt: number | null = null): void {
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, missing_at) VALUES (?, ?, 'local', ?, ?, ?)`)
		.run(`local-${trackId}`, trackId, filePath, filePath, missingAt);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-mir-port-'));
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	sqlite = new Database(dbPath);
	// present: a file on disk.  gone: the watcher saw its file vanish.
	// stream: no file at all.  copy: WAV-derived from present.
	seedTrack('present'); localLink('present', 'c:/music/present.flac');
	seedTrack('gone'); localLink('gone', 'c:/music/gone.flac', Date.now());
	seedTrack('stream');
	seedTrack('copy', { derived_from_track_id: 'present' }); localLink('copy', 'c:/music/present.wav');
});
afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* sibling DB handles on Windows */ }
});

describe('sqliteLibraryPort', () => {
	it('lists only tracks with a live local file as playable', () => {
		expect(sqliteLibraryPort(sqlite).playableTrackIds()).toEqual(['present']);
	});

	it('resolves no file for a link flagged missing_at', () => {
		const port = sqliteLibraryPort(sqlite);
		expect(port.trackFile('present')).toBe('c:/music/present.flac');
		expect(port.trackFile('gone')).toBeNull();
		expect(port.trackFile('stream')).toBeNull();
	});

	it('a re-bound link (missing_at cleared, new path) is playable again', () => {
		sqlite.prepare(`UPDATE source_link SET missing_at = NULL, file_path = 'c:/moved/gone.flac' WHERE track_id = 'gone'`).run();
		const port = sqliteLibraryPort(sqlite);
		expect([...port.playableTrackIds()].sort()).toEqual(['gone', 'present']);
		expect(port.trackFile('gone')).toBe('c:/moved/gone.flac');
	});
});
