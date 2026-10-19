// Spotify feed producers — see planning/prds/discover-streaming.md.
//
// Spotify's Recommendations / Audio Features endpoints (and preview URLs)
// are unavailable to newer third-party apps, so the v1 Spotify feed is NOT
// Spotify's recommender — it's our own feed built from endpoints that work
// reliably: followed-playlist deltas (snapshot_id change detection) and
// followed artists' recent releases. Personalization is Curator-side.
//
// Both producers resolve a fresh token per poll via AuthService and no-op
// cleanly when Spotify isn't connected (empty drafts, cursor echoed) —
// disabled is a supported state, same posture as the sidecars.

import { SpotifyClient, spotifyBackoffUntil } from '@curator/spotify';
import type { SpotifyAlbum, SpotifyPlaylist, SpotifyTrack } from '@curator/spotify';
import type { FeedAuthPort, FeedItemDraft, FeedProducer } from './types.js';
import { log } from '../log.js';

const flog = log.for('feed');

// Look-back windows. Playlist first-sight backfill goes two weeks deep so
// a fresh install / newly-followed playlist seeds the feed; new releases
// use a tighter window — release volume across a big follow list is high
// and older drops aren't "news" anymore.
const PLAYLIST_BACKFILL_DAYS = 14;
const RELEASE_WINDOW_DAYS = 5;

