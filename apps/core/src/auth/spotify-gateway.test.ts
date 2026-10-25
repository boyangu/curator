// Spotify tokens through the cloud ('spotify_gateway'): AuthService against
// the fake cloud's in-memory grant (test-support/fake-cloud.ts) on a migrated
// temp DB. Nothing reaches Spotify: the local refresh is injected, and the
// fake's "Spotify" mints and rotates tokens in memory.

import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SYNC_FEATURES, type SyncFeature } from '@curator/protocol';
import type { SpotifyTokens } from '@curator/spotify';

// The local refresh path refuses without a client id (config.ts reads it at
// import).
vi.hoisted(() => { process.env['CURATOR_SPOTIFY_CLIENT_ID'] = '0123456789abcdef0123456789abcdef'; });

import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { FakeCloud } from '../test-support/fake-cloud.js';
import { TwoDesktopRig } from '../test-support/two-desktops.js';
import { tmpDir, type TmpDir } from '../test-support/tmp.js';
import { AuthService } from './service.js';
import { TokenStore } from './store.js';

const HOUR = 3_600_000;
const VERIFIER = 'v'.repeat(43);

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// Each setup()'s dir, removed after the test.
const opened: TmpDir[] = [];

function setup(opts: { features?: readonly SyncFeature[] | null; refreshSpotify?: (rt: string) => Promise<SpotifyTokens>; gateway?: boolean } = {}) {
	const tmp = tmpDir('curator-spgw-');
	opened.push(tmp);
	const path = join(tmp.path, 'curator.db');
	migrate(path);
	const { db, sqlite } = createDb(path);
	tmp.track(sqlite);
	const cloud = new FakeCloud();
	const transport = cloud.transport('user-1');
	const state = { features: opts.features === undefined ? [...SYNC_FEATURES] as readonly SyncFeature[] | null : opts.features };
	const refreshed: string[] = [];
	let n = 0;
	const refreshSpotify = opts.refreshSpotify ?? (async (rt: string): Promise<SpotifyTokens> => {
		refreshed.push(rt);
		n++;
		return { accessToken: `local-at-${n}`, refreshToken: `local-rt-${n}`, expiresAt: new Date(Date.now() + HOUR), scope: '' };
	});
	const make = (): AuthService => {
		const auth = new AuthService(db, { refreshSpotify });
		if (opts.gateway !== false) {
			auth.attachSpotifyGateway({
				spotify: transport.spotify!,
				signedIn: () => transport.session() !== null,
				features: () => state.features,
				deviceId: () => 'dev-1',
			});
		}
		return auth;
	};
	const store = new TokenStore(db);
	// A device that signed in to Spotify before the gateway.
	const seedLocal = (opts: { expiresInMs?: number; refresh?: string } = {}): void => {
		store.put('spotify', 'access', 'user', 'local-at-0', { expiresAt: new Date(Date.now() + (opts.expiresInMs ?? -1_000)), meta: { id: 'spotify-user', displayName: 'Test DJ', avatarUrl: null } });
		store.put('spotify', 'refresh', 'user', opts.refresh ?? 'local-rt-0');
	};
	const rows = (): string[] => (sqlite.prepare(`SELECT kind FROM token WHERE source = 'spotify' ORDER BY kind`).pluck().all() as string[]);
	return { db, sqlite, cloud, transport, state, refreshed, make, store, seedLocal, rows };
}

const connectInCloud = (cloud: FakeCloud): void => {
	cloud.spotifyConnect({ deviceId: 'other-device', code: 'elsewhere', codeVerifier: VERIFIER, redirectUri: 'http://127.0.0.1:51737/auth/spotify/callback' });
	cloud.spotifyCalls.connect = 0;
};

afterEach(async () => {
	vi.useRealTimers();
	for (const t of opened.splice(0)) await t.cleanup();
});

