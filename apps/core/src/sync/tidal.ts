// Tidal sync — read-only pull of the user's Tidal playlists + their tracks
// into the local DB, the Tidal sibling of sync/spotify.ts. Same reconcile
// shape: upsert playlist meta, wholesale-replace playlist_track rows, resolve
// tracks provider-id → ISRC → create. Writes stay local — Tidal's write
// capabilities are off (see SourceCapabilities), so nothing here can touch
// the user's live account.
//
// Change detection: Tidal has no snapshot_id. The syncCursor is
// lastModifiedAt + numberOfItems from the playlist attributes — cheap to
// compare on every run, refetch only when the remote actually moved. A
// playlist without lastModifiedAt (never seen in practice; the field is in
// the v2 spec) falls back to always-refetch.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { recordingIdForTrack } from '../sync-log/recording-id.js';
import * as mut from '../library/mutators.js';
import { rawOf } from '../library/artists.js';
import { TidalApiClient, type TidalPlaylist, type TidalPlaylistItem, type TidalTrackV2 } from '@curator/tidal';
import type { Db } from '../db/client.js';
import { AuthService } from '../auth/service.js';
import { config } from '../config.js';
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
import { normalizeIncomingCredits, syncTrackArtists, syncTrackArtistsById } from '../library/artists.js';
import { syncTrackAlbumsById } from '../library/albums.js';
import { upsertArtistLinks } from '../library/artist-links.js';
import { findExistingByContent } from './match-existing.js';
import { normalizeIsrc } from '@curator/library-logic';
import type { ProgressFn } from './spotify.js';
import { log } from '../log.js';

const tlog = log.for('tidal-sync');

// Tidal catalog key (pitch-class enum + scale) → Camelot. Only MAJOR and the
// minor family map; modal scales (DORIAN, MIXOLYDIAN, …) have no wheel
// position and stay null. Applied to NEWLY minted tracks only — an
// analyzer-measured key on an existing row always wins.
const TIDAL_KEY_TO_CAMELOT: Record<string, { major: string; minor: string }> = {
	C:      { major: '8B',  minor: '5A' },
	CSharp: { major: '3B',  minor: '12A' },
	D:      { major: '10B', minor: '7A' },
	Eb:     { major: '5B',  minor: '2A' },
	E:      { major: '12B', minor: '9A' },
	F:      { major: '7B',  minor: '4A' },
	FSharp: { major: '2B',  minor: '11A' },
	G:      { major: '9B',  minor: '6A' },
	Ab:     { major: '4B',  minor: '1A' },
	A:      { major: '11B', minor: '8A' },
	Bb:     { major: '6B',  minor: '3A' },
	B:      { major: '1B',  minor: '10A' },
};
const MINOR_SCALES = new Set(['MINOR', 'AEOLIAN', 'HARMONIC_MINOR', 'MELODIC_MINOR']);

function tidalKeyToCamelot(key: string | null, scale: string | null): string | null {
	if (!key) return null;
	const entry = TIDAL_KEY_TO_CAMELOT[key];
	if (!entry) return null;
	if (scale === 'MAJOR') return entry.major;
	if (scale && MINOR_SCALES.has(scale)) return entry.minor;
	return null;
}

// Tidal renders version ("Extended Mix", "Remastered") as a separate field;
// Spotify bakes it into the name. Compose it in so cross-source titles look
// and match alike.
function displayTitle(t: TidalTrackV2): string {
	return t.version ? `${t.title} (${t.version})` : t.title;
}

function syncCursorFor(pl: TidalPlaylist): string | null {
	if (!pl.lastModifiedAt) return null;
	return `${pl.lastModifiedAt}:${pl.numberOfItems ?? ''}`;
}

// "Favorite Tracks" — Tidal's Liked Songs. Synthetic playlist with a stable
// sourceId, same pattern as Spotify's 'liked-songs' sentinel.
const FAVORITES_SENTINEL_ID = 'favorite-tracks';
const FAVORITES_URL = 'https://listen.tidal.com/collection/tracks';

