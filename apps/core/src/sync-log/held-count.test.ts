// The "update Curator" banner counts only held ops this build cannot read.
// Ops held by an older build that this one understands wait for the next
// pull's replay and must not ask the user to update (2026-10-21).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { heldCount, heldNewerCount } from './held.js';

let dir: string | null = null;
afterEach(() => { if (dir) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ } dir = null; } });

describe('heldNewerCount', () => {
	it('counts only ops above the current schema version', () => {
		dir = mkdtempSync(join(tmpdir(), 'curator-held-'));
		const path = join(dir, 'c.db');
		migrate(path);
		const raw = new Database(path);
		const ins = raw.prepare(`INSERT INTO sync_inbox_held (seq, op_id, schema_version, op, held_at) VALUES (?, ?, ?, '{}', 0)`);
		ins.run(1, 'a', 3);
		ins.run(2, 'b', 4);
		ins.run(3, 'c', 5);
		expect(heldCount(raw)).toBe(3);
		expect(heldNewerCount(raw, 4)).toBe(1);
		expect(heldNewerCount(raw, 5)).toBe(0);
		raw.close();
	});
});
