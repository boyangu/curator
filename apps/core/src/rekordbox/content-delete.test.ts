// Coverage for propagating Curator-side deletes to rekordbox's Collection.
// A track deleted from Curator that had a rekordbox_link leaves a
// rekordbox_deleted_content tombstone (pushed_at NULL). Every Sync to
// Rekordbox must:
//   (a) emit a content_delete op for each unpushed tombstone, regardless of
//       the sync target (the delete intent already happened; the sync is just
//       transport),
//   (b) stamp pushed_at on a verified push so the delete isn't re-emitted,
//   (c) leave pushed_at NULL when verify fails so a later sync retries,
//   (d) never re-emit an already-settled tombstone (the grandfathered rows).
// Runs the REAL exporter against a migrated temp DB with a stub sidecar.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { RekordboxExporter } from './exporter.js';
import type { RekordboxSidecar, WriteOp, WriteOpResult } from './sidecar.js';

let dir: string;
let dbPath: string;
let db: Db;
let sqlite: Database.Database;

function seedLinkedTrack(id: string, rbContentId: string): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES (?, ?, '[]', 'unsorted')`).run(id, id);
	sqlite.prepare(
		`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at) VALUES (?, ?, 0, 0, 0)`,
	).run(id, rbContentId);
}

function tombstone(rbContentId: string, pushedAt: number | null): void {
	sqlite.prepare(
		`INSERT INTO rekordbox_deleted_content (rb_content_id, deleted_at, pushed_at) VALUES (?, 100, ?)`,
	).run(rbContentId, pushedAt);
}

function pushedAtOf(rbContentId: string): number | null {
	const row = sqlite.prepare(`SELECT pushed_at AS p FROM rekordbox_deleted_content WHERE rb_content_id = ?`).get(rbContentId) as { p: number | null } | undefined;
	return row ? row.p : undefined as never;
}

// Stub sidecar. `missingContent` = rb rows already hard-gone (writer reports
// missing). `verifyOk` gates the verify result. Records the ops handed to
// applyWriteBatch so content_delete emission is assertable.
function stubSidecar(opts: { missingContent?: Set<string>; verifyOk?: boolean } = {}): { sidecar: RekordboxSidecar; applied: WriteOp[][] } {
	const missing = opts.missingContent ?? new Set<string>();
	const verifyOk = opts.verifyOk ?? true;
	const applied: WriteOp[][] = [];
	const sidecar = {
		backup: async () => ({ path: 'backup/master.backup.db', sizeBytes: 1, takenAtMs: 1 }),
		openForWrite: async () => ({ ok: true, path: dbPath }),
		applyWriteBatch: async (ops: WriteOp[]) => {
			applied.push(ops);
			return {
				results: ops.map((op): WriteOpResult => {
					if (op.kind === 'content_delete') {
						if (missing.has(op.rb_content_id)) {
							return { kind: op.kind, changed: false, skipped: true, missing: true, rb_content_id: op.rb_content_id };
						}
						return { kind: op.kind, changed: true, rb_content_id: op.rb_content_id };
					}
					return { kind: op.kind, changed: true };
				}),
			};
		},
		commitAndClose: async (writtenIds: string[]) => ({
			baselines: Object.fromEntries(writtenIds.map((id) => [id, 1_700_000_000_000])),
		}),
		verify: async () => ({ ok: verifyOk, pragma_error: verifyOk ? null : 'quick_check failed', failures: [] }),
	} as unknown as RekordboxSidecar;
	return { sidecar, applied };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-cdel-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('export: content_delete tombstone propagation', () => {
	it('emits content_delete for unpushed tombstones and stamps pushed_at on verify', async () => {
		// A live linked track drives the push; the tombstone rides along even
		// though it belongs to no target.
		seedLinkedTrack('t1', 'C1');
		tombstone('DEAD1', null);
		const { sidecar, applied } = stubSidecar();
		const exporter = new RekordboxExporter(db, sidecar);

		const result = await exporter.runExport({
			targetKind: 'tracks',
			targetIds: ['t1'],
			flags: { syncMetadata: true, syncCues: false, syncTags: false, syncPlaylist: false },
			dbPath,
		} as never);

		const ops = applied[0]!;
		const del = ops.filter((o): o is Extract<WriteOp, { kind: 'content_delete' }> => o.kind === 'content_delete');
		expect(del.map((o) => o.rb_content_id)).toEqual(['DEAD1']);
		expect(result.contentDeleted).toBe(1);
		// Settled → not re-emitted next time.
		expect(pushedAtOf('DEAD1')).not.toBeNull();
	});

	it('rides ANY push — even a pure-tombstone sync with no linked target changes', async () => {
		// No metadata op will be generated (target is a linked track but flags
		// off); the tombstone alone must still open a write session.
		seedLinkedTrack('t1', 'C1');
		tombstone('DEAD1', null);
		const { sidecar, applied } = stubSidecar();
		const exporter = new RekordboxExporter(db, sidecar);

		const result = await exporter.runExport({
			targetKind: 'tracks',
			targetIds: ['t1'],
			flags: { syncMetadata: false, syncCues: false, syncTags: false, syncPlaylist: false },
			dbPath,
		} as never);

		expect(applied).toHaveLength(1);
		expect(result.contentDeleted).toBe(1);
	});

	it('settles an already-gone rb row (missing) without counting it as a fresh delete', async () => {
		seedLinkedTrack('t1', 'C1');
		tombstone('GONE', null);
		const { sidecar } = stubSidecar({ missingContent: new Set(['GONE']) });
		const exporter = new RekordboxExporter(db, sidecar);

		const result = await exporter.runExport({
			targetKind: 'tracks',
			targetIds: ['t1'],
			flags: { syncMetadata: true, syncCues: false, syncTags: false, syncPlaylist: false },
			dbPath,
		} as never);

		// Already gone → not a fresh delete, but still settled so it stops re-emitting.
		expect(result.contentDeleted).toBe(0);
		expect(pushedAtOf('GONE')).not.toBeNull();
	});

	it('leaves pushed_at NULL when verify fails, so a later sync retries', async () => {
		seedLinkedTrack('t1', 'C1');
		tombstone('DEAD1', null);
		const { sidecar } = stubSidecar({ verifyOk: false });
		const exporter = new RekordboxExporter(db, sidecar);

		await exporter.runExport({
			targetKind: 'tracks',
			targetIds: ['t1'],
			flags: { syncMetadata: true, syncCues: false, syncTags: false, syncPlaylist: false },
			dbPath,
		} as never);

		expect(pushedAtOf('DEAD1')).toBeNull();
	});

	it('never re-emits a settled tombstone', async () => {
		seedLinkedTrack('t1', 'C1');
		tombstone('OLD', 50); // grandfathered / already pushed
		const { sidecar, applied } = stubSidecar();
		const exporter = new RekordboxExporter(db, sidecar);

		await exporter.runExport({
			targetKind: 'tracks',
			targetIds: ['t1'],
			flags: { syncMetadata: true, syncCues: false, syncTags: false, syncPlaylist: false },
			dbPath,
		} as never);

		const ops = applied[0] ?? [];
		expect(ops.some((o) => o.kind === 'content_delete')).toBe(false);
	});
});
