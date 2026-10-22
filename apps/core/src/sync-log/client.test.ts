// The cloud sync client against an in-memory server that keeps the real
// server's rules (design: "Server API"): one seq per user, duplicate op ids
// accepted and ignored, per-op rejection without failing the batch,
// materialisation with the protocol reducer, a `snapshotSeq` hint for a
// far-behind cursor, the 'pull_skip_own' feature (or, with `legacy`, a
// server from before it, strict about its pull input), and injectable
// transport failures.
//
// Generated DBs only (CLAUDE.md): mkdtempSync + migrate(); the services get
// a throwing Spotify adapter and no remote-write policy, and no transport
// here ever leaves the process.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@curator/shared/schema';
import { MAX_PULL_OPS, MAX_PUSH_OPS, rebalance, SCHEMA_VERSION, type StoredOp } from '@curator/protocol';
import { getSourceCapabilities } from '@curator/shared';
import type { AreaLogger } from '@curator/shared/log';
import { migrate } from '../db/migrate.js';
import { createDb } from '../db/client.js';
import { createCoreService, type CoreService } from '../service.js';
import type { StreamingSourceAdapter } from '../sources/adapter.js';
import { CloudTransportError, createSyncClient, readCursor, type CloudSyncEvent, type CloudTransport, type SyncClient } from './client.js';
import { compareDumps, dumpLibrary } from './dump.js';
import { INITIAL_PUSH_KEY, RECORDS_COMPLETE_KEY } from './apply.js';
import { heldCount, replayHeldOps } from './held.js';
import { foldLibraryAsync, joinPushAsync } from './initial-push.js';
import { inlineSnapshotBuilder } from './snapshot-build.js';
import { recordingIdForTrack } from './recording-id.js';
import { remintDeviceIdentity } from './remint.js';
import { FakeCloud } from '../test-support/fake-cloud.js';
import * as mut from '../library/mutators.js';
import { normalizeIncomingArtistsRaw, syncTrackArtistsByIdRaw } from '../library/artists.js';

// The fake server lives in test-support/fake-cloud.ts (shared with the
// two-desktop scenario suites).

// ── fixtures ────────────────────────────────────────────────────────────────

const TRACKS = Array.from({ length: 8 }, (_, i) => `trk-${i}`);

// These suites pin the push/pull mechanics as they were before protocol v3:
// against a server that does not advertise 'track_meta', nothing of v3 (base
// metadata, the default master) joins an outbox — which is itself the rule
// (track-meta.ts). Without v3 no device can state itself master, so such a
// server holds no base either ('snapshot_storage' off): a library goes up
// as ops and a device joins by pulling the log, the pre-base mechanics. The
// v3 stage and the base have their own suites (track-meta.test.ts,
// two-desktops-catalogue.test.ts, two-desktops-base.test.ts).
function v2Cloud(): FakeCloud {
	const cloud = new FakeCloud();
	cloud.features = cloud.features.filter((f) => f !== 'track_meta' && f !== 'zero_loss_v4' && f !== 'snapshot_storage');
	return cloud;
}

