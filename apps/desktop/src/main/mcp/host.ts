// McpBridgeHost — the app side of the Curator MCP bridge. Listens on a
// loopback ephemeral port, writes the discovery file the shim (apps/mcp)
// reads, and dispatches bridge tool calls into the live CoreService: the
// read-only agent registry via agentRunExternalTool, plus the confirm-gated
// MCP write tools. Transport mechanics mirror SpotifySidecarHost
// (LF-delimited JSON frames, first-line token auth) with the discovery
// inverted — Claude Desktop spawns the shim, we don't spawn anything.

import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type { CoreService, McpWriteToolRegistry } from '@curator/core';
import { mainLog } from '../log.js';
import { MCP_BRIDGE_PROTOCOL, type BridgeInitResult, type BridgeRequestFrame } from './protocol.js';

const mlog = mainLog.for('mcp');

// Above the shim's 140s per-call timeout AND the write tools' 120s confirm
// timeout, so the most specific error message wins the race.
const CALL_WATCHDOG_MS = 150_000;

export interface McpBridgeHostOptions {
	core: CoreService;
	userDataDir: string;
	appVersion: string;
	// Confirm-gated write tools (buildMcpWriteTools). Kept out of the agent
	// registry by construction — see apps/core/src/mcp/write-tools.ts.
	writeTools: McpWriteToolRegistry;
}

interface ClientState {
	sock: Socket;
	buf: string;
	// Lazily created on `initialize` — one external agent session per
	// connection. Kept after disconnect: result sets live in Discover history.
	sessionId: string | null;
}

export class McpBridgeHost {
	private server: Server | null = null;
	private clients = new Set<ClientState>();
	private token = randomBytes(24).toString('hex');
	private discoveryPath: string;
	private shuttingDown = false;

	constructor(private readonly opts: McpBridgeHostOptions) {
		this.discoveryPath = join(opts.userDataDir, 'mcp-bridge.json');
	}

	start(): void {
		if (this.server) return;
		const server = createServer((sock) => this.onConnection(sock));
		server.on('error', (err) => mlog.error('bridge server error', err));
		// Loopback only — never exposed off-box. The token gates which local
		// process may drive the bridge.
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			this.server = server;
			const discovery = {
				protocol: MCP_BRIDGE_PROTOCOL,
				port,
				token: this.token,
				pid: process.pid,
				startedAt: Date.now(),
			};
			// Rewritten every launch — stale content from a crashed run is
			// simply overwritten; the shim also pid-checks before connecting.
			void writeFile(this.discoveryPath, JSON.stringify(discovery, null, '\t'), 'utf8')
				.then(() => mlog.info('bridge listening', { port }))
				.catch((err) => mlog.error('failed to write discovery file', err));
		});
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		for (const c of this.clients) {
			try { c.sock.destroy(); } catch { /* */ }
		}
		this.clients.clear();
		if (this.server) {
			try { this.server.close(); } catch { /* */ }
			this.server = null;
		}
		await unlink(this.discoveryPath).catch(() => { /* best-effort */ });
	}

	private onConnection(sock: Socket): void {
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
			if (first !== this.token) {
				mlog.warn('rejected bridge connection (bad token)');
				sock.destroy();
				return;
			}
			authed = true;
			sock.removeListener('data', onData);
			this.adoptClient(sock, rest);
		};
		sock.on('data', onData);
		sock.on('error', () => { /* surfaced via close */ });
	}

	private adoptClient(sock: Socket, leftover: string): void {
		const state: ClientState = { sock, buf: '', sessionId: null };
		this.clients.add(state);
		mlog.info('bridge client connected', { clients: this.clients.size });
		sock.on('data', (chunk: string) => this.onSocketData(state, chunk));
		sock.on('close', () => {
			this.clients.delete(state);
			if (!this.shuttingDown) mlog.info('bridge client disconnected', { clients: this.clients.size });
		});
		if (leftover.length > 0) this.onSocketData(state, leftover);
	}

	private onSocketData(state: ClientState, chunk: string): void {
		state.buf += chunk;
		let idx = state.buf.indexOf('\n');
		while (idx >= 0) {
			const line = state.buf.slice(0, idx);
			state.buf = state.buf.slice(idx + 1);
			if (line.trim().length > 0) this.handleLine(state, line);
			idx = state.buf.indexOf('\n');
		}
	}

	private handleLine(state: ClientState, line: string): void {
		let frame: BridgeRequestFrame;
		try {
			frame = JSON.parse(line) as BridgeRequestFrame;
		} catch {
			mlog.warn('non-JSON line from bridge client', { line: line.slice(0, 200) });
			return;
		}
		if (typeof frame.id !== 'number' || typeof frame.method !== 'string') return;
		void this.dispatch(state, frame)
			.then((result) => this.reply(state, { id: frame.id, result }))
			.catch((err: unknown) => this.reply(state, {
				id: frame.id,
				error: { code: 'tool-error', message: err instanceof Error ? err.message : String(err) },
			}));
	}

	private reply(state: ClientState, frame: object): void {
		try { state.sock.write(JSON.stringify(frame) + '\n'); } catch { /* client gone */ }
	}

	private async dispatch(state: ClientState, frame: BridgeRequestFrame): Promise<unknown> {
		switch (frame.method) {
			case 'ping':
				return {};
			case 'initialize': {
				if (!state.sessionId) {
					const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
					state.sessionId = this.opts.core.agentCreateExternalSession(`Claude Desktop — ${stamp}`).id;
					mlog.info('bridge session created', { sessionId: state.sessionId });
				}
				const init: BridgeInitResult = {
					protocol: MCP_BRIDGE_PROTOCOL,
					appVersion: this.opts.appVersion,
					sessionId: state.sessionId,
					tools: [...this.opts.core.agentExternalToolSpecs(), ...this.opts.writeTools.specs()],
				};
				return init;
			}
			case 'tools/call': {
				const { name, args } = frame.params as { name?: unknown; args?: unknown };
				if (typeof name !== 'string') throw new Error('tools/call requires a tool name');
				if (!state.sessionId) throw new Error('bridge client is not initialized');
				const run = this.opts.writeTools.has(name)
					? this.opts.writeTools.execute(name, args)
					: this.opts.core.agentRunExternalTool({ sessionId: state.sessionId, name, args });
				// Watchdog: a hung tool must not leak a shim call forever. The
				// underlying promise is not cancelled — same policy as the agent
				// sidecar manager — but the shim gets a timely error.
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					return await Promise.race([
						run,
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error(`${name} timed out host-side after ${CALL_WATCHDOG_MS}ms`)), CALL_WATCHDOG_MS);
						}),
					]);
				} finally {
					if (timer) clearTimeout(timer);
				}
			}
			default:
				throw new Error(`unknown bridge method: ${String(frame.method)}`);
		}
	}
}
