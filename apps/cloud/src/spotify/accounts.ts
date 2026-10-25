// The two Spotify endpoints the gateway needs, and nothing more: the token
// endpoint (authorization_code with PKCE, refresh_token) and /v1/me for the
// profile shown on every device. Self-contained on purpose: @curator/spotify
// is desktop code (the package boundary forbids it here), and two form posts
// do not need a client library.
//
// PKCE only: the app's client id and no client secret, so the server holds
// no Spotify credential of its own beyond the user's grant.
//
// `fetch` is injected: production passes the global, tests a fake Spotify
// (src/test/fake-spotify.ts). Nothing here logs; the caller logs the error's
// fields, which are a stage, a status and Spotify's error code, never a token
// or a response body.

import type { SpotifyProfile } from '@curator/protocol';
import { z } from 'zod';

export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_ME_URL = 'https://api.spotify.com/v1/me';

export type SpotifyFetch = (url: string, init: RequestInit) => Promise<Response>;

export type SpotifyClient = {
	clientId: string;
	fetch: SpotifyFetch;
	// Per request. The token call runs inside the account's lock (gateway.ts),
	// so a hung Spotify must not hold it long.
	timeoutMs: number;
};

export type SpotifyStage = 'exchange' | 'refresh' | 'profile';

// Spotify refused the grant itself (`invalid_grant`: a revoked or unknown
// refresh token, an expired or reused code, a verifier that does not match).
// Only a new sign-in helps.
export class SpotifyGrantRefusedError extends Error {
	override readonly name = 'SpotifyGrantRefusedError';
	constructor(readonly stage: SpotifyStage) {
		super(`spotify refused the grant (${stage})`);
	}
}

export class SpotifyRateLimitedError extends Error {
	override readonly name = 'SpotifyRateLimitedError';
	constructor(
		readonly stage: SpotifyStage,
		readonly retryAfterSec: number,
	) {
		super(`spotify rate limited (${stage})`);
	}
}

// Anything else: Spotify down (5xx), the network, a timeout, an answer that
// does not parse, or a refusal that is not the user's grant (`invalid_client`:
// this server's client id is wrong). Retry later; the grant is untouched.
export class SpotifyUnavailableError extends Error {
	override readonly name = 'SpotifyUnavailableError';
	constructor(
		readonly stage: SpotifyStage,
		readonly status: number | null,
		// Spotify's `error` code when it sent one, cleaned: never its description.
		readonly spotifyError: string | null,
	) {
		super(`spotify unavailable (${stage}${status ? ` ${status}` : ''}${spotifyError ? ` ${spotifyError}` : ''})`);
	}
}

export type SpotifyTokenGrant = {
	accessToken: string;
	expiresInSec: number;
	// Present when Spotify rotated the refresh token (or on a code exchange);
	// the old one may stop working, so the new one must be kept.
	refreshToken: string | null;
	// Space-separated in the response; absent on some refreshes.
	scopes: string[] | null;
};

const ZTokenResponse = z.object({
	access_token: z.string().min(1).max(4096),
	expires_in: z.number().int().positive().max(86_400),
	refresh_token: z.string().min(1).max(4096).optional(),
	scope: z.string().max(4096).optional(),
});

const ZMe = z.object({
	id: z.string().min(1).max(256),
	display_name: z.string().nullable().optional(),
	images: z.array(z.object({ url: z.string() })).nullable().optional(),
});

// Spotify's Retry-After is whole seconds; anything unreadable is a short wait.
function retryAfter(res: Response): number {
	const n = Number(res.headers.get('retry-after'));
	return Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), 3600) : 5;
}

async function errorCode(res: Response): Promise<string | null> {
	try {
		const body = (await res.json()) as { error?: unknown };
		// The token endpoint answers `{ error: 'invalid_grant', error_description }`;
		// the Web API `{ error: { status, message } }`. Only the short code is kept.
		return typeof body.error === 'string' ? body.error.replace(/[^a-z_]/gi, '').slice(0, 64) || null : null;
	} catch {
		return null;
	}
}

async function send(client: SpotifyClient, stage: SpotifyStage, url: string, init: RequestInit): Promise<Response> {
	let res: Response;
	try {
		res = await client.fetch(url, { ...init, signal: AbortSignal.timeout(client.timeoutMs) });
	} catch {
		throw new SpotifyUnavailableError(stage, null, null);
	}
	if (res.ok) return res;
	if (res.status === 429) throw new SpotifyRateLimitedError(stage, retryAfter(res));
	const code = await errorCode(res);
	if (res.status === 400 && code === 'invalid_grant') throw new SpotifyGrantRefusedError(stage);
	throw new SpotifyUnavailableError(stage, res.status, code);
}

async function tokenCall(client: SpotifyClient, stage: 'exchange' | 'refresh', form: Record<string, string>): Promise<SpotifyTokenGrant> {
	const res = await send(client, stage, SPOTIFY_TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ ...form, client_id: client.clientId }).toString(),
	});
	let parsed: z.infer<typeof ZTokenResponse>;
	try {
		parsed = ZTokenResponse.parse(await res.json());
	} catch {
		throw new SpotifyUnavailableError(stage, res.status, 'unreadable_response');
	}
	return {
		accessToken: parsed.access_token,
		expiresInSec: parsed.expires_in,
		refreshToken: parsed.refresh_token ?? null,
		scopes: parsed.scope === undefined ? null : parsed.scope.split(/\s+/).filter(Boolean),
	};
}

export function exchangeCode(client: SpotifyClient, input: { code: string; codeVerifier: string; redirectUri: string }): Promise<SpotifyTokenGrant> {
	return tokenCall(client, 'exchange', {
		grant_type: 'authorization_code',
		code: input.code,
		redirect_uri: input.redirectUri,
		code_verifier: input.codeVerifier,
	});
}

export function refreshGrant(client: SpotifyClient, refreshToken: string): Promise<SpotifyTokenGrant> {
	return tokenCall(client, 'refresh', { grant_type: 'refresh_token', refresh_token: refreshToken });
}

export async function fetchProfile(client: SpotifyClient, accessToken: string): Promise<SpotifyProfile> {
	const res = await send(client, 'profile', SPOTIFY_ME_URL, { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } });
	let me: z.infer<typeof ZMe>;
	try {
		me = ZMe.parse(await res.json());
	} catch {
		throw new SpotifyUnavailableError('profile', res.status, 'unreadable_response');
	}
	const avatar = me.images?.[0]?.url ?? null;
	return {
		id: me.id,
		displayName: me.display_name ? me.display_name.slice(0, 200) : null,
		avatarUrl: avatar && avatar.length <= 1024 && avatar.startsWith('https://') ? avatar : null,
	};
}
