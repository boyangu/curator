// Vitest globalSetup: one run-scoped temp root per test run.
//
// Test suites make their scratch dirs with mkdtempSync(join(tmpdir(), …)).
// On Windows a dir whose files are still open cannot be removed, and suites
// that swallowed that EBUSY leaked 38k dirs (104 GB) into %TEMP% before
// anyone noticed. Per-suite cleanup is fixed where the handles are
// (apps/core/src/test-support/tmp.ts); this is the net under it.
//
// setup() makes %TEMP%\curator-run-<pid>-<rand> and points TEMP/TMP/TMPDIR
// at it, so os.tmpdir() in every worker (vitest copies process.env into the
// pool after globalSetup runs) and in every child a test spawns lands there.
// teardown() then removes exactly that root: nothing another run is using,
// however many suites run at once — the safety a "curator-* newer than the
// start time" sweep cannot give with two runs overlapping. What a test left
// behind is counted and logged, so a leak stays visible without filling the
// disk.
//
// A run that dies before its teardown (Ctrl-C, a crash) leaves its root; the
// next run's setup removes roots whose owning process no longer exists.
//
// In a vitest workspace every project runs its own globalSetup in the same
// main process: the first creates the root, the rest share it (refcounted on
// globalThis, since each project loads this module separately), and the last
// teardown removes it.

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const KEY = Symbol.for('curator.test.tmpRoot');
const ROOT_PREFIX = 'curator-run-';
const OWNER = 'owner.json';
const ENV_KEYS = ['TEMP', 'TMP', 'TMPDIR'];

const log = (msg) => process.stdout.write(`[tmp-root] ${msg}\n`);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: it exists, we just may not signal it.
		return err.code === 'EPERM';
	}
}

async function removeQuietly(path) {
	try {
		await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		return true;
	} catch {
		return false;
	}
}

// Roots left by runs that died before their teardown. Only roots with an
// owner file naming a process that is gone: a live run's root is never
// touched, and neither is anything that is not a run root.
async function sweepOrphans(base) {
	let removed = 0;
	for (const name of readdirSync(base)) {
		if (!name.startsWith(ROOT_PREFIX)) continue;
		const dir = join(base, name);
		let pid;
		try { pid = JSON.parse(readFileSync(join(dir, OWNER), 'utf8')).pid; } catch { continue; }
		if (typeof pid !== 'number' || alive(pid)) continue;
		if (await removeQuietly(dir)) removed++;
	}
	if (removed > 0) log(`removed ${removed} temp root(s) left by runs that did not finish`);
}

// Top-level entries a test left behind, grouped by mkdtemp prefix.
function leftovers(root) {
	const byPrefix = new Map();
	const names = readdirSync(root).filter((n) => n !== OWNER);
	for (const n of names) {
		const p = n.replace(/[A-Za-z0-9]{6}$/, '');
		byPrefix.set(p, (byPrefix.get(p) ?? 0) + 1);
	}
	return { names, byPrefix };
}

export default async function setup() {
	const shared = globalThis[KEY];
	if (shared) {
		shared.refs++;
		return teardown;
	}
	const base = tmpdir();
	await sweepOrphans(base);
	const root = mkdtempSync(join(base, `${ROOT_PREFIX}${process.pid}-`));
	writeFileSync(join(root, OWNER), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), cwd: process.cwd() }));
	const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	for (const k of ENV_KEYS) process.env[k] = root;
	globalThis[KEY] = { refs: 1, root, saved };
	return teardown;
}

async function teardown() {
	const state = globalThis[KEY];
	if (!state || --state.refs > 0) return;
	delete globalThis[KEY];
	for (const k of ENV_KEYS) {
		if (state.saved[k] === undefined) delete process.env[k];
		else process.env[k] = state.saved[k];
	}
	const { root } = state;
	if (!existsSync(root)) return;
	const { names, byPrefix } = leftovers(root);
	// Once, then again after the workers' handles have had a moment to go
	// (a worker that leaked a handle releases it when it exits).
	let ok = await removeQuietly(root);
	if (!ok) {
		await delay(1_000);
		ok = await removeQuietly(root);
	}
	if (names.length === 0 && ok) {
		log('tests left no temp dirs behind');
		return;
	}
	const detail = [...byPrefix].map(([p, n]) => `${p}×${n}`).join(', ');
	if (ok) {
		log(`tests left ${names.length} temp dir(s) behind (${detail}); removed them`);
	} else {
		const still = existsSync(root) ? leftovers(root).names.length : 0;
		log(`tests left ${names.length} temp dir(s) behind (${detail}); removed ${names.length - still}, could not remove ${still} — still in ${root}`);
	}
}
