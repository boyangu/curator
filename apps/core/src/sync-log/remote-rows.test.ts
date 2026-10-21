// Base metadata sync and remote rows, unit by unit (cloud plan: streaming
// identity §3, stage 2): what a row states (track-meta.ts), the dirty
// triggers and the baseline (migrate.ts, track_meta_seen), the drain and
// its backfill, the master-first pick, and the remote rows materialised
// from it (remote-rows.ts) — made, refreshed, re-picked, absorbed by an own
// row, dropped by a merge, kept out of the identity resolver, the claim
// binder's first step and the initial push. Cross-device behaviour is in
// two-desktops-catalogue.test.ts (scenarios 17, 18). Generated temp DBs only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { MASTER_DEVICE_SETTING, opSchemaVersion, rebalance, type TrackMeta } from '@curator/protocol';
import { createDb, type Db } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import * as mut from '../library/mutators.js';
import { applyOps, INITIAL_PUSH_KEY } from './apply.js';
import { bindByClaim, projectAdoptedRecordings } from './claim-bind.js';
import { planIdentityMerges } from './identity.js';
import { initialPush } from './initial-push.js';
import { readOutbox } from './outbox.js';
import { recordingIdForTrack } from './recording-id.js';
import { INLINE_CREATE_ROWS, MATERIALIZE_KEY, materializeSwept, remotePendingCount, remoteRowCount } from './remote-rows.js';
import { drainRemotePendingAsync, sweepRemoteRowsAsync } from './remote-sweep.js';
import { loadSnapshot, recordsFromState } from './snapshot.js';
import { remoteTrackId } from './stable-ids.js';
import {
	defaultMasterDevice, drainTrackMeta, masterDevice, queueTrackMetaBackfillAsync, setMasterDevice, trackMetaBackfillPending, trackMetaDirtyCount, trackMetaOf, TRACK_META_BACKFILL_KEY,
} from './track-meta.js';
import { applyOp, createLibraryState, parseOp } from '@curator/protocol';

const R = recordingIdForTrack;

