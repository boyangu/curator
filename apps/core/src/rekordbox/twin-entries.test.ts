// Twin rekordbox entries (importer.ts applyTrackDelta / flushFirstLinks): a
// track with two local files can have two rekordbox content rows, and both
// match it. The linked row wins and the twin is skipped by every pass; a
// track with no link yet links exactly one, deterministically. The e2e run of
// 2026-10-24 found an unlinked twin's rating 5 pushed onto the linked row.
// Real importer, migrated temp DB, stub sidecar — never real data.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { RekordboxImporter, type RunImportOptions } from './importer.js';
import type { RekordboxSidecar } from './sidecar.js';

let dir: string;
let db: Db;
let sqlite: Database.Database;

type Frame = { event: string; row: Record<string, unknown> };

const FILE_A = 'c:/music/one.flac';
const FILE_B = 'd:/copies/one.flac';
const FILE_C = 'e:/more/one.flac';

function stubSidecar(frames: Frame[]): RekordboxSidecar {
	const emitter = new EventEmitter();
	return Object.assign(emitter, {
		open: async () => ({ ok: true }),
		scan: async () => {
			for (const f of frames) emitter.emit('event', { event: f.event, frame: { row: f.row } });
			return { watermarks: {}, cancelled: false };
		},
		cancel: async () => { /* */ },
	}) as unknown as RekordboxSidecar;
}

async function pull(frames: Frame[]): Promise<RekordboxImporter> {
	const opts: RunImportOptions = {
		mode: 'full',
		flags: { syncTracks: true, syncPlaylists: true, syncMyTags: true, syncCuesGridsPhrases: true, syncWaveformPeaks: false, syncHistory: false },
		dbPath: join(dir, 'master.db'), // never opened — stub sidecar
		peaksDir: join(dir, 'peaks'),
	};
	const importer = new RekordboxImporter(db, stubSidecar(frames));
	await importer.runImport(opts);
	return importer;
}

