// Spotify sync — pulls the user's playlists + Liked Songs into the local DB.
// For Phase 2 we do a full refetch each run (Spotify exposes snapshot_id but
// not deltas; incremental optimization can come later). Cross-source resolution
// (matching Spotify tracks to Tidal SourceLinks) is Phase 4.
//
// Idempotent: re-running won't duplicate rows. Each (source, source_track_id)
// is uniqued; each playlist's tracks are replaced wholesale on every sync.

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { sortColumn } from './sort.js';
import type { ZTrackSortT } from '@curator/shared';
import { randomUUID } from 'node:crypto';
import { recordingIdForTrack } from '../sync-log/recording-id.js';
import * as mut from '../library/mutators.js';
import { rawOf } from '../library/artists.js';
import { SpotifyClient, type SpotifyPlaylist, type SpotifyPlaylistTrack, type SpotifyTrack } from '@curator/spotify';
import type { FetchLike as BeatportFetch } from '@curator/beatport';
import { enrichOne } from '../enrich/runner.js';
import { BeatportEnricher } from '../enrich/enrichers/beatport.js';
import { TraxsourceEnricher } from '../enrich/enrichers/traxsource.js';
import { LibrarySink } from '../enrich/sinks/library-sink.js';
import type { Db } from '../db/client.js';
import { AuthService } from '../auth/service.js';
import {
	track,
	sourceLink,
	playlist,
	playlistTrack,
	syncJob,
	type NewTrack,
	type NewSourceLink,
	type NewPlaylist,
	type TrackArtist,
} from '@curator/shared/schema';
import { asciify, searchFold } from '@curator/shared';
import { normalizeIncomingArtists, syncTrackArtists } from '../library/artists.js';
import { syncTrackAlbumsById } from '../library/albums.js';
import { upsertArtistLinks } from '../library/artist-links.js';
import { findExistingByContent } from './match-existing.js';
import { normalizeIsrc } from '@curator/library-logic';
import { log } from '../log.js';

const synclog = log.for('sync');
const bplog = log.for('beatport');

export interface EnrichmentResult {
	bpm: number | null;
	keyCamelot: string | null;
	genre: string | null;
	label: string | null;
}

export interface SyncProgress {
	stage: 'starting' | 'playlists-listing' | 'playlist-tracks' | 'playlist-skipped' | 'liked-songs' | 'enriching' | 'done' | 'error';
	// Which provider's sync emitted this event. Absent = spotify (the
	// original emitter, kept unstamped so nothing downstream changes);
	// TidalSync stamps 'tidal' on every event and the renderer routes
	// those to the Tidal tab's indicator instead of the Spotify sync view.
	source?: 'spotify' | 'tidal';
	currentPlaylist?: { id: string | null; name: string; index: number; total: number; reason?: 'unchanged' };
	enrichment?: {
		// `source` controls how the renderer surfaces success: Beatport pulls
		// metadata so we send the new field values; Tidal is a link-only match
		// so the renderer just adds the source pip + maybe a toast count.
		source: 'beatport' | 'tidal';
		index: number;
		total: number;
		trackId: string;
		trackTitle: string;
		phase: 'before' | 'after';
		// Beatport: set on 'after' when the lookup succeeded — the new values
		// the renderer should write into the row in place.
		result?: EnrichmentResult | null;
		// Tidal: set on 'after' so the renderer can know whether to light up
		// the SRC pip without re-fetching source_links per row.
		matched?: boolean;
	};
	totals?: { playlists: number; tracksUpserted: number; tracksEnriched?: number; playlistsSkipped?: number };
	error?: string;
}

export type ProgressFn = (p: SyncProgress) => void;

export const LIKED_SONGS_SENTINEL_ID = 'liked-songs';

export interface SpotifySyncOptions {
	beatportFetch?: BeatportFetch;
	cancelToken?: import('./cancellation.js').CancelToken;
	// The one curator.db enrichment sink. Shared with feed promotion so a
	// promoted track and a directly-enriched one go through the same persist
	// path. Falls back to a fresh sink (stateless) when not injected.
	librarySink?: LibrarySink;
}

export class SpotifySync {
	private readonly beatportFetch?: BeatportFetch;
	private readonly cancelToken?: import('./cancellation.js').CancelToken;
	private readonly librarySink: LibrarySink;

	constructor(
		private readonly db: Db,
		private readonly auth: AuthService,
		opts: SpotifySyncOptions = {}
	) {
		this.beatportFetch = opts.beatportFetch;
		this.cancelToken = opts.cancelToken;
		this.librarySink = opts.librarySink ?? new LibrarySink(db);
	}

