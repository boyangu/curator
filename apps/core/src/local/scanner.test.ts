// Regression coverage for the 2026-06-25 re-bind incident: a tag edit
// rewrote watched files, the scanner re-ran match-or-create on the changed
// content, the scorer rejected the original rows (RB comma-joined artist
// strings), and dozens of curated tracks lost their file links to freshly
// minted bare rows. Two invariants pinned here:
//   1. A path that already has a local source_link NEVER re-binds to a
//      different track when its content changes — the link is the identity.
//   2. A NEW file whose tags carry split artists still matches a canonical
//      row that stores them as one comma-joined string (scorer tokenization).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { createCoreService } from '../service.js';
import { LibraryScanner, normalizePath } from './scanner.js';
import type { ParseResult } from '../ingest/types.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Db;
let sqlite: Database.Database;

const FOLDER = { id: 'folder-1', path: '', excludeGlobs: null, watching: true, scanState: 'idle', scanError: null, addedAt: new Date(), lastScannedAt: null, isFavorite: false };

function parse(result: Partial<ParseResult>): (p: string) => Promise<ParseResult> {
	return async () => ({
		title: null, artists: [], albumTitle: null, duration: null,
		isrc: null, bpm: null, genre: null, label: null, container: 'flac', audioHash: null,
		...result,
	});
}

function insertTrack(id: string, title: string, artistsJson: string, duration: number): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, duration, state) VALUES (?, ?, ?, ?, 'unsorted')`)
		.run(id, title, artistsJson, duration);
}

function insertLocalLink(trackId: string, filePath: string): void {
	const norm = normalizePath(filePath);
	// Stale mtime/size so the mtime guard doesn't short-circuit the re-ingest.
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, file_mtime, file_size) VALUES (?, ?, 'local', ?, ?, 1000, 1)`)
		.run(`sl-${trackId}`, trackId, norm, norm);
}

function linkOwner(filePath: string): string | undefined {
	const row = sqlite.prepare(`SELECT track_id FROM source_link WHERE source='local' AND file_path = ?`)
		.get(normalizePath(filePath)) as { track_id: string } | undefined;
	return row?.track_id;
}

function trackCount(): number {
	return (sqlite.prepare(`SELECT COUNT(*) n FROM track`).get() as { n: number }).n;
}

async function ingest(scanner: LibraryScanner, filePath: string) {
	// ingestPath is private; drive it directly to keep chokidar out of the test.
	(scanner as any).totals.set(FOLDER.id, { scanned: 0, matched: 0, created: 0, skipped: 0, failed: 0 });
	return (scanner as any).ingestPath({ ...FOLDER, path: dir }, filePath);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-scanner-'));
	migrate(join(dir, 'curator.db'));
	({ db, sqlite } = createDb(join(dir, 'curator.db')));
});
afterEach(() => {
	sqlite.close();
	// The duplicate-group case opens a CoreService over the same dir; its
	// sibling DB handles can outlive the test on Windows.
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* see above */ }
});

describe('changed file keeps its track binding', () => {
	it('re-binds to the linked track even when the rewritten tags no longer score as a match', async () => {
		insertTrack('t-curated', "Lion's Mane - Bookwood Remix", '[{"name":"Madloch, Subnode, Bookwood"}]', 358);
		const file = join(dir, "Madloch, Subnode - Lion's Mane (Bookwood Remix).flac");
		writeFileSync(file, 'rewritten-by-tag-editor');
		insertLocalLink('t-curated', file);

		const scanner = new LibraryScanner(db, parse({
			// Post-edit tags: different title shape, split artists, no ISRC.
			title: "Lion's Mane (Bookwood Remix)", artists: ['Madloch', 'Subnode'], duration: 358,
		}));
		const result = await ingest(scanner, file);

		expect(result.outcome).toBe('matched');
		expect(result.trackId).toBe('t-curated');
		expect(linkOwner(file)).toBe('t-curated');
		expect(trackCount()).toBe(1);
	});

	it('keeps the binding even when the parsed metadata is entirely unrelated', async () => {
		insertTrack('t-curated', 'Original Title', '[{"name":"Original Artist"}]', 200);
		const file = join(dir, 'original.flac');
		writeFileSync(file, 'overwritten');
		insertLocalLink('t-curated', file);

		const scanner = new LibraryScanner(db, parse({
			title: 'Something Else Completely', artists: ['Nobody Known'], duration: 999,
		}));
		const result = await ingest(scanner, file);

		expect(result.trackId).toBe('t-curated');
		expect(linkOwner(file)).toBe('t-curated');
		expect(trackCount()).toBe(1);
	});
});

