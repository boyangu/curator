// Internals the rekordbox end-to-end run (e2e/, @curator/e2e) drives core
// through: the founder reset, the replica dump, the join bind and the claim
// index. Off-product tooling only — the CoreService interface stays the API
// surface; nothing here is a contract the desktop or the cloud relies on.

export { resetSyncForFounding, type RefoundResult } from './sync-log/refound.js';
export { compareDumps, dumpLibrary, DUMP_TABLES, type LibraryDump, type TableReport } from './sync-log/dump.js';
export { joinBindAsync, type JoinBindResult } from './sync-log/join-bind.js';
export { ClaimBinder } from './sync-log/claim-bind.js';
export { readCursor, CLIENT_STATE_KEY, SNAPSHOT_PUBLISH_KEY, SNAPSHOT_PUBLISH_REQUEST_KEY } from './sync-log/client.js';
export { INITIAL_PUSH_KEY, RECORDS_COMPLETE_KEY } from './sync-log/apply.js';
export { getDeviceId } from './sync-log/device.js';
export { parseTagComment } from './rekordbox/tag-comment.js';
// What the exporter would send for a track, so the run can tell "the real
// rekordbox is behind the master's Curator" from a push the master would
// never make.
export { effectiveAlbum, effectiveArtistName, effectiveGenre, effectiveLabel, effectiveTitle } from './sync/curator-view.js';
// Fixture libraries (e2e tests): the artist junction a catalogue row needs.
export { syncTrackArtistsByIdRaw } from './library/artists.js';
