// Node-side manager for the Rust audio engine sidecar (apps/audio/).
//
// Responsibilities — parallel to apps/core/src/analyzer/sidecar.ts:
//   1. Spawn the sidecar process at boot and keep it alive.
//   2. Wrap stdio JSON-RPC in a typed Promise<unknown> request API.
//      Requests are correlated by id; multiple in-flight requests are
//      multiplexed on one pipe (rare in audio's case — most ops are
//      load/play/pause/seek which serialise naturally — but correlation
//      keeps it correct under any ordering).
//   3. Forward async sidecar events (state_changed, ended) to a single
//      EventEmitter subscribers can attach to. The renderer's view is
//      one window's webContents, set via setEventTarget() from main.
//   4. Re-spawn on crash with bounded backoff so a momentary driver
//      hiccup doesn't take down playback for the session.
//
// The wire protocol matches apps/audio/src/protocol.rs exactly. Keep the
// two in sync.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { isWellFormedString } from '@curator/shared';
import { mainLog } from './log.js';
import type { AudioEvent } from '../ipc.js';

const slog = mainLog.for('audio');

export interface SidecarOptions {
	executable: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

// Crash respawn back-off. Mirrors the analyzer sidecar's curve. After
// MAX_RESPAWN_BURST consecutive crashes inside a minute, give up — likely
// a permanent failure (missing audio device, bad MSVC runtime, etc.) that
// won't fix itself with retries.
const RESPAWN_DELAYS_MS = [200, 500, 1000, 2000, 5000, 15000];
const MAX_RESPAWN_BURST = 6;

interface PendingRequest {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	method: string;
}

export class AudioSidecarHost extends EventEmitter {
	private opts: SidecarOptions;
	private proc: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	// Buffer for stdout — JSON frames are LF-delimited but a single read
	// may contain partial frames across chunks. Accumulate until we have
	// complete lines.
	private stdoutBuf = '';
	private stderrBuf = '';
	private crashCount = 0;
	private crashWindowStart = 0;
	private respawnTimer: NodeJS.Timeout | null = null;
	private shuttingDown = false;
	// Optional renderer target. Set by the main process after the window
	// is created so we can forward audio:event push messages directly.
	// Without it, events still fire on the local EventEmitter for
	// in-main-process subscribers.
	private eventTarget: WebContents | null = null;

	constructor(opts: SidecarOptions) {
		super();
		this.opts = opts;
	}

	// Wire the renderer window's webContents so audio events flow there.
	// Idempotent — calling with the same target a second time is a no-op.
	setEventTarget(wc: WebContents | null): void {
		this.eventTarget = wc;
	}

	start(): void {
		if (this.proc) return;
		this.shuttingDown = false;
		const proc = spawn(this.opts.executable, this.opts.args ?? [], {
			cwd: this.opts.cwd,
			env: { ...process.env, ...(this.opts.env ?? {}) },
			stdio: ['pipe', 'pipe', 'pipe'],
			// On Windows, default shell=false avoids cmd.exe wrapping which
			// would mangle stdio framing. On non-Windows there's no shell
			// involved anyway.
			windowsHide: true,
		}) as ChildProcessWithoutNullStreams;

		proc.stdout.setEncoding('utf8');
		proc.stderr.setEncoding('utf8');
		proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
		proc.stderr.on('data', (chunk: string) => this.onStderr(chunk));
		proc.on('exit', (code, signal) => {
			slog.warn('sidecar exited', { code, signal });
			this.proc = null;
			// Reject any in-flight requests so callers don't hang forever.
			for (const [id, req] of this.pending) {
				req.reject(new Error(`audio sidecar exited (code=${code}) during ${req.method}`));
				this.pending.delete(id);
			}
			if (!this.shuttingDown) this.scheduleRespawn();
		});
		proc.on('error', (err) => {
			slog.error('sidecar spawn error', err);
		});
		this.proc = proc;
		slog.info('sidecar started', { pid: proc.pid });
	}

