// Smoke-drive the shim over raw stdio MCP (newline-delimited JSON-RPC) —
// the repeatable pre-Claude check. Run the desktop app first (pnpm dev),
// build the shim, then:
//
//   node apps/mcp/scripts/smoke.mjs                      # initialize + tools/list
//   node apps/mcp/scripts/smoke.mjs query_library '{"limit":3}'   # + one tools/call
//
// Exits non-zero if any step fails. Shim stderr is passed through.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'main.js');
const [toolName, toolArgsJson] = process.argv.slice(2);

const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] });

let nextId = 1;
const pending = new Map();
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
	buf += chunk;
	let nl = buf.indexOf('\n');
	while (nl >= 0) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		nl = buf.indexOf('\n');
		if (!line.trim()) continue;
		const msg = JSON.parse(line);
		if (msg.id != null && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) reject(new Error(JSON.stringify(msg.error)));
			else resolve(msg.result);
		}
	}
});

function request(method, params) {
	const id = nextId++;
	child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		setTimeout(() => {
			if (pending.delete(id)) reject(new Error(`${method} timed out`));
		}, 30_000);
	});
}

function notify(method, params) {
	child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

try {
	const init = await request('initialize', {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'curator-smoke', version: '0.0.0' },
	});
	console.log(`initialize ok — server ${init.serverInfo?.name}@${init.serverInfo?.version}`);
	notify('notifications/initialized', {});

	// Give the bridge a moment to connect to the running app before listing.
	await new Promise((r) => setTimeout(r, 1_500));

	const list = await request('tools/list', {});
	console.log(`tools/list — ${list.tools.length} tools: ${list.tools.map((t) => t.name).join(', ')}`);
	if (list.tools.length <= 1) {
		console.log('NOTE: only curator_status listed — is the Curator desktop app running?');
	}

	if (toolName) {
		const args = toolArgsJson ? JSON.parse(toolArgsJson) : {};
		const res = await request('tools/call', { name: toolName, arguments: args });
		const text = res.content?.map((c) => c.text).join('\n') ?? JSON.stringify(res);
		console.log(`tools/call ${toolName}${res.isError ? ' (ERROR)' : ''}:\n${text.slice(0, 2_000)}`);
		if (res.isError) process.exitCode = 1;
	}
} catch (err) {
	console.error('smoke failed:', err.message ?? err);
	process.exitCode = 1;
} finally {
	child.kill();
}
