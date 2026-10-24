// The first-link rule (importer.ts decideFirstLinkSide): a device linking a
// rekordbox content row for the first time, for a recording whose values
// came from the account, takes per field whichever side wrote LATER — not
// rekordbox's values wholesale. The case it exists for: a second machine
// whose library came from the cloud account and whose rekordbox is older.
// Then the next "Sync to rekordbox" must carry the kept account values in.
// Real importer + exporter, migrated temp DB, stub sidecar, account records
// written straight into sync_state / tombstone — never real data.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { RekordboxImporter, type RunImportOptions } from './importer.js';
import { RekordboxExporter } from './exporter.js';
import type { RekordboxSidecar, WriteOp } from './sidecar.js';
import { drainTrackAttrs } from '../sync-log/track-attrs.js';

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
// The run's tally — what the one 'first-link rule' log line carries.
const statsOf = (i: RekordboxImporter): unknown => (i as unknown as { firstLinkStats: unknown }).firstLinkStats;

// What "Sync updates" would send right after the pull.
function pushOps(): WriteOp[] {
	const exporter = new RekordboxExporter(db, {} as never);
	const opts = {
		targetKind: 'updates' as const,
		targetIds: [],
		flags: { syncMetadata: true, syncCues: true, syncTags: true, syncPlaylist: true },
		dbPath: join(dir, 'master.db'),
	};
	const t = (exporter as unknown as { resolveTargets: (o: typeof opts) => { linked: unknown[]; playlistOrders: unknown[] } }).resolveTargets(opts);
	return (exporter as unknown as { buildWriteOps: (o: typeof opts, l: unknown, p: unknown) => { ops: WriteOp[] } }).buildWriteOps(opts, t.linked, t.playlistOrders).ops;
}
const opOf = <K extends WriteOp['kind']>(ops: WriteOp[], kind: K): Extract<WriteOp, { kind: K }> | undefined =>
	ops.find((o): o is Extract<WriteOp, { kind: K }> => o.kind === kind);

const T_RB = Date.parse('2026-09-01T10:00:00Z');
const OLDER = T_RB - 86_400_000;
const NEWER = T_RB + 86_400_000;
const REC = 'rec-1';
const FILE = 'c:/music/one.flac';

