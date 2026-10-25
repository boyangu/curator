// The cloud sync client's adaptive fallback poll (poll-policy.ts): the
// cadence while in use / idle, the switch between them, the Realtime
// channel's health holding the active cadence while it is down, a regained
// network (an immediate cycle, the poll re-based, 'reconnected' once it went
// through), policy changes on a running client, clamping, and the
// per-device setting behind it.
//
// Generated DBs only (CLAUDE.md): mkdtempSync + migrate(). The transport is
// an in-process stub that counts calls; nothing here touches the network,
// the live DB or real files.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
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
import { removeDir } from '../test-support/tmp.js';
import { createCoreService, type CloudActivityWatcher, type CoreService } from '../service.js';
import type { StreamingSourceAdapter } from '../sources/adapter.js';
import * as mut from '../library/mutators.js';
import { CloudTransportError, createSyncClient, type CloudSyncEvent, type CloudTransport, type SyncClient, type WakeReason } from './client.js';
import { DEFAULT_SYNC_POLL_POLICY, normalizePollPolicy, readPollSettings, SYNC_POLL_KEY } from './poll-policy.js';

// ── fixtures ────────────────────────────────────────────────────────────────

// `offline`: pulls fail as the HTTP transport's do with no network.
type StubTransport = CloudTransport & { calls: { push: number; pull: number }; offline: boolean };

