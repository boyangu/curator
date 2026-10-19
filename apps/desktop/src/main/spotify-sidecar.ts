// Node-side manager for the Spotify playback sidecar (apps/spotify-player/).
//
// Like AudioSidecarHost (audio-sidecar.ts) it owns spawn + lifecycle + bounded
// crash-respawn and exposes an id-correlated request() API with event
// forwarding to the renderer. The transport differs: the audio sidecar is a
// Rust process that speaks JSON-RPC over stdio, but an ELECTRON main process
// can't reliably READ piped stdin (it sees immediate EOF) and dribbles stray
// bytes onto stdout. So host ↔ sidecar talk over a loopback TCP socket instead:
// the host listens on 127.0.0.1:<ephemeral>, the child connects and proves
// itself with a one-time nonce. stderr stays piped for logs. Wire framing
// (LF-delimited JSON frames) matches apps/spotify-player/src/main.ts.

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { WebContents } from 'electron';
import { mainLog } from './log.js';
import type { SpotifyEvent } from '../ipc.js';

const slog = mainLog.for('spotify');

export interface SpotifySidecarOptions {
	executable: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export interface SpotifySidecarDeps {
	// Returns a fresh Spotify access token (or null when disconnected). Wired
	// to svc.auth.getSpotifyAccessToken() in main — invoked each time the SDK
	// asks for a token via a `need_token` event.
	getToken: () => Promise<string | null>;
}

const RESPAWN_DELAYS_MS = [200, 500, 1000, 2000, 5000, 15000];
const MAX_RESPAWN_BURST = 6;

interface PendingRequest {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	method: string;
}

export class SpotifySidecarHost extends EventEmitter {
	private opts: SpotifySidecarOptions;
	private deps: SpotifySidecarDeps;
	private proc: ChildProcess | null = null;
	private server: Server | null = null;
	private serverReady: Promise<number> | null = null;
	private nonce = randomBytes(24).toString('hex');
	private socket: Socket | null = null;
	private socketAuthed = false;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private socketBuf = '';
	private stderrBuf = '';
	// Frames written before the child's socket connects — flushed on auth.
	private writeQueue: string[] = [];
	private crashCount = 0;
	private crashWindowStart = 0;
	private respawnTimer: NodeJS.Timeout | null = null;
	private shuttingDown = false;
	private eventTarget: WebContents | null = null;

	constructor(opts: SpotifySidecarOptions, deps: SpotifySidecarDeps) {
		super();
		this.opts = opts;
		this.deps = deps;
	}

	setEventTarget(wc: WebContents | null): void {
		this.eventTarget = wc;
	}

	start(): void {
		if (this.proc) return;
		this.shuttingDown = false;
		this.ensureServer()
			.then((port) => { if (!this.shuttingDown) this.spawnChild(port); })
			.catch((err) => slog.error('failed to start RPC server', err));
	}

	private ensureServer(): Promise<number> {
		if (this.serverReady) return this.serverReady;
		this.serverReady = new Promise<number>((resolve, reject) => {
			const server = createServer((sock) => this.onConnection(sock));
			server.on('error', (err) => {
				slog.error('RPC server error', err);
				reject(err);
			});
			// Loopback only — never exposed off-box. The nonce gates which
			// local process may drive the sidecar.
			server.listen(0, '127.0.0.1', () => {
				const addr = server.address();
				const port = typeof addr === 'object' && addr ? addr.port : 0;
				this.server = server;
				resolve(port);
			});
		});
		return this.serverReady;
	}

	private onConnection(sock: Socket): void {
		// Only one live child at a time. A stray connector that doesn't lead
		// with the nonce is dropped.
		let authed = false;
		let buf = '';
		sock.setEncoding('utf8');
		const onData = (chunk: string): void => {
			if (authed) return; // post-auth handling swapped in below
			buf += chunk;
			const nl = buf.indexOf('\n');
			if (nl < 0) return;
			const first = buf.slice(0, nl);
			const rest = buf.slice(nl + 1);
			if (first !== this.nonce) {
				slog.warn('rejected RPC connection (bad nonce)');
				sock.destroy();
				return;
			}
			authed = true;
			sock.removeListener('data', onData);
			this.adoptSocket(sock, rest);
		};
		sock.on('data', onData);
		sock.on('error', () => { /* surfaced via close */ });
	}

	private adoptSocket(sock: Socket, leftover: string): void {
		this.socket = sock;
		this.socketAuthed = true;
		this.socketBuf = '';
		sock.on('data', (chunk: string) => this.onSocketData(chunk));
		sock.on('close', () => {
			if (this.socket === sock) {
				this.socket = null;
				this.socketAuthed = false;
			}
		});
		// Flush anything queued before the child connected, then any bytes that
		// arrived in the same chunk as the nonce.
		const queued = this.writeQueue.splice(0);
		for (const frame of queued) sock.write(frame);
		if (leftover.length > 0) this.onSocketData(leftover);
	}