let dir: string;
const handles: Database.Database[] = [];
const services: CoreService[] = [];
const clients: SyncClient[] = [];

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-cloud-client-')); });
afterEach(() => {
	for (const c of clients.splice(0)) c.stop();
	for (const s of services.splice(0)) s.close();
	for (const h of handles.splice(0)) h.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

// Catalogue rows as a write site leaves them: with their artist junction
// (the dump compares it).
function seedTracks(raw: Database.Database, ids: readonly string[] = TRACKS): void {
	const ins = raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration) VALUES (?, ?, ?, '[{"name":"Artist"}]', 'unsorted', 300)`);
	for (const id of ids) ins.run(id, recordingIdForTrack(id), `Title ${id}`);
	syncTrackArtistsByIdRaw(raw, ids);
}

function freshDb(name: string, seed = true): { path: string; raw: Database.Database } {
	const p = join(dir, `${name}.db`);
	migrate(p);
	const { sqlite } = createDb(p);
	handles.push(sqlite);
	if (seed) seedTracks(sqlite);
	return { path: p, raw: sqlite };
}

function throwingAdapter(): StreamingSourceAdapter {
	const boom = async (): Promise<never> => { throw new Error('upstream write attempted in a cloud client test'); };
	return {
		source: 'spotify', displayName: 'Fake Spotify', capabilities: getSourceCapabilities('spotify'),
		listRemotePlaylists: async () => [], fetchPlaylistTracks: async () => [],
		createPlaylist: boom, deletePlaylist: boom, renamePlaylist: boom, addTracks: boom, removeTracks: boom, replaceTracks: boom,
	};
}

function desktop(name: string, cloud: FakeCloud, userId = 'user-1'): { svc: CoreService; raw: Database.Database; path: string } {
	const { path, raw } = freshDb(name);
	const svc = createCoreService(path, {
		peaksDir: join(dir, `${name}-peaks`),
		sourceAdapters: { spotify: throwingAdapter() },
		cloud: { transport: cloud.transport(userId), device: { name, platform: 'win32' } },
	});
	services.push(svc);
	return { svc, raw, path };
}

function client(raw: Database.Database, transport: CloudTransport, extra: Partial<Parameters<typeof createSyncClient>[0]> = {}): SyncClient {
	const c = createSyncClient({ db: raw, transport, backoffBaseMs: 5, backoffCapMs: 40, debounceMs: 1, ...extra });
	clients.push(c);
	return c;
}

const outboxStates = (raw: Database.Database): Record<string, number> =>
	Object.fromEntries((raw.prepare(`SELECT state, count(*) AS n FROM sync_outbox GROUP BY state`).all() as Array<{ state: string; n: number }>).map((r) => [r.state, r.n]));

// N tag creates straight into the outbox via the mutator layer.
function makeTags(raw: Database.Database, n: number): void {
	const db = drizzle(raw, { schema });
	for (let i = 0; i < n; i++) mut.createTag(db, { id: `tag-${i}`, name: `Tag ${i}` });
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error('timed out waiting');
		await new Promise((r) => setTimeout(r, 5));
	}
}

const diffs = (a: Database.Database, b: Database.Database) => compareDumps(dumpLibrary(a), dumpLibrary(b)).filter((r) => !r.equal);

// Sets this device's op clock `aheadMs` ahead of real time, as a fast system
// clock would leave it.
function skewClock(raw: Database.Database, aheadMs: number): void {
	const row = raw.prepare(`SELECT value FROM app_setting WHERE key = 'sync.clock'`).pluck().get() as string | undefined;
	const seq = raw.prepare(`SELECT COALESCE(MAX(seq_local), 0) FROM sync_outbox`).pluck().get() as number;
	const c = row ? JSON.parse(row) as Record<string, number> : { lastServerTs: 0, lastSeqLocal: seq };
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES ('sync.clock', ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify({ ...c, lastIssuedTs: Date.now() + aheadMs }), Date.now());
}

const clientState = (raw: Database.Database): { needsRepair?: boolean; ownThroughSeq?: number } =>
	JSON.parse(raw.prepare(`SELECT value FROM app_setting WHERE key = 'sync.client'`).pluck().get() as string) as { needsRepair?: boolean; ownThroughSeq?: number };

// ── push ────────────────────────────────────────────────────────────────────

describe('push', () => {
	it('drains the outbox oldest first in batches of at most 500 and marks every op acked', async () => {
		const cloud = v2Cloud();
		const { raw } = freshDb('a');
		const c = client(raw, cloud.transport('u'));
		await c.runInitialPush();
		makeTags(raw, 1_150);
		await c.syncNow();
		expect(outboxStates(raw)).toEqual({ acked: expect.any(Number) });
		expect(cloud.pushSizes.every((n) => n <= MAX_PUSH_OPS)).toBe(true);
		expect(cloud.pushSizes.length).toBeGreaterThanOrEqual(3);
		// Oldest first: the server's seq order is the outbox's seq_local order.
		const local = raw.prepare(`SELECT op_id FROM sync_outbox ORDER BY seq_local`).pluck().all() as string[];
		expect(cloud.log.map((o) => o.op_id)).toEqual(local);
		expect(c.status()).toMatchObject({ pending: 0, rejected: 0, lastError: null, signedIn: true });
		expect(c.status().lastPushAt).not.toBeNull();
		expect(cloud.calls.register).toBe(1);
	});

	it('marks a per-op rejection rejected with its reason and never resends it', async () => {
		const cloud = v2Cloud();
		const { raw } = freshDb('a');
		const c = client(raw, cloud.transport('u'));
		await c.runInitialPush();
		makeTags(raw, 3);
		const bad = raw.prepare(`SELECT op_id FROM sync_outbox WHERE entity_id = 'tag-1'`).pluck().get() as string;
		cloud.rejectIds.set(bad, 'not_owner');
		await c.syncNow();
		expect(raw.prepare(`SELECT state, reason FROM sync_outbox WHERE op_id = ?`).get(bad)).toEqual({ state: 'rejected', reason: 'not_owner' });
		expect(c.status()).toMatchObject({ pending: 0, rejected: 1 });
		const pushes = cloud.calls.push;
		await c.syncNow();
		expect(cloud.calls.push).toBe(pushes); // nothing pending: no push call at all
		expect(cloud.log.some((o) => o.op_id === bad)).toBe(false);
	});

	it('keeps ops pending through transient failures, backs off, then delivers', async () => {
		const cloud = v2Cloud();
		const { raw } = freshDb('a');
		const c = client(raw, cloud.transport('u'), { random: () => 1 });
		await c.runInitialPush();
		makeTags(raw, 5);
		cloud.fail.push.push(new CloudTransportError('network', 'ECONNRESET'), new CloudTransportError('server', '503'));
		c.start();
		await c.syncNow();
		// First attempt failed: still pending, error surfaced, a retry armed.
		expect(c.status().pending).toBeGreaterThan(0);
		expect(c.status().lastError).toMatch(/Offline/);
		expect(c.status().nextRetryAt).not.toBeNull();
		// Pending reaches 0 at the push's answer; the cycle clears its error and
		// retry only when it ends (after its pull), so wait for that too.
		await until(() => c.status().pending === 0 && c.status().lastError === null);
		expect(cloud.calls.push).toBeGreaterThanOrEqual(3);
		expect(c.status()).toMatchObject({ lastError: null, nextRetryAt: null });
		// Duplicates on the server: none (every op landed exactly once).
		expect(new Set(cloud.log.map((o) => o.op_id)).size).toBe(cloud.log.length);
	});

	it('honours retry_after and caps the backoff at the configured ceiling', async () => {
		const cloud = v2Cloud();
		const { raw } = freshDb('a');
		const c = client(raw, cloud.transport('u'), { random: () => 1, backoffBaseMs: 1_000, backoffCapMs: 60_000 });
		await c.runInitialPush();
		makeTags(raw, 1);
		cloud.fail.push.push(new CloudTransportError('rate_limited', '429', 120_000));
		const before = Date.now();
		await c.syncNow();
		const wait = c.status().nextRetryAt! - before;
		expect(wait).toBeGreaterThanOrEqual(59_000);
		expect(wait).toBeLessThanOrEqual(60_500);
	});

	it('re-registers the device when the server has no registration for it', async () => {
		const cloud = v2Cloud();
		const { raw } = freshDb('a');
		const c = client(raw, cloud.transport('u'));
		await c.syncNow();
		expect(cloud.calls.register).toBe(1);
		makeTags(raw, 1);
		cloud.fail.push.push(new CloudTransportError('device_not_registered', 'PRECONDITION_FAILED'));
		c.start();
		await c.syncNow();
		await until(() => c.status().pending === 0);
		expect(cloud.calls.register).toBe(2);
	});

	it('update_required stops the push, keeps the ops pending and reports it', async () => {
		const cloud = v2Cloud();
		const { raw } = freshDb('a');
		const c = client(raw, cloud.transport('u'));
		await c.runInitialPush();
		makeTags(raw, 2);
		cloud.fail.push.push(new CloudTransportError('update_required', 'client too old'));
		await c.syncNow();
		expect(c.status()).toMatchObject({ needsUpdate: true, rejected: 0 });
		expect(c.status().pending).toBeGreaterThan(0);
	});

	it('does nothing while signed out, and refuses a second account on a bound library', async () => {
		const cloud = v2Cloud();
		const { raw } = freshDb('a');
		const t = cloud.transport('u');
		t.signedIn = false;
		const c = client(raw, t);
		await c.syncNow();
		expect(cloud.calls.push + cloud.calls.pull + cloud.calls.register).toBe(0);
		expect(c.status().signedIn).toBe(false);
		t.signedIn = true;
		await c.syncNow();
		const other = client(raw, cloud.transport('someone-else'));
		const calls = cloud.calls.push + cloud.calls.pull;
		await other.syncNow();
		expect(cloud.calls.push + cloud.calls.pull).toBe(calls);
		expect(other.status().lastError).toMatch(/another Curator account/);
	});
});

// ── pull ────────────────────────────────────────────────────────────────────

describe('pull', () => {
	it('skips its own ops and advances the cursor past them', async () => {
		const cloud = v2Cloud();
		const { raw } = freshDb('a');
		const c = client(raw, cloud.transport('u'));
		await c.runInitialPush();
		makeTags(raw, 4);
		await c.pushOnce();
		const r = await c.pullOnce();
		expect(r.applied).toBe(0);
		expect(readCursor(raw).lastSeq).toBe(cloud.maxSeq);
	});

	it('applies pages and advances the cursor only with the page commit (crash mid-page)', async () => {
		const cloud = v2Cloud();
		cloud.pageLimit = 3;
		const a = freshDb('a');
		const b = freshDb('b');
		const ca = client(a.raw, cloud.transport('u'));
		await ca.runInitialPush();
		makeTags(a.raw, 7);
		await ca.syncNow();

		let crashes = 1;
		const cb = client(b.raw, cloud.transport('u'), {
			beforeCursorAdvance: (page) => {
				if (crashes > 0 && page[0]!.seq > 3) { crashes--; throw new Error('power cut'); }
			},
		});
		await expect(cb.pullOnce()).rejects.toThrow('power cut');
		// The first page committed; the second rolled back with its cursor.
		expect(readCursor(b.raw).lastSeq).toBe(3);
		const tagsAfterCrash = b.raw.prepare(`SELECT count(*) AS n FROM tag WHERE kind = 'user'`).pluck().get() as number;
		const seenSeqs = cloud.log.filter((o) => o.seq <= 3 && o.entity === 'tag' && o.kind === 'create' && o.entity_id.startsWith('tag-')).length;
		expect(tagsAfterCrash).toBe(seenSeqs);

		const r = await cb.pullOnce();
		expect(r.pages).toBeGreaterThan(1);
		expect(readCursor(b.raw).lastSeq).toBe(cloud.maxSeq);
		expect(diffs(a.raw, b.raw)).toEqual([]);
	});

	// A page applies in sub-batches, a transaction each (client.ts
	// PULL_SLICE_MS); only the last moves the cursor. A crash there keeps
	// the earlier sub-batches and the cursor before the page, and the
	// re-pull applies the whole page again, harmlessly.
	it('a page in sub-batches: a crash in the last one keeps the cursor before the page, and the re-pull converges', async () => {
		const cloud = v2Cloud();
		const a = freshDb('a');
		const b = freshDb('b');
		const ca = client(a.raw, cloud.transport('u'));
		await ca.runInitialPush();
		makeTags(a.raw, 7);
		await ca.syncNow();

		let crashes = 1;
		let lastBatchPage = 0;
		const cb = client(b.raw, cloud.transport('u'), {
			pullApplyChunk: 2,
			beforeCursorAdvance: (page) => {
				lastBatchPage = page.length;
				if (crashes > 0) { crashes--; throw new Error('power cut'); }
			},
		});
		const r0 = await cb.pullOnce().catch((e: Error) => e);
		expect(r0).toBeInstanceOf(Error);
		// The seam saw the whole page (one page: the log is short).
		expect(lastBatchPage).toBe(cloud.maxSeq);
		expect(readCursor(b.raw).lastSeq).toBe(0);
		// The tag creates are the log's tail: the earlier sub-batches' ones
		// committed, the last sub-batch's rolled back.
		const tagsAfterCrash = b.raw.prepare(`SELECT count(*) FROM tag WHERE kind = 'user'`).pluck().get() as number;
		expect(tagsAfterCrash).toBeGreaterThan(0);
		expect(tagsAfterCrash).toBeLessThan(7);

		const r = await cb.pullOnce();
		expect(r.stopped).toBeNull();
		expect(r.maxSliceMs).toBeGreaterThan(0);
		expect(readCursor(b.raw).lastSeq).toBe(cloud.maxSeq);
		expect(diffs(a.raw, b.raw)).toEqual([]);
	});

	// The page is validated whole before its first sub-batch: an op this
	// version should read but cannot stops the pull with none of its page
	// applied, rather than with the sub-batches before it committed.
	it('an unreadable op stops the pull before any of its page applies', async () => {
		const cloud = v2Cloud();
		const a = freshDb('a');
		const b = freshDb('b');
		const ca = client(a.raw, cloud.transport('u'));
		await ca.runInitialPush();
		makeTags(a.raw, 3);
		await ca.syncNow();
		// A current-version op this build cannot parse (an empty tag name),
		// at the end of the page.
		cloud.appendRaw({ op_id: '5f0c2b9e-1d4a-4c3b-9e8f-7a6b5c4d3e2f', device_id: '0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e', client_ts: Date.now(), schema_version: SCHEMA_VERSION, entity: 'tag', entity_id: 'tag-0', kind: 'rename', payload: { name: '' }, seq: cloud.maxSeq + 1, user_id: 'u', received_at: Date.now() } as StoredOp);
		const cb = client(b.raw, cloud.transport('u'), { pullApplyChunk: 1 });
		const r = await cb.pullOnce();
		expect(r.stopped).toBe('unreadable');
		expect(r.applied).toBe(0);
		expect(readCursor(b.raw).lastSeq).toBe(0);
		expect(b.raw.prepare(`SELECT count(*) FROM tag WHERE kind = 'user'`).pluck().get()).toBe(0);
		expect(cb.status().lastError).toMatch(/cannot read/);
	});

	// Held aside, not a stop (held.ts): the rest of the log keeps applying
	// and the cursor reaches the head; the held op replays once a build
	// that reads its version pulls.
	it('holds an op from a newer protocol version aside, applies the rest, and replays it after an update', async () => {
		const cloud = v2Cloud();
		const a = freshDb('a');
		const b = freshDb('b');
		const ca = client(a.raw, cloud.transport('u'));
		await ca.runInitialPush();
		makeTags(a.raw, 2);
		await ca.syncNow();
		const before = cloud.maxSeq;
		// A newer client's rename of tag-0, then an ordinary op after it.
		cloud.appendRaw({ op_id: '7d1e0c52-3a8b-4f6e-9c21-5b0a4d3e2f10', device_id: '0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e', client_ts: Date.now() + 5, schema_version: SCHEMA_VERSION + 1, entity: 'tag', entity_id: 'tag-0', kind: 'rename', payload: { name: 'From the future' }, seq: before + 1, user_id: 'u', received_at: Date.now() } as StoredOp);
		mut.createTag(drizzle(a.raw, { schema }), { id: 'tag-later', name: 'Later' });
		await ca.syncNow();
		const cb = client(b.raw, cloud.transport('u'));
		const r = await cb.pullOnce();
		expect(r).toMatchObject({ stopped: null, held: 1 });
		expect(readCursor(b.raw).lastSeq).toBe(cloud.maxSeq);
		expect(cb.status().needsUpdate).toBe(true);
		// Everything but the held op applied, including what came after it.
		expect(b.raw.prepare(`SELECT name FROM tag WHERE id = 'tag-later'`).pluck().get()).toBe('Later');
		expect(b.raw.prepare(`SELECT name FROM tag WHERE id = 'tag-0'`).pluck().get()).toBe('Tag 0');
		// A re-pull holds nothing twice.
		await cb.pullOnce();
		expect(heldCount(b.raw)).toBe(1);
		// The same build replays nothing; an updated one applies it.
		expect(replayHeldOps(b.raw).applied).toBe(0);
		expect(replayHeldOps(b.raw, SCHEMA_VERSION + 1)).toMatchObject({ applied: 1, remaining: 0, error: null });
		expect(b.raw.prepare(`SELECT name FROM tag WHERE id = 'tag-0'`).pluck().get()).toBe('From the future');
		expect(cb.status().needsUpdate).toBe(false);
	});

	// From the push result (current server) or the op's echo (older server):
	// the same repair either way.
	it.each([['the push result', false], ['the echo from an older server', true]])('re-stamps an own op the server clamped, and repairs a write it shadowed (learnt from %s)', async (_how, legacy) => {
		const cloud = v2Cloud();
		cloud.legacy = legacy;
		const a = desktop('a', cloud);
		const b = desktop('b', cloud);
		await a.svc.cloudSyncNow();
		await b.svc.cloudSyncNow();
		const skew = skewClock;
		// B's clock a minute fast (inside the server's tolerance): kept as is.
		skew(b.raw, 60_000);
		await b.svc.setRating(['trk-3'], 2);
		await b.svc.cloudSyncNow();
		// A's clock an hour fast: the server clamps A's stamp to its receive
		// time, which is BEFORE B's stamp — so B's 2 is the server's answer.
		skew(a.raw, 3_600_000);
		await a.svc.setRating(['trk-3'], 5);
		// One op per page: A applies B's op (and loses it to its own future
		// stamp) before its own clamped op comes back.
		cloud.pageLimit = 1;
		await a.svc.cloudSyncNow();
		const own = cloud.log.find((o) => o.entity === 'library_track' && o.kind === 'set-rating' && o.payload.rating === 5)!;
		expect(a.raw.prepare(`SELECT client_ts FROM sync_outbox WHERE op_id = ?`).pluck().get(own.op_id)).toBe(own.client_ts);
		await b.svc.cloudSyncNow();
		expect(a.raw.prepare(`SELECT rating FROM track WHERE id = 'trk-3'`).pluck().get()).toBe(2);
		expect(b.raw.prepare(`SELECT rating FROM track WHERE id = 'trk-3'`).pluck().get()).toBe(2);
		expect(diffs(a.raw, b.raw)).toEqual([]);
	});

	it('emits an applied event naming the changed rows', async () => {
		const cloud = v2Cloud();
		const a = desktop('a', cloud);
		const b = desktop('b', cloud);
		await a.svc.cloudSyncNow();
		await b.svc.cloudSyncNow();
		const events: CloudSyncEvent[] = [];
		b.svc.subscribeCloudSync((e) => events.push(e));
		await a.svc.setRating(['trk-1'], 5);
		await a.svc.cloudSyncNow();
		await b.svc.cloudSyncNow();
		const applied = events.filter((e) => e.kind === 'applied');
		expect(applied).toHaveLength(1);
		expect(applied[0]!.kind === 'applied' && applied[0]!.applied.tracks).toEqual(['trk-1']);
		expect(b.raw.prepare(`SELECT rating FROM track WHERE id = 'trk-1'`).pluck().get()).toBe(5);
	});
});

// ── own-op skip ─────────────────────────────────────────────────────────────

describe('own ops on pull', () => {
	const ownTags = (raw: Database.Database, prefix: string, n: number): void => {
		const db = drizzle(raw, { schema });
		for (let i = 0; i < n; i++) mut.createTag(db, { id: `${prefix}-${i}`, name: `${prefix} ${i}` });
	};

	it('a first sign-in never pulls back the ops it pushed; an older server echoes them all', async () => {
		for (const legacy of [false, true]) {
			const cloud = v2Cloud();
			cloud.legacy = legacy;
			const { raw } = freshDb(legacy ? 'old' : 'new');
			const c = client(raw, cloud.transport('u'));
			makeTags(raw, 1_200);
			await c.syncNow();
			expect(outboxStates(raw)).toEqual({ acked: cloud.log.length });
			expect(readCursor(raw).lastSeq).toBe(cloud.maxSeq);
			expect(cloud.opsSent).toBe(legacy ? cloud.log.length : 0);
			// The skip fields go only to a server that offers them.
			const skipping = cloud.pullInputs.filter((i) => i.deviceId !== undefined);
			expect(skipping.length > 0).toBe(!legacy);
			for (const i of skipping) expect(i).toMatchObject({ deviceId: c.status().deviceId, ownThroughSeq: cloud.maxSeq });
		}
	});

	it('day to day: a push is not echoed, another device’s ops still arrive, and the cursor ends at the head', async () => {
		const cloud = v2Cloud();
		cloud.pageLimit = 3;
		const a = freshDb('a');
		const b = freshDb('b');
		const ca = client(a.raw, cloud.transport('u'));
		const cb = client(b.raw, cloud.transport('u'));
		await ca.syncNow();
		await cb.syncNow();
		ownTags(a.raw, 'a1', 4);
		await ca.syncNow();
		ownTags(b.raw, 'b1', 2);
		await cb.syncNow();
		ownTags(a.raw, 'a2', 5);
		await ca.pushOnce();
		const sent = cloud.opsSent;
		const r = await ca.pullOnce();
		// B's two creates, nothing of A's own.
		expect(cloud.opsSent - sent).toBe(r.received);
		expect(r.received).toBe(cloud.log.filter((o) => o.entity_id.startsWith('b1-')).length);
		expect(readCursor(a.raw).lastSeq).toBe(cloud.maxSeq);
		await cb.syncNow();
		expect(diffs(a.raw, b.raw)).toEqual([]);
	});

	it('re-stamps a clamped op from the push result, before any pull, then repairs on the pull', async () => {
		const cloud = v2Cloud();
		const { raw } = freshDb('a');
		const c = client(raw, cloud.transport('u'));
		await c.syncNow();
		skewClock(raw, 3_600_000);
		ownTags(raw, 'fast', 1);
		const pulls = cloud.calls.pull;
		await c.pushOnce();
		expect(cloud.calls.pull).toBe(pulls);
		const stored = cloud.log.find((o) => o.entity_id === 'fast-0')!;
		expect(raw.prepare(`SELECT client_ts FROM sync_outbox WHERE op_id = ?`).pluck().get(stored.op_id)).toBe(stored.client_ts);
		expect(clientState(raw).needsRepair).toBe(true);
		const r = await c.pullOnce();
		expect(r.bootstrapped).toBe(true);
		expect(clientState(raw).needsRepair).toBe(false);
	});

	it('a server rolled back mid-session: the refused skip falls back to a plain pull', async () => {
		const cloud = v2Cloud();
		const { raw } = freshDb('a');
		const c = client(raw, cloud.transport('u'));
		await c.syncNow();
		ownTags(raw, 'x', 2);
		await c.pushOnce();
		cloud.legacy = true;
		const r = await c.pullOnce();
		expect(r.stopped).toBeNull();
		// The refused attempt, then the same page without the skip (and the
		// pages after it, with own ops back to being skipped by op_id).
		const refused = cloud.pullInputs.findLastIndex((i) => i.deviceId !== undefined);
		expect(refused).toBeGreaterThanOrEqual(0);
		expect(cloud.pullInputs[refused + 1]).toEqual({ afterSeq: cloud.pullInputs[refused]!.afterSeq, limit: MAX_PULL_OPS });
		expect(r.applied).toBe(0);
		expect(readCursor(raw).lastSeq).toBe(cloud.maxSeq);
		// From here on it does not ask again until a server offers it.
		await c.pullOnce();
		expect(cloud.pullInputs.at(-1)!.deviceId).toBeUndefined();
	});

	it('a restored database gets back the own ops it lost, even when it pushes first', async () => {
		const cloud = v2Cloud();
		const a = freshDb('a');
		const ca = client(a.raw, cloud.transport('u'));
		ownTags(a.raw, 'before', 2);
		await ca.syncNow();
		ownTags(a.raw, 'pending', 1); // in the backup, not yet pushed
		const backup = join(dir, 'a-backup.db');
		a.raw.prepare(`VACUUM INTO ?`).run(backup);
		await ca.syncNow();
		ownTags(a.raw, 'after', 3); // pushed after the backup: the restore loses them
		await ca.syncNow();
		ca.stop();

		const { sqlite: restored } = createDb(backup);
		handles.push(restored);
		const cr = client(restored, cloud.transport('u'));
		expect(cr.status().deviceId).toBe(ca.status().deviceId);
		ownTags(restored, 'restored', 1); // new work before the first pull
		await cr.syncNow();
		const tagIds = (raw: Database.Database) => (raw.prepare(`SELECT id FROM tag WHERE kind = 'user' ORDER BY id`).pluck().all() as string[]);
		expect(tagIds(restored)).toEqual(expect.arrayContaining(['after-0', 'after-1', 'after-2', 'pending-0', 'restored-0']));
		// The restored push saw ops with its id above what it holds, so the
		// pull did not skip past them.
		expect(clientState(restored).ownThroughSeq).toBe(cloud.maxSeq);
		await ca.syncNow();
		expect(diffs(a.raw, restored)).toEqual([]);
	});

	// Workstream E: a backup restored onto a second machine while the first
	// keeps syncing. Without the re-mint both would push as one device, and
	// each one's own-op skip would hide the other's edits from it.
	it('a restore re-mints the device: both machines keep syncing and nothing pushed after the backup is lost', async () => {
		const cloud = v2Cloud();
		const a = freshDb('a');
		const ca = client(a.raw, cloud.transport('u'));
		ownTags(a.raw, 'before', 2);
		await ca.syncNow();
		ownTags(a.raw, 'pending', 1); // in the backup, not yet pushed
		const backup = join(dir, 'a-backup.db');
		a.raw.prepare(`VACUUM INTO ?`).run(backup);
		await ca.syncNow(); // the old machine pushes it after the backup
		ownTags(a.raw, 'after', 3);
		await ca.syncNow();
		const oldId = ca.status().deviceId;

		const { sqlite: restored } = createDb(backup);
		handles.push(restored);
		const r = remintDeviceIdentity(restored, 'snap-1@1');
		expect(r).toMatchObject({ reminted: true, oldDeviceId: oldId, restamped: 1 });
		expect(r.newDeviceId).not.toBe(oldId);
		// Pending ops move to the new id, records included; what the old id
		// already pushed keeps its stamp.
		expect(restored.prepare(`SELECT device_id FROM sync_outbox WHERE state = 'pending'`).pluck().all()).toEqual([r.newDeviceId]);
		expect(new Set(restored.prepare(`SELECT device_id FROM sync_outbox WHERE state = 'acked'`).pluck().all())).toEqual(new Set([oldId]));
		const rec = restored.prepare(`SELECT value FROM sync_state WHERE map = 'tags' AND key = 'pending-0'`).pluck().get() as string;
		expect(rec).toContain(r.newDeviceId);
		expect(rec).not.toContain(oldId);
		// The clock keeps its issued stamp and seq_local (pinned to the
		// restored outbox: outbox.ts pinClock) and forgets the server floor.
		const clock = JSON.parse(restored.prepare(`SELECT value FROM app_setting WHERE key = 'sync.clock'`).pluck().get() as string) as { lastIssuedTs: number; lastServerTs: number; lastSeqLocal: number };
		expect(clock.lastServerTs).toBe(0);
		expect(clock.lastSeqLocal).toBe(restored.prepare(`SELECT max(seq_local) FROM sync_outbox`).pluck().get());
		expect(clock.lastIssuedTs).toBeGreaterThanOrEqual(restored.prepare(`SELECT max(client_ts) FROM sync_outbox`).pluck().get() as number);
		expect(clientState(restored).ownThroughSeq).toBe(0);
		// Once per restore; the next restore re-mints again.
		expect(remintDeviceIdentity(restored, 'snap-1@1')).toMatchObject({ reminted: false, newDeviceId: r.newDeviceId });

		// The real server refuses an op whose device_id is not the pusher's
		// (not_owner): watch for one on the wire.
		const transport = cloud.transport('u');
		const foreign: string[] = [];
		const push = transport.sync.push;
		transport.sync.push = async (input) => {
			for (const o of input.ops as Array<{ op_id: string; device_id: string }>) if (o.device_id !== input.deviceId) foreign.push(o.op_id);
			return push(input);
		};
		const cr = client(restored, transport);
		expect(cr.status().deviceId).toBe(r.newDeviceId);
		ownTags(restored, 'restored', 1);
		await cr.syncNow();
		expect(foreign).toEqual([]);
		expect(cloud.devices.has(r.newDeviceId)).toBe(true);
		expect(outboxStates(restored)).toEqual({ acked: restored.prepare(`SELECT count(*) FROM sync_outbox`).pluck().get() });
		const tagIds = (raw: Database.Database) => (raw.prepare(`SELECT id FROM tag WHERE kind = 'user' ORDER BY id`).pluck().all() as string[]);
		expect(tagIds(restored)).toEqual(expect.arrayContaining(['after-0', 'after-1', 'after-2', 'before-0', 'pending-0', 'restored-0']));
		// A re-push of an op the old id already sent is a no-op, not a second copy.
		expect(cloud.log.filter((o) => o.entity === 'tag' && o.entity_id === 'pending-0')).toHaveLength(1);

		// Both keep going, and each sees the other's next edit.
		ownTags(a.raw, 'a-later', 1);
		ownTags(restored, 'r-later', 1);
		await ca.syncNow();
		await cr.syncNow();
		await ca.syncNow();
		expect(tagIds(a.raw)).toEqual(expect.arrayContaining(['r-later-0', 'restored-0']));
		expect(tagIds(restored)).toContain('a-later-0');
		expect(diffs(a.raw, restored)).toEqual([]);
		expect(remintDeviceIdentity(restored, 'snap-2@2').reminted).toBe(true);
	});
});

// ── two desktops ────────────────────────────────────────────────────────────

describe('two desktops on one account', () => {
	it('converge after edits on both, including concurrent edits to the same rows', async () => {
		const cloud = v2Cloud();
		cloud.pageLimit = 7; // exercise paging
		const a = desktop('a', cloud);
		const b = desktop('b', cloud);
		await a.svc.cloudSyncNow();
		await b.svc.cloudSyncNow();

		// A: tags, a playlist with a reorder, a cue, ratings, an override.
		const warm = await a.svc.createTag('Warm');
		await a.svc.addTrackTag('trk-0', warm.id);
		await a.svc.addTrackTag('trk-1', warm.id);
		const set = await a.svc.createLocalPlaylistFromTracks('Set A', ['trk-0', 'trk-1', 'trk-2', 'trk-3']);
		await a.svc.reorderPlaylistTracks(set.id, [3, 0, 1, 2]);
		await a.svc.upsertCue({ trackId: 'trk-0', slot: 0, kind: 'hot', positionSec: 10, lengthSec: null, color: null, name: 'A drop' });
		await a.svc.setRating(['trk-4'], 3);
		await a.svc.setTrackOverrides('trk-5', { title: 'From A' });
		await a.svc.cloudSyncNow();
		await b.svc.cloudSyncNow();

		// Concurrent, neither has seen the other: B edits A's rows too.
		await b.svc.addTrackTag('trk-2', warm.id);
		await b.svc.removeTracksFromPlaylist(set.id, ['trk-1']);
		await b.svc.renamePlaylist(set.id, 'Set A (B)');
		await b.svc.upsertCue({ trackId: 'trk-0', slot: 0, kind: 'hot', positionSec: 12, lengthSec: null, color: '#ff0000', name: 'B drop' });
		await b.svc.setRating(['trk-4'], 5);
		const peak = await b.svc.createTag('Peak');
		await b.svc.addTrackTag('trk-6', peak.id);
		await new Promise((r) => setTimeout(r, 5));
		await a.svc.setRating(['trk-4'], 1); // later than B's: wins
		await a.svc.addTracksToPlaylist(set.id, ['trk-7']);
		await a.svc.removeTrackTag('trk-0', warm.id);

		await b.svc.cloudSyncNow();
		await a.svc.cloudSyncNow();
		await b.svc.cloudSyncNow();

		expect(diffs(a.raw, b.raw)).toEqual([]);
		expect(a.raw.prepare(`SELECT rating FROM track WHERE id = 'trk-4'`).pluck().get()).toBe(1);
		expect(b.raw.prepare(`SELECT name FROM playlist WHERE id = ?`).pluck().get(set.id)).toBe('Set A (B)');
		expect(a.raw.prepare(`SELECT name FROM cue WHERE track_id = 'trk-0' AND slot = 0`).pluck().get()).toBe('B drop');
		const order = (raw: Database.Database) => raw.prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = ? ORDER BY position`).pluck().all(set.id);
		expect(order(a.raw)).toEqual(order(b.raw));
		expect(order(a.raw)).not.toContain('trk-1');
		expect(order(a.raw)).toContain('trk-7');
		for (const d of [a, b]) {
			const s = await d.svc.getCloudSyncStatus();
			expect(s).toMatchObject({ enabled: true, pending: 0, rejected: 0, lastError: null, initialPushDone: true });
		}
	});
});

