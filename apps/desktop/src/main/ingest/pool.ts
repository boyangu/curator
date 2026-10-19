// Pool of Electron utility processes that parse audio metadata off the main
// process. Each entry in the pool is one `app.utilityProcess.fork()` running
// the worker script at ./worker.ts (bundled to ingest-worker.cjs).
//
// The pool is owned by the desktop main process and exposes a single
// `parse(path)` Promise API. Calls land on a free worker if there is one;
// otherwise they queue in a FIFO and run as workers become idle.
//
// Worker crashes are handled defensively: the in-flight promise rejects, the
// dead entry is removed, and a fresh utility process is forked after a small
// delay. The pool stays at its configured size unless `shutdown()` is called.
//
// There is no internal throttle on `parse()` callers — the scanner can call
// it 4,500 times in a tight loop and the pool will queue everything. Memory
// per queued job is one closure + a path string.

import { cpus } from 'node:os';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { ParseFn, ParseResult } from '@curator/core/ingest';
import { mainLog } from '../log.js';

const slog = mainLog.for('ingest');

interface InflightRequest {
	id: number;
	// Path being parsed — kept so a worker death can be attributed to the
	// file that killed it (see crashCounts / dead-letter below).
	path: string;
	resolve: (r: ParseResult) => void;
	reject: (e: Error) => void;
}

interface WorkerEntry {
	proc: UtilityProcess;
	// At most one job runs on a worker at a time. We don't multiplex; keeps
	// the protocol trivial and matches how the scanner submits work anyway.
	inflight: InflightRequest | null;
}

interface WorkerResponse {
	id: number;
	ok: boolean;
	result?: ParseResult;
	message?: string;
}

// Cap to keep one runaway INGEST_POOL_SIZE env from spawning 64 processes
// on a server-class machine. Disk + tag-parse is I/O-bound; past ~8 we'd
// just be contending for the same disk head.
const POOL_CAP = 8;
// Delay before respawning a crashed worker. Short enough that a transient
// blip recovers fast; long enough that a crash-loop doesn't hammer the OS.
const RESPAWN_DELAY_MS = 500;
// A file whose parse kills the worker this many times is dead-lettered:
// subsequent parse() calls for it fail fast instead of sacrificing another
// worker. Without this, every rescan of a malformed file (truncated FLAC,
// hostile ID3) costs a worker death + respawn, and a watched folder full of
// them keeps the pool in a permanent crash-respawn churn.
const MAX_CRASHES_PER_PATH = 3;

export function defaultPoolSize(): number {
	const envRaw = process.env['INGEST_POOL_SIZE'];
	if (envRaw) {
		const n = Number.parseInt(envRaw, 10);
		if (Number.isFinite(n) && n > 0) return Math.min(n, POOL_CAP);
	}
	const cores = cpus().length;
	return Math.max(2, Math.min(POOL_CAP, cores - 1));
}

export class IngestPool {
	private workers: WorkerEntry[] = [];
	private idle: WorkerEntry[] = [];
	// FIFO of jobs waiting for a free worker.
	private waiting: Array<{ path: string; resolve: (r: ParseResult) => void; reject: (e: Error) => void }> = [];
	private nextId = 1;
	private shuttingDown = false;
	// Worker-death attribution. crashCounts only grows on crashes (not on
	// clean parse failures, which reject without killing the worker), so its
	// size is bounded by the number of genuinely lethal files on disk.
	private crashCounts = new Map<string, number>();
	private deadLetter = new Set<string>();

	constructor(private readonly workerPath: string, size: number) {
		for (let i = 0; i < size; i++) this.spawn();
		slog.info('pool started', { size, script: workerPath });
	}

