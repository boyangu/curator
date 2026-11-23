// The sync client's Realtime filter (client.ts wake / dropStalePings): the
// server rings every device of the user on each push, the pusher too, with
// the head seq; a ping at or below the pull cursor runs no cycle. A ping for
// another device's change, one without a seq (an older server), and one that
// arrives mid-cycle for a change the cycle's pull did not see all still sync.
//
// Generated DBs only (CLAUDE.md): mkdtempSync + migrate(); the in-memory
// server (test-support/fake-cloud.ts) never leaves the process.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@curator/shared/schema';
import type { AreaLogger } from '@curator/shared/log';
import type { PullInput, PushInput } from '@curator/protocol';
import { migrate } from '../db/migrate.js';
import { createDb } from '../db/client.js';
import * as mut from '../library/mutators.js';
import { FakeCloud, type FakeTransport } from '../test-support/fake-cloud.js';
import { createSyncClient, readCursor, type SyncClient } from './client.js';

let dir: string;
const handles: Database.Database[] = [];
const clients: SyncClient[] = [];

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-self-wake-')); });
afterEach(() => {
	for (const c of clients.splice(0)) c.stop();
	for (const h of handles.splice(0)) h.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function freshDb(name: string): Database.Database {
	const p = join(dir, `${name}.db`);
	migrate(p);
	const { sqlite } = createDb(p);
	handles.push(sqlite);
	return sqlite;
}

// A device whose pulls and cycles are counted.
function device(cloud: FakeCloud, name: string): { c: SyncClient; raw: Database.Database; t: FakeTransport; pulls: () => number; cycles: () => number } {
	const raw = freshDb(name);
	const t = cloud.transport('user-1');
	let pulls = 0;
	const pull = t.sync.pull;
	t.sync.pull = async (input: PullInput) => { pulls++; return pull(input); };
	let cycles = 0;
	const logger: AreaLogger = {
		debug: (msg) => { if (msg === 'sync cycle') cycles++; },
		info: (msg) => { if (msg === 'sync cycle') cycles++; },
		warn: () => { /* not counted */ },
		error: () => { /* not counted */ },
	};
	const c = createSyncClient({ db: raw, transport: t, debounceMs: 1, backoffBaseMs: 5, backoffCapMs: 40, logger });
	clients.push(c);
	return { c, raw, t, pulls: () => pulls, cycles: () => cycles };
}

// Until no cycle runs and none is about to (the 1 ms debounce has passed).
async function settled(c: SyncClient): Promise<void> {
	for (let i = 0; i < 400; i++) {
		await sleep(5);
		if (!c.status().running) {
			await sleep(15);
			if (!c.status().running) return;
		}
	}
	throw new Error('client did not settle');
}

let tagN = 0;
const addTag = (raw: Database.Database): void => { mut.createTag(drizzle(raw, { schema }), { id: `tag-${++tagN}`, name: `Tag ${tagN}` }); };

// The pre-v3 mechanics: no base-metadata or v4 stage adds ops of its own.
function cloud(): FakeCloud {
	const f = new FakeCloud();
	f.features = f.features.filter((x) => x !== 'track_meta' && x !== 'zero_loss_v4');
	return f;
}

describe('Realtime wake filter', () => {
	it('ignores the ping of its own push, wakes for another device and for an unnumbered ping', async () => {
		const f = cloud();
		const a = device(f, 'a');
		const b = device(f, 'b');
		await a.c.syncNow();
		await b.c.syncNow();

		addTag(a.raw);
		await a.c.syncNow();
		expect(readCursor(a.raw).lastSeq).toBe(f.maxSeq);
		const cycles = a.cycles();
		const pulls = a.pulls();

		// The server rings A for A's own push: nothing to fetch.
		a.c.wake('realtime', f.maxSeq);
		a.c.wake('realtime', f.maxSeq - 1);
		await settled(a.c);
		expect(a.cycles()).toBe(cycles);
		expect(a.pulls()).toBe(pulls);

		// B's push rings A with a head above A's cursor: A pulls it.
		addTag(b.raw);
		await b.c.syncNow();
		a.c.wake('realtime', f.maxSeq);
		await settled(a.c);
		expect(a.cycles()).toBe(cycles + 1);
		expect(readCursor(a.raw).lastSeq).toBe(f.maxSeq);
		expect(a.raw.prepare(`SELECT count(*) FROM tag WHERE id = ?`).pluck().get(`tag-${tagN}`)).toBe(1);

		// An older server sends no seq (or something unreadable): always a cycle.
		a.c.wake('realtime');
		await settled(a.c);
		expect(a.cycles()).toBe(cycles + 2);
		a.c.wake('realtime', Number.NaN);
		await settled(a.c);
		expect(a.cycles()).toBe(cycles + 3);

		// Other reasons are never filtered.
		a.c.wake('focus');
		await settled(a.c);
		expect(a.cycles()).toBe(cycles + 4);
	});

	it('drops its own ping that lands mid-cycle, before the push answer', async () => {
		const f = cloud();
		const a = device(f, 'a');
		await a.c.syncNow();
		// The broadcast beats the HTTP answer: the ping (head = this push's
		// ops) reaches the client while the cycle is still pushing.
		const push = a.t.sync.push;
		a.t.sync.push = async (input: PushInput) => {
			const r = await push(input);
			a.c.wake('realtime', r.maxSeq);
			await sleep(10); // the debounce fires while the cycle runs
			return r;
		};
		const cycles = a.cycles();
		addTag(a.raw);
		await a.c.syncNow();
		await settled(a.c);
		expect(a.cycles()).toBe(cycles + 1);
		expect(readCursor(a.raw).lastSeq).toBe(f.maxSeq);
	});

	it('reruns for a mid-cycle ping its pull did not cover', async () => {
		const f = cloud();
		const a = device(f, 'a');
		const b = device(f, 'b');
		await a.c.syncNow();
		await b.c.syncNow();
		// B pushes right after A's pull read the log, and its ping reaches
		// A before A's cycle ends: the head it names is above A's cursor.
		const pull = a.t.sync.pull;
		let inject = true;
		a.t.sync.pull = async (input: PullInput) => {
			const r = await pull(input);
			if (inject) {
				inject = false;
				addTag(b.raw);
				await b.c.syncNow();
				a.c.wake('realtime', f.maxSeq);
				await sleep(10);
			}
			return r;
		};
		const cycles = a.cycles();
		await a.c.syncNow();
		await settled(a.c);
		expect(a.cycles()).toBe(cycles + 2);
		expect(readCursor(a.raw).lastSeq).toBe(f.maxSeq);
		expect(a.raw.prepare(`SELECT count(*) FROM tag WHERE id = ?`).pluck().get(`tag-${tagN}`)).toBe(1);
	});
});
