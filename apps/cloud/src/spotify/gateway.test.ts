// The Spotify gateway (stage 1) end to end through the API: tRPC → gateway →
// PGlite under RLS, with a fake Spotify as the only network. Nothing here
// reaches Spotify.

import { randomUUID } from 'node:crypto';
import { SPOTIFY_GATEWAY_SCOPES, SYNC_FEATURES } from '@curator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db, Queryable } from '../db/db.js';
import { TokenBucketLimiter } from '../rate-limit.js';
import { FakeSpotify, randomTokenKey } from '../test/fake-spotify.js';
import { asUser, createTestApp, errorReason, type TestApp } from '../test/harness.js';
import { TokenCrypto } from './crypto.js';

const VERIFIER = 'pkce-verifier-'.padEnd(64, 'x');
const REDIRECT = 'http://127.0.0.1:43821/spotify/callback';

type Session = Awaited<ReturnType<TestApp['signIn']>>;

async function connect(app: TestApp, s?: Session): Promise<Session> {
	const session = s ?? (await app.signIn());
	const code = app.spotify!.authorize(VERIFIER, REDIRECT);
	await session.api.spotify.connect.mutate({ deviceId: session.deviceId, code, codeVerifier: VERIFIER, redirectUri: REDIRECT });
	return session;
}

// A second device of the same account, signed in with its own session.
async function secondDevice(app: TestApp, s: Session): Promise<{ deviceId: string; api: Session['api'] }> {
	const deviceId = `phone-${randomUUID()}`;
	const api = app.client(await app.sign(s.userId, { sessionId: `session-${deviceId}` }));
	await api.account.registerDevice.mutate({ deviceId, name: 'Phone', platform: 'ios' });
	return { deviceId, api };
}

// As the owner (no RLS): the cached access token has `secs` left.
const expireIn = (app: TestApp, userId: string, secs: number) =>
	app.pg.query(`update curator.spotify_grant set access_expires_at = now() + make_interval(secs => $2::float8) where user_id = $1`, [userId, secs]);

const grantRow = async (app: TestApp, userId: string) =>
	(
		await app.pg.query<{ key_id: string; needs_reconnect: boolean; has_access: boolean }>(
			`select key_id, needs_reconnect, access_ct is not null as has_access from curator.spotify_grant where user_id = $1`,
			[userId],
		)
	).rows[0];

async function auditKinds(app: TestApp, userId: string): Promise<{ kind: string; detail: Record<string, unknown> }[]> {
	await app.audit.flush();
	return (await app.pg.query<{ kind: string; detail: Record<string, unknown> }>(`select kind, detail from curator.audit_event where user_id = $1 and kind like 'spotify%' order by at, kind`, [userId])).rows;
}

let app: TestApp;
let spotify: FakeSpotify;
beforeAll(async () => {
	app = await createTestApp();
	spotify = app.spotify!;
});
afterAll(() => app.db.close());

