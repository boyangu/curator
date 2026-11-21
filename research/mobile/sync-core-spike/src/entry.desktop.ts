// The desktop half of the spike (Node + better-sqlite3): everything the phone
// bundle has, plus what only prepares the inputs — the schema, the master's
// snapshot builder and the outbox reader.

export * from './entry.core.js';
export { migrate } from '../../../../apps/core/src/db/migrate.js';
export { buildSnapshotParts } from '../../../../apps/core/src/sync-log/snapshot-build.js';
export { compareDumps } from '../../../../apps/core/src/sync-log/dump.js';
export { readOutbox } from '../../../../apps/core/src/sync-log/outbox.js';
export { MASTER_DEVICE_SETTING } from '../../../../packages/protocol/src/index.js';
export { drainArtistCreditRewrites } from '../../../../apps/core/src/library/artist-alias.js';
