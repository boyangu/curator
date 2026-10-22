// The account's BASE (the 2026-10-22 sync review): the first device folds its
// library into its own records and publishes them as the snapshot, sending
// no op for them; a joining device bootstraps from that snapshot, binds its
// rows to the account's recordings (join-bind.ts) and sends only what it
// alone holds; a device on an account with ops but no snapshot waits; a
// cursor below the server's base bootstraps; a secondary at the master's
// newest snapshot checks its records' digest and reloads on a mismatch; acked
// outbox rows go after a week without the clock or the own-op skip noticing;
// and migrate carries a stated library over to the split records key.
//
// Generated DBs only (CLAUDE.md): mkdtempSync + migrate() through the rig or
// directly; the cloud is the in-memory fake; no remoteWritePolicy.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@curator/shared/schema';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import * as mut from '../library/mutators.js';
import { FakeCloud } from '../test-support/fake-cloud.js';
import { markPreOpLog, replicaDiff, seedCatalogue, TRACKS, TwoDesktopRig, type Desktop, type DesktopOpts } from '../test-support/two-desktops.js';
import { INITIAL_PUSH_KEY, RECORDS_COMPLETE_KEY, recordsComplete } from './apply.js';
import { createSyncClient, readCursor, type SyncClient } from './client.js';
import { inlineSnapshotBuilder, type SnapshotBuilder } from './snapshot-build.js';
import { JOIN_BIND_KEY } from './join-bind.js';
import { CLOCK_KEY } from './outbox.js';
import { recordingIdForTrack } from './recording-id.js';

const R = recordingIdForTrack;

let rig: TwoDesktopRig;
beforeEach(() => { rig = new TwoDesktopRig('curator-2desk-base-'); });
afterEach(() => {
	const upstream = rig.upstreamCalls();
	rig.close();
	expect(upstream).toEqual([]);
});

const hash = (n: number): string => `pcm-md5:${String(n).repeat(32).slice(0, 32)}`;

// Rows a library holds before it ever signed in (written straight into the
// tables, as every pre-sync install has them): a local file by its audio
// hash, or a Spotify listing.
function holdFile(raw: Database.Database, trackId: string, h: string): void {
	raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, audio_hash) VALUES (?, ?, 'local', ?, ?, ?)`)
		.run(`sl-${trackId}`, trackId, `c:/music/${trackId}.flac`, `c:/music/${trackId}.flac`, h);
}
function holdSpotify(raw: Database.Database, trackId: string, sp: string): void {
	raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES (?, ?, 'spotify', ?, 1700000000000)`).run(`sp-${trackId}`, trackId, sp);
}
function tagRow(raw: Database.Database, trackId: string, tagId: string): void {
	raw.prepare(`INSERT INTO tag (id, name, kind, created_at) VALUES (?, ?, 'user', 1600000000000) ON CONFLICT(id) DO NOTHING`).run(tagId, `Tag ${tagId}`);
	raw.prepare(`INSERT INTO track_tag (track_id, tag_id, added_at) VALUES (?, ?, 1600000000000)`).run(trackId, tagId);
}

// The master: three recordings (two files, one Spotify track), one tagged.
const master = (opts: DesktopOpts = {}): Promise<Desktop> => rig.desktop('a', {
	...opts,
	catalogue: ['a-1', 'a-2', 'a-3'],
	seed: (raw) => {
		holdFile(raw, 'a-1', hash(1));
		holdFile(raw, 'a-2', hash(2));
		holdSpotify(raw, 'a-3', 'sp3');
		tagRow(raw, 'a-1', 'warm');
		raw.prepare(`UPDATE track SET rating = 4 WHERE id = 'a-2'`).run();
		markPreOpLog(raw);
	},
});

const opsOf = async (d: Desktop) => {
	const id = await d.deviceId();
	return rig.cloud.log.filter((o) => o.device_id === id);
};
const recOf = (d: Desktop, trackId: string): string => d.one(`SELECT recording_id FROM track WHERE id = ?`, trackId);