describe('spotify.connect', () => {
	it('stores the grant as ciphertext only, and no token reaches a table or a log line', async () => {
		const s = await app.signIn();
		const before = (await s.api.spotify.status.query()).connected;
		await connect(app, s);
		expect(before).toBe(false);
		// Everything the row holds, as text: bytea comes out as hex, so a
		// plaintext token would show either way.
		const [row] = (await app.pg.query<{ t: string; hex: string }>(
			`select row_to_json(g)::text as t, encode(refresh_ct, 'hex') || encode(access_ct, 'hex') as hex from curator.spotify_grant g where user_id = $1`,
			[s.userId],
		)).rows;
		expect(row).toBeDefined();
		await app.audit.flush();
		const logged = [
			(await app.pg.query<{ t: string }>(`select coalesce(json_agg(r)::text, '') as t from curator.request_log r`)).rows[0]!.t,
			(await app.pg.query<{ t: string }>(`select coalesce(json_agg(a)::text, '') as t from curator.audit_event a`)).rows[0]!.t,
			JSON.stringify(app.logs),
		].join('\n');
		expect(spotify.issued.length).toBeGreaterThanOrEqual(2);
		for (const tok of spotify.issued) {
			expect(row!.t).not.toContain(tok);
			expect(row!.hex).not.toContain(Buffer.from(tok).toString('hex'));
			expect(logged).not.toContain(tok);
		}
		// Nor the email /me answers with.
		expect(row!.t).not.toContain('never-stored@example.com');
	});

	it('answers the status: profile, scopes, connected', async () => {
		const s = await connect(app);
		const st = await s.api.spotify.status.query();
		expect(st).toEqual({
			connected: true,
			profile: { id: 'fake-spotify-user', displayName: 'DJ Fake', avatarUrl: 'https://i.scdn.co/image/fake' },
			scopes: [...SPOTIFY_GATEWAY_SCOPES],
			connectedAt: expect.any(Number),
			needsReconnect: false,
		});
		expect(Math.abs(st.connectedAt! - Date.now())).toBeLessThan(60_000);
		expect(await auditKinds(app, s.userId)).toEqual([{ kind: 'spotify_connected', detail: { scopes: SPOTIFY_GATEWAY_SCOPES.length, replaced: false } }]);
	});

	it('refuses an expired or reused code, a wrong verifier or redirect, and keeps the existing grant', async () => {
		const s = await connect(app);
		const code = spotify.authorize(VERIFIER, REDIRECT);
		const call = (c: string, v = VERIFIER, r = REDIRECT) => errorReason(s.api.spotify.connect.mutate({ deviceId: s.deviceId, code: c, codeVerifier: v, redirectUri: r }));
		expect(await call(code, 'w'.repeat(64))).toMatchObject({ code: 'FORBIDDEN', reason: 'spotify_reconnect_required' });
		// Single use: the failed attempt spent it.
		expect(await call(code)).toMatchObject({ reason: 'spotify_reconnect_required' });
		expect(await call(spotify.authorize(VERIFIER, REDIRECT), VERIFIER, 'http://127.0.0.1:1/other')).toMatchObject({ reason: 'spotify_reconnect_required' });
		expect((await s.api.spotify.status.query()).connected).toBe(true);
		await expect(s.api.spotify.token.mutate({ deviceId: s.deviceId })).resolves.toMatchObject({ accessToken: expect.any(String) });
	});

	it('replaces the grant on a second connect', async () => {
		const s = await connect(app);
		const first = await s.api.spotify.token.mutate({ deviceId: s.deviceId });
		await connect(app, s);
		const second = await s.api.spotify.token.mutate({ deviceId: s.deviceId });
		expect(second.accessToken).not.toBe(first.accessToken);
		expect((await auditKinds(app, s.userId)).map((e) => e.detail.replaced)).toEqual([false, true]);
	});
});

