// "Sync updates" convergence (2026-10-18). Every updates push since Sept
// re-sent ~1k unchanged tracks (+ their cues/tags) and ~110 no-op playlist
// merges; after the 2026-10-17 scanner re-stamp it was 4.4k tracks per run.
// The selection was track.updatedAt > rekordboxLink.rbUpdatedAtSeen, and seen
// only advances to rekordbox's post-commit updated_at — which rekordbox does
// not bump when the writer's diff no-ops. Pinned here against the REAL
// exporter on a migrated temp DB with a stub sidecar (no Python, no
// master.db):
//   - selection is pushedAt IS NULL OR updatedAt >= pushedAt, and pushedAt is
//     the time the push STARTED, so an unchanged re-sync selects nothing and
//     an edit made mid-push is picked up next time;
//   - a playlist merge with nothing to add/remove/reorder/rename is not sent;
//   - the write step streams progress and the commit is its own phase.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { memberOrder } from '../test-support/playlist-track.js';
import { RekordboxExporter, type ExportFlags, type RekordboxExportEvent } from './exporter.js';
import type { RekordboxSidecar, StaleRelation, WriteOp, WriteOpResult } from './sidecar.js';

let dir: string;
let dbPath: string;
let db: Db;
let sqlite: Database.Database;

const FULL: ExportFlags = { syncMetadata: true, syncCues: true, syncTags: true, syncPlaylist: true };
// rekordbox's updated_at for every content row, as the last pull saw it.
const RB_SEEN = 1_000;

function seedTrack(id: string, rbContentId: string, opts: { updatedAt?: number; pushedAt?: number | null; seen?: number } = {}): void {
	// The comment already carries the MyTag block for the rb tag below, as it
	// would after any earlier push — otherwise the stale-block self-heal
	// (a separate, intentional sweep) would pull the track in.
	sqlite.prepare(`INSERT INTO track (id, title, artists, rating, comment, state, updated_at) VALUES (?, ?, '[{"name":"Artist"}]', 4, ' /* peak */', 'unsorted', ?)`)
		.run(id, `Title ${id}`, opts.updatedAt ?? Date.now() - 60_000);
	sqlite.prepare(
		`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at, rb_updated_at_seen, pushed_at)
		 VALUES (?, ?, 0, 0, 0, ?, ?)`,
	).run(id, rbContentId, opts.seen ?? RB_SEEN, opts.pushedAt ?? null);
	sqlite.prepare(`INSERT INTO cue (id, track_id, slot, position_sec, kind) VALUES (?, ?, 0, 1.5, 'hot')`).run(`cue-${id}`, id);
	sqlite.prepare(`INSERT OR IGNORE INTO tag (id, name, kind) VALUES ('rb_7', 'peak', 'user')`).run();
	sqlite.prepare(`INSERT INTO track_tag (track_id, tag_id) VALUES (?, 'rb_7')`).run(id);
}

// rb playlist P with members in Curator order and a baseline that already
// agrees with them — the steady state after a verified push.
function seedPlaylist(trackIds: string[], rbIds: string[], rbNameSeen: string | null): string {
	const id = 'rb_P';
	sqlite.prepare(`INSERT INTO playlist (id, source, source_id, name, is_smart, rb_name_seen) VALUES (?, 'rekordbox', 'P', 'Set', 0, ?)`)
		.run(id, rbNameSeen);
	trackIds.forEach((tid, i) => {
		sqlite.prepare(
			`INSERT INTO playlist_track (id, order_key, playlist_id, track_id, position, source_track_id, added_by) VALUES (?, ?, ?, ?, ?, ?, 'rekordbox')`,
		).run(...memberOrder(i), id, tid, i, tid);
	});
	rbIds.forEach((cid, i) => {
		sqlite.prepare(`INSERT INTO rekordbox_membership_baseline (rb_playlist_id, member_kind, member_id, position) VALUES ('P', 'rb', ?, ?)`).run(cid, i);
	});
	return id;
}

interface Stub {
	sidecar: RekordboxSidecar;
	batches: WriteOp[][];
	// Runs inside applyWriteBatch — i.e. after the ops were built, before
	// commit/verify. The "edit during a push" hook.
	duringWrite: (() => void) | null;
	// What commit_and_close reports as each row's post-commit updated_at.
	// Default: unchanged (the writer's diff no-op'd; rekordbox didn't bump).
	commitTs: () => number;
	// What list_stale_relations reports (rb-side tombstone bindings).
	stale: StaleRelation[];
	backups: number;
}

