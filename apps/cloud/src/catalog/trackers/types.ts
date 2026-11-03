// A tracker adapter: how one provider reads the collection of one kind of
// live object (an artist's releases, a label's uploads). It observes and
// returns claims; it never writes the catalogue (ingest.ts does).

import type { CatalogClaim, CatalogKind, CatalogProvider, CatalogRef } from '@curator/protocol';

export type TrackerTarget = {
	object: { id: string; kind: CatalogKind; name: string };
	// The object's id on this provider; null for a tracker that works by name.
	representation: { providerId: string; url: string | null } | null;
	// What the adapter returned as `cursor` last time ({} at first).
	cursor: Record<string, unknown>;
	// Other objects the poll reads through, loaded by the sweep: a label's
	// catalogue playlists for the Spotify label tracker.
	related?: { providerId: string; url: string | null }[];
};

export type TrackerPoll = {
	// The children found (releases, mostly), as claims.
	children: CatalogClaim[];
	// A digest of the listing: unchanged since the last poll means nothing to
	// ingest, so a quiet artist costs one call and one cursor update.
	listingHash: string;
	cursor: Record<string, unknown>;
	// Provider calls this poll made, against the day's budget.
	calls: number;
	// The tracked object's own current representation (name, image), applied
	// in place: a live object's details are not history.
	self?: CatalogClaim;
	// A chart poll (a genre's top list): per entry, the child (by index into
	// `children`, a release carrying the charted track) and the track's rank.
	chart?: { index: number; rank: number; recording: CatalogRef }[];
	// Uploads (a label's channel or profile): a claim here is attached to the
	// recording it names when the catalogue already knows one, and is
	// otherwise not an object at all but an announcement signal on the
	// tracked object. A premiere video is not a release until a release is.
	tentative?: CatalogClaim[];
	// The children are releases of the tracked label even though no label
	// entity rides on them (a label's catalogue playlist): the sweep ties each
	// to it with a release-label edge.
	labelOf?: boolean;
	// The id the provider's API knows the object by, when the stored
	// representation still carried a slug the poll had to resolve (a
	// SoundCloud permalink whose page the profiler could not read): the sweep
	// re-points the representation before ingesting, so the next poll skips
	// the lookup.
	resolvedId?: string;
};

export interface TrackerAdapter {
	readonly provider: CatalogProvider;
	readonly kinds: readonly CatalogKind[];
	// Calls one poll is expected to make, reserved before it runs.
	readonly callsPerPoll: number;
	poll(target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll>;
}

export class TrackerRateLimitedError extends Error {
	override readonly name = 'TrackerRateLimitedError';
	constructor(readonly retryAfterSec: number) {
		super(`rate limited (${retryAfterSec}s)`);
	}
}