	// Pre-flight diff: hits Spotify once and reports which local Spotify
	// playlists are no longer present remotely. The renderer uses this to
	// ask the user before deleting anything destructively.
	async planRun(): Promise<{ toAdd: number; toUpdate: number; toRemove: { id: string; sourceId: string; name: string }[] }> {
		const accessToken = await this.auth.getSpotifyAccessToken();
		if (!accessToken) throw new Error('Spotify not connected');
		const client = new SpotifyClient(accessToken, 'sync:plan');
		const remote = await client.getUserPlaylists();
		const remoteIds = new Set(remote.map((p) => p.id));
		const localRows = this.db.select().from(playlist).where(eq(playlist.source, 'spotify')).all();
		const localByRemote = new Map(localRows.map((r) => [r.sourceId, r]));
		const toRemove = localRows
			.filter((r) => r.sourceId !== LIKED_SONGS_SENTINEL_ID && !remoteIds.has(r.sourceId))
			.map((r) => ({ id: r.id, sourceId: r.sourceId, name: r.name }));
		let toAdd = 0;
		let toUpdate = 0;
		for (const r of remote) {
			const prior = localByRemote.get(r.id);
			if (!prior) toAdd++;
			else if (prior.syncCursor !== r.snapshot_id) toUpdate++;
		}
		return { toAdd, toUpdate, toRemove };
	}

	async run(
		progress: ProgressFn = () => {},
		opts: { deleteRemoved?: boolean; force?: boolean } = {}
	): Promise<{ playlists: number; tracksUpserted: number; removed: number }> {
		const jobId = randomUUID();
		this.db.insert(syncJob).values({
			id: jobId,
			source: 'spotify',
			kind: 'full',
			state: 'running',
			startedAt: new Date(),
		}).run();

		try {
			progress({ stage: 'starting' });
			const accessToken = await this.auth.getSpotifyAccessToken();
			if (!accessToken) throw new Error('Spotify not connected');

			const client = new SpotifyClient(accessToken, 'sync:run');

			progress({ stage: 'playlists-listing' });
			const playlists = await client.getUserPlaylists();

			// Pre-load existing playlist rows keyed by sourceId so we can compare
			// each remote playlist's snapshot_id to our stored syncCursor and
			// skip the expensive /tracks fetch when nothing changed.
			const existing = new Map(
				this.db
					.select()
					.from(playlist)
					.where(eq(playlist.source, 'spotify'))
					.all()
					.map((p) => [p.sourceId, p])
			);

			let tracksUpserted = 0;
			let playlistsSkipped = 0;
			for (let i = 0; i < playlists.length; i++) {
				const pl = playlists[i]!;
				const prior = existing.get(pl.id);
				// `force` bypasses the snapshot_id short-circuit so every
				// playlist's /tracks endpoint is re-fetched. Used by the
				// "Resync entirely" UI path when the user suspects local
				// drift from remote (positions stale, removed-from-catalog
				// tracks lingering, addedAt mismatches, etc.).
				const unchanged = !opts.force
					&& !!prior
					&& prior.syncStatus === 'synced'
					&& prior.syncCursor === pl.snapshot_id
					&& !!pl.snapshot_id;

				if (unchanged) {
					// Cheap path: refresh metadata only (name/cover may differ),
					// leave tracks untouched. Re-stamp the sync timestamps so
					// "Last Synced" reflects this scan even when nothing was
					// fetched — same effect as the prior upsertPlaylist call.
					const id = this.upsertPlaylistMeta(pl);
					this.markPlaylistSynced(id, pl.snapshot_id);
					playlistsSkipped++;
					progress({
						stage: 'playlist-skipped',
						currentPlaylist: { id: prior?.id ?? null, name: pl.name, index: i + 1, total: playlists.length + 1, reason: 'unchanged' },
					});
					continue;
				}

				progress({
					stage: 'playlist-tracks',
					currentPlaylist: { id: prior?.id ?? null, name: pl.name, index: i + 1, total: playlists.length + 1 },
				});
				tracksUpserted += await this.syncPlaylist(pl, client);
			}

			// "Liked Songs" — synthetic playlist with stable id
			const likedExisting = this.db
				.select({ id: playlist.id })
				.from(playlist)
				.where(and(eq(playlist.source, 'spotify'), eq(playlist.sourceId, LIKED_SONGS_SENTINEL_ID)))
				.get();
			progress({
				stage: 'liked-songs',
				currentPlaylist: { id: likedExisting?.id ?? null, name: 'Liked Songs', index: playlists.length + 1, total: playlists.length + 1 },
			});
			tracksUpserted += await this.syncLikedSongs(client);

			// Deletion of orphan playlists — only when explicitly requested by
			// the renderer's plan-and-confirm flow. We never reap silently:
			// users who manually unfollow a playlist deserve a confirmation
			// step in the UI before we remove their saved tracks association.
			let removed = 0;
			if (opts.deleteRemoved) {
				const remoteIds = new Set(playlists.map((p) => p.id));
				const orphans = this.db
					.select({ id: playlist.id })
					.from(playlist)
					.where(eq(playlist.source, 'spotify'))
					.all()
					.filter((r) => {
						const rec = this.db.select({ sourceId: playlist.sourceId }).from(playlist).where(eq(playlist.id, r.id)).get();
						return rec && rec.sourceId !== LIKED_SONGS_SENTINEL_ID && !remoteIds.has(rec.sourceId);
					});
				for (const o of orphans) {
					// playlist delete op (container delete wins over its rows).
					mut.deletePlaylist(this.db, o.id);
					removed++;
				}
			}

			// Beatport enrichment is no longer triggered during sync — it's a
			// manual action per-playlist now. See enrichBeatportPlaylist().

			this.db
				.update(syncJob)
				.set({
					state: 'done',
					finishedAt: new Date(),
					stats: { added: tracksUpserted, matched: 0, updated: 0, removed },
				})
				.where(eq(syncJob.id, jobId))
				.run();

			progress({
				stage: 'done',
				totals: {
					playlists: playlists.length + 1,
					tracksUpserted,
					playlistsSkipped,
				},
			});
			return { playlists: playlists.length + 1, tracksUpserted, removed };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.db
				.update(syncJob)
				.set({ state: 'failed', finishedAt: new Date(), error: message })
				.where(eq(syncJob.id, jobId))
				.run();
			progress({ stage: 'error', error: message });
			throw err;
		}
	}