function seedTrack(f: { rating?: number | null; comment?: string | null; colorLabel?: string | null; recording?: string | null } = {}): void {
	sqlite.prepare(`INSERT INTO track (id, recording_id, title, artists, state, rating, comment, color_label, updated_at) VALUES ('t1', ?, 'One', '[{"name":"A"}]', 'unsorted', ?, ?, ?, ?)`)
		.run(f.recording === undefined ? REC : f.recording, f.rating ?? null, f.comment ?? null, f.colorLabel ?? null, OLDER - 1000);
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path) VALUES ('sl1', 't1', 'local', ?, ?)`).run(FILE, FILE);
}

const clock = (ts: number, op: string) => ({ ts, device: 'desk-a', op });

// The account's record for the recording, as the log left it in sync_state.
function seedAccountRecord(fields: Record<string, { value: unknown; ts: number }>): void {
	const cells: Record<string, unknown> = {};
	for (const [k, c] of Object.entries(fields)) cells[k] = { value: c.value, clock: clock(c.ts, `op-${k}`) };
	sqlite.prepare(`INSERT INTO sync_state (map, key, recording_id, parent_id, value) VALUES ('libraryTracks', ?, ?, NULL, ?)`)
		.run(REC, REC, JSON.stringify({ id: REC, created: clock(OLDER - 5000, 'op-create'), fields: cells }));
}

// An account cue, as the projection lands it: a cue row (origin 'rekordbox'
// — it came from another machine's rekordbox) plus its record.
function seedAccountCue(slot: number, positionSec: number, ts: number): void {
	sqlite.prepare(`INSERT INTO cue (id, track_id, slot, position_sec, kind, origin, created_at) VALUES (?, 't1', ?, ?, 'hot', 'rekordbox', 0)`).run(`cue-${slot}`, slot, positionSec);
	sqlite.prepare(`INSERT INTO sync_state (map, key, recording_id, parent_id, value) VALUES ('cues', ?, ?, NULL, ?)`).run(`${REC}:${slot}:hot`, REC, JSON.stringify({
		recordingId: REC, slot, kind: 'hot',
		cell: { value: { position_sec: positionSec, length_sec: null, color: null, name: null }, clock: clock(ts, `op-cue-${slot}`) },
	}));
}

function seedAccountTagRemoval(tagId: string, ts: number): void {
	sqlite.prepare(`INSERT INTO sync_state (map, key, recording_id, parent_id, value) VALUES ('trackTags', ?, ?, ?, ?)`)
		.run(`${REC}:${tagId}`, REC, tagId, JSON.stringify({ recordingId: REC, tagId, added: clock(OLDER - 4000, 'op-tag-add') }));
	sqlite.prepare(`INSERT INTO tombstone (entity, entity_id, client_ts, device_id, op_id, recording_id) VALUES ('track_tag', ?, ?, 'desk-a', 'op-tag-rm', ?)`).run(`${REC}:${tagId}`, ts, REC);
}

function seedAccountPlaylistRemoval(playlistId: string, ts: number): void {
	sqlite.prepare(`INSERT INTO sync_state (map, key, recording_id, parent_id, value) VALUES ('playlistTracks', 'row-1', ?, ?, ?)`)
		.run(REC, playlistId, JSON.stringify({ id: 'row-1', playlistId, recordingId: REC, added: clock(OLDER - 4000, 'op-pt-add'), orderKey: { value: 'a0', clock: clock(OLDER - 4000, 'op-pt-add') } }));
	sqlite.prepare(`INSERT INTO tombstone (entity, entity_id, client_ts, device_id, op_id, recording_id) VALUES ('playlist_track', 'row-1', ?, 'desk-a', 'op-pt-rm', NULL)`).run(ts);
}

function trackFrame(over: Record<string, unknown> = {}): Frame {
	return {
		event: 'track',
		row: {
			rb_content_id: 'C1', rb_local_usn: 11, rb_local_deleted: false,
			rb_updated_at_ms: T_RB, rb_added_at_ms: null, file_path: FILE,
			title: 'One', artist: 'A', album: null, genre: null, label: null,
			bpm: 124, key_camelot: '8A', key_musical: null, color_label: 'Red',
			rating: 2, comment: 'rb words', play_count: null, last_played_at_ms: null, duration_sec: 300,
			...over,
		},
	};
}
const cueFrame = (slot: number, positionSec: number): Frame => ({
	event: 'cues', row: { rb_content_id: 'C1', rb_local_usn: 1, rb_local_deleted: false, slot, kind: 'hot', position_sec: positionSec, length_sec: null, color: null, name: null },
});
const playlistFrame = (): Frame => ({
	event: 'playlist', row: { rb_playlist_id: 'P', rb_local_usn: 2, rb_local_deleted: false, parent_folder_id: null, name: 'Peak', is_folder: false, is_smart: false, position: 0, tracks: [{ rb_content_id: 'C1', position: 0 }] },
});
const mytagFrame = (id: string, name: string): Frame => ({
	event: 'mytag', row: { rb_tag_id: id, rb_local_usn: 3, rb_local_deleted: false, name, color: null, tracks: ['C1'] },
});

const row = () => sqlite.prepare(`SELECT rating, comment, color_label AS colorLabel FROM track WHERE id = 't1'`).get() as { rating: number | null; comment: string | null; colorLabel: string | null };
const cues = () => (sqlite.prepare(`SELECT slot, position_sec AS pos FROM cue WHERE track_id = 't1' ORDER BY slot`).all() as Array<{ slot: number; pos: number }>);
const tagsOf = () => (sqlite.prepare(`SELECT tag_id FROM track_tag WHERE track_id = 't1' ORDER BY tag_id`).pluck().all() as string[]);
const members = (pid: string) => (sqlite.prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = ?`).pluck().all(pid) as string[]);
const outbox = () => sqlite.prepare(`SELECT entity, kind, payload FROM sync_outbox ORDER BY seq_local`).all() as Array<{ entity: string; kind: string; payload: string }>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-first-link-'));
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

