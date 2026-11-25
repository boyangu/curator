// A feed card's track into the library with no provider (external-track.ts):
// what is stated, what is bound instead of minted, and what is refused.
// Generated temp DBs only; across devices it is apps/core
// sync-log/two-desktops-v4.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { MASTER_DEVICE_SETTING, opSchemaVersion, safeParseOp, type Op, type TrackMeta } from '@curator/protocol';
import { createDb, type Db } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { applyOps, INITIAL_PUSH_KEY } from '../sync-log/apply.js';
import { recordServerV4 } from '../sync-log/features.js';
import { readOutbox } from '../sync-log/outbox.js';
import { recordingIdForTrack } from '../sync-log/recording-id.js';
import { FIRST_PULL_KEY } from '../sync-log/role.js';
import { remoteTrackId } from '../sync-log/stable-ids.js';
import { tmpDir, type TmpDir } from '../test-support/tmp.js';
import { ensureExternalTrack, promoteExternalTrack, type ExternalTrackFacts } from './external-track.js';

let tmp: TmpDir;
let db: Db;
let raw: Database.Database;

beforeEach(() => {
	tmp = tmpDir('curator-external-track-');
	const path = join(tmp.path, 'library.db');
	migrate(path);
	const made = createDb(path);
	db = made.db;
	raw = tmp.track(made.sqlite);
	// A phone that has joined: the account's first pull is done, its master is
	// another device, and the server reads v4.
	for (const k of [FIRST_PULL_KEY, INITIAL_PUSH_KEY]) raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, '1', 1) ON CONFLICT(key) DO NOTHING`).run(k);
	recordServerV4(raw, true);
	applyOps(raw, [op('desk', 'setting', MASTER_DEVICE_SETTING, 'set', { value: 'desk' }), op('desk', 'tag', 'interested', 'create', { name: 'Interested', kind: 'system' })]);
});
afterEach(() => tmp.cleanup());

let ts = 1_760_000_000_000;
function op(device: string, entity: string, entityId: string, kind: string, payload: unknown): Record<string, unknown> {
	return { op_id: randomUUID(), device_id: device, client_ts: ts++, schema_version: opSchemaVersion({ entity, kind, entity_id: entityId }), entity, entity_id: entityId, kind, payload };
}
const meta = (over: Partial<TrackMeta> = {}): TrackMeta => ({
	source: 'spotify', title: 'Held', artists: [{ name: 'Someone' }], album_title: null, duration_sec: 240, isrc: null, release_date: null, label: null, genre: null, cover_url: null, track_number: null, disc_number: null, ...over,
});
// A recording the desktop holds, as its ops describe it.
function held(n: number, over: Partial<TrackMeta> = {}, spotify?: string): string {
	const rec = `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
	applyOps(raw, [
		op('desk', 'library_track', rec, 'create', { added_at: 1_755_000_000_000 }),
		op('desk', 'library_track', rec, 'set-meta', meta(over)),
		...(spotify ? [op('desk', 'recording_claim', rec, 'add', { kind: 'spotify', value: spotify, confidence: 1 })] : []),
	]);
	return rec;
}

const FACTS: ExternalTrackFacts = {
	spotifyTrackId: 'sp1', isrc: 'GB-AAA-26-00001', title: 'Lailonie', artists: ['Marsh'], albumTitle: 'Lailonie', releaseDate: '2026-10-23', label: 'Anjunadeep',
	genre: 'Melodic House', coverUrl: 'https://img.test/c.jpg', durationSec: 384.4, trackNumber: 1, bpm: 123, keyCamelot: '9A',
};
const kinds = (): string[] => readOutbox(raw).map((o: Op) => `${o.entity}.${o.kind}`);
const track = (id: string): Record<string, unknown> => raw.prepare(`SELECT * FROM track WHERE id = ?`).get(id) as Record<string, unknown>;

