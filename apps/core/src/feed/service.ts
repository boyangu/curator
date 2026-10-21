// Feed service — the relocatable Discover feed engine behind explicit ports.
// See planning/tech/discover-feed-service.md.
//
// Owns the store + scheduler (producers + pipeline stages) + enrichment, and
// exposes a transport-agnostic interface. It depends ONLY on the ports below
// — no curator.db schema, no Electron — so the SAME code runs in-process
// (S1), in an off-main worker (S2), or in the cloud (S3); only the port
// adapters + transport change. The one coupling that matters, promotion into
// the library, is the `LibraryPort` — the sole place the feed reaches the
// library.

import { SpotifyClient, type SpotifyTrack } from '@curator/spotify';
import type { FetchLike as BeatportFetch } from '@curator/beatport';
import type { FeedFilter, FeedStore } from './store.js';
import { FeedScheduler } from './scheduler.js';
import { FeedEnrichmentQueue } from './enrichment.js';
import { BeatportEnricher } from '../enrich/enrichers/beatport.js';
import { TraxsourceEnricher } from '../enrich/enrichers/traxsource.js';
import { SpotifyPlaylistDeltaProducer, SpotifyNewReleasesProducer } from './spotify-producers.js';
import { makeRemoteWriteGate, type RemoteWriteGate } from '../sources/adapter.js';
import {
	AlbumExpanderStage,
	ArtistDismissFilter,
	FeedDedupFilter,
	LibraryFilter,
	resolveAlbumTracks,
	fillAlbumTrackIsrcs,
	type FeedStage,
	type LibraryMembershipLookup,
} from './pipeline.js';
import type {
	EnrichmentResult,
	FeedAction,
	FeedActionResult,
	FeedAuthPort,
	FeedItem,
	FeedItemDetail,
	FeedMembershipTier,
	LibraryTier,
	FeedPage,
	FeedRefreshResult,
	FeedDecisionPort,
	FeedRole,
} from './types.js';
import { resolveFeedMembership } from './types.js';
import { log } from '../log.js';

const flog = log.for('feed');

// ─── Ports ───────────────────────────────────────────────────────────────

// Promotion + library-membership — the only places the feed touches the
// library. Local adapter writes curator.db; cloud adapter is a synced-library
// mutation/query. Keeps feed/ free of curator.db schema (the cloud seam).
export interface LibraryPort {
	// Tracks the library already owns, by ISRC and by spotify source-track id
	// (drives the pipeline's library-filter).
	membership: LibraryMembershipLookup;
	// Promote a resolved Spotify track into the library; returns the canonical
	// track id. Owns ALL curator.db writes for promotion: ingest match
	// (provider-id → ISRC → create), state → backlog, interested tag, and the
	// enrichment carry. `enrichment` is the feed's carried EnrichmentResult
	// (patch + matched source_links) — persisted through the SAME LibrarySink a
	// direct library enrich uses, so a promoted track is identical to one
	// enriched in place. Null / empty triggers a fallback library enrich.
	// `opts.pin` (default true) adds the `interested` ("Pinned") tag; the plain
	// "Organize" path passes false to bring the track in WITHOUT pinning it.
	promote(track: SpotifyTrack, enrichment: EnrichmentResult | null, opts?: { pin?: boolean }): Promise<string>;
	// Canonical curator track ids AND the resolved DISPLAY membership tier for
	// tracks the library holds, keyed by spotify source-track id and by ISRC.
	// Powers the detail's sourceTrackId → trackId map (renderer actions on an
	// owned feed track) and the membership chip on album rows (library / spotify
	// / tidal / followed). `tier*` only carries held tiers; a track held at the
	// none tier appears in `by*` but not `tier*`.
	libraryTrackIds(probe: { isrcs: string[]; spotifyTrackIds: string[] }): Promise<{
		bySpotify: Record<string, string>;
		byIsrc: Record<string, string>;
		tierBySpotify: Record<string, FeedMembershipTier>;
		tierByIsrc: Record<string, FeedMembershipTier>;
		// Keys carrying the `interested` ("Pinned") tag — a subset of `by*`. Drives
		// the renderer's "Not Interested" (un-pin), offered for pinned tracks only.
		pinnedBySpotify: Set<string>;
		pinnedByIsrc: Set<string>;
	}>;
	// Which of these feed tracks are SOFT-DELETED in the library — keyed by
	// spotify source-track id and by ISRC. Disjoint from libraryTrackIds (a
	// deleted track is not "in library"). Drives hiding deleted standalone
	// track-items from the feed and the "deleted" chip on deleted album rows.
	deletedKeys(probe: { isrcs: string[]; spotifyTrackIds: string[] }): Promise<{ spotify: Set<string>; isrc: Set<string> }>;
	// Reverse of promote: remove a track from the library (drops the row + its
	// interested tag, source links, memberships). Used by the 'uninterested'
	// action's "remove from pinned and library" path.
	unpromote(trackId: string): Promise<void>;
}

