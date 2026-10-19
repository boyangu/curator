// Feed production pipeline — composable stages between a producer's drafts
// and the bus (feed.db). Each stage takes the batch and returns the
// survivors: filters drop drafts (by omission — no sentinel), expanders and
// enrichers mutate payloads in place and return the same drafts.
//
// The scheduler threads every producer's drafts through the ordered stage
// list before upsertItems, cheap-local-filters first and expensive network
// last, so we never expand or enrich something a filter would drop. A stage
// that throws is caught by the scheduler and the batch continues unchanged
// (a filter that can't query just doesn't filter — dedupe_key UNIQUE is the
// backstop). Single-item failures are swallowed inside the stage.

import type { SpotifyClient } from '@curator/spotify';
import type { StreamingSource } from '@curator/shared';
import type { FeedItemDraft, LibraryTier, FeedTrackRef } from './types.js';
import type { FeedStore } from './store.js';
import { log } from '../log.js';

const flog = log.for('feed');

export interface FeedStageContext {
	producerId: string;
	mode: 'poll' | 'backfill';
	// Aborted when the scheduler stops mid-pass (process teardown). Slow
	// network stages check it between items.
	signal?: AbortSignal;
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

// Resolve a Spotify album's tracklist into FeedTrackRefs — ONE call
// (/albums/{id}/tracks). ISRCs are deliberately NOT fetched here: that needs a
// second /tracks?ids= call per album, and resolving every ingested album's
// ISRCs doubled the album-phase call volume against a per-client-ID rate limit
// for data nobody had looked at yet. ISRC is now filled on demand — see
// fillAlbumTrackIsrcs, called on first expand (getFeedItemDetail), so we only
// spend those calls on albums the user actually opens. Shared by the eager
// expander stage and the guarded lazy fallback in getFeedItemDetail.
export async function resolveAlbumTracks(client: SpotifyClient, albumId: string): Promise<FeedTrackRef[]> {
	const tracks = await client.getAlbumTracks(albumId);
	return tracks.map((t) => ({
		sourceTrackId: t.id,
		title: t.name,
		artists: t.artists.map((a) => a.name),
		// Kept so a per-track artist mute can chip exactly this row (album-tracks
		// includes the credited ids; the album-level payload only has primaries,
		// missing per-track features). Drives detail.mutedSourceTrackIds.
		artistIds: t.artists.map((a) => a.id),
		durationSec: Math.round((t.duration_ms ?? 0) / 1000),
		trackNumber: t.track_number,
		isrc: null,
	}));
}

// On-demand ISRC fill for an already-resolved tracklist. /albums/{id}/tracks
// omits external_ids, so /tracks?ids= supplies the ISRCs — mapped by id, never
// zipped positionally (getTracksByIds silently drops nulls). Mutates refs in
// place. Best-effort: a throw leaves ISRCs null (tracks still render, play, and
// promote — promotion refetches its own track). Returns whether any landed.
//
// The same full-track payload carries each ref's artist ids, so this also
// backfills FeedTrackRef.artistIds for refs resolved before that field existed
// — for free, on the expand the user already triggered. New ingests already
// carry ids from resolveAlbumTracks; this catches the pre-existing albums so
// their per-artist "Muted" chips become precise on first re-open.
export async function fillAlbumTrackIsrcs(client: SpotifyClient, refs: FeedTrackRef[]): Promise<boolean> {
	if (refs.length === 0) return false;
	const full = await client.getTracksByIds(refs.map((r) => r.sourceTrackId));
	const byId = new Map(full.map((f) => [f.id, f]));
	let changed = false;
	for (const ref of refs) {
		const f = byId.get(ref.sourceTrackId);
		const isrc = f?.external_ids?.isrc ?? null;
		if (isrc !== ref.isrc) { ref.isrc = isrc; changed = true; }
		if (f?.artists && !ref.artistIds) { ref.artistIds = f.artists.map((a) => a.id); changed = true; }
	}
	return changed;
}

// ─── Album expander ──────────────────────────────────────────────────────
// Resolve album tracklists at production time so albums enter the bus
// complete — the per-track enricher needs the tracks. One call per album
// (tracklist only); ISRCs are filled lazily on first expand, not here. Albums
// it can't resolve (no token) fall back to the lazy resolve in getItemDetail.
export class AlbumExpanderStage implements FeedStage {
	readonly id = 'album-expander';

