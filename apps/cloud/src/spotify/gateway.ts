// The Spotify gateway, stage 1 ('spotify_gateway', packages/protocol/src/
// spotify-gateway.ts; sql/0010_spotify_grant.sql): connect, adopt, status,
// token, disconnect. The account's refresh token lives here, sealed
// (crypto.ts), and never leaves: devices get access tokens only. Nothing here
// writes to Spotify; reads of the user's library and every write stay on the
// devices until the later stages.
//
// One writer at a time per account: every change to the grant (a refresh, a
// connect, an adopt, a disconnect) runs under the per-user advisory lock and
// re-reads the row after taking it. Two devices asking for a token at once
// then refresh once: the second waits on the lock and finds the first one's
// token. Without the lock a refresh of the old grant could also land after a
// connect and overwrite the new account's tokens with the old one's.
//
// The token call is the only one that talks to Spotify while holding the
// lock (the refresh and the write of its result, a rotated refresh token
// included, must be one transaction: a rotated token that is not persisted
// strands the grant). The accounts client's timeout bounds how long that is.

import type { SpotifyAdoptInput, SpotifyConnectInput, SpotifyGrantStatus, SpotifyProfile, SpotifyTokenResult } from '@curator/protocol';
import type { AuditEmit } from '../audit.js';
import { gateDevice, assertSessionNotRevoked, type Caller } from '../account/device-gate.js';
import { num, numOrNull, type Db, type Queryable } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { CloudError } from '../errors.js';
import type { Logger } from '../log.js';
import { exchangeCode, fetchProfile, refreshGrant, SpotifyGrantRefusedError, type SpotifyClient, type SpotifyTokenGrant } from './accounts.js';
import { TokenOpenError, type TokenCrypto } from './crypto.js';

export type SpotifyGateway = SpotifyClient & { crypto: TokenCrypto };

export type GatewayDeps = { db: Db; log: Logger; audit: AuditEmit; gateway: SpotifyGateway };

// A cached access token is handed out while it has more than this left, so a
// device never receives one that dies mid-request; past it the next call
// refreshes. Spotify's tokens live an hour.
export const ACCESS_TOKEN_MIN_LEFT_SEC = 5 * 60;

// Per Spotify request. A refresh holds the account's lock (and a pooled
// connection) while it waits; Spotify answers in well under a second.
export const SPOTIFY_TIMEOUT_MS = 10_000;

const GRANT_LOCK = `select pg_advisory_xact_lock(hashtextextended('spotify_grant:' || (select auth.uid())::text, 0))`;

type GrantRow = {
	refresh_ct: string;
	access_ct: string | null;
	access_expires_ms: unknown;
	// The cached token is good for ACCESS_TOKEN_MIN_LEFT_SEC more, judged by
	// the clock at the statement, not the transaction's start: a call that
	// waited on the lock must not trust a token that aged while it waited.
	access_fresh: boolean;
	scopes: string;
	profile: string;
	connected_ms: unknown;
	needs_reconnect: boolean;
	key_id: string;
};

// Sealed values cross the db seam as base64 text (db.ts: no bytea crosses it).
// Postgres's encode() wraps base64 at 76 characters; Buffer ignores the breaks.
async function readGrant(tx: Queryable): Promise<GrantRow | undefined> {
	const [row] = await tx.query<GrantRow>(
		`select encode(refresh_ct, 'base64') as refresh_ct, encode(access_ct, 'base64') as access_ct,
			floor(extract(epoch from access_expires_at) * 1000)::float8 as access_expires_ms,
			coalesce(access_expires_at > clock_timestamp() + make_interval(secs => ${ACCESS_TOKEN_MIN_LEFT_SEC}), false) as access_fresh,
			array_to_json(scopes)::text as scopes, profile::text as profile,
			floor(extract(epoch from connected_at) * 1000)::float8 as connected_ms,
			needs_reconnect, key_id
		from curator.spotify_grant where user_id = (select auth.uid())`,
	);
	return row;
}

const DISCONNECTED: SpotifyGrantStatus = { connected: false, profile: null, scopes: [], connectedAt: null, needsReconnect: false };

function statusOf(row: GrantRow | undefined): SpotifyGrantStatus {
	if (!row) return DISCONNECTED;
	return {
		connected: true,
		profile: JSON.parse(row.profile) as SpotifyProfile,
		scopes: JSON.parse(row.scopes) as string[],
		connectedAt: num(row.connected_ms),
		needsReconnect: row.needs_reconnect,
	};
}

const b64 = (b: Buffer) => b.toString('base64');

