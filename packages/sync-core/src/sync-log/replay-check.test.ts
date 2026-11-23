// The phase-0 exit check on a generated library shaped like a pre-op-log one
// (rows written directly, no records): the initial push must reproduce every
// table on a replica, and the source file must not change. Never the live
// library (CLAUDE.md).

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { INITIAL_PUSH_KEY } from './apply.js';
import { recordingIdForTrack } from './recording-id.js';
import { runReplayCheck } from './replay-check.js';
import { orderKeyAt } from '../test-support/playlist-track.js';

let dir: string;
const b0Of = (): number[] => Array.from({ length: 900 }, (_, k) => Math.round((0.087 + k * 0.46875) * 1000) / 1000);
afterEach(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ } });

function legacyLibrary(path: string): void {
	migrate(path);
	const db = new Database(path);
	const run = (sql: string, ...args: unknown[]): void => { db.prepare(sql).run(...args); };
	db.prepare(`DELETE FROM app_setting WHERE key = ?`).run(INITIAL_PUSH_KEY);
	for (let i = 0; i < 8; i++) {
		run(`INSERT INTO track (id, recording_id, title, artists, state, rating, overrides, created_at, updated_at) VALUES (?, ?, ?, '[{"name":"A"}]', 'unsorted', ?, ?, 1000, 2000)`,
			`t${i}`, recordingIdForTrack(`t${i}`), `T${i}`, i % 3 === 0 ? i % 6 : null, i === 1 ? '{"title":"Edited","bpm":124.5}' : null);
	}
	run(`UPDATE track SET deleted_at = 5000 WHERE id = 't7'`);
	// A curation stage away from the default, and a pre-op-log artist rename
	// (its parked alias) plus a curated spelling.
	run(`UPDATE track SET state = 'backlog', state_changed_at = 4200 WHERE id = 't2'`);
	run(`INSERT INTO artist (id, name, name_ascii, merged_into, name_curated_at, updated_at) VALUES ('ar1', 'New Name', 'newname', NULL, 4300, 4300), ('ar2', 'Old Name', 'oldname', 'ar1', NULL, 4300)`);
	// A derived WAV copy: device-local, must stay out of the op log.
	run(`INSERT INTO track (id, recording_id, title, artists, state, derived_from_track_id) VALUES ('wav', ?, 'T0 [WAV]', '[]', 'unsorted', 't0')`, recordingIdForTrack('wav'));
	run(`INSERT INTO tag (id, name, kind, color, created_at) VALUES ('g1', 'Groovy', 'user', '#123456', 3000), ('rb_7', 'Vocal', 'user', NULL, 3100)`);
	for (const [t, g] of [['t0', 'g1'], ['t1', 'g1'], ['t2', 'rb_7'], ['t3', 'interested'], ['wav', 'g1']]) run(`INSERT INTO track_tag (track_id, tag_id, added_at) VALUES (?, ?, 4000)`, t, g);
	run(`INSERT INTO playlist_folder (id, source, source_id, name) VALUES ('rb_100', 'rekordbox', '100', 'Gigs')`);
	run(`INSERT INTO playlist (id, source, source_id, name, parent_folder_id, is_favorite) VALUES ('pl', 'local', 'pl', 'Local set', NULL, 1),
		('rb_200', 'rekordbox', '200', 'Club night', 'rb_100', 0), ('sp', 'spotify', 'SPX', 'Spotify one', NULL, 0)`);
	run(`INSERT INTO playlist (id, source, source_id, name, is_smart) VALUES ('rb_300', 'rekordbox', '300', 'Smart', 1)`);
	run(`INSERT INTO playlist (id, source, source_id, name, derived_from_playlist_id) VALUES ('wavpl', 'local', 'wavpl', 'Local set [WAV]', 'pl')`);
	const member = (pl: string, t: string, pos: number): void => run(
		`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, source_track_id) VALUES (?, ?, ?, ?, ?, 4500, ?)`,
		`${pl}-${pos}`, pl, t, orderKeyAt(pos), pos, t);
	['t0', 't1', 't2', 't0', 'wav', 't4'].forEach((t, i) => member('pl', t, i));
	['t3', 't4', 't5'].forEach((t, i) => member('rb_200', t, i));
	['t6', 't7'].forEach((t, i) => member('sp', t, i));
	member('wavpl', 'wav', 0);
	run(`INSERT INTO cue (id, track_id, slot, position_sec, length_sec, color, name, kind) VALUES
		('c1', 't0', 0, 10.5, NULL, '#ff0000', 'A', 'hot'), ('c2', 't0', 1, 20, 8, NULL, NULL, 'hot'), ('c3', 't2', 0, 1, NULL, NULL, 'mem', 'memory')`);
	run(`INSERT INTO pinned_search (id, name, query, sort_column, sort_dir, position) VALUES ('ps', 'Fast', 'bpm:>128', 'bpm', 'desc', 0)`);
	run(`INSERT INTO play_session (id, origin, kind, started_at) VALUES ('s1', 'curator', 'prep', 6000)`);
	run(`INSERT INTO play_event (id, session_id, track_id, source, played_at, played_ms) VALUES ('e1', 's1', 't0', 'local', 6000, 1000)`);
	run(`INSERT INTO app_setting (key, value, updated_at) VALUES ('credit_format', '{"separator":"/","remixStyle":"dash"}', 7000)`);
	// The rekordbox slot: a full one, a key-only placeholder, a recorded
	// mix whose grid is too large for an op (device-local), and the WAV
	// copy's grafted slot (device-local).
	const f32 = (xs: number[]): Buffer => Buffer.from(new Float32Array(xs).buffer);
	const beats = (n: number, start = 0.087): number[] => Array.from({ length: n }, (_, k) => Math.round((start + k * 0.46875) * 1000) / 1000);
	const ta = db.prepare(`INSERT INTO track_analysis (track_id, analyzer_version, analyzed_at, rb_beatgrid, rb_downbeats, rb_key_camelot, rb_segments_json) VALUES (?, 'rekordbox', 8000, ?, ?, ?, ?)`);
	const b0 = beats(900);
	ta.run('t0', f32(b0), f32(b0.filter((_, i) => i % 4 === 0)), '8A', JSON.stringify([{ startSec: 0.087, endSec: 30.1, label: 'Intro 1', source: 'rekordbox', rbKind: 1 }]));
	ta.run('t1', null, null, '11B', null);
	const mix = beats(12_000);
	ta.run('t5', f32(mix), f32(mix.filter((_, i) => i % 4 === 0)), '2A', null);
	ta.run('wav', f32(b0), null, '8A', null);
	db.close();
}

