// The Curator MCP bridge wire protocol lives in @curator/agent-core
// (bridge.ts), shared with the shim (apps/mcp); re-exported here through
// @curator/core so the bridge host's imports stay local.

export { MCP_BRIDGE_PROTOCOL } from '@curator/core';
export type { BridgeDiscovery, BridgeEventFrame, BridgeInitResult, BridgeMethod, BridgeRequestFrame, BridgeResponseFrame, WireToolSpec } from '@curator/core';
