// Where a join's time goes, on Node (the desktop reference): every SQLite
// call timed by its statement, every log line stamped with the time since
// the start, so the client's phases show; the rest of the wall time is
// JavaScript.
//
//   node scripts/profile.mjs [--name nov8] [--work <dir>] [--top 40]
//       [--scale <n>]            the client's sliceScale
//       [--pragma "a=1;b=2"]     more settings on the library, right after it is put in WAL mode
//       [--memory]               the library in memory, written to a file once synced
//   node --cpu-prof --cpu-prof-dir=<dir> scripts/profile.mjs ...   adds V8's own profile
//
// Runs the driver's `join` (the in-process fake cloud holding the snapshot;
// no server, no HTTP) on a fresh copy of the empty library, real clock.
// Writes <work>/<name>/profile/{replica.db, sql.json} and prints the summary.

import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// The driver is loaded after console is wrapped below: the core's log sink
// binds console's methods when its module loads.

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const dir = join(resolve(arg('work', 'c:/tmp/curator-mobile-spike')), arg('name', 'nov8'));
const top = Number(arg('top', '40'));
const run = join(dir, 'profile');
rmSync(run, { recursive: true, force: true });
mkdirSync(run, { recursive: true });
copyFileSync(join(dir, 'empty.db'), join(run, 'replica.db'));

const now = () => Number(process.hrtime.bigint()) / 1e6;
const t0 = now();

// Every statement's calls, rows and time; keyed by its SQL, whitespace folded.
const stats = new Map();
let sqlMs = 0;
let calls = 0;
let commits = 0;
let commitMs = 0;
const record = (sql, ms, rows) => {
	const key = sql.replace(/\s+/g, ' ').trim();
	const s = stats.get(key) ?? stats.set(key, { calls: 0, ms: 0, rows: 0 }).get(key);
	s.calls++;
	s.ms += ms;
	s.rows += rows;
	sqlMs += ms;
	calls++;
	if (key === 'COMMIT' || key.startsWith('RELEASE')) { commits++; commitMs += ms; }
};
const probe = new Database(':memory:');
const Stmt = Object.getPrototypeOf(probe.prepare('select 1'));
probe.close();
for (const m of ['run', 'get', 'all']) {
	const orig = Stmt[m];
	Stmt[m] = function (...a) {
		const t = now();
		let rows = 0;
		try {
			const r = orig.apply(this, a);
			rows = m === 'run' ? r.changes : m === 'all' ? r.length : r === undefined ? 0 : 1;
			return r;
		} finally {
			record(this.source, now() - t, rows);
		}
	};
}
// iterate(): the time of each step, the statement's own.
const origIterate = Stmt.iterate;
Stmt.iterate = function (...a) {
	const source = this.source;
	let t = now();
	const it = origIterate.apply(this, a);
	record(source, now() - t, 0);
	return {
		[Symbol.iterator]() { return this; },
		next() {
			t = now();
			const r = it.next();
			record(source, now() - t, r.done ? 0 : 1);
			return r;
		},
		return(v) { return it.return ? it.return(v) : { done: true, value: v }; },
	};
};
const origExec = Database.prototype.exec;
Database.prototype.exec = function (sql) {
	const t = now();
	try { return origExec.call(this, sql); } finally { record(sql.length > 200 ? `${sql.slice(0, 200)}…` : sql, now() - t, 0); }
};
// --pragma: what the client opens the library with, then these.
const extra = (arg('pragma', '') ?? '').split(';').map((s) => s.trim()).filter(Boolean);
const origPragma = Database.prototype.pragma;
Database.prototype.pragma = function (source, opts) {
	const r = origPragma.call(this, source, opts);
	if (/^journal_mode\s*=\s*wal$/i.test(source.trim())) for (const p of extra) origPragma.call(this, p);
	return r;
};
const origPrepare = Database.prototype.prepare;
let prepares = 0;
let prepareMs = 0;
const prepared = new Map();
Database.prototype.prepare = function (sql) {
	const t = now();
	try { return origPrepare.call(this, sql); } finally {
		const ms = now() - t;
		prepares++;
		prepareMs += ms;
		const key = sql.replace(/\s+/g, ' ').trim();
		const p = prepared.get(key) ?? prepared.set(key, { n: 0, ms: 0 }).get(key);
		p.n++;
		p.ms += ms;
	}
};

