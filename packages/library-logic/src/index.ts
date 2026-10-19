// Pure library logic shared by the desktop, the cloud and the phone: ISRC
// canonicalisation, recording keys, version parsing, the three-way field/cue
// merge, override application and the playlist positional-move plan.
//
// What belongs: deterministic functions over plain data. What never does:
// drizzle, node:*, electron, better-sqlite3, I/O of any kind — the cloud
// service and the phone import this package, and the desktop's SQLite
// dialect must not come along for the ride. scripts/check-package-boundaries.mjs
// enforces the import list in this package's typecheck.

export * from './isrc.js';
export * from './recording-key.js';
export * from './version.js';
export * from './merge.js';
export * from './overrides.js';
export * from './reorder-moves.js';