	// JSON-RPC request. Returns a Promise that resolves with the sidecar's
	// `result` payload, or rejects with the typed `error.kind`/`error.message`.
	// Methods + params shape: see apps/audio/src/protocol.rs.
	//
	// Instrumentation: logs entry → stdin-write → response delta in ms so
	// we can attribute slow audio:rpc to either Node-side queueing (entry
	// vs write) or sidecar work (write vs response). Temporary; remove
	// once latency picture stabilises.
	request(method: string, params?: unknown): Promise<unknown> {
		const tEntry = performance.now();
		return new Promise((resolve, reject) => {
			if (!this.proc) {
				reject(new Error(`audio sidecar not running (request: ${method})`));
				return;
			}
			// Guard, don't scrub: `load` carries a file path, and a path with a
			// lone UTF-16 surrogate (NTFS allows them) can't round-trip UTF-8 to
			// the Rust side — scrubbing would silently name a different file.
			// Reject this one request loudly instead.
			if (params && typeof params === 'object') {
				for (const v of Object.values(params as Record<string, unknown>)) {
					if (typeof v === 'string' && !isWellFormedString(v)) {
						reject(new Error(`${method}: param is not valid Unicode (lone surrogate): ${v.replace(/[\uD800-\uDFFF]/g, '�')}`));
						return;
					}
				}
			}
			const id = this.nextId++;
			const wrappedResolve = (v: unknown): void => {
				const tDone = performance.now();
				slog.debug('rpc done', { method, id, writeToDoneMs: +(tDone - tWrite).toFixed(1), entryToDoneMs: +(tDone - tEntry).toFixed(1) });
				resolve(v);
			};
			const wrappedReject = (e: Error): void => {
				const tDone = performance.now();
				slog.debug('rpc failed', { method, id, entryToFailMs: +(tDone - tEntry).toFixed(1) });
				reject(e);
			};
			this.pending.set(id, { resolve: wrappedResolve, reject: wrappedReject, method });
			const frame = JSON.stringify({ id, method, params: params ?? {} }) + '\n';
			const tWrite = performance.now();
			slog.debug('rpc write', { method, id, entryToWriteMs: +(tWrite - tEntry).toFixed(1) });
			try {
				this.proc.stdin.write(frame);
			} catch (e) {
				this.pending.delete(id);
				wrappedReject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	async shutdown(): Promise<void> {
		if (!this.proc) return;
		this.shuttingDown = true;
		if (this.respawnTimer) {
			clearTimeout(this.respawnTimer);
			this.respawnTimer = null;
		}
		try {
			// Best-effort graceful shutdown — fire the RPC and ignore the
			// response. If the sidecar is wedged, kill below cleans up.
			await Promise.race([
				this.request('shutdown'),
				new Promise((res) => setTimeout(res, 500)),
			]);
		} catch { /* */ }
		if (this.proc) {
			try { this.proc.kill(); } catch { /* */ }
			this.proc = null;
		}
	}

	private onStdout(chunk: string): void {
		this.stdoutBuf += chunk;
		// Pull complete LF-delimited lines out of the buffer; leave any
		// trailing partial line for the next chunk.
		let idx = this.stdoutBuf.indexOf('\n');
		while (idx >= 0) {
			const line = this.stdoutBuf.slice(0, idx);
			this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
			if (line.trim().length > 0) this.handleLine(line);
			idx = this.stdoutBuf.indexOf('\n');
		}
	}

	private onStderr(chunk: string): void {
		// Sidecar logs (tracing) — route into the session log, area-tagged. The
		// line's own severity text (INFO/WARN from tracing) stays in msg;
		// parsing it into levels isn't worth the fragility. Same buffering
		// rationale as stdout: log lines may split across chunks.
		this.stderrBuf += chunk;
		let idx = this.stderrBuf.indexOf('\n');
		while (idx >= 0) {
			const line = this.stderrBuf.slice(0, idx);
			this.stderrBuf = this.stderrBuf.slice(idx + 1);
			if (line.length > 0) mainLog.for('audio').info(line);
			idx = this.stderrBuf.indexOf('\n');
		}
	}

	private handleLine(line: string): void {
		let msg: unknown;
		try {
			msg = JSON.parse(line);
		} catch (e) {
			slog.error('non-JSON line from sidecar', e, { line });
			return;
		}
		if (!msg || typeof msg !== 'object') return;
		const obj = msg as Record<string, unknown>;
		// Event frame — no `id`, has `event`. Forward to subscribers.
		if (typeof obj.event === 'string') {
			const ev = msg as AudioEvent;
			this.emit('event', ev);
			// Forward to the renderer if a target is wired.
			if (this.eventTarget && !this.eventTarget.isDestroyed()) {
				try { this.eventTarget.send('audio:event', ev); } catch { /* */ }
			}
			return;
		}
		// Response frame — has `id`, plus either `result` or `error`.
		const id = typeof obj.id === 'number' ? obj.id : null;
		if (id == null) return;
		const req = this.pending.get(id);
		if (!req) return;
		this.pending.delete(id);
		if ('error' in obj && obj.error) {
			const errObj = obj.error as { kind?: string; message?: string };
			const err = new Error(errObj.message ?? 'audio sidecar error') as Error & { kind?: string };
			err.kind = errObj.kind;
			req.reject(err);
		} else {
			req.resolve(obj.result);
		}
	}

	private scheduleRespawn(): void {
		const now = Date.now();
		if (now - this.crashWindowStart > 60_000) {
			this.crashWindowStart = now;
			this.crashCount = 0;
		}
		this.crashCount++;
		if (this.crashCount > MAX_RESPAWN_BURST) {
			slog.error(`sidecar crash-looped ${this.crashCount} times in a minute — giving up. Local audio will be unavailable until app restart.`);
			return;
		}
		const delay = RESPAWN_DELAYS_MS[Math.min(this.crashCount - 1, RESPAWN_DELAYS_MS.length - 1)]!;
		slog.info('respawning sidecar', { delayMs: delay, attempt: this.crashCount });
		this.respawnTimer = setTimeout(() => {
			this.respawnTimer = null;
			this.start();
		}, delay);
	}
}