describe('spotify.token', () => {
	it('answers spotify_not_connected for an account without a grant', async () => {
		const s = await app.signIn();
		expect(await errorReason(s.api.spotify.token.mutate({ deviceId: s.deviceId }))).toMatchObject({ code: 'FORBIDDEN', reason: 'spotify_not_connected' });
	});

	it('hands every device the cached token while it has more than five minutes left', async () => {
		const s = await connect(app);
		const phone = await secondDevice(app, s);
		const refreshes = spotify.calls.refresh;
		const a = await s.api.spotify.token.mutate({ deviceId: s.deviceId });
		const b = await phone.api.spotify.token.mutate({ deviceId: phone.deviceId });
		expect(b).toEqual(a);
		expect(a).toEqual({ accessToken: expect.stringMatching(/^fake-at-/), expiresAt: expect.any(Number), scopes: [...SPOTIFY_GATEWAY_SCOPES], profile: expect.objectContaining({ id: 'fake-spotify-user' }) });
		expect(a.expiresAt - Date.now()).toBeGreaterThan(3500_000);
		expect(spotify.calls.refresh).toBe(refreshes);
		// Vending is no audit event (request_log holds it).
		expect((await auditKinds(app, s.userId)).map((e) => e.kind)).toEqual(['spotify_connected']);
	});

	it('refreshes near expiry and persists the rotated refresh token', async () => {
		const s = await connect(app);
		const old = await s.api.spotify.token.mutate({ deviceId: s.deviceId });
		const refreshes = spotify.calls.refresh;
		await expireIn(app, s.userId, 4 * 60);
		const fresh = await s.api.spotify.token.mutate({ deviceId: s.deviceId });
		expect(fresh.accessToken).not.toBe(old.accessToken);
		expect(fresh.expiresAt - Date.now()).toBeGreaterThan(3500_000);
		expect(spotify.calls.refresh).toBe(refreshes + 1);
		// The fake rotated (and killed) the refresh token it was given: a
		// second refresh only works if the new one was stored.
		await expireIn(app, s.userId, 0);
		const third = await s.api.spotify.token.mutate({ deviceId: s.deviceId });
		expect(third.accessToken).not.toBe(fresh.accessToken);
		expect(spotify.calls.refresh).toBe(refreshes + 2);
		// And the next call is the cache again.
		await expect(s.api.spotify.token.mutate({ deviceId: s.deviceId })).resolves.toEqual(third);
		expect(spotify.calls.refresh).toBe(refreshes + 2);
	});

	it('keeps the refresh token it has when Spotify does not rotate it', async () => {
		const s = await connect(app);
		spotify.rotate = false;
		try {
			for (let i = 0; i < 2; i++) {
				await expireIn(app, s.userId, 0);
				await expect(s.api.spotify.token.mutate({ deviceId: s.deviceId })).resolves.toMatchObject({ accessToken: expect.any(String) });
			}
		} finally {
			spotify.rotate = true;
		}
	});

	it('refreshes once when two devices ask at the same time', async () => {
		const s = await connect(app);
		const phone = await secondDevice(app, s);
		await expireIn(app, s.userId, 0);
		const refreshes = spotify.calls.refresh;
		const [a, b] = await Promise.all([s.api.spotify.token.mutate({ deviceId: s.deviceId }), phone.api.spotify.token.mutate({ deviceId: phone.deviceId })]);
		expect(a.accessToken).toBe(b.accessToken);
		expect(spotify.calls.refresh).toBe(refreshes + 1);
	});

	// PGlite runs one transaction at a time, so the race above never overlaps
	// two transactions there. This one stages it: another refresher commits
	// its token in the moment between this call's unlocked read and its lock,
	// and the call must take that token rather than refresh again.
	it('takes the token a concurrent refresher stored while it waited for the lock', async () => {
		const s = await connect(app);
		await expireIn(app, s.userId, 0);
		const crypto = app.deps.spotify!.crypto;
		const realDb = app.deps.db;
		let fired = false;
		const intercept = (tx: Queryable): Queryable => ({
			exec: (t) => tx.exec(t),
			async query(text, params) {
				const rows = await tx.query(text, params);
				if (!fired && text.includes(`'spotify_grant:'`)) {
					fired = true;
					await tx.query(
						`update curator.spotify_grant set access_ct = decode($1, 'base64'), access_expires_at = now() + interval '1 hour' where user_id = (select auth.uid())`,
						[crypto.seal(s.userId, 'access', 'fake-at-from-the-other-refresher').toString('base64')],
					);
				}
				return rows as never;
			},
		});
		app.deps.db = { ...realDb, begin: (fn) => realDb.begin((tx) => fn(intercept(tx))) } satisfies Db;
		const refreshes = spotify.calls.refresh;
		try {
			const r = await s.api.spotify.token.mutate({ deviceId: s.deviceId });
			expect(fired).toBe(true);
			expect(r.accessToken).toBe('fake-at-from-the-other-refresher');
			expect(spotify.calls.refresh).toBe(refreshes);
		} finally {
			app.deps.db = realDb;
		}
	});

	it('flags the grant when Spotify refuses it, and stops asking Spotify until a reconnect', async () => {
		const own = await createTestApp();
		try {
			const s = await connect(own);
			const phone = await secondDevice(own, s);
			await expireIn(own, s.userId, 0);
			own.spotify!.revokeAll();
			expect(await errorReason(s.api.spotify.token.mutate({ deviceId: s.deviceId }))).toEqual({ code: 'FORBIDDEN', reason: 'spotify_reconnect_required', retryAfterSec: null });
			expect(own.spotify!.calls.refresh).toBe(1);
			// Committed, though the call failed: every device sees it.
			expect(await grantRow(own, s.userId)).toMatchObject({ needs_reconnect: true, has_access: false });
			expect((await phone.api.spotify.status.query()).needsReconnect).toBe(true);
			expect(await errorReason(phone.api.spotify.token.mutate({ deviceId: phone.deviceId }))).toMatchObject({ reason: 'spotify_reconnect_required' });
			expect(own.spotify!.calls.refresh).toBe(1);
			expect(await auditKinds(own, s.userId)).toEqual([
				{ kind: 'spotify_connected', detail: expect.any(Object) },
				{ kind: 'spotify_refresh_failed', detail: { reason: 'invalid_grant' } },
			]);
			// Signing in again clears it.
			await connect(own, s);
			expect((await s.api.spotify.status.query()).needsReconnect).toBe(false);
			await expect(phone.api.spotify.token.mutate({ deviceId: phone.deviceId })).resolves.toMatchObject({ accessToken: expect.any(String) });
		} finally {
			await own.db.close();
		}
	});

	it("answers Spotify's rate limit with its Retry-After, and an outage as a 503, leaving the grant as it was", async () => {
		const s = await connect(app);
		await expireIn(app, s.userId, 0);
		spotify.tokenFailures.push({ status: 429, headers: { 'retry-after': '7' } });
		expect(await errorReason(s.api.spotify.token.mutate({ deviceId: s.deviceId }))).toEqual({ code: 'TOO_MANY_REQUESTS', reason: 'rate_limited', retryAfterSec: 7 });
		spotify.tokenFailures.push({ status: 502, body: { error: 'server_error' } });
		expect(await errorReason(s.api.spotify.token.mutate({ deviceId: s.deviceId }))).toEqual({ code: 'SERVICE_UNAVAILABLE', reason: null, retryAfterSec: null });
		// A refusal that is not the user's (this server's client id) is an
		// outage too, never a reconnect for the user.
		spotify.tokenFailures.push({ status: 400, body: { error: 'invalid_client', error_description: 'Invalid client' } });
		expect(await errorReason(s.api.spotify.token.mutate({ deviceId: s.deviceId }))).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
		expect(app.logs).toContainEqual(expect.objectContaining({ msg: 'spotify_unavailable', stage: 'refresh', status: 400, spotifyError: 'invalid_client' }));
		expect(await grantRow(app, s.userId)).toMatchObject({ needs_reconnect: false });
		await expect(s.api.spotify.token.mutate({ deviceId: s.deviceId })).resolves.toMatchObject({ accessToken: expect.any(String) });
	});

	it('refuses a revoked device and an unregistered one', async () => {
		const s = await connect(app);
		expect(await errorReason(s.api.spotify.token.mutate({ deviceId: 'never-registered' }))).toMatchObject({ reason: 'device_not_registered' });
		const phone = await secondDevice(app, s);
		await phone.api.spotify.token.mutate({ deviceId: phone.deviceId });
		await s.api.account.revokeDevice.mutate({ deviceId: phone.deviceId });
		// Named by another session, and from its own session naming anything.
		expect(await errorReason(s.api.spotify.token.mutate({ deviceId: phone.deviceId }))).toMatchObject({ code: 'FORBIDDEN', reason: 'device_revoked' });
		expect(await errorReason(phone.api.spotify.token.mutate({ deviceId: s.deviceId }))).toMatchObject({ code: 'FORBIDDEN', reason: 'device_revoked' });
		expect(await errorReason(phone.api.spotify.status.query())).toMatchObject({ code: 'FORBIDDEN', reason: 'device_revoked' });
		await app.audit.flush();
		const ev = await app.pg.query<{ detail: unknown }>(`select detail from curator.audit_event where user_id = $1 and kind = 'read_from_revoked_device' order by at`, [s.userId]);
		expect(ev.rows).toEqual([
			{ detail: { procedure: 'spotify.token', via: 'device' } },
			{ detail: { procedure: 'spotify.token', via: 'session' } },
			{ detail: { procedure: 'spotify.status', via: 'session' } },
		]);
	});

	it('throttles one device at its own bucket', async () => {
		const limited = await createTestApp({ limits: { spotifyToken: new TokenBucketLimiter(2, 0.001) } });
		try {
			const s = await connect(limited);
			await s.api.spotify.token.mutate({ deviceId: s.deviceId });
			await s.api.spotify.token.mutate({ deviceId: s.deviceId });
			expect(await errorReason(s.api.spotify.token.mutate({ deviceId: s.deviceId }))).toMatchObject({ code: 'TOO_MANY_REQUESTS', reason: 'rate_limited' });
			const phone = await secondDevice(limited, s);
			await expect(phone.api.spotify.token.mutate({ deviceId: phone.deviceId })).resolves.toBeDefined();
		} finally {
			await limited.db.close();
		}
	});
});