export interface FeedServiceDeps {
	store: FeedStore;
	auth: FeedAuthPort;
	library: LibraryPort;
	beatportFetch?: BeatportFetch;
	// Default-deny gate for the live-account writes the feed makes (unfollow
	// playlist/artist). Injected by createCoreService; omitted ⇒ those ops throw.
	remoteWriteGate?: RemoteWriteGate;
	// The account's op log (feed/sync.ts): every decision is stated there
	// after feed.db holds it, and it says whether this device collects the
	// feed. Absent ⇒ a standalone device: collects, states nothing.
	decisions?: FeedDecisionPort;
}

export interface FeedService {
	getPage(req?: { cursor?: string | null; limit?: number } & FeedFilter): Promise<FeedPage>;
	getArchivedPage(req?: { cursor?: string | null; limit?: number }): Promise<FeedPage>;
	// Distinct genre/label values across the visible feed — populates the
	// renderer's filter dropdowns.
	filterOptions(): Promise<{ genres: string[]; labels: string[] }>;
	getItemDetail(itemId: string): Promise<FeedItemDetail | null>;
	// On-view Beatport enrichment for a single item (the expanded album / viewed
	// track). Idempotent — an already-enriched item returns untouched, spending
	// zero Beatport calls. Awaited and returns the updated item so the renderer
	// can fold fresh genre/label (album-level) + per-track bpm/key/genre/label
	// straight onto the card. One item at a time by design: fanning lookups out
	// across every visible card would fire concurrent scrapes and trip Beatport's
	// Cloudflare WAF.
	enrichItem(itemId: string): Promise<FeedItem | null>;
	action(action: FeedAction): Promise<FeedActionResult>;
	// Unfollow a source playlist: drop it at the source (so the delta
	// producer stops seeing it), then hard-remove every feed item it
	// produced. No suppression rule is written — a later re-follow should
	// repopulate cleanly.
	unfollowPlaylist(playlistId: string): Promise<FeedActionResult>;
	// Unfollow a source artist: drop them at the source (so the new-releases
	// producer stops scanning them), then hard-remove every feed item they
	// produced — release-origin items and any track/album they appear on.
	unfollowArtist(artistId: string): Promise<FeedActionResult>;
	refresh(): Promise<FeedRefreshResult>;
	// Manual Refresh of one producer by id (see FEED_PRODUCER_IDS) — drives the
	// temporary per-source Refresh buttons. Unknown id is a clean no-op.
	refreshProducer(producerId: string): Promise<FeedRefreshResult>;
	loadMore(days: number): Promise<FeedRefreshResult>;
	// Subscribe to per-item enrichment completions (background drain + on-view).
	// The desktop forwards these as a push event so a card's freshly landed
	// genre/label/bpm chips appear live. Returns an unsubscribe fn.
	subscribeEnriched(cb: (item: FeedItem) => void): () => void;
	startPolling(): void;
	// Whether this device collects the feed (feed/sync.ts feedRole).
	role(): FeedRole;
	stop(): void;
}

