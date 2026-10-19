// The one-shot outbox clean-up in migrate(): play-history restatements left
// by pre-fix rekordbox syncs collapse to one op per run of identical copies,
// keeping the LATEST copy (its clock is the one the reducer records hold),
// and only on a library that never synced. Synthetic rows on a temp DB.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrate.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-outbox-dedupe-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
});
afterEach(() => {
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

type Row = { op: string; entity: string; id: string; kind: string; payload: unknown; state?: string };

// Rows in seq order; the gate is cleared so the next migrate() runs the pass.
function seed(rows: Row[], setup?: (s: Database.Database) => void): void {
	const s = new Database(dbPath);
	const ins = s.prepare(`INSERT INTO sync_outbox (op_id, seq_local, device_id, client_ts, schema_version, entity, entity_id, kind, payload, state, created_at)
		VALUES (?, ?, 'dev', ?, 1, ?, ?, ?, ?, ?, 0)`);
	rows.forEach((r, i) => ins.run(r.op, i + 1, 1000 + i, r.entity, r.id, r.kind, JSON.stringify(r.payload), r.state ?? 'pending'));
	s.prepare(`DELETE FROM app_setting WHERE key = 'outbox_dedupe_version'`).run();
	setup?.(s);
	s.close();
}

function remaining(): string[] {
	const s = new Database(dbPath, { readonly: true });
	try {
		return (s.prepare(`SELECT op_id FROM sync_outbox ORDER BY seq_local`).pluck().all() as string[]);
	} finally {
		s.close();
	}
}

const P = { session_id: 's1', track_no: 1 };
const Q = { session_id: 's1', track_no: 2 };
const S = { name: 'HISTORY 2026-08-14', started_at: 1 };

const restated: Row[] = [
	{ op: 'e1a', entity: 'play_event', id: 'e1', kind: 'append', payload: P },
	{ op: 'e2a', entity: 'play_event', id: 'e2', kind: 'append', payload: P },
	{ op: 's1a', entity: 'play_session', id: 's1', kind: 'append', payload: S },
	{ op: 'e1b', entity: 'play_event', id: 'e1', kind: 'append', payload: P },
	{ op: 'e2b', entity: 'play_event', id: 'e2', kind: 'append', payload: Q }, // a real change …
	{ op: 's1b', entity: 'play_session', id: 's1', kind: 'append', payload: S },
	{ op: 'e1c', entity: 'play_event', id: 'e1', kind: 'append', payload: P },
	{ op: 'e2c', entity: 'play_event', id: 'e2', kind: 'append', payload: P }, // … and back: both stand
	{ op: 'tga', entity: 'tag', id: 't1', kind: 'create', payload: { name: 'x', kind: 'user' } },
	{ op: 'tgb', entity: 'tag', id: 't1', kind: 'create', payload: { name: 'x', kind: 'user' } }, // not a restated entity
];

describe('outbox restatement dedupe (migrate)', () => {
	it('collapses consecutive identical copies per entity, keeping the latest, and backs up first', () => {
		seed(restated);
		migrate(dbPath);
		expect(remaining()).toEqual(['e2a', 'e2b', 's1b', 'e1c', 'e2c', 'tga', 'tgb']);
		expect(readdirSync(dir).some((f) => f.includes('.pre-outbox-dedupe-') && f.endsWith('.bak'))).toBe(true);
		// Gated: a second boot does not run it again.
		seed([{ op: 'x1', entity: 'play_event', id: 'e9', kind: 'append', payload: P }, { op: 'x2', entity: 'play_event', id: 'e9', kind: 'append', payload: P }],
			(s) => s.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES ('outbox_dedupe_version', '1', 0)`).run());
		migrate(dbPath);
		expect(remaining()).toContain('x1');
	});

	it('leaves a library bound to an account alone', () => {
		seed(restated, (s) => s.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES ('sync.client', ?, 0)`).run(JSON.stringify({ userId: 'u1', registeredFor: 'u1' })));
		migrate(dbPath);
		expect(remaining()).toHaveLength(restated.length);
	});

	it('leaves a library that has pushed or pulled alone', () => {
		seed([...restated.slice(0, 1).map((r) => ({ ...r, op: 'acked', state: 'acked' })), ...restated]);
		migrate(dbPath);
		expect(remaining()).toHaveLength(restated.length + 1);

		rmSync(dbPath, { force: true });
		migrate(dbPath);
		seed(restated, (s) => s.prepare(`INSERT INTO sync_cursor (key, last_seq) VALUES ('library', 12)`).run());
		migrate(dbPath);
		expect(remaining()).toHaveLength(restated.length);
	});

	it('writes no backup when there is nothing to remove', () => {
		seed(restated.filter((r) => r.entity === 'tag'));
		migrate(dbPath);
		expect(readdirSync(dir).some((f) => f.includes('.pre-outbox-dedupe-'))).toBe(false);
	});
});