// Replaces the account's grant (connect, adopt): fresh tokens, fresh
// profile, the reconnect flag cleared.
async function storeGrant(tx: Queryable, gw: SpotifyGateway, userId: string, grant: SpotifyTokenGrant & { refreshToken: string }, scopes: string[], profile: SpotifyProfile): Promise<void> {
	await tx.query(
		`insert into curator.spotify_grant (refresh_ct, access_ct, access_expires_at, scopes, profile, key_id)
		values (decode($1, 'base64'), decode($2, 'base64'), clock_timestamp() + make_interval(secs => $3::float8),
			array(select jsonb_array_elements_text($4::text::jsonb)), $5::text::jsonb, $6)
		on conflict (user_id) do update set
			refresh_ct = excluded.refresh_ct, access_ct = excluded.access_ct, access_expires_at = excluded.access_expires_at,
			scopes = excluded.scopes, profile = excluded.profile, key_id = excluded.key_id,
			connected_at = now(), updated_at = now(), needs_reconnect = false`,
		[
			b64(gw.crypto.seal(userId, 'refresh', grant.refreshToken)),
			b64(gw.crypto.seal(userId, 'access', grant.accessToken)),
			String(grant.expiresInSec),
			JSON.stringify(scopes),
			JSON.stringify(profile),
			gw.crypto.keyId,
		],
	);
}

const refusedToCloud = (e: unknown): never => {
	if (e instanceof SpotifyGrantRefusedError) throw new CloudError('FORBIDDEN', 'spotify_reconnect_required');
	throw e;
};

// spotify.connect: the device ran the authorization (PKCE) in its own window;
// the server exchanges the code with the verifier and keeps the grant. A
// refused exchange (an expired or reused code) leaves any existing grant as
// it was.
export async function connect(deps: GatewayDeps, userId: string, caller: Caller, input: SpotifyConnectInput): Promise<SpotifyGrantStatus> {
	const { gateway: gw } = deps;
	const r = await withUserTx(deps.db, userId, async (tx) => {
		await gateDevice(tx, caller, input.deviceId);
		// Spotify first, outside the lock: a slow exchange holds no other caller.
		const grant = await exchangeCode(gw, input).catch(refusedToCloud);
		// A code exchange always returns a refresh token; one that does not is
		// a grant the gateway cannot keep.
		if (!grant.refreshToken) throw new CloudError('FORBIDDEN', 'spotify_reconnect_required');
		const profile = await fetchProfile(gw, grant.accessToken);
		await tx.query(GRANT_LOCK);
		const prior = await readGrant(tx);
		const scopes = grant.scopes ?? [];
		await storeGrant(tx, gw, userId, { ...grant, refreshToken: grant.refreshToken }, scopes, profile);
		return { status: statusOf(await readGrant(tx)), replaced: prior !== undefined };
	});
	// After the commit: an event for a grant that was stored.
	deps.audit('spotify_connected', { scopes: r.status.scopes.length, replaced: r.replaced }, { deviceId: input.deviceId });
	return r.status;
}

// spotify.adopt: a device moves the grant it already holds. A refresh proves
// it, and what is kept is that refresh's result: the rotated refresh token
// when Spotify returned one (the device's copy may be dead already), else the
// one given. The device deletes its own copy once this answers.
export async function adopt(deps: GatewayDeps, userId: string, caller: Caller, input: SpotifyAdoptInput): Promise<SpotifyGrantStatus> {
	const { gateway: gw } = deps;
	const r = await withUserTx(deps.db, userId, async (tx) => {
		await gateDevice(tx, caller, input.deviceId);
		const grant = await refreshGrant(gw, input.refreshToken).catch((e: unknown) => {
			if (e instanceof SpotifyGrantRefusedError) deps.audit('spotify_refresh_failed', { reason: 'invalid_grant' }, { deviceId: input.deviceId });
			return refusedToCloud(e);
		});
		const profile = await fetchProfile(gw, grant.accessToken);
		await tx.query(GRANT_LOCK);
		const prior = await readGrant(tx);
		// A refresh may leave the scope out; the adopted grant then keeps what
		// the account's row said, or none known.
		const scopes = grant.scopes ?? (prior ? (JSON.parse(prior.scopes) as string[]) : []);
		await storeGrant(tx, gw, userId, { ...grant, refreshToken: grant.refreshToken ?? input.refreshToken }, scopes, profile);
		return { status: statusOf(await readGrant(tx)), replaced: prior !== undefined, rotated: grant.refreshToken !== null };
	});
	deps.audit('spotify_adopted', { scopes: r.status.scopes.length, replaced: r.replaced, rotated: r.rotated }, { deviceId: input.deviceId });
	return r.status;
}

// spotify.status: names no device (the protocol's `status()` takes no input),
// so it is judged by the session alone, like account.devices.
export async function status(deps: Pick<GatewayDeps, 'db'>, userId: string, caller: Caller): Promise<SpotifyGrantStatus> {
	return withUserTx(deps.db, userId, async (tx) => {
		await assertSessionNotRevoked(tx, caller);
		return statusOf(await readGrant(tx));
	});
}

type VendOutcome = { ok: true; result: SpotifyTokenResult; refreshed: boolean } | { ok: false; reason: 'invalid_grant' | 'undecryptable' };

// Null when there is none, it is about to expire, or it no longer opens (a
// rotated key): each is a refresh.
function cachedToken(gw: SpotifyGateway, userId: string, row: GrantRow): SpotifyTokenResult | null {
	if (!row.access_fresh || row.access_ct === null) return null;
	let accessToken: string;
	try {
		accessToken = gw.crypto.open(userId, 'access', row.key_id, Buffer.from(row.access_ct, 'base64'));
	} catch (e) {
		if (e instanceof TokenOpenError) return null;
		throw e;
	}
	return {
		accessToken,
		expiresAt: numOrNull(row.access_expires_ms)!,
		scopes: JSON.parse(row.scopes) as string[],
		profile: JSON.parse(row.profile) as SpotifyProfile,
	};
}

