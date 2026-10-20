// Re-running an identical rekordbox import must emit nothing to the op log,
// on every pull path: tracks (rating / overrides / rb key), playlists +
// folders + membership, MyTags, the cue merge, grids + phrases and play
// history. 2026-10-18: the
// history pass restated every session and play on each sync (87k pending
// ops after three syncs); this pins the whole importer against that shape.
// Real importer, migrated temp DB, stub sidecar replaying synthetic frames —
// never real data.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { RekordboxImporter, type ImportTotals, type RunImportOptions } from './importer.js';
import type { RekordboxSidecar } from './sidecar.js';

let dir: string;
let db: Db;
let sqlite: Database.Database;

type Frame = { event: string; row: Record<string, unknown> };

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

function runImport(frames: Frame[]): Promise<ImportTotals> {
	const importer = new RekordboxImporter(db, stubSidecar(frames));
	const opts: RunImportOptions = {
		mode: 'full',
		flags: { syncTracks: true, syncPlaylists: true, syncMyTags: true, syncCuesGridsPhrases: true, syncWaveformPeaks: false, syncHistory: true },
		dbPath: join(dir, 'master.db'), // never opened — stub sidecar
		peaksDir: join(dir, 'peaks'),
	};
	return importer.runImport(opts);
}

const T0 = Date.parse('2026-08-14T10:00:00Z');
const file = (n: number): string => join(dir, `track${n}.mp3`).replace(/\\/g, '/');

function seedLocalTrack(n: number): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state, updated_at) VALUES (?, ?, '[{"name":"A"}]', 'unsorted', 1000)`).run(`t${n}`, `Song ${n}`);
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path) VALUES (?, ?, 'local', ?, ?)`).run(`sl${n}`, `t${n}`, file(n), file(n));
}

function trackFrame(n: number, over: Record<string, unknown> = {}): Frame {
	return {
		event: 'track',
		row: {
			rb_content_id: `C${n}`, rb_local_usn: 10 + n, rb_local_deleted: false,
			rb_updated_at_ms: T0, rb_added_at_ms: T0 - 86_400_000, file_path: file(n),
			title: `Song ${n}`, artist: 'A', album: 'LP', genre: 'House', label: 'Lbl',
			bpm: 122 + n, key_camelot: '8A', key_musical: null, color_label: null,
			rating: n % 5, comment: null, play_count: n, last_played_at_ms: T0, duration_sec: 300,
			...over,
		},
	};
}

function frames(opts: { rating1?: number; extraPlay?: boolean } = {}): Frame[] {
	const out: Frame[] = [];
	for (let n = 1; n <= 4; n++) out.push(trackFrame(n, n === 1 && opts.rating1 !== undefined ? { rating: opts.rating1 } : {}));
	out.push({ event: 'playlist', row: { rb_playlist_id: 'F', rb_local_usn: 1, rb_local_deleted: false, parent_folder_id: null, name: 'Folder', is_folder: true, is_smart: false, position: 0, tracks: [] } });
	out.push({ event: 'playlist', row: { rb_playlist_id: 'P', rb_local_usn: 2, rb_local_deleted: false, parent_folder_id: 'F', name: 'Peak', is_folder: false, is_smart: false, position: 0, tracks: [3, 1, 2].map((n, i) => ({ rb_content_id: `C${n}`, position: i })) } });
	out.push({ event: 'playlist_index', row: { live_ids: ['F', 'P'], missing_ids: null } });
	out.push({ event: 'mytag', row: { rb_tag_id: 'G1', rb_local_usn: 3, rb_local_deleted: false, name: 'vocal', color: null, tracks: ['C1', 'C4'] } });
	for (const n of [1, 2]) {
		out.push({ event: 'cues', row: { rb_content_id: `C${n}`, rb_local_usn: 1, rb_local_deleted: false, slot: 0, kind: 'hot', position_sec: 12.5 + n, length_sec: null, color: null, name: null } });
		out.push({ event: 'cues', row: { rb_content_id: `C${n}`, rb_local_usn: 1, rb_local_deleted: false, slot: 1, kind: 'memory', position_sec: 40 + n, length_sec: null, color: null, name: 'drop' } });
	}
	// Grids + phrases (the waveform pass): restated on every full read.
	for (const n of [1, 2]) {
		const beats = Array.from({ length: 600 }, (_, k) => Math.round(90 + n + k * 468.75) / 1000);
		out.push({ event: 'waveform', row: { rb_content_id: `C${n}`, peaks_lo_path: null, peaks_hi_path: null, beatgrid_sec: beats, downbeats_sec: beats.filter((_, i) => i % 4 === 0),
			segments: [{ startSec: 0.09, endSec: 30, label: 'Intro 1', source: 'rekordbox', rbKind: 1 }] } });
	}
	const plays = [1, 2, 3].map((n, i) => ({ rb_song_history_id: `H1-${n}`, rb_content_id: `C${n}`, track_no: i + 1, created_at_ms: T0 + i * 20 * 60_000 }));
	if (opts.extraPlay) plays.push({ rb_song_history_id: 'H1-9', rb_content_id: 'C9', track_no: 4, created_at_ms: T0 + 60 * 60_000 });
	out.push({ event: 'history', row: { rb_history_id: 'H1', name: 'HISTORY 2026-08-14', date_created_ms: T0, plays } });
	out.push({ event: 'history', row: { rb_history_id: 'H2', name: 'HISTORY 2026-08-09 (1)', date_created_ms: T0, plays: [1, 2, 3, 4].map((n) => ({ rb_song_history_id: `H2-${n}`, rb_content_id: `C${n}`, track_no: n, created_at_ms: T0 })) } });
	return out;
}

