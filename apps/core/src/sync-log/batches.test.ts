// 'batches' on the desktop: a one-time backlog (the initial push, a
// backfill) goes up as one server batch when the server offers it — staged,
// committed, acked together — while edits keep going out as plain pushes;
// an open batch is resumed after a restart and re-staged when the server
// dropped it; an older server (or a transport without the procedures) gets
// plain pushes; a backlog found pending at upgrade is classified for a batch
// without losing or doubling an op. And the two-desktop picture: A's
// backfill is invisible to B until the commit, then B bootstraps from the
// commit's snapshot and converges.
//
// Generated DBs only (CLAUDE.md): mkdtempSync + migrate(); every transport
// is the in-memory fake (test-support/fake-cloud.ts), nothing leaves the
// process.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@curator/shared/schema';
import { migrate } from '../db/migrate.js';
import { createDb } from '../db/client.js';
import * as mut from '../library/mutators.js';
import { syncTrackArtistsByIdRaw } from '../library/artists.js';
import { FakeCloud } from '../test-support/fake-cloud.js';
import { INITIAL_PUSH_KEY } from './apply.js';
import { CloudTransportError, createSyncClient, type CloudTransport, type SyncClient } from './client.js';
import { compareDumps, dumpLibrary } from './dump.js';
import { emitOps } from './outbox.js';
import { recordingIdForTrack } from './recording-id.js';

const TRACKS = Array.from({ length: 8 }, (_, i) => `trk-${i}`);