describe('spotify.adopt', () => {
	it("proves the device's grant with a refresh and keeps the rotated token", async () => {
		const s = await app.signIn();
		const deviceToken = spotify.deviceGrant();
		const st = await s.api.spotify.adopt.mutate({ deviceId: s.deviceId, refreshToken: deviceToken });
		expect(st).toMatchObject({ connected: true, needsReconnect: false, profile: { id: 'fake-spotify-user' }, scopes: [...SPOTIFY_GATEWAY_SCOPES] });
		// Rotated on the proving refresh: the device's copy is dead, and the
		// gateway still refreshes, so it kept the new one.
		expect(spotify.isLive(deviceToken)).toBe(false);
		await expireIn(app, s.userId, 0);
		await expect(s.api.spotify.token.mutate({ deviceId: s.deviceId })).resolves.toMatchObject({ accessToken: expect.any(String) });
		expect(await auditKinds(app, s.userId)).toEqual([{ kind: 'spotify_adopted', detail: { scopes: SPOTIFY_GATEWAY_SCOPES.length, replaced: false, rotated: true } }]);
	});

	it('keeps the given token when Spotify does not rotate it', async () => {
		const s = await app.signIn();
		const deviceToken = spotify.deviceGrant();
		spotify.rotate = false;
		try {
			await s.api.spotify.adopt.mutate({ deviceId: s.deviceId, refreshToken: deviceToken });
			expect(spotify.isLive(deviceToken)).toBe(true);
			await expireIn(app, s.userId, 0);
			await expect(s.api.spotify.token.mutate({ deviceId: s.deviceId })).resolves.toMatchObject({ accessToken: expect.any(String) });
		} finally {
			spotify.rotate = true;
		}
	});

	it('refuses a dead token and stores nothing', async () => {
		const s = await app.signIn();
		expect(await errorReason(s.api.spotify.adopt.mutate({ deviceId: s.deviceId, refreshToken: 'fake-rt-long-gone' }))).toMatchObject({ code: 'FORBIDDEN', reason: 'spotify_reconnect_required' });
		expect((await s.api.spotify.status.query()).connected).toBe(false);
		expect(await auditKinds(app, s.userId)).toEqual([{ kind: 'spotify_refresh_failed', detail: { reason: 'invalid_grant' } }]);
	});
});

