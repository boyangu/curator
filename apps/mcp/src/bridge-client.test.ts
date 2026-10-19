// BridgeClient against a fixture TCP server speaking the bridge protocol:
// token auth, LF framing across split chunks, unavailable state, and
// reconnect after a host restart with a fresh port + token (discovery file
// re-read each attempt). mkdtemp discovery files only — never the real
// userData one.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BridgeClient, BridgeUnavailableError } from './bridge-client.js';
import { MCP_BRIDGE_PROTOCOL } from './protocol.js';

const TOOLS = [{ name: 'query_library', description: 'q', parameters: { type: 'object' } }];

// Minimal host fixture: first line must equal `token`, then LF-JSON frames.
// initialize/ping/tools-call answered; tools/call echoes its args back.
function makeHost(token: string): Promise<{ server: Server; port: number; sockets: Set<Socket>; close: () => Promise<void> }> {
	const sockets = new Set<Socket>();
	const server = createServer((sock) => {
		sockets.add(sock);
		sock.setEncoding('utf8');
		let authed = false;
		let buf = '';
		sock.on('data', (chunk: string) => {
			buf += chunk;
			let nl = buf.indexOf('\n');
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				nl = buf.indexOf('\n');
				if (!authed) {
					if (line !== token) { sock.destroy(); return; }
					authed = true;
					continue;
				}
				const frame = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
				const reply = (obj: object) => {
					const wire = JSON.stringify(obj) + '\n';
					// Split writes mid-frame to exercise chunk reassembly.
					sock.write(wire.slice(0, 5));
					sock.write(wire.slice(5));
				};
				if (frame.method === 'initialize') {
					reply({ id: frame.id, result: { protocol: MCP_BRIDGE_PROTOCOL, appVersion: 'test', sessionId: 's1', tools: TOOLS } });
				} else if (frame.method === 'ping') {
					reply({ id: frame.id, result: {} });
				} else if (frame.method === 'tools/call') {
					if ((frame.params['name'] as string) === 'boom') reply({ id: frame.id, error: { code: 'tool-error', message: 'kaboom' } });
					else reply({ id: frame.id, result: { echoed: frame.params } });
				}
			}
		});
		sock.on('error', () => { /* */ });
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				server,
				port,
				sockets,
				close: () => new Promise((res) => {
					for (const s of sockets) s.destroy();
					server.close(() => res());
				}),
			});
		});
	});
}

const waitFor = async (cond: () => boolean, ms = 5000): Promise<void> => {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 20));
	}
};

describe('BridgeClient', () => {
	let dir: string;
	let discoveryPath: string;
	let client: BridgeClient | null = null;
	let changes: number;

	const writeDiscovery = (port: number, token: string, pid = process.pid): void => {
		writeFileSync(discoveryPath, JSON.stringify({ protocol: MCP_BRIDGE_PROTOCOL, port, token, pid, startedAt: 1 }));
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'curator-mcp-bridge-'));
		discoveryPath = join(dir, 'mcp-bridge.json');
		changes = 0;
	});

	afterEach(() => {
		client?.stop();
		client = null;
		rmSync(dir, { recursive: true, force: true });
	});

	it('connects, authenticates, exposes the manifest and forwards calls', async () => {
		const host = await makeHost('tok-1');
		writeDiscovery(host.port, 'tok-1');
		client = new BridgeClient({ discoveryPath, onToolsChanged: () => changes++ });
		client.start();
		await waitFor(() => client!.tools != null);
		expect(client.tools!.map((t) => t.name)).toEqual(['query_library']);
		expect(changes).toBe(1);

		const result = await client.call('query_library', { genre: 'House' });
		expect(result).toEqual({ echoed: { name: 'query_library', args: { genre: 'House' } } });
		await expect(client.call('boom', {})).rejects.toThrow('kaboom');
		await host.close();
	});

	it('is unavailable without a discovery file or with a dead pid', async () => {
		client = new BridgeClient({ discoveryPath, onToolsChanged: () => changes++ });
		client.start();
		expect(client.tools).toBeNull();
		await expect(client.call('query_library', {})).rejects.toThrow(BridgeUnavailableError);

		// Dead pid: file exists but the app crashed — still unavailable.
		writeDiscovery(1, 'tok', 999_999_999);
		await new Promise((r) => setTimeout(r, 100));
		expect(client.tools).toBeNull();
	});

	it('reconnects after a host restart with a NEW port and token', async () => {
		const first = await makeHost('tok-old');
		writeDiscovery(first.port, 'tok-old');
		client = new BridgeClient({ discoveryPath, onToolsChanged: () => changes++ });
		client.start();
		await waitFor(() => client!.tools != null);

		// App "restarts": old server gone, new one on a fresh port + token,
		// discovery file rewritten. The client must flip to unavailable
		// (rejecting in-flight state) and then pick up the new endpoint.
		await first.close();
		await waitFor(() => client!.tools == null);
		const second = await makeHost('tok-new');
		writeDiscovery(second.port, 'tok-new');
		await waitFor(() => client!.tools != null, 10_000);
		const result = await client.call('query_library', {});
		expect(result).toMatchObject({ echoed: { name: 'query_library' } });
		// availability flipped: up, down, up again
		expect(changes).toBe(3);
		await second.close();
	});
});
