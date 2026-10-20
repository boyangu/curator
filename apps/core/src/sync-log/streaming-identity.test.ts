// Streaming identity, unit by unit (cloud plan: streaming identity, stage 1):
// deterministic ids (stable-ids.ts), the claimant choice (claim-bind.ts), the
// doubled-row rule (playlist-dedupe.ts), the streaming tier of the identity
// resolver (identity.ts) with its cost on a generated 5,000-track library,
// the newer-version hold (held.ts), and that the boot-time ISRC dedupe
// treats a claim-bound import like any other row. Cross-device behaviour is
// in two-desktops-catalogue.test.ts. Generated temp DBs only (CLAUDE.md).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { opSchemaVersion, rebalance } from '@curator/protocol';
import type { SpotifyPlaylistTrack } from '@curator/spotify';
import { createDb, type Db } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import * as mut from '../library/mutators.js';
import { SpotifySync } from '../sync/spotify.js';
import { TidalSync } from '../sync/tidal.js';
import type { TidalPlaylist, TidalPlaylistItem } from '@curator/tidal';
import { applyOps } from './apply.js';
import { bindByClaim, ClaimBinder, projectAdoptedRecordings } from './claim-bind.js';
import { heldCount, replayHeldOps } from './held.js';
import { identityReport } from './identity-report.js';
import { planIdentityMerges, resolveRecordingIdentities, resolveRecordingIdentitiesAsync } from './identity.js';
import { initialPush } from './initial-push.js';
import { readOutbox } from './outbox.js';
import { healStreamingDuplicates, planStreamingDedupe, streamingDedupeSwept, sweepStreamingDuplicatesAsync } from './playlist-dedupe.js';
import { recordingIdForTrack } from './recording-id.js';
import { isStreamingMemberId, memberIdAllocator, nextStreamingPlaylistId, streamingMemberId, streamingPlaylistId, uuidv5 } from './stable-ids.js';

const R = recordingIdForTrack;

let dir: string;
const handles: Database.Database[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-streaming-identity-')); });
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

type TrackRow = { id: string; recording?: string; isrc?: string; deleted?: boolean; duration?: number };
function insertTrack(raw: Database.Database, r: TrackRow): void {
	raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration, isrc, deleted_at, added_at, created_at)
		VALUES (?, ?, ?, '[{"name":"Artist"}]', 'unsorted', ?, ?, ?, 1650000000000, 1650000000000)`)
		.run(r.id, r.recording ?? R(r.id), `Title ${r.id}`, r.duration ?? 300, r.isrc ?? null, r.deleted ? 1_700_000_000_000 : null);
}
function spotifyLink(raw: Database.Database, trackId: string, sp: string): void {
	raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES (?, ?, 'spotify', ?, 1660000000000)`).run(`sl-${trackId}-${sp}`, trackId, sp);
}

// Ops as another device would have pushed them.
let clockTs = 1_760_000_000_000;
function op(device: string, entity: string, entityId: string, kind: string, payload: unknown, ts = clockTs++): Record<string, unknown> {
	return { op_id: randomUUID(), device_id: device, client_ts: ts, schema_version: opSchemaVersion({ entity, kind }), entity, entity_id: entityId, kind, payload };
}
const created = (device: string, rec: string, addedAt = 1_755_000_000_000): Record<string, unknown> => op(device, 'library_track', rec, 'create', { added_at: addedAt });
const claim = (device: string, rec: string, kind: string, value: string, confidence = 1): Record<string, unknown> => op(device, 'recording_claim', rec, 'add', { kind, value, confidence });
const deleted = (device: string, rec: string, ts?: number): Record<string, unknown> => op(device, 'library_track', rec, 'delete', {}, ts);

