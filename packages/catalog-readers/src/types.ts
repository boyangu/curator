// A tracker adapter: how one provider reads the collection of one kind of
// live object (an artist's releases, a label's uploads). It observes and
// returns claims; it never writes the catalogue (the cloud's ingest does).
//
// The target and the poll are the wire contract too (a desktop reports a
// poll to the cloud as it is), so their shapes live in @curator/protocol.

import type { CatalogKind, CatalogProvider, CatalogTrackerPoll, CatalogTrackerTarget } from '@curator/protocol';

export type TrackerTarget = CatalogTrackerTarget;
export type TrackerPoll = CatalogTrackerPoll;

export interface TrackerAdapter {
	readonly provider: CatalogProvider;
	readonly kinds: readonly CatalogKind[];
	// Calls one poll is expected to make, reserved before it runs.
	readonly callsPerPoll: number;
	poll(target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll>;
}

// What each reader reserves before a poll, by provider (the playlist reader
// is Spotify's other kind), for a master that hands polls out without
// holding the reader itself.
export const CALLS_PER_POLL: Readonly<Record<string, number>> = {
	deezer: 9,
	beatport: 7,
	bandcamp: 5,
	spotify: 4,
	'spotify/playlist': 3,
	youtube: 2,
	soundcloud: 2,
};
export const callsPerPoll = (provider: string, kind: CatalogKind): number => CALLS_PER_POLL[`${provider}/${kind}`] ?? CALLS_PER_POLL[provider] ?? 1;

export class TrackerRateLimitedError extends Error {
	override readonly name = 'TrackerRateLimitedError';
	constructor(readonly retryAfterSec: number) {
		super(`rate limited (${retryAfterSec}s)`);
	}
}