describe('artist renames and track state across two desktops', () => {
	// Catalogue rows both desktops hold (tracks are not replayed), with
	// credits and the artist junction the rename acts on.
	function seedCredited(raw: Database.Database, rows: Array<[id: string, artists: Array<{ name: string }>]>): void {
		const ins = raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration) VALUES (?, ?, ?, ?, 'unsorted', 300)`);
		for (const [id, artists] of rows) ins.run(id, recordingIdForTrack(id), `Title ${id}`, JSON.stringify(artists));
		syncTrackArtistsByIdRaw(raw, rows.map(([id]) => id));
	}
	const credits = (raw: Database.Database, id: string) => JSON.parse(raw.prepare(`SELECT artists FROM track WHERE id = ?`).pluck().get(id) as string) as unknown;
	const junction = (raw: Database.Database) => raw.prepare(`SELECT t.recording_id, a.name, ta.position FROM track_artist ta JOIN track t ON t.id = ta.track_id
		JOIN artist a ON a.id = ta.artist_id WHERE t.id LIKE 'cr-%' ORDER BY t.recording_id, ta.position`).all();

	it('a rename on one desktop reaches the other, including a track it added offline by the old name', async () => {
		const cloud = v2Cloud();
		cloud.pageLimit = 5;
		const a = desktop('a', cloud);
		const b = desktop('b', cloud);
		const shared: Array<[string, Array<{ name: string }>]> = [
			['cr-0', [{ name: 'Old Name' }]],
			['cr-1', [{ name: 'Old Name' }, { name: 'Friend' }]],
			['cr-2', [{ name: 'Friend' }]],
		];
		seedCredited(a.raw, shared);
		seedCredited(b.raw, shared);
		await a.svc.cloudSyncNow();
		await b.svc.cloudSyncNow();

		// Offline on both: A renames; B adds a track by the old name (a
		// scanner-shaped create) and flips another's state.
		const oldId = a.raw.prepare(`SELECT id FROM artist WHERE name = 'Old Name'`).pluck().get() as string;
		await a.svc.renameArtist(oldId, 'New Name');
		seedCredited(b.raw, [['cr-b', [{ name: 'Old Name' }]]]);
		const bDb = drizzle(b.raw, { schema });
		mut.recordTrackCreated(bDb, 'cr-b', []);
		mut.recordTrackStateChanges(bDb, ['cr-2'], (raw) => { raw.prepare(`UPDATE track SET state = 'backlog' WHERE id = 'cr-2'`).run(); });

		await b.svc.cloudSyncNow();
		await a.svc.cloudSyncNow();
		await b.svc.cloudSyncNow();

		for (const d of [a, b]) {
			expect(credits(d.raw, 'cr-0')).toEqual([{ name: 'New Name' }]);
			expect(credits(d.raw, 'cr-1')).toEqual([{ name: 'New Name' }, { name: 'Friend' }]);
			expect(d.raw.prepare(`SELECT state FROM track WHERE id = 'cr-2'`).pluck().get()).toBe('backlog');
		}
		// B's offline track was rewritten when the rule landed.
		expect(credits(b.raw, 'cr-b')).toEqual([{ name: 'New Name' }]);
		const shared3 = (rows: unknown[]) => (rows as Array<{ recording_id: string }>).filter((r) => r.recording_id !== recordingIdForTrack('cr-b'));
		expect(shared3(junction(b.raw))).toEqual(junction(a.raw));
		// cr-b is B's catalogue row alone: its credits are not A's to hold.
		const onA = (d: ReturnType<typeof dumpLibrary>) => {
			const ok = (r: { recordingId: string }) => r.recordingId !== recordingIdForTrack('cr-b');
			return { ...d, credits: d.credits!.filter(ok), trackArtists: d.trackArtists!.filter(ok) };
		};
		expect(compareDumps(dumpLibrary(a.raw), onA(dumpLibrary(b.raw))).filter((r) => !r.equal)).toEqual([]);

		// And a track B ingests from now on maps through the rule.
		expect(normalizeIncomingArtistsRaw(b.raw, [{ name: 'OLD NAME' }])).toEqual([{ name: 'New Name' }]);
		for (const d of [a, b]) expect(await d.svc.getCloudSyncStatus()).toMatchObject({ pending: 0, rejected: 0, lastError: null });
	});

	it('a device that bootstraps from a snapshot gets the rules and rewrites its credits', async () => {
		const cloud = v2Cloud();
		const a = desktop('a', cloud);
		seedCredited(a.raw, [['cr-0', [{ name: 'Old Name' }]]]);
		await a.svc.cloudSyncNow();
		await a.svc.renameArtist(a.raw.prepare(`SELECT id FROM artist WHERE name = 'Old Name'`).pluck().get() as string, 'New Name');
		await a.svc.cloudSyncNow();
		cloud.hintBelow = cloud.takeSnapshot();
		const b = desktop('b', cloud);
		seedCredited(b.raw, [['cr-0', [{ name: 'Old Name' }]]]);
		await b.svc.cloudSyncNow();
		expect(cloud.calls.bootstrap).toBeGreaterThan(0);
		expect(credits(b.raw, 'cr-0')).toEqual([{ name: 'New Name' }]);
		expect(normalizeIncomingArtistsRaw(b.raw, [{ name: 'Old Name' }])).toEqual([{ name: 'New Name' }]);
	});
});

// ── bootstrap ───────────────────────────────────────────────────────────────

describe('bootstrap', () => {
	it('a far-behind device loads the snapshot, then pulls after it, and matches', async () => {
		const cloud = v2Cloud();
		const a = desktop('a', cloud);
		await a.svc.cloudSyncNow();
		const warm = await a.svc.createTag('Warm');
		await a.svc.addTrackTag('trk-0', warm.id);
		const set = await a.svc.createLocalPlaylistFromTracks('Set', ['trk-0', 'trk-1', 'trk-2']);
		await a.svc.upsertCue({ trackId: 'trk-1', slot: 2, kind: 'memory', positionSec: 60, lengthSec: null, color: null, name: 'Mem' });
		await a.svc.setRating(['trk-2'], 4);
		mut.deletePlaylist(drizzle(a.raw, { schema }), set.id); // a tombstone in the snapshot
		const set2 = await a.svc.createLocalPlaylistFromTracks('Keep', ['trk-3', 'trk-4']);
		await a.svc.cloudSyncNow();
		const snapSeq = cloud.takeSnapshot();
		cloud.hintBelow = snapSeq;

		// After the snapshot: more edits only the op stream carries.
		await a.svc.addTracksToPlaylist(set2.id, ['trk-5']);
		await a.svc.removeTrackTag('trk-0', warm.id);
		await a.svc.setRating(['trk-2'], 2);
		await a.svc.cloudSyncNow();

		const c = desktop('c', cloud);
		// An unpushed local edit on the joining device survives the bootstrap.
		await c.svc.setRating(['trk-6'], 5);
		await c.svc.cloudSyncNow();
		expect(cloud.calls.bootstrap).toBe(1);
		expect(readCursor(c.raw)).toMatchObject({ snapshotSeq: snapSeq });
		await a.svc.cloudSyncNow();
		expect(diffs(a.raw, c.raw)).toEqual([]);
		expect(c.raw.prepare(`SELECT rating FROM track WHERE id = 'trk-2'`).pluck().get()).toBe(2);
		expect(a.raw.prepare(`SELECT rating FROM track WHERE id = 'trk-6'`).pluck().get()).toBe(5);
		expect(readCursor(c.raw).lastSeq).toBe(cloud.maxSeq);
	});
});

// ── stating the library ─────────────────────────────────────────────────────

// A library from before the op log: rows written straight into the tables.
function legacyLibrary(raw: Database.Database, nTracks: number): number {
	const ids = Array.from({ length: nTracks }, (_, i) => `lt-${i}`);
	seedTracks(raw, ids);
	raw.transaction(() => {
		const tag = raw.prepare(`INSERT INTO tag (id, name, kind, created_at) VALUES (?, ?, 'user', ?)`);
		for (let i = 0; i < 20; i++) tag.run(`ltag-${i}`, `Legacy ${i}`, 1_600_000_000_000 + i);
		const tt = raw.prepare(`INSERT INTO track_tag (track_id, tag_id, added_at) VALUES (?, ?, ?)`);
		ids.forEach((id, i) => { tt.run(id, `ltag-${i % 20}`, 1_600_000_000_000 + i); tt.run(id, `ltag-${(i + 7) % 20}`, 1_600_000_000_000 + i); });
		const pl = raw.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES (?, 'local', ?, ?)`);
		const row = raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, source_track_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
		const per = 100;
		for (let p = 0; p * per < nTracks; p++) {
			pl.run(`lpl-${p}`, `lpl-${p}`, `Legacy set ${p}`);
			const members = ids.slice(p * per, (p + 1) * per);
			const keys = rebalance(members.length);
			members.forEach((t, i) => row.run(`lpt-${p}-${i}`, `lpl-${p}`, t, keys[i], i, 1_600_000_000_000, t));
		}
		const rate = raw.prepare(`UPDATE track SET rating = ? WHERE id = ?`);
		ids.forEach((id, i) => { if (i % 2 === 0) rate.run((i % 5) + 1, id); });
		// migrate() marked the DB complete while it was still empty; a real
		// pre-op-log library was migrated with these rows already in it.
		raw.prepare(`DELETE FROM app_setting WHERE key IN (?, ?)`).run(INITIAL_PUSH_KEY, RECORDS_COMPLETE_KEY);
	})();
	return nTracks;
}

