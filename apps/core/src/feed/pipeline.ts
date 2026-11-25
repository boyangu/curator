// The desktop's own feed production stage: the Spotify album expander, and the
// tracklist reads behind it. The stage contract and the filters every device
// runs are @curator/sync-core/feed/filters.

import type { SpotifyClient } from '@curator/spotify';
import type { FeedItemDraft, FeedTrackRef } from '@curator/sync-core/feed/types';
import type { FeedStage, FeedStageContext } from '@curator/sync-core/feed/filters';
import { log } from '@curator/sync-core/log';

const flog = log.for('feed');

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
		// Catalogue cards carry their tracklist; only a local producer's bare
		// Spotify album needs one fetched.
		const pending = drafts.filter(
			(d) => d.type === 'album' && d.source === 'spotify' && !d.payload.tracks && !d.payload.catalogId,
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
		for (const [i, d] of pending.entries()) {
			if (ctx.signal?.aborted) break;
			ctx.report?.(`Reading album ${i + 1} of ${pending.length}`);
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
