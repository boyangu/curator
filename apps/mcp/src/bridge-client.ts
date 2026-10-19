// Reconnecting loopback-TCP client for the Curator bridge. Inverts the
// spotify-sidecar pattern: Claude Desktop spawns THIS process, so instead of
// being handed a port on argv we discover the running app via the discovery
// file it writes on listen (new port + token every launch). Not running is a
// supported state — `tools` goes null and the caller degrades to a
// "launch Curator" tool surface until the next successful poll.

import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { log } from './log.js';
import {
	MCP_BRIDGE_PROTOCOL,
	type BridgeDiscovery,
	type BridgeInitResult,
	type WireToolSpec,
} from './protocol.js';

const RECONNECT_POLL_MS = 3_000;
const PING_INTERVAL_MS = 30_000;
// Below the host's 150s tools/call watchdog so host-side errors (which carry
// detail: confirmation denied, tool timeout, …) win the race.
const CALL_TIMEOUT_MS = 140_000;
const INIT_TIMEOUT_MS = 10_000;

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

export class BridgeUnavailableError extends Error {
	constructor() {
		super('Curator is not running. Launch the Curator desktop app, then retry — tools refresh automatically.');
		this.name = 'BridgeUnavailableError';
	}
}

export class BridgeClient {
	// Non-null exactly while a socket is authed + initialized.
	private manifest: BridgeInitResult | null = null;
	private socket: Socket | null = null;
	private buf = '';
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private reconnectTimer: NodeJS.Timeout | null = null;
	private pingTimer: NodeJS.Timeout | null = null;
	private stopped = false;

	constructor(
		private readonly opts: {
			discoveryPath: string;
			// Fired on every availability flip AND on a re-initialize with a
			// changed manifest — the shim forwards as tools/list_changed.
			onToolsChanged: () => void;
		},
	) {}

	get tools(): WireToolSpec[] | null {
		return this.manifest?.tools ?? null;
	}

	get appVersion(): string | null {
		return this.manifest?.appVersion ?? null;
	}

	start(): void {
		this.stopped = false;
		this.tryConnect();
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
		this.teardownSocket();
	}

	async call(name: string, args: unknown): Promise<unknown> {
		if (!this.socket || !this.manifest) throw new BridgeUnavailableError();
		return this.request('tools/call', { name, args }, CALL_TIMEOUT_MS);
	}

	// ── connection lifecycle ─────────────────────────────────────────────

	private tryConnect(): void {
		if (this.stopped || this.socket) return;
		const disc = this.readDiscovery();
		if (!disc) { this.scheduleReconnect(); return; }

		const sock = connect(disc.port, '127.0.0.1');
		sock.setEncoding('utf8');
		this.socket = sock;
		this.buf = '';

		sock.on('connect', () => {
			// First line is the raw token; a mismatch gets the socket destroyed
			// host-side without a reply — surfaces as 'close' below.
			sock.write(disc.token + '\n');
			this.request('initialize', { protocol: MCP_BRIDGE_PROTOCOL, client: 'curator-mcp-shim/0.1.0' }, INIT_TIMEOUT_MS)
				.then((result) => {
					const init = result as BridgeInitResult;
					if (init.protocol !== MCP_BRIDGE_PROTOCOL) {
						log('error', 'bridge protocol mismatch', { host: init.protocol, shim: MCP_BRIDGE_PROTOCOL });
						sock.destroy();
						return;
					}
					this.manifest = init;
					log('info', 'bridge connected', { appVersion: init.appVersion, tools: init.tools.length });
					this.startPing();
					this.opts.onToolsChanged();
				})
				.catch((err) => {
					log('warn', 'bridge initialize failed', { error: String(err) });
					sock.destroy();
				});
		});
		sock.on('data', (chunk: string) => this.onData(chunk));
		sock.on('error', () => { /* surfaced via close */ });
		sock.on('close', () => {
			const wasReady = this.manifest != null;
			if (this.socket === sock) this.teardownSocket();
			if (wasReady) this.opts.onToolsChanged();
			this.scheduleReconnect();
		});
	}

	private readDiscovery(): BridgeDiscovery | null {
		let raw: string;
		try {
			raw = readFileSync(this.opts.discoveryPath, 'utf8');
		} catch {
			return null; // app never ran / cleaned up on quit
		}
		let disc: BridgeDiscovery;
		try {
			disc = JSON.parse(raw) as BridgeDiscovery;
		} catch {
			return null;
		}
		if (typeof disc.port !== 'number' || typeof disc.token !== 'string') return null;
		// Stale-file check: a crashed app leaves the file behind. pid liveness
		// is a cheap pre-filter; the connect attempt itself is the real test.
		if (typeof disc.pid === 'number') {
			try { process.kill(disc.pid, 0); } catch { return null; }
		}
		return disc;
	}

	private teardownSocket(): void {
		if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
		const sock = this.socket;
		this.socket = null;
		this.manifest = null;
		this.buf = '';
		if (sock) { try { sock.destroy(); } catch { /* */ } }
		for (const [id, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new BridgeUnavailableError());
			this.pending.delete(id);
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.tryConnect();
		}, RECONNECT_POLL_MS);
	}

	private startPing(): void {
		if (this.pingTimer) clearInterval(this.pingTimer);
		// Detects half-open sockets (app hard-killed): an unanswered ping
		// rejects and tears the socket down, which re-enters the poll loop.
		this.pingTimer = setInterval(() => {
			this.request('ping', {}, 5_000).catch(() => {
				log('warn', 'bridge ping failed — reconnecting');
				this.socket?.destroy();
			});
		}, PING_INTERVAL_MS);
	}

	// ── framing ──────────────────────────────────────────────────────────

	private request(method: 'initialize' | 'tools/call' | 'ping', params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const sock = this.socket;
			if (!sock) { reject(new BridgeUnavailableError()); return; }
			const id = this.nextId++;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`bridge request ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				sock.write(JSON.stringify({ id, method, params }) + '\n');
			} catch (e) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	private onData(chunk: string): void {
		this.buf += chunk;
		let idx = this.buf.indexOf('\n');
		while (idx >= 0) {
			const line = this.buf.slice(0, idx);
			this.buf = this.buf.slice(idx + 1);
			if (line.trim().length > 0) this.handleLine(line);
			idx = this.buf.indexOf('\n');
		}
	}

	private handleLine(line: string): void {
		let msg: unknown;
		try {
			msg = JSON.parse(line);
		} catch {
			log('warn', 'non-JSON line from bridge', { line: line.slice(0, 200) });
			return;
		}
		if (!msg || typeof msg !== 'object') return;
		const obj = msg as Record<string, unknown>;

		if (obj['event'] === 'tools-changed') {
			// Host tool surface changed mid-session — re-initialize to fetch the
			// fresh manifest, then let the shim notify the MCP client.
			this.request('initialize', { protocol: MCP_BRIDGE_PROTOCOL, client: 'curator-mcp-shim/0.1.0' }, INIT_TIMEOUT_MS)
				.then((result) => {
					this.manifest = result as BridgeInitResult;
					this.opts.onToolsChanged();
				})
				.catch(() => { /* socket close path handles it */ });
			return;
		}

		const id = typeof obj['id'] === 'number' ? obj['id'] : null;
		if (id == null) return;
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		clearTimeout(p.timer);
		const err = obj['error'] as { code?: string; message?: string } | undefined;
		if (err) {
			p.reject(new Error(err.message ?? 'bridge error'));
		} else {
			p.resolve(obj['result']);
		}
	}
}