describe('spotify.disconnect', () => {
	it('deletes the grant', async () => {
		const s = await connect(app);
		await expect(s.api.spotify.disconnect.mutate({ deviceId: s.deviceId })).resolves.toEqual({ connected: false, profile: null, scopes: [], connectedAt: null, needsReconnect: false });
		expect(await grantRow(app, s.userId)).toBeUndefined();
		expect(await errorReason(s.api.spotify.token.mutate({ deviceId: s.deviceId }))).toMatchObject({ reason: 'spotify_not_connected' });
		// Again: nothing to delete, no second event.
		await s.api.spotify.disconnect.mutate({ deviceId: s.deviceId });
		expect((await auditKinds(app, s.userId)).map((e) => e.kind)).toEqual(['spotify_connected', 'spotify_disconnected']);
	});
});

describe('isolation', () => {
	it("never lets one account read, change or delete another's grant", async () => {
		const a = await connect(app);
		const b = await app.signIn();
		expect(await errorReason(b.api.spotify.token.mutate({ deviceId: b.deviceId }))).toMatchObject({ reason: 'spotify_not_connected' });
		await asUser(app.pg, b.userId, async (tx) => {
			expect((await tx.query(`select * from curator.spotify_grant`)).rows).toEqual([]);
			expect((await tx.query(`update curator.spotify_grant set needs_reconnect = true where user_id = $1`, [a.userId])).affectedRows).toBe(0);
			expect((await tx.query(`delete from curator.spotify_grant where user_id = $1`, [a.userId])).affectedRows).toBe(0);
		});
		await expect(
			asUser(app.pg, b.userId, (tx) =>
				tx.query(`insert into curator.spotify_grant (user_id, refresh_ct, scopes, profile, key_id) values ($1, decode(repeat('00', 40), 'hex'), '{}', '{}', 'k')`, [a.userId]),
			),
		).rejects.toThrow(/row-level security/);
		// The owner of a row is fixed: no update grant on user_id.
		await expect(asUser(app.pg, a.userId, (tx) => tx.query(`update curator.spotify_grant set user_id = $1`, [b.userId]))).rejects.toThrow(/permission denied/);
		expect(await grantRow(app, a.userId)).toMatchObject({ needs_reconnect: false });
	});

	it("cannot open another account's ciphertext, or the access column as the refresh one", async () => {
		const a = await connect(app);
		const b = await connect(app);
		// The owner copies A's sealed refresh token into B's row: authenticated
		// encryption binds it to A, so B's next refresh cannot open it.
		await app.pg.query(`update curator.spotify_grant set refresh_ct = (select refresh_ct from curator.spotify_grant where user_id = $1) where user_id = $2`, [a.userId, b.userId]);
		await expireIn(app, b.userId, 0);
		expect(await errorReason(b.api.spotify.token.mutate({ deviceId: b.deviceId }))).toMatchObject({ reason: 'spotify_reconnect_required' });
		expect(await auditKinds(app, b.userId)).toContainEqual({ kind: 'spotify_refresh_failed', detail: { reason: 'undecryptable' } });
		// A's own column swapped into its other column fails the same way.
		await app.pg.query(`update curator.spotify_grant set refresh_ct = access_ct where user_id = $1`, [a.userId]);
		await expireIn(app, a.userId, 0);
		expect(await errorReason(a.api.spotify.token.mutate({ deviceId: a.deviceId }))).toMatchObject({ reason: 'spotify_reconnect_required' });
	});
});