// Recording ids that sort in a known order.
const remoteRec = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const lateRec = (i: number): string => `ffffffff-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;

// ── stable ids ──────────────────────────────────────────────────────────────

describe('stable ids', () => {
	it('recording ids are unchanged by the UUIDv5 refactor', () => {
		// The pre-refactor derivation, verbatim: every recording id already
		// on the log was minted by it.
		const legacy = (trackId: string): string => {
			const hash = createHash('sha1').update(Buffer.from('6f1c2b7e3d4a5e8f9a0bc1d2e3f4a5b6', 'hex')).update(trackId, 'utf8').digest();
			const b = hash.subarray(0, 16);
			b[6] = (b[6]! & 0x0f) | 0x50;
			b[8] = (b[8]! & 0x3f) | 0x80;
			const hex = b.toString('hex');
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		};
		for (const id of ['trk-0', '3b241101-e2bb-4255-8caf-4136c566a962', 'é-ünïcode']) expect(R(id)).toBe(legacy(id));
		// RFC 4122 test vector: uuid5(DNS, 'python.org').
		expect(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
	});

	it('member ids are deterministic per (playlist, provider id, occurrence, bump) and distinct across them', () => {
		const a = streamingMemberId('pl', 'sp1', 0);
		expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(streamingMemberId('pl', 'sp1', 0)).toBe(a);
		const all = [a, streamingMemberId('pl', 'sp1', 1), streamingMemberId('pl', 'sp2', 0), streamingMemberId('pl2', 'sp1', 0), streamingMemberId('pl', 'sp1', 0, 1)];
		expect(new Set(all).size).toBe(all.length);
		expect(isStreamingMemberId(streamingMemberId('pl', 'sp1', 3, 2), 'pl', ['sp9', 'sp1'], 4)).toBe(true);
		expect(isStreamingMemberId(randomUUID(), 'pl', ['sp1'], 10)).toBe(false);
	});

	it('playlist ids move to the next generation past a tombstone, and member ids past a held row', () => {
		const { raw } = freshDb();
		const g0 = streamingPlaylistId('spotify', 'spP');
		expect(nextStreamingPlaylistId(raw, 'spotify', 'spP')).toBe(g0);
		raw.prepare(`INSERT INTO tombstone (entity, entity_id, client_ts) VALUES ('playlist', ?, 1)`).run(g0);
		expect(nextStreamingPlaylistId(raw, 'spotify', 'spP')).toBe(streamingPlaylistId('spotify', 'spP', 1));
		expect(streamingPlaylistId('tidal', 'spP')).not.toBe(g0);

		insertTrack(raw, { id: 't1' });
		raw.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES ('pl', 'spotify', 'x', 'X')`).run();
		raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, source_track_id) VALUES (?, 'pl', 't1', ?, 0, 'sp1')`).run(streamingMemberId('pl', 'sp1', 0), rebalance(1)[0]);
		const alloc = memberIdAllocator(raw, 'pl');
		expect(alloc('sp1', 0)).toBe(streamingMemberId('pl', 'sp1', 0, 1));
		expect(alloc('sp1', 1)).toBe(streamingMemberId('pl', 'sp1', 1));
	});

	it('a read-sync names the rows it adds by the provider list; a user add stays random', () => {
		const { raw, db } = freshDb();
		for (const id of ['t1', 't2']) insertTrack(raw, { id });
		raw.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES ('pl', 'spotify', 'x', 'X')`).run();
		const d = (trackId: string, sp: string): mut.DesiredMember => ({ trackId, sourceTrackId: sp, addedAt: null });
		mut.reconcileMembership(db, 'pl', [d('t1', 'sp1'), d('t2', 'sp2'), d('t1', 'sp1')], 'spotify');
		const ids = raw.prepare(`SELECT id FROM playlist_track WHERE playlist_id = 'pl' ORDER BY position`).pluck().all();
		expect(ids).toEqual([streamingMemberId('pl', 'sp1', 0), streamingMemberId('pl', 'sp2', 0), streamingMemberId('pl', 'sp1', 1)]);
		const [row] = mut.addMembers(db, 'pl', [{ playlistId: 'pl', trackId: 't2', addedAt: null, addedBy: null, sourceTrackId: 'sp2' }]);
		expect(isStreamingMemberId(row!.id, 'pl', ['sp1', 'sp2'], 5)).toBe(false);
	});
});

// ── claim-bind ──────────────────────────────────────────────────────────────