	private async syncPlaylist(pl: SpotifyPlaylist, client: SpotifyClient): Promise<number> {
		// Order matters: fetch tracks BEFORE committing any DB state. If
		// the network call fails, no row is left in a half-synced state
		// (claiming the snapshot is up-to-date while its tracks are stale).
		// Track-write + markSynced run last so the consistency invariant
		// holds: syncCursor only ever matches the snapshot whose tracks
		// were actually written.
		const items = await client.getPlaylistTracks(pl.id);
		const playlistId = this.upsertPlaylistMeta(pl);
		const n = this.replacePlaylistTracks(playlistId, items);
		this.markPlaylistSynced(playlistId, pl.snapshot_id);
		return n;
	}

	// Single-playlist sync — used for lazy-sync-on-click. Looks up the
	// playlist by internal id, requires it's a Spotify playlist, fetches just
	// its tracks. Skips the user-wide playlist list refresh.
	async runSinglePlaylist(
		playlistRowId: string,
		progress: ProgressFn = () => {},
		opts: { force?: boolean } = {}
	): Promise<{ tracksUpserted: number; tracksEnriched: number; skipped: boolean }> {
		progress({ stage: 'starting' });
		const accessToken = await this.auth.getSpotifyAccessToken();
		if (!accessToken) throw new Error('Spotify not connected');

		const row = this.db.select().from(playlist).where(eq(playlist.id, playlistRowId)).get();
		if (!row) throw new Error(`Playlist ${playlistRowId} not found`);
		if (row.source !== 'spotify') throw new Error(`Playlist ${row.name} is not a Spotify playlist`);

		const client = new SpotifyClient(accessToken, 'sync:playlist');
		const isLiked = row.sourceId === 'liked-songs';

		// Pre-fetch playlist meta (non-liked only). Used for BOTH the
		// snapshot short-circuit AND the post-write syncCursor stamp — same
		// network call, two purposes. Without this, the success path used
		// to leave syncCursor unwritten, so every subsequent sync of this
		// playlist refetched its tracks regardless of whether Spotify said
		// they changed.
		let meta: SpotifyPlaylist | null = null;
		if (!isLiked) {
			try {
				meta = await client.getPlaylist(row.sourceId);
			} catch (err) {
				// Network / 404 / etc. — log and fall through to the full
				// sync attempt. The tracks fetch below may also fail (and
				// surface a clear error), or it may succeed against a
				// transiently-flaky meta endpoint — either way we don't
				// short-circuit on a meta failure.
				synclog.warn('meta probe failed, attempting full sync anyway', { playlist: row.name }, err);
			}
		}

		// Snapshot check — only when meta is available and prior cursor matches.
		if (!opts.force && meta?.snapshot_id && row.syncStatus === 'synced'
				&& row.syncCursor && row.syncCursor === meta.snapshot_id) {
			// Refresh metadata + re-stamp lastSyncedAt; tracks are already
			// current per the snapshot match.
			const id = this.upsertPlaylistMeta(meta);
			this.markPlaylistSynced(id, meta.snapshot_id);
			progress({
				stage: 'playlist-skipped',
				currentPlaylist: { id: row.id, name: row.name, index: 1, total: 1, reason: 'unchanged' },
			});
			progress({ stage: 'done', totals: { playlists: 1, tracksUpserted: 0, tracksEnriched: 0, playlistsSkipped: 1 } });
			return { tracksUpserted: 0, tracksEnriched: 0, skipped: true };
		}

		progress({
			stage: 'playlist-tracks',
			currentPlaylist: { id: row.id, name: row.name, index: 1, total: 1 },
		});

		// Visual-only state — doesn't touch syncCursor. The real sync
		// stamps land via markPlaylistSynced after the tracks commit.
		this.db.update(playlist).set({ syncStatus: 'syncing' }).where(eq(playlist.id, playlistRowId)).run();

		try {
			let tracksUpserted = 0;
			if (isLiked) {
				const items = await client.getLikedSongs();
				tracksUpserted = this.replacePlaylistTracks(playlistRowId, items);
				// Liked Songs has no real snapshot — empty string stamps
				// "synced this run" for the status/lastSyncedAt update.
				this.markPlaylistSynced(playlistRowId, '');
			} else {
				const items = await client.getPlaylistTracks(row.sourceId);
				// Refresh metadata too, in case name/owner/cover changed.
				// When meta is missing (pre-fetch failed), we skip the meta
				// refresh AND leave syncCursor alone — the next sync will
				// see a mismatch and refetch, which is the safe fallback.
				const id = meta ? this.upsertPlaylistMeta(meta) : playlistRowId;
				tracksUpserted = this.replacePlaylistTracks(id, items);
				if (meta?.snapshot_id) {
					this.markPlaylistSynced(id, meta.snapshot_id);
				} else {
					// Meta-less fallback: stamp status + lastSyncedAt but
					// don't touch syncCursor. Matches the pre-fix behavior
					// for this edge case.
					this.db
						.update(playlist)
						.set({ syncStatus: 'synced', lastSyncedAt: new Date(), syncError: null })
						.where(eq(playlist.id, playlistRowId))
						.run();
				}
			}

			progress({ stage: 'done', totals: { playlists: 1, tracksUpserted } });
			return { tracksUpserted, tracksEnriched: 0, skipped: false };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.db.update(playlist).set({ syncStatus: 'error', syncError: message }).where(eq(playlist.id, playlistRowId)).run();
			progress({ stage: 'error', error: message });
			throw err;
		}
	}

