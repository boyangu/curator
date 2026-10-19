// Shim-side copy of the Curator MCP bridge wire protocol. Contract lives at
// apps/desktop/src/main/mcp/protocol.ts — keep the two in sync (same
// copy-with-comment convention as the agent sidecar). The shim cannot import
// from the desktop app: it is an independently-built program spawned by
// Claude Desktop, and these types ARE the boundary.
//
// Transport: loopback TCP, LF-delimited JSON, one frame per line. The first
// line the shim sends is the raw auth token from the discovery file (not
// JSON); every line after that is a frame.

export const MCP_BRIDGE_PROTOCOL = 1;

// Written by the desktop app on listen: %APPDATA%/Curator/mcp-bridge.json.
// Rewritten (new port + token) on every app launch; pid + a live TCP accept
// are the truth — the file is a hint that can go stale after a crash.
export interface BridgeDiscovery {
	protocol: number;
	port: number;
	token: string;
	pid: number;
	startedAt: number;
}

export interface WireToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
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
	tools: WireToolSpec[];
}
