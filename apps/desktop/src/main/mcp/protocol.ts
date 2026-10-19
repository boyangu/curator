// Host-side copy of the Curator MCP bridge wire protocol. Contract lives
// here; the shim's copy is apps/mcp/src/protocol.ts — keep the two in sync
// (same copy-with-comment convention as the agent sidecar). The shim is an
// independently-built program spawned by Claude Desktop, so these types ARE
// the boundary; neither side imports the other.
//
// Transport: loopback TCP, LF-delimited JSON, one frame per line. The first
// line a client sends is the raw auth token from the discovery file (not
// JSON); every line after that is a frame.

import type { WireToolSpec } from '@curator/core';

export const MCP_BRIDGE_PROTOCOL = 1;

// Written next to curator.db on listen (userData/mcp-bridge.json), rewritten
// with a fresh port + token every app launch, deleted best-effort on quit.
// Any local process that can read userData can drive the bridge — the same
// trust boundary as the DB files themselves. (DPAPI wrapping is a possible
// follow-up if that boundary ever tightens.)
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
	tools: WireToolSpec[];
}