// spotify.token: the cached access token while it has more than five minutes
// left, else a refresh under the account's lock. A refusal by Spotify is
// written down (needs_reconnect) and committed before the call fails, so
// every device sees it and none asks Spotify again with a dead token.
export async function token(deps: GatewayDeps, userId: string, caller: Caller, deviceId: string): Promise<{ result: SpotifyTokenResult; refreshed: boolean }> {
	const { gateway: gw } = deps;
	const outcome = await withUserTx(deps.db, userId, async (tx): Promise<VendOutcome> => {
		await gateDevice(tx, caller, deviceId);
		const markReconnect = async (reason: 'invalid_grant' | 'undecryptable'): Promise<VendOutcome> => {
			await tx.query(`update curator.spotify_grant set needs_reconnect = true, access_ct = null, access_expires_at = null, updated_at = now() where user_id = (select auth.uid())`);
			return { ok: false, reason };
		};
		const check = (row: GrantRow | undefined): GrantRow => {
			if (!row) throw new CloudError('FORBIDDEN', 'spotify_not_connected');
			if (row.needs_reconnect) throw new CloudError('FORBIDDEN', 'spotify_reconnect_required');
			return row;
		};
		// The common case, no lock: the shared token is still good.
		const first = cachedToken(gw, userId, check(await readGrant(tx)));
		if (first) return { ok: true, result: first, refreshed: false };
		await tx.query(GRANT_LOCK);
		// Whoever held the lock may have refreshed (or a connect replaced the
		// grant, or a refusal flagged it) while this call waited.
		const row = check(await readGrant(tx));
		const again = cachedToken(gw, userId, row);
		if (again) return { ok: true, result: again, refreshed: false };
		let refreshToken: string;
		try {
			refreshToken = gw.crypto.open(userId, 'refresh', row.key_id, Buffer.from(row.refresh_ct, 'base64'));
		} catch (e) {
			if (!(e instanceof TokenOpenError)) throw e;
			deps.log.error('spotify_grant_unopenable', { userId, keyId: row.key_id, current: gw.crypto.keyId });
			return markReconnect('undecryptable');
		}
		let grant: SpotifyTokenGrant;
		try {
			grant = await refreshGrant(gw, refreshToken);
		} catch (e) {
			if (e instanceof SpotifyGrantRefusedError) return markReconnect('invalid_grant');
			// Rate limit, outage: the grant is untouched (rolled back: nothing
			// was written), the caller retries.
			throw e;
		}
		const scopes = grant.scopes ?? (JSON.parse(row.scopes) as string[]);
		// Both columns re-sealed under the current key, so a grant moves off a
		// rotated key on its next refresh.
		const [written] = await tx.query<{ expires_ms: unknown }>(
			`update curator.spotify_grant set
				refresh_ct = decode($1, 'base64'), access_ct = decode($2, 'base64'),
				access_expires_at = clock_timestamp() + make_interval(secs => $3::float8),
				scopes = array(select jsonb_array_elements_text($4::text::jsonb)), key_id = $5, updated_at = now()
			where user_id = (select auth.uid())
			returning floor(extract(epoch from access_expires_at) * 1000)::float8 as expires_ms`,
			[
				b64(gw.crypto.seal(userId, 'refresh', grant.refreshToken ?? refreshToken)),
				b64(gw.crypto.seal(userId, 'access', grant.accessToken)),
				String(grant.expiresInSec),
				JSON.stringify(scopes),
				gw.crypto.keyId,
			],
		);
		return {
			ok: true,
			refreshed: true,
			result: { accessToken: grant.accessToken, expiresAt: num(written!.expires_ms), scopes, profile: JSON.parse(row.profile) as SpotifyProfile },
		};
	});
	if (!outcome.ok) {
		deps.audit('spotify_refresh_failed', { reason: outcome.reason }, { deviceId });
		throw new CloudError('FORBIDDEN', 'spotify_reconnect_required');
	}
	return { result: outcome.result, refreshed: outcome.refreshed };
}

// spotify.disconnect: the grant is deleted here. Spotify has no endpoint to
// revoke a refresh token; the user removes the app's access in their Spotify
// account (spotify.com/account/apps) to end it there too.
export async function disconnect(deps: GatewayDeps, userId: string, caller: Caller, deviceId: string): Promise<SpotifyGrantStatus> {
	const deleted = await withUserTx(deps.db, userId, async (tx) => {
		await gateDevice(tx, caller, deviceId);
		await tx.query(GRANT_LOCK);
		return (await tx.query(`delete from curator.spotify_grant where user_id = (select auth.uid()) returning 1`)).length > 0;
	});
	if (deleted) deps.audit('spotify_disconnected', {}, { deviceId });
	return DISCONNECTED;
}
