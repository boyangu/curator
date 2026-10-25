// Auth service — single point that owns "is X connected, and as whom".
// Persists tokens, refreshes them when expired, returns status for the UI.

import {
	SpotifyClient,
	exchangeCodeForTokens,
	refreshTokens,
	type SpotifyTokens,
} from '@curator/spotify';
import type { SpotifyProfile } from '@curator/protocol';
import {
	TidalApiClient,
	exchangeTidalCodeForTokens,
	refreshTidalTokens,
	type TidalUser,
} from '@curator/tidal';
import { SpotifyGateway, type SpotifyGatewayPort } from './spotify-gateway.js';
import { TokenStore } from './store.js';
import type { ExportedTokenRow } from '../backup/types.js';
import { config } from '../config.js';
import type { Db } from '../db/client.js';
import { log } from '../log.js';

const alog = log.for('auth');

// One wording per source, shared by the auth flows (desktop auth/*.ts throws
// it before opening a sign-in window) and the refresh paths here.
export const NOT_CONFIGURED = {
	spotify: 'Spotify is not configured in this build: set CURATOR_SPOTIFY_CLIENT_ID',
	tidal: 'Tidal is not configured in this build: set CURATOR_TIDAL_CLIENT_ID and CURATOR_TIDAL_CLIENT_SECRET',
} as const;

export interface AuthStatusEntry {
	// False when this build carries no app credentials for the source
	// (CURATOR_SPOTIFY_CLIENT_ID / CURATOR_TIDAL_CLIENT_ID+SECRET): Connect is
	// refused and a stored token is never refreshed. The UI says "not
	// configured" instead of offering a sign-in that would fail.
	configured: boolean;
	connected: boolean;
	displayName: string | null;
	avatarUrl: string | null;
	id: string | null;
	connectedAt: Date | null;
	error: string | null;
	// Where the tokens come from: 'cloud' when the Curator cloud holds the
	// grant and vends them (Spotify, 'spotify_gateway'), 'device' when this
	// device holds and refreshes its own; null while disconnected.
	via: 'cloud' | 'device' | null;
	// Spotify refused the account's grant (revoked, a scope change): the user
	// signs in again. `id` / `displayName` still name the account it was.
	needsReconnect: boolean;
}

export interface AuthStatus {
	spotify: AuthStatusEntry;
	tidal: AuthStatusEntry;
}

export type AuthServiceOptions = {
	// Test seam for the local refresh (the real one reaches Spotify).
	refreshSpotify?: (refreshToken: string) => Promise<SpotifyTokens>;
};

export class AuthService {
	private readonly store: TokenStore;
	private readonly refreshSpotify: (refreshToken: string) => Promise<SpotifyTokens>;
	// The cloud's token source (attachSpotifyGateway); null without a cloud
	// transport that has the procedures.
	private gateway: SpotifyGateway | null = null;
	// Single flight for the local refresh: Spotify may rotate the refresh
	// token on any refresh, so two concurrent ones with the same token leave
	// the loser holding a dead one (and may strand the grant).
	private spotifyRefreshing: Promise<string | null> | null = null;
	// Set once the grant starts moving to the cloud (or a cloud connect
	// starts): no local refresh after that, for the rest of the session.
	private localRefreshStopped = false;

	constructor(private readonly db: Db, opts: AuthServiceOptions = {}) {
		this.store = new TokenStore(db);
		this.refreshSpotify = opts.refreshSpotify ?? ((t) => refreshTokens(config.spotify, t));
	}

	// ─── Spotify ─────────────────────────────────────────────────────────

	// Gateway mode (auth/spotify-gateway.ts): while the port says the cloud
	// is signed in and offers 'spotify_gateway', the cloud is the token
	// source. Wired once by createCoreService.
	attachSpotifyGateway(port: SpotifyGatewayPort, opts: { onIdentityChange?: () => void } = {}): void {
		this.gateway = new SpotifyGateway(port, {
			store: this.store,
			db: this.db,
			stopLocalRefresh: async () => {
				this.localRefreshStopped = true;
				await this.spotifyRefreshing?.catch(() => null);
			},
			onIdentityChange: opts.onIdentityChange,
		});
	}

