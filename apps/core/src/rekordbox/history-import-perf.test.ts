// Performance guard for the rekordbox play-history pass. The reader sends the
// WHOLE history on every sync, so the steady state is "import 29k plays that
// are all already here". 2026-10-18 on the live library: each sync upserted
// every play and re-emitted every session + play into the outbox (87k
// pending play ops after three syncs) and the import's playlists→completed
// segment grew from 3.5–7 s to 10.6–14 s on the main loop.
//
// Generated history the size of the live one (1,200 sessions / 29,000
// plays, 3,000 of 4,000 content ids linked), imported twice: the second,
// unchanged import must emit nothing and cost no more than the first. The
// baseline is the same first import with op emission switched off (a test
// mock of the play mutator — there is no product switch), to show what the
// op log adds to a fresh import.
//
// Reference numbers, 2026-10-18, dev laptop (this file alone):
//   one commit per session, drizzle per-play writes: first import 9.9–11 s
//   (without emission 3.0–3.3 s), unchanged re-import 0.19–0.24 s;
//   50-session batches + prepared per-play statements: first import
//   3.4–3.5 s (without emission 0.9–1.2 s), unchanged re-import 0.14 s.
//   What emission still adds is SQLite page writes (outbox + sync_state
//   rows and their indexes) and the larger commits.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { migrate } from '../db/migrate.js';
import { createDb } from '../db/client.js';
import { RekordboxImporter, type ImportTotals } from './importer.js';
import type { RekordboxSidecar } from './sidecar.js';

const emission = vi.hoisted(() => ({ on: true }));
vi.mock('../library/mutators.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../library/mutators.js')>();
	return {
		...actual,
		recordPlayAppended: (...args: Parameters<typeof actual.recordPlayAppended>) => {
			if (emission.on) actual.recordPlayAppended(...args);
		},
	};
});

const SESSIONS = 1200;
const PLAYS = 29_000;
const CONTENT = 4000;
const LINKED = 3000;
const T0 = Date.parse('2024-01-01T20:00:00Z');

type Session = { rb_history_id: string; name: string; date_created_ms: number; plays: Array<{ rb_song_history_id: string; rb_content_id: string; track_no: number; created_at_ms: number }> };

function history(): Session[] {
	const out: Session[] = [];
	let play = 0;
	for (let s = 0; s < SESSIONS; s++) {
		const n = Math.floor(PLAYS / SESSIONS) + (s < PLAYS % SESSIONS ? 1 : 0);
		const day = new Date(T0 + s * 86_400_000);
		const bulk = s % 3 === 0; // a third are USB imports (every row in one instant)
		const start = day.getTime();
		const plays = [];
		for (let i = 0; i < n; i++, play++) {
			plays.push({
				rb_song_history_id: `SH${play}`,
				rb_content_id: `C${(play * 7919) % CONTENT}`,
				track_no: i + 1,
				created_at_ms: bulk ? start : start + i * 4 * 60_000,
			});
		}
		const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
		out.push({ rb_history_id: `H${s}`, name: `HISTORY ${ymd}`, date_created_ms: start, plays });
	}
	return out;
}

function stub(sessions: Session[]): RekordboxSidecar {
	const emitter = new EventEmitter();
	return Object.assign(emitter, {
		open: async () => ({ ok: true }),
		scan: async () => {
			for (const s of sessions) emitter.emit('event', { event: 'history', frame: { row: s } });
			return { watermarks: {}, cancelled: false };
		},
		cancel: async () => { /* */ },
	}) as unknown as RekordboxSidecar;
}

function library(dir: string, name: string) {
	const p = join(dir, `${name}.db`);
	migrate(p);
	const { db, sqlite } = createDb(p);
	const track = sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES (?, ?, '[]', 'unsorted')`);
	const link = sqlite.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at) VALUES (?, ?, 0, 0, 0)`);
	sqlite.transaction(() => {
		for (let i = 0; i < LINKED; i++) { track.run(`t${i}`, `Song ${i}`); link.run(`t${i}`, `C${i}`); }
	})();
	return { db, sqlite, dir };
}

async function timedImport(lib: ReturnType<typeof library>, sessions: Session[]): Promise<{ ms: number; totals: ImportTotals; ops: number }> {
	const before = (lib.sqlite.prepare(`SELECT count(*) AS n FROM sync_outbox`).get() as { n: number }).n;
	const importer = new RekordboxImporter(lib.db, stub(sessions));
	const t = performance.now();
	const totals = await importer.runImport({
		mode: 'full',
		flags: { syncTracks: false, syncPlaylists: false, syncMyTags: false, syncCuesGridsPhrases: false, syncWaveformPeaks: false, syncHistory: true },
		dbPath: join(lib.dir, 'master.db'), // never opened — stub sidecar
		peaksDir: join(lib.dir, 'peaks'),
	});
	const ms = performance.now() - t;
	const after = (lib.sqlite.prepare(`SELECT count(*) AS n FROM sync_outbox`).get() as { n: number }).n;
	return { ms, totals, ops: after - before };
}

describe('rekordbox history import at live-library size', () => {
	it('an unchanged re-import emits nothing and costs no more than the first import', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'curator-hist-perf-'));
		const sessions = history();
		const a = library(dir, 'a');
		const b = library(dir, 'b');
		try {
			emission.on = true;
			const first = await timedImport(a, sessions);
			const second = await timedImport(a, sessions);
			emission.on = false;
			const baseline = await timedImport(b, sessions);
			emission.on = true;

			process.stdout.write(`history import ${SESSIONS} sessions / ${PLAYS} plays (ms): ${JSON.stringify({
				first: Math.round(first.ms), firstOps: first.ops,
				firstWithoutEmission: Math.round(baseline.ms),
				unchangedReimport: Math.round(second.ms), unchangedOps: second.ops,
			})}\n`);

			expect(first.totals).toMatchObject({ historySessionsUpserted: SESSIONS, historyPlaysUpserted: PLAYS });
			expect(first.ops).toBe(SESSIONS + PLAYS);
			expect(second.totals).toMatchObject({ historySessionsSeen: SESSIONS, historyPlaysSeen: PLAYS, historySessionsUpserted: 0, historyPlaysUpserted: 0 });
			expect(second.ops).toBe(0);
			expect(second.ms).toBeLessThanOrEqual(first.ms);
			expect(baseline.ops).toBe(0);
		} finally {
			a.sqlite.close();
			b.sqlite.close();
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handles */ }
		}
	}, { timeout: 180_000 });
});