const outbox = (): Array<{ entity: string; kind: string; entity_id: string }> =>
	sqlite.prepare(`SELECT entity, kind, entity_id FROM sync_outbox ORDER BY seq_local`).all() as Array<{ entity: string; kind: string; entity_id: string }>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-reimport-'));
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
	for (let n = 1; n <= 4; n++) seedLocalTrack(n);
});

afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

describe('rekordbox re-import emits nothing when nothing changed', () => {
	it('every pull path: tracks, playlists, membership, MyTags, cues, history', async () => {
		const first = await runImport(frames());
		const afterFirst = outbox();
		const byEntity = (ops: ReturnType<typeof outbox>) => new Set(ops.map((o) => o.entity));
		// The first import did reach every path that carries synced state.
		for (const e of ['library_track', 'playlist_folder', 'playlist', 'playlist_track', 'tag', 'track_tag', 'cue', 'play_session', 'play_event']) {
			expect(byEntity(afterFirst).has(e), e).toBe(true);
		}
		expect(first.historySessionsUpserted).toBe(2);
		expect(first.historyPlaysUpserted).toBe(7);

		expect(afterFirst.filter((o) => o.kind === 'set-rb-analysis')).toHaveLength(4 /* keys */ + 2 /* grids */ + 2 /* phrases */);

		const second = await runImport(frames());
		expect(outbox().slice(afterFirst.length)).toEqual([]);
		expect(second).toMatchObject({
			tracksMatched: 4,
			tracksUpdated: 0,
			cuesUpserted: 0,
			historySessionsUpserted: 0,
			historyPlaysUpserted: 0,
			historySessionsSeen: 2,
			historyPlaysSeen: 7,
		});

		// A real change still emits — and only that change.
		await runImport(frames({ rating1: 4, extraPlay: true }));
		const third = outbox().slice(afterFirst.length).map((o) => `${o.entity}.${o.kind}`);
		expect(third.sort()).toEqual(['library_track.set-rating', 'play_event.append', 'play_session.append']);
	});

	it('a play whose track appears later is emitted once, with its recording', async () => {
		await runImport(frames({ extraPlay: true }));
		const before = outbox().length;
		const play = sqlite.prepare(`SELECT id, track_id FROM play_event WHERE rb_song_history_id = 'H1-9'`).get() as { id: string; track_id: string | null };
		expect(play.track_id).toBeNull();

		// The track and its rekordbox link land (a later tracks pass).
		seedLocalTrack(9);
		sqlite.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at) VALUES ('t9', 'C9', 0, 0, 0)`).run();
		await runImport(frames({ extraPlay: true }));
		const added = sqlite.prepare(`SELECT entity, entity_id, payload FROM sync_outbox ORDER BY seq_local`).all().slice(before) as Array<{ entity: string; entity_id: string; payload: string }>;
		const events = added.filter((o) => o.entity === 'play_event');
		expect(events.map((o) => o.entity_id)).toEqual([play.id]);
		expect(JSON.parse(events[0]!.payload).recording_id).toBeTruthy();

		const settled = outbox().length;
		await runImport(frames({ extraPlay: true }));
		expect(outbox().length).toBe(settled);
	});
});