describe('the founder', () => {
	it('folds its library into its records with zero outbox rows, and publishes it as the base at seq 1', async () => {
		const a = await master();
		await a.sync();
		const aId = await a.deviceId();
		// The only op: the master setting, at seq 1.
		expect(rig.cloud.log.map((o) => [o.seq, o.entity, o.entity_id])).toEqual([[1, 'setting', 'library.master_device']]);
		expect(a.one(`SELECT count(*) FROM sync_outbox`)).toBe(1);
		expect(a.one(`SELECT count(*) FROM sync_outbox WHERE entity != 'setting'`)).toBe(0);
		// Every row has its record: recordings, claims, the tag, the rating.
		expect(a.one(`SELECT count(*) FROM sync_state WHERE map = 'libraryTracks'`)).toBe(3);
		expect(a.one(`SELECT count(*) FROM sync_state WHERE map = 'claims'`)).toBe(3);
		expect(a.one(`SELECT count(*) FROM sync_state WHERE map = 'trackTags'`)).toBe(1);
		// Published as the base, by the master, at seq 1.
		expect(rig.cloud.published.map((p) => [p.seq, p.deviceId])).toEqual([[1, aId]]);
		expect(await a.svc.getCloudSyncStatus()).toMatchObject({ initialPushDone: true, pending: 0, phase: null, snapshot: { lastSeq: 1 } });
		// Restated nothing on later cycles: the backfills were folded too.
		await rig.settle();
		expect(rig.cloud.log).toHaveLength(1);
	});
});

