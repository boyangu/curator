// Wall-clock budgets for the tests that bound a main-loop slice.
//
// Those bounds are written against the dev laptop at rest. Under load (the
// full suite's other workers, a CI runner with two cores, a build in the
// background) the same slice runs 2-5× slower and a fixed bound fails on a
// busy machine rather than on a regression. A budget here is the written
// bound scaled by how slow this machine is right now — a fixed CPU + SQLite
// workload timed against what it costs on the dev laptop — capped at CAP so a
// regression in kind (a slice that grows with the library, one transaction
// where there were many: 10× and up) still fails however loaded the machine.
//
// What it cannot absorb is a single scheduler stall in the middle of a slice
// (the OS parking the worker for a few hundred ms), which no calibration
// predicts. That is why the files with the tightest bounds also run on their
// own after the parallel suite (vitest.workspace.ts, project "perf").

import Database from 'better-sqlite3';

// The median of `sample()` on the dev laptop with nothing else running
// (2026-10-25: 8 cores, Node 22; medians 15-17.5 ms, single samples 14.6-20).
// A faster machine reads below it and gets the written bound, never a
// tighter one.
const REFERENCE_MS = 17;
// ×4 keeps a 2-3× loaded machine green and still fails a 10× regression.
const CAP = 4;
const SAMPLES = 5;

// A fixed workload shaped like the code under test: JSON payloads through
// prepared statements in one transaction, a grouped read back, and the JS
// round trip of the result. In memory, so it times CPU contention, not the
// disk (the slices under test commit to WAL files, but an fsync's latency
// is too erratic to calibrate against).
function sample(): number {
	const t0 = performance.now();
	const db = new Database(':memory:');
	try {
		db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT NOT NULL, v TEXT NOT NULL)');
		const ins = db.prepare('INSERT INTO t (k, v) VALUES (?, ?)');
		db.transaction(() => {
			for (let i = 0; i < 10_000; i++) ins.run(`k${i % 97}`, JSON.stringify({ i, title: `Song ${i}`, artists: [{ name: `Artist ${i % 50}` }] }));
		})();
		const rows = db.prepare(`SELECT k, count(*) AS n, max(json_extract(v, '$.i')) AS m FROM t GROUP BY k ORDER BY k`).all();
		JSON.parse(JSON.stringify(rows));
	} finally {
		db.close();
	}
	return performance.now() - t0;
}

// The median of a few runs after a warm-up (the first pays for the JIT and
// the statement compile): the typical slowdown right now, not one GC pause.
export function measureSlowdown(): number {
	sample();
	const xs = Array.from({ length: SAMPLES }, sample).sort((a, b) => a - b);
	return xs[Math.floor(SAMPLES / 2)]! / REFERENCE_MS;
}

// Calibrated once when the test file loads, before its own heavy work, and
// again when a budget is asked for, after it: the slower of the two stands
// for the load the measured work ran under.
const atLoad = measureSlowdown();

// The machine's slowdown now, between ×1 and ×cap.
export function loadFactor(cap = CAP): number {
	return Math.min(cap, Math.max(1, atLoad, measureSlowdown()));
}

// `ms` scaled by the machine's slowdown, between ×1 and ×CAP. The factor is
// written to stdout so a failing bound says what it was measured against.
export function budgetMs(ms: number, label = ''): number {
	const factor = loadFactor();
	const budget = ms * factor;
	process.stdout.write(`[timing] ${label ? `${label}: ` : ''}budget ${ms} ms × ${factor.toFixed(2)} = ${budget.toFixed(0)} ms\n`);
	return budget;
}