	private async syncLikedSongs(client: SpotifyClient): Promise<number> {
		// Fetch BEFORE committing meta+stamps — same invariant as
		// syncPlaylist: a mid-fetch failure must not leave a half-synced
		// row behind. Liked Songs has no real snapshot_id (Spotify doesn't
		// expose one for /me/tracks), but we keep the same shape so the
		// invariant logic stays uniform across all playlist paths.
		const items = await client.getLikedSongs();
		const synthPl = {
			id: LIKED_SONGS_SENTINEL_ID,
			name: 'Liked Songs',
			description: null,
			owner: { id: 'me', display_name: 'You' },
			images: [],
			tracks: { total: 0 },
			collaborative: false,
			public: false,
			snapshot_id: '',
			external_urls: { spotify: 'https://open.spotify.com/collection/tracks' },
		};
		const playlistId = this.upsertPlaylistMeta(synthPl, { mark: '♡' });
		const n = this.replacePlaylistTracks(playlistId, items);
		this.markPlaylistSynced(playlistId, '');
		return n;
	}

	// ─── Playlist upsert ─────────────────────────────────────────────────

	// Write playlist metadata (name, owner, cover, etc.) WITHOUT touching
	// the sync stamps (syncStatus / syncCursor / lastSyncedAt). The stamps
	// commit separately via markPlaylistSynced() only AFTER the playlist's
	// tracks land successfully — so a mid-fetch failure can never leave a
	// row claiming "synced" with stale/missing tracks behind it.
	//
	// For NEW playlists the initial sync stamps are intentionally `pending`
	// / null: until tracks are written, the next sync should refetch (the
	// snapshot check at the call site treats null-cursor rows as needing
	// work). For EXISTING playlists the prior stamps are preserved — only
	// the metadata columns + remoteUpdatedAt change here.
	private upsertPlaylistMeta(pl: SpotifyPlaylist, opts: { mark?: string } = {}): string {
		const existing = this.db
			.select()
			.from(playlist)
			.where(and(eq(playlist.source, 'spotify'), eq(playlist.sourceId, pl.id)))
			.get();

		const now = new Date();
		// Remote-updated is "when we last saw a snapshot change". If the
		// snapshot differs from prior (or this is the first time we see it),
		// stamp the current time. Otherwise keep the prior stamp.
		const snapshotChanged = !existing || existing.syncCursor !== pl.snapshot_id;
		const remoteUpdatedAt = snapshotChanged ? now : existing!.remoteUpdatedAt;

		if (existing) {
			// A provider-side rename is a playlist rename op; the rest of the
			// metadata (owner, cover, counts, stamps) is provider data.
			rawOf(this.db).transaction(() => {
				mut.renamePlaylist(this.db, existing.id, pl.name);
				this.db
					.update(playlist)
					.set({
						name: pl.name,
						nameAscii: searchFold(pl.name),
						description: pl.description,
						ownerName: pl.owner.display_name,
						ownerId: pl.owner.id,
						coverUrl: pl.images?.[0]?.url ?? null,
						trackCount: pl.tracks.total,
						isCollaborative: pl.collaborative,
						isPublic: pl.public,
						remoteUpdatedAt,
						updatedAt: now,
						...(opts.mark ? { mark: opts.mark } : {}),
					})
					.where(eq(playlist.id, existing.id))
					.run();
			})();
			return existing.id;
		}

		const id = randomUUID();
		const row: NewPlaylist = {
			id,
			source: 'spotify',
			sourceId: pl.id,
			url: pl.external_urls?.spotify ?? null,
			name: pl.name,
			nameAscii: searchFold(pl.name),
			description: pl.description,
			ownerName: pl.owner.display_name,
			ownerId: pl.owner.id,
			coverUrl: pl.images?.[0]?.url ?? null,
			trackCount: pl.tracks.total,
			followers: null,
			isCollaborative: pl.collaborative,
			isPublic: pl.public,
			// Sync stamps start unset on insert — markPlaylistSynced fills
			// them after tracks land. Otherwise a failure between this
			// insert and the track write would mark the playlist 'synced'
			// with no tracks, and the next sync would skip it.
			lastSyncedAt: null,
			remoteUpdatedAt,
			syncStatus: 'pending',
			syncError: null,
			syncCursor: null,
			mark: opts.mark ?? 'P',
			isFavorite: false,
			isHidden: false,
			createdAt: now,
			updatedAt: now,
		};
		mut.createPlaylist(this.db, row);
		return id;
	}

