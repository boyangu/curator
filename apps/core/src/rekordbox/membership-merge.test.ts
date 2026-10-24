// Regression coverage for the playlist-membership 3-way merge that replaced
// the wholesale wipe-and-re-add. Exercises the REAL exporter diff
// (buildWriteOps → playlist_merge) and importer merge (mergePlaylistMembership)
// against a migrated temp DB, so the truth table and the unlinked-member
// protection are pinned, not just typechecked.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { memberOrder } from '../test-support/playlist-track.js';
import { createDb, type Db } from '../db/client.js';
import { RekordboxExporter } from './exporter.js';
import { RekordboxImporter } from './importer.js';
import type { WriteOp } from './sidecar.js';

let dir: string;
let dbPath: string;
let db: Db;
let sqlite: Database.Database;

function seedTrack(id: string, rbContentId: string | null): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES (?, ?, '[]', 'unsorted')`).run(id, id);
	if (rbContentId) {
		sqlite.prepare(
			`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at)
			 VALUES (?, ?, 0, 0, 0)`,
		).run(id, rbContentId);
	}
}

function seedPlaylist(rbPlaylistId: string): string {
	const id = `rb_${rbPlaylistId}`;
	sqlite.prepare(
		`INSERT INTO playlist (id, source, source_id, name, is_smart) VALUES (?, 'rekordbox', ?, ?, 0)`,
	).run(id, rbPlaylistId, rbPlaylistId);
	return id;
}

function setMembers(playlistId: string, trackIds: string[]): void {
	sqlite.prepare(`DELETE FROM playlist_track WHERE playlist_id = ?`).run(playlistId);
	trackIds.forEach((tid, i) => {
		sqlite.prepare(
			`INSERT INTO playlist_track (id, order_key, playlist_id, track_id, position, source_track_id, added_by) VALUES (?, ?, ?, ?, ?, ?, 'rekordbox')`,
		).run(...memberOrder(i), playlistId, tid, i, tid);
	});
}

function setBaseline(rbPlaylistId: string, members: Array<{ kind: 'rb' | 'curator'; id: string }>): void {
	sqlite.prepare(`DELETE FROM rekordbox_membership_baseline WHERE rb_playlist_id = ?`).run(rbPlaylistId);
	members.forEach((m, i) => {
		sqlite.prepare(
			`INSERT INTO rekordbox_membership_baseline (rb_playlist_id, member_kind, member_id, position) VALUES (?, ?, ?, ?)`,
		).run(rbPlaylistId, m.kind, m.id, i);
	});
}

function members(playlistId: string): string[] {
	return sqlite
		.prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = ? ORDER BY position`)
		.all(playlistId)
		.map((r) => (r as { track_id: string }).track_id);
}

interface RemovalHoldShape {
	rbPlaylistId: string;
	playlistId: string;
	playlistName: string;
	heldRemovals: number;
	reason: string;
	unlinkedTracks: Array<{ trackId: string; title: string; artist: string | null; hasFile: boolean }>;
}

function buildPlaylist(playlistId: string, allowMassRemovalFor?: string[]): { op: Extract<WriteOp, { kind: 'playlist_merge' }> | undefined; holds: RemovalHoldShape[] } {
	const exporter = new RekordboxExporter(db, {} as never);
	const opts = {
		targetKind: 'playlist' as const,
		targetIds: [playlistId],
		flags: { syncMetadata: false, syncCues: false, syncTags: false, syncPlaylist: true, allowMassRemovalFor },
		dbPath,
	};
	const targets = (exporter as unknown as { resolveTargets: (o: typeof opts) => { linked: unknown[]; playlistOrders: unknown[] } }).resolveTargets(opts);
	const { ops, holds } = (exporter as unknown as { buildWriteOps: (o: typeof opts, l: unknown, p: unknown) => { ops: WriteOp[]; holds: RemovalHoldShape[] } }).buildWriteOps(opts, targets.linked, targets.playlistOrders);
	return { op: ops.find((o): o is Extract<WriteOp, { kind: 'playlist_merge' }> => o.kind === 'playlist_merge'), holds };
}

function buildPlaylistOp(playlistId: string): Extract<WriteOp, { kind: 'playlist_merge' }> | undefined {
	return buildPlaylist(playlistId).op;
}