// One track, its local files in the order they were bound (rowid order: the
// first is its primary file).
function seedTrack(files: string[]): void {
	sqlite.prepare(`INSERT INTO track (id, recording_id, title, artists, state, updated_at) VALUES ('t1', 'rec-1', 'One', '[{"name":"A"}]', 'unsorted', 0)`).run();
	files.forEach((f, i) => {
		sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path) VALUES (?, 't1', 'local', ?, ?)`).run(`sl${i}`, f, f);
	});
}

const T_RB = Date.parse('2026-09-01T10:00:00Z');
const trackFrame = (id: string, file: string, over: Record<string, unknown> = {}): Frame => ({
	event: 'track',
	row: {
		rb_content_id: id, rb_local_usn: 11, rb_local_deleted: false,
		rb_updated_at_ms: T_RB, rb_added_at_ms: null, file_path: file,
		title: 'One', artist: 'A', album: null, genre: null, label: null,
		bpm: 124, key_camelot: '8A', key_musical: null, color_label: null,
		rating: 2, comment: null, play_count: null, last_played_at_ms: null, duration_sec: 300,
		...over,
	},
});
const cueFrame = (id: string, slot: number, positionSec: number): Frame => ({
	event: 'cues', row: { rb_content_id: id, rb_local_usn: 1, rb_local_deleted: false, slot, kind: 'hot', position_sec: positionSec, length_sec: null, color: null, name: null },
});
const playlistFrame = (pid: string, ids: string[]): Frame => ({
	event: 'playlist', row: { rb_playlist_id: pid, rb_local_usn: 2, rb_local_deleted: false, parent_folder_id: null, name: pid, is_folder: false, is_smart: false, position: 0, tracks: ids.map((id, i) => ({ rb_content_id: id, position: i })) },
});
const mytagFrame = (tid: string, ids: string[]): Frame => ({
	event: 'mytag', row: { rb_tag_id: tid, rb_local_usn: 3, rb_local_deleted: false, name: tid, color: null, tracks: ids },
});

const linkOf = () => sqlite.prepare(`SELECT rb_content_id AS id, rb_file_path AS path FROM rekordbox_link WHERE track_id = 't1'`).get() as { id: string; path: string } | undefined;
const ratingOf = () => sqlite.prepare(`SELECT rating FROM track WHERE id = 't1'`).pluck().get() as number | null;
const cueSlots = () => sqlite.prepare(`SELECT slot, position_sec AS pos FROM cue WHERE track_id = 't1' ORDER BY slot`).all() as Array<{ slot: number; pos: number }>;
const tagsOf = () => sqlite.prepare(`SELECT tag_id FROM track_tag WHERE track_id = 't1' ORDER BY tag_id`).pluck().all() as string[];
const membersOf = (pid: string) => sqlite.prepare(`SELECT track_id AS trackId, source_track_id AS cid FROM playlist_track WHERE playlist_id = ?`).all(`rb_${pid}`) as Array<{ trackId: string; cid: string }>;
const twinsOf = (i: RekordboxImporter): number => (i as unknown as { twinsSkipped: number }).twinsSkipped;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-rb-twins-'));
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

describe('twin rekordbox entries: the linked entry wins', () => {
	it('a linked track skips its twin in the track, cue, tag and playlist passes', async () => {
		seedTrack([FILE_A, FILE_B]);
		await pull([trackFrame('C1', FILE_A), cueFrame('C1', 0, 10)]);
		expect(linkOf()).toEqual({ id: 'C1', path: FILE_A });
		expect(ratingOf()).toBe(2);

		const i = await pull([
			trackFrame('C1', FILE_A),
			// The twin: another rating, its own cues, a tag only it carries.
			trackFrame('C2', FILE_B, { rating: 5, rb_updated_at_ms: T_RB + 86_400_000 }),
			playlistFrame('P', ['C2', 'C1']),
			playlistFrame('Q', ['C2']),
			mytagFrame('M1', ['C1']),
			mytagFrame('M2', ['C2']),
			cueFrame('C1', 0, 10),
			cueFrame('C2', 1, 99),
		]);
		expect(twinsOf(i)).toBe(1);
		expect(linkOf()).toEqual({ id: 'C1', path: FILE_A });
		expect(ratingOf()).toBe(2);
		expect(cueSlots()).toEqual([{ slot: 0, pos: 10 }]);
		expect(tagsOf()).toEqual(['rb_M1']);
		// One place, at the linked row; a playlist holding only the twin
		// holds nothing Curator can link.
		expect(membersOf('P')).toEqual([{ trackId: 't1', cid: 'C1' }]);
		expect(membersOf('Q')).toEqual([]);
	});

	it('a new content row at the linked file is the same file re-added: the link re-homes', async () => {
		seedTrack([FILE_A, FILE_B]);
		await pull([trackFrame('C1', FILE_A)]);
		const i = await pull([trackFrame('C7', FILE_A, { rating: 4 })]);
		expect(twinsOf(i)).toBe(0);
		expect(linkOf()).toEqual({ id: 'C7', path: FILE_A });
	});
});

describe('twin rekordbox entries: a track with no link links exactly one', () => {
	for (const order of ['twin first', 'primary first'] as const) {
		it(`the row at the primary file links, whatever the stream order (${order})`, async () => {
			seedTrack([FILE_A, FILE_B]);
			const primary = trackFrame('C900', FILE_A, { rating: 3 });
			const twin = trackFrame('C3', FILE_B, { rating: 5 });
			const i = await pull([
				...(order === 'twin first' ? [twin, primary] : [primary, twin]),
				playlistFrame('P', ['C3', 'C900']),
				mytagFrame('M2', ['C3']),
				cueFrame('C3', 1, 99),
				cueFrame('C900', 0, 10),
			]);
			expect(twinsOf(i)).toBe(1);
			expect(linkOf()).toEqual({ id: 'C900', path: FILE_A });
			expect(ratingOf()).toBe(3);
			expect(cueSlots()).toEqual([{ slot: 0, pos: 10 }]);
			expect(tagsOf()).toEqual([]);
			expect(membersOf('P')).toEqual([{ trackId: 't1', cid: 'C900' }]);
		});
	}

	it('with no row at the primary file, the lowest content id links (numeric order)', async () => {
		seedTrack([FILE_A, FILE_B, FILE_C]);
		const i = await pull([
			trackFrame('100', FILE_B, { rating: 5 }),
			trackFrame('20', FILE_C, { rating: 1 }),
		]);
		expect(twinsOf(i)).toBe(1);
		expect(linkOf()).toEqual({ id: '20', path: FILE_C });
		expect(ratingOf()).toBe(1);

		// The next pull carrying the other row: it is a twin of the linked one.
		const j = await pull([trackFrame('100', FILE_B, { rating: 5, rb_updated_at_ms: T_RB + 86_400_000 })]);
		expect(twinsOf(j)).toBe(1);
		expect(linkOf()).toEqual({ id: '20', path: FILE_C });
		expect(ratingOf()).toBe(1);
	});

	it('a missing primary file does not count as primary', async () => {
		seedTrack([FILE_A, FILE_B]);
		sqlite.prepare(`UPDATE source_link SET missing_at = 1 WHERE file_path = ?`).run(FILE_A);
		await pull([trackFrame('5', FILE_A), trackFrame('9', FILE_B)]);
		expect(linkOf()).toEqual({ id: '9', path: FILE_B });
	});
});
