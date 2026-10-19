// Main-process owner of the core sidecar (the Node sub-process running
// apps/desktop/src/main/core-sidecar/entry.ts).
//
// Responsibilities:
//   1. Fork the sidecar via app.utilityProcess.fork and keep it alive.
//   2. `await ready()` returns once the sidecar has constructed core and
//      finished migrations — main blocks renderer-window-open on this.
//   3. `call(method, args)` is the forward-RPC entry point that
//      apps/desktop/src/main/handlers.ts uses to delegate IPC channels to
//      the sidecar.
//   4. Event frames from the sidecar fan out to every BrowserWindow on
//      the channel name carried in the frame (no per-channel wiring
//      needed in main).
//   5. Reverse-RPC frames (host-call) get routed to a method-name → fn
//      table that the caller registers via `onHostCall(method, fn)`.
//   6. Crashes: in-flight calls reject with `sidecar_unavailable`;
//      sidecar respawns with exponential backoff. The renderer treats
//      that error like a transient network failure.

import { app, BrowserWindow, utilityProcess, type UtilityProcess } from 'electron';
import { mainLog } from '../log.js';
import type {
	CallFrame,
	HostCallFrame,
	HostErrorFrame,
	HostResultFrame,
	MainToSidecar,
	SidecarToMain,
} from './protocol.js';

const slog = mainLog.for('core-sidecar');

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

type HostHandler = (args: unknown[]) => Promise<unknown> | unknown;

// Respawn pacing. Cribbed from AnalyzerSidecar — short delays for the
// common transient crash, capped so a crash-loop doesn't hammer the OS.
const RESPAWN_DELAYS_MS = [500, 1000, 2000, 5000, 10000, 30000];
const MAX_RESPAWN_BURST = 6;

export interface CoreSidecarOptions {
	// Path to the bundled sidecar entry (out/main/core-sidecar.cjs). Resolved
	// by the caller because __dirname differs between dev and packaged builds.
	scriptPath: string;
	// Env to pass into the sub-process. Currently just CURATOR_DB_PATH;
	// later steps will add CURATOR_PEAKS_DIR, analyzer/rekordbox specs, etc.
	env: NodeJS.ProcessEnv;
}

export class CoreSidecarHost {
	private proc: UtilityProcess | null = null;
	private nextCallId = 1;
	private pendingCalls = new Map<number, PendingCall>();
	private readyPromise: Promise<void> | null = null;
	private resolveReady: (() => void) | null = null;
	private rejectReady: ((err: Error) => void) | null = null;
	private hostHandlers = new Map<string, HostHandler>();
	private respawnAttempts = 0;
	private respawnBurstAt = 0;
	private respawnTimer: NodeJS.Timeout | null = null;
	private shuttingDown = false;

	constructor(private readonly opts: CoreSidecarOptions) {}

