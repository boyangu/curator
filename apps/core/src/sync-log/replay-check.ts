// The phase-0 exit check (cloud design "Rollout", phase 0; plan B5 task 3),
// as a function so it is tested on a generated library and run by
// scripts/replay-check.ts against a copy of a real one:
//
//   1. `VACUUM INTO` a copy from a READ-ONLY handle of `sourcePath` — the
//      source file is never opened writable, never migrated, never touched;
//   2. migrate the copy and run the initial push (initial-push.ts) into the
//      COPY's outbox;
//   3. build an empty migrated replica holding only the copy's track rows
//      (tracks are catalogue/scanner-side) and the artist junction every
//      write of them derives, apply the outbox onto it in pull-sized
//      batches, then drain the artist credit re-derivation the sync client
//      would run between pages;
//   4. report per-table equality of the copy, the replica and the protocol
//      reducer's materialised view of the same ops.
//
// Everything is written under `workDir`.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyOps as reduceOps, createLibraryState, materialize, MAX_PULL_OPS } from '@curator/protocol';
import { migrate } from '../db/migrate.js';
import { drainArtistCreditRewrites } from '../library/artist-alias.js';
import { syncTrackArtistsByIdRaw } from '../library/artists.js';
import { applyOps } from './apply.js';
import { compareDumps, dumpLibrary, dumpView, type TableReport } from './dump.js';
import { initialPush, type InitialPushResult } from './initial-push.js';
import { readOutbox } from './outbox.js';

export type ReplayCheckReport = {
	copyPath: string;
	replicaPath: string;
	push: InitialPushResult;
	opsInOutbox: number;
	applyMs: number;
	replicaVsCopy: TableReport[];
	reducerVsReplica: TableReport[];
	equal: boolean;
};

export function runReplayCheck(sourcePath: string, workDir: string, opts: { batch?: number } = {}): ReplayCheckReport {
	const src = resolve(sourcePath);
	if (!existsSync(src)) throw new Error(`no such database: ${src}`);
	mkdirSync(workDir, { recursive: true });
	const copyPath = join(resolve(workDir), 'copy.db');
	const replicaPath = join(resolve(workDir), 'replica.db');
	for (const p of [copyPath, replicaPath]) if (existsSync(p)) throw new Error(`refusing to overwrite ${p}; use an empty work dir`);
	if (resolve(copyPath) === src || resolve(replicaPath) === src) throw new Error('work dir must not hold the source database');

	// 1. Read-only snapshot. VACUUM INTO is consistent under WAL and needs no
	// write access to the source.
	const ro = new Database(src, { readonly: true, fileMustExist: true });
	try {
		ro.exec(`VACUUM INTO '${copyPath.replace(/'/g, "''").replace(/\\/g, '/')}'`);
	} finally {
		ro.close();
	}

	// 2. The copy, brought to this build's schema, pushes its rows.
	migrate(copyPath);
	const copy = new Database(copyPath);
	copy.pragma('foreign_keys = ON');
	try {
		const push = initialPush(copy);
		const ops = readOutbox(copy);

		// 3. Replica: same track rows, nothing else.
		migrate(replicaPath);
		const replica = new Database(replicaPath);
		replica.pragma('foreign_keys = ON');
		try {
			const cols = (replica.prepare(`SELECT name FROM pragma_table_info('track')`).all() as Array<{ name: string }>).map((c) => c.name);
			replica.exec(`ATTACH DATABASE '${copyPath.replace(/'/g, "''").replace(/\\/g, '/')}' AS src`);
			replica.exec(`INSERT INTO main.track (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM src.track`);
			replica.exec(`DETACH DATABASE src`);
			// A device's live catalogue rows never exist without their junction
			// (artists.ts: every write runs the seam, and migrate heals a row
			// that bypassed it); rows inserted after migrate need it here.
			replica.transaction(() => { syncTrackArtistsByIdRaw(replica, replica.prepare(`SELECT id FROM track WHERE deleted_at IS NULL`).pluck().all() as string[]); })();

			const batch = opts.batch ?? MAX_PULL_OPS;
			const started = Date.now();
			for (let i = 0; i < ops.length; i += batch) applyOps(replica, ops.slice(i, i + batch));
			drainArtistCreditRewrites(replica);
			const applyMs = Date.now() - started;

			// 4. Compare.
			const copyDump = dumpLibrary(copy);
			const replicaDump = dumpLibrary(replica);
			const replicaVsCopy = compareDumps(copyDump, replicaDump);
			const view = dumpView(materialize(reduceOps(createLibraryState(), ops).state));
			// The reducer only knows tags an op mentioned; migrate seeds the
			// system tags on every device.
			const reducerVsReplica = compareDumps(view, { ...replicaDump, tags: replicaDump.tags.filter((t) => t.kind !== 'system' || view.tags.some((v) => v.id === t.id)) });
			return {
				copyPath,
				replicaPath,
				push,
				opsInOutbox: ops.length,
				applyMs,
				replicaVsCopy,
				reducerVsReplica,
				equal: replicaVsCopy.every((r) => r.equal) && reducerVsReplica.every((r) => r.equal),
			};
		} finally {
			replica.close();
		}
	} finally {
		copy.close();
	}
}
