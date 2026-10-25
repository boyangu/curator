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
import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { createCoreService } from '../service.js';
import { LibraryScanner, normalizePath } from './scanner.js';
import type { ParseResult } from '../ingest/types.js';
import { audioHash } from '../ingest/audio-hash.js';
import { writeFlac } from '../test-support/catalogue-fakes.js';
import { tmpDir, type TmpDir } from '../test-support/tmp.js';
import { applyOps } from '../sync-log/apply.js';
import { opSchemaVersion, type NewOp } from '@curator/protocol';
import type Database from 'better-sqlite3';

let tmp: TmpDir;
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
	tmp = tmpDir('curator-scanner-');
	dir = tmp.path;
	migrate(join(dir, 'curator.db'));
	({ db, sqlite } = createDb(join(dir, 'curator.db')));
	tmp.track(sqlite);
});
afterEach(async () => {
	// Also closes the CoreService the duplicate-group case opens over the dir.
	await tmp.cleanup();
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

		const svc = tmp.track(createCoreService(join(dir, 'curator.db'), { peaksDir: join(dir, 'peaks') }));
		const groups = await svc.getDuplicateAudioGroups();
		expect(groups).toHaveLength(1);
		expect(groups[0]!.audioHash).toBe(HASH);
		expect(groups[0]!.tracks.map((t) => t.trackId).sort()).toEqual([first.trackId, second.trackId!].sort());
		expect(groups[0]!.tracks.map((t) => t.filePath).sort()).toEqual([normalizePath(one), normalizePath(two)].sort());
	});

	it('a missing link on a soft-deleted track is not a re-bind target, and the moved file stays with the deleted row', async () => {
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

		// Not re-bound: the tombstone's link stays where it was, still flagged
		// (for the TTL sweep), and the new path got a link of its own — on the
		// deleted row, which stays deleted, rather than on a fresh row.
		expect(res).toEqual({ outcome: 'deleted', trackId: first.trackId });
		expect(linkRow(oldPath)).toMatchObject({ id: link.id, missing_at: expect.any(Number) });
		expect(linkRow(newPath)!.id).not.toBe(link.id);
		expect(linkRow(newPath)!.track_id).toBe(first.trackId);
		expect(trackCount()).toBe(1);
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

// Workstream E: a deleted track must stay deleted when its audio is still on
// disk. A fresh row would be a new recording on every synced device — the
// delete undone everywhere. Real (generated) FLACs through the real parser,
// so the audio hash is the one the hasher computes.
describe('a deleted track stays deleted', () => {
	const PCM = 'c0ffee00'.repeat(4);

	function liveTrackCount(): number {
		return sqlite.prepare(`SELECT COUNT(*) FROM track WHERE deleted_at IS NULL`).pluck().get() as number;
	}
	function linkOf(filePath: string): { track_id: string } | undefined {
		return sqlite.prepare(`SELECT track_id FROM source_link WHERE source = 'local' AND file_path = ?`).get(normalizePath(filePath)) as { track_id: string } | undefined;
	}
	// The real hasher over the generated file; tags are beside the point here
	// (music-metadata does not read these minimal FLACs).
	const parseFlac = async (p: string): Promise<ParseResult> => ({
		title: basename(p, '.flac'), artists: ['Artist'], albumTitle: null, duration: 300,
		isrc: null, bpm: null, genre: null, label: null, container: 'flac', audioHash: await audioHash(p),
	});
	const deletedAt = (id: string): number | null => sqlite.prepare(`SELECT deleted_at FROM track WHERE id = ?`).pluck().get(id) as number | null;
	// A library_track delete as another device would push it.
	function remoteDelete(trackId: string): void {
		const rec = sqlite.prepare(`SELECT recording_id FROM track WHERE id = ?`).pluck().get(trackId) as string;
		const body: NewOp = { entity: 'library_track', entity_id: rec, kind: 'delete', payload: {} };
		applyOps(sqlite, [{ ...body, op_id: crypto.randomUUID(), device_id: 'other-desktop', client_ts: Date.now() + 1_000, schema_version: opSchemaVersion(body) }]);
	}

	it('this device: a delete whose trash step failed does not come back on the next scan', async () => {
		const file = join(dir, 'music', 'Deep Song.flac');
		writeFlac(file, PCM, 'TITLE=Deep Song');
		const scanner = new LibraryScanner(db, parseFlac);
		const first = await ingest(scanner, file);
		expect(first.outcome).toBe('created');

		// No trashFile injected: the file stays on disk, exactly as when the
		// trash step fails. The delete drops the local link.
		const svc = createCoreService(join(dir, 'curator.db'), { peaksDir: join(dir, 'peaks') });
		try {
			await svc.deleteTracks([first.trackId!]);
		} finally {
			await svc.close();
		}
		expect(linkOf(file)).toBeUndefined();

		// Only the recording's audio-hash claim still knows this file.
		const again = await ingest(scanner, file);
		expect(again).toEqual({ outcome: 'deleted', trackId: first.trackId });
		expect(trackCount()).toBe(1);
		expect(liveTrackCount()).toBe(0);
		expect(linkOf(file)?.track_id).toBe(first.trackId);
		// And a re-scan of the now-linked path is a plain skip.
		expect((await ingest(scanner, file)).outcome).toBe('skipped');
	});

	it('another device: a synced delete holds when the local copy is moved, copied or re-tagged', async () => {
		mkdirSync(join(dir, 'a')); mkdirSync(join(dir, 'b'));
		const file = join(dir, 'a', 'Song.flac');
		writeFlac(file, PCM, 'TITLE=Song');
		const scanner = new LibraryScanner(db, parseFlac);
		const first = await ingest(scanner, file);
		remoteDelete(first.trackId!);
		expect(deletedAt(first.trackId!)).not.toBeNull();

		// Moved: a new path for audio the deleted row already links.
		const moved = join(dir, 'b', 'Song.flac');
		renameSync(file, moved);
		expect(await ingest(scanner, moved)).toEqual({ outcome: 'deleted', trackId: first.trackId });
		// A second copy, re-tagged: same PCM, other tags.
		const copy = join(dir, 'a', 'Song (copy).flac');
		writeFlac(copy, PCM, 'TITLE=Song (Original Mix)\nARTIST=Someone');
		expect(await ingest(scanner, copy)).toEqual({ outcome: 'deleted', trackId: first.trackId });

		expect(trackCount()).toBe(1);
		expect(liveTrackCount()).toBe(0);
		// No library_track create left this device for the deleted audio.
		const creates = sqlite.prepare(`SELECT count(*) FROM sync_outbox WHERE entity = 'library_track' AND kind = 'create'`).pluck().get();
		expect(creates).toBe(1);
	});

	it('different audio is still a new track, and a deliberate undelete brings the row back with its file', async () => {
		const file = join(dir, 'music', 'Keep.flac');
		writeFlac(file, PCM, 'TITLE=Keep');
		const scanner = new LibraryScanner(db, parseFlac);
		const first = await ingest(scanner, file);
		remoteDelete(first.trackId!);

		const other = join(dir, 'music', 'Other.flac');
		writeFlac(other, 'ab'.repeat(16), 'TITLE=Other');
		expect((await ingest(scanner, other)).outcome).toBe('created');

		const svc = createCoreService(join(dir, 'curator.db'), { peaksDir: join(dir, 'peaks') });
		try {
			expect(await svc.undeleteTracks([first.trackId!])).toEqual({ restored: [first.trackId] });
			expect(await svc.undeleteTracks([first.trackId!])).toEqual({ restored: [] });
		} finally {
			await svc.close();
		}
		expect(deletedAt(first.trackId!)).toBeNull();
		expect(linkOf(file)?.track_id).toBe(first.trackId);
		const undelete = sqlite.prepare(`SELECT count(*) FROM sync_outbox WHERE entity = 'library_track' AND kind = 'undelete'`).pluck().get();
		expect(undelete).toBe(1);
		// Live again: the next scan of a copy finds a live owner, as before.
		const copy = join(dir, 'music', 'Keep copy.flac');
		writeFlac(copy, PCM, 'TITLE=Keep');
		expect((await ingest(scanner, copy)).outcome).not.toBe('deleted');
		expect(liveTrackCount()).toBeGreaterThanOrEqual(2);
	});
});
