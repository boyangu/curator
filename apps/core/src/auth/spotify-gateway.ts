// Spotify tokens through the Curator cloud ('spotify_gateway', protocol
// spotify-gateway.ts). When this device is signed in to the cloud and the
// server offers the gateway, the account's Spotify grant lives there: the
// device asks `spotify.token` for a short-lived access token and never holds
// a refresh token. Spotify may rotate the refresh token on every refresh, so
// one owner is the only way two devices (or two callers on one) cannot strand
// each other.
//
// Every consumer still calls AuthService.getSpotifyAccessToken(); this is the
// source behind it in gateway mode. What it keeps on the device:
//   - the access row (token + expiry + the profile in its meta), so
//     getStatus().spotify — and with it the membership identity — works
//     offline and across restarts. Never a refresh row.
//   - app_setting 'spotify.gateway' (device-local): whether the last server
//     answer offered the gateway (an adopted device has nothing to refresh
//     with before this session's first sync answer), and the "reconnect"
//     state with the profile it belonged to, so the identity survives a
//     revoked grant until the user reconnects or disconnects.
//
// Logs carry counts and error kinds only, never a token.

import { eq } from 'drizzle-orm';
import { appSetting } from '@curator/shared/schema';
import type { CloudService, SpotifyProfile, SpotifyTokenResult, SyncFeature } from '@curator/protocol';
import type { Db } from '../db/client.js';
import { log } from '../log.js';
import { CloudTransportError } from '../sync-log/client.js';
import type { TokenStore } from './store.js';

const glog = log.for('spotify-gateway');

export const SPOTIFY_GATEWAY_FEATURE: SyncFeature = 'spotify_gateway';
const STATE_KEY = 'spotify.gateway';

// Ask for a new token this long before the vended one expires (the local
// refresh path's margin).
export const SPOTIFY_TOKEN_MARGIN_MS = 60_000;
// After a vend failed (offline, the server erroring) callers get the last
// token, or null, without another call for this long: the playback SDK asks
// on every play and the feed producers loop.
const RETRY_MS = 30_000;
// After Spotify refused the grant, or the account turned out to hold none:
// another device may connect meanwhile, so ask again, but rarely.
const RECHECK_MS = 5 * 60_000;

// What the gateway needs of the cloud side (service.ts wires it from the
// transport and the sync client).
export type SpotifyGatewayPort = {
	spotify: CloudService['spotify'];
	signedIn(): boolean;
	// The server's features as last answered this session; null before the
	// first answer.
	features(): readonly SyncFeature[] | null;
	deviceId(): string;
};

export type SpotifyGatewayDeps = {
	store: TokenStore;
	db: Db;
	// Stops every local refresh from now on and resolves once one running now
	// has finished (AuthService owns the local path).
	stopLocalRefresh(): Promise<void>;
	// The Spotify account this device acts as changed (connected elsewhere,
	// disconnected elsewhere): the streaming-vs-followed split depends on it.
	onIdentityChange?: () => void;
	now?: () => number;
};

type GatewayState = { offered: boolean; needsReconnect: boolean; profile: SpotifyProfile | null };

const EMPTY: GatewayState = { offered: false, needsReconnect: false, profile: null };

export class SpotifyGateway {
	private state: GatewayState;
	private cached: { accessToken: string; expiresAt: number } | null = null;
	// Single flight: every caller during one vend shares its answer.
	private vending: Promise<string | null> | null = null;
	private adopting: Promise<void> | null = null;
	private quietUntil = 0;
	private failing = false;
	private wasActive = false;
	private readonly now: () => number;