function favoritesSynthPlaylist(meta: { lastModifiedAt: string | null; numberOfItems: number | null } | null): TidalPlaylist {
	return {
		id: FAVORITES_SENTINEL_ID,
		name: 'Favorite Tracks',
		description: null,
		numberOfItems: meta?.numberOfItems ?? null,
		playlistType: null,
		accessType: null,
		lastModifiedAt: meta?.lastModifiedAt ?? null,
	};
}

export class TidalSync {
	constructor(
		private readonly db: Db,
		private readonly auth: AuthService
	) {}

	private async buildClient(): Promise<TidalApiClient> {
		const token = await this.auth.getTidalAccessToken();
		if (!token) throw new Error('Tidal not connected');
		const countryCode = this.auth.getTidalCountryCode() ?? 'US';
		return new TidalApiClient(config.tidal.apiBase, async () => token, countryCode);
	}

	async run(
		progress: ProgressFn = () => {},
		opts: { force?: boolean } = {}
	): Promise<{ playlists: number; tracksUpserted: number }> {
		const jobId = randomUUID();
		this.db.insert(syncJob).values({
			id: jobId,
			source: 'tidal',
			kind: 'full',
			state: 'running',
			startedAt: new Date(),
		}).run();

		try {
			progress({ stage: 'starting', source: 'tidal' });
			const client = await this.buildClient();

			progress({ stage: 'playlists-listing', source: 'tidal' });
			const playlists = await client.listMyPlaylists();

			const existing = new Map(
				this.db
					.select()
					.from(playlist)
					.where(eq(playlist.source, 'tidal'))
					.all()
					.map((p) => [p.sourceId, p])
			);

			// +1 = the synthetic Favorite Tracks entry synced after the loop.
			const total = playlists.length + 1;
			let tracksUpserted = 0;
			let playlistsSkipped = 0;
			for (let i = 0; i < playlists.length; i++) {
				const pl = playlists[i]!;
				const prior = existing.get(pl.id);
				const cursor = syncCursorFor(pl);
				const unchanged = !opts.force
					&& !!prior
					&& prior.syncStatus === 'synced'
					&& !!cursor
					&& prior.syncCursor === cursor;

				if (unchanged) {
					// Metadata-only refresh + re-stamp — same cheap path as
					// Spotify's snapshot_id short-circuit.
					const id = this.upsertPlaylistMeta(pl);
					this.markPlaylistSynced(id, cursor);
					playlistsSkipped++;
					progress({
						stage: 'playlist-skipped',
						source: 'tidal',
						currentPlaylist: { id: prior?.id ?? null, name: pl.name, index: i + 1, total, reason: 'unchanged' },
					});
					continue;
				}

				progress({
					stage: 'playlist-tracks',
					source: 'tidal',
					currentPlaylist: { id: prior?.id ?? null, name: pl.name, index: i + 1, total },
				});
				tracksUpserted += await this.syncPlaylist(pl, client);
			}

			// Favorite Tracks — the collection resource exposes the same
			// lastModifiedAt+numberOfItems pair, so an untouched collection
			// costs one meta request per tick, not the full items walk.
			{
				const synth = favoritesSynthPlaylist(await client.getFavoritesMeta());
				const prior = existing.get(FAVORITES_SENTINEL_ID);
				const cursor = syncCursorFor(synth);
				const unchanged = !opts.force
					&& !!prior
					&& prior.syncStatus === 'synced'
					&& !!cursor
					&& prior.syncCursor === cursor;
				if (unchanged) {
					const id = this.upsertPlaylistMeta(synth, { mark: '♡', url: FAVORITES_URL });
					this.markPlaylistSynced(id, cursor);
					playlistsSkipped++;
					progress({
						stage: 'playlist-skipped',
						source: 'tidal',
						currentPlaylist: { id: prior?.id ?? null, name: synth.name, index: total, total, reason: 'unchanged' },
					});
				} else {
					progress({
						stage: 'playlist-tracks',
						source: 'tidal',
						currentPlaylist: { id: prior?.id ?? null, name: synth.name, index: total, total },
					});
					// Fetch-before-commit invariant, same as syncPlaylist.
					const items = await client.listFavoriteItems();
					const id = this.upsertPlaylistMeta(synth, { mark: '♡', url: FAVORITES_URL });
					tracksUpserted += this.replacePlaylistTracks(id, items);
					this.markPlaylistSynced(id, syncCursorFor(synth));
				}
			}

			this.db
				.update(syncJob)
				.set({
					state: 'done',
					finishedAt: new Date(),
					stats: { added: tracksUpserted, matched: 0, updated: 0, removed: 0 },
				})
				.where(eq(syncJob.id, jobId))
				.run();

			progress({
				stage: 'done',
				source: 'tidal',
				totals: { playlists: total, tracksUpserted, playlistsSkipped },
			});
			return { playlists: total, tracksUpserted };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.db
				.update(syncJob)
				.set({ state: 'failed', finishedAt: new Date(), error: message })
				.where(eq(syncJob.id, jobId))
				.run();
			progress({ stage: 'error', source: 'tidal', error: message });
			throw err;
		}
	}

