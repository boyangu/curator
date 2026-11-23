// The snapshot builder on a generated database (mkdtempSync + migrate()):
// the JSON is serializeLibraryState of the state the rows describe even
// where SQLite's key order is not the protocol's, the parts are cut at the
// size asked and address their own bytes, and the Storage reader joins them
// back and refuses anything that does not match the manifest.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { createLibraryState, rebuildArtistAlias, serializeLibraryState, snapshotPartPath, type LibraryState } from '@curator/protocol';
import { migrate } from '../db/migrate.js';
import { RECORDS_COMPLETE_KEY } from './apply.js';
import { buildSnapshotParts, type SnapshotBuildOk } from './snapshot-build.js';
import { readStorageSnapshotBody } from './snapshot-storage.js';

let dir: string;
let dbPath: string;
let db: Database.Database;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-snapbuild-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	db = new Database(dbPath);
	db.pragma('journal_mode = WAL');
	db.prepare(`INSERT OR REPLACE INTO app_setting (key, value, updated_at) VALUES (?, '1', 0)`).run(RECORDS_COMPLETE_KEY);
	db.prepare(`INSERT OR REPLACE INTO sync_cursor (key, last_seq) VALUES ('library', 42)`).run();
});
afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

const clock = (ts: number, op = `op-${ts}`) => ({ ts, device: 'dev-a', op });

// Rows straight into the reducer tables, and the LibraryState they stand for.
function seed(): LibraryState {
	const state = createLibraryState();
	const put = db.prepare(`INSERT INTO sync_state (map, key, recording_id, parent_id, value) VALUES (?, ?, NULL, NULL, ?)`);
	// Keys whose UTF-8 byte order (SQLite's) differs from code-unit order.
	for (const [i, key] of ['', '😀', 'a', '�', '𝄞x', 'b'].entries()) {
		const v = { value: { zeta: i, alpha: [3, 1, { y: 1, x: 2 }], name: `n${key}` }, clock: clock(i + 1) };
		put.run('settings', key, JSON.stringify(v));
		state.settings.set(key, v as never);
	}
	const tag = { id: 't1', created: clock(10), fields: { name: { value: 'Wärm', clock: clock(11) } } };
	put.run('tags', 't1', JSON.stringify(tag));
	state.tags.set('t1', tag as never);
	for (const [key, rule] of [['old', { from: 'Old', to: 'New', to_key: 'new' }], ['new', { from: 'New', to: 'Newest', to_key: 'newest' }]] as const) {
		const cell = { value: rule, clock: clock(20 + key.length) };
		put.run('artistAliases', key, JSON.stringify(cell));
		state.artistAliases.set(key, cell);
	}
	rebuildArtistAlias(state);
	const tomb = db.prepare(`INSERT INTO tombstone (entity, entity_id, client_ts, device_id, op_id, recording_id) VALUES (?, ?, ?, ?, ?, NULL)`);
	tomb.run('playlist_track', 'row-1', 30, 'dev-a', 'op-30');
	tomb.run('playlist', 'p1', 31, 'dev-b', 'op-31');
	tomb.run('cue', 'rec-1:0:hot', 32, 'dev-a', 'op-32');
	state.tombstones.set('playlist_track:row-1', clock(30));
	state.tombstones.set('playlist:p1', { ts: 31, device: 'dev-b', op: 'op-31' });
	state.tombstones.set('cue:rec-1:0:hot', clock(32));
	db.prepare(`INSERT INTO recording_alias (loser, winner) VALUES ('rec-z', 'rec-a'), ('rec-b', 'rec-a')`).run();
	state.recordingAlias.set('rec-z', 'rec-a');
	state.recordingAlias.set('rec-b', 'rec-a');
	return state;
}

const joined = (b: SnapshotBuildOk): Buffer => Buffer.concat(b.files.map((f) => readFileSync(f)));
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function build(partMaxBytes?: number): Promise<SnapshotBuildOk> {
	const r = await buildSnapshotParts({ dbPath, outDir: mkdtempSync(join(dir, 'out-')), userId: 'USER-1', ...(partMaxBytes ? { partMaxBytes } : {}) });
	if (!r.ok) throw new Error(`skipped: ${r.skipped}`);
	return r;
}