function stubSidecar(): Stub {
	const stub: Stub = { sidecar: null as never, batches: [], duringWrite: null, commitTs: () => RB_SEEN, stale: [], backups: 0 };
	stub.sidecar = {
		listStaleRelations: async () => ({ stale: stub.stale }),
		backup: async () => { stub.backups++; return { path: 'backup/master.backup.db', sizeBytes: 1, takenAtMs: 1 }; },
		openForWrite: async () => ({ ok: true, path: dbPath }),
		applyWriteBatch: async (ops: WriteOp[], onProgress?: (done: number, total: number) => void) => {
			stub.batches.push(ops);
			stub.duringWrite?.();
			// What the Python writer streams for a batch this size.
			for (let d = 1; d < ops.length; d++) onProgress?.(d, ops.length);
			onProgress?.(ops.length, ops.length);
			return { results: ops.map((op): WriteOpResult => ({ kind: op.kind, changed: false })) };
		},
		commitAndClose: async (ids: string[]) => ({ baselines: Object.fromEntries(ids.map((id) => [id, stub.commitTs()])) }),
		verify: async () => ({ ok: true, pragma_error: null, failures: [] }),
	} as unknown as RekordboxSidecar;
	return stub;
}

async function syncUpdates(stub: Stub, flags: ExportFlags = FULL, events?: RekordboxExportEvent[]): Promise<WriteOp[]> {
	const exporter = new RekordboxExporter(db, stub.sidecar);
	if (events) exporter.on('event', (e: RekordboxExportEvent) => events.push(e));
	const before = stub.batches.length;
	const result = await exporter.runExport({ targetKind: 'updates', targetIds: [], flags, dbPath });
	expect(result.verifyOk).toBe(true);
	return stub.batches.length > before ? stub.batches[stub.batches.length - 1]! : [];
}

function selected(flags: ExportFlags = FULL): string[] {
	const exporter = new RekordboxExporter(db, {} as never);
	return (exporter as unknown as { resolveTargets: (o: unknown) => { linked: Array<{ curatorTrackId: string }> } })
		.resolveTargets({ targetKind: 'updates', targetIds: [], flags, dbPath })
		.linked.map((l) => l.curatorTrackId)
		.sort();
}

function countByKind(ops: WriteOp[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const op of ops) out[op.kind] = (out[op.kind] ?? 0) + 1;
	return out;
}

