// Convert to WAV — the Curator-side copy. Pins:
//   1. The copy carries the original's metadata, overrides, rating/colour/
//      comment, analysis (both slots), cues (as curator-origin), user tags +
//      MyTags — and NOT its ISRC, system tags, streaming links or rb link.
//   2. Pre-binding: the scanner sees the renamed file as already-known
//      ('skipped'), never match-or-creates it onto the FLAC's track.
//   3. Identity guards: startup ISRC dedup never folds a derived row, and a
//      new file can't match-or-create onto a copy.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { LibraryScanner, normalizePath } from '../local/scanner.js';
import type { ParseResult } from '../ingest/types.js';
import { findLiveDerivative, materializeWavCopy } from './materialize.js';

let dir: string;
let dbPath: string;
let db: Db;
let sqlite: Database.Database;

const FOLDER = { id: 'folder-1', path: '', excludeGlobs: null, watching: true, scanState: 'idle', scanError: null, addedAt: new Date(), lastScannedAt: null, isFavorite: false };

function seedOriginal(): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, isrc, duration, bpm, key_camelot, rating, color_label, comment, overrides, state, cues_edited_at)
		VALUES ('flac', 'Song (X Remix)', ?, 'GBAAA0000001', 300, 124, '8A', 4, 'red', 'warm-up', ?, 'unsorted', NULL)`)
		.run(JSON.stringify([{ name: 'A' }, { name: 'X', role: 'remixer' }]), JSON.stringify({ genre: 'Deep House' }));
	sqlite.prepare(`INSERT INTO track_analysis (track_id, bpm, beatgrid, analyzer_version, analyzed_at, rb_bpm, rb_beatgrid) VALUES ('flac', 124, ?, '2.3.0', 1, 124, ?)`)
		.run(Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6, 7, 8]));
	sqlite.prepare(`INSERT INTO cue (id, track_id, slot, position_sec, length_sec, color, name, kind, origin) VALUES ('c1', 'flac', 0, 1.5, NULL, 'cti:1', 'Drop', 'hot', 'rekordbox')`).run();
	sqlite.prepare(`INSERT INTO cue (id, track_id, slot, position_sec, length_sec, color, name, kind, origin) VALUES ('c2', 'flac', 100, 30, 8, NULL, NULL, 'memory', 'rekordbox')`).run();
	sqlite.prepare(`INSERT INTO tag (id, name, kind) VALUES ('user1', 'peak', 'user'), ('rb_42', 'Vocal', 'user')`).run();
	for (const tag of ['interested', 'user1', 'rb_42']) sqlite.prepare(`INSERT INTO track_tag (track_id, tag_id) VALUES ('flac', ?)`).run(tag);
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id) VALUES ('sp', 'flac', 'spotify', 'spotify:track:1')`).run();
	sqlite.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at) VALUES ('flac', '555', 1, 1, 1)`).run();
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-wav-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
	seedOriginal();
});
afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function writeWav(name: string): { path: string; stat: { size: number; mtimeMs: number } } {
	const path = join(dir, name);
	writeFileSync(path, Buffer.alloc(64, 1));
	const st = statSync(path);
	return { path, stat: { size: st.size, mtimeMs: st.mtimeMs } };
}

// The fixtures are not real WAVs, so the hash the converter would compute is
// stubbed; it only has to be non-null for the watcher's skip path.
const WAV_HASH = `pcm-md5:${'0'.repeat(32)}`;

describe('materializeWavCopy', () => {
	it('copies everything the original carries except its identity', () => {
		const { path, stat } = writeWav('Song.wav');
		const id = materializeWavCopy(db, sqlite, { sourceTrackId: 'flac', wavPath: normalizePath(path), stat, audioHash: WAV_HASH });

		const t = sqlite.prepare(`SELECT * FROM track WHERE id = ?`).get(id) as Record<string, unknown>;
		expect(t.title).toBe('Song (X Remix) [WAV]');
		expect(t.isrc).toBeNull();
		expect(t.derived_from_track_id).toBe('flac');
		expect([t.rating, t.color_label, t.comment, t.bpm, t.key_camelot, t.duration]).toEqual([4, 'red', 'warm-up', 124, '8A', 300]);
		expect(JSON.parse(t.overrides as string)).toEqual({ genre: 'Deep House' });
		expect(t.cues_edited_at).not.toBeNull();
		expect(t.title_ascii).toContain('wav');

		const a = sqlite.prepare(`SELECT beatgrid, rb_beatgrid, rb_bpm FROM track_analysis WHERE track_id = ?`).get(id) as { beatgrid: Buffer; rb_beatgrid: Buffer; rb_bpm: number };
		expect([...a.beatgrid]).toEqual([1, 2, 3, 4]);
		expect([...a.rb_beatgrid]).toEqual([5, 6, 7, 8]);

		const cues = sqlite.prepare(`SELECT id, slot, position_sec, name, kind, origin FROM cue WHERE track_id = ? ORDER BY slot`).all(id) as Array<Record<string, unknown>>;
		expect(cues.map((c) => [c.slot, c.position_sec, c.name, c.kind, c.origin])).toEqual([[0, 1.5, 'Drop', 'hot', 'curator'], [100, 30, null, 'memory', 'curator']]);
		expect(cues.every((c) => c.id !== 'c1' && c.id !== 'c2')).toBe(true);

		const tags = (sqlite.prepare(`SELECT tag_id FROM track_tag WHERE track_id = ? ORDER BY tag_id`).all(id) as Array<{ tag_id: string }>).map((r) => r.tag_id);
		expect(tags).toEqual(['rb_42', 'user1']);

		const links = sqlite.prepare(`SELECT source, file_path, file_format, file_size, file_mtime FROM source_link WHERE track_id = ?`).all(id) as Array<Record<string, unknown>>;
		expect(links).toEqual([{ source: 'local', file_path: normalizePath(path), file_format: 'wave', file_size: stat.size, file_mtime: Math.trunc(stat.mtimeMs) }]);
		expect(sqlite.prepare(`SELECT 1 FROM rekordbox_link WHERE track_id = ?`).get(id)).toBeUndefined();
		expect((sqlite.prepare(`SELECT COUNT(*) n FROM track_artist WHERE track_id = ?`).get(id) as { n: number }).n).toBe(2);

		expect(findLiveDerivative(db, 'flac')).toEqual({ id, filePath: normalizePath(path) });
	});

	it('pre-binds the path: the watcher\'s add for the renamed file is a no-op skip', async () => {
		const { path, stat } = writeWav('Song.wav');
		const id = materializeWavCopy(db, sqlite, { sourceTrackId: 'flac', wavPath: normalizePath(path), stat, audioHash: WAV_HASH });
		let parsed = 0;
		const scanner = new LibraryScanner(db, async (): Promise<ParseResult> => {
			parsed++;
			return { title: 'Song (X Remix) [WAV]', artists: ['A'], albumTitle: null, duration: 300, isrc: null, bpm: null, genre: null, label: null, container: 'wave', audioHash: null };
		});
		(scanner as any).totals.set(FOLDER.id, { scanned: 0, matched: 0, created: 0, skipped: 0, failed: 0 });
		const res = await (scanner as any).ingestPath({ ...FOLDER, path: dir }, path);
		expect(res).toEqual({ outcome: 'skipped', trackId: id });
		expect(parsed).toBe(0);
		// Still exactly one local link on the original's side (none), one on the copy.
		expect(sqlite.prepare(`SELECT COUNT(*) n FROM source_link WHERE track_id = 'flac' AND source = 'local'`).get()).toEqual({ n: 0 });
	});

	it('a new file never match-or-creates onto a copy', async () => {
		const { path, stat } = writeWav('Song.wav');
		const id = materializeWavCopy(db, sqlite, { sourceTrackId: 'flac', wavPath: normalizePath(path), stat, audioHash: WAV_HASH });
		const other = writeWav('Song other.wav');
		const scanner = new LibraryScanner(db, async (): Promise<ParseResult> => ({
			title: 'Song (X Remix) [WAV]', artists: ['A'], albumTitle: null, duration: 300, isrc: null, bpm: null, genre: null, label: null, container: 'wave', audioHash: null,
		}));
		(scanner as any).totals.set(FOLDER.id, { scanned: 0, matched: 0, created: 0, skipped: 0, failed: 0 });
		const res = await (scanner as any).ingestPath({ ...FOLDER, path: dir }, other.path);
		expect(res.trackId).not.toBe(id);
	});

	it('startup ISRC dedup leaves a derived row alone even if it gains the ISRC', () => {
		const { path, stat } = writeWav('Song.wav');
		const id = materializeWavCopy(db, sqlite, { sourceTrackId: 'flac', wavPath: normalizePath(path), stat, audioHash: WAV_HASH });
		sqlite.prepare(`UPDATE track SET isrc = 'GBAAA0000001' WHERE id = ?`).run(id);
		sqlite.close();
		migrate(dbPath);
		({ db, sqlite } = createDb(dbPath));
		expect(sqlite.prepare(`SELECT id FROM track WHERE id IN ('flac', ?) ORDER BY id`).all(id)).toHaveLength(2);
		expect((sqlite.prepare(`SELECT COUNT(*) n FROM cue WHERE track_id = ?`).get(id) as { n: number }).n).toBe(2);
	});
});