describe('buildSnapshotParts', () => {
	it('writes serializeLibraryState of the records, in the protocol\'s key order', async () => {
		const state = seed();
		const r = await build();
		const json = gunzipSync(joined(r)).toString('utf8');
		expect(json).toBe(serializeLibraryState(state));
		expect(r.manifest.stateSha256).toBe(sha(Buffer.from(json, 'utf8')));
		expect(r.jsonBytes).toBe(Buffer.byteLength(json));
		expect(r.snapshotSeq).toBe(42);
		expect(json.indexOf('😀')).toBeLessThan(json.indexOf(''));
	});

	it('cuts the gzip body into parts no larger than asked, each named by its sha256', async () => {
		seed();
		const r = await build(64);
		expect(r.manifest.parts.length).toBeGreaterThan(3);
		const body = joined(r);
		expect(body.length).toBe(r.manifest.totalBytes);
		expect(sha(body)).toBe(r.manifest.sha256);
		r.manifest.parts.forEach((p, i) => {
			const bytes = readFileSync(r.files[i]!);
			expect(p.bytes).toBe(bytes.length);
			expect(p.bytes).toBeLessThanOrEqual(64);
			expect(p.sha256).toBe(sha(bytes));
			expect(p.path).toBe(snapshotPartPath('user-1', p.sha256));
		});
		// Every part but the last is full.
		expect(r.manifest.parts.slice(0, -1).every((p) => p.bytes === 64)).toBe(true);
	});

	it('reads one instant: a write after the build began is not in it', async () => {
		seed();
		const r = await build();
		db.prepare(`UPDATE sync_cursor SET last_seq = 43`).run();
		db.prepare(`INSERT INTO sync_state (map, key, value) VALUES ('tags', 't2', '{}')`).run();
		expect(r.snapshotSeq).toBe(42);
		expect(gunzipSync(joined(r)).toString('utf8')).not.toContain('"t2"');
	});

	it('skips when the records are not the fold through the cursor', async () => {
		seed();
		const out = mkdtempSync(join(dir, 'skip-'));
		const skip = () => buildSnapshotParts({ dbPath, outDir: out, userId: 'u' });
		db.prepare(`INSERT OR REPLACE INTO app_setting (key, value, updated_at) VALUES ('sync.client', ?, 0)`).run(JSON.stringify({ ownThroughSeq: 50 }));
		expect(await skip()).toEqual({ ok: false, skipped: 'own_ops_ahead', count: 8 });
		db.prepare(`UPDATE app_setting SET value = ? WHERE key = 'sync.client'`).run(JSON.stringify({ needsRepair: true }));
		expect(await skip()).toEqual({ ok: false, skipped: 'needs_repair' });
		db.prepare(`DELETE FROM app_setting WHERE key = ?`).run(RECORDS_COMPLETE_KEY);
		expect(await skip()).toEqual({ ok: false, skipped: 'records_incomplete' });
	});
});

describe('readStorageSnapshotBody', () => {
	it('joins the parts back and refuses a short, swapped or corrupt one', async () => {
		seed();
		const r = await build(64);
		const objects = new Map(r.manifest.parts.map((p, i) => [p.path, new Uint8Array(readFileSync(r.files[i]!))]));
		const get = async (path: string) => objects.get(path)!;
		const body = await readStorageSnapshotBody(r.manifest, get, { maxBytes: 1 << 20, concurrency: 3 });
		expect(body.equals(joined(r))).toBe(true);
		await expect(readStorageSnapshotBody(r.manifest, get, { maxBytes: 10 })).rejects.toThrow(/past the cap/);
		const swapped = { ...r.manifest, parts: [r.manifest.parts[1]!, r.manifest.parts[0]!, ...r.manifest.parts.slice(2)] };
		await expect(readStorageSnapshotBody(swapped, get, { maxBytes: 1 << 20 })).rejects.toThrow(/body does not match/);
		const first = r.manifest.parts[0]!.path;
		const bad = new Uint8Array(objects.get(first)!);
		bad[0] = bad[0]! ^ 1;
		await expect(readStorageSnapshotBody(r.manifest, async (p) => (p === first ? bad : objects.get(p)!), { maxBytes: 1 << 20 })).rejects.toThrow(/part 0 does not match/);
		await expect(readStorageSnapshotBody({ ...r.manifest, totalBytes: r.manifest.totalBytes + 1 }, get, { maxBytes: 1 << 20 })).rejects.toThrow(/add up/);
	});
});
