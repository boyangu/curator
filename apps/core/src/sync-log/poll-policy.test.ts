// The cloud sync client's adaptive fallback poll (poll-policy.ts): the
// cadence while in use / idle, the switch between them, policy changes on a
// running client, clamping, and the per-device setting behind it.
//
// Generated DBs only (CLAUDE.md): mkdtempSync + migrate(). The transport is
// an in-process stub that counts calls; nothing here touches the network,
// the live DB or real files.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@curator/shared/schema';
import { ACCOUNT_SETTING_KEYS, isAccountSettingKey, type PullInput, type PushInput } from '@curator/protocol';
import { getSourceCapabilities } from '@curator/shared';
import type { AreaLogger } from '@curator/shared/log';
import { migrate } from '../db/migrate.js';
import { createDb } from '../db/client.js';
import { createCoreService, type CloudActivityWatcher, type CoreService } from '../service.js';
import type { StreamingSourceAdapter } from '../sources/adapter.js';
import * as mut from '../library/mutators.js';
import { createSyncClient, type CloudTransport, type SyncClient } from './client.js';
import { DEFAULT_SYNC_POLL_POLICY, normalizePollPolicy, readPollSettings, SYNC_POLL_KEY } from './poll-policy.js';

// ── fixtures ────────────────────────────────────────────────────────────────

type StubTransport = CloudTransport & { calls: { push: number; pull: number } };

function stubTransport(): StubTransport {
	const calls = { push: 0, pull: 0 };
	return {
		calls,
		session: () => ({ userId: 'user-1', email: null }),
		sync: {
			push: async (input: PushInput) => { calls.push++; return { accepted: input.ops.length, maxSeq: 0, rejected: [] }; },
			pull: async (input: PullInput) => { calls.pull++; return { ops: [], nextSeq: input.afterSeq }; },
		},
		bootstrap: async () => ({ snapshotSeq: 0, records: [] }),
		account: {
			registerDevice: async () => ({ ok: true as const }),
			devices: async () => [],
			revokeDevice: async () => ({ ok: true as const }),
		},
	};
}

type Rec = { level: string; msg: string; data?: Record<string, unknown> };
function capture(): { recs: Rec[]; logger: AreaLogger } {
	const recs: Rec[] = [];
	return {
		recs,
		logger: {
			debug: (msg, data) => recs.push({ level: 'debug', msg, data }),
			info: (msg, data) => recs.push({ level: 'info', msg, data }),
			warn: (msg, data) => recs.push({ level: 'warn', msg, data }),
			error: (msg, _err, data) => recs.push({ level: 'error', msg, data }),
		},
	};
}

function throwingAdapter(): StreamingSourceAdapter {
	const boom = async (): Promise<never> => { throw new Error('upstream write attempted in a poll-policy test'); };
	return {
		source: 'spotify', displayName: 'Fake Spotify', capabilities: getSourceCapabilities('spotify'),
		listRemotePlaylists: async () => [], fetchPlaylistTracks: async () => [],
		createPlaylist: boom, deletePlaylist: boom, renamePlaylist: boom, addTracks: boom, removeTracks: boom, replaceTracks: boom,
	};
}

