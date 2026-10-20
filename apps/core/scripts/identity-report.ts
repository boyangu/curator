// Read-only measurement of what the streaming identity tier and the
// playlist dedupe would do to a library (cloud plan: streaming identity §5):
// identity groups and the merges this device would emit (by which device
// minted each side), doubled streaming playlist rows now and after those
// merges, live records with no row here, and ISRC lookalikes listed for
// review. Nothing is written: the database is opened with
// SQLITE_OPEN_READONLY (better-sqlite3's `readonly`; this build of SQLite
// does not parse `file:…?mode=ro` URIs, see agent/workspace/engine.ts), and
// every step is a planner. Point it at a COPY of a live library.
//
//   npx tsx scripts/identity-report.ts <db-path> [--json]
//
// Needs the ABI of better-sqlite3 it runs under (`pnpm rebuild:node`, or
// Electron's node with ELECTRON_RUN_AS_NODE=1).

import Database from 'better-sqlite3';
import { identityReport } from '../src/sync-log/identity-report.js';

const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith('--'));
if (!dbPath) {
	console.error('usage: npx tsx scripts/identity-report.ts <db-path> [--json]');
	process.exit(2);
}

const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
	const r = identityReport(raw);
	if (args.includes('--json')) {
		console.log(JSON.stringify(r, null, 2));
	} else {
		console.log(`database:        ${dbPath}`);
		console.log(`device:          ${r.deviceId ?? '(none)'}   records complete: ${r.recordsComplete}`);
		console.log(`library:         ${r.library.liveTracks} live tracks, ${r.library.deletedTracks} deleted; ${r.library.streamingPlaylists} streaming playlists, ${r.library.streamingPlaylistRows} rows`);
		console.log(`recordings by minting device:`);
		for (const d of r.recordingsByDevice) console.log(`  ${d.device}  ${d.recordings}`);
		console.log(`identity groups: ${r.identity.groups} (streaming ${r.identity.streamingGroups}, audio ${r.identity.audioGroups})`);
		console.log(`merges this device emits: ${r.identity.merges.total} (streaming ${r.identity.merges.streaming}, audio ${r.identity.merges.audio}); survivor held here ${r.identity.holdsSurvivor}, loser held here ${r.identity.holdsLoser}`);
		for (const m of r.identity.merges.byDevice) console.log(`  loser minted by ${m.loserDevice} → winner minted by ${m.winnerDevice}: ${m.merges}`);
		console.log(`held groups:     local duplicates ${r.identity.held.localDuplicate}, one device minted two members ${r.identity.held.sameDevice}, oversized ${r.identity.held.oversized}`);
		console.log(`doubled streaming rows: now ${r.dedupe.now.removes} (in ${r.dedupe.now.groups} groups); after the merges ${r.dedupe.afterMerges.removes} (in ${r.dedupe.afterMerges.groups} groups)`);
		for (const p of r.dedupe.afterMerges.perPlaylist.slice(0, 30)) console.log(`  ${String(p.excessRows).padStart(5)}  ${p.name ?? '?'}  (${p.playlistId})`);
		if (r.dedupe.afterMerges.perPlaylist.length > 30) console.log(`  … ${r.dedupe.afterMerges.perPlaylist.length - 30} more playlists`);
		console.log(`live records without a row here: ${r.recordsWithoutRows}`);
		console.log(`remote_only rows: ${r.remoteOnly ?? 'n/a (column not in this schema)'}`);
		console.log(`ISRC lookalikes for review: ${r.isrcLookalikes.pairs}`);
		for (const l of r.isrcLookalikes.sample.slice(0, 10)) console.log(`  ${l.isrc}: ${l.titles.map((t, i) => `${t ?? '(no row)'} [${l.durations[i] ?? '?'} s]`).join(' | ')}`);
	}
} finally {
	raw.close();
}