// Cadence hints kept for when auto-poll is re-enabled — currently moot
// (AUTO_POLL=false means no timers fire). Playlist deltas are cheap (snapshot_id
// diffing) → ~30m; new releases drop ≤ daily and each poll scans every followed
// artist (plus album expansion) → once a day.
const THIRTY_MIN_MS = 30 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Both Spotify producers are REGISTERED but MANUAL-ONLY (autoPoll=false): no
// background timer fires, so the per-app quota can't be drained by an unattended
// poll loop (the reason they were paused). They run only on explicit user
// action — the temporary "Refresh Artists" / "Refresh Playlists" buttons (and
// the toolbar Refresh / Load More), each a single bounded pass:
//   • playlist-delta — walks /me/playlists + tracks of each changed playlist
//   • new-releases   — one /artists/{id}/albums per followed artist
const AUTO_POLL = false;

// Producer ids, surfaced so the renderer's temp Refresh buttons can target one
// producer each via refreshProducer().
export const FEED_PRODUCER_IDS = {
	playlists: 'spotify-playlist-delta',
	artists: 'spotify-new-releases',
} as const;

export function createFeedService(deps: FeedServiceDeps): FeedService {
	const { store, auth, library } = deps;
	const decisions = deps.decisions ?? null;
	const role = (): FeedRole => decisions?.role() ?? { role: 'collector', masterDeviceId: null };
	// Producers run on the collecting device only (feed/sync.ts): a follower's
	// Refresh / Load More are refused, not silently empty.
	const followerSkip = (): FeedRefreshResult | null => (role().role === 'follower' ? { producers: [], skipped: 'follower' } : null);
	// Absent gate ⇒ default-deny (off-product construction can't unfollow remotely).
	const remoteWriteGate = deps.remoteWriteGate ?? makeRemoteWriteGate(undefined);

	// Spotify client provider, derived from the auth port. A null token no-ops
	// the network stages + album expansion — disabled Spotify is supported.
	// `tag` labels the client's calls in the rate-window log so an interactive
	// expand is distinguishable from the background album-expander.
	const spotifyClient = async (tag = 'feed:interactive'): Promise<SpotifyClient | null> => {
		const token = await auth.getSpotifyAccessToken().catch(() => null);
		return token ? new SpotifyClient(token, tag) : null;
	};

	// Live-update fan-out: enrichment completions push to every subscriber (the
	// desktop forwards them as a renderer event). A Set so subscribe/unsubscribe
	// is cheap; listeners are wrapped at the queue boundary so a throw can't
	// derail the drain.
	const enrichedListeners = new Set<(item: FeedItem) => void>();

	// Enrichment runs post-bus/async (Beatport's ~1.5s/track WAF) so a deep
	// backfill can't block the feed from populating.
	const enrichment = new FeedEnrichmentQueue(
		store,
		[new BeatportEnricher(deps.beatportFetch), new TraxsourceEnricher(deps.beatportFetch)],
		undefined,
		(item) => { for (const l of enrichedListeners) l(item); },
	);

	// Pre-bus pipeline: cheap local filters first, expensive network last, so
	// nothing is expanded that a filter would drop.
	const stages: FeedStage[] = [
		new FeedDedupFilter(store),
		new ArtistDismissFilter(store),
		new LibraryFilter(library.membership),
		new AlbumExpanderStage(() => spotifyClient('feed:album-expander')),
	];
	const scheduler = new FeedScheduler(store, () => enrichment.kick(), stages);
	scheduler.register(new SpotifyPlaylistDeltaProducer(auth), THIRTY_MIN_MS, AUTO_POLL);
	// Pass the muted-artist lookup so the release walk skips silenced artists
	// before spending a per-artist albums call (the ArtistDismissFilter still
	// backstops at the pipeline).
	scheduler.register(new SpotifyNewReleasesProducer(auth, () => store.suppressedKeys('artist')), ONE_DAY_MS, AUTO_POLL);
	if (!AUTO_POLL)
		flog.warn('Spotify producers are manual-only — no background polling; ingest runs on Refresh / Load More only');

	// Per-page decoration of TRACK items (one batched deleted-probe + one
	// membership probe). Two jobs:
	//   • DROP a track-item that's soft-deleted in the library OR that we now
	//     hold at the `local` tier — you have the file, so it's not discovery.
	//     (The ingest LibraryFilter already drops `local` at production time;
	//     this catches tracks that became `local` AFTER being stored.)
	//   • STAMP the DISPLAY `item.membership` on the survivors so the card can
	//     show its chip — pinned → `library`, own playlist → its source, followed
	//     → `followed` (resolved from the raw tier + pinned tag + owning source).
	// Album items pass through untouched — their deleted/owned nested rows are
	// chipped per-row via getItemDetail, not dropped. The keyset cursor is
	// unaffected (derived from store rows, not the trimmed list); `total` keeps
	// the store's global count (these drops are rare).
	const decorateTrackItems = async (page: FeedPage): Promise<FeedPage> => {
		const trackItems = page.items.filter((i) => i.type === 'track');
		if (trackItems.length === 0) return page;
		const spotifyTrackIds = trackItems.filter((i) => i.source === 'spotify').map((i) => i.sourceId);
		const isrcs = trackItems.map((i) => i.payload.isrc).filter((x): x is string => !!x);
		// `mem` (raw tier + pinned + source) drives the local-file DROP and the
		// chip tier; `owned` (resolved curator ids, excludes followed) supplies the
		// libraryTrackId the card's curate menu acts on. Same probes getItemDetail
		// runs per album expand, batched once per page here.
		const [deleted, mem, owned] = await Promise.all([
			library.deletedKeys({ isrcs, spotifyTrackIds }),
			library.membership({ isrcs, spotifyTrackIds }),
			library.libraryTrackIds({ isrcs, spotifyTrackIds }),
		]);
		// Raw tier still drives the `local`-file drop; pinned + source resolve the
		// display chip (a pinned non-local track survives and reads "In Library").
		const rawOf = (i: FeedItem): LibraryTier | undefined =>
			(i.source === 'spotify' ? mem.membershipBySpotifyId[i.sourceId] : undefined)
			?? (i.payload.isrc ? mem.membershipByIsrc[i.payload.isrc] : undefined);
		const items: FeedItem[] = [];
		for (const i of page.items) {
			if (i.type !== 'track') { items.push(i); continue; }
			if (i.source === 'spotify' && deleted.spotify.has(i.sourceId)) continue;
			if (i.payload.isrc && deleted.isrc.has(i.payload.isrc)) continue;
			const raw = rawOf(i);
			if (raw === 'local') continue;
			const pinned = (i.source === 'spotify' && mem.pinnedBySpotifyId.has(i.sourceId))
				|| (!!i.payload.isrc && mem.pinnedByIsrc.has(i.payload.isrc));
			const src = (i.source === 'spotify' ? mem.sourceBySpotifyId[i.sourceId] : undefined)
				?? (i.payload.isrc ? mem.sourceByIsrc[i.payload.isrc] : undefined);
			const tier = resolveFeedMembership(raw, pinned, src);
			// Owned curator id (pinned / local / own playlist — never followed), so
			// the card's curate menu can Tag / Add-to-playlist / un-pin in place.
			const libraryTrackId = (i.source === 'spotify' ? owned.bySpotify[i.sourceId] : undefined)
				?? (i.payload.isrc ? owned.byIsrc[i.payload.isrc] : undefined);
			items.push(tier || libraryTrackId ? { ...i, membership: tier, libraryTrackId } : i);
		}
		return { ...page, items };
	};

	return {
		async getPage(req) {
			// Viewing the feed drives enrichment: kick the (idempotent, sequential,
			// 1.5s-paced) background drain so visible track items + tracklisted
			// albums fill in their Beatport metadata. Paced sequentially on purpose
			// — fanning a lookup out per visible card would fire concurrent scrapes
			// and trip Beatport's Cloudflare WAF.
			enrichment.kick();
			return decorateTrackItems(await store.getPage(req));
		},
		async getArchivedPage(req) {
			return decorateTrackItems(await store.getArchivedPage(req));
		},
		filterOptions() {
			return store.filterOptions();
		},
		async getItemDetail(itemId) {
			const detail = await store.getItemDetail(itemId);
			if (!detail) return null;
			const { item } = detail;
			// Expand is the "user is looking at this album" signal, so it's where
			// we spend Spotify calls — only on what's actually seen:
			//   • tracklist: normally pre-resolved at ingest by the album-expander;
			//     resolve here as a fallback when it couldn't (no token at poll).
			//   • ISRCs: never fetched at ingest (would double the per-client-ID
			//     call volume for unseen albums). Filled here on first expand and
			//     cached, guarded by payload.isrcResolved so a re-expand is free.
			if (item.type === 'album' && item.source === 'spotify') {
				const needsTracks = !item.payload.tracks;
				const needsIsrc = !needsTracks && !item.payload.isrcResolved && (item.payload.tracks?.length ?? 0) > 0;
				if (needsTracks || needsIsrc) {
					const client = await spotifyClient('interactive:expand');
					if (!client) {
						// Only a hard error when there's nothing to show at all; an
						// ISRC-only miss is invisible to the user.
						if (needsTracks) detail.tracksError = 'Spotify isn’t connected — reconnect it in Settings.';
					} else {
						if (needsTracks) {
							try {
								item.payload.tracks = await resolveAlbumTracks(client, item.sourceId);
							} catch (err) {
								const msg = err instanceof Error ? err.message : String(err);
								// Surface the real reason — the client's retry budget is
								// already spent by the time this throws, so a 429 here is
								// a genuine "app-wide window is saturated", not a blip.
								detail.tracksError = /\b429\b/.test(msg)
									? 'Spotify rate-limited this request (app-wide limit) — try again in a moment.'
									: `Spotify error: ${msg}`;
								flog.warn('album tracklist fetch failed', undefined, err);
							}
						}
						// Best-effort ISRC fill — failure leaves ISRCs null (tracks
						// still render/play; promotion refetches its own track).
						const tracks = item.payload.tracks;
						if (tracks && tracks.length > 0 && !item.payload.isrcResolved && !detail.tracksError) {
							try {
								await fillAlbumTrackIsrcs(client, tracks);
								item.payload.isrcResolved = true;
							} catch (err) {
								flog.warn('album ISRC fill failed', undefined, err);
							}
						}
						// Cache whatever resolved (tracklist and/or ISRCs) so the
						// next expand spends no calls.
						if (item.payload.tracks) await store.setPayload(item.id, item.payload);
					}
				}
			}
			// In-library marking — album rows can carry tracks you already own
			// (the ingest LibraryFilter only drops track items, not albums).
			// Reuse the same membership probe the filter uses; one batched
			// read-only query per expand, by ISRC + spotify source-track id.
			const refs = item.payload.tracks ?? [];
			if (refs.length > 0) {
				const isrcs = refs.map((t) => t.isrc).filter((x): x is string => !!x);
				const spotifyTrackIds = item.source === 'spotify' ? refs.map((t) => t.sourceTrackId) : [];
				// Resolve curator ids (not just presence) so the renderer can act on
				// owned tracks. The sourceTrackId → trackId map drives both the chip
				// (its keys) and the in-library menu branch (its values). The deleted
				// probe runs alongside — disjoint from owned (a deleted track isn't
				// "in library"), so a row is at most one of In Library / Deleted.
				const [owned, deleted] = await Promise.all([
					library.libraryTrackIds({ isrcs, spotifyTrackIds }),
					library.deletedKeys({ isrcs, spotifyTrackIds }),
				]);
				const map: Record<string, string> = {};
				const tierMap: Record<string, FeedMembershipTier> = {};
				const pinnedIds: string[] = [];
				for (const t of refs) {
					const id = (item.source === 'spotify' ? owned.bySpotify[t.sourceTrackId] : undefined)
						?? (t.isrc ? owned.byIsrc[t.isrc] : undefined);
					if (id) map[t.sourceTrackId] = id;
					const tier = (item.source === 'spotify' ? owned.tierBySpotify[t.sourceTrackId] : undefined)
						?? (t.isrc ? owned.tierByIsrc[t.isrc] : undefined);
					if (tier) tierMap[t.sourceTrackId] = tier;
					// Pinned drives Not Interested (un-pin); owned-but-not-pinned (local
					// file / own playlist) gets only the non-destructive Tag / Playlist.
					if ((item.source === 'spotify' && owned.pinnedBySpotify.has(t.sourceTrackId)) || (t.isrc != null && owned.pinnedByIsrc.has(t.isrc)))
						pinnedIds.push(t.sourceTrackId);
				}
				detail.inLibraryTrackIds = map;
				detail.membershipBySourceTrackId = tierMap;
				detail.pinnedSourceTrackIds = pinnedIds;
				detail.deletedSourceTrackIds = refs
					.filter((t) => (item.source === 'spotify' && deleted.spotify.has(t.sourceTrackId)) || (t.isrc != null && deleted.isrc.has(t.isrc)))
					.map((t) => t.sourceTrackId);
			}
			// "Muted" chip set — album tracks credited to a muted artist
			// (feed_suppression scope 'artist'). Precise by artist id where the ref
			// carries them; for refs that predate FeedTrackRef.artistIds we fall
			// back to album-level artist NAMES whose id is muted (covers the
			// primaries for free — no extra Spotify call). Album items only: a
			// partial mute keeps the release but flags its offending rows.
			if (item.type === 'album' && refs.length > 0) {
				const mutedKeys = await store.suppressedKeys('artist');
				if (mutedKeys.size > 0) {
					const ids = item.payload.artistIds ?? [];
					const names = item.payload.artists ?? [];
					const mutedNames = new Set(
						ids.map((id, i) => (id && mutedKeys.has(`artist:${id}`) ? names[i] : undefined))
							.filter((n): n is string => !!n),
					);
					detail.mutedSourceTrackIds = refs
						.filter((t) =>
							(t.artistIds ?? []).some((id) => mutedKeys.has(`artist:${id}`)) ||
							t.artists.some((n) => mutedNames.has(n)),
						)
						.map((t) => t.sourceTrackId);
				}
			}
			return detail;
		},
		async enrichItem(itemId) {
			return enrichment.enrichItem(itemId);
		},
		async action(action): Promise<FeedActionResult> {
			// Suppress-only — no target row required (unlike every other action).
			// Mutes each scope; an artist mute leaves albums in place (their tracks
			// chip via getItemDetail) but still hides matching track items at the
			// next read. `dismissItemId` additionally removes one item — the
			// multi-artist TRACK behind "Mute all artists", which should vanish.
			if (action.kind === 'mute') {
				for (const s of action.scopes) {
					await store.addSuppression(s.scope, s.key);
					decisions?.suppression(s.key, s.scope, true);
				}
				if (action.dismissItemId) {
					const it = await store.getItem(action.dismissItemId);
					if (it) {
						await store.markState(it.id, 'dismissed');
						decisions?.itemState(it.dedupeKey, 'dismissed');
						await store.recordSignal({
							itemId: it.id,
							kind: 'dismiss',
							value: { scope: action.scopes.map((s) => `${s.scope}:${s.key}`).join(',') },
						});
					}
				}
				return { ok: true };
			}
			const item = await store.getItem(action.itemId);
			if (!item) return { ok: false, error: 'feed item not found' };
			switch (action.kind) {
				case 'seen':
				case 'expanded': {
					// Don't regress expanded → seen when cards re-enter the viewport.
					if (item.state === 'fresh' || (action.kind === 'expanded' && item.state === 'seen')) {
						await store.markState(item.id, action.kind);
						decisions?.itemState(item.dedupeKey, action.kind);
					}
					await store.recordSignal({ itemId: item.id, kind: action.kind === 'seen' ? 'impression' : 'expand' });
					return { ok: true };
				}
				case 'played': {
					await store.markPlayed(item.id);
					decisions?.played(item.dedupeKey, item.playedAt ?? Date.now(), action.sourceTrackId ?? null);
					await store.recordSignal({
						itemId: item.id,
						kind: 'listen',
						value: { sourceTrackId: action.sourceTrackId, ms: action.ms },
					});
					return { ok: true };
				}
				case 'unavailable': {
					// Reactive play-failure flag (see player.ts): Spotify refused this
					// source track with 403 "Restriction violated" and the market probe
					// confirmed is_playable:false. Record it globally so every item that
					// carries the track dims + auto-skips. No signal — it's a fact about
					// the track, not a preference.
					await store.markUnavailable(action.sourceTrackId);
					decisions?.suppression(`track:${action.sourceTrackId}`, 'track', true);
					return { ok: true };
				}
				case 'dismiss': {
					// Soft remove — row + signals retained as negative-preference
					// tuning data; the scope (when given) suppresses the whole
					// artist/label/playlist from future pages.
					await store.markState(item.id, 'dismissed');
					decisions?.itemState(item.dedupeKey, 'dismissed');
					await store.recordSignal({
						itemId: item.id,
						kind: 'dismiss',
						value: action.scope ? { scope: `${action.scope.scope}:${action.scope.key}` } : null,
					});
					if (action.scope) {
						await store.addSuppression(action.scope.scope, action.scope.key);
						decisions?.suppression(action.scope.key, action.scope.scope, true);
					}
					return { ok: true };
				}
				case 'archive': {
					// Explicit set-aside: leaves the main feed, lands on the
					// Archived page, restorable. Kept as tuning data like dismiss.
					await store.markState(item.id, 'archived');
					decisions?.itemState(item.dedupeKey, 'archived');
					await store.recordSignal({ itemId: item.id, kind: 'archive' });
					return { ok: true };
				}
				case 'unarchive': {
					// Back to the visible feed. 'seen' (not 'fresh') so it doesn't
					// masquerade as new; ordering is by published/fetched time, so
					// it returns to its chronological slot, not the top.
					await store.markState(item.id, 'seen');
					decisions?.itemState(item.dedupeKey, 'seen');
					return { ok: true };
				}
				case 'interested': {
					// Promotion seam: resolve the Spotify track here (feed-side),
					// then hand off to the LibraryPort for the curator.db writes.
					if (item.source !== 'spotify') {
						return { ok: false, error: `promotion not supported for source '${item.source}' yet` };
					}
					const sourceTrackId = action.sourceTrackId ?? (item.type === 'track' ? item.sourceId : null);
					if (!sourceTrackId) return { ok: false, error: 'sourceTrackId required for album/playlist items' };
					// Producers stash the full SpotifyTrack on the payload when they
					// had it (playlist deltas); album tracks need a refetch for ISRC.
					let st: SpotifyTrack | null = null;
					const raw = item.payload.raw as SpotifyTrack | undefined;
					if (raw?.id === sourceTrackId && raw.external_ids !== undefined) st = raw;
					if (!st) {
						const client = await spotifyClient('interactive:promote');
						if (!client) return { ok: false, error: 'Spotify not connected' };
						const [fetched] = await client.getTracksByIds([sourceTrackId]);
						if (!fetched) return { ok: false, error: 'track not found on Spotify' };
						st = fetched;
					}
					// Ensure the Beatport metadata is present before promoting — the
					// user may keep a card the background drain hasn't reached yet.
					// Idempotent + single item, so this is WAF-safe; an already-
					// enriched item returns instantly. Falls back to the un-enriched
					// item if the lookup turns up nothing.
					const enriched = (await enrichment.enrichItem(item.id)) ?? item;
					// The enrichment to carry onto the library row: the matching album
					// track's ref (per-track enrichment) for an album, else the item
					// payload for a track item. Both carry the DJ fields AND the matched
					// source_links, so promotion reconstructs the same EnrichmentResult a
					// direct library enrich produces (null source → fallback enrich).
					const src = enriched.type === 'album'
						? enriched.payload.tracks?.find((t) => t.sourceTrackId === sourceTrackId) ?? null
						: enriched.payload;
					const result: EnrichmentResult | null = src
						? {
							patch: (src.bpm != null || src.keyCamelot || src.genre || src.label)
								? { bpm: src.bpm ?? null, keyCamelot: src.keyCamelot ?? null, genre: src.genre ?? null, label: src.label ?? null, releaseDate: src.releaseDate ?? null }
								: null,
							sourceLinks: src.sourceLinks ?? [],
							errored: false,
						}
						: null;
					const trackId = await library.promote(st, result, { pin: action.pin ?? true });
					await store.recordSignal({ itemId: item.id, kind: 'promote', value: { sourceTrackId } });
					// Album items stay in the feed (the user may want more of its
					// tracks); only single-track items flip to promoted.
					if (item.type === 'track') {
						await store.markState(item.id, 'promoted', { promotedTrackId: trackId });
						decisions?.itemState(item.dedupeKey, 'promoted', trackId);
					}
					return { ok: true, promotedTrackId: trackId };
				}
				case 'uninterested': {
					// Remove the track from the library (drops it + its interested
					// tag) — the inverse of 'interested'. For a promoted track item,
					// return the feed item to the visible feed and clear the now-dead
					// reference; album items keep their state (only a nested track left).
					await library.unpromote(action.trackId);
					if (item.type === 'track' && item.promotedTrackId === action.trackId) {
						await store.clearPromotion(item.id);
						decisions?.itemState(item.dedupeKey, 'seen');
					}
					return { ok: true };
				}
			}
		},
		async unfollowPlaylist(playlistId): Promise<FeedActionResult> {
			// Remote write — gated. Off-product code (no policy) throws here before
			// touching the live account.
			remoteWriteGate({ source: 'spotify', op: 'unfollowPlaylist', remoteId: playlistId });
			// Source first, fail-closed: if the unfollow doesn't land, the delta
			// producer would just re-add the items on the next poll, so don't
			// delete locally on a failure.
			const client = await spotifyClient('interactive:unfollow');
			if (!client) return { ok: false, error: 'Spotify not connected' };
			try {
				await client.unfollowPlaylist(playlistId);
			} catch (err) {
				return { ok: false, error: `unfollow failed: ${err instanceof Error ? err.message : String(err)}` };
			}
			// Re-read the followed playlists (now without this one) so a track
			// also in a playlist you still follow is kept — only items where this
			// was the last followed playlist are evicted. Owned playlists never
			// produce feed keys, so including them in the set is harmless.
			const playlists = await client.getUserPlaylists().catch(() => []);
			const removed = await store.removeOriginItems('playlist', playlistId, new Set(playlists.map((p) => p.id)));
			return { ok: true, removed };
		},
		async unfollowArtist(artistId): Promise<FeedActionResult> {
			// Remote write — gated (see unfollowPlaylist).
			remoteWriteGate({ source: 'spotify', op: 'unfollowArtist', remoteId: artistId });
			// Source first, fail-closed — same contract as unfollowPlaylist.
			const client = await spotifyClient('interactive:unfollow');
			if (!client) return { ok: false, error: 'Spotify not connected' };
			try {
				await client.unfollowArtist(artistId);
			} catch (err) {
				return { ok: false, error: `unfollow failed: ${err instanceof Error ? err.message : String(err)}` };
			}
			// Re-read the follow list (now without this artist) so a release
			// shared with an artist you still follow is kept — only items where
			// this was the last followed artist are evicted. Read-after-write lag
			// is harmless: the store excludes `artistId` from "still followed"
			// regardless.
			const followed = await client.getFollowedArtists().catch(() => []);
			const removed = await store.removeOriginItems('artist', artistId, new Set(followed.map((a) => a.id)));
			return { ok: true, removed };
		},
		async refresh() {
			return followerSkip() ?? scheduler.runAll();
		},
		async refreshProducer(producerId) {
			return followerSkip() ?? scheduler.refreshProducer(producerId);
		},
		async loadMore(days) {
			const skip = followerSkip();
			if (skip) return skip;
			const clamped = Math.min(Math.max(Math.round(days) || 7, 1), 60);
			return scheduler.backfillAll(clamped);
		},
		subscribeEnriched(cb) {
			enrichedListeners.add(cb);
			return () => { enrichedListeners.delete(cb); };
		},
		startPolling() {
			// Starts background timers only for auto-poll producers — currently a
			// no-op (both Spotify producers are manual-only; see AUTO_POLL). Ingest
			// runs on Refresh / Refresh-producer / Load More instead.
			// A follower runs no producer, timers included (feed/sync.ts).
			if (role().role === 'collector') scheduler.start();
			// Drain any pre-existing backlog (items fetched before the enricher
			// existed). Enrichment is Beatport-only, no Spotify quota, so it runs
			// regardless of producer state.
			enrichment.kick();
		},
		role,
		stop() {
			scheduler.stop();
			enrichment.stop();
			store.close();
		},
	};
}
