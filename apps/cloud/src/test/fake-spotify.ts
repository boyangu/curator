// A fake of the two Spotify hosts the gateway talks to (accounts.spotify.com
// token endpoint, api.spotify.com /v1/me), as an injected `fetch`. No test
// ever reaches Spotify: the gateway's fetch is this object's, and anything
// else it is asked for answers 404.
//
// It keeps the rules that matter to the gateway: a code is single-use and
// bound to its verifier and redirect URI; a refresh token is live until it is
// rotated or revoked; access tokens are only good on /me while issued.

import { randomBytes, randomUUID } from 'node:crypto';
import { SPOTIFY_GATEWAY_SCOPES } from '@curator/protocol';
import { SPOTIFY_ME_URL, SPOTIFY_TOKEN_URL } from '../spotify/accounts.js';
import { parseTokenKey, type TokenKey } from '../spotify/crypto.js';

export const FAKE_SPOTIFY_CLIENT_ID = '0123456789abcdef0123456789abcdef';

// A fresh 32-byte key, as `pnpm cloud:set-token-key` makes one.
export function randomTokenKey(): TokenKey {
	return parseTokenKey('test key', randomBytes(32).toString('base64'));
}

type Canned = { status: number; body?: unknown; headers?: Record<string, string> };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export class FakeSpotify {
	readonly clientId = FAKE_SPOTIFY_CLIENT_ID;
	readonly calls = { exchange: 0, refresh: 0, profile: 0 };
	// Every token handed out, so a test can look for it where it must not be.
	readonly issued: string[] = [];
	// Refreshes rotate the refresh token, as Spotify may.
	rotate = true;
	expiresInSec = 3600;
	scope: string | null = SPOTIFY_GATEWAY_SCOPES.join(' ');
	profile: { id: string; display_name: string | null; images: { url: string }[] } = { id: 'fake-spotify-user', display_name: 'DJ Fake', images: [{ url: 'https://i.scdn.co/image/fake' }] };
	// Answers that replace the next token-endpoint responses, in order.
	readonly tokenFailures: Canned[] = [];
	// Awaited before a refresh answers, so a test can hold one mid-flight.
	beforeRefresh: (() => Promise<void>) | null = null;

	private readonly codes = new Map<string, { verifier: string; redirectUri: string }>();
	private readonly refreshTokens = new Set<string>();
	private readonly accessTokens = new Set<string>();

	// What Spotify's /authorize hands the device after the user consents.
	authorize(verifier: string, redirectUri: string): string {
		const code = `fake-code-${randomUUID()}`;
		this.codes.set(code, { verifier, redirectUri });
		return code;
	}

	// A refresh token a device already holds (a desktop from before the gateway).
	deviceGrant(): string {
		return this.mint('rt', this.refreshTokens);
	}

	// The user removed the app in their Spotify account.
	revokeAll(): void {
		this.refreshTokens.clear();
		this.accessTokens.clear();
	}

	isLive(refreshToken: string): boolean {
		return this.refreshTokens.has(refreshToken);
	}

	readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
		if (url === SPOTIFY_TOKEN_URL && init.method === 'POST') return this.token(new URLSearchParams(String(init.body)));
		if (url === SPOTIFY_ME_URL) {
			this.calls.profile++;
			const auth = new Headers(init.headers).get('authorization') ?? '';
			if (!this.accessTokens.has(auth.replace(/^Bearer /, ''))) return json(401, { error: { status: 401, message: 'Invalid access token' } });
			return json(200, { ...this.profile, email: 'never-stored@example.com' });
		}
		return json(404, { error: { status: 404, message: 'not here' } });
	};

	private mint(kind: 'rt' | 'at', into: Set<string>): string {
		const t = `fake-${kind}-${randomUUID()}`;
		into.add(t);
		this.issued.push(t);
		return t;
	}

	private grant(refreshToken: string | null): Response {
		return json(200, {
			access_token: this.mint('at', this.accessTokens),
			token_type: 'Bearer',
			expires_in: this.expiresInSec,
			...(refreshToken ? { refresh_token: refreshToken } : {}),
			...(this.scope !== null ? { scope: this.scope } : {}),
		});
	}

	private async token(form: URLSearchParams): Promise<Response> {
		const grantType = form.get('grant_type');
		if (grantType === 'authorization_code') this.calls.exchange++;
		if (grantType === 'refresh_token') this.calls.refresh++;
		const canned = this.tokenFailures.shift();
		if (canned) return json(canned.status, canned.body ?? {}, canned.headers);
		if (form.get('client_id') !== this.clientId) return json(400, { error: 'invalid_client', error_description: 'Invalid client' });
		if (form.has('client_secret')) return json(400, { error: 'invalid_request', error_description: 'PKCE clients send no secret' });
		if (grantType === 'authorization_code') {
			const code = form.get('code') ?? '';
			const c = this.codes.get(code);
			this.codes.delete(code);
			if (!c || c.verifier !== form.get('code_verifier') || c.redirectUri !== form.get('redirect_uri')) {
				return json(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
			}
			return this.grant(this.mint('rt', this.refreshTokens));
		}
		if (grantType === 'refresh_token') {
			await this.beforeRefresh?.();
			const rt = form.get('refresh_token') ?? '';
			if (!this.refreshTokens.has(rt)) return json(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
			if (!this.rotate) return this.grant(null);
			this.refreshTokens.delete(rt);
			return this.grant(this.mint('rt', this.refreshTokens));
		}
		return json(400, { error: 'unsupported_grant_type' });
	}
}
