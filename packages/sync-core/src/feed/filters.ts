// Feed production stages — composable steps between a producer's drafts and
// the bus (feed.db). Each stage takes the batch and returns the survivors:
// filters drop drafts (by omission — no sentinel), expanders and enrichers
// mutate payloads in place and return the same drafts.
//
// A pass (pass.ts) threads every producer's drafts through the ordered stage
// list before upsertItems, cheap-local-filters first and expensive network
// last, so we never expand or enrich something a filter would drop. A stage
// that throws is caught by the pass and the batch continues unchanged (a
// filter that can't query just doesn't filter — dedupe_key UNIQUE is the
// backstop). Single-item failures are swallowed inside the stage.
//
// The filters need only the store and an injected library probe, so every
// device runs these. The desktop's album expander, which asks Spotify, stays
// with its provider (apps/core feed/pipeline.ts).

import type { StreamingSource } from '@curator/shared';
import type { FeedItemDraft, LibraryTier } from './types.js';
import type { FeedStore } from './store.js';
import { spotifyIdOf } from './handles.js';

export interface FeedStageContext {
	producerId: string;
	mode: 'poll' | 'backfill';
	// Aborted when the scheduler stops mid-pass (process teardown). Slow
	// network stages check it between items.
	signal?: AbortSignal;
	// A slow stage says what it is doing, for the refresh status.
	report?: (detail: string) => void;
}

export interface FeedStage {
	readonly id: string;
	run(drafts: FeedItemDraft[], ctx: FeedStageContext): Promise<FeedItemDraft[]>;
}

// Library-membership probe, injected so the feed module never imports
// curator.db schema (the FeedStore is the cloud seam). For the supplied keys
// the library holds, returns — keyed by ISRC and by spotify source-track id:
//   • the RAW LibraryTier (what the LibraryFilter drops `local` off, and the
//     base the per-page decorator resolves the display chip from);
//   • `pinned*` — keys carrying the `interested` ("Pinned") tag, which promote
//     the display chip to "In Library" regardless of tier;
//   • `source*` — for a `streaming`-tier key, which of the user's own sources
//     holds it (names the "In {Spotify|Tidal} Library" chip; spotify wins both).
// A key absent from `membership*` = not in the library (or held at the null/none
// tier — same effect for the filter: not dropped).
export type LibraryMembershipLookup = (keys: {
	isrcs: string[];
	spotifyTrackIds: string[];
}) => Promise<{
	membershipByIsrc: Record<string, LibraryTier>;
	membershipBySpotifyId: Record<string, LibraryTier>;
	pinnedByIsrc: Set<string>;
	pinnedBySpotifyId: Set<string>;
	sourceByIsrc: Record<string, StreamingSource>;
	sourceBySpotifyId: Record<string, StreamingSource>;
}>;

// ─── filter1: feed dedup ───────────────────────────────────────────────────
// Drafts whose dedupeKey is already in feed.db are a repeat sighting — the
// same recording via another playlist, the same release via another followed
// artist. They're dropped (sparing the downstream network stages), but NOT
// silently: their origin + suppress keys accrue onto the stored row first, so
// the "+N sources" badge, multi-source ranking, and unfollow/mute coverage see
// every source, not just the first one that ever surfaced it.
//
// Repeats WITHIN the batch are kept: upsertItems inserts the first and folds
// the rest onto it in its dedupe branch (the only place that sees both).
export class FeedDedupFilter implements FeedStage {
	readonly id = 'feed-dedup-filter';

	constructor(private readonly store: Pick<FeedStore, 'existingDedupeKeys' | 'accrueSources'>) {}

	async run(drafts: FeedItemDraft[]): Promise<FeedItemDraft[]> {
		if (drafts.length === 0) return drafts;
		// A draft is a repeat when the store holds it under ANY of its keys: a
		// catalogue card for a release a local producer stored (alias), or the
		// reverse. accrueSources folds the repeat's facts onto that row.
		const keysOf = (d: FeedItemDraft) => [d.dedupeKey, ...(d.aliasKeys ?? [])];
		const existing = await this.store.existingDedupeKeys([...new Set(drafts.flatMap(keysOf))]);
		if (existing.size === 0) return drafts;
		const held = (d: FeedItemDraft) => keysOf(d).some((k) => existing.has(k));
		const repeats = drafts.filter(held);
		await this.store.accrueSources(repeats);
		return drafts.filter((d) => !held(d));
	}
}

// ─── filter3: artist dismiss ───────────────────────────────────────────────
// Drop TRACK drafts whose artist was explicitly dismissed (feed_suppression
// scope 'artist'). Producers already emit 'artist:<id>' suppress keys. This
// stops NEW track items from a dismissed artist at the door; the read-time
// VISIBLE_WHERE suppression complements it by hiding items already in the bus.
//
// ALBUMS are exempt from credit mutes: muting an artist never removes a
// release (a multi-artist album would vanish over a single credited feature).
// The album stays and its per-artist tracks are chipped/skipped instead (see
// getItemDetail). The one album rule: a muted FOLLOWED artist's own new
// releases (the artist the item's origin names) are dropped — the local
// new-releases producer skips them before fetching, the cloud's arrive here.
export class ArtistDismissFilter implements FeedStage {
	readonly id = 'artist-dismiss-filter';

	constructor(private readonly store: Pick<FeedStore, 'suppressedKeys'>) {}

	async run(drafts: FeedItemDraft[]): Promise<FeedItemDraft[]> {
		if (drafts.length === 0) return drafts;
		const dismissed = await this.store.suppressedKeys('artist');
		if (dismissed.size === 0) return drafts;
		// An album stays unless the artist whose follow produced it is muted
		// (the cloud's releases arrive here unfiltered; the local new-releases
		// producer skips muted artists before fetching).
		return drafts.filter((d) =>
			d.type === 'album' ? !(d.origin?.kind === 'artist' && dismissed.has(`artist:${d.origin.id}`)) : !d.suppressKeys.some((k) => dismissed.has(k)),
		);
	}
}

// ─── filter2: library ──────────────────────────────────────────────────────
// Drop TRACK items already in the library at the `local` tier ONLY — you have
// the file, so it's not discovery. Tracks held at `streaming`/`followed` (or
// none) STAY in the feed, surfaced with a membership chip. Album items pass
// through untouched — a release is news even if you own some of its tracks. The
// tier probe is injected so this module never imports curator.db schema.
export class LibraryFilter implements FeedStage {
	readonly id = 'library-filter';

	constructor(private readonly lookup: LibraryMembershipLookup) {}

	async run(drafts: FeedItemDraft[]): Promise<FeedItemDraft[]> {
		const tracks = drafts.filter((d) => d.type === 'track');
		if (tracks.length === 0) return drafts;
		const isrcs = [...new Set(tracks.map((d) => d.payload.isrc).filter((x): x is string => !!x))];
		const spotifyTrackIds = [...new Set(tracks.map(spotifyIdOf).filter((x): x is string => !!x))];
		const { membershipByIsrc, membershipBySpotifyId } = await this.lookup({ isrcs, spotifyTrackIds });
		return drafts.filter((d) => {
			if (d.type !== 'track') return true;
			const sid = spotifyIdOf(d);
			const tier = (d.payload.isrc ? membershipByIsrc[d.payload.isrc] : undefined)
				?? (sid ? membershipBySpotifyId[sid] : undefined);
			return tier !== 'local';
		});
	}
}