	private spawnChild(port: number): void {
		if (this.proc) return;
		const args = [...(this.opts.args ?? []), `--rpc-port=${port}`, `--rpc-nonce=${this.nonce}`];
		const proc = spawn(this.opts.executable, args, {
			cwd: this.opts.cwd,
			env: { ...process.env, ...(this.opts.env ?? {}) },
			// stdin/stdout unused (socket carries the protocol); stderr piped
			// for the sidecar's logs.
			stdio: ['ignore', 'ignore', 'pipe'],
			windowsHide: true,
		});

		proc.stderr?.setEncoding('utf8');
		proc.stderr?.on('data', (chunk: string) => this.onStderr(chunk));
		proc.on('exit', (code, signal) => {
			slog.warn('sidecar exited', { code, signal });
			this.proc = null;
			if (this.socket) { try { this.socket.destroy(); } catch { /* */ } this.socket = null; }
			this.socketAuthed = false;
			this.writeQueue = [];
			for (const [id, req] of this.pending) {
				req.reject(new Error(`spotify sidecar exited (code=${code}) during ${req.method}`));
				this.pending.delete(id);
			}
			if (!this.shuttingDown) this.scheduleRespawn();
		});
		proc.on('error', (err) => {
			slog.error('sidecar spawn error', err);
		});
		this.proc = proc;
		slog.info('sidecar started', { pid: proc.pid, rpcPort: port });
	}

	// JSON-RPC request. Resolves with the sidecar's `result`, or rejects with
	// an Error carrying the typed `error.kind` (e.g. 'track_unavailable'). The
	// kind doesn't survive ipcRenderer.invoke, so the renderer disambiguates on
	// the message string — see player.ts playSpotify.
	request(method: string, params?: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.proc) {
				reject(new Error(`spotify sidecar not running (request: ${method})`));
				return;
			}
			const id = this.nextId++;
			this.pending.set(id, { resolve, reject, method });
			const frame = JSON.stringify({ id, method, params: params ?? {} }) + '\n';
			if (this.socket && this.socketAuthed) {
				try { this.socket.write(frame); }
				catch (e) { this.pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
			} else {
				// Child spawned but its socket hasn't connected/authed yet —
				// buffer; flushed in adoptSocket. A child that never connects
				// rejects this via the 'exit' handler.
				this.writeQueue.push(frame);
			}
		});
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.respawnTimer) {
			clearTimeout(this.respawnTimer);
			this.respawnTimer = null;
		}
		if (this.proc) {
			try {
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
		if (this.server) {
			try { this.server.close(); } catch { /* */ }
			this.server = null;
			this.serverReady = null;
		}
	}

	private onSocketData(chunk: string): void {
		this.socketBuf += chunk;
		let idx = this.socketBuf.indexOf('\n');
		while (idx >= 0) {
			const line = this.socketBuf.slice(0, idx);
			this.socketBuf = this.socketBuf.slice(idx + 1);
			if (line.trim().length > 0) this.handleLine(line);
			idx = this.socketBuf.indexOf('\n');
		}
	}

	private onStderr(chunk: string): void {
		this.stderrBuf += chunk;
		let idx = this.stderrBuf.indexOf('\n');
		while (idx >= 0) {
			const line = this.stderrBuf.slice(0, idx);
			this.stderrBuf = this.stderrBuf.slice(idx + 1);
			if (line.length > 0) mainLog.for('spotify').info(line);
			idx = this.stderrBuf.indexOf('\n');
		}
	}

	private handleLine(line: string): void {
		let msg: unknown;
		try {
			msg = JSON.parse(line);
		} catch {
			slog.error('non-JSON line from sidecar', undefined, { line });
			return;
		}
		if (!msg || typeof msg !== 'object') return;
		const obj = msg as Record<string, unknown>;

		if (typeof obj.event === 'string') {
			// need_token is handled here, not forwarded — fetch a fresh token
			// and push it back so the SDK's getOAuthToken callback resolves.
			if (obj.event === 'need_token') {
				this.deps.getToken()
					.then((token) => this.request('set_token', { token }))
					.catch((err) => slog.error('token fetch failed', err));
				return;
			}
			const ev = msg as SpotifyEvent;
			this.emit('event', ev);
			if (this.eventTarget && !this.eventTarget.isDestroyed()) {
				try { this.eventTarget.send('spotify:event', ev); } catch { /* */ }
			}
			return;
		}

		const id = typeof obj.id === 'number' ? obj.id : null;
		if (id == null) return;
		const req = this.pending.get(id);
		if (!req) return;
		this.pending.delete(id);
		if ('error' in obj && obj.error) {
			const errObj = obj.error as { kind?: string; message?: string };
			const err = new Error(errObj.message ?? 'spotify sidecar error') as Error & { kind?: string };
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
			slog.error(`sidecar crash-looped ${this.crashCount} times in a minute — giving up. Spotify playback unavailable until app restart.`);
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