describe('spotify gateway: vending', () => {
	it('vends one token for ten concurrent callers, caches it, and keeps no refresh token', async () => {
		const t = setup();
		connectInCloud(t.cloud);
		const auth = t.make();
		const tokens = await Promise.all(Array.from({ length: 10 }, () => auth.getSpotifyAccessToken()));
		expect(new Set(tokens)).toEqual(new Set([tokens[0]]));
		expect(tokens[0]).toMatch(/^cloud-at-/);
		expect(t.cloud.spotifyCalls.token).toBe(1);
		expect(await auth.getSpotifyAccessToken()).toBe(tokens[0]);
		expect(t.cloud.spotifyCalls.token).toBe(1);
		expect(t.rows()).toEqual(['access']);
		const s = auth.getStatus().spotify;
		expect(s).toMatchObject({ connected: true, via: 'cloud', needsReconnect: false, id: 'spotify-user', displayName: 'Test DJ' });
	});

	it('a restart before the first sync answer keeps gateway mode and the cached token', async () => {
		const t = setup();
		connectInCloud(t.cloud);
		const first = await t.make().getSpotifyAccessToken();
		t.state.features = null; // this session has not heard the server yet
		const auth = t.make();
		expect(await auth.getSpotifyAccessToken()).toBe(first);
		expect(t.cloud.spotifyCalls.token).toBe(1);
		expect(auth.getStatus().spotify.via).toBe('cloud');
	});

	it('asks again shortly before expiry, as the playback SDK does after a token runs out', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const t = setup();
		connectInCloud(t.cloud);
		const auth = t.make();
		const first = await auth.getSpotifyAccessToken();
		vi.setSystemTime(Date.now() + HOUR - 30_000);
		const second = await auth.getSpotifyAccessToken();
		expect(second).not.toBe(first);
		expect(t.cloud.spotifyCalls.token).toBe(2);
		expect(t.cloud.spotifyRefreshes).toBe(1);
		expect(t.refreshed).toEqual([]);
	});

	it('offline: the last token while it is valid, then null; back online it vends again', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const t = setup();
		connectInCloud(t.cloud);
		const auth = t.make();
		const first = await auth.getSpotifyAccessToken();
		t.transport.online = false;
		vi.setSystemTime(Date.now() + HOUR - 30_000); // inside the margin, still valid
		expect(await auth.getSpotifyAccessToken()).toBe(first);
		// Within the retry window nothing is asked of the cloud.
		const calls = t.cloud.spotifyCalls.token;
		expect(await auth.getSpotifyAccessToken()).toBe(first);
		expect(t.cloud.spotifyCalls.token).toBe(calls);
		vi.setSystemTime(Date.now() + 60_000); // expired
		expect(await auth.getSpotifyAccessToken()).toBeNull();
		expect(auth.getStatus().spotify.connected).toBe(true); // offline is not disconnected
		t.transport.online = true;
		vi.setSystemTime(Date.now() + 31_000);
		expect(await auth.getSpotifyAccessToken()).toMatch(/^cloud-at-/);
	});

	it('reconnect_required clears the access row and flags the status, keeping the identity', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const t = setup();
		connectInCloud(t.cloud);
		const auth = t.make();
		await auth.getSpotifyAccessToken();
		t.cloud.revokeSpotifyGrant();
		vi.setSystemTime(Date.now() + HOUR);
		expect(await auth.getSpotifyAccessToken()).toBeNull();
		expect(t.rows()).toEqual([]);
		expect(auth.getStatus().spotify).toMatchObject({ connected: false, needsReconnect: true, via: 'cloud', id: 'spotify-user' });
		// Signing in again through the cloud clears it.
		await auth.completeSpotifyAuth('fresh', VERIFIER);
		expect(auth.getStatus().spotify).toMatchObject({ connected: true, needsReconnect: false, via: 'cloud' });
	});

	it('an account with no grant: null, and nothing left on the device', async () => {
		const t = setup();
		t.store.put('spotify', 'access', 'user', 'stale', { expiresAt: new Date(Date.now() - 1_000), meta: { id: 'spotify-user' } });
		const auth = t.make();
		expect(await auth.getSpotifyAccessToken()).toBeNull();
		expect(t.rows()).toEqual([]);
		expect(auth.getStatus().spotify).toMatchObject({ connected: false, needsReconnect: false, id: null });
	});
});