	/** Spawn the sub-process. Idempotent — calling twice while alive is a no-op. */
	start(): void {
		if (this.proc) return;
		this.shuttingDown = false;
		this.readyPromise = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});

		const proc = utilityProcess.fork(this.opts.scriptPath, [], {
			serviceName: 'curator-core',
			stdio: 'pipe',
			env: { ...process.env, ...this.opts.env },
		});
		this.proc = proc;

		proc.on('message', (data: unknown) => this.onMessage(data as SidecarToMain));
		proc.on('exit', (code: number) => this.onExit(code));
		proc.on('error', (type: string, location: string, report: string) => {
			slog.error('fatal', undefined, { type, location });
			if (report) slog.error('report', undefined, { report });
		});
		// Stray non-logger output only — structured records travel over the
		// message port as `log` frames (see entry.ts). What's left here is
		// crash dumps, third-party prints, and the pre-logger fatal guards, so
		// stderr rates warn and stdout debug.
		const pipeLines = (buf: { s: string }, chunk: string, write: (line: string) => void): void => {
			buf.s += chunk;
			let idx = buf.s.indexOf('\n');
			while (idx >= 0) {
				const line = buf.s.slice(0, idx);
				buf.s = buf.s.slice(idx + 1);
				if (line.length > 0) write(line);
				idx = buf.s.indexOf('\n');
			}
		};
		const errBuf = { s: '' };
		const outBuf = { s: '' };
		if (proc.stderr) {
			proc.stderr.setEncoding('utf8');
			proc.stderr.on('data', (chunk: string) => pipeLines(errBuf, chunk, (l) => mainLog.for('core-sidecar').warn(l)));
		}
		if (proc.stdout) {
			proc.stdout.setEncoding('utf8');
			proc.stdout.on('data', (chunk: string) => pipeLines(outBuf, chunk, (l) => mainLog.for('core-sidecar').debug(l)));
		}
	}

	/** Resolves when the sidecar has emitted its `ready` frame. */
	ready(): Promise<void> {
		if (!this.readyPromise) {
			throw new Error('core sidecar not started — call start() first');
		}
		return this.readyPromise;
	}

	/** Forward an IPC channel call into the sidecar. */
	call<T = unknown>(method: string, args: unknown[]): Promise<T> {
		const proc = this.proc;
		if (!proc) {
			return Promise.reject(new Error('sidecar_unavailable'));
		}
		const id = this.nextCallId++;
		return new Promise<T>((resolve, reject) => {
			this.pendingCalls.set(id, { resolve: resolve as (v: unknown) => void, reject });
			const frame: CallFrame = { kind: 'call', id, method, args };
			try {
				proc.postMessage(frame);
			} catch (err) {
				this.pendingCalls.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/** Register a handler for a reverse-RPC method. Returns an unregister fn. */
	onHostCall(method: string, fn: HostHandler): () => void {
		this.hostHandlers.set(method, fn);
		return () => this.hostHandlers.delete(method);
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; }
		const proc = this.proc;
		if (!proc) return;
		// Ask the sidecar to close core (which tears down its analyzer +
		// rekordbox child processes) and exit on its own, THEN fall back to
		// kill(). A bare kill() terminates only this process, not its Python
		// descendants — on Windows there's no tree-kill — so the children
		// would orphan. Bounded wait so a wedged sidecar can't freeze app
		// quit; if we do fall through to kill(), each child sidecar still
		// self-exits on stdin EOF as the backstop.
		try { proc.postMessage({ kind: 'shutdown' } satisfies MainToSidecar); } catch { /* already gone */ }
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, 2000);
			proc.once('exit', () => { clearTimeout(t); resolve(); });
		});
		if (this.proc) {
			try { this.proc.kill(); } catch { /* already dying */ }
			this.proc = null;
		}
	}

	// ─── private ─────────────────────────────────────────────────────────

	private onMessage(msg: SidecarToMain | undefined): void {
		if (!msg) return;
		switch (msg.kind) {
			case 'ready':
				if (this.resolveReady) {
					this.resolveReady();
					this.resolveReady = null;
					this.rejectReady = null;
				}
				return;
			case 'result':
			case 'error': {
				const pending = this.pendingCalls.get(msg.id);
				if (!pending) return;
				this.pendingCalls.delete(msg.id);
				if (msg.kind === 'result') pending.resolve(msg.value);
				else {
					const err = new Error(msg.message) as Error & { kind?: string };
					if (msg.errKind) err.kind = msg.errKind;
					pending.reject(err);
				}
				return;
			}
			case 'event':
				this.fanoutEvent(msg.channel, msg.payload);
				return;
			case 'host-call':
				this.handleHostCall(msg);
				return;
			case 'log':
				// Already level-filtered and proc-stamped ('core') in the sidecar —
				// emit() writes straight to main's sinks so the app shares one
				// JSONL timeline.
				mainLog.emit(msg.record);
				return;
		}
	}

	private fanoutEvent(channel: string, payload: unknown): void {
		for (const w of BrowserWindow.getAllWindows()) {
			if (!w.isDestroyed()) w.webContents.send(channel, payload);
		}
	}

	private async handleHostCall(frame: HostCallFrame): Promise<void> {
		const fn = this.hostHandlers.get(frame.method);
		const proc = this.proc;
		if (!proc) return;
		if (!fn) {
			const errFrame: HostErrorFrame = {
				kind: 'host-error',
				id: frame.id,
				message: `unknown host-call: ${frame.method}`,
			};
			try { proc.postMessage(errFrame satisfies MainToSidecar); } catch { /* sidecar gone */ }
			return;
		}
		try {
			const value = await fn(frame.args);
			const okFrame: HostResultFrame = { kind: 'host-result', id: frame.id, value };
			try { proc.postMessage(okFrame satisfies MainToSidecar); } catch { /* sidecar gone */ }
		} catch (err) {
			const errFrame: HostErrorFrame = {
				kind: 'host-error',
				id: frame.id,
				message: err instanceof Error ? err.message : String(err),
			};
			try { proc.postMessage(errFrame satisfies MainToSidecar); } catch { /* sidecar gone */ }
		}
	}

	private onExit(code: number): void {
		slog.warn('exited', { code, pending: this.pendingCalls.size });
		this.proc = null;
		// Reject every in-flight call — caller decides retry policy.
		for (const [, p] of this.pendingCalls) {
			const err = new Error('sidecar_unavailable') as Error & { kind?: string };
			err.kind = 'sidecar_unavailable';
			p.reject(err);
		}
		this.pendingCalls.clear();
		// If the sidecar died before reporting ready, fail the ready promise
		// so main's boot sequence can decide what to do.
		if (this.rejectReady) {
			this.rejectReady(new Error(`sidecar exited before ready (code=${code})`));
			this.resolveReady = null;
			this.rejectReady = null;
		}
		if (this.shuttingDown) return;
		this.scheduleRespawn();
	}

	private scheduleRespawn(): void {
		if (!app.isReady()) return; // app already shutting down
		const now = Date.now();
		if (now - this.respawnBurstAt > 60_000) {
			this.respawnBurstAt = now;
			this.respawnAttempts = 0;
		}
		if (this.respawnAttempts >= MAX_RESPAWN_BURST) {
			slog.error('respawn limit reached — disabled. Investigate logs.');
			return;
		}
		const delay = RESPAWN_DELAYS_MS[Math.min(this.respawnAttempts, RESPAWN_DELAYS_MS.length - 1)]!;
		this.respawnAttempts++;
		this.respawnTimer = setTimeout(() => {
			this.respawnTimer = null;
			slog.info('respawning', { attempt: this.respawnAttempts });
			this.start();
		}, delay);
	}
}