function cutoffIsoDaysBack(days: number): string {
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Pacing is no longer a producer concern: every Spotify call now passes
// through the shared rate gate inside SpotifyClient (one app-wide throttle +
// 429 cooldown, see packages/providers/spotify). That fixed the old failure
// mode where a poller's unpaced burst (one request per artist / per changed
// playlist) ate the rolling rate limit and 429'd interactive calls landing
// mid-pass. So these loops just iterate; the gate spaces the requests.

function trackArtistNames(t: SpotifyTrack): string[] {
	return (t.artists ?? []).map((a) => a.name);
}

function suppressKeysForArtists(artists: { id: string; name: string }[]): string[] {
	return artists.filter((a) => a.id).map((a) => `artist:${a.id}`);
}

// ─── Playlist-delta producer ────────────────────────────────────────────
//
// Watches the FOLLOWED playlists on /me/playlists — playlists the user
// owns are skipped: adds there are the user's own curation, not news.
// Change detection is two-stage and cheap:
//   1. snapshot_id comparison — unchanged playlists cost zero extra calls.
//   2. For changed playlists, fetch tracks and emit only items whose
//      added_at is newer than the per-playlist watermark.
// First sight of a playlist (first run, or a playlist followed later)
// backfills the PLAYLIST_BACKFILL_DAYS window — tracks added in the last two
// weeks seed the feed; anything older is history, not news.

interface PlaylistDeltaCursor {
	watermarks: Record<string, { snapshot: string; lastAddedAt: string }>;
	// Oldest added_at boundary already fetched ("Load more" horizon). Polls
	// only move watermarks forward; backfill() moves this back and emits
	// the newly-uncovered (newHorizon, horizon] window.
	horizon?: string;
}

export class SpotifyPlaylistDeltaProducer implements FeedProducer {
	readonly id = 'spotify-playlist-delta';
	readonly source = 'spotify' as const;
	readonly displayName = 'Spotify playlists';

	constructor(private readonly auth: FeedAuthPort) {}

	async poll(cursor: unknown): Promise<{ drafts: FeedItemDraft[]; nextCursor: unknown }> {
		const token = await this.auth.getSpotifyAccessToken().catch(() => null);
		if (!token) return { drafts: [], nextCursor: cursor };
		// Quota ban active → skip the poll entirely. Poking a wall that's still
		// up only re-arms the ban; the cursor is untouched so the next pass (or a
		// user action that re-probes) resumes cleanly once it clears.
		if (Date.now() < spotifyBackoffUntil()) return { drafts: [], nextCursor: cursor };
		const client = new SpotifyClient(token, 'feed:playlist-delta');

		const prevCursor = cursor as PlaylistDeltaCursor | null;
		const prev = prevCursor?.watermarks ?? {};
		const next: PlaylistDeltaCursor['watermarks'] = {};
		const drafts: FeedItemDraft[] = [];
		const cutoffIso = cutoffIsoDaysBack(PLAYLIST_BACKFILL_DAYS);

		const me = await client.getMe();
		const playlists = await client.getUserPlaylists();
		// Spotify intermittently serves /me/playlists pages with a correct
		// `total` but EMPTY `items` (observed in the wild: 5 pages, +0 each,
		// total=231). Advancing the cursor on such a response would wipe
		// every watermark and re-baseline the world — bail without touching
		// the cursor and let the next poll retry.
		if (playlists.length === 0) return { drafts: [], nextCursor: cursor };
		for (const pl of playlists) {
			// Own playlists aren't a discovery source — the user put those
			// tracks there themselves.
			if (pl.owner?.id === me.id) continue;
			const w = prev[pl.id];
			if (w && w.snapshot === pl.snapshot_id) {
				next[pl.id] = w;
				continue;
			}
			// Known playlist whose snapshot moved → emit past the watermark.
			// First sight (no watermark) → backfill the last two weeks.
			const sinceIso = w ? w.lastAddedAt : cutoffIso;
			let maxAdded = sinceIso;
			try {
				const items = await client.getPlaylistTracks(pl.id);
				for (const it of items) {
					const t = it.track;
					if (!t?.id || it.is_local) continue;
					const addedAt = it.added_at ?? '';
					if (addedAt <= sinceIso) continue;
					if (addedAt > maxAdded) maxAdded = addedAt;
					drafts.push(this.trackDraft(t, pl, addedAt));
				}
			} catch (err) {
				// One broken playlist shouldn't sink the poll — keep the old
				// watermark (or stay unseen) so the next pass retries it.
				flog.warn('playlist fetch failed', { playlistId: pl.id }, err);
				if (w) next[pl.id] = w;
				continue;
			}
			next[pl.id] = { snapshot: pl.snapshot_id, lastAddedAt: maxAdded };
		}
		return {
			drafts,
			nextCursor: {
				watermarks: next,
				horizon: prevCursor?.horizon ?? cutoffIso,
			} satisfies PlaylistDeltaCursor,
		};
	}

	// "Load more": walk every followed playlist once and emit tracks whose
	// added_at falls inside the newly-uncovered window. Expensive by nature
	// (one /tracks fetch per playlist) — only runs on explicit user action.
	async backfill(cursor: unknown, days: number): Promise<{ drafts: FeedItemDraft[]; nextCursor: unknown }> {
		const token = await this.auth.getSpotifyAccessToken().catch(() => null);
		if (!token) return { drafts: [], nextCursor: cursor };
		if (Date.now() < spotifyBackoffUntil()) return { drafts: [], nextCursor: cursor };
		const client = new SpotifyClient(token, 'feed:playlist-backfill');

		const prevCursor = (cursor as PlaylistDeltaCursor | null) ?? { watermarks: {} };
		const horizon = prevCursor.horizon ?? cutoffIsoDaysBack(PLAYLIST_BACKFILL_DAYS);
		const newHorizon = new Date(Date.parse(horizon) - days * 24 * 60 * 60 * 1000).toISOString();
		const drafts: FeedItemDraft[] = [];

		const me = await client.getMe();
		const playlists = await client.getUserPlaylists();
		// Same empty-index guard as poll() — don't move the horizon on a
		// bogus response.
		if (playlists.length === 0) return { drafts: [], nextCursor: cursor };
		for (const pl of playlists) {
			if (pl.owner?.id === me.id) continue;
			try {
				const items = await client.getPlaylistTracks(pl.id);
				for (const it of items) {
					const t = it.track;
					if (!t?.id || it.is_local) continue;
					const addedAt = it.added_at ?? '';
					if (addedAt <= newHorizon || addedAt > horizon) continue;
					drafts.push(this.trackDraft(t, pl, addedAt));
				}
			} catch (err) {
				flog.warn('backfill playlist fetch failed', { playlistId: pl.id }, err);
			}
		}
		return { drafts, nextCursor: { ...prevCursor, horizon: newHorizon } satisfies PlaylistDeltaCursor };
	}

	private trackDraft(t: SpotifyTrack, pl: SpotifyPlaylist, addedAt: string): FeedItemDraft {
		const publishedAt = Date.parse(addedAt) || null;
		const isrc = t.external_ids?.isrc ?? null;
		return {
			type: 'track',
			source: 'spotify',
			sourceId: t.id,
			// ISRC-keyed when available — the recording's cross-source
			// identity, so the same track surfacing via another source (or
			// another Spotify id) collapses to one feed item. Source-id
			// fallback for the rare ISRC-less track.
			dedupeKey: isrc ? `isrc:${isrc}` : `spotify:track:${t.id}`,
			payload: {
				title: t.name,
				isrc,
				artists: trackArtistNames(t),
				artistIds: (t.artists ?? []).map((a) => a.id),
				coverUrl: t.album?.images?.[0]?.url ?? null,
				albumTitle: t.album?.name ?? null,
				releaseDate: t.album?.release_date ?? null,
				durationSec: Math.round((t.duration_ms ?? 0) / 1000),
				url: `https://open.spotify.com/track/${t.id}`,
				raw: t,
			},
			origin: { kind: 'playlist', id: pl.id, name: pl.name },
			publishedAt,
			suppressKeys: ['source:spotify', `playlist:${pl.id}`, ...suppressKeysForArtists(t.artists ?? [])],
		};
	}
}

// ─── New-releases producer ──────────────────────────────────────────────
//
// Followed artists → recent albums/singles within RELEASE_WINDOW_DAYS. One
// /artists/{id}/albums call per followed artist per poll (newest-first,
// single page) — acceptable at follow-list scale with the default
// 30-minute interval; revisit with batching if follow lists grow into the
// thousands. The store's dedupeKey makes re-polls free, so the only
// window logic needed is the release-date cutoff.

interface NewReleasesCursor {
	// Oldest release-date boundary already fetched (YYYY-MM-DD). Poll
	// covers the rolling RELEASE_WINDOW_DAYS window; backfill() moves this
	// back and emits the newly-uncovered (newHorizon, horizon] window.
	horizon?: string;
	// Index into the followed-artists list to resume from. Set when a poll
	// ends early on a rate-limit so the next poll picks up where it left off
	// instead of always re-walking (and re-starving) the same tail. Wraps to
	// 0 once a full pass completes.
	resumeAt?: number;
}

export class SpotifyNewReleasesProducer implements FeedProducer {
	readonly id = 'spotify-new-releases';
	readonly source = 'spotify' as const;
	readonly displayName = 'Spotify new releases';

	constructor(
		private readonly auth: FeedAuthPort,
		// Muted-artist gate: returns the set of suppressed 'artist:<id>' keys
		// (feed_suppression, scope 'artist'). The release walk skips these
		// artists BEFORE spending an /artists/{id}/albums call — a muted artist
		// shouldn't cost quota just to have its drafts dropped downstream by the
		// ArtistDismissFilter. Injected (not the store) to keep the producer free
		// of feed.db; omitted ⇒ no skipping (the filter still backstops).
		private readonly mutedArtistKeys?: () => Promise<Set<string>>,
	) {}

	async poll(cursor: unknown): Promise<{ drafts: FeedItemDraft[]; nextCursor: unknown }> {
		const token = await this.auth.getSpotifyAccessToken().catch(() => null);
		if (!token) return { drafts: [], nextCursor: cursor };
		if (Date.now() < spotifyBackoffUntil()) return { drafts: [], nextCursor: cursor };
		const client = new SpotifyClient(token, 'feed:new-releases');

		const cutoff = cutoffIsoDaysBack(RELEASE_WINDOW_DAYS).slice(0, 10);
		const prevCursor = cursor as NewReleasesCursor | null;
		const { drafts, resumeAt } = await this.collectReleases(client, cutoff, undefined, 20, prevCursor?.resumeAt ?? 0);
		return {
			drafts,
			nextCursor: { horizon: prevCursor?.horizon ?? cutoff, resumeAt } satisfies NewReleasesCursor,
		};
	}

	// "Load more": extend the release-date horizon back by `days`. Uses a
	// deeper per-artist page (50 vs 20) since older releases sit further
	// down the newest-first listing.
	async backfill(cursor: unknown, days: number): Promise<{ drafts: FeedItemDraft[]; nextCursor: unknown }> {
		const token = await this.auth.getSpotifyAccessToken().catch(() => null);
		if (!token) return { drafts: [], nextCursor: cursor };
		if (Date.now() < spotifyBackoffUntil()) return { drafts: [], nextCursor: cursor };
		const client = new SpotifyClient(token, 'feed:releases-backfill');

		const prevCursor = (cursor as NewReleasesCursor | null) ?? {};
		const horizon = prevCursor.horizon ?? cutoffIsoDaysBack(RELEASE_WINDOW_DAYS).slice(0, 10);
		const newHorizon = new Date(Date.parse(horizon) - days * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);
		const { drafts } = await this.collectReleases(client, newHorizon, horizon, 50);
		return { drafts, nextCursor: { horizon: newHorizon } satisfies NewReleasesCursor };
	}

	// Walk followed artists and collect releases with release_date in
	// [from .. toExclusive); toExclusive undefined = no upper bound.
	//
	// Starts at `startIndex` and wraps around the follow list so a poll that
	// ended early on a rate-limit covers the rest next time. Returns the index
	// to resume from: where it stopped on a rate-limit, else 0 (full pass).
	private async collectReleases(
		client: SpotifyClient,
		from: string,
		toExclusive: string | undefined,
		limit = 20,
		startIndex = 0,
	): Promise<{ drafts: FeedItemDraft[]; resumeAt: number }> {
		const drafts: FeedItemDraft[] = [];
		const artists = await client.getFollowedArtists();
		// Muted artists are skipped before any albums call — don't search for new
		// releases from someone the user silenced in the feed. Best-effort: a
		// lookup failure leaves the set empty (the ArtistDismissFilter still drops
		// their drafts post-fetch, just without the quota saving).
		const muted = (await this.mutedArtistKeys?.().catch(() => null)) ?? new Set<string>();
		const n = artists.length;
		const start = n > 0 ? startIndex % n : 0;
		for (let i = 0; i < n; i++) {
			const idx = (start + i) % n;
			const artist = artists[idx];
			if (!artist) continue;
			if (muted.has(`artist:${artist.id}`)) continue;
			let albums: SpotifyAlbum[];
			try {
				albums = await client.getArtistAlbums(artist.id, { limit });
			} catch (err) {
				// A 429 that survived the client's own retry budget means we've
				// tripped Spotify's rolling rate-limit window — every remaining
				// artist would hit the same wall. Stop the walk and return what
				// we have, recording this artist as the resume point so the next
				// poll picks up here instead of re-starving the tail.
				if (err instanceof Error && err.message.includes('429')) {
					flog.warn('rate-limited during release walk; resuming at this artist next poll', { artistId: artist.id, walked: i, total: n, drafts: drafts.length });
					return { drafts, resumeAt: idx };
				}
				flog.warn('artist albums fetch failed', { artistId: artist.id }, err);
				continue;
			}
			for (const al of albums) {
				// release_date precision varies (YYYY / YYYY-MM / YYYY-MM-DD);
				// string comparison against a YYYY-MM-DD cutoff is correct for
				// the day-precision releases we care about and conservatively
				// drops the coarse ones.
				if (!al.release_date || al.release_date < from) continue;
				if (toExclusive && al.release_date >= toExclusive) continue;
				drafts.push(this.albumDraft(al, artist.id, artist.name));
			}
		}
		return { drafts, resumeAt: 0 };
	}

	private albumDraft(al: SpotifyAlbum, artistId: string, artistName: string): FeedItemDraft {
		return {
			type: 'album',
			source: 'spotify',
			sourceId: al.id,
			dedupeKey: `spotify:album:${al.id}`,
			payload: {
				title: al.name,
				artists: (al.artists ?? []).map((a) => a.name),
				artistIds: (al.artists ?? []).map((a) => a.id),
				coverUrl: al.images?.[0]?.url ?? null,
				releaseDate: al.release_date,
				albumType: al.album_group ?? al.album_type,
				trackCount: al.total_tracks ?? null,
				url: al.external_urls?.spotify ?? `https://open.spotify.com/album/${al.id}`,
			},
			origin: { kind: 'artist', id: artistId, name: artistName },
			publishedAt: Date.parse(al.release_date) || null,
			suppressKeys: ['source:spotify', `artist:${artistId}`, ...suppressKeysForArtists(al.artists ?? [])],
		};
	}
}