describe('a joiner', () => {
	it('bootstraps from the base and matches the master', async () => {
		const a = await master();
		await a.sync();
		const b = await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		expect(rig.cloud.calls.storageBootstraps).toBe(1);
		expect(readCursor(b.raw)).toMatchObject({ snapshotSeq: 1, lastSeq: rig.cloud.maxSeq });
		expect(replicaDiff(a, b)).toEqual([]);
		expect(b.one(`SELECT rating FROM track WHERE recording_id = ?`, R('a-2'))).toBe(4);
		expect(await opsOf(b)).toEqual([]);
	});

	it('with the same files binds every row: zero merges, zero source ops; its tags on bound recordings reach the master', async () => {
		const a = await master();
		await a.sync();
		const b = await rig.desktop('b', {
			catalogue: ['b-1', 'b-2', 'b-3'],
			seed: (raw) => {
				holdFile(raw, 'b-1', hash(1));
				holdFile(raw, 'b-2', hash(2));
				holdSpotify(raw, 'b-3', 'sp3');
				tagRow(raw, 'b-1', 'deep');
				tagRow(raw, 'b-3', 'deep');
				markPreOpLog(raw);
			},
		});
		await rig.settle();
		for (const [bt, at] of [['b-1', 'a-1'], ['b-2', 'a-2'], ['b-3', 'a-3']] as const) expect(recOf(b, bt), bt).toBe(R(at));
		expect(b.one(`SELECT count(*) FROM app_setting WHERE key = ?`, JOIN_BIND_KEY)).toBe(1);
		const bOps = await opsOf(b);
		expect(bOps.filter((o) => o.entity === 'recording' || o.entity === 'recording_claim' || (o.entity === 'library_track' && o.kind === 'create'))).toEqual([]);
		expect(rig.cloud.log.filter((o) => o.entity === 'recording')).toEqual([]);
		// What it sent: its tag and the two assignments, on A's recordings.
		expect(bOps.filter((o) => o.entity === 'track_tag').map((o) => o.entity_id).sort()).toEqual([`${R('a-1')}:deep`, `${R('a-3')}:deep`].sort());
		for (const t of ['a-1', 'a-3']) expect(a.one(`SELECT count(*) FROM track_tag WHERE track_id = ? AND tag_id = 'deep'`, t), t).toBe(1);
		// A's curation shows on B's own rows; no remote row was left behind.
		expect(b.one(`SELECT rating FROM track WHERE id = 'b-2'`)).toBe(4);
		expect(b.one(`SELECT count(*) FROM track_tag WHERE track_id = 'b-1' AND tag_id = 'warm'`)).toBe(1);
		expect(b.one(`SELECT count(*) FROM track WHERE remote_only = 1`)).toBe(0);
		expect(replicaDiff(a, b, { sharedOnly: true })).toEqual([]);
	});

	it('with extra rows emits exactly those; a stale delete never binds onto a live recording', async () => {
		const a = await master();
		await a.sync();
		const b = await rig.desktop('b', {
			catalogue: ['b-1', 'b-extra', 'b-gone'],
			seed: (raw) => {
				holdFile(raw, 'b-1', hash(1));
				holdFile(raw, 'b-extra', hash(9));
				tagRow(raw, 'b-extra', 'mine');
				// B deleted its copy of A's live file long ago: it stays its own
				// (deleted) recording rather than deleting A's.
				holdFile(raw, 'b-gone', hash(2));
				raw.prepare(`UPDATE track SET deleted_at = 1650000000000 WHERE id = 'b-gone'`).run();
				markPreOpLog(raw);
			},
		});
		await rig.settle();
		expect(recOf(b, 'b-1')).toBe(R('a-1'));
		expect(recOf(b, 'b-extra')).toBe(R('b-extra'));
		expect(recOf(b, 'b-gone')).toBe(R('b-gone'));
		const bOps = await opsOf(b);
		const states = (entity: string, kind: string): string[] => bOps.filter((o) => o.entity === entity && o.kind === kind).map((o) => o.entity_id).sort();
		expect(states('library_track', 'create')).toEqual([R('b-extra'), R('b-gone')].sort());
		expect(states('library_track', 'delete')).toEqual([R('b-gone')]);
		expect(states('recording_claim', 'add')).toEqual([R('b-extra'), R('b-gone')].sort());
		expect(states('tag', 'create')).toEqual(['mine']);
		expect(states('track_tag', 'add')).toEqual([`${R('b-extra')}:mine`]);
		// A's live copy stayed live everywhere, and no merge was made.
		expect(a.one(`SELECT deleted_at FROM track WHERE id = 'a-2'`)).toBeNull();
		expect(rig.cloud.log.filter((o) => o.entity === 'recording')).toEqual([]);
		expect(a.one(`SELECT remote_only FROM track WHERE recording_id = ?`, R('b-extra'))).toBe(1);
	});

	it('on an account with ops but no snapshot waits, without pushing or pulling, until one is published', async () => {
		// The master's builder crashes until the test lets it work.
		let broken = true;
		let real: SnapshotBuilder | null = null;
		const flaky: DesktopOpts = { snapshot: { retryMs: 0, builder: async (req) => { if (broken || !real) throw new Error('builder process crashed'); return real(req); } } };
		const a = await master(flaky);
		real = inlineSnapshotBuilder(a.path, join(rig.dir, 'snap-tmp'));
		await a.sync();
		expect(rig.cloud.published).toEqual([]);
		const b = await rig.desktop('b', { catalogue: ['b-1'], seed: (raw) => { holdFile(raw, 'b-1', hash(1)); markPreOpLog(raw); } });
		const pulls = rig.cloud.calls.pull;
		await b.sync();
		await b.sync();
		expect(await b.svc.getCloudSyncStatus()).toMatchObject({ phase: 'waiting_for_snapshot', initialPushDone: false, lastError: null, pending: 0 });
		expect(await opsOf(b)).toEqual([]);
		// One probe of the head per cycle; never a pull of the log.
		expect(rig.cloud.calls.pull - pulls).toBe(2);
		expect(rig.cloud.pullInputs.slice(-2).every((p) => p.afterSeq === 0 && p.limit === 1)).toBe(true);
		// The master's publish lands: B joins, binding its copy to A's file.
		broken = false;
		await a.sync();
		expect(rig.cloud.published).toHaveLength(1);
		await rig.settle([b, a]);
		expect(await b.svc.getCloudSyncStatus()).toMatchObject({ phase: null, initialPushDone: true });
		expect(recOf(b, 'b-1')).toBe(R('a-1'));
	});
});