describe('key rotation', () => {
	it('opens rows sealed under the previous key and moves them to the current one on refresh', async () => {
		const keyA = randomTokenKey();
		const keyB = randomTokenKey();
		const rot = await createTestApp({ spotify: { keys: { current: keyA, previous: null } } });
		try {
			const s = await connect(rot);
			const before = await s.api.spotify.token.mutate({ deviceId: s.deviceId });
			expect(await grantRow(rot, s.userId)).toMatchObject({ key_id: keyA.id });
			// The release after `pnpm cloud:set-token-key --rotate`.
			rot.deps.spotify = { ...rot.deps.spotify!, crypto: new TokenCrypto({ current: keyB, previous: keyA }) };
			await expect(s.api.spotify.token.mutate({ deviceId: s.deviceId })).resolves.toEqual(before);
			await expireIn(rot, s.userId, 0);
			await s.api.spotify.token.mutate({ deviceId: s.deviceId });
			expect(await grantRow(rot, s.userId)).toMatchObject({ key_id: keyB.id });
			// Once moved, the previous key is no longer needed.
			rot.deps.spotify = { ...rot.deps.spotify, crypto: new TokenCrypto({ current: keyB, previous: null }) };
			await expect(s.api.spotify.token.mutate({ deviceId: s.deviceId })).resolves.toMatchObject({ accessToken: expect.any(String) });
		} finally {
			await rot.db.close();
		}
	});

	it('flags a grant no key on the server opens (rotated twice while idle) for reconnect', async () => {
		const keyA = randomTokenKey();
		const rot = await createTestApp({ spotify: { keys: { current: keyA, previous: null } } });
		try {
			const s = await connect(rot);
			rot.deps.spotify = { ...rot.deps.spotify!, crypto: new TokenCrypto({ current: randomTokenKey(), previous: randomTokenKey() }) };
			expect(await errorReason(s.api.spotify.token.mutate({ deviceId: s.deviceId }))).toMatchObject({ reason: 'spotify_reconnect_required' });
			expect(await grantRow(rot, s.userId)).toMatchObject({ needs_reconnect: true });
			expect(rot.logs).toContainEqual(expect.objectContaining({ msg: 'spotify_grant_unopenable', keyId: keyA.id }));
			// Reconnecting seals under the current key.
			await connect(rot, s);
			await expect(s.api.spotify.token.mutate({ deviceId: s.deviceId })).resolves.toMatchObject({ accessToken: expect.any(String) });
		} finally {
			await rot.db.close();
		}
	});
});

describe('gateway off', () => {
	it('drops the feature and answers every procedure spotify_not_connected', async () => {
		const off = await createTestApp({ spotify: null });
		try {
			const h = await off.client().health.query();
			expect(h.features).toEqual(SYNC_FEATURES.filter((f) => f !== 'spotify_gateway'));
			const s = await off.signIn();
			expect((await s.api.sync.push.mutate({ deviceId: s.deviceId, ops: [] })).features).not.toContain('spotify_gateway');
			const refused = { code: 'FORBIDDEN', reason: 'spotify_not_connected', retryAfterSec: null };
			expect(await errorReason(s.api.spotify.token.mutate({ deviceId: s.deviceId }))).toEqual(refused);
			expect(await errorReason(s.api.spotify.status.query())).toEqual(refused);
			expect(await errorReason(s.api.spotify.connect.mutate({ deviceId: s.deviceId, code: 'c', codeVerifier: VERIFIER, redirectUri: REDIRECT }))).toEqual(refused);
			expect(await errorReason(s.api.spotify.adopt.mutate({ deviceId: s.deviceId, refreshToken: 'r' }))).toEqual(refused);
			expect(await errorReason(s.api.spotify.disconnect.mutate({ deviceId: s.deviceId }))).toEqual(refused);
			expect(off.logs).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'spotify_gateway_disabled', procedure: 'spotify.token' }));
		} finally {
			await off.db.close();
		}
	});
});