	// Commit the sync stamps. Called by syncPlaylist / syncLikedSongs ONLY
	// after the playlist's tracks have been written successfully — so the
	// pair (syncCursor, playlist_track rows) stays consistent. If anything
	// fails before this is reached, the playlist row keeps its prior
	// syncCursor (or `null` on a brand-new insert), which means the next
	// sync will detect "snapshot mismatch" and re-fetch.
	private markPlaylistSynced(playlistRowId: string, snapshotId: string): void {
		this.db
			.update(playlist)
			.set({
				syncStatus: 'synced',
				syncCursor: snapshotId,
				lastSyncedAt: new Date(),
				syncError: null,
			})
			.where(eq(playlist.id, playlistRowId))
			.run();
	}

	// Make a playlist's rows the provider's list, atomically: upsert tracks +
	// source_links, then reconcile membership against the provider's order
	// (mutators.reconcileMembership: add/move/remove ops for the diff, nothing
	// for rows that did not change). One transaction for the whole playlist,
	// so the per-track writes and their ops commit together and a 2,000-row
	// import is one commit instead of thousands of autocommits. Returns the
	// number of tracks upserted.
	private replacePlaylistTracks(playlistRowId: string, items: SpotifyPlaylistTrack[]): number {
		return rawOf(this.db).transaction(() => this.replacePlaylistTracksTx(playlistRowId, items))();
	}

	private replacePlaylistTracksTx(playlistRowId: string, items: SpotifyPlaylistTrack[]): number {
		// filter out items where Spotify track is null (rare — removed-from-catalog)
		const validItems = items.filter((it) => it.track && it.track.id);

		// Preserve the earliest known add-date per member. Spotify stamps
		// added_at at add time and any full re-add (the 2026-06-27 disaster
		// recovery; a PUT-style replace) RESETS it for every item — which
		// destroyed the recency dimension for ~80 playlists. Curator keeps
		// the earliest value it has ever seen so its "Added" column stays
		// the source of truth for recency even when the remote lies.
		// Trade-off (deliberate): a track the user removed and later
		// genuinely re-added keeps its ORIGINAL date.
		const priorAddedAt = new Map<string, number>();
		for (const r of this.db
			.select({ sourceTrackId: playlistTrack.sourceTrackId, addedAt: playlistTrack.addedAt })
			.from(playlistTrack)
			.where(eq(playlistTrack.playlistId, playlistRowId))
			.all()) {
			if (r.sourceTrackId && r.addedAt) priorAddedAt.set(r.sourceTrackId, r.addedAt.getTime());
		}

		const desired: mut.DesiredMember[] = [];
		for (const item of validItems) {
			const t = item.track!;
			const trackId = this.upsertTrack(t);
			upsertArtistLinks(this.db, 'spotify', t.artists ?? []);
			const remoteMs = item.added_at ? new Date(item.added_at).getTime() : null;
			const priorMs = priorAddedAt.get(t.id) ?? null;
			const addedMs = priorMs != null && remoteMs != null
				? Math.min(priorMs, remoteMs)
				: priorMs ?? remoteMs;
			desired.push({
				trackId,
				addedAt: addedMs != null ? new Date(addedMs) : null,
				addedBy: item.added_by?.id ?? null,
				sourceTrackId: t.id,
			});
		}
		mut.reconcileMembership(this.db, playlistRowId, desired, 'spotify');
		return validItems.length;
	}

