// @curator/agent-core — the agent foundation shared by every surface that
// runs a model loop: the desktop agent sidecar (apps/agent) and its host
// (apps/core/src/agent), the cloud catalogue reasoner (apps/cloud), the
// research sidecar and the MCP shim.
//
// Pure TypeScript with no dependencies: no node:*, no SQLite, no zod (core
// pins zod 3, the sidecar zod 4 — schemas cross as plain JSON Schema). The
// package is loaded by Node, the Electron main process and, later, a React
// Native app, so anything runtime-specific (a provider SDK, a database, a
// process boundary) is an adapter in the consuming app, behind the seams in
// harness/types.ts. scripts/check-package-boundaries.mjs enforces the
// import list in this package's typecheck.

export * from './protocol.js';
export * from './harness/types.js';
export { capToolResult, defaultLoop } from './harness/loop.js';
export * from './harness/status.js';
export * from './decision.js';
export * from './prompts/assemble.js';
