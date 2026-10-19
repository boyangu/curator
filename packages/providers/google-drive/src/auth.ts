// Google OAuth 2.0 (authorization code + PKCE) for a Desktop-app client. The
// browser flow and the loopback listener live in the desktop main process;
// this module only knows how to build the authorize URL and talk to the
// token endpoint.

import { GoogleAuthError } from './errors.js';

export interface GoogleAuthConfig {
	clientId: string;
	// Google issues one for Desktop clients but documents it as not actually
	// secret (it ships inside the app); the token endpoint still demands it.
	clientSecret: string;
	redirectUri: string;
	scopes: string;
	authorizeUrl: string;
	tokenUrl: string;
}

export interface GoogleCodeTokens {
	accessToken: string;
	// Null when Google didn't issue one — happens when `prompt=consent` was
	// not honored (the user had already granted the app). The caller tells the
	// user to revoke the app at myaccount.google.com/permissions and retry.
	refreshToken: string | null;
	expiresAt: number;
	scope: string;
}

export interface GoogleRefreshedTokens {
	accessToken: string;
	expiresAt: number;
	// Google normally keeps the refresh token stable; forwarded if rotated.
	refreshToken?: string;
}

export function buildGoogleAuthorizeUrl(cfg: GoogleAuthConfig, codeChallenge: string, state: string): string {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: cfg.clientId,
		redirect_uri: cfg.redirectUri,
		scope: cfg.scopes,
		state,
		code_challenge_method: 'S256',
		code_challenge: codeChallenge,
		// offline + consent: without both, a re-authorization returns only an
		// access token and the backup scheduler would be dead within the hour.
		access_type: 'offline',
		prompt: 'consent',
		include_granted_scopes: 'true',
	});
	return `${cfg.authorizeUrl}?${params}`;
}

interface TokenResponse {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
	scope?: string;
	token_type?: string;
}

async function tokenRequest(cfg: GoogleAuthConfig, form: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
	const res = await fetchImpl(cfg.tokenUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(form),
	});
	const text = await res.text().catch(() => '');
	let json: { error?: string; error_description?: string } & Partial<TokenResponse> = {};
	try {
		json = JSON.parse(text) as typeof json;
	} catch {
		// Non-JSON body (proxy error page); the status + raw text carry it.
	}
	if (!res.ok) {
		const code = typeof json.error === 'string' ? json.error : `http_${res.status}`;
		throw new GoogleAuthError(code, `Google token endpoint: ${code} — ${json.error_description ?? text.slice(0, 300)}`, res.status);
	}
	if (typeof json.access_token !== 'string' || typeof json.expires_in !== 'number') {
		throw new GoogleAuthError('malformed_response', `Google token endpoint returned no access token: ${text.slice(0, 300)}`, res.status);
	}
	return json as TokenResponse;
}

export async function exchangeGoogleCode(cfg: GoogleAuthConfig, code: string, codeVerifier: string, fetchImpl: typeof fetch = fetch): Promise<GoogleCodeTokens> {
	const json = await tokenRequest(cfg, {
		grant_type: 'authorization_code',
		code,
		code_verifier: codeVerifier,
		client_id: cfg.clientId,
		client_secret: cfg.clientSecret,
		redirect_uri: cfg.redirectUri,
	}, fetchImpl);
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token ?? null,
		expiresAt: Date.now() + json.expires_in * 1000,
		scope: json.scope ?? '',
	};
}

export async function refreshGoogleToken(cfg: GoogleAuthConfig, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<GoogleRefreshedTokens> {
	const json = await tokenRequest(cfg, {
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: cfg.clientId,
		client_secret: cfg.clientSecret,
	}, fetchImpl);
	return {
		accessToken: json.access_token,
		expiresAt: Date.now() + json.expires_in * 1000,
		...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
	};
}