function stubTransport(): StubTransport {
	const calls = { push: 0, pull: 0 };
	const t: StubTransport = {
		calls,
		offline: false,
		session: () => ({ userId: 'user-1', email: null }),
		signOut: async () => { /* not exercised */ },
		sync: {
			push: async (input: PushInput) => { calls.push++; return { accepted: input.ops.length, maxSeq: 0, rejected: [] }; },
			pull: async (input: PullInput) => {
				calls.pull++;
				if (t.offline) throw new CloudTransportError('network', 'fetch failed');
				return { ops: [], nextSeq: input.afterSeq };
			},
		},
		bootstrap: async () => ({ snapshotSeq: 0, baseSeq: 0, records: null }),
		account: {
			registerDevice: async () => ({ ok: true as const }),
			devices: async () => [],
			revokeDevice: async () => ({ ok: true as const }),
		},
	};
	return t;
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
afterEach(async () => {
	vi.useRealTimers();
	for (const c of clients.splice(0)) c.stop();
	for (const s of services.splice(0).reverse()) await s.close();
	for (const h of handles.splice(0)) h.close();
	await removeDir(dir);
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
// `live`: the Realtime channel is joined (set before start, so it wakes
// nothing) — the idle cadence needs it.
async function startedClient(extra: Partial<Parameters<typeof createSyncClient>[0]> = {}, o: { live?: boolean } = {}): Promise<{ c: SyncClient; t: StubTransport; raw: Database.Database; recs: Rec[]; events: CloudSyncEvent[] }> {
	const { raw } = freshDb();
	const t = stubTransport();
	const { recs, logger } = capture();
	const c = createSyncClient({ db: raw, transport: t, debounceMs: 1, logger, backoffBaseMs: 5_000, backoffCapMs: 5_000, ...extra });
	clients.push(c);
	await c.syncNow();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
	c.setRealtimeLive(o.live ?? true);
	t.calls.pull = 0;
	t.calls.push = 0;
	recs.length = 0;
	const events: CloudSyncEvent[] = [];
	c.subscribe((e) => events.push(e));
	c.start();
	await vi.advanceTimersByTimeAsync(5);
	expect(t.calls.pull).toBe(1);
	return { c, t, raw, recs, events };
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

// ── Realtime health ─────────────────────────────────────────────────────────

describe('Realtime channel health', () => {
	const cycles = (recs: Rec[]): Rec[] => recs.filter((r) => r.msg === 'sync cycle');
	const channelLines = (recs: Rec[]): Rec[] => recs.filter((r) => r.msg.startsWith('realtime wake channel'));

	it('keeps the 60 s cadence while idle and the channel is down; the idle decay applies once it is joined', async () => {
		const { c, t } = await startedClient({}, { live: false });
		const clock = { t: 5 };
		expect(c.status().poll).toMatchObject({ realtimeLive: false, active: true });
		c.setActive(false);
		await advanceTo(clock, 60 * SEC + 5);
		expect(t.calls.pull).toBe(2);
		await advanceTo(clock, 120 * SEC + 5);
		expect(t.calls.pull).toBe(3);
		// Joined: one catch-up cycle, then the idle period from the last poll.
		c.setRealtimeLive(true);
		await advanceTo(clock, 130 * SEC);
		expect(t.calls.pull).toBe(4);
		expect(c.status().poll.realtimeLive).toBe(true);
		await advanceTo(clock, 719 * SEC);
		expect(t.calls.pull).toBe(4);
		await advanceTo(clock, 720 * SEC + 10);
		expect(t.calls.pull).toBe(5);
	});

	it('idle with the channel joined polls every 600 s', async () => {
		const { c, t } = await startedClient({}, { live: true });
		const clock = { t: 5 };
		c.setActive(false);
		await advanceTo(clock, 599 * SEC);
		expect(t.calls.pull).toBe(1);
		await advanceTo(clock, 600 * SEC + 5);
		expect(t.calls.pull).toBe(2);
	});

	it('down → live wakes one catch-up cycle; repeats and live → down wake none; each transition logs once', async () => {
		const { c, t, recs } = await startedClient({}, { live: false });
		const clock = { t: 5 };
		c.setRealtimeLive(true);
		c.setRealtimeLive(true);
		await advanceTo(clock, 10 * SEC);
		expect(t.calls.pull).toBe(2);
		expect(cycles(recs).at(-1)!.data).toMatchObject({ reason: 'rejoin' });
		c.setRealtimeLive(false);
		c.setRealtimeLive(false);
		await advanceTo(clock, 20 * SEC);
		expect(t.calls.pull).toBe(2);
		expect(channelLines(recs).map((r) => [r.level, r.msg])).toEqual([
			['info', 'realtime wake channel live — polling every 60s'],
			['info', 'realtime wake channel down — polling every 60s'],
		]);
		// While idle the number says what the switch changed.
		c.setActive(false);
		c.setRealtimeLive(true);
		expect(channelLines(recs).at(-1)!.msg).toBe('realtime wake channel live — polling every 600s');
	});

	it('the channel going down while idle shortens the period at once (a due time already past polls now)', async () => {
		const { c, t } = await startedClient({}, { live: true });
		const clock = { t: 5 };
		c.setActive(false);
		await advanceTo(clock, 300 * SEC);
		expect(t.calls.pull).toBe(1);
		c.setRealtimeLive(false);
		await advanceTo(clock, 300 * SEC + 5);
		expect(t.calls.pull).toBe(2);
		await advanceTo(clock, 359 * SEC);
		expect(t.calls.pull).toBe(2);
		await advanceTo(clock, 360 * SEC + 10);
		expect(t.calls.pull).toBe(3);
	});
});

// ── a regained network ──────────────────────────────────────────────────────

describe('a network wake', () => {
	it('cycles at once, logs it at info, re-bases the poll on it, and says reconnected once', async () => {
		const { c, t, recs, events } = await startedClient();
		const clock = { t: 5 };
		await advanceTo(clock, 45 * SEC);
		c.wake('network');
		// The next poll counts from the reconnect, not from start.
		expect(c.status().poll.nextPollAt).toBe(Date.now() + 60 * SEC);
		await advanceTo(clock, 45 * SEC + 5);
		expect(t.calls.pull).toBe(2);
		const line = recs.filter((r) => r.msg === 'sync cycle').at(-1)!;
		expect([line.level, line.data?.['reason'], line.data?.['outcome']]).toEqual(['info', 'network', 'ok']);
		expect(events.filter((e) => e.kind === 'reconnected')).toHaveLength(1);
		await advanceTo(clock, 104 * SEC);
		expect(t.calls.pull).toBe(2);
		await advanceTo(clock, 105 * SEC + 10);
		expect(t.calls.pull).toBe(3);
		// Later cycles are ordinary.
		expect(events.filter((e) => e.kind === 'reconnected')).toHaveLength(1);
	});

	it('a reconnect whose first cycle fails says reconnected after the one that goes through', async () => {
		const { c, t, events } = await startedClient();
		const clock = { t: 5 };
		t.offline = true;
		c.wake('network');
		await advanceTo(clock, 10);
		expect(t.calls.pull).toBe(2);
		expect(events.some((e) => e.kind === 'reconnected')).toBe(false);
		t.offline = false;
		// The backoff's retry (5 s here) goes through.
		await advanceTo(clock, 6 * SEC);
		expect(t.calls.pull).toBe(3);
		expect(events.filter((e) => e.kind === 'reconnected')).toHaveLength(1);
	});

	it('other wakes never say reconnected', async () => {
		const { c, events } = await startedClient();
		const clock = { t: 5 };
		for (const r of ['focus', 'realtime', 'manual', 'resume', 'rejoin'] as WakeReason[]) c.wake(r);
		await advanceTo(clock, 70 * SEC);
		expect(events.some((e) => e.kind === 'reconnected')).toBe(false);
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

		await svc.close();
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

		await svc.close();
		services.splice(services.indexOf(svc), 1);
		expect(watcher.stopped).toBe(true);
	});

	it('threads the host\'s Realtime health and network wakes through: reconnected follows a network wake\'s cycle', async () => {
		const { path } = freshDb();
		let onWake: ((reason?: WakeReason, seq?: number) => void) | null = null;
		let onRealtime: ((live: boolean) => void) | null = null;
		let realtimeUnsubbed = false;
		const svc = createCoreService(path, {
			peaksDir: join(dir, 'peaks'),
			sourceAdapters: { spotify: throwingAdapter() },
			cloud: {
				transport: stubTransport(),
				device: { name: 'test', platform: 'win32' },
				subscribeWakeups: (cb) => { onWake = cb; return () => { onWake = null; }; },
				onRealtimeChange: (cb) => { onRealtime = cb; cb(false); return () => { realtimeUnsubbed = true; }; },
			},
		});
		services.push(svc);
		const events: CloudSyncEvent[] = [];
		svc.subscribeCloudSync((e) => events.push(e));
		svc.startCloudSync();
		const until = async (cond: () => Promise<boolean>): Promise<void> => {
			const end = Date.now() + 5_000;
			while (!(await cond())) {
				if (Date.now() > end) throw new Error('timed out waiting');
				await new Promise((r) => setTimeout(r, 10));
			}
		};
		await until(async () => (await svc.getCloudSyncStatus()).lastPullAt !== null && !(await svc.getCloudSyncStatus()).running);
		expect((await svc.getCloudSyncStatus()).poll.realtimeLive).toBe(false);
		onRealtime!(true);
		expect((await svc.getCloudSyncStatus()).poll.realtimeLive).toBe(true);
		expect(events.some((e) => e.kind === 'reconnected')).toBe(false);

		onWake!('network');
		await until(async () => events.some((e) => e.kind === 'reconnected'));
		expect(events.filter((e) => e.kind === 'reconnected')).toHaveLength(1);

		await svc.close();
		services.splice(services.indexOf(svc), 1);
		expect(realtimeUnsubbed).toBe(true);
	});
});
