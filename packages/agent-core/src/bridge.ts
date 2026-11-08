// The Curator MCP bridge wire protocol — one copy, shared by the desktop's
// bridge host (apps/desktop/src/main/mcp/host.ts, through @curator/core) and
// the shim Claude Desktop spawns (apps/mcp). Both used to keep a hand-synced
// copy; the shim imports types only, so its .mcpb bundle still carries no
// workspace package at run time.
//
// Transport: loopback TCP, LF-delimited JSON, one frame per line. The first
// line a client sends is the raw auth token from the discovery file (not
// JSON); every line after that is a frame.

import type { WireToolSpec } from './protocol.js';

export const MCP_BRIDGE_PROTOCOL = 1;

// Written next to curator.db on listen (userData/mcp-bridge.json), rewritten
// with a fresh port + token every app launch, deleted best-effort on quit.
// Any local process that can read userData can drive the bridge — the same
// trust boundary as the DB files themselves. pid + a live TCP accept are the
// truth; the file is a hint that can go stale after a crash.
export interface BridgeDiscovery {
	protocol: number;
	port: number;
	token: string;
	pid: number;
	startedAt: number;
}

export type BridgeMethod = 'initialize' | 'tools/call' | 'ping';

export interface BridgeRequestFrame {
	id: number;
	method: BridgeMethod;
	params: Record<string, unknown>;
}

export type BridgeResponseFrame =
	| { id: number; result: unknown }
	| { id: number; error: { code: string; message: string } };

// Host-pushed, no id. 'tools-changed' → the shim re-initializes and sends
// MCP notifications/tools/list_changed.
export type BridgeEventFrame = { event: 'tools-changed' };

export interface BridgeInitResult {
	protocol: number;
	appVersion: string;
	sessionId: string;
	// With annotations: outside models see each tool's hints.
	tools: WireToolSpec[];
}