describe('new file matching against RB-style canonical rows', () => {
	it('matches a row that stores all artists as one comma-joined string', async () => {
		insertTrack('t-rb', "Lion's Mane - Bookwood Remix", '[{"name":"Madloch, Subnode, Bookwood"}]', 358);
		const file = join(dir, 'lion.flac');
		writeFileSync(file, 'fresh download');

		const scanner = new LibraryScanner(db, parse({
			title: "Lion's Mane (Bookwood Remix)", artists: ['Madloch', 'Subnode'], duration: 358,
		}));
		const result = await ingest(scanner, file);

		expect(result.outcome).toBe('matched');
		expect(result.trackId).toBe('t-rb');
		expect(trackCount()).toBe(1);
	});

	it('still creates a fresh row for a genuinely unknown file', async () => {
		insertTrack('t-rb', "Lion's Mane - Bookwood Remix", '[{"name":"Madloch, Subnode, Bookwood"}]', 358);
		const file = join(dir, 'other.flac');
		writeFileSync(file, 'brand new');

		const scanner = new LibraryScanner(db, parse({
			title: 'Unrelated Song', artists: ['Someone New'], duration: 100,
		}));
		const result = await ingest(scanner, file);

		expect(result.outcome).toBe('created');
		expect(trackCount()).toBe(2);
	});
});

