// The wire and merge contract shared by the desktop, the cloud and the phone:
// op schemas, the pure reducer with every merge rule, fractional order keys,
// the hybrid-lite clock and the `CloudService` surface. One implementation
// for all three, so a byte that leaves one of them is understood by the
// others and the same ops in any order reach the same state.
//
// This package may import only zod. No node:*, no drizzle, no electron, no
// @curator/core — the cloud service and the phone load it, and the desktop's
// SQLite stack must not come along. A boundary script enforces the list once
// B2 lands; until then keep it honest by hand.

export * from './ops.js';
export * from './order-key.js';
export * from './rb-grid.js';
export * from './clock.js';
export * from './state.js';
export * from './reduce.js';
export * from './cloud-service.js';
export * from './sync-input.js';
export * from './snapshot.js';
export * from './catalogue.js';
export * from './catalogue-pack.js';