function runImportMerge(curatorPlaylistId: string, rbPlaylistId: string, rbOrder: string[]): void {
	const importer = new RekordboxImporter(db, {} as never);
	const rbTracks = rbOrder.map((cid, i) => ({ rb_content_id: cid, position: i }));
	(importer as unknown as { mergePlaylistMembership: (id: string, rb: string, t: unknown, m: Map<string, string>) => void })
		.mergePlaylistMembership(curatorPlaylistId, rbPlaylistId, rbTracks, new Map());
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-merge-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('export: targeted B-vs-C diff (the bug fix)', () => {
	it('removes only the Curator-deleted member, never the unlinked/lingering rest', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		// Baseline last agreed on A,B,C. Curator then deleted A (membership = B,C).
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }, { kind: 'rb', id: 'C' }]);
		setMembers(pid, ['tB', 'tC']);

		const op = buildPlaylistOp(pid);
		expect(op).toBeTruthy();
		expect(op!.remove).toEqual(['A']);       // only the deleted member
		expect(op!.add).toEqual([]);
		// Pure remove (no reorder of the survivors) → order=null: the writer
		// drops A and leaves B,C in rb's order, so we don't clobber it.
		expect(op!.order).toBeNull();
		// An rb member never in the baseline (e.g. one Curator could never link)
		// is, by construction, in neither remove nor add — it can't be touched.
	});

	it('adds a Curator-added member and pushes the new order', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }]);
		setMembers(pid, ['tA', 'tC', 'tB']); // added C, reordered

		const op = buildPlaylistOp(pid)!;
		expect(op.remove).toEqual([]);
		expect(op.add).toEqual([{ rb_content_id: 'C', position: 2 }]);
		expect(op.order).toEqual(['A', 'C', 'B']);
	});
});

describe('import: rb→Curator 3-way merge', () => {
	it('does NOT resurrect a Curator-deleted track on inbound sync', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }, { kind: 'rb', id: 'C' }]);
		setMembers(pid, ['tB', 'tC']);          // Curator deleted A
		runImportMerge(pid, 'P', ['A', 'B', 'C']); // rb still has all three
		expect(members(pid)).toEqual(['tB', 'tC']); // A stays gone
	});

	it('imports an rb-added track', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }]);
		setMembers(pid, ['tA', 'tB']);
		runImportMerge(pid, 'P', ['A', 'B', 'C']); // rb added C
		expect(members(pid)).toEqual(['tA', 'tB', 'tC']);
	});

	it('drops a Curator member rb deleted', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }]);
		setMembers(pid, ['tA', 'tB']);
		runImportMerge(pid, 'P', ['A']);        // rb deleted B
		expect(members(pid)).toEqual(['tA']);
	});

	it('a Curator-only member keeps its place, ahead of linked tracks Curator added after it', () => {
		seedTrack('tA', 'A'); seedTrack('tX', null); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		// A second desktop's first pull: no baseline, rekordbox holds A only;
		// X has no rekordbox file, B and C were added in Curator after it.
		setMembers(pid, ['tA', 'tX', 'tB', 'tC']);
		const keyOf = (t: string): string => sqlite.prepare(`SELECT order_key FROM playlist_track WHERE playlist_id = ? AND track_id = ?`).pluck().get(pid, t) as string;
		const before = keyOf('tX');
		runImportMerge(pid, 'P', ['A']);
		expect(members(pid)).toEqual(['tA', 'tX', 'tB', 'tC']);
		expect(keyOf('tX')).toBe(before);
	});

	it('a Curator-only member follows its predecessor through a rekordbox reorder, and leads when it led', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tX', null); seedTrack('tY', null);
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }]);
		setMembers(pid, ['tY', 'tA', 'tX', 'tB']);
		runImportMerge(pid, 'P', ['B', 'A']);   // only rekordbox reordered
		expect(members(pid)).toEqual(['tY', 'tB', 'tA', 'tX']);
	});

	it('honors the tombstone: rb re-add of deleted content is not imported, and is queued for rb removal', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }]);
		setMembers(pid, ['tA']);
		sqlite.prepare(`INSERT INTO rekordbox_deleted_content (rb_content_id, deleted_at) VALUES ('B', 0)`).run();
		runImportMerge(pid, 'P', ['A', 'B']);   // rb has tombstoned B
		expect(members(pid)).toEqual(['tA']);   // B not imported
		const base = sqlite.prepare(`SELECT member_id FROM rekordbox_membership_baseline WHERE rb_playlist_id='P' AND member_id='B'`).get();
		expect(base).toBeTruthy();              // seeded so the exporter removes B from rb
	});

	it('records an order conflict when both sides reordered', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }, { kind: 'rb', id: 'C' }]);
		setMembers(pid, ['tC', 'tB', 'tA']);    // Curator reordered
		runImportMerge(pid, 'P', ['B', 'C', 'A']); // rb reordered differently
		const conflict = sqlite.prepare(`SELECT kind FROM playlist_conflict WHERE rb_playlist_id='P'`).get();
		expect(conflict).toBeTruthy();
	});

	it('no order conflict when only one side reordered', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }, { kind: 'rb', id: 'C' }]);
		setMembers(pid, ['tA', 'tB', 'tC']);    // Curator unchanged
		runImportMerge(pid, 'P', ['C', 'B', 'A']); // only rb reordered
		const conflict = sqlite.prepare(`SELECT kind FROM playlist_conflict WHERE rb_playlist_id='P'`).get();
		expect(conflict).toBeFalsy();
		expect(members(pid)).toEqual(['tC', 'tB', 'tA']); // rb order adopted
	});
});