describe('claim-bind: which recording an import binds to', () => {
	it('a recording this device shows first, then the smallest live, then the latest delete', () => {
		const { raw } = freshDb();
		// Three remote claimants of sp1: 0 (smallest, live), 1 (live, and this
		// device holds a row of it), 2 (deleted).
		insertTrack(raw, { id: 'mine', recording: remoteRec(1) });
		applyOps(raw, [
			created('dev-x', remoteRec(0)), claim('dev-x', remoteRec(0), 'spotify', 'sp1'),
			created('dev-x', remoteRec(1)), claim('dev-x', remoteRec(1), 'spotify', 'sp1'),
			created('dev-y', remoteRec(2)), claim('dev-y', remoteRec(2), 'spotify', 'sp1'), deleted('dev-y', remoteRec(2)),
		]);
		expect(bindByClaim(raw, 'spotify', 'sp1')).toEqual({ recordingId: remoteRec(1), trackId: 'mine', deleted: false });
		// Without the row here: the resolver's survivor.
		raw.prepare(`UPDATE track SET deleted_at = 1 WHERE id = 'mine'`).run();
		expect(bindByClaim(raw, 'spotify', 'sp1')).toEqual({ recordingId: remoteRec(0), trackId: null, deleted: false });
		expect(bindByClaim(raw, 'spotify', 'sp-unknown')).toBeNull();
	});

	it('only deleted claimants: the latest delete, kept deleted; a live-only binder declines', () => {
		const { raw } = freshDb();
		applyOps(raw, [
			created('dev-x', remoteRec(0)), claim('dev-x', remoteRec(0), 'spotify', 'sp1'), deleted('dev-x', remoteRec(0), 1_760_100_000_000),
			created('dev-y', remoteRec(1)), claim('dev-y', remoteRec(1), 'spotify', 'sp1'), deleted('dev-y', remoteRec(1), 1_760_200_000_000),
		]);
		expect(bindByClaim(raw, 'spotify', 'sp1')).toEqual({ recordingId: remoteRec(1), trackId: null, deleted: true });
		expect(bindByClaim(raw, 'spotify', 'sp1', { liveOnly: true })).toBeNull();
	});

	it('claimants are resolved through merges; prefetch batches agree with single binds', () => {
		const { raw } = freshDb();
		const ops: Record<string, unknown>[] = [];
		for (let i = 0; i < 900; i++) ops.push(created('dev-x', remoteRec(i)), claim('dev-x', remoteRec(i), 'tidal', `td${i}`));
		ops.push(op('dev-x', 'recording', remoteRec(5), 'merge', { winner: remoteRec(4) }));
		applyOps(raw, ops);
		const binder = new ClaimBinder(raw);
		binder.prefetch('tidal', Array.from({ length: 900 }, (_, i) => `td${i}`));
		expect(binder.bind('tidal', 'td5')).toEqual({ recordingId: remoteRec(4), trackId: null, deleted: false });
		for (const i of [0, 399, 400, 899]) expect(binder.bind('tidal', `td${i}`)).toEqual(bindByClaim(raw, 'tidal', `td${i}`));
	});

	it('a Tidal import binds to another device’s claim the same way: no create, no claim, the stable playlist id', () => {
		const { raw, db } = freshDb();
		applyOps(raw, [created('dev-x', remoteRec(3)), claim('dev-x', remoteRec(3), 'tidal', 'td3'), op('dev-x', 'library_track', remoteRec(3), 'set-rating', { rating: 5 })]);
		const sync = new TidalSync(db, {} as never) as unknown as { upsertPlaylistMeta(pl: TidalPlaylist): string; replacePlaylistTracks(id: string, items: TidalPlaylistItem[]): number };
		const pl: TidalPlaylist = { id: 'td-pl', name: 'Crate', description: null, numberOfItems: 2, playlistType: 'USER', accessType: 'PRIVATE', lastModifiedAt: '2026-08-01T10:00:00Z' };
		const item = (n: number): TidalPlaylistItem => ({
			addedAt: '2026-08-01T10:00:00Z',
			track: { id: `td${n}`, title: `Tune ${n}`, version: null, duration: 280 + n, isrc: `USBBB26000${n}`, bpm: 124, key: 'A', keyScale: 'MINOR', explicit: false, artists: [{ id: `ta${n}`, name: `Band ${n}`, main: true }], album: { id: `tal${n}`, title: `Record ${n}` }, url: null },
		});
		const id = sync.upsertPlaylistMeta(pl);
		expect(id).toBe(streamingPlaylistId('tidal', 'td-pl'));
		const before = readOutbox(raw).length;
		sync.replacePlaylistTracks(id, [item(3), item(4)]);
		const bound = raw.prepare(`SELECT t.recording_id, t.rating FROM track t JOIN source_link l ON l.track_id = t.id WHERE l.source = 'tidal' AND l.source_track_id = 'td3'`).get();
		expect(bound).toEqual({ recording_id: remoteRec(3), rating: 5 });
		const ops = readOutbox(raw).slice(before);
		// td4 is new (create + claims); td3 emits nothing of its own.
		expect(ops.filter((o) => o.entity === 'library_track' && o.kind === 'create').map((o) => o.entity_id)).not.toContain(remoteRec(3));
		expect(ops.filter((o) => o.entity === 'recording_claim' && o.entity_id === remoteRec(3))).toEqual([]);
		expect(ops.find((o) => o.entity === 'recording_claim' && (o.payload as { kind: string; value: string }).value === 'td4')?.payload).toMatchObject({ confidence: 1 });
		expect(raw.prepare(`SELECT id FROM playlist_track WHERE playlist_id = ? ORDER BY position`).pluck().all(id)).toEqual([streamingMemberId(id, 'td3', 0), streamingMemberId(id, 'td4', 0)]);
	});

	it('a row inserted for a claimed recording shows what the records hold for it', () => {
		const { raw } = freshDb();
		const rec = remoteRec(7);
		const pl = streamingPlaylistId('spotify', 'spP');
		applyOps(raw, [
			created('dev-x', rec), claim('dev-x', rec, 'spotify', 'sp7'),
			op('dev-x', 'library_track', rec, 'set-rating', { rating: 4 }),
			op('dev-x', 'tag', 'warm', 'create', { name: 'Warm', kind: 'user', color: null }),
			op('dev-x', 'track_tag', `${rec}:warm`, 'add', {}),
			op('dev-x', 'playlist', pl, 'create', { name: 'Shared', folder_id: null, source_link: { source: 'spotify', source_id: 'spP', url: null } }),
			op('dev-x', 'playlist_track', streamingMemberId(pl, 'sp7', 0), 'add', { playlist_id: pl, recording_id: rec, order_key: rebalance(1)[0] }),
		]);
		insertTrack(raw, { id: 'bound', recording: rec });
		raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id) VALUES ('sl', 'bound', 'spotify', 'sp7')`).run();
		const s = raw.transaction(() => projectAdoptedRecordings(raw, [rec]))();
		expect(s.tracksTouched).toContain('bound');
		expect(raw.prepare(`SELECT rating FROM track WHERE id = 'bound'`).pluck().get()).toBe(4);
		expect(raw.prepare(`SELECT count(*) FROM track_tag WHERE track_id = 'bound' AND tag_id = 'warm'`).pluck().get()).toBe(1);
		expect(raw.prepare(`SELECT track_id, source_track_id FROM playlist_track WHERE playlist_id = ?`).get(pl)).toEqual({ track_id: 'bound', source_track_id: 'sp7' });
	});
});

// ── playlist dedupe ─────────────────────────────────────────────────────────

describe('playlist dedupe: the doubled rows two imports left', () => {
	const PL = 'pl-stream';
	const LOCAL = 'pl-local';
	const key = (i: number): string => rebalance(20)[i]!;
	// A streaming and a local playlist, recording X held by dev-a (earlier)
	// and dev-b; Y twice by dev-b only.
	function library(raw: Database.Database, extra: Record<string, unknown>[] = []): void {
		applyOps(raw, [
			op('dev-a', 'playlist', PL, 'create', { name: 'S', folder_id: null, source_link: { source: 'spotify', source_id: 'spS', url: null } }),
			op('dev-a', 'playlist', LOCAL, 'create', { name: 'L', folder_id: null, source_link: null }),
			created('dev-a', remoteRec(1)), claim('dev-a', remoteRec(1), 'spotify', 'spX'),
			op('dev-a', 'playlist_track', 'a-x', 'add', { playlist_id: PL, recording_id: remoteRec(1), order_key: key(0) }, 1_760_000_000_000),
			op('dev-b', 'playlist_track', 'b-x', 'add', { playlist_id: PL, recording_id: remoteRec(1), order_key: key(1) }, 1_760_000_500_000),
			op('dev-b', 'playlist_track', 'b-y1', 'add', { playlist_id: PL, recording_id: remoteRec(2), order_key: key(2) }),
			op('dev-b', 'playlist_track', 'b-y2', 'add', { playlist_id: PL, recording_id: remoteRec(2), order_key: key(3) }),
			op('dev-a', 'playlist_track', 'la-x', 'add', { playlist_id: LOCAL, recording_id: remoteRec(1), order_key: key(0) }),
			op('dev-b', 'playlist_track', 'lb-x', 'add', { playlist_id: LOCAL, recording_id: remoteRec(1), order_key: key(1) }),
			...extra,
		]);
	}

	it('keeps the earliest import, never touches a local playlist or one device\'s own duplicates', () => {
		const { raw } = freshDb();
		library(raw);
		const plan = planStreamingDedupe(raw);
		expect(plan.removes.map((r) => r.rowId)).toEqual(['b-x']);
		expect(plan.groups).toBe(1);
	});

	it('keeps the device with more rows (the provider list gained a duplicate)', () => {
		const { raw } = freshDb();
		library(raw, [op('dev-b', 'playlist_track', 'b-x2', 'add', { playlist_id: PL, recording_id: remoteRec(1), order_key: key(4) })]);
		expect(planStreamingDedupe(raw).removes.map((r) => r.rowId)).toEqual(['a-x']);
	});

	it('never removes a user\'s acked add or a provider-derived row; they count toward their device', () => {
		const { raw } = freshDb();
		const stable = streamingMemberId(PL, 'spX', 0);
		const userAdd = op('dev-b', 'playlist_track', 'b-user', 'add', { playlist_id: PL, recording_id: remoteRec(1), order_key: key(5) });
		library(raw, [
			userAdd,
			op('dev-b', 'upstream', userAdd['op_id'] as string, 'ack', { provider: 'spotify', status: 'pushed' }),
			op('dev-c', 'playlist_track', stable, 'add', { playlist_id: PL, recording_id: remoteRec(1), order_key: key(6) }),
		]);
		// dev-b holds two rows (one acked) and wins on count; dev-a's single
		// row goes; dev-c's provider-derived row stays.
		expect(planStreamingDedupe(raw).removes.map((r) => r.rowId)).toEqual(['a-x']);
	});

	it('emits the removes and takes the rows off the visible table; a second run finds nothing', () => {
		const { raw } = freshDb();
		insertTrack(raw, { id: 'x', recording: remoteRec(1) });
		library(raw);
		expect(raw.prepare(`SELECT count(*) FROM playlist_track WHERE playlist_id = ?`).pluck().get(PL)).toBe(2);
		const r = healStreamingDuplicates(raw);
		expect(r.removed).toBe(1);
		expect(raw.prepare(`SELECT id FROM playlist_track WHERE playlist_id = ?`).pluck().all(PL)).toEqual(['a-x']);
		expect(raw.prepare(`SELECT count(*) FROM playlist_track WHERE playlist_id = ?`).pluck().get(LOCAL)).toBe(2);
		expect(readOutbox(raw).map((o) => `${o.entity}.${o.kind}:${o.entity_id}`)).toEqual(['playlist_track.remove:b-x']);
		expect(healStreamingDuplicates(raw).removed).toBe(0);
	});

	it('the one-time sweep folds every streaming playlist, then marks itself done', async () => {
		const { raw } = freshDb();
		insertTrack(raw, { id: 'x', recording: remoteRec(1) });
		library(raw);
		expect(streamingDedupeSwept(raw)).toBe(false);
		const r = await sweepStreamingDuplicatesAsync(raw, { chunk: 1 });
		expect(r).toMatchObject({ removed: 1, playlists: 1 });
		expect(streamingDedupeSwept(raw)).toBe(true);
	});

	it('scoped to recordings, it reads only their rows', () => {
		const { raw } = freshDb();
		library(raw);
		expect(planStreamingDedupe(raw, { recordings: [remoteRec(2)] }).removes).toEqual([]);
		expect(planStreamingDedupe(raw, { recordings: [remoteRec(1)] }).removes.map((r) => r.rowId)).toEqual(['b-x']);
		// A planned (not yet applied) merge folds rows under its winner.
		const planned = planStreamingDedupe(raw, { recordings: [remoteRec(2)], alias: new Map([[remoteRec(1), remoteRec(2)]]) });
		expect(planned.removes.map((r) => r.rowId).sort()).toEqual(['a-x']);
	});
});

// ── the identity resolver's streaming tier ──────────────────────────────────

describe('identity: the streaming tier', () => {
	// This device holds `own` (a Spotify row of its own, initial-pushed);
	// another device claims the same id under `other`.
	function pair(raw: Database.Database, own: { id: string; recording?: string }, other: string, confidence = 1, kind: 'spotify' | 'tidal' | 'beatport' = 'spotify'): void {
		insertTrack(raw, own);
		raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES (?, ?, ?, 'p1', 1660000000000)`).run(`sl-${own.id}`, own.id, kind);
		initialPush(raw);
		applyOps(raw, [created('dev-x', other), claim('dev-x', other, kind, 'p1', confidence)]);
	}

	it('the holder of either side emits: survivor held here, the other device\'s copy merges in', () => {
		const { raw } = freshDb();
		pair(raw, { id: 'own', recording: remoteRec(1) }, lateRec(1));
		const plan = planIdentityMerges(raw);
		expect(plan).toMatchObject({ groups: 1, streamingGroups: 1, held: [] });
		expect(plan.merges).toEqual([{ loser: lateRec(1), winner: remoteRec(1), tier: 'streaming', trackId: null, claims: [{ kind: 'spotify', value: 'p1' }] }]);
		const r = resolveRecordingIdentities(raw);
		expect(r.merged).toBe(1);
		expect(raw.prepare(`SELECT winner FROM recording_alias WHERE loser = ?`).pluck().get(lateRec(1))).toBe(remoteRec(1));
		expect(planIdentityMerges(raw)).toMatchObject({ groups: 0, merges: [] });
	});

	it('the row here moves when the other device holds the smaller id', () => {
		const { raw } = freshDb();
		pair(raw, { id: 'own', recording: lateRec(1) }, remoteRec(1));
		expect(planIdentityMerges(raw).merges).toEqual([{ loser: lateRec(1), winner: remoteRec(1), tier: 'streaming', trackId: 'own', claims: [{ kind: 'spotify', value: 'p1' }] }]);
		resolveRecordingIdentities(raw);
		expect(raw.prepare(`SELECT recording_id FROM track WHERE id = 'own'`).pluck().get()).toBe(remoteRec(1));
	});

	it('needs a confidence-1 anchor: an ISRC or content bind alone never merges', () => {
		const { raw } = freshDb();
		insertTrack(raw, { id: 'own', recording: lateRec(1) });
		initialPush(raw);
		applyOps(raw, [
			claim('dev-me', lateRec(1), 'spotify', 'p1', 0.9),
			created('dev-x', remoteRec(1)), claim('dev-x', remoteRec(1), 'spotify', 'p1', 0.7),
		]);
		expect(planIdentityMerges(raw)).toMatchObject({ groups: 0, merges: [] });
		// One anchor, and the fuzzier claims join it.
		applyOps(raw, [created('dev-y', remoteRec(0)), claim('dev-y', remoteRec(0), 'spotify', 'p1', 1)]);
		const plan = planIdentityMerges(raw);
		expect(plan.groups).toBe(1);
		expect(plan.merges.map((m) => m.loser).sort()).toEqual([remoteRec(1), lateRec(1)].sort());
	});

	it('beatport ids are not evidence', () => {
		const { raw } = freshDb();
		pair(raw, { id: 'own', recording: lateRec(1) }, remoteRec(1), 1, 'beatport');
		expect(planIdentityMerges(raw)).toMatchObject({ groups: 0, merges: [] });
	});

	it('a deleted member joins, and the fold keeps it deleted', () => {
		const { raw } = freshDb();
		pair(raw, { id: 'own', recording: lateRec(1) }, remoteRec(1));
		applyOps(raw, [deleted('dev-x', remoteRec(1))]);
		expect(planIdentityMerges(raw).merges).toHaveLength(1);
		resolveRecordingIdentities(raw);
		expect(raw.prepare(`SELECT recording_id, deleted_at IS NOT NULL AS gone FROM track WHERE id = 'own'`).get()).toEqual({ recording_id: remoteRec(1), gone: 1 });
	});

	it('rows here for two members hold the group (this device\'s own duplicates)', () => {
		const { raw } = freshDb();
		insertTrack(raw, { id: 'own-1', recording: remoteRec(1) });
		insertTrack(raw, { id: 'own-2', recording: lateRec(1) });
		spotifyLink(raw, 'own-1', 'p1');
		initialPush(raw);
		applyOps(raw, [claim('dev-x', lateRec(1), 'spotify', 'p1', 1)]);
		const plan = planIdentityMerges(raw);
		expect(plan.merges).toEqual([]);
		expect(plan.held).toMatchObject([{ reason: 'local-duplicate', trackIds: ['own-1', 'own-2'] }]);
	});

	it('a group where one device minted two members is held everywhere (a fuzzy bridge, or that device’s own duplicates)', () => {
		const { raw } = freshDb();
		// This device holds one row; dev-x minted a recording that claims both
		// this row's id and another of dev-x's own recordings' ids (a content
		// bind stated at 1.0 before the confidence labels).
		pair(raw, { id: 'own', recording: lateRec(1) }, remoteRec(1));
		applyOps(raw, [created('dev-x', remoteRec(2)), claim('dev-x', remoteRec(2), 'spotify', 'p2'), claim('dev-x', remoteRec(1), 'spotify', 'p2')]);
		const plan = planIdentityMerges(raw);
		expect(plan.merges).toEqual([]);
		expect(plan.held).toMatchObject([{ reason: 'same-device', recordings: [remoteRec(1), remoteRec(2), lateRec(1)] }]);
	});

	it('the survivor keeps the earliest added_at of the group', () => {
		const { raw } = freshDb();
		pair(raw, { id: 'own', recording: remoteRec(1) }, lateRec(1));
		resolveRecordingIdentities(raw);
		const rec = JSON.parse(raw.prepare(`SELECT value FROM sync_state WHERE map = 'libraryTracks' AND key = ?`).pluck().get(remoteRec(1)) as string) as { fields: { added_at: { value: number } } };
		expect(rec.fields.added_at.value).toBe(1_650_000_000_000);
		expect(readOutbox(raw).filter((o) => o.entity === 'library_track' && o.kind === 'create' && o.entity_id === remoteRec(1)).length).toBeGreaterThan(0);
	});

	it('cost on a generated 5,000-track library: heals the incident shape in short slices', async () => {
		const { raw } = freshDb('big');
		const N = 5_000;
		const PL = 'pl-big';
		const keys = rebalance(N);
		raw.transaction(() => {
			const ins = raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration, added_at, created_at) VALUES (?, ?, ?, '[{"name":"A"}]', 'unsorted', 300, 1650000000000, 1650000000000)`);
			const link = raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES (?, ?, 'spotify', ?, 1660000000000)`);
			raw.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES (?, 'spotify', 'spBig', 'Big')`).run(PL);
			const row = raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, source_track_id) VALUES (?, ?, ?, ?, ?, 1650000000000, ?)`);
			for (let i = 0; i < N; i++) {
				ins.run(`big-${i}`, lateRec(i), `Song ${i}`);
				link.run(`sl-${i}`, `big-${i}`, `sp-${i}`);
				row.run(`row-${i}`, PL, `big-${i}`, keys[i], i, `sp-${i}`);
			}
		})();
		initialPush(raw);
		// The second desktop's import: its own recording per track (sorting
		// below every local one) and a random-id row per entry.
		const ops: Record<string, unknown>[] = [];
		for (let i = 0; i < N; i++) {
			ops.push(created('dev-profile', remoteRec(i)), claim('dev-profile', remoteRec(i), 'spotify', `sp-${i}`));
			ops.push(op('dev-profile', 'playlist_track', randomUUID(), 'add', { playlist_id: PL, recording_id: remoteRec(i), order_key: keys[i] }));
		}
		for (let i = 0; i < ops.length; i += 1_000) applyOps(raw, ops.slice(i, i + 1_000));
		// Invisible here so far: no row of the profile's recordings.
		expect(raw.prepare(`SELECT count(*) FROM playlist_track WHERE playlist_id = ?`).pluck().get(PL)).toBe(N);

		const planStart = performance.now();
		const plan = planIdentityMerges(raw);
		const planMs = performance.now() - planStart;
		expect(plan.merges).toHaveLength(N);
		let worstGap = 0;
		let last = performance.now();
		const timer = setInterval(() => { const now = performance.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 1);
		const r = await resolveRecordingIdentitiesAsync(raw);
		clearInterval(timer);
		console.log(`[streaming identity] merges=${r.merged} dedupeRemoved=${r.dedupeRemoved} chunks=${r.chunks} plan=${planMs.toFixed(1)}ms total=${r.ms}ms maxSlice=${r.maxSliceMs.toFixed(1)}ms worstTimerGap=${worstGap.toFixed(1)}ms`);
		expect(r.merged).toBe(N);
		expect(r.dedupeRemoved).toBe(N);
		expect(r.maxSliceMs).toBeLessThan(2_000);
		// The library as it was: every row here moved onto the smaller id,
		// the playlist still N rows in upstream order, none doubled.
		expect(raw.prepare(`SELECT count(*) FROM track WHERE id LIKE 'big-%' AND recording_id LIKE '00000000-%' AND deleted_at IS NULL`).pluck().get()).toBe(N);
		expect(raw.prepare(`SELECT id FROM playlist_track WHERE playlist_id = ? ORDER BY position`).pluck().all(PL)).toEqual(Array.from({ length: N }, (_, i) => `row-${i}`));
		const again = performance.now();
		expect(planIdentityMerges(raw)).toMatchObject({ groups: 0, merges: [] });
		expect(planStreamingDedupe(raw).removes).toEqual([]);
		console.log(`[streaming identity] idle re-plan=${(performance.now() - again).toFixed(1)}ms`);
	}, 180_000);
});

