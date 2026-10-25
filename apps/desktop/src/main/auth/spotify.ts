// Spotify PKCE flow inside an Electron BrowserWindow.
// We listen for the redirect to our loopback URI via webRequest, extract
// the auth code without ever needing a real local HTTP server. Who exchanges
// the code is core's call (AuthService.completeSpotifyAuth): the Curator
// cloud when it holds the account's grant ('spotify_gateway'; it needs the
// same client id this window authorizes with), else this device.

import { BrowserWindow, session } from 'electron';
import { buildAuthorizeUrl, generatePkce } from '@curator/spotify';
import type { SpotifyProfile } from '@curator/protocol';
import { config, NOT_CONFIGURED, type AuthService } from '@curator/core';

export async function runSpotifyAuthFlow(authService: AuthService): Promise<SpotifyProfile> {
	// Refuse before a window opens: Spotify would only show an error page
	// for an empty client_id.
	if (!config.spotify.configured) throw new Error(NOT_CONFIGURED.spotify);
	const { verifier, challenge } = await generatePkce();
	const state = Math.random().toString(36).slice(2);
	const authorizeUrl = buildAuthorizeUrl(config.spotify, challenge, state);

	// Use a dedicated session so cookies don't leak into other Electron windows
	const authSession = session.fromPartition('persist:curator-spotify-auth');

	return new Promise<SpotifyProfile>((resolve, reject) => {
		const win = new BrowserWindow({
			width: 520,
			height: 720,
			title: 'Sign in to Spotify',
			autoHideMenuBar: true,
			webPreferences: {
				session: authSession,
				nodeIntegration: false,
				contextIsolation: true,
			},
		});

		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
			if (!win.isDestroyed()) win.close();
		};

		const redirectPrefix = config.spotify.redirectUri;

		// Intercept the redirect to our loopback URL — Spotify navigates here with
		// ?code=... or ?error=... We catch it via webRequest before navigation completes.
		authSession.webRequest.onBeforeRequest(
			{ urls: [`${redirectPrefix}*`] },
			(details, callback) => {
				try {
					const u = new URL(details.url);
					const returnedState = u.searchParams.get('state');
					const code = u.searchParams.get('code');
					const error = u.searchParams.get('error');

					if (returnedState !== state) {
						settle(() => reject(new Error(`Spotify auth: state mismatch (${returnedState} != ${state})`)));
						callback({ cancel: true });
						return;
					}
					if (error) {
						settle(() => reject(new Error(`Spotify auth: ${error}`)));
						callback({ cancel: true });
						return;
					}
					if (!code) {
						settle(() => reject(new Error('Spotify auth: no code in redirect')));
						callback({ cancel: true });
						return;
					}

					// We have the code. Cancel the doomed navigation, exchange in background.
					callback({ cancel: true });
					authService
						.completeSpotifyAuth(code, verifier)
						.then((me) => settle(() => resolve(me)))
						.catch((err) => settle(() => reject(err)));
				} catch (err) {
					settle(() => reject(err as Error));
					callback({ cancel: true });
				}
			}
		);

		win.on('closed', () => {
			if (!settled) {
				settled = true;
				reject(new Error('Spotify auth window closed before completion'));
			}
		});

		win.loadURL(authorizeUrl).catch((err) => {
			settle(() => reject(err));
		});
	});
}