	// From the sync client's status events (the server's features arrive
	// with them).
	spotifyGatewayCheck(): void {
		this.gateway?.check();
	}

	async completeSpotifyAuth(code: string, codeVerifier: string): Promise<SpotifyProfile> {
		if (this.gateway?.active()) return this.gateway.connect(code, codeVerifier, config.spotify.redirectUri);
		if (!config.spotify.configured) throw new Error(NOT_CONFIGURED.spotify);
		const tokens = await exchangeCodeForTokens(config.spotify, code, codeVerifier);
		this.store.put('spotify', 'access', 'user', tokens.accessToken, { expiresAt: tokens.expiresAt });
		this.store.put('spotify', 'refresh', 'user', tokens.refreshToken);
		// fetch + persist user info
		const me = await new SpotifyClient(tokens.accessToken, 'auth:verify').getMe();
		const profile: SpotifyProfile = { id: me.id, displayName: me.display_name, avatarUrl: me.images[0]?.url ?? null };
		this.store.put('spotify', 'access', 'user', tokens.accessToken, { expiresAt: tokens.expiresAt, meta: profile });
		this.gateway?.forget();
		return profile;
	}

	async getSpotifyAccessToken(): Promise<string | null> {
		if (this.gateway?.active()) return this.gateway.token();
		const access = this.store.get('spotify', 'access', 'user');
		if (!access) return null;
		const margin = 60_000; // refresh 1 min before expiry
		if (access.expiresAt && access.expiresAt.getTime() - Date.now() > margin) {
			return access.value;
		}
		// expired or near-expiry — refresh, once for every caller
		this.spotifyRefreshing ??= this.refreshSpotifyLocally().finally(() => { this.spotifyRefreshing = null; });
		return this.spotifyRefreshing;
	}

	private async refreshSpotifyLocally(): Promise<string | null> {
		// Read inside the flight: the previous one may have rotated it.
		const access = this.store.get('spotify', 'access', 'user');
		const refresh = this.store.get('spotify', 'refresh', 'user');
		if (!access || !refresh) return null;
		if (this.localRefreshStopped) {
			alog.warn('spotify local refresh skipped: the grant is moving to the cloud');
			return null;
		}
		// A token row can outlive the credentials (restored DB, unconfigured
		// build): refreshing with an empty client id is a guaranteed 400.
		if (!config.spotify.configured) {
			alog.warn('spotify token refresh skipped: ' + NOT_CONFIGURED.spotify);
			return null;
		}
		try {
			const tokens = await this.refreshSpotify(refresh.value);
			this.store.put('spotify', 'access', 'user', tokens.accessToken, {
				expiresAt: tokens.expiresAt,
				meta: access.meta,
			});
			this.store.put('spotify', 'refresh', 'user', tokens.refreshToken);
			this.gateway?.forget();
			return tokens.accessToken;
		} catch (err) {
			alog.warn('spotify refresh failed', undefined, err);
			return null;
		}
	}

	// Gateway mode: the cloud drops the account's grant (every device), then
	// this device's rows go. A failed cloud call throws and keeps them: the
	// next vend would only bring the token back.
	async disconnectSpotify(): Promise<void> {
		if (this.gateway?.active()) return this.gateway.disconnect();
		this.store.clear('spotify');
		this.gateway?.forget();
	}

	// ─── Tidal (OAuth) ───────────────────────────────────────────────────

	async completeTidalOAuth(code: string, codeVerifier: string): Promise<TidalUser> {
		if (!config.tidal.configured) throw new Error(NOT_CONFIGURED.tidal);
		const tokens = await exchangeTidalCodeForTokens(config.tidal, code, codeVerifier);
		this.store.put('tidal', 'access', 'user', tokens.accessToken, { expiresAt: tokens.expiresAt });
		this.store.put('tidal', 'refresh', 'user', tokens.refreshToken);

		// Validate + cache user profile so the UI has a name to show without
		// hitting /users/me on every status check.
		const me = await new TidalApiClient(
			config.tidal.apiBase,
			async () => tokens.accessToken,
			'US' // placeholder; replaced from me.country below
		).getMe();
		const countryCode = me.country ?? 'US';
		this.store.put('tidal', 'access', 'user', tokens.accessToken, {
			expiresAt: tokens.expiresAt,
			meta: {
				userId: me.id,
				countryCode,
				displayName: me.displayName ?? `Tidal #${me.id}`,
				avatarUrl: me.picture
					? `https://resources.tidal.com/images/${me.picture.replaceAll('-', '/')}/320x320.jpg`
					: null,
			},
		});
		return me;
	}