let dir: string;
const handles: Database.Database[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-remote-rows-')); });
afterEach(() => {
	for (const h of handles.splice(0)) h.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

function freshDb(name = 'lib'): { path: string; raw: Database.Database; db: Db } {
	const path = join(dir, `${name}.db`);
	migrate(path);
	const { db, sqlite } = createDb(path);
	handles.push(sqlite);
	return { path, raw: sqlite, db };
}

function insertTrack(raw: Database.Database, id: string, cols: { title?: string; artists?: unknown; artists_base?: string | null; cover?: string | null; recording?: string; derived?: string } = {}): void {
	raw.prepare(`INSERT INTO track (id, recording_id, title, artists, artists_base, cover_url, state, duration, derived_from_track_id, added_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, 'unsorted', 300, ?, 1650000000000, 1650000000000)`)
		.run(id, cols.recording ?? R(id), cols.title ?? `Title ${id}`, JSON.stringify(cols.artists ?? [{ name: 'Artist' }]), cols.artists_base ?? null, cols.cover ?? null, cols.derived ?? null);
}
function link(raw: Database.Database, trackId: string, source: string, value = `${source}-${trackId}`): void {
	raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES (?, ?, ?, ?, 1660000000000)`).run(randomUUID(), trackId, source, value);
}

let clockTs = 1_760_000_000_000;
function op(device: string, entity: string, entityId: string, kind: string, payload: unknown, ts = clockTs++): Record<string, unknown> {
	return { op_id: randomUUID(), device_id: device, client_ts: ts, schema_version: opSchemaVersion({ entity, kind, entity_id: entityId }), entity, entity_id: entityId, kind, payload };
}
function meta(title: string, extra: Partial<TrackMeta> = {}): TrackMeta {
	return { source: 'spotify', title, artists: [{ name: `${title} Artist` }], album_title: `${title} Album`, duration_sec: 240, isrc: null, release_date: '2024', label: null, genre: 'House', cover_url: 'https://i.example/x.jpg', track_number: 2, disc_number: 1, ...extra };
}
const created = (device: string, rec: string): Record<string, unknown> => op(device, 'library_track', rec, 'create', { added_at: 1_755_000_000_000 });
const setMeta = (device: string, rec: string, m: TrackMeta): Record<string, unknown> => op(device, 'library_track', rec, 'set-meta', m);
const master = (device: string, value: string): Record<string, unknown> => op(device, 'setting', MASTER_DEVICE_SETTING, 'set', { value });
const remoteRec = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const rowsOf = (raw: Database.Database, rec: string): Array<{ id: string; remote_only: number; title: string }> =>
	raw.prepare(`SELECT id, remote_only, title FROM track WHERE recording_id = ? ORDER BY remote_only, id`).all(rec) as never;

// ── what a row states ───────────────────────────────────────────────────────

describe('track meta: the payload', () => {
	it('states the source credits (artists_base), an http(s) cover only, and the best source', () => {
		const row = {
			id: 't', recording_id: 'r', title: 'Song', album_title: '', duration: 241.6, isrc: 'GBAAA2600001', release_date: '2021', label: 'L', genre: null,
			artists: JSON.stringify([{ name: 'Ben Böhmer' }]),
			// A rule renamed "Ben Bohmer" → "Ben Böhmer" here; the source said the former.
			artists_base: JSON.stringify({ list: [{ name: 'Ben Bohmer' }], of: JSON.stringify([['Ben Böhmer']]) }),
			cover_url: 'C:\\covers\\x.jpg', track_number: 3, disc_number: null,
		};
		const m = trackMetaOf(row, new Set(['spotify', 'local']))!;
		expect(m).toEqual({ source: 'local', title: 'Song', artists: [{ name: 'Ben Bohmer' }], album_title: null, duration_sec: 242, isrc: 'GBAAA2600001', release_date: '2021', label: 'L', genre: null, cover_url: null, track_number: 3, disc_number: null });
		expect(trackMetaOf({ ...row, cover_url: 'https://i.scdn.co/a' }, new Set(['tidal']))).toMatchObject({ source: 'tidal', cover_url: 'https://i.scdn.co/a' });
		expect(trackMetaOf(row, new Set())!.source).toBe('other');
		// A stale base cell (its `of` no longer matches) reads as the credits.
		expect(trackMetaOf({ ...row, artists: JSON.stringify([{ name: 'Someone Else' }]) }, new Set())!.artists).toEqual([{ name: 'Someone Else' }]);
	});
});

// ── the dirty triggers and the drain ────────────────────────────────────────

describe('track meta: triggers, drain, baseline', () => {
	it('marks own rows on insert, meta-column updates and link changes — never remote or derived rows, never other columns', () => {
		const { raw } = freshDb();
		insertTrack(raw, 'own');
		insertTrack(raw, 'copy', { derived: 'own' });
		raw.prepare(`INSERT INTO track (id, recording_id, title, artists, remote_only) VALUES ('rem', ?, 'Remote', '[]', 1)`).run(R('rem'));
		expect(raw.prepare(`SELECT track_id FROM track_meta_dirty ORDER BY track_id`).pluck().all()).toEqual(['own']);
		raw.prepare(`DELETE FROM track_meta_dirty`).run();
		raw.prepare(`UPDATE track SET rating = 5, play_count = 3, updated_at = 9 WHERE id = 'own'`).run();
		expect(trackMetaDirtyCount(raw)).toBe(0);
		raw.prepare(`UPDATE track SET label = 'New' WHERE id = 'own'`).run();
		raw.prepare(`UPDATE track SET title = 'X' WHERE id IN ('copy', 'rem')`).run();
		expect(raw.prepare(`SELECT track_id FROM track_meta_dirty`).pluck().all()).toEqual(['own']);
		raw.prepare(`DELETE FROM track_meta_dirty`).run();
		link(raw, 'own', 'spotify');
		expect(raw.prepare(`SELECT track_id FROM track_meta_dirty`).pluck().all()).toEqual(['own']);
	});

	it('a source arriving on a remote row makes it an own row, which then states its meta', () => {
		const { raw } = freshDb();
		raw.prepare(`INSERT INTO track (id, recording_id, title, artists, remote_only, remote_source) VALUES ('rem', ?, 'Remote', '[]', 1, 'local')`).run(R('rem'));
		link(raw, 'rem', 'local');
		expect(raw.prepare(`SELECT remote_only FROM track WHERE id = 'rem'`).pluck().get()).toBe(0);
		expect(raw.prepare(`SELECT track_id FROM track_meta_dirty`).pluck().all()).toEqual(['rem']);
		// An enrichment link is catalogue data, not a source here.
		raw.prepare(`INSERT INTO track (id, recording_id, title, artists, remote_only) VALUES ('rem3', ?, 'Remote', '[]', 1)`).run(R('rem3'));
		link(raw, 'rem3', 'beatport');
		expect(raw.prepare(`SELECT remote_only FROM track WHERE id = 'rem3'`).pluck().get()).toBe(1);
		raw.prepare(`INSERT INTO track (id, recording_id, title, artists, remote_only) VALUES ('rem2', ?, 'Remote', '[]', 1)`).run(R('rem2'));
		raw.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at) VALUES ('rem2', '1', 1, 1)`).run();
		expect(raw.prepare(`SELECT remote_only FROM track WHERE id = 'rem2'`).pluck().get()).toBe(0);
	});

	it('the drain states each recording once from its primary own row, then only real changes; a merge loser is silent', () => {
		const { raw } = freshDb();
		insertTrack(raw, 'a', { title: 'Alpha' });
		insertTrack(raw, 'b', { title: 'Beta' });
		// A second own copy of b's recording (a local duplicate): b speaks.
		insertTrack(raw, 'b2', { title: 'Beta copy', recording: R('b') });
		raw.prepare(`UPDATE track SET created_at = created_at + 1 WHERE id = 'b2'`).run();
		insertTrack(raw, 'gone', { title: 'Merged away' });
		raw.prepare(`INSERT INTO recording_alias (loser, winner) VALUES (?, ?)`).run(R('gone'), R('a'));
		const r = drainTrackMeta(raw);
		expect(r).toMatchObject({ rows: 4, emitted: 2, done: true });
		const ops = readOutbox(raw).filter((o) => o.kind === 'set-meta');
		expect(ops.map((o) => [o.entity_id, (o.payload as TrackMeta).title, o.schema_version]).sort()).toEqual([[R('a'), 'Alpha', 3], [R('b'), 'Beta', 3]].sort());
		// A restatement is a read, not an op.
		raw.prepare(`UPDATE track SET title = 'Alpha' WHERE id = 'a'`).run();
		expect(drainTrackMeta(raw).emitted).toBe(0);
		raw.prepare(`UPDATE track SET title = 'Alpha (Remastered)' WHERE id = 'a'`).run();
		expect(drainTrackMeta(raw).emitted).toBe(1);
		expect(trackMetaDirtyCount(raw)).toBe(0);
	});

	it('the backfill queues every own row once, after the initial push', async () => {
		const { raw } = freshDb();
		for (let i = 0; i < 7; i++) insertTrack(raw, `t${i}`);
		raw.prepare(`DELETE FROM track_meta_dirty`).run();
		raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(INITIAL_PUSH_KEY);
		expect(trackMetaBackfillPending(raw)).toBe(false);
		raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, '1', 1)`).run(INITIAL_PUSH_KEY);
		expect(trackMetaBackfillPending(raw)).toBe(true);
		expect(await queueTrackMetaBackfillAsync(raw, { page: 3 })).toBe(7);
		expect(trackMetaBackfillPending(raw)).toBe(false);
		expect(raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(TRACK_META_BACKFILL_KEY)).toBeDefined();
		expect(drainTrackMeta(raw).emitted).toBe(7);
	});
});

// ── the master device ───────────────────────────────────────────────────────

describe('master device', () => {
	it('defaults to the earliest-registered device still on the account', () => {
		expect(defaultMasterDevice([
			{ deviceId: 'b', registeredAt: 20, revokedAt: null },
			{ deviceId: 'a', registeredAt: 10, revokedAt: 15 },
			{ deviceId: 'c', registeredAt: 20, revokedAt: null },
		])).toBe('b');
		expect(defaultMasterDevice([])).toBeNull();
	});

	it('is stated as an account setting (op + mirror) and read from the records', () => {
		const { raw } = freshDb();
		expect(masterDevice(raw)).toBeNull();
		setMasterDevice(raw, 'dev-main');
		expect(masterDevice(raw)).toBe('dev-main');
		expect(raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).pluck().get(MASTER_DEVICE_SETTING)).toBe('"dev-main"');
		const [o] = readOutbox(raw);
		expect(o).toMatchObject({ entity: 'setting', entity_id: MASTER_DEVICE_SETTING, kind: 'set', payload: { value: 'dev-main' }, schema_version: 3 });
	});
});

// ── remote rows ─────────────────────────────────────────────────────────────

describe('remote rows', () => {
	const PL = 'pl-1';
	const keys = rebalance(4);

	it('a recording with meta and no row here gets a remote row, with its records projected onto it', () => {
		const { raw } = freshDb();
		const rec = remoteRec(1);
		applyOps(raw, [
			op('dev-x', 'tag', 'tg', 'create', { name: 'Peak', kind: 'user', color: null }),
			op('dev-x', 'playlist', PL, 'create', { name: 'Mix', folder_id: null, source_link: null }),
			op('dev-x', 'artist_alias', 'bohmer', 'set', { from: 'Bohmer', to: 'Böhmer', to_key: 'bohmer' }),
			created('dev-x', rec),
			setMeta('dev-x', rec, meta('Lilac', { artists: [{ name: 'Bohmer' }, { name: 'Friend', role: 'featured' }] })),
			op('dev-x', 'library_track', rec, 'set-rating', { rating: 4 }),
			op('dev-x', 'library_track', rec, 'set-override', { field: 'genre', value: 'Deep House' }),
			op('dev-x', 'track_tag', `${rec}:tg`, 'add', {}),
			op('dev-x', 'playlist_track', 'row-1', 'add', { playlist_id: PL, recording_id: rec, order_key: keys[0] }),
		]);
		const id = remoteTrackId(rec);
		const t = raw.prepare(`SELECT * FROM track WHERE id = ?`).get(id) as Record<string, unknown>;
		expect(t).toMatchObject({
			recording_id: rec, remote_only: 1, remote_source: 'spotify', title: 'Lilac', album_title: 'Lilac Album', duration: 240, genre: 'House', release_date: '2024',
			cover_url: 'https://i.example/x.jpg', track_number: 2, disc_number: 1, rating: 4, added_at: 1_755_000_000_000, title_ascii: 'lilac',
		});
		// Credits through the converged rule, the source spelling kept beside.
		expect(JSON.parse(t['artists'] as string)).toEqual([{ name: 'Böhmer' }, { name: 'Friend', role: 'featured' }]);
		expect(JSON.parse(t['artists_base'] as string).list).toEqual([{ name: 'Bohmer' }, { name: 'Friend', role: 'featured' }]);
		expect(JSON.parse(t['overrides'] as string)).toEqual({ genre: 'Deep House' });
		expect(raw.prepare(`SELECT tag_id FROM track_tag WHERE track_id = ?`).pluck().all(id)).toEqual(['tg']);
		expect(raw.prepare(`SELECT id FROM playlist_track WHERE track_id = ?`).pluck().all(id)).toEqual(['row-1']);
		// Its artist junction (derived inline for a handful).
		expect(raw.prepare(`SELECT count(*) FROM track_artist WHERE track_id = ?`).pluck().get(id)).toBe(2);
		// Nothing of it is this device's to state.
		expect(trackMetaDirtyCount(raw)).toBe(0);
		expect(remoteRowCount(raw)).toBe(1);
	});

	it('no meta: no row; a deleted recording gets a deleted row (followed playlists show it with the chip); delete and undelete reach it', () => {
		const { raw } = freshDb();
		const [a, b, c] = [remoteRec(1), remoteRec(2), remoteRec(3)];
		applyOps(raw, [created('dev-x', a), created('dev-x', b), setMeta('dev-x', b, meta('B')), op('dev-x', 'library_track', b, 'delete', {}), created('dev-x', c), setMeta('dev-x', c, meta('C'))]);
		const deleted = (rec: string): number => raw.prepare(`SELECT deleted_at IS NOT NULL FROM track WHERE recording_id = ?`).pluck().get(rec) as number;
		expect(rowsOf(raw, a)).toEqual([]);
		expect(rowsOf(raw, b).map((r) => r.title)).toEqual(['B']);
		expect(deleted(b)).toBe(1);
		expect(deleted(c)).toBe(0);
		applyOps(raw, [op('dev-x', 'library_track', c, 'delete', {}), op('dev-x', 'library_track', b, 'undelete', {})]);
		expect(deleted(c)).toBe(1);
		expect(deleted(b)).toBe(0);
		expect(remoteRowCount(raw)).toBe(1);
	});

	it('shows the master\'s meta wherever it has one; a newer meta refreshes the row; a master change re-picks in the sweep', async () => {
		const { raw } = freshDb();
		const [a, b] = [remoteRec(1), remoteRec(2)];
		applyOps(raw, [
			master('dev-m', 'dev-m'),
			created('dev-m', a), setMeta('dev-m', a, meta('Main A')), setMeta('dev-l', a, meta('Laptop A', { source: 'local' })),
			created('dev-l', b), setMeta('dev-l', b, meta('Laptop B')),
		]);
		expect(rowsOf(raw, a).map((r) => r.title)).toEqual(['Main A']);
		expect(rowsOf(raw, b).map((r) => r.title)).toEqual(['Laptop B']);
		applyOps(raw, [setMeta('dev-m', a, meta('Main A (Edit)'))]);
		expect(rowsOf(raw, a).map((r) => r.title)).toEqual(['Main A (Edit)']);
		await sweepRemoteRowsAsync(raw);
		expect(materializeSwept(raw)).toBe(true);
		applyOps(raw, [master('dev-l', 'dev-l')]);
		expect(materializeSwept(raw)).toBe(false);
		const r = await sweepRemoteRowsAsync(raw, { page: 1 });
		expect(r.records).toBe(2);
		expect(rowsOf(raw, a).map((x) => x.title)).toEqual(['Laptop A']);
	});

	it('never touches an own row: the device\'s own copy keeps its own metadata', () => {
		const { raw } = freshDb();
		insertTrack(raw, 'mine', { title: 'My Spelling' });
		initialPush(raw);
		applyOps(raw, [master('dev-m', 'dev-m'), setMeta('dev-m', R('mine'), meta('Master Spelling'))]);
		expect(rowsOf(raw, R('mine'))).toEqual([{ id: 'mine', remote_only: 0, title: 'My Spelling' }]);
	});

	it('an own row for the recording absorbs the remote row: the playlist row and tag move onto it', () => {
		const { raw } = freshDb();
		const rec = remoteRec(1);
		applyOps(raw, [
			op('dev-x', 'playlist', PL, 'create', { name: 'Mix', folder_id: null, source_link: null }),
			op('dev-x', 'tag', 'tg', 'create', { name: 'Peak', kind: 'user', color: null }),
			created('dev-x', rec), setMeta('dev-x', rec, meta('Lilac')),
			op('dev-x', 'track_tag', `${rec}:tg`, 'add', {}),
			op('dev-x', 'playlist_track', 'row-1', 'add', { playlist_id: PL, recording_id: rec, order_key: keys[0] }),
		]);
		expect(rowsOf(raw, rec)).toHaveLength(1);
		// An import bound to the recording inserts its own row (claim-bind.ts
		// does this when the binder returned no row) and projects.
		insertTrack(raw, 'own', { recording: rec, title: 'Lilac (own)' });
		projectAdoptedRecordings(raw, [rec]);
		expect(rowsOf(raw, rec)).toEqual([{ id: 'own', remote_only: 0, title: 'Lilac (own)' }]);
		expect(raw.prepare(`SELECT track_id FROM playlist_track WHERE id = 'row-1'`).pluck().get()).toBe('own');
		expect(raw.prepare(`SELECT tag_id FROM track_tag WHERE track_id = 'own'`).pluck().all()).toEqual(['tg']);
		expect(raw.prepare(`SELECT position FROM playlist_track WHERE playlist_id = ?`).pluck().all(PL)).toEqual([0]);
	});

	it('a merge drops the loser\'s remote row; a remote winner gives way to the loser\'s own row', () => {
		const { raw } = freshDb();
		const [lo, hi] = [remoteRec(1), remoteRec(2)];
		applyOps(raw, [
			op('dev-x', 'playlist', PL, 'create', { name: 'Mix', folder_id: null, source_link: null }),
			created('dev-x', lo), setMeta('dev-x', lo, meta('Low')),
			created('dev-y', hi), setMeta('dev-y', hi, meta('High')),
			op('dev-y', 'playlist_track', 'row-hi', 'add', { playlist_id: PL, recording_id: hi, order_key: keys[0] }),
		]);
		expect(remoteRowCount(raw)).toBe(2);
		applyOps(raw, [op('dev-y', 'recording', hi, 'merge', { winner: lo })]);
		expect(rowsOf(raw, hi)).toEqual([]);
		expect(rowsOf(raw, lo).map((r) => r.remote_only)).toEqual([1]);
		expect(raw.prepare(`SELECT track_id FROM playlist_track WHERE id = 'row-hi'`).pluck().get()).toBe(remoteTrackId(lo));

		// Own loser, remote winner: the own row takes the recording.
		const { raw: raw2 } = freshDb('two');
		insertTrack(raw2, 'mine', { recording: hi, title: 'Mine' });
		initialPush(raw2);
		applyOps(raw2, [created('dev-x', lo), setMeta('dev-x', lo, meta('Low'))]);
		expect(remoteRowCount(raw2)).toBe(1);
		applyOps(raw2, [op('dev-x', 'recording', hi, 'merge', { winner: lo })]);
		expect(rowsOf(raw2, lo)).toEqual([{ id: 'mine', remote_only: 0, title: 'Mine' }]);
		expect(remoteRowCount(raw2)).toBe(0);
	});

	it('a batch makes a handful inline and queues the rest for the sliced drain, which projects them like any', async () => {
		const { raw } = freshDb();
		const recs = Array.from({ length: INLINE_CREATE_ROWS + 7 }, (_, i) => remoteRec(100 + i));
		applyOps(raw, [
			op('dev-x', 'tag', 'tg', 'create', { name: 'Peak', kind: 'user', color: null }),
			...recs.flatMap((r, i) => [created('dev-x', r), setMeta('dev-x', r, meta(`T${i}`)), op('dev-x', 'track_tag', `${r}:tg`, 'add', {})]),
		]);
		expect(remoteRowCount(raw)).toBe(INLINE_CREATE_ROWS);
		expect(remotePendingCount(raw)).toBe(7);
		const r = await drainRemotePendingAsync(raw, { chunk: 3 });
		expect(r).toMatchObject({ records: 7, created: 7, chunks: 3 });
		expect(remoteRowCount(raw)).toBe(recs.length);
		expect(remotePendingCount(raw)).toBe(0);
		expect(raw.prepare(`SELECT count(*) FROM track_tag WHERE tag_id = 'tg'`).pluck().get()).toBe(recs.length);
	});

	it('loads from a snapshot (meta cells and all) and from the one-time sweep over records that never had rows', async () => {
		const state = createLibraryState();
		const rec = remoteRec(7);
		for (const o of [created('dev-x', rec), setMeta('dev-x', rec, meta('From Snapshot'))]) applyOp(state, parseOp(o));
		const { raw } = freshDb();
		await loadSnapshot(raw, recordsFromState(state));
		expect(rowsOf(raw, rec).map((r) => r.title)).toEqual(['From Snapshot']);
		// A build that never materialised (the v2 upgrade): the records are
		// there, the rows are not; the sweep makes them.
		raw.prepare(`DELETE FROM track WHERE remote_only = 1`).run();
		raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(MATERIALIZE_KEY);
		const r = await sweepRemoteRowsAsync(raw);
		expect(r.created).toBe(1);
		expect(rowsOf(raw, rec).map((x) => x.title)).toEqual(['From Snapshot']);
	});
});

// ── kept out of this device's identity and push ─────────────────────────────

describe('remote rows are never this device\'s own', () => {
	it('the identity resolver holds and emits nothing for groups of remote rows', () => {
		const { raw } = freshDb();
		const [a, b] = [remoteRec(1), remoteRec(2)];
		applyOps(raw, [
			created('dev-x', a), setMeta('dev-x', a, meta('A')), op('dev-x', 'recording_claim', a, 'add', { kind: 'spotify', value: 'sp1', confidence: 1 }),
			created('dev-y', b), setMeta('dev-y', b, meta('A again')), op('dev-y', 'recording_claim', b, 'add', { kind: 'spotify', value: 'sp1', confidence: 1 }),
		]);
		expect(remoteRowCount(raw)).toBe(2);
		expect(planIdentityMerges(raw)).toMatchObject({ groups: 1, merges: [], held: [] });
	});

	it('the claim binder\'s first step ignores remote rows; a bind still attaches to one', () => {
		const { raw } = freshDb();
		const [a, b] = [remoteRec(2), remoteRec(1)];
		applyOps(raw, [
			created('dev-x', a), setMeta('dev-x', a, meta('A')), op('dev-x', 'recording_claim', a, 'add', { kind: 'spotify', value: 'sp1', confidence: 1 }),
			created('dev-y', b), op('dev-y', 'recording_claim', b, 'add', { kind: 'spotify', value: 'sp1', confidence: 1 }),
		]);
		// Only `a` has a (remote) row here; the resolver keeps `b` (smaller).
		const bound = bindByClaim(raw, 'spotify', 'sp1')!;
		expect(bound).toMatchObject({ recordingId: b, trackId: null });
		const one = bindByClaim(raw, 'spotify', 'sp1')!;
		expect(one.recordingId).toBe(b);
		applyOps(raw, [setMeta('dev-y', b, meta('B'))]);
		expect(bindByClaim(raw, 'spotify', 'sp1')).toMatchObject({ recordingId: b, trackId: remoteTrackId(b) });
	});

	it('an initial push (re-)run states nothing for remote rows', () => {
		const { raw } = freshDb();
		const rec = remoteRec(1);
		applyOps(raw, [created('dev-x', rec), setMeta('dev-x', rec, meta('A', { isrc: 'GBAAA2600009' })), op('dev-x', 'library_track', rec, 'set-rating', { rating: 2 })]);
		raw.prepare(`UPDATE track SET isrc = 'GBAAA2600009' WHERE remote_only = 1`).run();
		const before = readOutbox(raw).length;
		raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(INITIAL_PUSH_KEY);
		initialPush(raw);
		// (The system tags it states are this library's own.)
		expect(readOutbox(raw).slice(before).filter((o) => o.entity !== 'tag')).toEqual([]);
	});

	it('user edits on a remote row ride the log like any row\'s', async () => {
		const { raw, db } = freshDb();
		const rec = remoteRec(1);
		applyOps(raw, [created('dev-x', rec), setMeta('dev-x', rec, meta('A'))]);
		mut.setRating(db, [remoteTrackId(rec)], 5);
		expect(readOutbox(raw).filter((o) => o.kind === 'set-rating').map((o) => [o.entity_id, o.payload])).toEqual([[rec, { rating: 5 }]]);
	});
});