let dir: string;
const handles: Database.Database[] = [];
const clients: SyncClient[] = [];
const services: CoreService[] = [];

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-poll-policy-')); });
afterEach(() => {
	vi.useRealTimers();
	for (const c of clients.splice(0)) c.stop();
	for (const s of services.splice(0)) s.close();
	for (const h of handles.splice(0)) h.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

function freshDb(name = 'lib'): { path: string; raw: Database.Database } {
	const p = join(dir, `${name}.db`);
	migrate(p);
	const { sqlite } = createDb(p);
	handles.push(sqlite);
	return { path: p, raw: sqlite };
}

const SEC = 1_000;

// A started client on fake timers whose first (session) cycle has run. The
// device registration and first-sign-in push run once on real timers first
// (they yield with setImmediate), so every later cycle is exactly one pull.
async function startedClient(extra: Partial<Parameters<typeof createSyncClient>[0]> = {}): Promise<{ c: SyncClient; t: StubTransport; raw: Database.Database; recs: Rec[] }> {
	const { raw } = freshDb();
	const t = stubTransport();
	const { recs, logger } = capture();
	const c = createSyncClient({ db: raw, transport: t, debounceMs: 1, logger, ...extra });
	clients.push(c);
	await c.syncNow();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
	t.calls.pull = 0;
	t.calls.push = 0;
	recs.length = 0;
	c.start();
	await vi.advanceTimersByTimeAsync(5);
	expect(t.calls.pull).toBe(1);
	return { c, t, raw, recs };
}

// Advance to `ms` after start (the start-time fixture already used 5 ms).
const advanceTo = async (elapsedRef: { t: number }, ms: number): Promise<void> => {
	await vi.advanceTimersByTimeAsync(ms - elapsedRef.t);
	elapsedRef.t = ms;
};

// ── client cadence ──────────────────────────────────────────────────────────

describe('fallback poll cadence', () => {
	it('polls every 60 s by default', async () => {
		const { c, t } = await startedClient();
		const clock = { t: 5 };
		expect(c.status().poll).toMatchObject({ active: true, policy: DEFAULT_SYNC_POLL_POLICY });
		await advanceTo(clock, 59 * SEC);
		expect(t.calls.pull).toBe(1);
		await advanceTo(clock, 60 * SEC + 5);
		expect(t.calls.pull).toBe(2);
		await advanceTo(clock, 120 * SEC + 5);
		expect(t.calls.pull).toBe(3);
		await advanceTo(clock, 180 * SEC + 5);
		expect(t.calls.pull).toBe(4);
	});

	it('switches to 600 s after setActive(false)', async () => {
		const { c, t } = await startedClient();
		const clock = { t: 5 };
		const startedAt = c.status().poll.nextPollAt! - 60 * SEC;
		c.setActive(false);
		expect(c.status().poll.active).toBe(false);
		// The period counts from the last poll (start), not from the switch.
		expect(c.status().poll.nextPollAt).toBe(startedAt + 600 * SEC);
		await advanceTo(clock, 599 * SEC);
		expect(t.calls.pull).toBe(1);
		await advanceTo(clock, 600 * SEC + 5);
		expect(t.calls.pull).toBe(2);
		await advanceTo(clock, 1199 * SEC);
		expect(t.calls.pull).toBe(2);
		await advanceTo(clock, 1200 * SEC + 5);
		expect(t.calls.pull).toBe(3);
	});

	it('syncs at once on setActive(true), then returns to 60 s', async () => {
		const { c, t, recs } = await startedClient();
		const clock = { t: 5 };
		c.setActive(false);
		await advanceTo(clock, 300 * SEC);
		expect(t.calls.pull).toBe(1);
		c.setActive(true);
		await advanceTo(clock, 300 * SEC + 5);
		expect(t.calls.pull).toBe(2);
		expect(recs.filter((r) => r.msg === 'sync cycle').at(-1)!.data).toMatchObject({ reason: 'resume' });
		await advanceTo(clock, 359 * SEC);
		expect(t.calls.pull).toBe(2);
		await advanceTo(clock, 360 * SEC + 5);
		expect(t.calls.pull).toBe(3);
		expect(recs.filter((r) => r.msg === 'sync cycle').at(-1)!.data).toMatchObject({ reason: 'interval' });
	});

	it('applies a policy change to the next poll without waiting out the old timer', async () => {
		const { c, t } = await startedClient();
		const clock = { t: 5 };
		await advanceTo(clock, 10 * SEC);
		c.setPollPolicy({ activeSec: 20 });
		expect(c.status().poll.policy.activeSec).toBe(20);
		await advanceTo(clock, 19 * SEC);
		expect(t.calls.pull).toBe(1);
		await advanceTo(clock, 20 * SEC + 5);
		expect(t.calls.pull).toBe(2);
		await advanceTo(clock, 40 * SEC + 5);
		expect(t.calls.pull).toBe(3);

		// Idle, then a shorter idle period that is already overdue: polls now.
		c.setActive(false);
		await advanceTo(clock, 200 * SEC);
		expect(t.calls.pull).toBe(3);
		c.setPollPolicy({ idleSec: 120 });
		await advanceTo(clock, 200 * SEC + 5);
		expect(t.calls.pull).toBe(4);
		await advanceTo(clock, 319 * SEC);
		expect(t.calls.pull).toBe(4);
		await advanceTo(clock, 320 * SEC + 5);
		expect(t.calls.pull).toBe(5);
	});

	it('clamps a policy, at construction and on change', async () => {
		const { c, t } = await startedClient({ pollPolicy: { activeSec: 1 } });
		const clock = { t: 5 };
		expect(c.status().poll.policy).toEqual({ activeSec: 15, idleSec: 600, idleAfterSec: 600 });
		await advanceTo(clock, 15 * SEC + 5);
		expect(t.calls.pull).toBe(2);
		c.setPollPolicy({ activeSec: 9_999, idleSec: 1 });
		// idleSec is never below activeSec.
		expect(c.status().poll.policy).toEqual({ activeSec: 600, idleSec: 600, idleAfterSec: 600 });
	});

	it('still syncs at once on Realtime and local wakes while idle', async () => {
		const { c, t, raw, recs } = await startedClient();
		const clock = { t: 5 };
		c.setActive(false);
		await advanceTo(clock, 100 * SEC);
		c.wake('realtime');
		await advanceTo(clock, 100 * SEC + 5);
		expect(t.calls.pull).toBe(2);
		expect(recs.filter((r) => r.msg === 'sync cycle').at(-1)!.data).toMatchObject({ reason: 'realtime' });

		mut.createTag(drizzle(raw, { schema }), { id: 'tag-1', name: 'Tag 1' });
		await advanceTo(clock, 100 * SEC + 10);
		expect(t.calls.push).toBe(1);
		expect(t.calls.pull).toBe(3);
		expect(recs.filter((r) => r.msg === 'sync cycle').at(-1)!.data).toMatchObject({ reason: 'local', pushed: 1 });
		// Neither moved the idle poll.
		await advanceTo(clock, 599 * SEC);
		expect(t.calls.pull).toBe(3);
		await advanceTo(clock, 600 * SEC + 5);
		expect(t.calls.pull).toBe(4);
	});

	it('logs one line per cadence switch, not per tick', async () => {
		const { c, recs } = await startedClient();
		const clock = { t: 5 };
		c.setActive(false);
		c.setActive(false);
		await advanceTo(clock, 3_600 * SEC);
		c.setActive(true);
		c.setActive(true);
		await advanceTo(clock, 3_900 * SEC);
		const switches = recs.filter((r) => r.msg.startsWith('poll cadence'));
		expect(switches.map((r) => [r.level, r.msg])).toEqual([['info', 'poll cadence: idle'], ['info', 'poll cadence: in use']]);
		expect(switches[0]!.data).toMatchObject({ everySec: 600 });
		expect(switches[1]!.data).toMatchObject({ everySec: 60 });
	});

	it('stop() clears the poll timer', async () => {
		const { c, t } = await startedClient();
		expect(c.status().poll.nextPollAt).not.toBeNull();
		c.stop();
		expect(c.status().poll.nextPollAt).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(3_600 * SEC);
		expect(t.calls.pull).toBe(1);
		// A switch on a stopped client re-arms nothing.
		c.setActive(false);
		c.setActive(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});

// ── the setting ─────────────────────────────────────────────────────────────

describe('sync.poll setting', () => {
	it('normalises missing, garbage and out-of-range fields', () => {
		expect(normalizePollPolicy(null)).toEqual(DEFAULT_SYNC_POLL_POLICY);
		expect(normalizePollPolicy({ activeSec: 'x', idleSec: Number.NaN, idleAfterSec: 1e9 })).toEqual({ activeSec: 60, idleSec: 600, idleAfterSec: 7200 });
		expect(normalizePollPolicy({ activeSec: 5, idleSec: 30, idleAfterSec: 10 })).toEqual({ activeSec: 15, idleSec: 60, idleAfterSec: 60 });
		expect(normalizePollPolicy({ activeSec: 300, idleSec: 120 })).toEqual({ activeSec: 300, idleSec: 300, idleAfterSec: 600 });
		expect(normalizePollPolicy({ activeSec: 29.6 }).activeSec).toBe(30);
	});

	it('is per device: never an account setting, never an op', () => {
		expect(isAccountSettingKey(SYNC_POLL_KEY)).toBe(false);
		expect((ACCOUNT_SETTING_KEYS as readonly string[]).includes(SYNC_POLL_KEY)).toBe(false);
	});

	it('round-trips through CoreService and survives a reopen', async () => {
		const { path, raw } = freshDb();
		const open = (): CoreService => {
			const svc = createCoreService(path, { peaksDir: join(dir, 'peaks'), sourceAdapters: { spotify: throwingAdapter() } });
			services.push(svc);
			return svc;
		};
		let svc = open();
		expect(await svc.getCloudSyncPollSettings()).toMatchObject({ policy: DEFAULT_SYNC_POLL_POLICY, defaults: DEFAULT_SYNC_POLL_POLICY, stored: false });
		expect((await svc.getCloudSyncPollSettings()).limits.activeSec).toEqual([15, 600]);

		const set = await svc.setCloudSyncPollPolicy({ activeSec: 30, idleAfterSec: 900 });
		expect(set).toMatchObject({ policy: { activeSec: 30, idleSec: 600, idleAfterSec: 900 }, stored: true });
		// A patch merges over the stored value; out-of-range input is clamped.
		expect((await svc.setCloudSyncPollPolicy({ idleSec: 5 })).policy).toEqual({ activeSec: 30, idleSec: 60, idleAfterSec: 900 });
		// Sync disabled: the status still reports the policy in force.
		expect((await svc.getCloudSyncStatus()).poll).toMatchObject({ policy: { activeSec: 30 }, active: true, nextPollAt: null });

		svc.close();
		services.splice(services.indexOf(svc), 1);
		svc = open();
		expect((await svc.getCloudSyncPollSettings()).policy).toEqual({ activeSec: 30, idleSec: 60, idleAfterSec: 900 });

		// Stored as JSON under the one key, with no op in the outbox.
		const row = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(SYNC_POLL_KEY) as { value: string };
		expect(JSON.parse(row.value)).toEqual({ activeSec: 30, idleSec: 60, idleAfterSec: 900 });
		expect(raw.prepare(`SELECT count(*) FROM sync_outbox WHERE entity = 'setting'`).pluck().get()).toBe(0);

		expect(await svc.setCloudSyncPollPolicy(null)).toMatchObject({ policy: DEFAULT_SYNC_POLL_POLICY, stored: false });
		expect(readPollSettings(raw).stored).toBe(false);
	});

	it('applies to the running client and the host activity watcher at once', async () => {
		const { path } = freshDb();
		const watcher = { idleAfterMs: [] as number[], stopped: false, onChange: null as ((active: boolean) => void) | null };
		const svc = createCoreService(path, {
			peaksDir: join(dir, 'peaks'),
			sourceAdapters: { spotify: throwingAdapter() },
			cloud: {
				transport: stubTransport(),
				device: { name: 'test', platform: 'win32' },
				watchActivity: (onChange): CloudActivityWatcher => {
					watcher.onChange = onChange;
					return { setIdleAfterMs: (ms) => { watcher.idleAfterMs.push(ms); }, stop: () => { watcher.stopped = true; } };
				},
			},
		});
		services.push(svc);
		svc.startCloudSync();
		expect(watcher.idleAfterMs).toEqual([600_000]);

		await svc.setCloudSyncPollPolicy({ activeSec: 45, idleAfterSec: 120 });
		expect((await svc.getCloudSyncStatus()).poll.policy).toEqual({ activeSec: 45, idleSec: 600, idleAfterSec: 120 });
		expect(watcher.idleAfterMs).toEqual([600_000, 120_000]);

		watcher.onChange!(false);
		expect((await svc.getCloudSyncStatus()).poll.active).toBe(false);
		watcher.onChange!(true);
		expect((await svc.getCloudSyncStatus()).poll.active).toBe(true);

		svc.close();
		services.splice(services.indexOf(svc), 1);
		expect(watcher.stopped).toBe(true);
	});
});