describe('spotify gateway: connect, adopt, disconnect', () => {
	it('connect hands the code to the cloud, drops an older local grant, and vends', async () => {
		const t = setup();
		t.seedLocal({ expiresInMs: HOUR });
		const auth = t.make();
		const profile = await auth.completeSpotifyAuth('code-1', VERIFIER);
		expect(profile).toEqual({ id: 'spotify-user', displayName: 'Test DJ', avatarUrl: null });
		expect(t.cloud.spotifyCalls.connect).toBe(1);
		expect(t.cloud.spotifyCalls.adopt).toBe(0);
		expect(t.rows()).toEqual(['access']);
		expect(await auth.getSpotifyAccessToken()).toBe('cloud-at-code-code-1');
	});

	it('a refused code throws and stores nothing', async () => {
		const t = setup();
		const auth = t.make();
		await expect(auth.completeSpotifyAuth('expired-code', VERIFIER)).rejects.toThrow('spotify_reconnect_required');
		expect(t.rows()).toEqual([]);
	});

	it('adopts the device grant once: refresh row deleted, no local refresh', async () => {
		const t = setup();
		t.seedLocal();
		const auth = t.make();
		const tokens = await Promise.all(Array.from({ length: 5 }, () => auth.getSpotifyAccessToken()));
		expect(t.cloud.spotifyAdopted).toEqual(['local-rt-0']);
		expect(t.cloud.spotifyCalls.adopt).toBe(1);
		expect(tokens.every((x) => x === tokens[0] && x!.startsWith('cloud-at-'))).toBe(true);
		expect(t.rows()).toEqual(['access']);
		expect(t.refreshed).toEqual([]);
	});

	it('adoption waits out a local refresh already running and sends the rotated token; none after', async () => {
		const pending = deferred<SpotifyTokens>();
		const calls: string[] = [];
		const t = setup({ features: null, refreshSpotify: (rt) => { calls.push(rt); return pending.promise; } });
		t.seedLocal();
		// No marker yet and no answer this session: the local path refreshes.
		const auth = t.make();
		const local = auth.getSpotifyAccessToken();
		await tick();
		expect(calls).toEqual(['local-rt-0']);
		// The first answer offers the gateway.
		t.state.features = [...SYNC_FEATURES];
		const vended = auth.getSpotifyAccessToken();
		await tick();
		expect(t.cloud.spotifyCalls.adopt).toBe(0);
		pending.resolve({ accessToken: 'local-at-1', refreshToken: 'local-rt-rotated', expiresAt: new Date(Date.now() + HOUR), scope: '' });
		expect(await local).toBe('local-at-1');
		expect(await vended).toMatch(/^cloud-at-/);
		expect(t.cloud.spotifyAdopted).toEqual(['local-rt-rotated']);
		// Signed out of the cloud after adoption: the local path has nothing to
		// refresh with, and would not refresh anyway.
		await t.transport.signOut();
		t.store.put('spotify', 'access', 'user', 'old', { expiresAt: new Date(Date.now() - 1_000) });
		t.store.put('spotify', 'refresh', 'user', 'resurrected');
		expect(await auth.getSpotifyAccessToken()).toBeNull();
		expect(calls).toEqual(['local-rt-0']);
	});

	it('the cloud already holds a grant: drops the local refresh row without adopting', async () => {
		const t = setup();
		connectInCloud(t.cloud);
		t.seedLocal();
		const auth = t.make();
		expect(await auth.getSpotifyAccessToken()).toMatch(/^cloud-at-/);
		expect(t.cloud.spotifyCalls.adopt).toBe(0);
		expect(t.cloud.spotifyAdopted).toEqual([]);
		expect(t.rows()).toEqual(['access']);
		expect(t.refreshed).toEqual([]);
	});

	it('the first status with the feature adopts right away, even with a token still good', async () => {
		const t = setup({ features: [] });
		t.seedLocal({ expiresInMs: HOUR });
		const auth = t.make();
		auth.spotifyGatewayCheck();
		await tick();
		expect(t.cloud.spotifyCalls.adopt).toBe(0);
		t.state.features = [...SYNC_FEATURES];
		auth.spotifyGatewayCheck();
		for (let i = 0; i < 10 && t.rows().includes('refresh'); i++) await tick();
		expect(t.cloud.spotifyAdopted).toEqual(['local-rt-0']);
		expect(t.rows()).toEqual(['access']);
	});

	it('disconnect drops the cloud grant and the local rows', async () => {
		const t = setup();
		connectInCloud(t.cloud);
		const auth = t.make();
		await auth.getSpotifyAccessToken();
		await auth.disconnectSpotify();
		expect(t.cloud.spotifyGrant).toBeNull();
		expect(t.rows()).toEqual([]);
		expect(auth.getStatus().spotify).toMatchObject({ connected: false, via: null, needsReconnect: false });
	});

	it('disconnect offline throws and keeps the rows', async () => {
		const t = setup();
		connectInCloud(t.cloud);
		const auth = t.make();
		await auth.getSpotifyAccessToken();
		t.transport.online = false;
		await expect(auth.disconnectSpotify()).rejects.toThrow();
		expect(t.rows()).toEqual(['access']);
	});
});

