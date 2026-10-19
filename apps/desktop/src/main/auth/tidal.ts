// Tidal OAuth flow — Authorization Code + PKCE + client_secret.
// Same Electron interception pattern as Spotify: open the authorize URL in
// a BrowserWindow, catch the redirect via webRequest before any HTTP request
// is dispatched, then exchange the code in the auth service.
//
// The redirect URI must match exactly what's registered on the
// developer.tidal.com app — config.tidal.redirectUri.

import { BrowserWindow, session } from 'electron';
import {
	buildTidalAuthorizeUrl,
	generateTidalPkce,
	type TidalUser,
} from '@curator/tidal';
import { config, NOT_CONFIGURED, type AuthService } from '@curator/core';

const TIDAL_PARTITION = 'persist:curator-tidal-auth';

export async function clearTidalSession(): Promise<void> {
	const s = session.fromPartition(TIDAL_PARTITION);
	await s.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
}

export async function runTidalAuthFlow(authService: AuthService): Promise<TidalUser> {
	if (!config.tidal.configured) throw new Error(NOT_CONFIGURED.tidal);
	const { verifier, challenge } = await generateTidalPkce();
	const state = Math.random().toString(36).slice(2);
	const authorizeUrl = buildTidalAuthorizeUrl(config.tidal, challenge, state);

	const authSession = session.fromPartition(TIDAL_PARTITION);

	return new Promise<TidalUser>((resolve, reject) => {
		const win = new BrowserWindow({
			width: 520,
			height: 720,
			title: 'Sign in to Tidal',
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

		const redirectPrefix = config.tidal.redirectUri;

		authSession.webRequest.onBeforeRequest(
			{ urls: [`${redirectPrefix}*`] },
			(details, callback) => {
				try {
					const u = new URL(details.url);
					const returnedState = u.searchParams.get('state');
					const code = u.searchParams.get('code');
					const error = u.searchParams.get('error');
					const errorDescription = u.searchParams.get('error_description');

					if (returnedState !== state) {
						settle(() => reject(new Error(`Tidal auth: state mismatch (${returnedState} != ${state})`)));
						callback({ cancel: true });
						return;
					}
					if (error) {
						settle(() => reject(new Error(`Tidal auth: ${error}${errorDescription ? ` — ${errorDescription}` : ''}`)));
						callback({ cancel: true });
						return;
					}
					if (!code) {
						settle(() => reject(new Error('Tidal auth: no code in redirect')));
						callback({ cancel: true });
						return;
					}

					callback({ cancel: true });
					authService
						.completeTidalOAuth(code, verifier)
						.then((user) => settle(() => resolve(user)))
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
				reject(new Error('Tidal auth window closed before completion'));
			}
		});

		win.loadURL(authorizeUrl).catch((err) => {
			settle(() => reject(err));
		});
	});
}