	async getTidalAccessToken(): Promise<string | null> {
		const access = this.store.get('tidal', 'access', 'user');
		if (!access) return null;
		const margin = 60_000;
		if (access.expiresAt && access.expiresAt.getTime() - Date.now() > margin) {
			return access.value;
		}
		const refresh = this.store.get('tidal', 'refresh', 'user');
		if (!refresh) return null;
		if (!config.tidal.configured) {
			alog.warn('tidal token refresh skipped: ' + NOT_CONFIGURED.tidal);
			return null;
		}
		try {
			const tokens = await refreshTidalTokens(config.tidal, refresh.value);
			this.store.put('tidal', 'access', 'user', tokens.accessToken, {
				expiresAt: tokens.expiresAt,
				meta: access.meta,
			});
			this.store.put('tidal', 'refresh', 'user', tokens.refreshToken);
			return tokens.accessToken;
		} catch (err) {
			alog.warn('tidal refresh failed', undefined, err);
			return null;
		}
	}

	getTidalCountryCode(): string | null {
		const t = this.store.get('tidal', 'access', 'user');
		if (!t) return null;
		return (t.meta as { countryCode?: string } | null)?.countryCode ?? null;
	}

	// ─── Tidal session sniff (legacy path, used for download only) ─────
	// The official OAuth tier (THIRD_PARTY) is locked out of /trackFiles +
	// /trackManifests. Downloading still requires a real listen.tidal.com
	// session bearer captured from the user's logged-in browser. We keep
	// this token under kind='session' so it lives alongside the OAuth pair
	// without colliding.

	storeTidalSession(authorization: string, countryCode: string, meta?: { userId?: string; displayName?: string }): void {
		// Parse the JWT's `exp` claim so we can preempt expiry. Tidal bearer
		// tokens are 24h JWTs; without an explicit expiresAt the store would
		// keep handing back a dead token until an API call 401s mid-download.
		const exp = parseJwtExpiry(authorization);
		this.store.put('tidal', 'session', 'user', authorization, {
			expiresAt: exp ?? undefined,
			meta: { countryCode, userId: meta?.userId ?? null, displayName: meta?.displayName ?? null },
		});
	}

	getTidalSessionExpiresAt(): Date | null {
		const t = this.store.get('tidal', 'session', 'user');
		return t?.expiresAt ?? null;
	}

	// Has a session bearer that won't expire within `marginMs`. Used by the
	// download flow to decide whether to trigger a fresh sniff BEFORE the
	// queue starts pulling jobs — better than mid-flight 401s.
	isTidalSessionFresh(marginMs = 15 * 60_000): boolean {
		const exp = this.getTidalSessionExpiresAt();
		if (!exp) return false;
		return exp.getTime() - Date.now() > marginMs;
	}

	getTidalSessionToken(): { token: string; countryCode: string } | null {
		const t = this.store.get('tidal', 'session', 'user');
		if (!t) return null;
		const cc = (t.meta as { countryCode?: string } | null)?.countryCode;
		if (!cc) return null;
		return { token: t.value, countryCode: cc };
	}

	hasTidalSession(): boolean {
		return !!this.store.get('tidal', 'session', 'user');
	}

	disconnectTidal(): void {
		this.store.clear('tidal');
	}

	// ─── Backup token sidecar ───────────────────────────────────────────
	// The backup strips `token` rows from the DB copy; the desktop main
	// encrypts this export with safeStorage into a machine-bound file so a
	// same-machine restore keeps the user signed in. Main-process only —
	// deliberately NOT a CoreService method, so no IPC channel can ever
	// hand the renderer (or an MCP client) plaintext tokens.

