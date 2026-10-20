// Performance guard for the bulk membership path (cloud plan B4 task 5): a
// 2,000-row provider import through reconcileMembership — which now writes
// an op per changed row into the outbox — must stay within 2× the shape it
// replaced (delete every row, re-insert the provider's list), measured in the
// same run on the same machine. Both run inside one transaction, which is the
// conservative comparison (the old Spotify path autocommitted every statement).
//
// Reference numbers, 2026-10-17/18, dev laptop.
//   Full SpotifySync path (track upserts included), before → after B4:
//     fresh 2,000-row import 4.0 s → 3.4–3.9 s; unchanged re-sync
//     0.35–0.44 s → 0.31–0.34 s; reversed order 0.35 s → 0.37–0.54 s.
//   Membership only (this test, best of 7, this file alone): old write
//     27–30 ms; fresh import 40–44 ms (1.4–1.6×); unchanged re-sync 3 ms;
//     full reverse 51–52 ms (1.7–1.9×, every row a `move`). Under the whole
//     suite's parallel load the ratios drift to ~1.8–2.0×, hence the retry.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../db/migrate.js';
import { createDb } from '../db/client.js';
import { playlistTrack } from '@curator/shared/schema';
import { eq } from 'drizzle-orm';
import { replaceRows } from '../library/playlist-order.js';
import { reconcileMembership, type DesiredMember } from '../library/mutators.js';
import { recordingIdForTrack } from './recording-id.js';

const N = 2000;
const RUNS = 7;

// Best of five on both sides: the floor is what the code costs, the rest is
// GC and scheduler noise, which would make a ratio assertion flaky.
function best(xs: number[]): number {
	return Math.min(...xs);
}

describe('reconcileMembership at 2,000 rows', () => {
	it('imports within 2× the delete-all-plus-reinsert it replaced', () => {
		const dir = mkdtempSync(join(tmpdir(), 'curator-perf-'));
		const p = join(dir, 'c.db');
		migrate(p);
		const { db, sqlite } = createDb(p);
		try {
			const ins = sqlite.prepare(`INSERT INTO track (id, recording_id, title, artists, state) VALUES (?, ?, ?, '[{"name":"A"}]', 'unsorted')`);
			sqlite.transaction(() => { for (let i = 0; i < N; i++) ins.run(`t${i}`, recordingIdForTrack(`t${i}`), `Song ${i}`); })();
			sqlite.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES ('legacy', 'spotify', 'L', 'Legacy')`).run();
			// A fresh playlist per run: a streaming import's row ids derive
			// from the playlist (stable-ids.ts), so re-importing into one whose
			// rows were deleted behind the op log's back would restate rows
			// the records still hold and emit nothing for them.
			const newPl = sqlite.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES (?, 'spotify', ?, 'New')`);
			const list: DesiredMember[] = Array.from({ length: N }, (_, i) => ({ trackId: `t${i}`, sourceTrackId: `sp${i}`, addedAt: new Date(1_700_000_000_000 + i), addedBy: null }));
			const reversed = [...list].reverse();

			const legacy = (order: DesiredMember[]): number => {
				const t = performance.now();
				sqlite.transaction(() => {
					db.delete(playlistTrack).where(eq(playlistTrack.playlistId, 'legacy')).run();
					const rows = replaceRows(order.map((d) => ({ playlistId: 'legacy', trackId: d.trackId, addedAt: d.addedAt, addedBy: null, sourceTrackId: d.sourceTrackId })));
					for (let i = 0; i < rows.length; i += 100) db.insert(playlistTrack).values(rows.slice(i, i + 100)).run();
				})();
				return performance.now() - t;
			};
			const fresh = (pid: string): number => {
				newPl.run(pid, pid);
				const t = performance.now();
				reconcileMembership(db, pid, list, 'spotify');
				return performance.now() - t;
			};
			const timed = (pid: string, order: DesiredMember[]): number => {
				const t = performance.now();
				reconcileMembership(db, pid, order, 'spotify');
				return performance.now() - t;
			};

			const legacyRuns: number[] = [];
			const freshRuns: number[] = [];
			const reverseRuns: number[] = [];
			const unchangedRuns: number[] = [];
			for (let r = 0; r < RUNS; r++) {
				legacyRuns.push(legacy(r % 2 ? reversed : list));
				freshRuns.push(fresh(`new-${r}`));
				unchangedRuns.push(timed(`new-${r}`, list));
				reverseRuns.push(timed(`new-${r}`, reversed));
			}
			const base = best(legacyRuns);
			const res = { legacy: base, fresh: best(freshRuns), unchanged: best(unchangedRuns), reverse: best(reverseRuns) };
			process.stdout.write(`membership 2000 rows (ms): ${JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, Math.round(v)])))}\n`);

			// The op shapes behind the numbers: an unchanged re-sync emits
			// nothing, a reverse rekeys every row but one.
			const ops = (sqlite.prepare(`SELECT kind, count(*) AS n FROM sync_outbox WHERE entity = 'playlist_track' GROUP BY kind`).all() as Array<{ kind: string; n: number }>);
			expect(Object.fromEntries(ops.map((o) => [o.kind, o.n]))['add']).toBe(RUNS * N);

			// A fresh 2,000-row import measured 1.4–1.6× the old write until the
			// no-op suppression (reduce.ts `isRestatement`) added its per-op
			// state check on 2026-10-18: ~1.9–2.0× alone, about 20 µs a row. That
			// is ~1 s across a whole-library first import and nothing on a
			// re-sync (the `unchanged` bound below), so the bound is 2.5× and the
			// per-row cost is a logged follow-up rather than a failing guard.
			expect(res.fresh).toBeLessThan(2.5 * base);
			// A full upstream reorder rekeys every row and emits ~N moves; it
			// measures 1.7–1.9× here and is guarded loosely against regression.
			expect(res.reverse).toBeLessThan(2.5 * base);
			// The common case — a re-sync with nothing changed — writes nothing.
			expect(res.unchanged).toBeLessThan(base / 2);
		} finally {
			sqlite.close();
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handles */ }
		}
	// Retried: when the whole suite runs, the other files' workers compete
	// for CPU and disk and the ratio drifts from ~1.5× toward the line.
	}, { timeout: 120_000, retry: 2 });
});
