// Spotify playlists, read with a watcher's own Spotify login: the grant the
// cloud's Spotify gateway holds for them (apps/cloud spotify/gateway.ts), or
// the desktop's own token when the desktop is the reader.
//
// Why a user's login: since Spotify's February 2026 rules a playlist's items
// are served only to its owner and collaborators, and an app token is nobody.
// A user's token still reads the playlists they follow while Spotify's
// postponement for this app lasts (2026-10-26); when it ends, items of
// playlists the user does not own stop for every reader, cloud or device.
//
// Per poll: one call for the playlist's `snapshot_id` (unchanged → nothing
// more); otherwise its items, of which the ones added since the last poll
// (or, at first, within the last two weeks) become recording claims with
// `publishedAt` = when they were added. The sweep turns each into a
// `playlist_add` event (events.ts). The playlist's own name and cover are
// refreshed in place.

import type { CatalogClaim, CatalogKind } from '@curator/protocol';
import { getJson, type FetchLike } from './http.js';
import { ProviderHttpError } from './http.js';
import type { TrackerAdapter, TrackerPoll, TrackerTarget } from './types.js';

const API = 'https://api.spotify.com/v1';
const FIRST_WINDOW_DAYS = 14;
// Large playlists are read in pages of 100; additions sit at the end.
const MAX_PAGES = 20;

type SpArtist = { id: string; name: string; external_urls?: { spotify?: string } };
type SpTrack = {
	id: string | null;
	name: string;
	duration_ms?: number;
	external_ids?: { isrc?: string };
	external_urls?: { spotify?: string };
	artists?: SpArtist[];
	album?: { name?: string; release_date?: string; images?: { url: string }[] };
	type?: string;
};
type SpEntry = { added_at?: string; is_local?: boolean; track?: SpTrack | null; item?: SpTrack | null };
type SpPage = { items?: SpEntry[]; next: string | null; total?: number };
type SpPlaylist = { snapshot_id: string; name: string; images?: { url: string }[] };

// `token`: a Spotify access token that may read this playlist (the catalogue
// object's id), or a throw when there is none. The adapter knows the object,
// not the user: the cloud looks a watcher up and vends from their grant
// (apps/cloud catalog/spotify-app-token.ts watcherPlaylistToken); a desktop
// answers with its own login whatever the id.
export type SpotifyUserPlaylistDeps = { token: (objectId: string) => Promise<string> };

export class SpotifyUserPlaylistTracker implements TrackerAdapter {
	readonly provider = 'spotify' as const;
	readonly kinds: readonly CatalogKind[] = ['playlist'];
	readonly callsPerPoll = 3;
	// '/items' (2026) or '/tracks' (older): the one Spotify served last.
	private itemsPath: 'items' | 'tracks' = 'items';

	constructor(
		private readonly deps: SpotifyUserPlaylistDeps,
		private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
		private readonly now: () => number = Date.now,
	) {}

	private get<T>(token: string, path: string, signal: AbortSignal): Promise<T> {
		return getJson<T>(this.fetchFn, 'spotify', path.startsWith('http') ? path : `${API}${path}`, {
			headers: { authorization: `Bearer ${token}` },
			signal,
			logPath: path.split('?')[0]!.replace(/\/playlists\/[^/]+/, '/playlists/{id}'),
		});
	}

	async poll(target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll> {
		if (!target.representation) throw new Error('spotify playlist tracker needs a Spotify id');
		const id = encodeURIComponent(target.representation.providerId);
		const token = await this.deps.token(target.object.id);
		const meta = await this.get<SpPlaylist>(token, `/playlists/${id}?fields=snapshot_id,name,images`, signal);
		let calls = 1;
		const self: CatalogClaim = {
			provider: 'spotify',
			kind: 'playlist',
			providerId: target.representation.providerId,
			name: meta.name || target.object.name,
			...(target.representation.url ? { url: target.representation.url } : {}),
			...(meta.images?.[0]?.url ? { facts: { coverUrl: meta.images[0].url } } : {}),
		};
		if (meta.snapshot_id === target.cursor.snapshot) {
			return { children: [], listingHash: String(target.cursor.listingHash ?? meta.snapshot_id), cursor: target.cursor, calls, self };
		}
		const since = typeof target.cursor.lastAddedAt === 'string' ? target.cursor.lastAddedAt : new Date(this.now() - FIRST_WINDOW_DAYS * 86400_000).toISOString();
		const entries: SpEntry[] = [];
		let next: string | null = null;
		for (let page = 0; page < MAX_PAGES; page++) {
			let body: SpPage;
			try {
				body = await this.get<SpPage>(token, next ?? `/playlists/${id}/${this.itemsPath}?limit=100&offset=0`, signal);
			} catch (e) {
				// The other form of the path (Spotify's 2026 rename), once.
				if (page === 0 && !next && e instanceof ProviderHttpError && e.status === 404) {
					this.itemsPath = this.itemsPath === 'items' ? 'tracks' : 'items';
					body = await this.get<SpPage>(token, `/playlists/${id}/${this.itemsPath}?limit=100&offset=0`, signal);
					calls++;
				} else throw e;
			}
			calls++;
			// No items in the answer: Spotify withheld them (owner/collaborator
			// rule). Not "emptied": fail, keep the cursor.
			if (!Array.isArray(body.items)) throw new Error('Spotify withheld this playlist\'s items');
			entries.push(...body.items);
			next = body.next;
			if (!next) break;
		}
		let lastAddedAt = since;
		const children: CatalogClaim[] = [];
		entries.forEach((e, position) => {
			const t = e.track ?? e.item;
			if (!t?.id || e.is_local || (t.type && t.type !== 'track')) return;
			const added = e.added_at ?? '';
			if (added <= since) return;
			if (added > lastAddedAt) lastAddedAt = added;
			children.push({
				provider: 'spotify',
				kind: 'recording',
				providerId: t.id,
				name: t.name,
				url: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
				identifiers: t.external_ids?.isrc ? [{ namespace: 'isrc', value: t.external_ids.isrc }] : [],
				facts: {
					...(t.duration_ms ? { durationSec: Math.round(t.duration_ms / 100) / 10 } : {}),
					...(t.album?.name ? { albumTitle: t.album.name } : {}),
					...(t.album?.images?.[0]?.url ? { coverUrl: t.album.images[0].url } : {}),
					...(t.album?.release_date && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(t.album.release_date) ? { releaseDate: t.album.release_date } : {}),
					trackNumber: position + 1,
				},
				artists: (t.artists ?? []).filter((a) => a.id).map((a) => ({
					provider: 'spotify' as const,
					kind: 'artist' as const,
					providerId: a.id,
					name: a.name,
					url: a.external_urls?.spotify ?? `https://open.spotify.com/artist/${a.id}`,
				})),
				publishedAt: Date.parse(added) || null,
			});
		});
		return { children, listingHash: meta.snapshot_id, cursor: { snapshot: meta.snapshot_id, lastAddedAt }, calls, self };
	}
}