describe('runReplayCheck', () => {
	it('reproduces a pre-op-log library from its initial push, leaving the source untouched', () => {
		dir = mkdtempSync(join(tmpdir(), 'curator-replaycheck-'));
		const src = join(dir, 'library.db');
		legacyLibrary(src);
		const hash = (): string => createHash('sha256').update(readFileSync(src)).digest('hex');
		const before = hash();

		const report = runReplayCheck(src, join(dir, 'work'), { batch: 25 });
		expect(report.replicaVsCopy.filter((r) => !r.equal)).toEqual([]);
		expect(report.reducerVsReplica.filter((r) => !r.equal)).toEqual([]);
		expect(report.equal).toBe(true);
		expect(hash()).toBe(before);
		expect(report.push.byEntity['library_track']).toBeGreaterThan(0);

		// Device-local rows stayed out; the rest of each kind made it in.
		const copy = new Database(report.copyPath, { readonly: true });
		const ids = copy.prepare(`SELECT entity, entity_id FROM sync_outbox`).all() as Array<{ entity: string; entity_id: string }>;
		copy.close();
		expect(ids.some((o) => o.entity_id === 'wavpl' || o.entity_id === 'rb_300' || o.entity_id.includes(recordingIdForTrack('wav')))).toBe(false);
		// rb units: t0's grid/key/phrases, t1's key, t5's key (its grid is
		// over the cap and stays device-local, on both sides of the compare).
		const rb = report.replicaVsCopy.find((r) => r.table === 'rbAnalysis')!;
		expect(rb.left).toBe(3);
		const rbOps = (() => { const c = new Database(report.copyPath, { readonly: true }); try { return c.prepare(`SELECT entity_id, payload FROM sync_outbox WHERE kind = 'set-rb-analysis'`).all() as Array<{ entity_id: string; payload: string }>; } finally { c.close(); } })();
		expect(rbOps.map((o) => JSON.parse(o.payload).unit).sort()).toEqual(['grid', 'key', 'key', 'key', 'segments']);
		expect(rbOps.some((o) => o.entity_id === recordingIdForTrack('t5') && JSON.parse(o.payload).unit === 'grid')).toBe(false);
		const replica = new Database(report.replicaPath, { readonly: true });
		const slot = replica.prepare(`SELECT rb_beatgrid, rb_key_camelot FROM track_analysis WHERE track_id = 't0'`).get() as { rb_beatgrid: Buffer; rb_key_camelot: string };
		replica.close();
		expect(slot.rb_beatgrid.equals(Buffer.from(new Float32Array(b0Of()).buffer))).toBe(true);
		expect(slot.rb_key_camelot).toBe('8A');
		expect(report.push.byEntity).toMatchObject({ tag: 4, playlist: 4 /* 3 creates + 1 favourite */, playlist_folder: 1, playlist_track: 10, track_tag: 4, cue: 3, pinned_search: 1, play_session: 1, play_event: 1, setting: 1, artist_alias: 2 });

		// A second run on the same work dir refuses rather than overwrite.
		expect(() => runReplayCheck(src, join(dir, 'work'))).toThrow(/refusing/);
	});
});
