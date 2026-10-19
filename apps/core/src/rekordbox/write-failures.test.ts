// Coverage for the per-op write-failure surface (the lone-surrogate incident
// class): when the Python writer reports `error` on an op, the exporter must
// (a) surface it in ExportResult.writeFailures with curator-side attribution,
// (b) keep the failed op OUT of the verify pass, and (c) NOT advance the
// failed track's rekordboxLink baseline — while the rest of the batch
// verifies and advances normally. Runs the REAL exporter against a migrated
// temp DB with a stub sidecar (no Python).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { RekordboxExporter, type ExportResult, type RekordboxExportEvent } from './exporter.js';
import type { RekordboxSidecar, WriteOp, WriteOpResult } from './sidecar.js';

let dir: string;
let dbPath: string;
let db: Db;
let sqlite: Database.Database;

function seedTrack(id: string, title: string, rbContentId: string): void {
	sqlite.prepare(
		`INSERT INTO track (id, title, artists, state) VALUES (?, ?, '[]', 'unsorted')`,
	).run(id, title);
	sqlite.prepare(
		`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at)
		 VALUES (?, ?, 0, 0, 0)`,
	).run(id, rbContentId);
}

// Stub sidecar: succeeds everything except ops whose rb_content_id is in
// `failIds` (those return the writer's per-op error shape). Captures the
// ops handed to verify so the exclusion is assertable.
function stubSidecar(failIds: Set<string>): { sidecar: RekordboxSidecar; verified: WriteOp[][] } {
	const verified: WriteOp[][] = [];
	const sidecar = {
		backup: async () => ({ path: 'backup/master.backup.db', sizeBytes: 1, takenAtMs: 1 }),
		openForWrite: async () => ({ ok: true, path: dbPath }),
		applyWriteBatch: async (ops: WriteOp[]) => ({
			results: ops.map((op): WriteOpResult => {
				const target = op.kind === 'playlist_merge' || op.kind === 'playlist_rename'
					? op.rb_playlist_id : op.rb_content_id;
				if (failIds.has(target)) {
					return { kind: op.kind, error: "UnicodeEncodeError: 'utf-8' codec can't encode character '\\udc90'", skipped: true, rb_content_id: target };
				}
				return { kind: op.kind, changed: true };
			}),
		}),
		commitAndClose: async (writtenIds: string[]) => ({
			baselines: Object.fromEntries(writtenIds.map((id) => [id, 1_700_000_000_000])),
		}),
		verify: async (_db: string, _key: string | undefined, expectedWrites: WriteOp[]) => {
			verified.push(expectedWrites);
			return { ok: true, pragma_error: null, failures: [] };
		},
	} as unknown as RekordboxSidecar;
	return { sidecar, verified };
}

function baselineOf(trackId: string): number | null {
	const row = sqlite.prepare(`SELECT rb_updated_at_seen AS seen FROM rekordbox_link WHERE track_id = ?`).get(trackId) as { seen: number | null };
	return row.seen;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-wfail-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('export: per-op write failures', () => {
	it('surfaces failures with attribution, excludes them from verify, and freezes their baselines', async () => {
		seedTrack('t-ok', 'Clean Track', 'C1');
		// NB: the title is clean on purpose — a lone surrogate seeded through
		// better-sqlite3 does not round-trip (SQLite stores CESU-8 bytes that
		// read back as U+FFFD×3), which is itself evidence the production
		// surrogate was born in flight, not in curator.db. The failure here is
		// triggered by the stub's failIds, mirroring the writer's report.
		seedTrack('t-bad', 'Broken Track', 'C2');
		const { sidecar, verified } = stubSidecar(new Set(['C2']));
		const audits: Record<string, unknown>[] = [];
		const exporter = new RekordboxExporter(db, sidecar, (e) => audits.push(e));

		const events: RekordboxExportEvent[] = [];
		exporter.on('event', (e: RekordboxExportEvent) => events.push(e));

		const result: ExportResult = await exporter.runExport({
			targetKind: 'tracks',
			targetIds: ['t-ok', 't-bad'],
			flags: { syncMetadata: true, syncCues: false, syncTags: false, syncPlaylist: false },
			dbPath,
		} as never);

		// (a) attribution: the failure names the curator-side title.
		expect(result.writeFailures).toHaveLength(1);
		expect(result.writeFailures[0]).toMatchObject({
			kind: 'track',
			target: 'C2',
			targetLabel: 'Broken Track',
		});
		expect(result.writeFailures[0]!.error).toContain('UnicodeEncodeError');

		// (b) the failed op never reaches verify; the clean one does.
		expect(verified).toHaveLength(1);
		const verifiedTargets = verified[0]!.map((op) => op.kind === 'track' ? op.rb_content_id : '');
		expect(verifiedTargets).toContain('C1');
		expect(verifiedTargets).not.toContain('C2');

		// (c) baselines: clean track advanced, failed track frozen so the
		// next "Sync updates" still picks it up.
		expect(baselineOf('t-ok')).toBe(1_700_000_000_000);
		expect(baselineOf('t-bad')).toBeNull();

		// Sync still completes (verifyOk) — one bad op no longer kills the run.
		expect(result.verifyOk).toBe(true);
		const completed = events.find((e): e is Extract<RekordboxExportEvent, { kind: 'completed' }> => e.kind === 'completed');
		expect(completed?.result.writeFailures).toHaveLength(1);

		// The failure also lands in the write-audit trail.
		expect(audits.some((a) => a['kind'] === 'rekordbox-write-batch-failures')).toBe(true);
	});

	it('reports empty writeFailures on an all-clean batch', async () => {
		seedTrack('t1', 'Fine', 'C9');
		const { sidecar } = stubSidecar(new Set());
		const exporter = new RekordboxExporter(db, sidecar);
		const result = await exporter.runExport({
			targetKind: 'tracks',
			targetIds: ['t1'],
			flags: { syncMetadata: true, syncCues: false, syncTags: false, syncPlaylist: false },
			dbPath,
		} as never);
		expect(result.writeFailures).toEqual([]);
		expect(baselineOf('t1')).toBe(1_700_000_000_000);
	});
});
