// Order keys + derived positions through the service's playlist writers:
// after every append / remove / reorder the rows sort by (order_key, id) in
// the order the user asked for and positions read 0..n-1; a reorder rekeys
// only the rows that moved.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { rebalance } from '@curator/protocol';
import { migrate } from '../db/migrate.js';
import { createCoreService, type CoreService } from '../service.js';
import { planReorderKeys, recomputePositions } from './playlist-order.js';

let dir: string;
let dbPath: string;
let sqlite: Database.Database;
let svc: CoreService;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-playlist-order-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	sqlite = new Database(dbPath);
	const ins = sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES (?, ?, '[]', 'unsorted')`);
	for (let i = 0; i < 8; i++) ins.run(`t${i}`, `T${i}`);
	svc = createCoreService(dbPath, { peaksDir: join(dir, 'peaks') });
});

afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* sibling DB handles on Windows */ }
});

type Row = { id: string; track_id: string; order_key: string; position: number };
const rows = (pid: string): Row[] =>
	sqlite.prepare(`SELECT id, track_id, order_key, position FROM playlist_track WHERE playlist_id = ? ORDER BY order_key, id`).all(pid) as Row[];

// The invariants every writer must leave behind.
function expectConsistent(pid: string): Row[] {
	const r = rows(pid);
	expect(r.map((x) => x.position)).toEqual(r.map((_, i) => i));
	for (let i = 1; i < r.length; i++) expect(r[i - 1]!.order_key < r[i]!.order_key).toBe(true);
	return r;
}

async function makePlaylist(n: number): Promise<string> {
	const pl = await svc.createLocalPlaylistFromTracks('P', Array.from({ length: n }, (_, i) => `t${i}`));
	return pl.id;
}

describe('playlist writers keep order keys and positions consistent', () => {
	it('create writes evenly spaced keys at 0..n-1', async () => {
		const pid = await makePlaylist(4);
		expect(expectConsistent(pid).map((r) => r.track_id)).toEqual(['t0', 't1', 't2', 't3']);
	});

	it('append lands after the last row without touching existing keys', async () => {
		const pid = await makePlaylist(3);
		const before = rows(pid);
		await svc.addTracksToPlaylist(pid, ['t5', 't6']);
		const after = expectConsistent(pid);
		expect(after.map((r) => r.track_id)).toEqual(['t0', 't1', 't2', 't5', 't6']);
		expect(after.slice(0, 3).map((r) => [r.id, r.order_key])).toEqual(before.map((r) => [r.id, r.order_key]));
	});

	it('remove restamps positions and leaves survivors their keys', async () => {
		const pid = await makePlaylist(5);
		const before = new Map(rows(pid).map((r) => [r.id, r.order_key]));
		await svc.removeTracksFromPlaylist(pid, ['t0', 't3']);
		const after = expectConsistent(pid);
		expect(after.map((r) => r.track_id)).toEqual(['t1', 't2', 't4']);
		for (const r of after) expect(r.order_key).toBe(before.get(r.id));
	});

	it('a single drag rekeys exactly one row and positions stay 0-based', async () => {
		const pid = await makePlaylist(6);
		const before = rows(pid);
		// Drag t4 to the top: newOrder lists CURRENT positions in the new order.
		await svc.reorderPlaylistTracks(pid, [4, 0, 1, 2, 3, 5]);
		const after = expectConsistent(pid);
		expect(after.map((r) => r.track_id)).toEqual(['t4', 't0', 't1', 't2', 't3', 't5']);
		const keyBefore = new Map(before.map((r) => [r.id, r.order_key]));
		expect(after.filter((r) => r.order_key !== keyBefore.get(r.id)).map((r) => r.track_id)).toEqual(['t4']);
	});

	it('a reverse sort rekeys the minimal set (all but one row)', async () => {
		const pid = await makePlaylist(6);
		const before = new Map(rows(pid).map((r) => [r.id, r.order_key]));
		await svc.reorderPlaylistTracks(pid, [5, 4, 3, 2, 1, 0]);
		const after = expectConsistent(pid);
		expect(after.map((r) => r.track_id)).toEqual(['t5', 't4', 't3', 't2', 't1', 't0']);
		expect(after.filter((r) => r.order_key !== before.get(r.id))).toHaveLength(5);
	});

	it('the positions a reorder leaves are the ones the next reorder accepts', async () => {
		const pid = await makePlaylist(4);
		await svc.reorderPlaylistTracks(pid, [3, 2, 1, 0]);
		await svc.reorderPlaylistTracks(pid, [1, 0, 2, 3]);
		expect(expectConsistent(pid).map((r) => r.track_id)).toEqual(['t2', 't3', 't1', 't0']);
		await expect(svc.reorderPlaylistTracks(pid, [1, 2, 3, 4])).rejects.toThrow(/unknown position 4/);
	});

	it('duplicates of one track are separate rows that reorder independently', async () => {
		const pl = await svc.createLocalPlaylistFromTracks('D', ['t0', 't1', 't0']);
		await svc.reorderPlaylistTracks(pl.id, [2, 1, 0]);
		const after = expectConsistent(pl.id);
		expect(after.map((r) => r.track_id)).toEqual(['t0', 't1', 't0']);
		expect(new Set(after.map((r) => r.id)).size).toBe(3);
	});
});

describe('planReorderKeys', () => {
	const current = (n: number) => rebalance(n).map((k, i) => ({ id: `r${i}`, orderKey: k }));

	it('returns no changes for the identity permutation', () => {
		expect(planReorderKeys(current(5), [0, 1, 2, 3, 4]).size).toBe(0);
	});

	it('rekeys a moved block between its new neighbours', () => {
		const cur = current(6);
		const perm = [0, 3, 4, 1, 2, 5];
		const plan = planReorderKeys(cur, perm);
		// LIS of the permutation keeps four rows; the other two move.
		expect(plan.size).toBe(2);
		const keyOf = (id: string) => plan.get(id) ?? cur.find((r) => r.id === id)!.orderKey;
		const ordered = perm.map((i) => keyOf(cur[i]!.id));
		expect([...ordered].sort()).toEqual(ordered);
	});

	it('rekeys the whole playlist when kept neighbours share a key and a row must go between them', () => {
		// Two rows inserted into one gap by two devices: same key, tie broken by id.
		const cur = [{ id: 'a', orderKey: 'a0' }, { id: 'b', orderKey: 'a1' }, { id: 'c', orderKey: 'a1' }];
		const plan = planReorderKeys(cur, [1, 0, 2]);
		const keyOf = (id: string) => plan.get(id) ?? cur.find((r) => r.id === id)!.orderKey;
		expect(['b', 'a', 'c'].map(keyOf)).toEqual([...['b', 'a', 'c'].map(keyOf)].sort());
		expect(new Set(['a', 'b', 'c'].map(keyOf)).size).toBe(3);
	});
});

describe('recomputePositions', () => {
	it('closes gaps and repairs a stale order without tripping the unique index', async () => {
		const pid = await makePlaylist(4);
		// Simulate drift: reverse and gap the positions (0..3 → 19..16) so
		// none matches the key order.
		sqlite.exec(`UPDATE playlist_track SET position = -1 - position WHERE playlist_id = '${pid}'`);
		sqlite.exec(`UPDATE playlist_track SET position = 20 + position WHERE playlist_id = '${pid}'`);
		expect(recomputePositions(sqlite, pid)).toBe(4);
		expect(expectConsistent(pid).map((r) => r.track_id)).toEqual(['t0', 't1', 't2', 't3']);
		expect(recomputePositions(sqlite, pid)).toBe(0);
	});
});
