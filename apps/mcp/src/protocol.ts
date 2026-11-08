// The Curator MCP bridge wire protocol lives in @curator/agent-core
// (bridge.ts), shared with the desktop's bridge host. Types only at run time
// except the protocol number, which is inlined here so the shim's .mcpb
// bundle needs no workspace package: keep it equal to agent-core's (the
// bridge test asserts it).

export type { BridgeDiscovery, BridgeEventFrame, BridgeInitResult, BridgeMethod, BridgeRequestFrame, BridgeResponseFrame, ToolAnnotations, WireToolSpec } from '@curator/agent-core';

export const MCP_BRIDGE_PROTOCOL = 1;