// ── the read-only report ────────────────────────────────────────────────────

describe('identity report', () => {
	it('counts the groups, merges and doubled rows on a read-only handle, writing nothing', () => {
		const { path, raw } = freshDb('report');
		const N = 12;
		const keys = rebalance(N);
		raw.transaction(() => {
			raw.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES ('pl-r', 'spotify', 'spR', 'Report Mix')`).run();
			for (let i = 0; i < N; i++) {
				insertTrack(raw, { id: `r-${i}`, recording: lateRec(i) });
				spotifyLink(raw, `r-${i}`, `sp-${i}`);
				raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, source_track_id) VALUES (?, 'pl-r', ?, ?, ?, 1650000000000, ?)`).run(`row-${i}`, `r-${i}`, keys[i], i, `sp-${i}`);
			}
		})();
		initialPush(raw);
		// The profile minted 10 of the 12 again and doubled their rows.
		const ops: Record<string, unknown>[] = [];
		for (let i = 0; i < 10; i++) {
			ops.push(created('dev-profile', remoteRec(i)), claim('dev-profile', remoteRec(i), 'spotify', `sp-${i}`));
			ops.push(op('dev-profile', 'playlist_track', randomUUID(), 'add', { playlist_id: 'pl-r', recording_id: remoteRec(i), order_key: keys[i] }));
		}
		applyOps(raw, ops);
		raw.close();
		handles.splice(handles.indexOf(raw), 1);

		const ro = new Database(path, { readonly: true, fileMustExist: true });
		handles.push(ro);
		const r = identityReport(ro);
		expect(r.identity).toMatchObject({ groups: 10, streamingGroups: 10, holdsLoser: 10, holdsSurvivor: 0, merges: { total: 10, streaming: 10, audio: 0 } });
		expect(r.identity.merges.byDevice).toEqual([{ loserDevice: r.deviceId, winnerDevice: 'dev-profile', merges: 10 }]);
		expect(r.dedupe.now.removes).toBe(0);
		expect(r.dedupe.afterMerges).toMatchObject({ groups: 10, removes: 10, perPlaylist: [{ playlistId: 'pl-r', name: 'Report Mix', excessRows: 10 }] });
		expect(r.recordsWithoutRows).toBe(10);
		expect(r.remoteOnly).toBeNull();
		// A read-only handle: any write would have thrown.
		expect(() => ro.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES ('x', '1', 1)`).run()).toThrow(/readonly/);
	});
});

// ── held newer-version ops ──────────────────────────────────────────────────

describe('held ops', () => {
	it('an op this build should read but cannot parse stays held and is reported', () => {
		const { raw } = freshDb();
		raw.prepare(`INSERT INTO sync_inbox_held (seq, op_id, schema_version, op, held_at) VALUES (7, 'x', 1, ?, 1)`)
			.run(JSON.stringify({ op_id: randomUUID(), device_id: 'd', client_ts: 1, schema_version: 1, entity: 'tag', entity_id: 't', kind: 'rename', payload: { nope: true } }));
		const r = replayHeldOps(raw);
		expect(r.applied).toBe(0);
		expect(r.error).toMatch(/tag\.rename/);
		expect(heldCount(raw)).toBe(1);
	});
});

// ── boot-time ISRC dedupe ───────────────────────────────────────────────────

describe('boot-time ISRC dedupe and a claim-bound import', () => {
	function spotifyItem(n: number, isrc: string): SpotifyPlaylistTrack {
		return {
			added_at: '2026-08-01T10:00:00Z', added_by: { id: 'me' }, is_local: false,
			track: { id: `sp${n}`, name: `Song ${n}`, duration_ms: 300_000, explicit: false, external_ids: { isrc }, artists: [{ id: 'a', name: 'Artist' }], album: { id: 'al', name: 'Album', release_date: '2026-01-01', images: [] } },
		} as SpotifyPlaylistTrack;
	}

	it('a bound row is an ordinary row: a restart changes nothing, and two own same-ISRC rows still merge as before', () => {
		const { path, raw, db } = freshDb();
		applyOps(raw, [created('dev-x', remoteRec(1)), claim('dev-x', remoteRec(1), 'spotify', 'sp1'), op('dev-x', 'library_track', remoteRec(1), 'set-rating', { rating: 3 })]);
		const sync = new SpotifySync(db, {} as never) as unknown as { ingestExternalTrack(t: SpotifyPlaylistTrack['track']): string };
		const bound = sync.ingestExternalTrack(spotifyItem(1, 'GBAAA2600001').track);
		expect(raw.prepare(`SELECT recording_id, rating FROM track WHERE id = ?`).get(bound)).toEqual({ recording_id: remoteRec(1), rating: 3 });
		const outbox = readOutbox(raw).length;
		const tracks = raw.prepare(`SELECT count(*) FROM track`).pluck().get();
		migrate(path);
		expect(raw.prepare(`SELECT count(*) FROM track`).pluck().get()).toBe(tracks);
		expect(readOutbox(raw).length).toBe(outbox);

		// Two own live rows sharing an ISRC: folded at boot, the merge emitted.
		insertTrack(raw, { id: 'old', isrc: 'GBZZZ2600009' });
		raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration, isrc, created_at) VALUES ('young', ?, 'T', '[]', 'unsorted', 300, 'GBZZZ2600009', 1700000000000)`).run(R('young'));
		migrate(path);
		expect(raw.prepare(`SELECT id FROM track WHERE isrc = 'GBZZZ2600009'`).pluck().all()).toEqual(['old']);
		expect(readOutbox(raw).filter((o) => o.entity === 'recording' && o.kind === 'merge').map((o) => o.entity_id)).toEqual([R('young')]);
	});
});