describe('export: order-push guard (clobber safety)', () => {
	// The exporter must send order=null unless Curator actually changed the
	// ordering — otherwise it overwrites a rb-side manual reorder the
	// incremental pull hasn't reconciled. "Changed ordering" excludes pure
	// tail-adds and pure removes (the writer reproduces those for order=null),
	// but INCLUDES mid-list inserts (the writer appends adds when order=null,
	// so a mid insert needs the explicit order to land in place).
	it('suppresses order when Curator is unchanged vs baseline (rb keeps its order)', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }, { kind: 'rb', id: 'C' }]);
		setMembers(pid, ['tA', 'tB', 'tC']);     // identical to baseline order
		const op = buildPlaylistOp(pid)!;
		expect(op.order).toBeNull();
		expect(op.add).toEqual([]);
		expect(op.remove).toEqual([]);
	});

	it('suppresses order for a pure tail-add (writer appends; no reorder)', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }]);
		setMembers(pid, ['tA', 'tB', 'tC']);     // C added at the tail
		const op = buildPlaylistOp(pid)!;
		expect(op.add).toEqual([{ rb_content_id: 'C', position: 3 }]);
		expect(op.order).toBeNull();
	});

	it('suppresses order for a pure remove (writer drops it; rest unchanged)', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }, { kind: 'rb', id: 'C' }]);
		setMembers(pid, ['tA', 'tC']);           // removed B, order otherwise intact
		const op = buildPlaylistOp(pid)!;
		expect(op.remove).toEqual(['B']);
		expect(op.order).toBeNull();
	});

	it('pushes order for a mid-list insert so the add lands in place', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }]);
		setMembers(pid, ['tA', 'tC', 'tB']);     // C inserted between A and B
		const op = buildPlaylistOp(pid)!;
		expect(op.order).toEqual(['A', 'C', 'B']);
	});

	it('pushes order when Curator reordered existing members', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }, { kind: 'rb', id: 'C' }]);
		setMembers(pid, ['tC', 'tB', 'tA']);     // reordered, no adds/removes
		const op = buildPlaylistOp(pid)!;
		expect(op.order).toEqual(['C', 'B', 'A']);
	});
});