describe('a cursor below the account base', () => {
	it('bootstraps from the newest snapshot instead of pulling, and ends equal with no gap', async () => {
		const a = await master({ snapshot: { everyOps: 1, retryMs: 0 } });
		const b = await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		b.transport.online = false;
		await a.svc.setRating(['a-1'], 2);
		await a.svc.addTrackTag('a-3', 'interested');
		await a.sync();
		const newest = rig.cloud.published.at(-1)!.seq;
		expect(newest).toBe(rig.cloud.maxSeq);
		expect(readCursor(b.raw).lastSeq).toBeLessThan(newest);
		// The server's week-later compaction: the log forgets through the base.
		rig.cloud.compact(newest);
		await a.svc.setRating(['a-2'], 1);
		await a.sync();
		const boots = rig.cloud.calls.storageBootstraps;
		b.transport.online = true;
		await rig.settle();
		expect(rig.cloud.calls.storageBootstraps).toBe(boots + 1);
		// The newest snapshot by then (the master published again after the
		// compaction), never an op below the base.
		expect(readCursor(b.raw)).toMatchObject({ snapshotSeq: rig.cloud.published.at(-1)!.seq, lastSeq: rig.cloud.maxSeq });
		expect(readCursor(b.raw).snapshotSeq).toBeGreaterThanOrEqual(newest);
		expect(replicaDiff(a, b)).toEqual([]);
		expect(b.one(`SELECT rating FROM track WHERE recording_id = ?`, R('a-1'))).toBe(2);
		expect(b.one(`SELECT rating FROM track WHERE recording_id = ?`, R('a-2'))).toBe(1);
	});
});

describe('a secondary\'s digest check', () => {
	it('matches when the records are the master\'s; a mismatch re-bootstraps and repairs', async () => {
		const a = await master({ snapshot: { everyOps: 1, retryMs: 0 } });
		const b = await rig.desktop('b', { catalogue: [] });
		await rig.settle();
		await a.svc.setRating(['a-1'], 3);
		await rig.settle();
		const seq = rig.cloud.published.at(-1)!.seq;
		expect(readCursor(b.raw).lastSeq).toBe(seq);
		expect((await b.svc.getCloudSyncStatus()).snapshot.digest).toMatchObject({ seq, matched: true });
		// The master never checks itself.
		expect((await a.svc.getCloudSyncStatus()).snapshot.digest).toBeNull();

		// B's records drift (a lost record) without any op saying so.
		b.raw.prepare(`DELETE FROM sync_state WHERE map = 'trackTags'`).run();
		await a.svc.setRating(['a-2'], 5);
		const boots = rig.cloud.calls.storageBootstraps;
		await a.sync();
		await b.sync();
		const next = rig.cloud.published.at(-1)!.seq;
		expect((await b.svc.getCloudSyncStatus()).snapshot.digest).toMatchObject({ seq: next, matched: false });
		await b.sync();
		expect(rig.cloud.calls.storageBootstraps).toBe(boots + 1);
		expect(b.one(`SELECT count(*) FROM sync_state WHERE map = 'trackTags'`)).toBe(1);
		expect(replicaDiff(a, b)).toEqual([]);
	});
});

// ── outbox retention and the migrate one-shot: one client on a fake cloud ──