// Audio-hash identity (A1–A3): a moved or re-tagged file keeps its row and
// its link id; a second copy on disk is a new row that the duplicate view can
// find; links of vanished files wait for the re-bind, then get swept.
describe('audio hash identity', () => {
	const HASH = `pcm-md5:${'a'.repeat(32)}`;
	const tags: Partial<ParseResult> = { title: 'Moved Song', artists: ['Mover'], duration: 240, audioHash: HASH };

	interface LinkRow { id: string; track_id: string; audio_hash: string | null; missing_at: number | null }
	function linkRow(filePath: string): LinkRow | undefined {
		return sqlite.prepare(`SELECT id, track_id, audio_hash, missing_at FROM source_link WHERE source='local' AND file_path = ?`)
			.get(normalizePath(filePath)) as LinkRow | undefined;
	}
	function linkCount(): number {
		return (sqlite.prepare(`SELECT COUNT(*) n FROM source_link WHERE source='local'`).get() as { n: number }).n;
	}
	// Parser stub that counts calls — the skip path must not parse.
	function countingScanner(result: Partial<ParseResult>): { scanner: LibraryScanner; calls: () => number } {
		let n = 0;
		const base = parse(result);
		const scanner = new LibraryScanner(db, (p) => { n++; return base(p); });
		return { scanner, calls: () => n };
	}
	function twoFolders(): { a: string; b: string } {
		mkdirSync(join(dir, 'a')); mkdirSync(join(dir, 'b'));
		return { a: join(dir, 'a'), b: join(dir, 'b') };
	}

	it('lazy backfill: an unchanged known path with no hash is parsed once, stored, then skipped', async () => {
		insertTrack('t-old', 'Moved Song', '[{"name":"Mover"}]', 240);
		const file = join(dir, 'old.flac');
		writeFileSync(file, 'audio');
		const st = statSync(file);
		const norm = normalizePath(file);
		// Real size+mtime (the mtime guard alone would skip) but no audio_hash.
		sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, file_mtime, file_size) VALUES ('sl-old', 't-old', 'local', ?, ?, ?, ?)`)
			.run(norm, norm, Math.trunc(st.mtimeMs), st.size);

		const { scanner, calls } = countingScanner(tags);
		expect((await ingest(scanner, file)).outcome).toBe('matched');
		expect(calls()).toBe(1);
		expect(linkRow(file)).toMatchObject({ id: 'sl-old', track_id: 't-old', audio_hash: HASH });

		expect((await ingest(scanner, file)).outcome).toBe('skipped');
		expect(calls()).toBe(1);
	});

	// 2026-10-17: the backfill re-parsed every known path and stamped
	// updatedAt on all of them, so rekordbox "Sync updates" re-sent the whole
	// local library on every run. updatedAt means "Curator changed this row".
	describe('lazy backfill and updatedAt', () => {
		const STAMP = 1_000_000;
		function seedUnhashed(fields: { duration: number; genre?: string | null; label?: string | null }): string {
			sqlite.prepare(`INSERT INTO track (id, title, artists, duration, genre, label, state, updated_at) VALUES ('t-old', 'Moved Song', '[{"name":"Mover"}]', ?, ?, ?, 'unsorted', ?)`)
				.run(fields.duration, fields.genre ?? null, fields.label ?? null, STAMP);
			const file = join(dir, 'old.flac');
			writeFileSync(file, 'audio');
			const st = statSync(file);
			const norm = normalizePath(file);
			sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, file_mtime, file_size) VALUES ('sl-old', 't-old', 'local', ?, ?, ?, ?)`)
				.run(norm, norm, Math.trunc(st.mtimeMs), st.size);
			return file;
		}
		const row = () => sqlite.prepare(`SELECT duration, genre, label, updated_at FROM track WHERE id = 't-old'`).get() as
			{ duration: number; genre: string | null; label: string | null; updated_at: number };

		it('does not bump updatedAt when the re-parse changes nothing', async () => {
			const file = seedUnhashed({ duration: 240, genre: 'House', label: 'Anjunadeep' });
			const scanner = new LibraryScanner(db, parse({ ...tags, duration: 240, genre: 'Tech House', label: 'Other' }));
			expect((await ingest(scanner, file)).outcome).toBe('matched');
			// genre/label are gap-fill only, so the different file tags are not a change.
			expect(row()).toEqual({ duration: 240, genre: 'House', label: 'Anjunadeep', updated_at: STAMP });
			expect(linkRow(file)!.audio_hash).toBe(HASH);
		});

		it('bumps updatedAt when the file duration differs', async () => {
			const file = seedUnhashed({ duration: 240 });
			const scanner = new LibraryScanner(db, parse({ ...tags, duration: 241 }));
			await ingest(scanner, file);
			expect(row().duration).toBe(241);
			expect(row().updated_at).toBeGreaterThan(STAMP);
		});

		it('bumps updatedAt when a genre gap is filled', async () => {
			const file = seedUnhashed({ duration: 240, genre: null });
			const scanner = new LibraryScanner(db, parse({ ...tags, duration: 240, genre: 'Progressive House' }));
			await ingest(scanner, file);
			expect(row().genre).toBe('Progressive House');
			expect(row().updated_at).toBeGreaterThan(STAMP);
		});
	});

	it('move, unlink then add: the link follows the audio with the same id and track', async () => {
		const { a, b } = twoFolders();
		const oldPath = join(a, 'song.flac');
		writeFileSync(oldPath, 'audio');
		const scanner = new LibraryScanner(db, parse(tags));
		const first = await ingest(scanner, oldPath);
		expect(first.outcome).toBe('created');
		const link = linkRow(oldPath)!;

		(scanner as any).orphanByPath(oldPath);
		expect(linkRow(oldPath)!.missing_at).not.toBeNull();
		expect(trackCount()).toBe(1);

		const newPath = join(b, 'song.flac');
		renameSync(oldPath, newPath);
		const res = await ingest(scanner, newPath);

		expect(res).toEqual({ outcome: 'rebound', trackId: first.trackId });
		expect(trackCount()).toBe(1);
		expect(linkCount()).toBe(1);
		expect(linkRow(newPath)).toMatchObject({ id: link.id, track_id: first.trackId, missing_at: null, audio_hash: HASH });
		expect(linkRow(oldPath)).toBeUndefined();
	});

	it('move, add then unlink: the stale link is re-pointed when its file is already gone; the late unlink is a no-op', async () => {
		const { a, b } = twoFolders();
		const oldPath = join(a, 'song.flac');
		writeFileSync(oldPath, 'audio');
		const scanner = new LibraryScanner(db, parse(tags));
		const first = await ingest(scanner, oldPath);
		const link = linkRow(oldPath)!;

		const newPath = join(b, 'song.flac');
		renameSync(oldPath, newPath);
		const res = await ingest(scanner, newPath);
		expect(res).toEqual({ outcome: 'rebound', trackId: first.trackId });

		const orphaned: string[] = [];
		scanner.onIngest((evt) => { if (evt.outcome === 'orphaned') orphaned.push(evt.filePath); });
		(scanner as any).orphanByPath(oldPath);

		expect(orphaned).toEqual([]);
		expect(trackCount()).toBe(1);
		expect(linkCount()).toBe(1);
		expect(linkRow(newPath)).toMatchObject({ id: link.id, track_id: first.trackId, missing_at: null });
	});

	it('tag rewrite at the same path (new size/mtime, same hash) keeps the row and the link', async () => {
		const file = join(dir, 'song.flac');
		writeFileSync(file, 'audio');
		const scanner = new LibraryScanner(db, parse(tags));
		const first = await ingest(scanner, file);
		const link = linkRow(file)!;

		writeFileSync(file, 'audio with a much longer tag block appended');
		const retagged = new LibraryScanner(db, parse({ ...tags, title: 'Renamed In Tags', artists: ['Someone Else'] }));
		const res = await ingest(retagged, file);

		expect(res).toEqual({ outcome: 'matched', trackId: first.trackId });
		expect(trackCount()).toBe(1);
		expect(linkCount()).toBe(1);
		expect(linkRow(file)!.id).toBe(link.id);
	});

	it('a file reappearing at its own path clears missing_at without a parse', async () => {
		const file = join(dir, 'song.flac');
		writeFileSync(file, 'audio');
		const { scanner, calls } = countingScanner(tags);
		const first = await ingest(scanner, file);
		(scanner as any).orphanByPath(file);
		expect(linkRow(file)!.missing_at).not.toBeNull();

		const res = await ingest(scanner, file);
		expect(res).toEqual({ outcome: 'matched', trackId: first.trackId });
		expect(linkRow(file)!.missing_at).toBeNull();
		expect(calls()).toBe(1);
	});

	it('a byte-identical second file still on disk mints its own track and shows as a duplicate group', async () => {
		const { a, b } = twoFolders();
		const one = join(a, 'song.flac');
		const two = join(b, 'song copy.flac');
		writeFileSync(one, 'audio');
		writeFileSync(two, 'audio');
		const scanner = new LibraryScanner(db, parse(tags));
		const first = await ingest(scanner, one);
		const second = await ingest(scanner, two);

		expect(second.outcome).toBe('created');
		expect(second.trackId).not.toBe(first.trackId);
		expect(trackCount()).toBe(2);
		expect(linkCount()).toBe(2);
		// Neither link was touched by the other's ingest.
		expect(linkRow(one)!.track_id).toBe(first.trackId);
		expect(linkRow(two)!.track_id).toBe(second.trackId);

		const svc = createCoreService(join(dir, 'curator.db'), { peaksDir: join(dir, 'peaks') });
		const groups = await svc.getDuplicateAudioGroups();
		expect(groups).toHaveLength(1);
		expect(groups[0]!.audioHash).toBe(HASH);
		expect(groups[0]!.tracks.map((t) => t.trackId).sort()).toEqual([first.trackId, second.trackId!].sort());
		expect(groups[0]!.tracks.map((t) => t.filePath).sort()).toEqual([normalizePath(one), normalizePath(two)].sort());
	});

	it('a missing link on a soft-deleted track is not a re-bind target', async () => {
		const { a, b } = twoFolders();
		const oldPath = join(a, 'song.flac');
		writeFileSync(oldPath, 'audio');
		const scanner = new LibraryScanner(db, parse(tags));
		const first = await ingest(scanner, oldPath);
		(scanner as any).orphanByPath(oldPath);
		sqlite.prepare(`UPDATE track SET deleted_at = ? WHERE id = ?`).run(Date.now(), first.trackId);

		const link = linkRow(oldPath)!;

		const newPath = join(b, 'song.flac');
		renameSync(oldPath, newPath);
		const res = await ingest(scanner, newPath);

		// Not re-bound: the tombstone's link stays where it was, still flagged,
		// and the new path got a link of its own. (Whether the scorer then
		// matches the tombstone by tags is findCandidates' pre-existing
		// behaviour — it does not filter deleted_at — and not pinned here.)
		expect(res.outcome).not.toBe('rebound');
		expect(linkRow(oldPath)).toMatchObject({ id: link.id, missing_at: expect.any(Number) });
		expect(linkRow(newPath)!.id).not.toBe(link.id);
	});

	it('sweep drops links missing for longer than the TTL and keeps younger ones', () => {
		insertTrack('t-31', 'Long Gone', '[]', 100);
		insertTrack('t-29', 'Just Gone', '[]', 100);
		const day = 86_400_000;
		sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, missing_at) VALUES ('sl-31', 't-31', 'local', '/x/31.flac', '/x/31.flac', ?)`)
			.run(Date.now() - 31 * day);
		sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, missing_at) VALUES ('sl-29', 't-29', 'local', '/x/29.flac', '/x/29.flac', ?)`)
			.run(Date.now() - 29 * day);

		const scanner = new LibraryScanner(db, parse(tags));
		const orphaned: string[] = [];
		scanner.onIngest((evt) => { if (evt.outcome === 'orphaned') orphaned.push(evt.trackId); });

		expect(scanner.sweepMissingLinks(30)).toBe(1);
		expect(orphaned).toEqual(['t-31']);
		expect(linkRow('/x/31.flac')).toBeUndefined();
		expect(linkRow('/x/29.flac')).toMatchObject({ id: 'sl-29' });
		expect(trackCount()).toBe(2);
	});
});
