// emitOps / the reducer records / applyOps on generated DBs (never the live
// library — CLAUDE.md).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOps as reduceOps, createLibraryState, materialize, OpValidationError, parseOp } from '@curator/protocol';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import type Database from 'better-sqlite3';
import { CLOCK_KEY, emitOps, readOutbox } from './outbox.js';
import { applyOps, INITIAL_PUSH_KEY, SyncRecordsIncompleteError } from './apply.js';
import { initialPush } from './initial-push.js';
import { compareDumps, dumpLibrary, dumpView } from './dump.js';
import { recordingIdForTrack } from './recording-id.js';
import * as m from '../library/mutators.js';

let dir: string;
const open: Array<Database.Database> = [];

function freshDb(name: string): { db: Db; raw: Database.Database } {
	const p = join(dir, `${name}.db`);
	migrate(p);
	const { db, sqlite } = createDb(p);
	open.push(sqlite);
	return { db, raw: sqlite };
}

function seedTracks(raw: Database.Database, ids: string[]): void {
	const ins = raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state) VALUES (?, ?, ?, '[{"name":"A"}]', 'unsorted')`);
	for (const id of ids) ins.run(id, recordingIdForTrack(id), `T ${id}`);
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-outbox-')); });
afterEach(() => {
	for (const s of open.splice(0)) s.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

describe('emitOps', () => {
	it('refuses to run outside a transaction', () => {
		const { raw } = freshDb('a');
		expect(() => emitOps(raw, [{ entity: 'tag', entity_id: 't1', kind: 'create', payload: { name: 'x', kind: 'user' } }])).toThrow(/transaction/);
	});

	it('a payload the protocol refuses rolls the write back with it', () => {
		const { raw } = freshDb('a');
		const write = raw.transaction(() => {
			raw.prepare(`INSERT INTO tag (id, name, kind) VALUES ('t1', 'x', 'user')`).run();
			emitOps(raw, [{ entity: 'tag', entity_id: 't1', kind: 'create', payload: { name: '', kind: 'user' } }]);
		});
		expect(() => write()).toThrow(OpValidationError);
		expect(raw.prepare(`SELECT count(*) AS n FROM tag WHERE id = 't1'`).get()).toEqual({ n: 0 });
		expect(raw.prepare(`SELECT count(*) AS n FROM sync_outbox`).get()).toEqual({ n: 0 });
	});

	it('stamps a monotonic clock and seq that survive a reopen', () => {
		const p = join(dir, 'c.db');
		migrate(p);
		let { db, sqlite } = createDb(p);
		m.createTag(db, { id: 't1', name: 'one' });
		m.renameTag(db, 't1', 'two');
		sqlite.close();
		({ db, sqlite } = createDb(p));
		open.push(sqlite);
		// A clock row that claims the future: the next stamp must still rise.
		const c = JSON.parse((sqlite.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(CLOCK_KEY) as { value: string }).value);
		sqlite.prepare(`UPDATE app_setting SET value = ? WHERE key = ?`).run(JSON.stringify({ ...c, lastIssuedTs: Date.now() + 60_000 }), CLOCK_KEY);
		m.renameTag(db, 't1', 'three');
		const ops = readOutbox(sqlite);
		expect(ops.map((o) => o.kind)).toEqual(['create', 'rename', 'rename']);
		const seq = sqlite.prepare(`SELECT seq_local FROM sync_outbox ORDER BY seq_local`).pluck().all();
		expect(seq).toEqual([1, 2, 3]);
		expect(ops[1]!.client_ts).toBeGreaterThan(ops[0]!.client_ts);
		expect(ops[2]!.client_ts).toBeGreaterThan(Date.now() + 59_000);
		for (const o of ops) expect(() => parseOp(o)).not.toThrow();
	});

	it('records a delete in tombstone with its whole clock', () => {
		const { db, raw } = freshDb('a');
		m.createTag(db, { id: 't1', name: 'one' });
		m.deleteTag(db, 't1');
		const t = raw.prepare(`SELECT entity, entity_id, client_ts, device_id, op_id FROM tombstone`).all() as Array<Record<string, unknown>>;
		expect(t).toHaveLength(1);
		expect(t[0]).toMatchObject({ entity: 'tag', entity_id: 't1' });
		expect(t[0]!['op_id']).toBe(readOutbox(raw)[1]!.op_id);
	});

	it('records a pre-sync container the first time an op references it', () => {
		const { db, raw } = freshDb('a');
		seedTracks(raw, ['k1']);
		raw.prepare(`INSERT INTO tag (id, name, kind, color) VALUES ('legacy', 'Old', 'user', '#f00')`).run();
		m.tagTracks(db, ['k1'], 'legacy');
		m.tagTracks(db, ['k1'], 'interested');
		const ops = readOutbox(raw);
		expect(ops.map((o) => `${o.entity}.${o.kind}:${o.entity_id.split(':').pop()}`)).toEqual([
			'tag.create:legacy', 'track_tag.add:legacy', 'tag.create:interested', 'track_tag.add:interested',
		]);
		expect(ops[0]!.payload).toEqual({ name: 'Old', kind: 'user', color: '#f00' });
	});
});

describe('emitOps no-op suppression', () => {
	const rec = recordingIdForTrack('k1');
	const emit = (raw: Database.Database, ops: Parameters<typeof emitOps>[1], opts?: Parameters<typeof emitOps>[2]) => raw.transaction(() => emitOps(raw, ops, opts))();

	it('drops an op that only restates a recorded value, without consuming a seq', () => {
		const { db, raw } = freshDb('a');
		m.createTag(db, { id: 't1', name: 'one' });
		expect(emit(raw, [{ entity: 'tag', entity_id: 't1', kind: 'rename', payload: { name: 'one' } }])).toEqual([]);
		expect(emit(raw, [{ entity: 'tag', entity_id: 't1', kind: 'create', payload: { name: 'one', kind: 'user', color: null } }])).toEqual([]);
		m.renameTag(db, 't1', 'two');
		expect(readOutbox(raw).map((o) => o.kind)).toEqual(['create', 'rename']);
		expect(raw.prepare(`SELECT seq_local FROM sync_outbox ORDER BY seq_local`).pluck().all()).toEqual([1, 2]);
	});

	it('still emits for a record the op log has not seen (a row from before it)', () => {
		const { raw } = freshDb('a');
		seedTracks(raw, ['k1']);
		raw.prepare(`UPDATE track SET rating = 3 WHERE id = 'k1'`).run();
		const op = { entity: 'library_track' as const, entity_id: rec, kind: 'set-rating' as const, payload: { rating: 3 } };
		expect(emit(raw, [op])).toHaveLength(1);
		expect(emit(raw, [op])).toEqual([]);
		expect(emit(raw, [{ ...op, payload: { rating: 4 } }])).toHaveLength(1);
	});

	it('judges each op of a batch against the ones before it', () => {
		const { db, raw } = freshDb('a');
		seedTracks(raw, ['k1']);
		m.createTag(db, { id: 't1', name: 'one' });
		const id = `${rec}:t1`;
		const ops = emit(raw, [
			{ entity: 'track_tag', entity_id: id, kind: 'add', payload: {} },
			{ entity: 'track_tag', entity_id: id, kind: 'add', payload: {} },
			{ entity: 'track_tag', entity_id: id, kind: 'remove', payload: {} },
			{ entity: 'track_tag', entity_id: id, kind: 'add', payload: {} },
		]);
		expect(ops.map((o) => o.kind)).toEqual(['add', 'remove', 'add']);
	});

	it('never drops a same-clock re-assert (the merge relies on its clock, not its value)', () => {
		const { raw } = freshDb('a');
		seedTracks(raw, ['k1']);
		const op = { entity: 'library_track' as const, entity_id: rec, kind: 'set-rating' as const, payload: { rating: 3 } };
		emit(raw, [op]);
		expect(emit(raw, [op], { sameClock: true })).toHaveLength(1);
	});
});

describe('startup ISRC dedup (scenario 14)', () => {
	it('emits recording.merge plus the survivor re-assert, so other devices fold the same rows', () => {
		const p = join(dir, 'dedup.db');
		migrate(p);
		const raw0 = createDb(p).sqlite;
		raw0.prepare(`INSERT INTO track (id, recording_id, title, artists, state, isrc, duration, created_at) VALUES ('old', ?, 'X', '[]', 'unsorted', 'GBAAA1600001', 300, 1)`).run(recordingIdForTrack('old'));
		raw0.prepare(`INSERT INTO track (id, recording_id, title, artists, state, isrc, duration, created_at, rating) VALUES ('dup', ?, 'X', '[]', 'unsorted', 'GBAAA1600001', 301, 2, 5)`).run(recordingIdForTrack('dup'));
		raw0.prepare(`INSERT INTO cue (id, track_id, slot, position_sec, kind) VALUES ('c', 'dup', 4, 9, 'hot')`).run();
		raw0.close();
		migrate(p);
		const { sqlite } = createDb(p);
		open.push(sqlite);
		const ops = readOutbox(sqlite);
		const merge = ops.find((o) => o.entity === 'recording');
		expect(merge).toMatchObject({ kind: 'merge', entity_id: recordingIdForTrack('dup'), payload: { winner: recordingIdForTrack('old') } });
		// The dupe's cue slot is gone locally (hard delete), so its delete is
		// stated for the survivor at the merge clock, as is the survivor's
		// (absent) rating.
		const sameClock = ops.filter((o) => o.client_ts === merge!.client_ts);
		expect(sameClock.some((o) => o.entity === 'cue' && o.kind === 'delete' && o.entity_id === `${recordingIdForTrack('old')}:4:hot`)).toBe(true);
		expect(sameClock.some((o) => o.entity === 'library_track' && o.kind === 'set-rating')).toBe(true);
		expect(sqlite.prepare(`SELECT loser, winner FROM recording_alias`).all()).toEqual([{ loser: recordingIdForTrack('dup'), winner: recordingIdForTrack('old') }]);
	});
});

describe('applyOps', () => {
	it('refuses a library whose rows the op log has not recorded', () => {
		// A library that had rows before the op log: migrate() leaves it
		// unmarked (only an empty one is born complete).
		const p = join(dir, 'legacy.db');
		migrate(p);
		const { sqlite: raw } = createDb(p);
		open.push(raw);
		raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(INITIAL_PUSH_KEY);
		raw.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES ('p', 'local', 'p', 'P')`).run();
		// Re-migrating a non-empty library must not mark it either.
		migrate(p);
		expect(() => applyOps(raw, [])).toThrow(SyncRecordsIncompleteError);
		// The initial push records the playlist and lifts the guard.
		const pushed = initialPush(raw);
		expect(pushed.byEntity['playlist']).toBe(1);
		expect(() => applyOps(raw, [])).not.toThrow();
	});

	it('skips this device\'s own ops and is idempotent', () => {
		const a = freshDb('a');
		m.createTag(a.db, { id: 't1', name: 'one' });
		const ops = readOutbox(a.raw);
		expect(applyOps(a.raw, ops)).toMatchObject({ applied: 0, skippedOwn: 1 });
		const b = freshDb('b');
		expect(applyOps(b.raw, ops).applied).toBe(1);
		const once = dumpLibrary(b.raw);
		applyOps(b.raw, ops);
		expect(dumpLibrary(b.raw)).toEqual(once);
		expect(once.tags.find((t) => t.id === 't1')).toMatchObject({ name: 'one' });
	});

	it('converges in any order, including edits before their creates', () => {
		const a = freshDb('a');
		const tracks = ['k1', 'k2', 'k3'];
		seedTracks(a.raw, tracks);
		m.createPlaylist(a.db, { id: 'p1', source: 'local', sourceId: 'p1', name: 'P' });
		m.addMembers(a.db, 'p1', tracks.map((t) => ({ playlistId: 'p1', trackId: t, addedAt: new Date(), sourceTrackId: t })));
		const rows = a.raw.prepare(`SELECT id FROM playlist_track ORDER BY position`).pluck().all() as string[];
		m.reorderMembers(a.db, 'p1', [...rows].reverse());
		m.removeMemberRows(a.db, 'p1', [rows[1]!]);
		m.renamePlaylist(a.db, 'p1', 'Renamed');
		m.createTag(a.db, { id: 't1', name: 'one' });
		m.tagTracks(a.db, ['k1', 'k2'], 't1');
		m.untagTracks(a.db, ['k2'], 't1');
		m.setRating(a.db, ['k1'], 4);
		const ops = readOutbox(a.raw);
		const want = dumpLibrary(a.raw);
		for (let round = 0; round < 6; round++) {
			const b = freshDb(`b${round}`);
			seedTracks(b.raw, tracks);
			const shuffled = [...ops].sort(() => Math.random() - 0.5);
			// Two batches, so a create can land in a later transaction than
			// the edits that depend on it.
			applyOps(b.raw, shuffled.slice(0, Math.floor(shuffled.length / 2)));
			applyOps(b.raw, shuffled.slice(Math.floor(shuffled.length / 2)));
			const got = dumpLibrary(b.raw);
			expect(compareDumps(want, got).filter((r) => !r.equal)).toEqual([]);
		}
		const view = dumpView(materialize(reduceOps(createLibraryState(), ops).state));
		const tagsOnly = (d: ReturnType<typeof dumpLibrary>) => ({ ...d, tags: d.tags.filter((t) => t.kind !== 'system') });
		expect(compareDumps(tagsOnly(want), tagsOnly(view)).filter((r) => !r.equal)).toEqual([]);
	});
});
