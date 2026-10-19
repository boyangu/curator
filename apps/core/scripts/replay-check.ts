// Phase-0 exit check over a real library (cloud plan B5 task 3): snapshot
// the database at <db-path> through a READ-ONLY handle (VACUUM INTO), run the
// initial push into the copy's outbox, replay it onto an empty replica that
// holds the same track rows, and print per-table equality — copy vs replica,
// and the protocol reducer's view vs replica.
//
// The source file is opened read-only and is never migrated or written; all
// output lands in <work-dir> (default: a fresh temp dir). There is no default
// database path on purpose: point it at a COPY of the live library.
//
//   npx tsx scripts/replay-check.ts <db-path> [--work <dir>] [--json]
//
// Needs the Node ABI of better-sqlite3 (`pnpm rebuild:node`).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReplayCheck } from '../src/sync-log/replay-check.js';

const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--work');
if (!dbPath) {
	console.error('usage: npx tsx scripts/replay-check.ts <db-path> [--work <dir>] [--json]');
	process.exit(2);
}
const workIdx = args.indexOf('--work');
const workDir = workIdx >= 0 ? args[workIdx + 1]! : mkdtempSync(join(tmpdir(), 'curator-replay-check-'));

const report = runReplayCheck(dbPath, workDir);

if (args.includes('--json')) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log(`copy:     ${report.copyPath}`);
	console.log(`replica:  ${report.replicaPath}`);
	console.log(`initial push: ${report.push.ops} ops in ${report.push.ms} ms ${JSON.stringify(report.push.byEntity)}`);
	console.log(`outbox: ${report.opsInOutbox} ops, applied in ${report.applyMs} ms`);
	for (const [title, rows] of [['replica vs copy', report.replicaVsCopy], ['reducer vs replica', report.reducerVsReplica]] as const) {
		console.log(`\n${title}`);
		for (const r of rows) {
			console.log(`  ${r.equal ? 'OK  ' : 'DIFF'} ${r.table.padEnd(16)} ${String(r.left).padStart(7)} | ${String(r.right).padStart(7)}`);
			if (!r.equal) {
				for (const x of r.onlyLeft) console.log(`         only left:  ${JSON.stringify(x)}`);
				for (const x of r.onlyRight) console.log(`         only right: ${JSON.stringify(x)}`);
			}
		}
	}
	console.log(`\n${report.equal ? 'EQUAL' : 'NOT EQUAL'}`);
}
process.exit(report.equal ? 0 : 1);