describe('ensureExternalTrack', () => {
	it('states a new recording and shows it as a remote row, streamable by its claim', () => {
		const r = ensureExternalTrack(db, FACTS);
		expect(r).toMatchObject({ ok: true, created: true });
		if (!r.ok) return;
		expect(r.trackId).toBe(remoteTrackId(r.recordingId));
		expect(kinds()).toEqual(['library_track.create', 'library_track.set-meta', 'library_track.set-attrs', 'recording_claim.add', 'recording_claim.add']);
		// Each is one the server takes as it stands.
		for (const o of readOutbox(raw)) expect(safeParseOp(o).ok).toBe(true);
		expect(track(r.trackId)).toMatchObject({
			remote_only: 1, remote_source: 'spotify', title: 'Lailonie', isrc: 'GBAAA2600001', album_title: 'Lailonie', duration: 384, label: 'Anjunadeep',
			genre: 'Melodic House', release_date: '2026-10-23', cover_url: 'https://img.test/c.jpg', bpm: 123, key_camelot: '9A', deleted_at: null,
		});
		expect(JSON.parse(track(r.trackId)['artists'] as string)).toEqual([{ name: 'Marsh' }]);
		expect(raw.prepare(`SELECT source, source_track_id FROM claim_link WHERE track_id = ?`).all(r.trackId)).toEqual([{ source: 'spotify', source_track_id: 'sp1' }]);
		// The credited artist is linked, as any track's.
		expect(raw.prepare(`SELECT count(*) FROM track_artist WHERE track_id = ?`).pluck().get(r.trackId)).toBe(1);
	});

	it('leaves out what the card does not say, and a cover that is not a web address', () => {
		const r = ensureExternalTrack(db, { ...FACTS, isrc: null, coverUrl: 'C:\\x.jpg', bpm: null, keyCamelot: null, label: ' ', durationSec: 0 });
		if (!r.ok) throw new Error(r.reason);
		expect(kinds()).toEqual(['library_track.create', 'library_track.set-meta', 'recording_claim.add']);
		expect(track(r.trackId)).toMatchObject({ isrc: null, cover_url: null, bpm: null, label: null, duration: null });
	});

	it('finds the same track again instead of stating it twice', () => {
		const a = ensureExternalTrack(db, FACTS);
		const n = kinds().length;
		const b = ensureExternalTrack(db, FACTS);
		expect(b).toEqual({ ...a, created: false });
		expect(kinds()).toHaveLength(n);
	});

	it('binds to the recording another device claims the Spotify id for, describing nothing of it', () => {
		const rec = held(1, { title: 'Held there' }, 'sp1');
		const r = ensureExternalTrack(db, FACTS);
		expect(r).toMatchObject({ ok: true, created: false, recordingId: rec, trackId: remoteTrackId(rec) });
		expect(kinds()).toEqual([]);
		expect(track(remoteTrackId(rec))['title']).toBe('Held there');
	});

	it('binds by ISRC to what the library holds, adding only the claim that makes it streamable', () => {
		const rec = held(2, { isrc: 'GBAAA2600001', source: 'local' });
		const r = ensureExternalTrack(db, FACTS);
		expect(r).toMatchObject({ ok: true, created: false, recordingId: rec });
		expect(kinds()).toEqual(['recording_claim.add']);
		expect(readOutbox(raw)[0]!.payload).toMatchObject({ kind: 'spotify', value: 'sp1', confidence: 0.9 });
		expect(raw.prepare(`SELECT source_track_id FROM claim_link WHERE track_id = ?`).pluck().all(remoteTrackId(rec))).toEqual(['sp1']);
	});

	it('never brings back a track the user deleted, by id or by ISRC', () => {
		const a = held(3, {}, 'sp1');
		applyOps(raw, [op('desk', 'library_track', a, 'delete', {})]);
		expect(ensureExternalTrack(db, { ...FACTS, isrc: null })).toEqual({ ok: false, reason: 'deleted' });
		const b = held(4, { isrc: 'GBAAA2600009' });
		applyOps(raw, [op('desk', 'library_track', b, 'delete', {})]);
		expect(ensureExternalTrack(db, { ...FACTS, spotifyTrackId: 'sp2', isrc: 'GBAAA2600009' })).toEqual({ ok: false, reason: 'deleted' });
		expect(kinds()).toEqual([]);
	});

	it('waits for a recording another device claimed but has not described yet', () => {
		const rec = recordingIdForTrack('elsewhere');
		applyOps(raw, [op('desk', 'library_track', rec, 'create', {}), op('desk', 'recording_claim', rec, 'add', { kind: 'spotify', value: 'sp1', confidence: 1 })]);
		expect(ensureExternalTrack(db, FACTS)).toEqual({ ok: false, reason: 'not-ready' });
		expect(kinds()).toEqual([]);
	});

	it('states nothing before the first pull, or to a server that does not read it', () => {
		raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(FIRST_PULL_KEY);
		expect(ensureExternalTrack(db, FACTS)).toEqual({ ok: false, reason: 'not-ready' });
		raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, '1', 1)`).run(FIRST_PULL_KEY);
		recordServerV4(raw, false);
		expect(ensureExternalTrack(db, FACTS)).toEqual({ ok: false, reason: 'not-ready' });
		expect(kinds()).toEqual([]);
		expect(raw.prepare(`SELECT count(*) FROM track`).pluck().get()).toBe(0);
	});
});

describe('promoteExternalTrack', () => {
	it('files the track in the backlog under Interested, as ops', () => {
		const r = promoteExternalTrack(db, FACTS);
		if (!r.ok) throw new Error(r.reason);
		expect(track(r.trackId)['state']).toBe('backlog');
		expect(raw.prepare(`SELECT tag_id FROM track_tag WHERE track_id = ?`).pluck().all(r.trackId)).toEqual(['interested']);
		expect(kinds().slice(-2)).toEqual(['library_track.set-state', 'track_tag.add']);
		const n = kinds().length;
		expect(promoteExternalTrack(db, FACTS)).toMatchObject({ ok: true, trackId: r.trackId, created: false });
		expect(kinds()).toHaveLength(n);
	});

	it('keeps a track the user already files further along where it is', () => {
		const rec = held(5, {}, 'sp1');
		applyOps(raw, [op('desk', 'library_track', rec, 'set-state', { state: 'purchased' })]);
		const r = promoteExternalTrack(db, FACTS);
		if (!r.ok) throw new Error(r.reason);
		expect(track(r.trackId)['state']).toBe('purchased');
		expect(kinds()).toEqual(['track_tag.add']);
	});

	it('states nothing at all when the track is refused', () => {
		const rec = held(6, {}, 'sp1');
		applyOps(raw, [op('desk', 'library_track', rec, 'delete', {})]);
		expect(promoteExternalTrack(db, FACTS)).toEqual({ ok: false, reason: 'deleted' });
		expect(kinds()).toEqual([]);
	});
});