// Log lines stamped with seconds since the start, and SQL time so far. The
// client logs a phase when it ends, so the time since the previous line is
// put down to the line's phase.
const segments = [];
let mark = { t: t0, sqlMs: 0, commits: 0, commitMs: 0, prepares: 0, calls: 0 };
const stamp = (fn) => (...a) => {
	const t = now();
	const first = typeof a[0] === 'string' ? a[0] : '';
	if (/^\[(cloud-sync|remote-rows|join-bind|identity|claim)/.test(first) || /^cycle \d/.test(first)) {
		segments.push({ label: first.slice(0, 70), ms: t - mark.t, sqlMs: sqlMs - mark.sqlMs, commits: commits - mark.commits, commitMs: commitMs - mark.commitMs, prepares: prepares - mark.prepares, calls: calls - mark.calls });
		mark = { t, sqlMs, commits, commitMs, prepares, calls };
	}
	fn(`[${((t - t0) / 1000).toFixed(1).padStart(6)} s, sql ${(sqlMs / 1000).toFixed(1).padStart(5)} s]`, ...a);
};
for (const k of ['log', 'info', 'debug', 'warn', 'error']) console[k] = stamp(console[k].bind(console));

const { main } = await import('../dist/desktop.mjs');
await main(['join', '--db', join(run, 'replica.db'), '--data', dir, '--out', run, ...(arg('scale') ? ['--scale', arg('scale')] : []), ...(args.includes('--memory') ? ['--memory'] : [])]);
const wall = now() - t0;

const rows = [...stats].map(([sql, s]) => ({ sql, ...s })).sort((a, b) => b.ms - a.ms);
writeFileSync(join(run, 'sql.json'), JSON.stringify({ wallMs: wall, sqlMs, calls, prepares, prepareMs, statements: rows }, null, 1));
const f = (ms) => `${(ms / 1000).toFixed(1)} s`;
console.log(`\nsettings: scale ${arg('scale', '1')}${extra.length ? `, ${extra.join(', ')}` : ''}`);
console.log(`wall ${f(wall)} (including the dump), SQLite ${f(sqlMs)} in ${calls.toLocaleString()} calls over ${stats.size.toLocaleString()} distinct statements, ${prepares.toLocaleString()} prepares ${f(prepareMs)}; the rest ${f(wall - sqlMs - prepareMs)} is JavaScript`);
console.log(`\nphases over a second (time up to each log line):`);
for (const s of segments.filter((x) => x.ms > 1000)) console.log(`${f(s.ms).padStart(8)}  sql ${f(s.sqlMs).padStart(7)}  ${String(s.commits).padStart(5)} commits ${f(s.commitMs).padStart(7)}  ${String(s.calls).padStart(8)} calls  ${String(s.prepares).padStart(7)} prepares  ${s.label}`);
console.log(`\ntop ${top} statements by time:`);
for (const r of rows.slice(0, top)) console.log(`${f(r.ms).padStart(8)} ${String(r.calls).padStart(9)} calls ${String(r.rows).padStart(9)} rows  ${(r.ms * 1000 / r.calls).toFixed(0).padStart(5)} µs/call  ${r.sql.slice(0, 150)}`);
console.log(`\ntop 15 statements by times prepared:`);
for (const [sql, p] of [...prepared].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) console.log(`${String(p.n).padStart(8)}×  ${f(p.ms).padStart(6)}  ${sql.slice(0, 150)}`);
