// The desktop half of the spike (Node + better-sqlite3): everything the phone
// bundle has, plus what only prepares the inputs — the schema, the master's
// snapshot builder and the outbox reader.

export * from './entry.core.js';
export { migrate } from '@curator/sync-core/db/migrate';
export { buildSnapshotParts } from '@curator/sync-core/sync-log/snapshot-build';
export { buildReplica } from '@curator/sync-core/sync-log/replica';
export { compareDumps } from '@curator/sync-core/sync-log/dump';
export { readOutbox } from '@curator/sync-core/sync-log/outbox';
export { MASTER_DEVICE_SETTING } from '../../../../packages/protocol/src/index.js';
export { drainArtistCreditRewrites } from '@curator/sync-core/library/artist-alias';
