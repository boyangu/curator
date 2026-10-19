// Curator config. Every vendor credential and project identifier comes from
// the environment — nothing is committed. Each section's `configured` flag
// says whether its feature can run; consumers must check it and report "not
// configured" instead of calling a vendor with an empty id (AuthService,
// desktop auth/*.ts, backup/google-auth.ts, cloud-config.ts).
//
// The credentials are read as literal `process.env.CURATOR_*` property
// accesses on purpose: the desktop bundle replaces each one at build time
// (electron.vite.config.ts `define`) with the value from the build machine's
// .env/shell, so a packaged app carries its own and never consults the end
// user's shell. Tests and the CLI read the real process.env, where nothing
// set is the default. `.env.example` at the repo root lists the variables.
//
// The redirect-URI overrides stay runtime env reads: they are dev knobs with
// safe defaults, not credentials.
const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>;

function text(v: string | undefined): string {
	return (v ?? '').trim();
}

const spotifyClientId = text(process.env.CURATOR_SPOTIFY_CLIENT_ID);
const tidalClientId = text(process.env.CURATOR_TIDAL_CLIENT_ID);
const tidalClientSecret = text(process.env.CURATOR_TIDAL_CLIENT_SECRET);
const googleClientId = text(process.env.CURATOR_GOOGLE_CLIENT_ID);
const googleClientSecret = text(process.env.CURATOR_GOOGLE_CLIENT_SECRET);

export const config = {
	spotify: {
		// False ⇒ Connect is refused and token refresh short-circuits.
		configured: spotifyClientId !== '',
		// A Spotify app from the Developer Dashboard. PKCE flow: no secret.
		clientId: spotifyClientId,
		// Loopback redirect — must match what's registered in the Spotify app.
		// We intercept this via Electron's webRequest before any HTTP server hits it.
		redirectUri: env.CURATOR_SPOTIFY_REDIRECT_URI ?? 'http://127.0.0.1:51737/auth/spotify/callback',
		// `streaming` enables Web Playback SDK in-app playback (Premium-only).
		// `user-modify-playback-state` lets us start a track on our device.
		// `user-read-playback-state` lets us read current state for resume on boot.
		// Adding these forces existing users to reconnect once — the stored
		// access token doesn't carry them.
		scopes: [
			'playlist-read-private',
			'playlist-read-collaborative',
			// Write scopes — required by the two-way-sync adapter for
			// replaceTracks / addTracks / removeTracks / createPlaylist.
			// Adding these forces existing users to reconnect once; the
			// stored token doesn't carry write rights without a fresh OAuth.
			'playlist-modify-private',
			'playlist-modify-public',
			'user-library-read',
			// Discover feed — new-releases producer reads /me/following;
			// unfollow-artist writes DELETE /me/following (403 without modify).
			// Adding these forces existing users to reconnect once.
			'user-follow-read',
			'user-follow-modify',
			'user-read-email',
			'user-read-private',
			'streaming',
			'user-modify-playback-state',
			'user-read-playback-state',
		].join(' '),
	},
	tidal: {
		configured: tidalClientId !== '' && tidalClientSecret !== '',
		// Official Tidal developer app OAuth (Authorization Code + Secret + PKCE),
		// registered at developer.tidal.com.
		clientId: tidalClientId,
		clientSecret: tidalClientSecret,
		// Must match exactly what's registered on the developer.tidal.com app.
		redirectUri: env.CURATOR_TIDAL_REDIRECT_URI ?? 'http://127.0.0.1:51737/auth/spotify/callback',
		// Third-party scopes Tidal exposes (per OpenAPI spec). Together these
		// cover: user profile, the user's playlists, their saved collection.
		scopes: ['user.read', 'playlists.read', 'collection.read'].join(' '),
		// OAuth endpoints. Verified against @tidal-music/auth source + the
		// official OpenAPI spec — token endpoint is reused for refresh.
		authorizeUrl: 'https://login.tidal.com/authorize',
		tokenUrl: 'https://auth.tidal.com/v1/oauth2/token',
		// API base for catalog + user data (v2 OpenAPI surface). Different
		// from the legacy api.tidal.com/v1 we used in the sniff flow. Catalog
		// reads need only a user token, so this works without the app ids.
		apiBase: 'https://openapi.tidal.com/v2',
	},
	google: {
		configured: googleClientId !== '' && googleClientSecret !== '',
		// Backup target. A "Desktop app" OAuth client from the Google Cloud
		// Console; `drive.file` is a non-sensitive scope (no app verification)
		// that only sees files THIS client id created — so changing the id
		// orphans every existing backup on Drive. The consent screen must be
		// "In production": in Testing mode Google expires refresh tokens after
		// 7 days and the scheduler would need a reconnect every week. The
		// client secret of a Desktop client is not a real secret per Google's
		// own docs (it ships in the binary); the token endpoint demands it
		// anyway.
		clientId: googleClientId,
		clientSecret: googleClientSecret,
		// Port 0 = pick a free loopback port at run time; the OAuth flow
		// rewrites the URI with the real port before opening the browser.
		redirectUri: env.CURATOR_GOOGLE_REDIRECT_URI ?? 'http://127.0.0.1:0/auth/google/callback',
		scopes: 'https://www.googleapis.com/auth/drive.file',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		tokenUrl: 'https://oauth2.googleapis.com/token',
	},
} as const;