describe('first link, account newer than rekordbox', () => {
	it('keeps the account values, and the next push writes them into rekordbox', async () => {
		seedTrack({ rating: 5, comment: 'account words', colorLabel: 'Blue' });
		seedAccountRecord({
			rating: { value: 5, ts: NEWER },
			'curation.comment': { value: 'account words', ts: NEWER },
			'curation.color_label': { value: 'Blue', ts: NEWER },
		});
		seedAccountCue(0, 10, NEWER);
		// rb's own tag on the track (G2) and one the account removed (G1).
		sqlite.prepare(`INSERT INTO tag (id, name, kind) VALUES ('rb_G2', 'keep', 'user')`).run();
		sqlite.prepare(`INSERT INTO track_tag (track_id, tag_id) VALUES ('t1', 'rb_G2')`).run();
		seedAccountTagRemoval('rb_G1', NEWER);
		seedAccountPlaylistRemoval('rb_P', NEWER);

		const importer = await pull([trackFrame(), cueFrame(0, 33), cueFrame(1, 66), playlistFrame(), mytagFrame('G1', 'gone'), mytagFrame('G2', 'keep')]);
		expect(statsOf(importer)).toEqual({
			firstLinks: 1, withAccount: 1, rbWon: 0, accountWon: 6,
			byField: { rating: { rb: 0, account: 1 }, comment: { rb: 0, account: 1 }, colorLabel: { rb: 0, account: 1 }, cues: { rb: 0, account: 1 }, mytags: { rb: 0, account: 1 }, playlists: { rb: 0, account: 1 } },
		});

		expect(row()).toEqual({ rating: 5, comment: 'account words', colorLabel: 'Blue' });
		expect(cues()).toEqual([{ slot: 0, pos: 10 }]);
		expect(tagsOf()).toEqual(['rb_G2']);
		expect(members('rb_P')).toEqual([]);
		// Nothing rekordbox held was stated over the account.
		// (rb's key landing in the rekordbox slot is rekordbox's own unit,
		// not a value the account holds.)
		const stated = outbox().filter((o) => ['library_track', 'cue', 'track_tag', 'playlist_track'].includes(o.entity) && o.kind !== 'set-rb-analysis');
		expect(stated).toEqual([]);

		// The push: the newly linked row is in scope (pushed_at NULL) and
		// carries the account's values; the baselines the pull wrote are
		// rekordbox's, so nothing reads as already in sync.
		const ops = pushOps();
		expect(opOf(ops, 'track')!.fields).toMatchObject({ Rating: 5, Color: 'Blue' });
		expect(opOf(ops, 'track')!.fields.Comment).toContain('account words');
		expect(opOf(ops, 'cues')!.cues.map((c) => [c.slot, c.position_sec])).toEqual([[0, 10]]);
		expect(opOf(ops, 'tags')!.rb_tag_ids).toEqual(['G2']);
		expect(opOf(ops, 'playlist_merge')).toMatchObject({ rb_playlist_id: 'P', remove: ['C1'], add: [] });
	});

	it('a later pull (link exists) leaves the kept account values alone', async () => {
		seedTrack({ rating: 5 });
		seedAccountRecord({ rating: { value: 5, ts: NEWER } });
		await pull([trackFrame()]);
		await pull([trackFrame()]);
		expect(row().rating).toBe(5);
	});
});

