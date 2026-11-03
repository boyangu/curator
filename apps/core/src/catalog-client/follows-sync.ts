// The user's Spotify follows, carried into the Global Catalog behind the
// scenes (Guy, 2026-10-26: "update the db behind the scenes; it's just me
// today"): followed artists and followed (not owned) playlists become watches,
// and the artists muted in Discover become muted watches. Once carried over,
// the catalogue is where follows live: unfollowing in Curator does not touch
// Spotify, and a follow that Spotify still lists is not brought back.
//
// So each run imports only the Spotify follows it has never handled before
// (their ids are kept device-local in app_setting), and the mutes only on the
// first run. It runs before the cloud feed's poll (feed/cloud-producer.ts
// `prepare`), at most every few hours: two Spotify reads for the follow lists,
// one catalogue call per new batch.

import type { CatalogClaim } from '@curator/protocol';
import { SpotifyClient } from '@curator/spotify';
import { log } from '../log.js';
import type { CatalogClient } from './service.js';

const clog = log.for('catalog');

export const FOLLOWS_SYNC_EVERY_MS = 6 * 3600_000;

export type FollowsSyncState = {
	at: number;
	// Spotify ids already handled (imported, or seen and left alone).
	artists: string[];
	playlists: string[];
	mutesCarried: boolean;
};

export type FollowsSyncDeps = {
	client: CatalogClient;
	spotifyToken: () => Promise<string | null>;
	// Spotify artist ids muted in Discover (feed_suppression, scope artist).
	mutedSpotifyArtistIds: () => Promise<Set<string>>;
	load: () => FollowsSyncState | null;
	save: (s: FollowsSyncState) => void;
	now?: () => number;
};

export type FollowsSyncReport = { artists: number; playlists: number; muted: number };

export async function syncSpotifyFollows(deps: FollowsSyncDeps, opts: { force?: boolean } = {}): Promise<FollowsSyncReport | null> {
	const now = deps.now ?? Date.now;
	const prev = deps.load();
	if (!opts.force && prev && now() - prev.at < FOLLOWS_SYNC_EVERY_MS) return null;
	const status = deps.client.status();
	if (!status.available) {
		clog.info('spotify follows sync skipped: catalogue unavailable', { reason: status.reason });
		return null;
	}
	const token = await deps.spotifyToken().catch((e: unknown) => {
		clog.warn('spotify follows sync: token failed', undefined, e);
		return null;
	});
	if (!token) {
		clog.info('spotify follows sync skipped: Spotify not connected');
		return null;
	}
	const spotify = new SpotifyClient(token, 'catalog:follows-sync');

	const seenArtists = new Set(prev?.artists ?? []);
	const seenPlaylists = new Set(prev?.playlists ?? []);
	const [me, artists, playlists] = await Promise.all([spotify.getMe(), spotify.getFollowedArtists(), spotify.getUserPlaylists()]);

	const artistClaims: CatalogClaim[] = artists
		.filter((a) => !seenArtists.has(a.id))
		.map((a) => ({
			provider: 'spotify',
			kind: 'artist',
			providerId: a.id,
			name: a.name,
			url: a.external_urls?.spotify ?? `https://open.spotify.com/artist/${a.id}`,
			...(a.images?.[0]?.url ? { facts: { coverUrl: a.images[0].url } } : {}),
		}));
	// Followed, not the user's own: their own playlists are curation, not a source.
	const followed = playlists.filter((p) => p.owner?.id !== me.id);
	const playlistClaims: CatalogClaim[] = followed
		.filter((p) => !seenPlaylists.has(p.id))
		.map((p) => ({
			provider: 'spotify',
			kind: 'playlist',
			providerId: p.id,
			name: p.name,
			url: p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${p.id}`,
			...(p.images?.[0]?.url ? { facts: { coverUrl: p.images[0].url } } : {}),
		}));
	const report: FollowsSyncReport = { artists: 0, playlists: 0, muted: 0 };
	if (artistClaims.length) report.artists = (await deps.client.importClaims(artistClaims, 'imported')).watched;
	if (playlistClaims.length) report.playlists = (await deps.client.importClaims(playlistClaims, 'imported')).watched;

	// The artists muted in Discover, once: later mutes go through the card
	// (feed/service.ts mutes the watch too).
	if (!prev?.mutesCarried) {
		const muted = await deps.mutedSpotifyArtistIds();
		if (muted.size) {
			for (const w of await deps.client.watches()) {
				if (w.muted || w.object.kind !== 'artist') continue;
				if (w.object.handles.some((h) => h.provider === 'spotify' && muted.has(h.id))) {
					await deps.client.mute(w.object.id, true);
					report.muted++;
				}
			}
		}
	}

	deps.save({
		at: now(),
		artists: [...new Set([...seenArtists, ...artists.map((a) => a.id)])],
		playlists: [...new Set([...seenPlaylists, ...followed.map((p) => p.id)])],
		mutesCarried: true,
	});
	clog.info('spotify follows synced', { ...report, followedArtists: artists.length, followedPlaylists: followed.length });
	return report;
}