// 20 tags + 20 playlists + 4,000 tag rows + 2,000 members + 1,000 ratings +
// 2 system tags + 2,000 recording creates (the rows carry no claims: no
// links, no ISRC) for a 2,000-track legacy library.
const LEGACY_2000_OPS = 20 + 20 + 4_000 + 2_000 + 1_000 + 2 + 2_000;

describe('stating the library', () => {
	it('the founder folds a legacy library into its records: no outbox row, progress through the client status', async () => {
		const cloud = new FakeCloud();
		const { raw } = freshDb('a', false);
		legacyLibrary(raw, 2_000);
		const c = client(raw, cloud.transport('u'), { initialPushChunk: 500 });
		const events: number[] = [];
		c.subscribe((e) => { if (e.kind === 'status' && e.status.initialPush) events.push(e.status.initialPush.done); });
		expect(c.status().initialPushDone).toBe(false);
		// The event loop keeps turning while it runs, and each turn can read
		// the progress off the status (what the Settings line shows).
		const seen: number[] = [];
		const timer = setInterval(() => { const p = c.status().initialPush; if (p) seen.push(p.done); }, 0);
		await c.runInitialPush();
		clearInterval(timer);
		expect(c.status().initialPushDone).toBe(true);
		expect(c.status().initialPush).toBeNull();
		expect(new Set(seen).size).toBeGreaterThan(3);
		expect(seen.every((n, i) => i === 0 || n >= seen[i - 1]!)).toBe(true);
		expect(events.length).toBeGreaterThan(0);
		// Folded, not sent: every row has a record, the outbox is empty, and
		// the account's log holds nothing of the library.
		expect(c.status().pending).toBe(0);
		expect(raw.prepare(`SELECT count(*) FROM sync_outbox`).pluck().get()).toBe(0);
		expect(raw.prepare(`SELECT count(*) FROM sync_state WHERE map = 'trackTags'`).pluck().get()).toBe(4_000);
		expect(raw.prepare(`SELECT count(*) FROM sync_state WHERE map = 'libraryTracks'`).pluck().get()).toBe(2_000);
		expect(cloud.log).toEqual([]);
		// The fold stated the meta cells too, with the drains' baselines, so
		// nothing is queued or restated afterwards.
		expect(raw.prepare(`SELECT count(*) FROM track_meta_dirty`).pluck().get()).toBe(0);
		expect(raw.prepare(`SELECT count(*) FROM track_meta_seen`).pluck().get()).toBe(2_000);
		await c.syncNow();
		expect(c.status().pending).toBe(0);
		expect(cloud.log.filter((o) => o.entity !== 'setting')).toEqual([]);
	});

	it('a joiner states only what it alone holds, as the initial-push batch', async () => {
		const cloud = new FakeCloud();
		cloud.takeSnapshot('u'); // an account with an (empty) base to join
		const { raw } = freshDb('a', false);
		legacyLibrary(raw, 2_000);
		const c = client(raw, cloud.transport('u'), { initialPushChunk: 500 });
		await c.runInitialPush();
		expect(c.status().initialPushDone).toBe(true);
		expect(c.status().pending).toBe(LEGACY_2000_OPS);
		expect(raw.prepare(`SELECT count(*) FROM sync_outbox WHERE batch_label = 'initial-push'`).pluck().get()).toBe(LEGACY_2000_OPS);
		await c.syncNow();
		expect(c.status().pending).toBe(0);
	});

	it('a second desktop that joins from the founder\'s snapshot matches the legacy library', async () => {
		const cloud = new FakeCloud();
		const a = freshDb('a', false);
		legacyLibrary(a.raw, 300);
		const ca = client(a.raw, cloud.transport('u'), { snapshot: { builder: inlineSnapshotBuilder(a.path) } });
		await ca.syncNow();
		await until(() => !ca.status().snapshot.publishing);
		expect(cloud.published).toHaveLength(1);
		const b = freshDb('b', false);
		seedTracks(b.raw, Array.from({ length: 300 }, (_, i) => `lt-${i}`));
		const cb = client(b.raw, cloud.transport('u'));
		await cb.syncNow();
		expect(cloud.calls.storageBootstraps).toBe(1);
		expect(diffs(a.raw, b.raw)).toEqual([]);
	});

	it('measures the main-loop stall of the fold on a generated library of ~50k op-log rows', async () => {
		const { raw } = freshDb('big', false);
		legacyLibrary(raw, 12_500); // 25k tag rows + 12.5k members + 6.25k ratings + containers ≈ 44k ops
		const rows = (raw.prepare(`SELECT (SELECT count(*) FROM track_tag) + (SELECT count(*) FROM playlist_track) + (SELECT count(*) FROM track) AS n`).pluck().get() as number);
		let worstGap = 0;
		let last = performance.now();
		const timer = setInterval(() => { const now = performance.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 1);
		const r = await foldLibraryAsync(raw, { chunk: 500 });
		clearInterval(timer);
		// Reported, not asserted tight: machines differ. A 500-op slice should
		// stay far under the 18 s single-shot run B measured.
		console.log(`[founder-fold stall] rows=${rows} ops=${r.ops} meta=${r.meta} attrs=${r.attrs} chunks=${r.chunks} total=${r.ms}ms maxSlice=${r.maxSliceMs.toFixed(1)}ms worstTimerGap=${worstGap.toFixed(1)}ms`);
		expect(r.ops).toBeGreaterThan(40_000);
		expect(r.maxSliceMs).toBeLessThan(2_000);
		expect(raw.prepare(`SELECT count(*) FROM sync_outbox`).pluck().get()).toBe(0);
		// The joiner form of the same library, for the record.
		const j = freshDb('join', false);
		legacyLibrary(j.raw, 2_000);
		const jr = await joinPushAsync(j.raw, { chunk: 500 });
		expect(jr.ops).toBe(LEGACY_2000_OPS);
		expect(j.raw.prepare(`SELECT count(*) FROM sync_outbox`).pluck().get()).toBe(LEGACY_2000_OPS);
	}, 120_000);
});

// ── logging ─────────────────────────────────────────────────────────────────

describe('cycle summary log', () => {
	type Rec = { level: string; msg: string; data?: Record<string, unknown>; err?: unknown };
	const capture = (): { recs: Rec[]; logger: AreaLogger } => {
		const recs: Rec[] = [];
		return {
			recs,
			logger: {
				debug: (msg, data) => recs.push({ level: 'debug', msg, data }),
				info: (msg, data) => recs.push({ level: 'info', msg, data }),
				warn: (msg, data, err) => recs.push({ level: 'warn', msg, data, err }),
				error: (msg, err, data) => recs.push({ level: 'error', msg, data, err }),
			},
		};
	};

	it('logs one summary per cycle with counts only, at debug when the cycle was idle', async () => {
		const cloud = v2Cloud();
		const marker = 'payload-marker-7f3a';
		const a = freshDb('a');
		const ca = client(a.raw, cloud.transport('u', 'secret.person@example.test'));
		await ca.syncNow();
		const db = drizzle(a.raw, { schema });
		for (let i = 0; i < 3; i++) mut.createTag(db, { id: `t-${i}`, name: `${marker} ${i}` });

		const b = freshDb('b');
		const { recs, logger } = capture();
		const cb = client(b.raw, cloud.transport('u', 'secret.person@example.test'), { logger });
		await ca.syncNow();
		await cb.syncNow();
		const firstB = recs.filter((r) => r.msg === 'sync cycle');
		expect(firstB).toHaveLength(1);
		expect(firstB[0]!.level).toBe('info');
		// B's own first statement (its seeded rows, as ops: a server with no
		// base) never comes back on its pull.
		expect(firstB[0]!.data).toMatchObject({ outcome: 'ok', pulled: cloud.log.filter((o) => o.device_id !== cb.status().deviceId).length, bootstrapped: false });
		expect(firstB[0]!.data!.applied).toBeGreaterThan(0);
		expect(typeof firstB[0]!.data!.ms).toBe('number');

		// A's next cycle pushes nothing new: idle, so debug.
		const { recs: recsA, logger: loggerA } = capture();
		const ca2 = client(a.raw, cloud.transport('u'), { logger: loggerA });
		mut.createTag(db, { id: 't-9', name: `${marker} 9` });
		await ca2.syncNow();
		await ca2.syncNow();
		const cycles = recsA.filter((r) => r.msg === 'sync cycle');
		expect(cycles.map((r) => r.level)).toEqual(['info', 'debug']);
		expect(cycles[0]!.data).toMatchObject({ outcome: 'ok', pushed: 1, rejected: 0 });

		// A failed cycle is summarised too, with the error kind.
		cloud.fail.pull.push(new CloudTransportError('server', 'HTTP 503'));
		await cb.syncNow();
		expect(recs.filter((r) => r.msg === 'sync cycle').at(-1)).toMatchObject({ level: 'info', data: { outcome: 'server' } });

		const all = JSON.stringify([...recs, ...recsA]);
		expect(all).not.toContain(marker);
		expect(all).not.toContain('secret.person@example.test');
	});

	it('counts per-op rejections in the summary', async () => {
		const cloud = v2Cloud();
		const { raw } = freshDb('a');
		const { recs, logger } = capture();
		const c = client(raw, cloud.transport('u'), { logger });
		await c.runInitialPush();
		makeTags(raw, 3);
		const bad = raw.prepare(`SELECT op_id FROM sync_outbox WHERE entity_id = 'tag-1'`).pluck().get() as string;
		cloud.rejectIds.set(bad, 'not_owner');
		await c.syncNow();
		const s = recs.filter((r) => r.msg === 'sync cycle').at(-1)!;
		expect(s.data).toMatchObject({ outcome: 'ok', rejected: 1 });
		expect(s.data!.pushed).toBeGreaterThanOrEqual(2);
	});
});
