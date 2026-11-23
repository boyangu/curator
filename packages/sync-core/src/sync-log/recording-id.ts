// The recording id a track row is born with (cloud design: "Identifiers").
//
// A UUIDv5 of the row's own id rather than a random one, for two reasons.
// The migrate-time backfill and every insert site then agree by
// construction: a writer that forgets the column is healed on the next boot
// to exactly the value it should have written. And a library restored from a
// backup taken before the sync schema existed re-derives the ids it had
// already pushed, instead of minting fresh recordings the cloud has never
// seen. Track ids are random UUIDs minted per device, so the hash is as
// unique as a random v4 and says nothing about the row.
//
// Only the mint is derived. After a catalogue alias rewrites the column the
// value is whatever the alias says; nothing may recompute it from the id.

import { uuidv5 } from './stable-ids.js';

// Fixed namespace for Curator recording ids. Changing it would re-mint every
// recording a device has not yet stored, so it never changes.
const RECORDING_NAMESPACE = '6f1c2b7e-3d4a-5e8f-9a0b-c1d2e3f4a5b6';

export function recordingIdForTrack(trackId: string): string {
	return uuidv5(RECORDING_NAMESPACE, trackId);
}
