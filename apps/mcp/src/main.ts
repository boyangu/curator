// Curator MCP shim — the stdio MCP server Claude Desktop spawns. Deliberately
// dumb: the tool manifest comes verbatim from the running Curator app over
// the loopback bridge (WireToolSpec JSON Schemas registered 1:1), and every
// tools/call is forwarded. Tool changes therefore only need a Curator
// restart, never a Claude Desktop restart. When the app isn't running the
// shim degrades to a single curator_status tool with a "launch Curator"
// message instead of failing registration.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BridgeClient, BridgeUnavailableError } from './bridge-client.js';
import { log } from './log.js';

const SHIM_VERSION = '0.1.0';

// Mirrors Electron's app.getPath('userData') for app name "Curator".
function defaultDiscoveryPath(): string {
	const env = process.env['CURATOR_MCP_BRIDGE_FILE'];
	if (env) return env;
	if (process.platform === 'win32') {
		return join(process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'Curator', 'mcp-bridge.json');
	}
	if (process.platform === 'darwin') {
		return join(homedir(), 'Library', 'Application Support', 'Curator', 'mcp-bridge.json');
	}
	return join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'Curator', 'mcp-bridge.json');
}

if (process.argv.includes('--print-config')) {
	// DX helper: the snippet to paste into claude_desktop_config.json.
	const entry = { mcpServers: { curator: { command: 'node', args: [join(import.meta.dirname, 'main.js')] } } };
	process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
	process.exit(0);
}

// ── MCP Apps widget (PROTOTYPE, flag-gated) ─────────────────────────────
// CURATOR_MCP_UI=1 registers the track-list widget as a ui:// resource and
// decorates the list-shaped tools with _meta.ui so a rendering-capable host
// (Claude Desktop / claude.ai) shows the table inline. Off (the default),
// behavior is byte-identical to plain tools — Claude Desktop's stdio widget
// rendering has open bugs, so this stays a prototype until verified live.
const UI_ENABLED = process.env['CURATOR_MCP_UI'] === '1';
const WIDGET_URI = 'ui://curator/track-list.html';
const WIDGET_MIME = 'text/html;profile=mcp-app';
const WIDGET_TOOLS = new Set(['query_library', 'get_library_favorites', 'get_playlist_tracks']);
const WIDGET_META = {
	ui: {
		resourceUri: WIDGET_URI,
		// Spotify cover art host; everything else stays deny-all per spec.
		csp: { resourceDomains: ['https://i.scdn.co'] },
	},
};

function readWidgetHtml(): string | null {
	try {
		// dist/main.js → ../widget/track-list.html (no build step; the widget
		// is a committed single file).
		return readFileSync(join(import.meta.dirname, '..', 'widget', 'track-list.html'), 'utf8');
	} catch {
		return null;
	}
}

const STATUS_TOOL = {
	name: 'curator_status',
	description: 'Report whether the Curator desktop app is running and reachable. When it is not, the other Curator tools are unavailable until the app is launched.',
	inputSchema: { type: 'object', properties: {} },
} as const;

const server = new Server(
	{ name: 'curator', version: SHIM_VERSION },
	{ capabilities: { tools: { listChanged: true }, ...(UI_ENABLED ? { resources: {} } : {}) } },
);

let transportConnected = false;
const bridge = new BridgeClient({
	discoveryPath: defaultDiscoveryPath(),
	onToolsChanged: () => {
		if (!transportConnected) return;
		server.notification({ method: 'notifications/tools/list_changed' }).catch((err) => {
			log('warn', 'tools/list_changed notification failed', { error: String(err) });
		});
	},
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
	const tools = bridge.tools;
	return {
		tools: [
			STATUS_TOOL,
			...(tools ?? []).map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.parameters as { type: 'object'; [k: string]: unknown },
				...(UI_ENABLED && WIDGET_TOOLS.has(t.name) ? { _meta: WIDGET_META } : {}),
			})),
		],
	};
});

if (UI_ENABLED) {
	server.setRequestHandler(ListResourcesRequestSchema, async () => ({
		resources: readWidgetHtml() != null
			? [{ uri: WIDGET_URI, name: 'Curator track list', mimeType: WIDGET_MIME, _meta: WIDGET_META }]
			: [],
	}));
	server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
		if (req.params.uri !== WIDGET_URI) throw new Error(`unknown resource: ${req.params.uri}`);
		const html = readWidgetHtml();
		if (html == null) throw new Error('widget HTML missing (apps/mcp/widget/track-list.html)');
		return { contents: [{ uri: WIDGET_URI, mimeType: WIDGET_MIME, text: html }] };
	});
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	const { name, arguments: args } = req.params;
	if (name === STATUS_TOOL.name) {
		return bridge.tools
			? text(`Curator is running (app version ${bridge.appVersion ?? 'unknown'}); ${bridge.tools.length} tools available.`)
			: text('Curator is NOT running. Ask the user to launch the Curator desktop app — tools refresh automatically once it is up.');
	}
	try {
		const result = await bridge.call(name, args ?? {});
		return text(typeof result === 'string' ? result : JSON.stringify(result));
	} catch (err) {
		const message = err instanceof BridgeUnavailableError
			? err.message
			: `Curator tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
		return { ...text(message), isError: true };
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
transportConnected = true;
bridge.start();
log('info', 'curator MCP shim started', { discovery: defaultDiscoveryPath() });

// Claude Desktop closes stdin to stop the server.
process.stdin.on('close', () => {
	bridge.stop();
	process.exit(0);
});
