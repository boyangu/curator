// Legacy listen.tidal.com session-token capture. Opens the regular Tidal web
// client in an Electron BrowserWindow, listens for outgoing requests, grabs
// the `Authorization: Bearer …` header + countryCode. Used ONLY for the
// download flow — the official OAuth path can't reach /trackFiles or
// /trackManifests (third-party tier blocked).
//
// Lives in its own session partition so cookies don't collide with anything
// else. The captured bearer is stored as kind='session' in the auth store.

import { BrowserWindow, session } from 'electron';
import type { AuthService } from '@curator/core';
import { mainLog } from '../log.js';

const slog = mainLog.for('tidal-sniff');

const TIMEOUT_MS = 5 * 60_000;
const TIDAL_SNIFF_PARTITION = 'persist:curator-tidal-sniff';
const TIDAL_LOGIN_URL = 'https://listen.tidal.com';

export interface TidalSnoopResult {
	authorization: string;
	countryCode: string;
}

export async function clearTidalSniffSession(): Promise<void> {
	const s = session.fromPartition(TIDAL_SNIFF_PARTITION);
	await s.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
}

export async function runTidalSniffFlow(authService: AuthService): Promise<TidalSnoopResult> {
	const sn = session.fromPartition(TIDAL_SNIFF_PARTITION);

	return new Promise<TidalSnoopResult>((resolve, reject) => {
		const win = new BrowserWindow({
			width: 1180,
			height: 800,
			title: 'Enable Tidal Downloads — sign in',
			autoHideMenuBar: true,
			webPreferences: {
				session: sn,
				nodeIntegration: false,
				contextIsolation: true,
			},
		});

		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			fn();
			if (!win.isDestroyed()) win.close();
		};

		// Capture both signals from API traffic to *.tidal.com. We don't settle
		// on the first sighting — Tidal's app issues several requests during
		// load and the early ones can be unauthenticated. Wait for one that
		// has BOTH a Bearer header AND a countryCode in the URL.
		const seen = { auth: '', countryCode: '' };

		// Case-insensitive header lookup — Electron normalises header names
		// inconsistently across versions (sometimes "Authorization", sometimes
		// "authorization"). Match either.
		const getHeader = (h: Record<string, string>, name: string): string | undefined => {
			const target = name.toLowerCase();
			for (const k of Object.keys(h)) {
				if (k.toLowerCase() === target) return h[k];
			}
			return undefined;
		};

		let requestCount = 0;
		// Widest possible filter to diagnose where Tidal is sending traffic.
		// The previous *.tidal.com filter missed something. Once we know what
		// domains carry the bearer, we can narrow back down.
		sn.webRequest.onBeforeSendHeaders(
			{ urls: ['<all_urls>'] },
			(details, callback) => {
				requestCount++;
				const authz = getHeader(details.requestHeaders, 'Authorization');
				// Log every host once per session so we can see Tidal's actual
				// network footprint after sign-in.
				if (requestCount <= 50 || /tidal|listen|auth\./i.test(details.url)) {
					try {
						const host = new URL(details.url).host;
						const hasBearer = typeof authz === 'string' && /^Bearer /.test(authz);
						slog.debug('req', { n: requestCount, host, hasBearer, method: details.method });
					} catch { /* ignore */ }
				}
				if (typeof authz === 'string' && /^Bearer /.test(authz) && !seen.auth) {
					seen.auth = authz;
					slog.info('✔ captured Authorization bearer', { requestNum: requestCount, url: details.url.slice(0, 120) });
				}
				try {
					const u = new URL(details.url);
					const cc = u.searchParams.get('countryCode');
					if (cc && !seen.countryCode) {
						seen.countryCode = cc;
						slog.info('✔ captured countryCode', { countryCode: cc, host: u.host });
					}
				} catch {
					// ignore unparseable URLs
				}
				if (seen.auth && seen.countryCode && !settled) {
					const result = { authorization: seen.auth, countryCode: seen.countryCode };
					slog.info('both signals captured, validating against /v1/sessions');
					validate(result)
						.then((meta) => {
							slog.info('✔ session valid; persisting', { userId: meta.userId });
							authService.storeTidalSession(result.authorization, result.countryCode, meta);
							settle(() => resolve(result));
						})
						.catch((err) => {
							slog.warn('/v1/sessions validate failed, keep listening', undefined, err);
							seen.auth = '';
						});
				}
				callback({ requestHeaders: details.requestHeaders });
			}
		);

		win.on('closed', () => {
			if (!settled) {
				settled = true;
				if (timer) clearTimeout(timer);
				reject(new Error('Tidal sniff window closed before a session was captured'));
			}
		});

		timer = setTimeout(() => settle(() => reject(new Error('Tidal sniff timed out after 5 minutes'))), TIMEOUT_MS);

		win.loadURL(TIDAL_LOGIN_URL).catch((err) => settle(() => reject(err)));
	});
}

// Validate the captured bearer by hitting /v1/sessions. Returns userId +
// displayName when the token works; throws otherwise.
async function validate(creds: TidalSnoopResult): Promise<{ userId: string; displayName: string }> {
	const url = `https://api.tidal.com/v1/sessions?countryCode=${encodeURIComponent(creds.countryCode)}`;
	const res = await fetch(url, { headers: { Authorization: creds.authorization } });
	if (!res.ok) throw new Error(`/v1/sessions ${res.status}`);
	const j = (await res.json()) as { userId: number; sessionId: string; countryCode: string };
	return { userId: String(j.userId), displayName: `Tidal #${j.userId}` };
}