	constructor(private readonly port: SpotifyGatewayPort, private readonly deps: SpotifyGatewayDeps) {
		this.now = deps.now ?? Date.now;
		const row = deps.db.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, STATE_KEY)).get();
		this.state = { ...EMPTY, ...((row?.value as Partial<GatewayState> | undefined) ?? {}) };
	}

	// Whether the server offers the gateway: this session's last answer, else
	// what the previous session heard.
	offered(): boolean {
		const f = this.port.features();
		if (f !== null) {
			const on = f.includes(SPOTIFY_GATEWAY_FEATURE);
			if (on !== this.state.offered) {
				this.patch({ offered: on });
				glog.info('spotify gateway offer changed', { offered: on });
			}
		}
		return this.state.offered;
	}

	active(): boolean {
		return this.port.signedIn() && this.offered();
	}

	needsReconnect(): boolean {
		return this.state.needsReconnect;
	}

	profile(): SpotifyProfile | null {
		return this.state.profile;
	}

	// On every sync status event. The first time the gateway is active this
	// session, a grant this device still holds moves to the cloud now rather
	// than at the next expiry, and a device with no token learns whether the
	// account has one (connected on another device).
	check(): void {
		const on = this.active();
		if (on && !this.wasActive) {
			// Adoption first: a token still good in the cache would skip it.
			void this.adoptIfNeeded().then(
				() => this.token(),
				(err: unknown) => this.logFailure('spotify grant could not move to the cloud yet', err instanceof CloudTransportError ? err.kind : 'network'),
			);
		}
		this.wasActive = on;
	}

	async token(): Promise<string | null> {
		const now = this.now();
		const c = this.current();
		if (c && c.expiresAt - SPOTIFY_TOKEN_MARGIN_MS > now) return c.accessToken;
		if (now < this.quietUntil) return this.fallback(now);
		this.vending ??= this.vend().finally(() => { this.vending = null; });
		return this.vending;
	}

	// The PKCE window ran on this device; the cloud exchanges the code and
	// keeps the grant.
	async connect(code: string, codeVerifier: string, redirectUri: string): Promise<SpotifyProfile> {
		await this.deps.stopLocalRefresh();
		const deviceId = this.port.deviceId();
		await this.port.spotify.connect({ deviceId, code, codeVerifier, redirectUri });
		// The cloud's grant replaces one this device held from an older sign-in
		// (a separate grant: refreshing it would only keep a second session
		// alive, and adopting it later would overwrite the new one).
		this.deps.store.clear('spotify', 'refresh', 'user');
		this.cached = null;
		this.quietUntil = 0;
		const r = await this.port.spotify.token({ deviceId });
		this.remember(r);
		glog.info('spotify connected through the cloud');
		return r.profile;
	}

	async disconnect(): Promise<void> {
		// A vend landing after the clear would put the row back.
		await this.vending?.catch(() => null);
		await this.port.spotify.disconnect({ deviceId: this.port.deviceId() });
		this.forgetLocal();
		glog.info('spotify disconnected through the cloud');
	}

	// Local rows were cleared or rewritten outside the gateway.
	forget(): void {
		this.cached = null;
		this.quietUntil = 0;
		if (this.state.needsReconnect || this.state.profile) this.patch({ needsReconnect: false, profile: null });
	}

	private forgetLocal(): void {
		this.deps.store.clear('spotify');
		this.forget();
	}

	// The in-memory copy, seeded from the access row once (a restart keeps a
	// token that is still good).
	private current(): { accessToken: string; expiresAt: number } | null {
		if (this.cached) return this.cached;
		const row = this.deps.store.get('spotify', 'access', 'user');
		if (row?.expiresAt) this.cached = { accessToken: row.value, expiresAt: row.expiresAt.getTime() };
		return this.cached;
	}

	private fallback(now: number): string | null {
		const c = this.current();
		return c && c.expiresAt > now ? c.accessToken : null;
	}

	private async vend(): Promise<string | null> {
		try {
			await this.adoptIfNeeded();
			const r = await this.port.spotify.token({ deviceId: this.port.deviceId() });
			this.remember(r);
			return r.accessToken;
		} catch (err) {
			return this.vendFailed(err);
		}
	}

	private remember(r: SpotifyTokenResult): void {
		const before = this.identity();
		this.deps.store.put('spotify', 'access', 'user', r.accessToken, {
			expiresAt: new Date(r.expiresAt),
			meta: { id: r.profile.id, displayName: r.profile.displayName, avatarUrl: r.profile.avatarUrl, via: 'cloud' },
		});
		this.cached = { accessToken: r.accessToken, expiresAt: r.expiresAt };
		this.quietUntil = 0;
		if (this.failing) {
			this.failing = false;
			glog.info('spotify tokens from the cloud again');
		}
		const p = this.state.profile;
		if (this.state.needsReconnect || !p || p.id !== r.profile.id || p.displayName !== r.profile.displayName || p.avatarUrl !== r.profile.avatarUrl) {
			this.patch({ needsReconnect: false, profile: r.profile });
		}
		if (before !== r.profile.id) this.deps.onIdentityChange?.();
	}

	private vendFailed(err: unknown): string | null {
		const kind = err instanceof CloudTransportError ? err.kind : 'network';
		const now = this.now();
		if (kind === 'spotify_reconnect_required') {
			// Spotify refused the account's grant; the token this device holds
			// came from it. The profile stays (the identity holds until the user
			// reconnects or disconnects).
			this.deps.store.clear('spotify', 'access', 'user');
			this.cached = null;
			this.quietUntil = now + RECHECK_MS;
			if (!this.state.needsReconnect) this.patch({ needsReconnect: true });
			this.logFailure('spotify refused the account grant; reconnect Spotify', kind);
			return null;
		}
		if (kind === 'spotify_not_connected') {
			// The account holds no grant (never connected, or disconnected on
			// another device), and adoption already ran: neither does this device.
			const before = this.identity();
			this.forgetLocal();
			this.quietUntil = now + RECHECK_MS;
			this.logFailure('the account has no spotify connection', kind);
			if (before !== null) this.deps.onIdentityChange?.();
			return null;
		}
		this.quietUntil = now + RETRY_MS;
		const token = this.fallback(now);
		this.logFailure('spotify token from the cloud failed', kind, { lastTokenValid: token !== null });
		return token;
	}

	private logFailure(msg: string, kind: string, extra: Record<string, unknown> = {}): void {
		if (this.failing) return;
		this.failing = true;
		glog.warn(msg, { kind, ...extra });
	}

	private identity(): string | null {
		const meta = this.deps.store.get('spotify', 'access', 'user')?.meta as { id?: string } | null | undefined;
		return meta?.id ?? this.state.profile?.id ?? null;
	}

	// A device that signed in to Spotify before the gateway moves its grant to
	// the cloud once, then vends like every other device.
	private adoptIfNeeded(): Promise<void> {
		if (this.adopting) return this.adopting;
		if (!this.deps.store.get('spotify', 'refresh', 'user')) return Promise.resolve();
		this.adopting = this.adopt().finally(() => { this.adopting = null; });
		return this.adopting;
	}

	private async adopt(): Promise<void> {
		// From here this device never refreshes locally again: a refresh after
		// the cloud's would strand the grant just handed over. One running now
		// finishes first, so the token sent is the newest.
		await this.deps.stopLocalRefresh();
		const refresh = this.deps.store.get('spotify', 'refresh', 'user');
		if (!refresh) return;
		// Another device moved its grant (or connected) first, or an adopt of
		// ours went through and its answer was lost: the cloud's grant serves
		// this device too. A grant Spotify refused is worth replacing with ours.
		const st = await this.port.spotify.status();
		if (st.connected && !st.needsReconnect) {
			this.deps.store.clear('spotify', 'refresh', 'user');
			glog.info('spotify grant already in the cloud; dropped this device copy', { dropped: 1 });
			return;
		}
		try {
			const res = await this.port.spotify.adopt({ deviceId: this.port.deviceId(), refreshToken: refresh.value });
			this.deps.store.clear('spotify', 'refresh', 'user');
			if (res.profile) this.patch({ needsReconnect: false, profile: res.profile });
			glog.info('spotify grant moved to the cloud', { adopted: 1 });
		} catch (err) {
			if (err instanceof CloudTransportError && err.kind === 'spotify_reconnect_required') {
				// Spotify refused this device's token: nothing to move or keep.
				this.deps.store.clear('spotify', 'refresh', 'user');
				glog.warn('spotify refused this device grant; not moved', { dropped: 1 });
				return;
			}
			throw err;
		}
	}

	private patch(p: Partial<GatewayState>): void {
		this.state = { ...this.state, ...p };
		const value = this.state;
		this.deps.db.insert(appSetting)
			.values({ key: STATE_KEY, value, updatedAt: new Date() })
			.onConflictDoUpdate({ target: appSetting.key, set: { value, updatedAt: new Date() } })
			.run();
	}
}
