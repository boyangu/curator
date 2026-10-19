// Supabase access-token verification. The project signs with asymmetric
// keys, so the API holds no secret at all: it checks the signature against
// the project's published JWKS, then `aud`, `iss` and `exp`, and takes `sub`
// as the user id. The user id is never read from anything the client sends
// besides this token (design: "Authentication").
//
// The key source is injected: production passes `createRemoteJWKSet` (jose
// caches the set and refetches on an unknown `kid`, which is how key
// rotation lands), tests pass a local set built from a generated key pair.

import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type AuthUser = {
	id: string;
	// Supabase's per-sign-in session id: one per device in practice, so it
	// keys the pull rate limit (PullInput carries no device id).
	sessionId: string | null;
};

export type AuthFailure = 'missing_token' | 'token_expired' | 'invalid_token';

export class AuthError extends Error {
	override readonly name = 'AuthError';
	constructor(readonly reason: AuthFailure) {
		super(reason);
	}
}

export type TokenVerifier = { verify(authorization: string | null): Promise<AuthUser> };

// The algorithms Supabase's asymmetric signing keys use. Pinning them is
// what stops an `alg: none` or an HS256 token signed with a public key from
// ever being considered.
const ALGORITHMS = ['ES256', 'RS256'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function jwksUrl(supabaseUrl: string): URL {
	return new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
}

export function remoteKeys(supabaseUrl: string): JWTVerifyGetKey {
	return createRemoteJWKSet(jwksUrl(supabaseUrl));
}

export function createTokenVerifier(opts: { supabaseUrl: string; keys: JWTVerifyGetKey; clockToleranceSec?: number }): TokenVerifier {
	const issuer = `${opts.supabaseUrl}/auth/v1`;
	return {
		async verify(authorization) {
			const m = authorization ? /^Bearer\s+(\S+)$/i.exec(authorization.trim()) : null;
			if (!m) throw new AuthError('missing_token');
			let payload;
			try {
				({ payload } = await jwtVerify(m[1]!, opts.keys, {
					issuer,
					audience: 'authenticated',
					algorithms: ALGORITHMS,
					requiredClaims: ['exp', 'sub'],
					clockTolerance: opts.clockToleranceSec ?? 5,
				}));
			} catch (e) {
				// The client refreshes on `token_expired` and signs in again on
				// anything else; the jose detail stays in the server log only.
				throw new AuthError(e instanceof errors.JWTExpired ? 'token_expired' : 'invalid_token');
			}
			// `auth.uid()` casts `sub` to uuid; anything else would surface as a
			// 500 deep inside a query instead of a 401 here.
			if (typeof payload.sub !== 'string' || !UUID_RE.test(payload.sub)) throw new AuthError('invalid_token');
			const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
			return { id: payload.sub.toLowerCase(), sessionId };
		},
	};
}