function link(trackId: string): { pushed_at: number | null; rb_updated_at_seen: number | null } {
	return sqlite.prepare(`SELECT pushed_at, rb_updated_at_seen FROM rekordbox_link WHERE track_id = ?`).get(trackId) as
		{ pushed_at: number | null; rb_updated_at_seen: number | null };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-converge-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('"Sync updates" converges', () => {
	it('a re-sync right after a verified push selects nothing and sends no ops — even when rekordbox did not bump updated_at', async () => {
		seedTrack('t1', 'C1');
		seedTrack('t2', 'C2');
		seedPlaylist(['t1', 't2'], ['C1', 'C2'], null);
		const stub = stubSidecar();

		const startedBefore = Date.now();
		const first = await syncUpdates(stub);
		// Never pushed → everything goes once; the unknown rb name rides the
		// playlist op once.
		expect(countByKind(first)).toEqual({ track: 2, cues: 2, tags: 2, playlist_merge: 1 });
		// Stamped with the run's start, not rekordbox's (unchanged) clock.
		expect(link('t1').pushed_at).toBeGreaterThanOrEqual(startedBefore);
		expect(link('t1').rb_updated_at_seen).toBe(RB_SEEN);
		// The old rule (updatedAt > seen) would still select both here.
		expect(selected()).toEqual([]);

		const second = await syncUpdates(stub);
		expect(second).toEqual([]);
		expect(stub.batches).toHaveLength(1); // nothing reached the writer at all
	});

	it('a Curator edit after the push is selected next time — and only that track', async () => {
		seedTrack('t1', 'C1');
		seedTrack('t2', 'C2');
		seedPlaylist(['t1', 't2'], ['C1', 'C2'], 'Set');
		const stub = stubSidecar();
		await syncUpdates(stub);
		expect(selected()).toEqual([]);

		sqlite.prepare(`UPDATE track SET title = 'Edited', updated_at = ? WHERE id = 't1'`).run(Date.now());
		expect(selected()).toEqual(['t1']);
		const ops = await syncUpdates(stub);
		expect(countByKind(ops)).toEqual({ track: 1, cues: 1, tags: 1 });
		expect(ops.find((o) => o.kind === 'track')).toMatchObject({ rb_content_id: 'C1', fields: { Title: 'Edited' } });
		expect(selected()).toEqual([]);
	});

	it('an edit made DURING a push (after ops were built) is selected next time, even though rekordbox stamped a later updated_at', async () => {
		seedTrack('t1', 'C1');
		seedTrack('t2', 'C2');
		const stub = stubSidecar();
		let editedAt = 0;
		stub.duringWrite = () => {
			editedAt = Date.now();
			sqlite.prepare(`UPDATE track SET rating = 5, updated_at = ? WHERE id = 't2'`).run(editedAt);
		};
		// rekordbox's post-commit updated_at lands after the edit — folding
		// `seen` into the rule (MAX(seen, pushedAt)) would mask the edit.
		stub.commitTs = () => editedAt + 60_000;
		await syncUpdates(stub);

		expect(link('t2').pushed_at).toBeLessThanOrEqual(editedAt);
		expect(link('t2').rb_updated_at_seen).toBe(editedAt + 60_000);
		expect(selected()).toEqual(['t2']);
		stub.duringWrite = null;
		const ops = await syncUpdates(stub);
		expect(ops.find((o) => o.kind === 'track')).toMatchObject({ rb_content_id: 'C2', fields: { Rating: 5 } });
		expect(selected()).toEqual([]);
	});

	it('the live 2026-10-18 shape: updated_at newer than seen but older than pushed_at is NOT selected', () => {
		// updated_at 10-17 14:41 (scanner re-stamp), seen 07-16, pushed_at 10-18 19:00.
		seedTrack('stale', 'C1', { seen: 1_000_000, updatedAt: 1_500_000, pushedAt: 2_000_000 });
		seedTrack('edited', 'C2', { seen: 1_000_000, updatedAt: 2_500_000, pushedAt: 2_000_000 });
		expect(selected()).toEqual(['edited']);
	});

	it('a never-pushed (first-link) track is selected even when its edits predate rekordbox\'s import time', () => {
		seedTrack('fresh', 'C1', { seen: 5_000, updatedAt: 1_000, pushedAt: null });
		expect(selected()).toEqual(['fresh']);
	});
});

describe('pushedAt is only stamped for scopes the push carried', () => {
	it('a metadata-only run (tags not in scope) leaves pushedAt alone, so the track stays selected', async () => {
		seedTrack('t1', 'C1');
		const stub = stubSidecar();
		await syncUpdates(stub, { ...FULL, syncTags: false, syncCues: false });
		expect(link('t1').pushed_at).toBeNull();
		expect(selected()).toEqual(['t1']);
	});

	it('with cues unchecked, a track stamps unless its cues were edited since the previous push', async () => {
		const prevPush = Date.now() - 30_000;
		seedTrack('cueEdited', 'C1', { pushedAt: prevPush, updatedAt: Date.now() - 10_000 });
		seedTrack('metaOnly', 'C2', { pushedAt: prevPush, updatedAt: Date.now() - 10_000 });
		sqlite.prepare(`UPDATE track SET cues_edited_at = ? WHERE id = 'cueEdited'`).run(Date.now() - 10_000);
		sqlite.prepare(`UPDATE track SET cues_edited_at = ? WHERE id = 'metaOnly'`).run(prevPush - 60_000);
		const stub = stubSidecar();
		await syncUpdates(stub, { ...FULL, syncCues: false });
		// The unpushed cue edit keeps its track in the dirty set for a later cue push.
		expect(link('cueEdited').pushed_at).toBe(prevPush);
		expect(link('metaOnly').pushed_at).toBeGreaterThan(prevPush);
		expect(selected()).toEqual(['cueEdited']);
	});

	it('a track with an open conflict is not stamped — its shielded field still has to go out after "keep Curator"', async () => {
		seedTrack('conflicted', 'C1');
		seedTrack('clean', 'C2');
		sqlite.prepare(`INSERT INTO sync_conflict (id, provider, track_id, kind, field_key, detected_at) VALUES ('x1', 'rekordbox', 'conflicted', 'field', 'rating', 1)`).run();
		const stub = stubSidecar();
		const ops = await syncUpdates(stub);
		const conflictedOp = ops.find((o): o is Extract<WriteOp, { kind: 'track' }> => o.kind === 'track' && o.rb_content_id === 'C1')!;
		expect('Rating' in conflictedOp.fields).toBe(false); // shielded
		expect(link('conflicted').pushed_at).toBeNull();
		expect(link('clean').pushed_at).not.toBeNull();
		// User resolves "keep Curator" (conflict row gone, updatedAt untouched).
		sqlite.prepare(`DELETE FROM sync_conflict`).run();
		expect(selected()).toEqual(['conflicted']);
		const next = await syncUpdates(stub);
		expect(next.find((o) => o.kind === 'track')).toMatchObject({ rb_content_id: 'C1', fields: { Rating: 4 } });
		expect(selected()).toEqual([]);
	});
});

describe('playlist merges with nothing to send are skipped', () => {
	it('an unchanged playlist emits no op; a rename emits one name-only op, then converges', async () => {
		seedTrack('t1', 'C1', { pushedAt: Date.now() - 1_000, updatedAt: Date.now() - 60_000 });
		const pid = seedPlaylist(['t1'], ['C1'], 'Set');
		const stub = stubSidecar();
		expect(await syncUpdates(stub)).toEqual([]);

		sqlite.prepare(`UPDATE playlist SET name = 'Set (final)' WHERE id = ?`).run(pid);
		const ops = await syncUpdates(stub);
		expect(ops).toEqual([{ kind: 'playlist_merge', rb_playlist_id: 'P', name: 'Set (final)', remove: [], add: [], order: null }]);
		expect((sqlite.prepare(`SELECT rb_name_seen AS n FROM playlist WHERE id = ?`).get(pid) as { n: string }).n).toBe('Set (final)');
		expect(await syncUpdates(stub)).toEqual([]);
	});

	it('a membership change still emits the op', async () => {
		seedTrack('t1', 'C1', { pushedAt: Date.now() - 1_000, updatedAt: Date.now() - 60_000 });
		seedTrack('t2', 'C2', { pushedAt: Date.now() - 1_000, updatedAt: Date.now() - 60_000 });
		seedPlaylist(['t1', 't2'], ['C1'], 'Set'); // Curator added t2
		const ops = await syncUpdates(stubSidecar());
		expect(ops).toEqual([{ kind: 'playlist_merge', rb_playlist_id: 'P', name: 'Set', remove: [], add: [{ rb_content_id: 'C2', position: 2 }], order: null }]);
	});
});

// The stale-relation sweep only adds a track the push can heal. Before
// 2026-10-19 it added every linked id the probe reported, so two tracks bound
// to a tombstoned album "Remembering" — with no album in Curator, which
// omit-if-empty never pushes — were re-sent (backup + write) on every run.
describe('stale-relation sweep converges', () => {
	// Steady state: pushed after the last edit, comment block already matches
	// the rb tag — the timestamp rule and the other self-heals select nothing.
	const clean = (id: string, rbId: string): void =>
		seedTrack(id, rbId, { pushedAt: Date.now() - 1_000, updatedAt: Date.now() - 60_000 });
	const album = (id: string, v: string | null): void => { sqlite.prepare(`UPDATE track SET album_title = ? WHERE id = ?`).run(v, id); };

	it('a dead album FK on a track Curator has no album for is not swept in — no ops, no backup, every run', async () => {
		clean('t1', 'C1');
		const stub = stubSidecar();
		stub.stale = [{ rbContentId: 'C1', fields: ['album'], myTags: [] }];
		expect(await syncUpdates(stub)).toEqual([]);
		expect(await syncUpdates(stub)).toEqual([]);
		expect(stub.batches).toHaveLength(0);
		expect(stub.backups).toBe(0);
	});

	it('a dead album FK on a track Curator HAS an album for is pushed, then converges once rekordbox is re-pointed', async () => {
		clean('t1', 'C1');
		clean('t2', 'C2');
		album('t1', 'Remembering');
		const stub = stubSidecar();
		stub.stale = [{ rbContentId: 'C1', fields: ['album'], myTags: [] }, { rbContentId: 'C2', fields: ['album'], myTags: [] }];
		const ops = await syncUpdates(stub);
		expect(ops.filter((o) => o.kind === 'track')).toEqual([
			expect.objectContaining({ rb_content_id: 'C1', fields: expect.objectContaining({ AlbumName: 'Remembering' }) }),
		]);
		expect(stub.backups).toBe(1);
		// The writer re-pointed C1; C2 (no Curator album) is still reported.
		stub.stale = [{ rbContentId: 'C2', fields: ['album'], myTags: [] }];
		expect(await syncUpdates(stub)).toEqual([]);
		expect(stub.backups).toBe(1);
	});

	it('an album override counts as the value (same source as the metadata op)', async () => {
		clean('t1', 'C1');
		sqlite.prepare(`UPDATE track SET overrides = ? WHERE id = 't1'`).run(JSON.stringify({ albumTitle: 'Override LP' }));
		const stub = stubSidecar();
		stub.stale = [{ rbContentId: 'C1', fields: ['album'], myTags: [] }];
		const ops = await syncUpdates(stub);
		expect(ops.find((o) => o.kind === 'track')).toMatchObject({ rb_content_id: 'C1', fields: { AlbumName: 'Override LP' } });
	});

	it('a dead MyTag is pushed only when Curator still has a tag of that name', async () => {
		clean('has', 'C1'); // rb_7 'peak'
		clean('lacks', 'C2');
		const stub = stubSidecar();
		stub.stale = [
			{ rbContentId: 'C1', fields: [], myTags: ['Peak'] }, // case-insensitive, like reconcileDeadMyTags
			{ rbContentId: 'C2', fields: [], myTags: ['vocal'] },
		];
		const ops = await syncUpdates(stub);
		expect(ops.filter((o) => o.kind === 'tags')).toEqual([{ kind: 'tags', rb_content_id: 'C1', rb_tag_ids: ['7'] }]);
		expect(ops.some((o) => 'rb_content_id' in o && o.rb_content_id === 'C2')).toBe(false);
	});

	it('respects the scope flags and the conflict shield', async () => {
		clean('t1', 'C1');
		album('t1', 'Remembering');
		const stub = stubSidecar();
		stub.stale = [{ rbContentId: 'C1', fields: ['album'], myTags: ['peak'] }];
		// Album needs syncMetadata; the MyTag needs syncTags.
		expect(await syncUpdates(stub, { ...FULL, syncMetadata: false, syncTags: false })).toEqual([]);
		stub.stale = [{ rbContentId: 'C1', fields: ['album'], myTags: [] }];
		expect(await syncUpdates(stub, { ...FULL, syncMetadata: false })).toEqual([]);
		stub.stale = [{ rbContentId: 'C1', fields: [], myTags: ['peak'] }];
		expect(await syncUpdates(stub, { ...FULL, syncTags: false })).toEqual([]);
		// An open album conflict drops AlbumName from the op — nothing to heal.
		sqlite.prepare(`INSERT INTO sync_conflict (id, provider, track_id, kind, field_key, detected_at) VALUES ('x1', 'rekordbox', 't1', 'field', 'album', 1)`).run();
		stub.stale = [{ rbContentId: 'C1', fields: ['album'], myTags: [] }];
		expect(await syncUpdates(stub)).toEqual([]);
		expect(stub.backups).toBe(0);
		// Flags on, no shield → it goes.
		sqlite.prepare(`DELETE FROM sync_conflict`).run();
		expect((await syncUpdates(stub)).some((o) => o.kind === 'track')).toBe(true);
	});
});

describe('write progress', () => {
	it('forwards the sidecar\'s in-batch progress as phase "write", then brackets the commit', async () => {
		seedTrack('t1', 'C1');
		seedTrack('t2', 'C2');
		const events: RekordboxExportEvent[] = [];
		await syncUpdates(stubSidecar(), FULL, events);
		const phases = events
			.filter((e): e is Extract<RekordboxExportEvent, { kind: 'progress' }> => e.kind === 'progress')
			.map((e) => `${e.phase}:${e.done}/${e.total}`);
		const n = 6; // 2 × (track + cues + tags)
		const writeFrames = phases.filter((p) => p.startsWith('write:'));
		expect(writeFrames[0]).toBe(`write:0/${n}`);
		expect(writeFrames).toContain(`write:3/${n}`);
		expect(writeFrames[writeFrames.length - 1]).toBe(`write:${n}/${n}`);
		const lastWrite = phases.lastIndexOf(`write:${n}/${n}`);
		expect(phases.slice(lastWrite + 1, lastWrite + 3)).toEqual(['commit:0/1', 'commit:1/1']);
		expect(phases.indexOf('verify:0/1')).toBeGreaterThan(phases.indexOf('commit:1/1'));
	});
});