describe('first link, rekordbox newer than the account', () => {
	it('takes rekordbox values and states them as ops', async () => {
		seedTrack({ rating: 5, comment: 'account words', colorLabel: 'Blue' });
		seedAccountRecord({
			rating: { value: 5, ts: OLDER },
			'curation.comment': { value: 'account words', ts: OLDER },
			'curation.color_label': { value: 'Blue', ts: OLDER },
		});
		seedAccountCue(0, 10, OLDER);
		seedAccountTagRemoval('rb_G1', OLDER);
		seedAccountPlaylistRemoval('rb_P', OLDER);

		await pull([trackFrame(), cueFrame(0, 33), playlistFrame(), mytagFrame('G1', 'gone')]);

		expect(row()).toEqual({ rating: 2, comment: 'rb words', colorLabel: 'Red' });
		expect(cues()).toEqual([{ slot: 0, pos: 33 }]);
		expect(tagsOf()).toEqual(['rb_G1']);
		expect(members('rb_P')).toEqual(['t1']);

		const kinds = outbox().map((o) => `${o.entity}.${o.kind}`);
		expect(kinds).toContain('library_track.set-rating');
		expect(kinds.some((k) => k.startsWith('cue.'))).toBe(true);
		expect(kinds).toContain('track_tag.add');
		expect(kinds).toContain('playlist_track.add');
		const rating = outbox().find((o) => o.kind === 'set-rating')!;
		expect(JSON.parse(rating.payload).rating).toBe(2);

		// Comment and colour are stated by the curation drain, at the pull's
		// write time — later than the account's cells.
		drainTrackAttrs(sqlite, { role: { speaks: 'all' } });
		const curation = outbox().filter((o) => o.kind === 'set-curation').map((o) => JSON.parse(o.payload) as { field: string; value: unknown });
		expect(curation).toEqual(expect.arrayContaining([{ field: 'comment', value: 'rb words' }, { field: 'color_label', value: 'Red' }]));
	});
});

describe('first link, only one side has a value', () => {
	it('rekordbox unrated / no comment / no colour: the account keeps its values even when rb is newer', async () => {
		seedTrack({ rating: 4, comment: 'account words', colorLabel: 'Blue' });
		seedAccountRecord({
			rating: { value: 4, ts: OLDER },
			'curation.comment': { value: 'account words', ts: OLDER },
			'curation.color_label': { value: 'Blue', ts: OLDER },
		});
		seedAccountCue(0, 10, OLDER);
		await pull([trackFrame({ rating: 0, comment: null, color_label: null })]);
		expect(row()).toEqual({ rating: 4, comment: 'account words', colorLabel: 'Blue' });
		// rb has no cues at all: the account's set survives (the legacy
		// bootstrap wiped every rekordbox-origin cue here).
		expect(cues()).toEqual([{ slot: 0, pos: 10 }]);
		expect(opOf(pushOps(), 'track')!.fields).toMatchObject({ Rating: 4, Color: 'Blue' });
	});

	it('the account has no value: rekordbox\'s is taken even when the account is newer', async () => {
		seedTrack({ rating: null, comment: null, colorLabel: null });
		seedAccountRecord({ rating: { value: null, ts: NEWER }, 'curation.comment': { value: null, ts: NEWER } });
		await pull([trackFrame(), cueFrame(0, 33)]);
		expect(row()).toEqual({ rating: 2, comment: 'rb words', colorLabel: 'Red' });
		expect(cues()).toEqual([{ slot: 0, pos: 33 }]);
	});
});

describe('no account records for the recording', () => {
	it('keeps today\'s behaviour: rekordbox wins the first link', async () => {
		seedTrack({ rating: 5, comment: 'local words', colorLabel: 'Blue' });
		sqlite.prepare(`INSERT INTO cue (id, track_id, slot, position_sec, kind, origin, created_at) VALUES ('c0', 't1', 0, 10, 'hot', 'rekordbox', 0)`).run();
		await pull([trackFrame(), cueFrame(0, 33), playlistFrame(), mytagFrame('G1', 'gone')]);
		expect(row()).toEqual({ rating: 2, comment: 'rb words', colorLabel: 'Red' });
		expect(cues()).toEqual([{ slot: 0, pos: 33 }]);
		expect(tagsOf()).toEqual(['rb_G1']);
		expect(members('rb_P')).toEqual(['t1']);
	});

	it('a track without a recording id behaves the same', async () => {
		seedTrack({ rating: 5, recording: null });
		await pull([trackFrame()]);
		expect(row().rating).toBe(2);
	});
});