describe('outbox retention', () => {
	let dir: string;
	const handles: Database.Database[] = [];
	const clients: SyncClient[] = [];
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-retention-')); });
	afterEach(() => {
		for (const c of clients.splice(0)) c.stop();
		for (const h of handles.splice(0)) h.close();
		try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
	});
	const fresh = (name: string): Database.Database => {
		const p = join(dir, `${name}.db`);
		migrate(p);
		const { sqlite } = createDb(p);
		handles.push(sqlite);
		seedCatalogue(sqlite, TRACKS);
		return sqlite;
	};
	const tags = (raw: Database.Database, prefix: string, n: number): void => {
		const db = drizzle(raw, { schema });
		for (let i = 0; i < n; i++) mut.createTag(db, { id: `${prefix}-${i}`, name: `${prefix} ${i}` });
	};
	const clock = (raw: Database.Database) => JSON.parse(raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).pluck().get(CLOCK_KEY) as string) as { lastIssuedTs: number; lastSeqLocal: number };
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	it('deletes acked rows past retention; the clock never regresses and the own-op skip still holds', async () => {
		// A server from before the own-op skip echoes every own op back: the
		// strictest test of applyOps' skip by op id.
		const cloud = new FakeCloud();
		cloud.legacy = true;
		const raw = fresh('a');
		const other = fresh('b');
		const c = createSyncClient({ db: raw, transport: cloud.transport('u'), debounceMs: 1, outboxRetentionMs: 0 });
		const o = createSyncClient({ db: other, transport: cloud.transport('u'), debounceMs: 1 });
		clients.push(c, o);
		tags(raw, 'mine', 5);
		const before = raw.prepare(`SELECT max(client_ts) AS ts, max(seq_local) AS seq FROM sync_outbox`).get() as { ts: number; seq: number };
		await c.syncNow();
		await sleep(5);
		await c.syncNow();
		expect(raw.prepare(`SELECT count(*) FROM sync_outbox`).pluck().get()).toBe(0);
		// The clock was pinned before the rows went.
		expect(clock(raw).lastIssuedTs).toBeGreaterThanOrEqual(before.ts);
		expect(clock(raw).lastSeqLocal).toBeGreaterThanOrEqual(before.seq);
		// The next op stamps after everything already in the log.
		tags(raw, 'later', 1);
		const next = raw.prepare(`SELECT client_ts, seq_local FROM sync_outbox WHERE entity_id = 'later-0'`).get() as { client_ts: number; seq_local: number };
		expect(next.client_ts).toBeGreaterThan(before.ts);
		expect(next.seq_local).toBeGreaterThan(before.seq);
		// The other device states its rows; this one pushes 'later', pulls
		// them and its own echo (skipped by op id: the row is still there, a
		// prune runs only after the cycle's pull), then prunes again.
		await o.syncNow();
		await c.syncNow();
		expect(raw.prepare(`SELECT count(*) FROM sync_outbox`).pluck().get()).toBe(0);
		expect(raw.prepare(`SELECT count(*) FROM tag WHERE id = 'later-0'`).pluck().get()).toBe(1);
		// Another device's op arrives; nothing of this device's comes back as
		// remote: its cursor had passed every pruned op.
		tags(other, 'theirs', 1);
		await o.syncNow();
		const r = await c.pullOnce();
		expect(r).toMatchObject({ received: 1, applied: 1 });
		expect(raw.prepare(`SELECT name FROM tag WHERE id = 'theirs-0'`).pluck().get()).toBe('theirs 0');
	});
});

describe('migrate: the records key split', () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-split-')); });
	afterEach(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ } });

	it('a library stated under the old single key gets the records key once; an unstated one does not', () => {
		const p = join(dir, 'old.db');
		migrate(p);
		const { sqlite: raw } = createDb(p);
		try {
			// As a build from before the split left it: rows, the one key.
			raw.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES ('p', 'local', 'p', 'P')`).run();
			raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(RECORDS_COMPLETE_KEY);
			raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, '1', 1) ON CONFLICT(key) DO NOTHING`).run(INITIAL_PUSH_KEY);
			expect(recordsComplete(raw)).toBe(false);
		} finally { raw.close(); }
		migrate(p);
		const { sqlite: after } = createDb(p);
		try {
			expect(after.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(RECORDS_COMPLETE_KEY)).toBeDefined();
			expect(recordsComplete(after)).toBe(true);
			// An unstated library with rows stays incomplete.
			after.prepare(`DELETE FROM app_setting WHERE key IN (?, ?)`).run(RECORDS_COMPLETE_KEY, INITIAL_PUSH_KEY);
		} finally { after.close(); }
		migrate(p);
		const { sqlite: again } = createDb(p);
		try { expect(recordsComplete(again)).toBe(false); } finally { again.close(); }
	});
});
