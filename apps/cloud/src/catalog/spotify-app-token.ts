// The cloud's two Spotify token sources for the readers in
// @curator/catalog-readers: the app's own credentials for artists and labels
// (a client-credentials grant), and a watcher's stored grant for the
// playlists they follow. A desktop hands the readers its user's login
// instead; the readers are the same.

import type { SpotifyTokenSource } from '@curator/catalog-readers';
import type { Db } from '../db/db.js';
import type { Logger } from '../log.js';
import { tokenForUser, type SpotifyGateway } from '../spotify/gateway.js';

export type SpotifyAppCredentials = { clientId: string; clientSecret: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// An app token, refreshed a minute before Spotify's expiry.
// CURATOR_SPOTIFY_APP_CLIENT_ID / _SECRET on the worker only: no user, so
// Development Mode's five-user cap does not apply; the endpoint limits do.
export function appCredentialsToken(creds: SpotifyAppCredentials, fetchFn: FetchLike = (u, i) => fetch(u, i), now: () => number = Date.now): SpotifyTokenSource {
	let token: { value: string; expiresAt: number } | null = null;
	return async (signal) => {
		if (token && token.expiresAt - 60_000 > now()) return token.value;
		const res = await fetchFn('https://accounts.spotify.com/api/token', {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`,
			},
			body: 'grant_type=client_credentials',
			...(signal ? { signal } : {}),
		});
		if (!res.ok) throw new Error(`spotify token ${res.status}`);
		const j = (await res.json()) as { access_token: string; expires_in: number };
		token = { value: j.access_token, expiresAt: now() + j.expires_in * 1000 };
		return j.access_token;
	};
}

// A token from a watcher of the playlist who has Spotify connected, the
// longest-standing watcher first. `forUser` vends for one user, or throws
// (not connected, reconnect needed): the next watcher is tried.
export function watcherPlaylistToken(db: Db, forUser: (userId: string) => Promise<string>): (objectId: string) => Promise<string> {
	return async (objectId) => {
		const watchers = await db.query<{ user_id: string }>(
			`select user_id from curator.catalog_watch where object_id = $1 and not muted order by created_at limit 5`,
			[objectId],
		);
		for (const w of watchers) {
			try {
				return await forUser(w.user_id);
			} catch {
				// Not connected, or reconnect needed: the next watcher.
			}
		}
		throw new Error('no watcher of this playlist has Spotify connected');
	};
}

// The cloud's vend from the watcher's stored grant (spotify/gateway.ts).
export function gatewayPlaylistToken(deps: { db: Db; log: Logger; gateway: SpotifyGateway }): (objectId: string) => Promise<string> {
	return watcherPlaylistToken(deps.db, async (userId) => (await tokenForUser(deps, userId)).accessToken);
}
