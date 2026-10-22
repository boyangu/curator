// SyncStateStore's lazy merge records: a store that never applies a
// recording op never reads them (nor writes them back), and one that does
// sees all of them, so the reducer's alias rebuild keeps every alias.
//
// Generated DBs only (CLAUDE.md): mkdtempSync + migrate(), synthetic records.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { applyOp, opSchemaVersion, type Op } from '@curator/protocol';
import { migrate } from '../db/migrate.js';
import { createDb } from '../db/client.js';
import { SyncStateStore } from './store.js';

let dir: string;
let raw: Database.Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-sync-store-'));
	const p = join(dir, 'lib.db');
	migrate(p);
	raw = createDb(p).sqlite;
	// rec-2 was merged into rec-1 (ts 100); the alias table is its projection.
	raw.prepare(`INSERT INTO sync_state (map, key, recording_id, parent_id, value) VALUES ('merges', 'rec-2', NULL, NULL, ?)`)
		.run(JSON.stringify({ winner: 'rec-1', clock: { ts: 100, device: 'dev-b', op: 'op-m1' } }));
	raw.prepare(`INSERT INTO recording_alias (loser, winner) VALUES ('rec-2', 'rec-1')`).run();
});
afterEach(() => {
	raw.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

const op = (o: Omit<Op, 'device_id' | 'schema_version'> & { device_id?: string }): Op =>
	({ device_id: 'dev-a', schema_version: opSchemaVersion(o as Op), ...o }) as Op;

const mergesLoaded = (s: SyncStateStore): boolean => (s as unknown as { mergesLoaded: boolean }).mergesLoaded;
const mergeRows = (): number => raw.prepare(`SELECT count(*) FROM sync_state WHERE map = 'merges'`).pluck().get() as number;

describe('SyncStateStore merges', () => {
	it('are not read by a store that applies no recording op', () => {
		raw.transaction(() => {
			const store = new SyncStateStore(raw);
			const tag = op({ op_id: 'op-t1', client_ts: 200, entity: 'tag', entity_id: 'tag-1', kind: 'create', payload: { name: 'Warm', kind: 'user' } } as never);
			store.prefetch([tag]);
			store.touch(tag);
			applyOp(store.state, tag);
			store.flush();
			expect(mergesLoaded(store)).toBe(false);
			// The alias map is loaded regardless: every op resolves through it.
			expect(store.state.recordingAlias.get('rec-2')).toBe('rec-1');
		})();
		expect(mergeRows()).toBe(1);
		expect(raw.prepare(`SELECT winner FROM recording_alias WHERE loser = 'rec-2'`).pluck().get()).toBe('rec-1');
	});

	it('load whole on a recording op, so the alias rebuild keeps every alias', () => {
		raw.prepare(`INSERT INTO sync_state (map, key, recording_id, parent_id, value) VALUES ('merges', 'rec-3', NULL, NULL, ?)`)
			.run(JSON.stringify({ winner: 'rec-4', clock: { ts: 90, device: 'dev-b', op: 'op-m2' } }));
		raw.prepare(`INSERT INTO recording_alias (loser, winner) VALUES ('rec-3', 'rec-4')`).run();
		raw.transaction(() => {
			const store = new SyncStateStore(raw);
			// An older merge the other way round (rec-1 into rec-2) closes a
			// cycle, so the reducer rebuilds the aliases from every merge
			// record and skips it. Over a short map the rebuild would keep only
			// this one and drop rec-2's and rec-3's aliases.
			const merge = op({ op_id: 'op-m0', client_ts: 50, device_id: 'dev-c', entity: 'recording', entity_id: 'rec-1', kind: 'merge', payload: { winner: 'rec-2' } } as never);
			store.prefetch([merge]);
			store.touch(merge);
			applyOp(store.state, merge);
			expect(mergesLoaded(store)).toBe(true);
			expect(store.state.merges.size).toBe(3);
			store.flush();
		})();
		expect(mergeRows()).toBe(3);
		expect(raw.prepare(`SELECT loser, winner FROM recording_alias ORDER BY loser`).all()).toEqual([
			{ loser: 'rec-2', winner: 'rec-1' },
			{ loser: 'rec-3', winner: 'rec-4' },
		]);
	});

	it('are re-stamped with the rest when a clamped recording op comes back', () => {
		raw.transaction(() => {
			const store = new SyncStateStore(raw);
			const merge = op({ op_id: 'op-m1', client_ts: 100, device_id: 'dev-b', entity: 'recording', entity_id: 'rec-2', kind: 'merge', payload: { winner: 'rec-1' } } as never);
			store.touch(merge);
			store.restampClock('op-m1', 'dev-b', 90);
			expect(store.state.merges.get('rec-2')!.clock.ts).toBe(90);
			store.flush();
		})();
		const v = JSON.parse(raw.prepare(`SELECT value FROM sync_state WHERE map = 'merges' AND key = 'rec-2'`).pluck().get() as string) as { clock: { ts: number } };
		expect(v.clock.ts).toBe(90);
	});
});