	private async syncPlaylist(pl: TidalPlaylist, client: TidalApiClient): Promise<number> {
		// Fetch BEFORE committing DB state — same invariant as SpotifySync:
		// syncCursor only ever matches items that actually landed.
		const items = await client.listPlaylistItems(pl.id);
		const playlistId = this.upsertPlaylistMeta(pl);
		const n = this.replacePlaylistTracks(playlistId, items);
		this.markPlaylistSynced(playlistId, syncCursorFor(pl));
		return n;
	}

	// Single-playlist sync — the lazy sync-on-click path for rows still
	// 'pending'/'error' in the sidebar. Probes playlist meta first so an
	// unchanged playlist costs one request, not the full items walk.
	async runSinglePlaylist(
		playlistRowId: string,
		progress: ProgressFn = () => {},
		opts: { force?: boolean } = {}
	): Promise<{ tracksUpserted: number; skipped: boolean }> {
		progress({ stage: 'starting', source: 'tidal' });
		const row = this.db.select().from(playlist).where(eq(playlist.id, playlistRowId)).get();
		if (!row) throw new Error(`Playlist ${playlistRowId} not found`);
		if (row.source !== 'tidal') throw new Error(`Playlist ${row.name} is not a Tidal playlist`);

		const client = await this.buildClient();
		const isFavorites = row.sourceId === FAVORITES_SENTINEL_ID;

		let meta: TidalPlaylist | null = null;
		try {
			meta = isFavorites
				? favoritesSynthPlaylist(await client.getFavoritesMeta())
				: await client.getPlaylist(row.sourceId);
		} catch (err) {
			tlog.warn('meta probe failed, attempting full sync anyway', { playlist: row.name }, err);
		}

		const metaOpts = isFavorites ? { mark: '♡', url: FAVORITES_URL } : {};
		const cursor = meta ? syncCursorFor(meta) : null;
		if (!opts.force && cursor && row.syncStatus === 'synced' && row.syncCursor === cursor) {
			const id = this.upsertPlaylistMeta(meta!, metaOpts);
			this.markPlaylistSynced(id, cursor);
			progress({
				stage: 'playlist-skipped',
				source: 'tidal',
				currentPlaylist: { id: row.id, name: row.name, index: 1, total: 1, reason: 'unchanged' },
			});
			progress({ stage: 'done', source: 'tidal', totals: { playlists: 1, tracksUpserted: 0, playlistsSkipped: 1 } });
			return { tracksUpserted: 0, skipped: true };
		}

		progress({
			stage: 'playlist-tracks',
			source: 'tidal',
			currentPlaylist: { id: row.id, name: row.name, index: 1, total: 1 },
		});

		// Visual-only — the real stamps land via markPlaylistSynced after
		// the tracks commit.
		this.db.update(playlist).set({ syncStatus: 'syncing' }).where(eq(playlist.id, playlistRowId)).run();

		try {
			const items = isFavorites
				? await client.listFavoriteItems()
				: await client.listPlaylistItems(row.sourceId);
			const id = meta ? this.upsertPlaylistMeta(meta, metaOpts) : playlistRowId;
			const tracksUpserted = this.replacePlaylistTracks(id, items);
			if (cursor) {
				this.markPlaylistSynced(id, cursor);
			} else {
				// Meta-less fallback: stamp status + lastSyncedAt, leave
				// syncCursor alone so the next full sync refetches.
				this.db
					.update(playlist)
					.set({ syncStatus: 'synced', lastSyncedAt: new Date(), syncError: null })
					.where(eq(playlist.id, playlistRowId))
					.run();
			}
			progress({ stage: 'done', source: 'tidal', totals: { playlists: 1, tracksUpserted } });
			return { tracksUpserted, skipped: false };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.db.update(playlist).set({ syncStatus: 'error', syncError: message }).where(eq(playlist.id, playlistRowId)).run();
			progress({ stage: 'error', source: 'tidal', error: message });
			throw err;
		}
	}