describe('export: removal guards (the 2026-06/07 phantom-delete class)', () => {
	it('unlinked ≠ removed: holds removals while any member has no rekordbox_link', () => {
		// The incident shape: tB is still IN the playlist but its link broke
		// (scanner re-bind) — the diff sees baseline B, current {A} and would
		// conclude "user deleted B". The guard must hold that removal.
		seedTrack('tA', 'A'); seedTrack('tB', null); // tB unlinked
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }]);
		setMembers(pid, ['tA', 'tB']);
		const { op, holds } = buildPlaylist(pid);
		expect(op!.remove).toEqual([]);
		expect(holds).toEqual([{
			rbPlaylistId: 'P', playlistId: pid, playlistName: 'P', heldRemovals: 1, reason: 'unlinked-members',
			// The invisible member is named on the hold so the dialog can
			// tell the user what the removal is waiting on.
			unlinkedTracks: [{ trackId: 'tB', title: 'tB', artist: null, hasFile: false }],
		}]);
	});

	it('unlinked members also suppress the order push (writer would tail-drift them)', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tX', null);
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }]);
		setMembers(pid, ['tB', 'tX', 'tA']);     // genuine reorder + unlinked member
		const { op, holds } = buildPlaylist(pid);
		expect(op!.order).toBeNull();            // held, not ['B','A']
		expect(op!.remove).toEqual([]);
		expect(holds).toHaveLength(1);
		expect(holds[0]!.reason).toBe('unlinked-members');
	});

	it('mass-removal breaker: holds when the diff drops more than max(3, 10%) of the baseline', () => {
		for (const t of ['tA', 'tB', 'tC', 'tD', 'tE']) seedTrack(t, t.slice(1));
		const pid = seedPlaylist('P');
		setBaseline('P', ['A', 'B', 'C', 'D', 'E'].map((id) => ({ kind: 'rb' as const, id })));
		setMembers(pid, ['tA']);                 // 4 of 5 gone — corruption-shaped
		const { op, holds } = buildPlaylist(pid);
		expect(op!.remove).toEqual([]);
		expect(holds).toEqual([{ rbPlaylistId: 'P', playlistId: pid, playlistName: 'P', heldRemovals: 4, reason: 'mass-removal', unlinkedTracks: [] }]);
	});

	it('mass-removal waiver: allowMassRemovalFor lets the big removal through for that playlist', () => {
		for (const t of ['tA', 'tB', 'tC', 'tD', 'tE']) seedTrack(t, t.slice(1));
		const pid = seedPlaylist('P');
		setBaseline('P', ['A', 'B', 'C', 'D', 'E'].map((id) => ({ kind: 'rb' as const, id })));
		setMembers(pid, ['tA']);                 // 4 of 5 gone — same shape as the held case
		const { op, holds } = buildPlaylist(pid, ['P']); // user confirmed "Push anyway"
		expect(op!.remove).toEqual(['B', 'C', 'D', 'E']);
		expect(holds).toEqual([]);
	});

	it('mass-removal waiver does NOT override unlinked-members (link loss always holds)', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		seedTrack('tD', 'D'); seedTrack('tE', null);  // tE unlinked
		const pid = seedPlaylist('P');
		setBaseline('P', ['A', 'B', 'C', 'D', 'E'].map((id) => ({ kind: 'rb' as const, id })));
		setMembers(pid, ['tA', 'tE']);           // B,C,D dropped AND a member is unlinked
		const { op, holds } = buildPlaylist(pid, ['P']); // waiver present, but…
		expect(op!.remove).toEqual([]);          // still held — unlinked wins
		// tE is unlinked so it's absent from the linked diff: removeAll is
		// {B,C,D,E} = 4 (E looks dropped because its link is gone).
		expect(holds).toEqual([{
			rbPlaylistId: 'P', playlistId: pid, playlistName: 'P', heldRemovals: 4, reason: 'unlinked-members',
			unlinkedTracks: [{ trackId: 'tE', title: 'tE', artist: null, hasFile: false }],
		}]);
	});

	it('small removals still flow (at or under the threshold)', () => {
		for (const t of ['tA', 'tB', 'tC', 'tD', 'tE']) seedTrack(t, t.slice(1));
		const pid = seedPlaylist('P');
		setBaseline('P', ['A', 'B', 'C', 'D', 'E'].map((id) => ({ kind: 'rb' as const, id })));
		setMembers(pid, ['tA', 'tB']);           // 3 of 5 removed == max(3, ceil(0.5)) → allowed
		const { op, holds } = buildPlaylist(pid);
		expect(op!.remove).toEqual(['C', 'D', 'E']);
		expect(holds).toEqual([]);
	});
});

function baselineRb(rbPlaylistId: string): string[] {
	return sqlite
		.prepare(`SELECT member_id FROM rekordbox_membership_baseline WHERE rb_playlist_id = ? AND member_kind = 'rb' ORDER BY position`)
		.all(rbPlaylistId)
		.map((r) => (r as { member_id: string }).member_id);
}

