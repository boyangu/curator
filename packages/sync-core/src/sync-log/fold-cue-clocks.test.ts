// The founder's fold states every cue at its row's own clock, origin
// included (initial-push.ts initialPushOps). With a v1 upsert the cue origin
// backfill had to restate each rekordbox cue with a fresh clock, so the base
// said every rekordbox cue was edited at founding time — and a later first
// link let that beat real, older rekordbox edits (e2e run 2026-10-24).
// Migrated temp DB, rows written directly — never real data.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb } from '../db/client.js';
import { foldLibraryAsync } from './initial-push.js';

let dir: string;
let raw: Database.Database;

const CREATED = Date.parse('2026-08-01T10:00:00Z');

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-fold-cues-'));
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	raw = createDb(dbPath).sqlite;
});

afterEach(() => {
	raw.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

describe('founder fold, cues', () => {
	it('keeps each cue\'s own clock and origin, so no backfill restates it', async () => {
		raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, updated_at) VALUES ('t1', 'rec-1', 'One', '[{"name":"A"}]', 'unsorted', ?)`).run(CREATED);
		raw.prepare(`INSERT INTO cue (id, track_id, slot, position_sec, kind, origin, created_at) VALUES ('c0', 't1', 0, 10, 'hot', 'rekordbox', ?)`).run(CREATED);
		raw.prepare(`INSERT INTO cue (id, track_id, slot, position_sec, kind, origin, created_at) VALUES ('c1', 't1', 1, 20, 'hot', 'curator', ?)`).run(CREATED + 1000);
		await foldLibraryAsync(raw);
		const records = (raw.prepare(`SELECT value FROM sync_state WHERE map = 'cues' ORDER BY key`).pluck().all() as string[])
			.map((v) => JSON.parse(v) as { slot: number; cell: { value: { origin?: string }; clock: { ts: number } } });
		expect(records.map((r) => [r.slot, r.cell.value.origin, r.cell.clock.ts])).toEqual([
			[0, 'rekordbox', CREATED],
			[1, 'curator', CREATED + 1000],
		]);
	});
});