describe('spotify tokens without the gateway', () => {
	it('a server without the feature: the device refreshes its own grant, as before', async () => {
		const t = setup({ features: SYNC_FEATURES.filter((f) => f !== 'spotify_gateway') });
		t.seedLocal({ expiresInMs: HOUR });
		const auth = t.make();
		expect(await auth.getSpotifyAccessToken()).toBe('local-at-0');
		t.seedLocal();
		expect(await auth.getSpotifyAccessToken()).toBe('local-at-1');
		expect(t.refreshed).toEqual(['local-rt-0']);
		expect(Object.values(t.cloud.spotifyCalls).every((n) => n === 0)).toBe(true);
		expect(auth.getStatus().spotify).toMatchObject({ connected: true, via: 'device', needsReconnect: false });
		expect(t.rows()).toEqual(['access', 'refresh']);
	});

	it('the local refresh is single-flight: ten callers, one refresh, the rotated token kept', async () => {
		const pending = deferred<SpotifyTokens>();
		const calls: string[] = [];
		const t = setup({ gateway: false, refreshSpotify: (rt) => { calls.push(rt); return pending.promise; } });
		t.seedLocal();
		const auth = t.make();
		const all = Promise.all(Array.from({ length: 10 }, () => auth.getSpotifyAccessToken()));
		await tick();
		pending.resolve({ accessToken: 'local-at-1', refreshToken: 'local-rt-1', expiresAt: new Date(Date.now() + HOUR), scope: '' });
		expect(new Set(await all)).toEqual(new Set(['local-at-1']));
		expect(calls).toEqual(['local-rt-0']);
		expect(t.store.get('spotify', 'refresh', 'user')?.value).toBe('local-rt-1');
	});
});

describe('spotify tokens in a restore', () => {
	const rows = (now: number) => [
		{ source: 'spotify', kind: 'access', scope: 'user', value: 'at', expiresAt: now + HOUR, fetchedAt: now, meta: { id: 'spotify-user' } },
		{ source: 'spotify', kind: 'refresh', scope: 'user', value: 'rt-old', expiresAt: null, fetchedAt: now, meta: null },
		{ source: 'tidal', kind: 'refresh', scope: 'user', value: 'tidal-rt', expiresAt: null, fetchedAt: now, meta: null },
	];

	it('gateway mode: the Spotify refresh row is not put back', () => {
		const t = setup();
		t.make().importTokenRows(rows(Date.now()));
		expect(t.rows()).toEqual(['access']);
		expect(t.store.get('tidal', 'refresh', 'user')?.value).toBe('tidal-rt');
	});

	it('without the gateway: every row comes back', () => {
		const t = setup({ gateway: false });
		t.make().importTokenRows(rows(Date.now()));
		expect(t.rows()).toEqual(['access', 'refresh']);
	});
});

describe('spotify gateway: two desktops through the service', () => {
	it('the first desktop adopts its grant on sync; the second vends the same token with no sign-in', async () => {
		const rig = new TwoDesktopRig('curator-spgw-rig-');
		try {
			const a = await rig.desktop('a', {
				seed: (raw) => {
					const now = Date.now();
					raw.prepare(`INSERT INTO token (source, kind, scope, value, expires_at, fetched_at, meta) VALUES ('spotify', 'access', 'user', 'local-at-0', ?, ?, ?), ('spotify', 'refresh', 'user', 'local-rt-a', NULL, ?, NULL)`)
						.run(now - 1_000, now, JSON.stringify({ id: 'spotify-user', displayName: 'Test DJ', avatarUrl: null }), now);
				},
			});
			const b = await rig.desktop('b');
			await a.sync();
			for (let i = 0; i < 50 && rig.cloud.spotifyAdopted.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
			expect(rig.cloud.spotifyAdopted).toEqual(['local-rt-a']);
			const ta = await a.svc.auth.getSpotifyAccessToken();
			expect(a.all(`SELECT kind FROM token WHERE source = 'spotify'`)).toEqual([{ kind: 'access' }]);
			await b.sync();
			const tb = await b.svc.auth.getSpotifyAccessToken();
			expect(tb).toBe(ta);
			expect(b.svc.auth.getStatus().spotify).toMatchObject({ connected: true, via: 'cloud', id: 'spotify-user' });
			expect(rig.cloud.spotifyRefreshes).toBe(1);
		} finally {
			await rig.close();
		}
	});
});