let dir: string;
const handles: Database.Database[] = [];
const clients: SyncClient[] = [];

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-batches-')); });
afterEach(() => {
	for (const c of clients.splice(0)) c.stop();
	for (const h of handles.splice(0)) { try { h.close(); } catch { /* closed by the test */ } }
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

function freshDb(name: string): { path: string; raw: Database.Database } {
	const p = join(dir, `${name}.db`);
	migrate(p);
	const { sqlite } = createDb(p);
	handles.push(sqlite);
	const ins = sqlite.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration) VALUES (?, ?, ?, '[{"name":"Artist"}]', 'unsorted', 300)`);
	for (const id of TRACKS) ins.run(id, recordingIdForTrack(id), `Title ${id}`);
	syncTrackArtistsByIdRaw(sqlite, TRACKS);
	return { path: p, raw: sqlite };
}

// A library from before the op log: tags and assignments no op ever stated,
// so the next sign-in's initial push emits them ('initial-push').
function legacy(raw: Database.Database, tags = 30): void {
	raw.transaction(() => {
		const tag = raw.prepare(`INSERT INTO tag (id, name, kind, created_at) VALUES (?, ?, 'user', ?)`);
		const tt = raw.prepare(`INSERT INTO track_tag (track_id, tag_id, added_at) VALUES (?, ?, ?)`);
		for (let i = 0; i < tags; i++) {
			tag.run(`lt-${i}`, `Legacy ${i}`, 1_600_000_000_000 + i);
			tt.run(TRACKS[i % TRACKS.length]!, `lt-${i}`, 1_600_000_000_000 + i);
		}
		raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(INITIAL_PUSH_KEY);
	})();
}

// A backfill's ops, as the v4 backfills emit them: stating rows this
// library already holds.
function backfill(raw: Database.Database, n: number, prefix = 'bf'): void {
	raw.transaction(() => {
		const tag = raw.prepare(`INSERT INTO tag (id, name, kind, created_at) VALUES (?, ?, 'user', ?)`);
		for (let i = 0; i < n; i++) tag.run(`${prefix}-${i}`, `Backfilled ${i}`, 1_600_000_000_000 + i);
		emitOps(raw, Array.from({ length: n }, (_, i) => ({ entity: 'tag' as const, entity_id: `${prefix}-${i}`, kind: 'create' as const, payload: { name: `Backfilled ${i}`, kind: 'user' as const } })), { batchLabel: 'backfill' });
	})();
}

// Edits through the mutator layer: never labelled.
function edit(raw: Database.Database, n: number, prefix = 'ed'): void {
	const db = drizzle(raw, { schema });
	for (let i = 0; i < n; i++) mut.createTag(db, { id: `${prefix}-${i}`, name: `Edit ${i}` });
}

function client(raw: Database.Database, transport: CloudTransport, extra: Partial<Parameters<typeof createSyncClient>[0]> = {}): SyncClient {
	const c = createSyncClient({ db: raw, transport, backoffBaseMs: 5, backoffCapMs: 40, debounceMs: 1, batchMinOps: 20, batchCommitPollMs: 1, batchCommitPolls: 3, ...extra });
	clients.push(c);
	return c;
}

const states = (raw: Database.Database): Record<string, number> =>
	Object.fromEntries((raw.prepare(`SELECT state, count(*) AS n FROM sync_outbox GROUP BY state`).all() as Array<{ state: string; n: number }>).map((r) => [r.state, r.n]));
const opIds = (raw: Database.Database, where = '1'): string[] => raw.prepare(`SELECT op_id FROM sync_outbox WHERE ${where} ORDER BY seq_local`).pluck().all() as string[];
const logIds = (cloud: FakeCloud): string[] => cloud.log.map((o) => o.op_id);
const unique = (xs: string[]): boolean => new Set(xs).size === xs.length;

describe('the backlog goes up as a batch', () => {
	it('stages a first sign-in’s initial push and commits it; plain pushes carry none of it', async () => {
		const cloud = new FakeCloud();
		const { raw } = freshDb('a');
		legacy(raw);
		const c = client(raw, cloud.transport('u'));
		await c.syncNow();
		const labelled = opIds(raw, `batch_label = 'initial-push'`);
		expect(labelled.length).toBeGreaterThanOrEqual(20);
		expect(states(raw)).toEqual({ acked: opIds(raw).length });
		expect(cloud.calls.batchBegin).toBe(1);
		expect(cloud.calls.batchPush).toBeGreaterThan(0);
		expect(cloud.calls.batchCommit).toBe(1);
		// Plain pushes: the empty features probe and whatever was not the backlog.
		const plain = cloud.pushLog.reduce((n, p) => n + p.sent, 0);
		expect(plain).toBe(opIds(raw).length - labelled.length);
		expect(logIds(cloud).sort()).toEqual(opIds(raw).sort());
		expect(unique(logIds(cloud))).toBe(true);
		// The commit took a snapshot that holds the batch.
		expect(cloud.batches.size).toBe(1);
		expect([...cloud.batches.values()][0]).toMatchObject({ label: 'initial-push', status: 'committed' });
		expect(c.status().batch).toBeNull();
	});

	it('pushes everything plainly to a server without the feature, or through a transport without the procedures', async () => {
		const old = new FakeCloud();
		old.features = old.features.filter((f) => f !== 'batches');
		const a = freshDb('a');
		legacy(a.raw);
		await client(a.raw, old.transport('u')).syncNow();
		expect(old.calls.batchBegin + old.calls.batchPush + old.calls.batchCommit).toBe(0);
		expect(states(a.raw)).toEqual({ acked: opIds(a.raw).length });
		expect(logIds(old).sort()).toEqual(opIds(a.raw).sort());

		const cloud = new FakeCloud();
		const b = freshDb('b');
		legacy(b.raw);
		const t = cloud.transport('u2');
		const bare: CloudTransport = { ...t, sync: { push: t.sync.push, pull: t.sync.pull } };
		await client(b.raw, bare).syncNow();
		expect(cloud.calls.batchBegin).toBe(0);
		expect(states(b.raw)).toEqual({ acked: opIds(b.raw).length });
	});

	it('never batches edits, and a small labelled backlog goes plainly too', async () => {
		const cloud = new FakeCloud();
		const { raw } = freshDb('a');
		await client(raw, cloud.transport('u')).syncNow();
		backfill(raw, 5);
		edit(raw, 30);
		await client(raw, cloud.transport('u')).syncNow();
		expect(cloud.calls.batchBegin).toBe(0);
		expect(states(raw)).toEqual({ acked: opIds(raw).length });
		// A big backlog and edits made while it goes up: the edits are pushed
		// plainly, while the batch is still committing.
		cloud.holdCommits = true;
		backfill(raw, 60, 'big');
		const c = client(raw, cloud.transport('u'));
		const editsBefore = cloud.log.length;
		await c.syncNow();
		expect(cloud.log.length).toBe(editsBefore);
		edit(raw, 3, 'during');
		await c.syncNow();
		const during = opIds(raw, `entity_id LIKE 'during-%'`);
		expect(during).toHaveLength(3);
		expect(logIds(cloud)).toEqual(expect.arrayContaining(during));
		expect(opIds(raw, `batch_label IS NOT NULL AND state = 'pending'`)).toHaveLength(60);
		expect(c.status().pending).toBe(60);
		cloud.holdCommits = false;
		await c.syncNow();
		expect(states(raw)).toEqual({ acked: opIds(raw).length });
		expect(unique(logIds(cloud))).toBe(true);
	});

	it('labels a large drain (a meta backfill) for a batch, a small one not', async () => {
		const cloud = new FakeCloud();
		const { raw } = freshDb('a');
		await client(raw, cloud.transport('u'), { batchMinOps: 5 }).syncNow();
		const meta = raw.prepare(`SELECT batch_label AS label, count(*) AS n FROM sync_outbox WHERE kind = 'set-meta' GROUP BY batch_label`).all();
		expect(meta).toEqual([{ label: 'backfill', n: TRACKS.length }]);
		expect(cloud.calls.batchCommit).toBeGreaterThan(0);
		raw.prepare(`UPDATE track SET title = 'Renamed' WHERE id = ?`).run(TRACKS[0]);
		await client(raw, cloud.transport('u'), { batchMinOps: 5 }).syncNow();
		const edited = raw.prepare(`SELECT batch_label FROM sync_outbox WHERE kind = 'set-meta' ORDER BY seq_local DESC LIMIT 1`).pluck().get();
		expect(edited).toBeNull();
	});
});

describe('resuming', () => {
	it('resumes the open batch after a restart mid-staging, without doubling an op', async () => {
		const cloud = new FakeCloud();
		const { raw } = freshDb('a');
		await client(raw, cloud.transport('u')).syncNow();
		backfill(raw, 1_200);
		const t = cloud.transport('u');
		let pushes = 0;
		// The app quits after two staging calls (the third never answers).
		const crashing: CloudTransport = { ...t, sync: { ...t.sync, batchPush: async (input) => {
			if (++pushes === 3) throw new CloudTransportError('network', 'net::ERR_CONNECTION_RESET');
			return t.sync.batchPush!(input);
		} } };
		const first = client(raw, crashing);
		await first.syncNow();
		first.stop();
		const staged = opIds(raw, `batch_id IS NOT NULL`);
		expect(staged).toHaveLength(1_000);
		const batchId = raw.prepare(`SELECT DISTINCT batch_id FROM sync_outbox WHERE batch_id IS NOT NULL`).pluck().get() as string;
		expect(JSON.parse(raw.prepare(`SELECT value FROM app_setting WHERE key = 'sync.client'`).pluck().get() as string).batches).toEqual({ backfill: { batchId, committing: false } });
		expect(cloud.log.length).toBe(opIds(raw, `batch_label IS NULL`).length);

		// Restart: the same batch, the rest staged, one commit.
		const second = client(raw, cloud.transport('u'));
		await second.syncNow();
		expect(cloud.batches.get(batchId)).toMatchObject({ status: 'committed' });
		expect(cloud.calls.batchBegin).toBe(2);
		expect(states(raw)).toEqual({ acked: opIds(raw).length });
		expect(logIds(cloud).sort()).toEqual(opIds(raw).sort());
		expect(unique(logIds(cloud))).toBe(true);
	});

	it('resumes a commit the server was still running when the app quit', async () => {
		const cloud = new FakeCloud();
		const { raw } = freshDb('a');
		await client(raw, cloud.transport('u')).syncNow();
		backfill(raw, 100);
		cloud.holdCommits = true;
		const first = client(raw, cloud.transport('u'));
		await first.syncNow();
		first.stop();
		const st = JSON.parse(raw.prepare(`SELECT value FROM app_setting WHERE key = 'sync.client'`).pluck().get() as string) as { batches: Record<string, { committing: boolean }> };
		expect(st.batches['backfill']!.committing).toBe(true);
		expect(states(raw)['pending']).toBe(100);
		cloud.holdCommits = false;
		const second = client(raw, cloud.transport('u'));
		await second.syncNow();
		// Polled, not staged again.
		expect(cloud.calls.batchBegin).toBe(1);
		expect(states(raw)).toEqual({ acked: opIds(raw).length });
		expect(unique(logIds(cloud))).toBe(true);
	});

	it('stages again under a new batch when the server expired the old one', async () => {
		const cloud = new FakeCloud();
		const { raw } = freshDb('a');
		await client(raw, cloud.transport('u')).syncNow();
		backfill(raw, 300);
		const t = cloud.transport('u');
		const noCommit: CloudTransport = { ...t, sync: { ...t.sync, batchCommit: async () => { throw new CloudTransportError('network', 'net::ERR_INTERNET_DISCONNECTED'); } } };
		const first = client(raw, noCommit);
		await first.syncNow();
		first.stop();
		const oldId = raw.prepare(`SELECT DISTINCT batch_id FROM sync_outbox WHERE batch_id IS NOT NULL`).pluck().get() as string;
		expect(opIds(raw, `batch_id = '${oldId}'`)).toHaveLength(300);
		// The client marked it committing before the commit call failed: the
		// server, a day later, has expired it anyway (it never saw the commit).
		cloud.expireBatch(oldId);
		cloud.batches.get(oldId)!.status = 'expired';
		await client(raw, cloud.transport('u')).syncNow();
		await client(raw, cloud.transport('u')).syncNow();
		expect(states(raw)).toEqual({ acked: opIds(raw).length });
		expect(logIds(cloud).sort()).toEqual(opIds(raw).sort());
		expect(unique(logIds(cloud))).toBe(true);
		expect([...cloud.batches.values()].map((b) => b.status).sort()).toEqual(['committed', 'expired']);
	});
});

describe('a desktop upgraded mid-backfill', () => {
	// The schema as an older build left it: no batch columns.
	function downgrade(raw: Database.Database): void {
		raw.exec(`DROP INDEX sync_outbox_batch_idx; ALTER TABLE sync_outbox DROP COLUMN batch_id; ALTER TABLE sync_outbox DROP COLUMN batch_label;`);
	}

	it('labels a pending backlog at upgrade and sends the rest of it as a batch: nothing lost, nothing doubled', async () => {
		const old = new FakeCloud();
		old.features = old.features.filter((f) => f !== 'batches');
		const { path, raw } = freshDb('a');
		await client(raw, old.transport('u')).syncNow();
		// The old build's backfill: 1,500 ops, unlabelled, partly pushed.
		backfill(raw, 1_500);
		raw.prepare(`UPDATE sync_outbox SET batch_label = NULL`).run();
		const oldClient = client(raw, old.transport('u'));
		await oldClient.pushOnce();
		oldClient.stop();
		expect(states(raw)['pending']).toBe(1_000);
		// One of the pending ops reached the server, its answer lost.
		const lost = opIds(raw, `state = 'pending'`)[0]!;
		const row = raw.prepare(`SELECT * FROM sync_outbox WHERE op_id = ?`).get(lost) as Record<string, unknown>;
		old.push('u', { deviceId: row['device_id'] as string, ops: [{ op_id: lost, device_id: row['device_id'], client_ts: row['client_ts'], schema_version: row['schema_version'], entity: row['entity'], entity_id: row['entity_id'], kind: row['kind'], payload: JSON.parse(row['payload'] as string) } as never] });
		downgrade(raw);
		raw.close();

		// The new build starts: migrate labels the backlog.
		migrate(path);
		const { sqlite } = createDb(path);
		handles.push(sqlite);
		expect(sqlite.prepare(`SELECT batch_label, count(*) AS n FROM sync_outbox WHERE state = 'pending' GROUP BY batch_label`).all()).toEqual([{ batch_label: 'backfill', n: 1_000 }]);
		// A re-run never labels anything again (edits made since stay plain).
		edit(sqlite, 2, 'later');
		migrate(path);
		expect(opIds(sqlite, `entity_id LIKE 'later-%' AND batch_label IS NULL`)).toHaveLength(2);

		// The server now offers batches.
		old.features = [...old.features, 'batches'];
		await client(sqlite, old.transport('u')).syncNow();
		expect(old.calls.batchCommit).toBe(1);
		expect(states(sqlite)).toEqual({ acked: opIds(sqlite).length });
		expect(logIds(old).sort()).toEqual(opIds(sqlite).sort());
		expect(unique(logIds(old))).toBe(true);
	});

	it('leaves a few pending edits unlabelled at upgrade', async () => {
		const { path, raw } = freshDb('a');
		edit(raw, 5);
		downgrade(raw);
		raw.close();
		migrate(path);
		const { sqlite } = createDb(path);
		handles.push(sqlite);
		expect(opIds(sqlite, `batch_label IS NOT NULL`)).toEqual([]);
	});
});

describe('two desktops', () => {
	it('A’s backfill in a batch: B sees nothing of it until the commit, then bootstraps from the next snapshot and converges', async () => {
		const cloud = new FakeCloud();
		cloud.farBehindOps = 50;
		const a = freshDb('a');
		const b = freshDb('b');
		const ca = client(a.raw, cloud.transport('u'));
		const cb = client(b.raw, cloud.transport('u'));
		await ca.syncNow();
		await cb.syncNow();
		edit(a.raw, 3, 'before');
		await ca.syncNow();
		await cb.syncNow();
		expect(b.raw.prepare(`SELECT count(*) FROM tag WHERE id LIKE 'before-%'`).pluck().get()).toBe(3);

		// A's backfill goes up; the server is slow to publish it.
		backfill(a.raw, 400);
		cloud.holdCommits = true;
		await ca.syncNow();
		expect(ca.status().batch).toBeNull();
		edit(b.raw, 2, 'b-live');
		await cb.syncNow();
		await ca.syncNow();
		// B: none of the backfill; its own edits went up and A has them.
		expect(b.raw.prepare(`SELECT count(*) FROM tag WHERE id LIKE 'bf-%'`).pluck().get()).toBe(0);
		expect(a.raw.prepare(`SELECT count(*) FROM tag WHERE id LIKE 'b-live-%'`).pluck().get()).toBe(2);
		const bootsBefore = cloud.calls.bootstrap;

		// Published, then the server's sweep folds a snapshot (the commit
		// builds none): B is far behind it, so it loads that.
		cloud.holdCommits = false;
		await ca.syncNow();
		expect(states(a.raw)).toEqual({ acked: opIds(a.raw).length });
		cloud.takeSnapshot();
		await cb.syncNow();
		expect(cloud.calls.bootstrap).toBe(bootsBefore + 1);
		expect(b.raw.prepare(`SELECT count(*) FROM tag WHERE id LIKE 'bf-%'`).pluck().get()).toBe(400);
		// A pulls nothing of its own batch back (its own-op bound moved with
		// the commit) and does not bootstrap.
		const aBoots = cloud.calls.bootstrap;
		await ca.syncNow();
		expect(cloud.calls.bootstrap).toBe(aBoots);
		expect(compareDumps(dumpLibrary(a.raw), dumpLibrary(b.raw)).filter((r) => !r.equal)).toEqual([]);
	});
});
