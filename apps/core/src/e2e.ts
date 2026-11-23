// Internals the rekordbox end-to-end run (e2e/, @curator/e2e) drives core
// through: the founder reset, the replica dump, the join bind and the claim
// index. Off-product tooling only — the CoreService interface stays the API
// surface; nothing here is a contract the desktop or the cloud relies on.

export { resetSyncForFounding, type RefoundResult } from '@curator/sync-core/sync-log/refound';
export { compareDumps, dumpLibrary, DUMP_TABLES, type LibraryDump, type TableReport } from '@curator/sync-core/sync-log/dump';
export { joinBindAsync, type JoinBindResult } from '@curator/sync-core/sync-log/join-bind';
export { ClaimBinder } from '@curator/sync-core/sync-log/claim-bind';
export { createSyncClient, readCursor, CLIENT_STATE_KEY, SNAPSHOT_PUBLISH_KEY, SNAPSHOT_PUBLISH_REQUEST_KEY } from '@curator/sync-core/sync-log/client';
export { INITIAL_PUSH_KEY, RECORDS_COMPLETE_KEY } from '@curator/sync-core/sync-log/apply';
export { getDeviceId } from '@curator/sync-core/sync-log/device';
export { parseTagComment } from '@curator/sync-core/rekordbox/tag-comment';
// What the exporter would send for a track, so the run can tell "the real
// rekordbox is behind the master's Curator" from a push the master would
// never make.
export { effectiveAlbum, effectiveArtistName, effectiveGenre, effectiveLabel, effectiveTitle } from './sync/curator-view.js';
// Fixture libraries (e2e tests): the artist junction a catalogue row needs.
export { syncTrackArtistsByIdRaw } from '@curator/sync-core/library/artists';