	constructor(private readonly getClient: () => Promise<SpotifyClient | null>) {}

	async run(drafts: FeedItemDraft[], ctx: FeedStageContext): Promise<FeedItemDraft[]> {
		const pending = drafts.filter(
			(d) => d.type === 'album' && d.source === 'spotify' && !d.payload.tracks,
		);
		if (pending.length === 0) return drafts;
		const client = await this.getClient();
		// No token → albums enter without tracks; the guarded lazy fallback in
		// getFeedItemDetail still resolves them on expand. Same degrade posture
		// as the producers when Spotify isn't connected.
		if (!client) return drafts;
		// One fetch per album id per run — a collab release credited to two
		// followed artists arrives as two drafts (the dedup filter keeps in-batch
		// repeats so upsertItems can accrue both origins).
		const resolved = new Map<string, FeedTrackRef[]>();
		for (const d of pending) {
			if (ctx.signal?.aborted) break;
			const cached = resolved.get(d.sourceId);
			if (cached) { d.payload.tracks = cached; continue; }
			try {
				// No local pacing — SpotifyClient's shared rate gate spaces every
				// call process-wide (and backs off on 429).
				d.payload.tracks = await resolveAlbumTracks(client, d.sourceId);
				resolved.set(d.sourceId, d.payload.tracks);
			} catch (err) {
				// One bad album must not sink the batch — leave it without tracks;
				// the lazy fallback covers it on expand.
				flog.warn('album tracklist fetch failed', { albumId: d.sourceId }, err);
			}
		}
		return drafts;
	}
}

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
		const existing = await this.store.existingDedupeKeys(drafts.map((d) => d.dedupeKey));
		if (existing.size === 0) return drafts;
		const repeats = drafts.filter((d) => existing.has(d.dedupeKey));
		await this.store.accrueSources(repeats);
		return drafts.filter((d) => !existing.has(d.dedupeKey));
	}
}

// ─── filter3: artist dismiss ───────────────────────────────────────────────
// Drop TRACK drafts whose artist was explicitly dismissed (feed_suppression
// scope 'artist'). Producers already emit 'artist:<id>' suppress keys. This
// stops NEW track items from a dismissed artist at the door; the read-time
// VISIBLE_WHERE suppression complements it by hiding items already in the bus.
//
// ALBUMS are exempt: muting an artist never removes a release (a multi-artist
// album would vanish over a single credited feature). The album stays and its
// per-artist tracks are chipped/skipped instead (see getItemDetail). A muted
// FOLLOWED artist's OWN new releases still don't appear — the new-releases
// producer skips them upstream before spending the Spotify call, not here.
export class ArtistDismissFilter implements FeedStage {
	readonly id = 'artist-dismiss-filter';

	constructor(private readonly store: Pick<FeedStore, 'suppressedKeys'>) {}

	async run(drafts: FeedItemDraft[]): Promise<FeedItemDraft[]> {
		if (drafts.length === 0) return drafts;
		const dismissed = await this.store.suppressedKeys('artist');
		if (dismissed.size === 0) return drafts;
		return drafts.filter((d) => d.type === 'album' || !d.suppressKeys.some((k) => dismissed.has(k)));
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
		const spotifyTrackIds = [...new Set(tracks.filter((d) => d.source === 'spotify').map((d) => d.sourceId))];
		const { membershipByIsrc, membershipBySpotifyId } = await this.lookup({ isrcs, spotifyTrackIds });
		return drafts.filter((d) => {
			if (d.type !== 'track') return true;
			const tier = (d.payload.isrc ? membershipByIsrc[d.payload.isrc] : undefined)
				?? (d.source === 'spotify' ? membershipBySpotifyId[d.sourceId] : undefined);
			return tier !== 'local';
		});
	}
}
