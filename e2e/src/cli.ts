// pnpm e2e:rekordbox [--dry-run] [--keep] [--curator <path>] [--rb <path>] [--timeout-min <n>]
//
// Runs the library → cloud → fresh desktop → rekordbox pipeline on copies of
// the live library under planning/private/e2e/<timestamp>/ and writes
// report.json + report.html there. The sources (default: the live
// %APPDATA%/Curator/curator.db and %APPDATA%/Pioneer/rekordbox/master.db)
// are only read. Close rekordbox first: the run refuses while it is open
// (except --dry-run, which never pushes and only warns if the copy may be
// torn). Without --keep only the report and the logs are kept.
//
// Exit: 0 every check passed; 1 a Curator-owned difference; 2 the run
// stopped (a safety refusal, a timeout, an error).

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CLI_WORK_ROOT } from './paths.js';
import { runRekordboxE2E } from './pipeline.js';
import { summaryLines } from './report.js';

function usage(msg?: string): never {
	if (msg) process.stderr.write(`${msg}\n`);
	process.stderr.write('usage: pnpm e2e:rekordbox [--dry-run] [--keep] [--curator <curator.db or its folder>] [--rb <master.db or its folder>] [--timeout-min <n>]\n');
	process.exit(2);
}

function source(p: string, file: string): string {
	const abs = resolve(p);
	return existsSync(abs) && statSync(abs).isDirectory() ? join(abs, file) : abs;
}

async function main(): Promise<void> {
	const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
	let curatorDb = join(appData, 'Curator', 'curator.db');
	let rbDb = join(appData, 'Pioneer', 'rekordbox', 'master.db');
	let dryRun = false;
	let keep = false;
	let timeoutMin = 45;
	const args = process.argv.slice(2).filter((a) => a !== '--');
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		const value = (): string => args[++i] ?? usage(`${a} needs a value`);
		if (a === '--dry-run') dryRun = true;
		else if (a === '--keep') keep = true;
		else if (a === '--curator') curatorDb = source(value(), 'curator.db');
		else if (a === '--rb') rbDb = source(value(), 'master.db');
		else if (a === '--timeout-min') timeoutMin = Number(value());
		else if (a === '--help' || a === '-h') usage();
		else usage(`unknown argument ${a}`);
	}
	if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) usage('--timeout-min must be a positive number');
	// The work root is fixed: the run refuses a work dir outside it (rails.ts).
	const report = await runRekordboxE2E({
		sources: { curatorDb, rbDb },
		workRoot: CLI_WORK_ROOT,
		dryRun,
		keep,
		phaseTimeoutMs: timeoutMin * 60_000,
	});
	for (const l of summaryLines(report)) process.stdout.write(`${l}\n`);
	process.exitCode = report.exitCode;
}

main().catch((err: unknown) => {
	process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
	process.exitCode = 2;
});