describe('import: baseline advance after pull (rb-originated changes are not Curator edits)', () => {
	// 2026-09-15: rb-side adds landed in Curator at their rb positions, but
	// the baseline only ever advanced after a push — so the very next push
	// saw them as Curator adds + a Curator reorder and rewrote every TrackNo
	// in the playlist. After a pull, the push must see nothing to do.
	it('rb mid-list add: baseline adopts it at rb position; push emits no add and no order', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }]);
		setMembers(pid, ['tA', 'tB']);
		runImportMerge(pid, 'P', ['A', 'C', 'B']);   // rb inserted C in the middle
		expect(members(pid)).toEqual(['tA', 'tC', 'tB']);
		expect(baselineRb('P')).toEqual(['A', 'C', 'B']);
		const op = buildPlaylistOp(pid)!;
		expect(op.add).toEqual([]);
		expect(op.order).toBeNull();
	});

	it('member that just gained its rekordbox_link is not re-added or reordered by the push', () => {
		seedTrack('tA', 'A'); seedTrack('tX', null);
		const pid = seedPlaylist('P');
		// Last push recorded tX as a curator-only member; rb then imported its file.
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'curator', id: 'tX' }]);
		setMembers(pid, ['tA', 'tX']);
		sqlite.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at) VALUES ('tX', 'X', 0, 0, 0)`).run();
		runImportMerge(pid, 'P', ['A', 'X']);
		expect(members(pid)).toEqual(['tA', 'tX']);
		expect(baselineRb('P')).toEqual(['A', 'X']);
		const op = buildPlaylistOp(pid)!;
		expect(op.add).toEqual([]);
		expect(op.order).toBeNull();
	});

	it('Curator-pending removal stays in the baseline so the push still removes it from rb', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }, { kind: 'rb', id: 'C' }]);
		setMembers(pid, ['tA', 'tC']);               // Curator removed B, not pushed yet
		runImportMerge(pid, 'P', ['A', 'B', 'C']);   // rb unchanged
		expect(members(pid)).toEqual(['tA', 'tC']);
		expect(baselineRb('P')).toEqual(['A', 'C', 'B']);
		const op = buildPlaylistOp(pid)!;
		expect(op.remove).toEqual(['B']);
		expect(op.order).toBeNull();
	});

	it('Curator-pending add stays OUT of the baseline so the push still adds it', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }]);
		setMembers(pid, ['tA', 'tB', 'tC']);         // Curator added C at the tail
		runImportMerge(pid, 'P', ['A', 'B']);
		expect(members(pid)).toEqual(['tA', 'tB', 'tC']);
		expect(baselineRb('P')).toEqual(['A', 'B']);
		const op = buildPlaylistOp(pid)!;
		expect(op.add).toEqual([{ rb_content_id: 'C', position: 3 }]);
		expect(op.order).toBeNull();
	});

	it('only Curator reordered + rb add: the add is kept (never dropped) and Curator order still pushes', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C'); seedTrack('tD', 'D');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }, { kind: 'rb', id: 'C' }]);
		setMembers(pid, ['tC', 'tB', 'tA']);         // Curator reordered
		runImportMerge(pid, 'P', ['A', 'B', 'C', 'D']); // rb appended D, order otherwise same
		expect(members(pid)).toEqual(['tC', 'tB', 'tA', 'tD']);
		expect(baselineRb('P')).toEqual(['A', 'B', 'C', 'D']); // rb membership agreed, rb sequence kept
		const op = buildPlaylistOp(pid)!;
		expect(op.add).toEqual([]);
		expect(op.order).toEqual(['C', 'B', 'A', 'D']);
	});

	it('both reordered: baseline is left untouched while the order conflict is open', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B'); seedTrack('tC', 'C');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }, { kind: 'rb', id: 'C' }]);
		setMembers(pid, ['tC', 'tB', 'tA']);
		runImportMerge(pid, 'P', ['B', 'C', 'A']);
		expect(sqlite.prepare(`SELECT kind FROM playlist_conflict WHERE rb_playlist_id='P'`).get()).toBeTruthy();
		expect(baselineRb('P')).toEqual(['A', 'B', 'C']);
	});

	it('rb member Curator cannot resolve is neither imported nor adopted into the baseline (never removed from rb)', () => {
		seedTrack('tA', 'A');                         // 'Z' has no Curator track at all
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }]);
		setMembers(pid, ['tA']);
		runImportMerge(pid, 'P', ['A', 'Z']);
		expect(members(pid)).toEqual(['tA']);
		expect(baselineRb('P')).toEqual(['A']);
		const op = buildPlaylistOp(pid)!;
		expect(op.remove).toEqual([]);
		expect(op.add).toEqual([]);
		expect(op.order).toBeNull();
	});

	it('rb removal drops the member from the baseline too', () => {
		seedTrack('tA', 'A'); seedTrack('tB', 'B');
		const pid = seedPlaylist('P');
		setBaseline('P', [{ kind: 'rb', id: 'A' }, { kind: 'rb', id: 'B' }]);
		setMembers(pid, ['tA', 'tB']);
		runImportMerge(pid, 'P', ['A']);             // rb deleted B
		expect(members(pid)).toEqual(['tA']);
		expect(baselineRb('P')).toEqual(['A']);
		const op = buildPlaylistOp(pid)!;
		expect(op.remove).toEqual([]);
		expect(op.add).toEqual([]);
	});
});