	exportTokenRows(): ExportedTokenRow[] {
		return this.store.all().map((r) => ({
			source: r.source, kind: r.kind, scope: r.scope, value: r.value,
			expiresAt: r.expiresAt ? r.expiresAt.getTime() : null, fetchedAt: r.fetchedAt.getTime(), meta: r.meta,
		}));
	}

	// In gateway mode a restored Spotify refresh token is never put back: the
	// cloud owns the grant, and a stale copy here could be refreshed (or
	// adopted) against it.
	importTokenRows(rows: ExportedTokenRow[]): void {
		if (this.gateway?.offered()) {
			const kept = rows.filter((r) => !(r.source === 'spotify' && r.kind === 'refresh'));
			if (kept.length !== rows.length) alog.info('restore: spotify refresh token skipped (the cloud holds the grant)', { skipped: rows.length - kept.length });
			rows = kept;
		}
		this.gateway?.forget();
		this.store.importRows(rows.map((r) => ({
			source: r.source, kind: r.kind, scope: r.scope, value: r.value,
			expiresAt: r.expiresAt != null ? new Date(r.expiresAt) : null, fetchedAt: new Date(r.fetchedAt), meta: r.meta,
		})));
	}

	// ─── Combined status ─────────────────────────────────────────────────

	getStatus(): AuthStatus {
		const sp = this.store.get('spotify', 'access', 'user');
		const td = this.store.get('tidal', 'access', 'user');
		const viaCloud = this.gateway?.active() ?? false;
		// A grant Spotify refused: no token row, but the account it was (the
		// membership identity holds until a reconnect or a disconnect).
		const lost = viaCloud && !sp && this.gateway!.needsReconnect() ? this.gateway!.profile() : null;

		return {
			spotify: sp
				? {
						configured: config.spotify.configured,
						connected: true,
						displayName: (sp.meta as Record<string, unknown> | null)?.['displayName'] as string ?? null,
						avatarUrl: (sp.meta as Record<string, unknown> | null)?.['avatarUrl'] as string ?? null,
						id: (sp.meta as Record<string, unknown> | null)?.['id'] as string ?? null,
						connectedAt: sp.fetchedAt,
						error: null,
						via: viaCloud ? 'cloud' : 'device',
						needsReconnect: false,
				  }
				: lost
					? {
							configured: config.spotify.configured,
							connected: false,
							displayName: lost.displayName,
							avatarUrl: lost.avatarUrl,
							id: lost.id,
							connectedAt: null,
							error: 'Spotify refused the sign-in: reconnect Spotify',
							via: 'cloud',
							needsReconnect: true,
					  }
					: { configured: config.spotify.configured, connected: false, displayName: null, avatarUrl: null, id: null, connectedAt: null, error: null, via: null, needsReconnect: false },
			tidal: td
				? {
						configured: config.tidal.configured,
						connected: true,
						displayName: (td.meta as Record<string, unknown> | null)?.['displayName'] as string ?? null,
						avatarUrl: (td.meta as Record<string, unknown> | null)?.['avatarUrl'] as string ?? null,
						id: String((td.meta as Record<string, unknown> | null)?.['userId'] ?? ''),
						connectedAt: td.fetchedAt,
						error: null,
						via: 'device',
						needsReconnect: false,
				  }
				: { configured: config.tidal.configured, connected: false, displayName: null, avatarUrl: null, id: null, connectedAt: null, error: null, via: null, needsReconnect: false },
		};
	}
}

// Extract `exp` from a JWT-format Tidal bearer. Returns the Date when the
// token expires, or null when the token isn't a JWT (some older Tidal access
// tokens are opaque). Caller treats null as "unknown expiry, assume stale".
function parseJwtExpiry(authorization: string): Date | null {
	try {
		const token = authorization.replace(/^Bearer\s+/i, '');
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		// base64url → base64
		const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
		const json = Buffer.from(b64, 'base64').toString('utf8');
		const payload = JSON.parse(json) as { exp?: number };
		if (typeof payload.exp !== 'number') return null;
		return new Date(payload.exp * 1000);
	} catch {
		return null;
	}
}