	// Exposed as ParseFn so consumers can pass `pool.parse` straight into
	// createCoreService without a wrapper.
	parse: ParseFn = (path: string): Promise<ParseResult> => {
		return new Promise<ParseResult>((resolve, reject) => {
			if (this.shuttingDown) {
				reject(new Error('ingest pool shutting down'));
				return;
			}
			if (this.deadLetter.has(path)) {
				reject(new Error(`file repeatedly crashed the ingest worker (${MAX_CRASHES_PER_PATH}×) — skipped: ${path}`));
				return;
			}
			const worker = this.idle.pop();
			if (worker) this.dispatch(worker, path, resolve, reject);
			else this.waiting.push({ path, resolve, reject });
		});
	};

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		// Reject every queued job — they'll never run.
		for (const w of this.waiting) {
			w.reject(new Error('ingest pool shutting down'));
		}
		this.waiting = [];
		// Reject every in-flight, then kill the processes.
		for (const e of this.workers) {
			if (e.inflight) e.inflight.reject(new Error('ingest pool shutting down'));
			e.inflight = null;
			try { e.proc.kill(); } catch { /* already dying */ }
		}
		this.workers = [];
		this.idle = [];
	}

	private spawn(): void {
		const proc = utilityProcess.fork(this.workerPath, [], {
			serviceName: 'curator-ingest',
			// stdio: pipe stderr through so worker errors surface in the main
			// terminal with the rest of the app's logs.
			stdio: 'pipe',
		});
		const entry: WorkerEntry = { proc, inflight: null };
		proc.on('message', (data: unknown) => this.onMessage(entry, data as WorkerResponse));
		proc.on('exit', (code: number) => this.onExit(entry, code));
		// UtilityProcess fires 'error' for non-continuable V8 errors in the
		// worker (per Electron docs). Without a listener Node would abort the
		// main process — exactly the symptom we'd see as a 0xC0000005 exit on
		// Windows. The 'exit' event still fires after, so the respawn path
		// runs and heals the pool.
		proc.on('error', (type: string, location: string, report: string) => {
			slog.error('worker fatal', undefined, { type, location });
			if (report) slog.error('worker report', undefined, { report });
			if (entry.inflight) {
				this.recordCrash(entry.inflight.path);
				entry.inflight.reject(new Error(`worker fatal: ${type} @ ${location}`));
				entry.inflight = null;
			}
		});
		if (proc.stderr) {
			proc.stderr.setEncoding('utf8');
			proc.stderr.on('data', (chunk: string) => process.stderr.write(`[ingest] ${chunk}`));
		}
		this.workers.push(entry);
		this.idle.push(entry);
	}

	private dispatch(
		entry: WorkerEntry,
		path: string,
		resolve: (r: ParseResult) => void,
		reject: (e: Error) => void,
	): void {
		const id = this.nextId++;
		entry.inflight = { id, path, resolve, reject };
		entry.proc.postMessage({ type: 'parse', id, path });
	}

	private onMessage(entry: WorkerEntry, data: WorkerResponse): void {
		const inflight = entry.inflight;
		// Stale frame — worker is replying to a job we already gave up on
		// (e.g. timed out, though we don't have timeouts yet). Drop it.
		if (!inflight || data.id !== inflight.id) return;
		entry.inflight = null;

		if (data.ok && data.result) inflight.resolve(data.result);
		else inflight.reject(new Error(data.message ?? 'ingest worker returned no result'));

		// Worker is free — hand it the next waiting job (if any), otherwise
		// return it to the idle pool.
		const next = this.waiting.shift();
		if (next) this.dispatch(entry, next.path, next.resolve, next.reject);
		else this.idle.push(entry);
	}

	// A worker died while this path was in flight. After MAX_CRASHES_PER_PATH
	// strikes the path is dead-lettered and parse() fails fast for it.
	private recordCrash(path: string): void {
		const n = (this.crashCounts.get(path) ?? 0) + 1;
		this.crashCounts.set(path, n);
		if (n >= MAX_CRASHES_PER_PATH && !this.deadLetter.has(path)) {
			this.deadLetter.add(path);
			slog.error(`dead-lettered after ${n} worker crashes`, undefined, { path });
		}
	}

	private onExit(entry: WorkerEntry, code: number): void {
		slog.warn('worker exited', { code, inflight: entry.inflight ? 1 : 0 });
		if (entry.inflight) {
			this.recordCrash(entry.inflight.path);
			entry.inflight.reject(new Error(`ingest worker exited (code=${code})`));
			entry.inflight = null;
		}
		this.workers = this.workers.filter((w) => w !== entry);
		this.idle = this.idle.filter((w) => w !== entry);

		if (this.shuttingDown) return;

		// Refill the pool. A fresh worker picks up a waiting job immediately
		// rather than going through the idle list — keeps the queue draining.
		setTimeout(() => {
			if (this.shuttingDown) return;
			this.spawn();
			const replacement = this.workers[this.workers.length - 1];
			if (!replacement) return;
			const next = this.waiting.shift();
			if (!next) return;
			const idx = this.idle.indexOf(replacement);
			if (idx >= 0) this.idle.splice(idx, 1);
			this.dispatch(replacement, next.path, next.resolve, next.reject);
		}, RESPAWN_DELAY_MS);
	}
}