	// ─── Playlist upsert ─────────────────────────────────────────────────
	// Metadata only — sync stamps commit separately via markPlaylistSynced
	// after tracks land, so a mid-fetch failure can't leave a row claiming
	// "synced" with stale tracks. Mirrors SpotifySync.upsertPlaylistMeta.

	private upsertPlaylistMeta(pl: TidalPlaylist, opts: { mark?: string; url?: string } = {}): string {
		const existing = this.db
			.select()
			.from(playlist)
			.where(and(eq(playlist.source, 'tidal'), eq(playlist.sourceId, pl.id)))
			.get();

		const now = new Date();
		const cursor = syncCursorFor(pl);
		const cursorChanged = !existing || existing.syncCursor !== cursor;
		const remoteUpdatedAt = pl.lastModifiedAt
			? new Date(pl.lastModifiedAt)
			: (cursorChanged ? now : existing!.remoteUpdatedAt);

		if (existing) {
			// A provider-side rename is a playlist rename op; the rest is
			// provider metadata (see SpotifySync.upsertPlaylistMeta).
			rawOf(this.db).transaction(() => {
				mut.renamePlaylist(this.db, existing.id, pl.name);
				this.db
					.update(playlist)
					.set({
						name: pl.name,
						nameAscii: searchFold(pl.name),
						description: pl.description,
						trackCount: pl.numberOfItems,
						isPublic: pl.accessType === 'PUBLIC',
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
			source: 'tidal',
			sourceId: pl.id,
			url: opts.url ?? `https://tidal.com/browse/playlist/${pl.id}`,
			name: pl.name,
			nameAscii: searchFold(pl.name),
			description: pl.description,
			// The v2 collection endpoint doesn't expose the owner at our
			// include level — null keeps ownership-gated UI (drops, upstream
			// writes) conservatively off for Tidal rows.
			ownerName: null,
			ownerId: null,
			coverUrl: null,
			trackCount: pl.numberOfItems,
			followers: null,
			isCollaborative: false,
			isPublic: pl.accessType === 'PUBLIC',
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

	private markPlaylistSynced(playlistRowId: string, cursor: string | null): void {
		this.db
			.update(playlist)
			.set({
				syncStatus: 'synced',
				syncCursor: cursor,
				lastSyncedAt: new Date(),
				syncError: null,
			})
			.where(eq(playlist.id, playlistRowId))
			.run();
	}

	// ─── Track membership replace ────────────────────────────────────────

	// Same shape as SpotifySync.replacePlaylistTracks: one transaction per
	// playlist, membership reconciled by diff (add/move/remove ops).
	private replacePlaylistTracks(playlistRowId: string, items: TidalPlaylistItem[]): number {
		return rawOf(this.db).transaction(() => this.replacePlaylistTracksTx(playlistRowId, items))();
	}

	private replacePlaylistTracksTx(playlistRowId: string, items: TidalPlaylistItem[]): number {
		// Preserve the earliest known add-date per member — same policy as
		// Spotify sync (the remote can lie after re-adds; Curator's "Added"
		// column keeps the earliest value it has ever seen).
		const priorAddedAt = new Map<string, number>();
		for (const r of this.db
			.select({ sourceTrackId: playlistTrack.sourceTrackId, addedAt: playlistTrack.addedAt })
			.from(playlistTrack)
			.where(eq(playlistTrack.playlistId, playlistRowId))
			.all()) {
			if (r.sourceTrackId && r.addedAt) priorAddedAt.set(r.sourceTrackId, r.addedAt.getTime());
		}

		const desired: mut.DesiredMember[] = [];
		for (const item of items) {
			const t = item.track;
			const trackId = this.upsertTrack(t);
			upsertArtistLinks(this.db, 'tidal', t.artists);
			const remoteMs = item.addedAt ? new Date(item.addedAt).getTime() : null;
			const priorMs = priorAddedAt.get(t.id) ?? null;
			const addedMs = priorMs != null && remoteMs != null
				? Math.min(priorMs, remoteMs)
				: priorMs ?? remoteMs;
			desired.push({
				trackId,
				addedAt: addedMs != null ? new Date(addedMs) : null,
				addedBy: null,
				sourceTrackId: t.id,
			});
		}
		mut.reconcileMembership(this.db, playlistRowId, desired, 'tidal');
		return items.length;
	}

	// ─── Track upsert ────────────────────────────────────────────────────
	// Identity resolution identical to SpotifySync.upsertTrack:
	//   1. (source='tidal', source_track_id) — already ingested; refresh link.
	//   2. track.isrc — same recording known via another provider (typically
	//      Spotify ingest or the hybrid matcher); attach a link beside it.
	//   3. Create canonical track + link.

	private upsertTrack(t: TidalTrackV2): string {
		const existing = this.db
			.select({ trackId: sourceLink.trackId })
			.from(sourceLink)
			.where(and(eq(sourceLink.source, 'tidal'), eq(sourceLink.sourceTrackId, t.id)))
			.get();

		// Snapshot verbatim for source_link; normalized for the canonical row.
		// The v2 mapper's `main` flag is positional (first = main), not a
		// real credit role, so no role is written from it. Tidal entities go
		// through the splitter (unlike Spotify's): Tidal mints combined
		// artists for collaboration singles — "Paons, Dave DK" is one Tidal
		// id — and that is exactly the packing the credit rules undo.
		const artists: TrackArtist[] = t.artists.map((a) => ({ name: a.name }));
		const title = displayTitle(t);
		const { artists: canonicalArtists, artistsBase } = normalizeIncomingCredits(this.db, artists, { title });
		// Canonical form only; the verbatim provider value stays in `payload`.
		const isrc = normalizeIsrc(t.isrc);

		if (existing) {
			this.db
				.update(sourceLink)
				.set({
					url: `https://tidal.com/browse/track/${t.id}`,
					isrcLocal: isrc,
					titleLocal: title,
					artistsLocal: artists,
					albumLocal: t.album?.title ?? null,
					durationLocal: t.duration,
					bpmLocal: t.bpm,
					keyLocal: t.key,
					payload: t as unknown,
					fetchedAt: new Date(),
				})
				.where(and(eq(sourceLink.source, 'tidal'), eq(sourceLink.sourceTrackId, t.id)))
				.run();
			// Heal canonical rows minted during a degraded pass (batch artist
			// lookup 429'd mid-sync → track.artists landed empty). Only fills
			// the empty case — a populated row is never overwritten.
			if (artists.length > 0) {
				const row = this.db.select({ artists: track.artists }).from(track).where(eq(track.id, existing.trackId)).get();
				if (row && (row.artists ?? []).length === 0) {
					this.db.update(track)
						.set(asciify({ artists: canonicalArtists, artistsBase, updatedAt: new Date() }))
						.where(eq(track.id, existing.trackId))
						.run();
					syncTrackArtistsById(this.db, [existing.trackId]);
				}
			}
			syncTrackAlbumsById(this.db, [existing.trackId]);
			return existing.trackId;
		}

		const newLinkFor = (trackId: string): NewSourceLink => ({
			id: randomUUID(),
			trackId,
			source: 'tidal',
			sourceTrackId: t.id,
			url: `https://tidal.com/browse/track/${t.id}`,
			isrcLocal: isrc,
			titleLocal: title,
			artistsLocal: artists,
			albumLocal: t.album?.title ?? null,
			durationLocal: t.duration,
			bpmLocal: t.bpm,
			keyLocal: t.key,
			payload: t as unknown,
			fetchedAt: new Date(),
		});

		if (isrc) {
			// Live row first — see SpotifySync.upsertTrack (merge losers keep
			// the survivor's ISRC).
			const byIsrc = this.db
				.select({ id: track.id })
				.from(track)
				.where(eq(track.isrc, isrc))
				.orderBy(sql`${track.deletedAt} IS NOT NULL`)
				.get();
			if (byIsrc) {
				this.db.insert(sourceLink).values(newLinkFor(byIsrc.id)).run();
				mut.addClaims(this.db, byIsrc.id, [{ kind: 'tidal', value: t.id }]);
				syncTrackAlbumsById(this.db, [byIsrc.id]);
				return byIsrc.id;
			}
		}

		// Third-chance match — same recording under a provider id whose ISRC we
		// don't hold (rekordbox/scanner canonicals carry no streaming ISRC).
		// Attach beside the existing row and seed its ISRC. See match-existing.ts.
		const byContent = findExistingByContent(this.db, {
			title,
			artists: artists.map((a) => a.name),
			duration: t.duration ?? null,
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
			this.db.insert(sourceLink).values(newLinkFor(byContent.trackId)).run();
			mut.addClaims(this.db, byContent.trackId, [{ kind: 'tidal', value: t.id }, ...(byContent.seedIsrc ? [{ kind: 'isrc' as const, value: byContent.seedIsrc, confidence: 0.9 }] : [])]);
			syncTrackAlbumsById(this.db, [byContent.trackId]);
			return byContent.trackId;
		}

		const trackId = randomUUID();
		const newTrack: NewTrack = {
			id: trackId,
			recordingId: recordingIdForTrack(trackId),
			isrc,
			mbid: null,
			title,
			artists: canonicalArtists,
			artistsBase,
			albumTitle: t.album?.title ?? null,
			releaseDate: null,
			coverUrl: null,
			duration: t.duration ?? 0,
			// Tidal catalog values seed brand-new rows only — the analyzer
			// (bpm) and enrichers overwrite via their own merge policies.
			bpm: t.bpm,
			keyCamelot: tidalKeyToCamelot(t.key, t.keyScale),
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
		this.db.insert(sourceLink).values(newLinkFor(trackId)).run();
		// A new recording: library_track create + provider id / ISRC claims.
		mut.recordTrackCreated(this.db, trackId, [{ kind: 'tidal', value: t.id }, ...(isrc ? [{ kind: 'isrc' as const, value: isrc, confidence: 0.9 }] : [])]);
		syncTrackAlbumsById(this.db, [trackId]);
		return trackId;
	}
}