// Title and artist: compared as the strings the push composes; the account's
// clock is the recording's meta cell (the master's, else the best device's)
// and the field's override cell. e2e 2026-10-24: a stale rekordbox artist
// line rebuilt the account's three credits into two.
describe('first link: title and artist follow the same rule', () => {
	const ACCOUNT_CREDITS = [{ name: 'Ilo Marsh' }, { name: 'Rook Hale' }, { name: 'Pell Arno', role: 'remixer' }];
	const meta = (artists: unknown[], ts: number) => ({
		'meta.desk-a': { value: { source: 'local', title: 'Low Tide', artists, album_title: null, duration_sec: 300, isrc: null, release_date: null, label: null, genre: null, cover_url: null }, ts },
	});
	const seedCredits = (artists: unknown[], overrides: unknown = null): void => {
		seedTrack();
		sqlite.prepare(`UPDATE track SET title = 'Low Tide', artists = ?, overrides = ? WHERE id = 't1'`).run(JSON.stringify(artists), overrides == null ? null : JSON.stringify(overrides));
	};
	const credits = () => JSON.parse(sqlite.prepare(`SELECT artists FROM track WHERE id = 't1'`).pluck().get() as string) as Array<{ name: string; role?: string }>;
	const titleOf = () => sqlite.prepare(`SELECT title FROM track WHERE id = 't1'`).pluck().get() as string;
	// rekordbox's stale line: the names run together, the remixer re-cased.
	const staleRb = { title: 'Low Tide (Pell arno Rmx)', artist: 'Rook Hale Ilo Marsh, Pell arno' };

	it('the account wrote later: nothing is pulled, and the push sends the account\'s composition', async () => {
		seedCredits(ACCOUNT_CREDITS);
		seedAccountRecord(meta(ACCOUNT_CREDITS, NEWER));
		const importer = await pull([trackFrame(staleRb)]);
		expect(credits()).toEqual(ACCOUNT_CREDITS);
		expect(titleOf()).toBe('Low Tide');
		expect((statsOf(importer) as { byField: Record<string, unknown> }).byField).toMatchObject({ title: { rb: 0, account: 1 }, artist: { rb: 0, account: 1 } });
		expect(opOf(pushOps(), 'track')!.fields).toMatchObject({ Title: 'Low Tide (Pell Arno Remix)', ArtistName: 'Ilo Marsh, Rook Hale, Pell Arno' });
	});

	it('rekordbox wrote later: its strings are pulled, as before', async () => {
		seedCredits(ACCOUNT_CREDITS);
		seedAccountRecord(meta(ACCOUNT_CREDITS, OLDER));
		await pull([trackFrame(staleRb)]);
		expect(titleOf()).toBe(staleRb.title);
		expect(credits().map((a) => a.name)).toContain('Rook Hale Ilo Marsh');
	});

	it('a later override cell is the account\'s clock for its field', async () => {
		seedCredits(ACCOUNT_CREDITS, { title: 'Low Tide (Long Version)' });
		seedAccountRecord({ ...meta(ACCOUNT_CREDITS, OLDER), 'override.title': { value: 'Low Tide (Long Version)', ts: NEWER } });
		await pull([trackFrame(staleRb)]);
		const overrides = JSON.parse(sqlite.prepare(`SELECT overrides FROM track WHERE id = 't1'`).pluck().get() as string) as { title?: string };
		expect(overrides.title).toBe('Low Tide (Long Version)');
		// The artist line has no override: the meta cell is older, rb wins it.
		expect(credits().map((a) => a.name)).toContain('Rook Hale Ilo Marsh');
	});

	it('an account with no credits takes rekordbox\'s artist even when the account is newer', async () => {
		seedCredits([]);
		seedAccountRecord(meta([], NEWER));
		await pull([trackFrame({ title: 'Low Tide', artist: 'Kova Lune' })]);
		expect(credits()).toEqual([{ name: 'Kova Lune' }]);
	});
});