	// Public seam for the Discover feed's promotion path — resolves a full
	// SpotifyTrack to a canonical track.id using the exact same matching
	// rules as playlist sync (provider-id → ISRC → create). No parallel
	// matching logic anywhere else.
	ingestExternalTrack(t: SpotifyTrack): string {
		return this.upsertTrack(t);
	}

	// ─── Track upsert ────────────────────────────────────────────────────

	// Resolve a Spotify track to a canonical track.id, creating rows as
	// needed.
	//
	// Lookup order:
	//   1. (source='spotify', source_track_id=t.id) — exact provider id we've
	//      ingested before. Cheapest hit; refreshes the source_link payload.
	//   2. track.isrc = t.isrc — different Spotify ID, same recording. Spotify
	//      often carries the same song under multiple track ids (re-releases,
	//      regional variants). Without this lookup we'd create a duplicate
	//      canonical track row each time the same recording shows up via a
	//      new playlist that happens to reference a different Spotify ID.
	//      Attach a second source_link to the existing canonical track.
	//   3. Fall through — brand-new recording, create both rows.
	private upsertTrack(t: SpotifyTrack): string {
		const existing = this.db
			.select({ trackId: sourceLink.trackId })
			.from(sourceLink)
			.where(and(eq(sourceLink.source, 'spotify'), eq(sourceLink.sourceTrackId, t.id)))
			.get();

		// The provider snapshot (source_link.artists_local) stays verbatim — it
		// is what the artist backfill's protect set learns from. The canonical
		// row gets the normalized list (packed credits split, curated
		// spellings applied). Spotify reports no roles, so none are invented.
		const artists: TrackArtist[] = (t.artists ?? []).map((a) => ({ name: a.name }));
		const canonicalArtists = normalizeIncomingArtists(this.db, artists, { title: t.name, split: false });
		// Canonical form only; the verbatim provider value stays in `payload`.
		const isrc = normalizeIsrc(t.external_ids?.isrc);
		const duration = Math.round((t.duration_ms ?? 0) / 1000);

		if (existing) {
			// refresh the source_link blob (cheap; covers metadata changes upstream)
			this.db
				.update(sourceLink)
				.set({
					url: `https://open.spotify.com/track/${t.id}`,
					isrcLocal: isrc,
					titleLocal: t.name,
					artistsLocal: artists,
					albumLocal: t.album?.name ?? null,
					durationLocal: duration,
					payload: t as unknown,
					fetchedAt: new Date(),
				})
				.where(and(eq(sourceLink.source, 'spotify'), eq(sourceLink.sourceTrackId, t.id)))
				.run();
			// The refreshed payload may now carry the album / track position.
			syncTrackAlbumsById(this.db, [existing.trackId]);
			return existing.trackId;
		}

		// Second-chance match — same recording (ISRC) under a different
		// Spotify id. Reuse the existing canonical track, attach the new
		// source_link beside the prior one(s). A live row wins over a
		// soft-deleted one: a track merge leaves the ISRC on BOTH the survivor
		// and the tombstoned loser, and binding to the loser strands the link
		// on a deleted row. A deleted row is still the fallback so a track the
		// user deleted stays deleted when a new Spotify id for it shows up.
		if (isrc) {
			const byIsrc = this.db
				.select({ id: track.id })
				.from(track)
				.where(eq(track.isrc, isrc))
				.orderBy(sql`${track.deletedAt} IS NOT NULL`)
				.get();
			if (byIsrc) {
				const newLink: NewSourceLink = {
					id: randomUUID(),
					trackId: byIsrc.id,
					source: 'spotify',
					sourceTrackId: t.id,
					url: `https://open.spotify.com/track/${t.id}`,
					isrcLocal: isrc,
					titleLocal: t.name,
					artistsLocal: artists,
					albumLocal: t.album?.name ?? null,
					durationLocal: duration,
					bpmLocal: null,
					keyLocal: null,
					payload: t as unknown,
					fetchedAt: new Date(),
				};
				this.db.insert(sourceLink).values(newLink).run();
				mut.addClaims(this.db, byIsrc.id, [{ kind: 'spotify', value: t.id }]);
				syncTrackAlbumsById(this.db, [byIsrc.id]);
				return byIsrc.id;
			}
		}

		// Third-chance match — same recording under a provider id whose ISRC we
		// don't hold (rekordbox/scanner canonicals carry no streaming ISRC).
		// Attach beside the existing row and seed its ISRC so pass-2 resolves
		// directly next time. See match-existing.ts.
		const byContent = findExistingByContent(this.db, {
			title: t.name,
			artists: artists.map((a) => a.name),
			duration,
			isrc,
		});
		if (byContent) {
			if (byContent.seedIsrc) {
				this.db
					.update(track)
					.set({ isrc: byContent.seedIsrc })
					.where(and(eq(track.id, byContent.trackId), isNull(track.isrc)))
					.run();
			}
			this.db
				.insert(sourceLink)
				.values({
					id: randomUUID(),
					trackId: byContent.trackId,
					source: 'spotify',
					sourceTrackId: t.id,
					url: `https://open.spotify.com/track/${t.id}`,
					isrcLocal: isrc,
					titleLocal: t.name,
					artistsLocal: artists,
					albumLocal: t.album?.name ?? null,
					durationLocal: duration,
					bpmLocal: null,
					keyLocal: null,
					payload: t as unknown,
					fetchedAt: new Date(),
				})
				.run();
			mut.addClaims(this.db, byContent.trackId, [{ kind: 'spotify', value: t.id }, ...(byContent.seedIsrc ? [{ kind: 'isrc' as const, value: byContent.seedIsrc, confidence: 0.9 }] : [])]);
			syncTrackAlbumsById(this.db, [byContent.trackId]);
			return byContent.trackId;
		}

		const trackId = randomUUID();
		const newTrack: NewTrack = {
			id: trackId,
			recordingId: recordingIdForTrack(trackId),
			isrc,
			mbid: null,
			title: t.name,
			artists: canonicalArtists,
			albumTitle: t.album?.name ?? null,
			releaseDate: t.album?.release_date ?? null,
			coverUrl: t.album?.images?.[0]?.url ?? null,
			duration,
			bpm: null,
			keyCamelot: null,
			genre: null,
			label: null,
			copyright: null,
			explicit: t.explicit,
			state: 'unsorted',
			stateChangedAt: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		this.db.insert(track).values(asciify(newTrack)).run();
		syncTrackArtists(this.db, [{ id: trackId, artists: canonicalArtists, overrides: null }]);

		const newLink: NewSourceLink = {
			id: randomUUID(),
			trackId,
			source: 'spotify',
			sourceTrackId: t.id,
			url: `https://open.spotify.com/track/${t.id}`,
			isrcLocal: isrc,
			titleLocal: t.name,
			artistsLocal: artists,
			albumLocal: t.album?.name ?? null,
			durationLocal: duration,
			bpmLocal: null,
			keyLocal: null,
			payload: t as unknown,
			fetchedAt: new Date(),
		};
		this.db.insert(sourceLink).values(newLink).run();
		// A new recording: its library_track create plus the claims the
		// catalogue resolver reads (provider id, ISRC).
		mut.recordTrackCreated(this.db, trackId, [{ kind: 'spotify', value: t.id }, ...(isrc ? [{ kind: 'isrc' as const, value: isrc, confidence: 0.9 }] : [])]);
		// After the link: the album seam reads the album id off its payload.
		syncTrackAlbumsById(this.db, [trackId]);
		return trackId;
	}

	// ─── Beatport enrichment ─────────────────────────────────────────────
	// Per-track scrape of Beatport for tracks missing BPM/key/label/genre.
	// Runs sequentially with a small delay between hits — Beatport doesn't
	// publish rate limits but they cloudflare-block aggressive scrapers.
	// Now triggered manually via the playlist context menu, not during sync.

	async enrichBeatportPlaylist(
		playlistRowId: string,
		progress: ProgressFn = () => {},
		sort?: { column: ZTrackSortT['column']; dir: 'asc' | 'desc' }
	): Promise<{ enriched: number; scanned: number }> {
		// Pull tracks in the target playlist that don't have all of BPM/key/label
		// (we only enrich the unenriched). Order matches the user's visible
		// sort so the indicator moves down the list predictably.
		const orderCol = sort
			? (sort.column === 'index' ? playlistTrack.position : sortColumn(sort.column))
			: playlistTrack.position;
		const orderBy = sort?.dir === 'desc' ? desc(orderCol!) : asc(orderCol ?? playlistTrack.position);
		const targets = this.db
			.select({
				id: track.id,
				title: track.title,
				artists: track.artists,
				duration: track.duration,
				isrc: track.isrc,
				bpm: track.bpm,
				keyCamelot: track.keyCamelot,
				genre: track.genre,
				label: track.label,
			})
			.from(track)
			.innerJoin(playlistTrack, eq(playlistTrack.trackId, track.id))
			.where(and(
				eq(playlistTrack.playlistId, playlistRowId),
				isNull(track.bpm),
				isNull(track.keyCamelot),
				isNull(track.label),
			))
			.orderBy(orderBy)
			.all();

		// IMPORTANT: no 'starting' event — that's the sync overlay's trigger and
		// would yank the view off the playlist. Enrichment shows its own banner
		// + per-row updates on the existing tracks view.
		const result = await this.enrichTargets(targets, progress);
		progress({ stage: 'done', totals: { playlists: 0, tracksUpserted: 0, tracksEnriched: result.enriched } });
		return { enriched: result.enriched, scanned: targets.length };
	}

	async enrichBeatportTracks(trackIds: string[], progress: ProgressFn = () => {}): Promise<{ enriched: number; scanned: number }> {
		if (!trackIds.length) return { enriched: 0, scanned: 0 };
		// Select targets in the same order the renderer sent them — that's
		// already the user's visible sort. Drizzle's `inArray` doesn't
		// preserve order, so we sort client-side after the fetch.
		const idIndex = new Map(trackIds.map((id, i) => [id, i]));
		const rows = this.db
			.select({
				id: track.id,
				title: track.title,
				artists: track.artists,
				duration: track.duration,
				isrc: track.isrc,
				bpm: track.bpm,
				keyCamelot: track.keyCamelot,
				genre: track.genre,
				label: track.label,
			})
			.from(track)
			.where(inArray(track.id, trackIds))
			.all();
		rows.sort((a, b) => (idIndex.get(a.id) ?? 0) - (idIndex.get(b.id) ?? 0));
		const result = await this.enrichTargets(rows, progress);
		progress({ stage: 'done', totals: { playlists: 0, tracksUpserted: 0, tracksEnriched: result.enriched } });
		return { enriched: result.enriched, scanned: rows.length };
	}

	async enrichBeatportTrack(trackId: string, progress: ProgressFn = () => {}): Promise<{ enriched: number; scanned: number }> {
		const targets = this.db
			.select({
				id: track.id,
				title: track.title,
				artists: track.artists,
				duration: track.duration,
				isrc: track.isrc,
				bpm: track.bpm,
				keyCamelot: track.keyCamelot,
				genre: track.genre,
				label: track.label,
			})
			.from(track)
			.where(eq(track.id, trackId))
			.all();

		// Single-track enrichment is user-initiated for a specific row — bypass
		// the "only unenriched" filter so they can refresh stale data too.
		const result = await this.enrichTargets(targets, progress);
		progress({ stage: 'done', totals: { playlists: 0, tracksUpserted: 0, tracksEnriched: result.enriched } });
		return { enriched: result.enriched, scanned: targets.length };
	}

	private async enrichTargets(
		targets: { id: string; title: string; artists: TrackArtist[]; duration: number | null; isrc: string | null; bpm: number | null; keyCamelot: string | null; genre: string | null; label: string | null }[],
		progress: ProgressFn
	): Promise<{ enriched: number; cancelled: boolean }> {
		if (!targets.length) return { enriched: 0, cancelled: false };

		this.cancelToken?.reset();
		// One canonical Beatport enricher + the library sink. Field-merge policy
		// (local BPM/key win; Beatport fills genre/label) lives in the sink; the
		// 350ms politeness throttle is paced inside enrichOne. See
		// apps/core/src/enrich/.
		const enrichers = [new BeatportEnricher(this.beatportFetch), new TraxsourceEnricher(this.beatportFetch)];
		const sink = this.librarySink;
		let enriched = 0;
		for (let i = 0; i < targets.length; i++) {
			if (this.cancelToken?.cancelled) {
				bplog.info('enrichment cancelled by user');
				return { enriched, cancelled: true };
			}
			const t = targets[i]!;

			// Notify the renderer we're about to look this one up (so it can
			// highlight the row and bump the "x/y" counter).
			progress({
				stage: 'enriching',
				enrichment: {
					source: 'beatport',
					index: i + 1,
					total: targets.length,
					trackId: t.id,
					trackTitle: t.title,
					phase: 'before',
				},
			});

			let resultForRenderer: EnrichmentResult | null = null;

			const result = await enrichOne(
				{
					query: {
						title: t.title,
						artists: (t.artists ?? []).map((a) => a.name),
						durationSec: t.duration,
						isrc: t.isrc,
						label: t.label,
					},
				},
				enrichers,
				{ pacingMs: 350 },
			);
			const applied = await sink.persist(t.id, result);
			if (applied) {
				enriched++;
				resultForRenderer = {
					bpm: applied.bpm ?? null,
					keyCamelot: applied.keyCamelot ?? null,
					genre: applied.genre ?? null,
					label: applied.label ?? null,
				};
			}

			// Notify the renderer the lookup completed — carries the new field
			// values so the row can be updated in place.
			progress({
				stage: 'enriching',
				enrichment: {
					source: 'beatport',
					index: i + 1,
					total: targets.length,
					trackId: t.id,
					trackTitle: t.title,
					phase: 'after',
					result: resultForRenderer,
				},
			});
		}
		return { enriched, cancelled: false };
	}
}
