// A Curator account's session for a host without supabase-js (the phone):
// Supabase Auth's REST endpoints through the host's one request function.
// Sign-in as on the desktop (apps/desktop main/cloud/account.ts): email +
// password, or a code sent by email. Accounts are made on the desktop, so a
// code is never sent to an address that has none. A forgotten password is a
// code too: signed in with it, the account takes a new one (setPassword).
//
// The account outlives its tokens. A session the server refuses to refresh
// (signed out elsewhere, a reused refresh token) leaves the account with
// `tokens: null`: the library on this device is still this person's, and the
// same person signing in again carries on. Only signOut() ends the account.
// Anything short of a refusal (offline, a 5xx, a 429) keeps the tokens.
//
// Expiry is counted from when the tokens arrived, by this device's clock
// alone; a clock that was changed since shows as a 401, which the transport
// answers with one forced refresh (accessToken({ refresh: true })).
//
// Logged: outcomes with Supabase's machine-readable code and the status.
// Never an email, a password, a one-time code, a token, or a server message
// (which may echo what was typed).

import { log } from '../log.js';
import type { HttpRequest, HttpResponse } from '../sync-log/fetch-transport.js';

const slog = log.for('auth');

export type AuthTokens = { accessToken: string; refreshToken: string; expiresAt: number };
export type AuthAccount = { userId: string; email: string | null; tokens: AuthTokens | null };

// `code`: Supabase's (`invalid_credentials`, `otp_expired`,
// `over_email_send_rate_limit`), or one of this file's: `network`, `server`,
// `other_account`, `bad_answer`.
export class AuthError extends Error {
	override readonly name = 'AuthError';
	constructor(
		readonly code: string,
		readonly status: number | null = null,
	) {
		super(code);
	}
}

// The refusals that end a session for good. A list, not "any 4xx": a wrong
// publishable key is a 401 too, and must not sign anyone out.
const SESSION_OVER = new Set(['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired', 'user_not_found', 'user_banned', 'invalid_grant']);

// Refreshed this long before it expires, so a call never leaves with a token
// that lapses on the way.
const REFRESH_AHEAD_MS = 60_000;

export type GotrueDeps = {
	// The Supabase project's origin, no trailing slash; its publishable key.
	supabaseUrl: string;
	publishableKey: string;
	request(req: HttpRequest): Promise<HttpResponse>;
	// The account kept from the last run, if any.
	initial: AuthAccount | null;
	// Whether this device holds a library of the account's: only then is another
	// account refused. Absent: it does.
	holdsLibrary?(): boolean;
	// After every change, before the call that caused it answers: the host
	// keeps it (a rotated refresh token is single-use, so a lost one is a lost
	// session). null: signed out.
	onChange(account: AuthAccount | null): void;
	now?: () => number;
};

export type Gotrue = {
	account(): AuthAccount | null;
	signInPassword(email: string, password: string): Promise<AuthAccount>;
	requestCode(email: string): Promise<void>;
	verifyCode(email: string, code: string): Promise<AuthAccount>;
	// The signed-in account's new password. Supabase signs the account's other
	// sessions out with it.
	setPassword(password: string): Promise<void>;
	// A token to call with, refreshed when due (or when asked); null without a
	// session. Rejects (AuthError) when one is due and cannot be had now.
	accessToken(opts?: { refresh?: boolean }): Promise<string | null>;
	// Ends this install's session at the server, best effort, and never
	// rejects. endSession keeps the account (this library is still theirs: the
	// way back from a device that was removed); signOut forgets it.
	endSession(): Promise<void>;
	signOut(): Promise<void>;
};

type TokenAnswer = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; user?: { id?: unknown; email?: unknown } };

function parse(body: string): Record<string, unknown> | null {
	try {
		const v: unknown = JSON.parse(body);
		return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

// GoTrue has answered errors as { error_code, msg } and as { error, error_description }.
function errorCode(body: string): string | null {
	const b = parse(body);
	for (const c of [b?.['error_code'], b?.['code'], b?.['error']]) {
		if (typeof c === 'string' && /^[a-z_]{1,64}$/.test(c)) return c;
	}
	return null;
}

export function createGotrue(deps: GotrueDeps): Gotrue {
	const now = deps.now ?? Date.now;
	let account = deps.initial;
	let refreshing: Promise<string> | null = null;

	const send = async (method: 'POST' | 'PUT', path: string, body: unknown, bearer?: string): Promise<HttpResponse> => {
		let res: HttpResponse;
		try {
			res = await deps.request({
				method,
				url: `${deps.supabaseUrl}/auth/v1/${path}`,
				headers: { apikey: deps.publishableKey, 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
				body: JSON.stringify(body),
			});
		} catch {
			throw new AuthError('network');
		}
		if (res.status >= 200 && res.status < 300) return res;
		throw new AuthError(errorCode(res.body) ?? (res.status >= 500 ? 'server' : `http_${res.status}`), res.status);
	};

	const post = (path: string, body: unknown, bearer?: string): Promise<HttpResponse> => send('POST', path, body, bearer);

	const set = (next: AuthAccount | null): void => {
		account = next;
		deps.onChange(next);
	};

	const tokensOf = (res: HttpResponse): { userId: string; email: string | null; tokens: AuthTokens } => {
		const a = parse(res.body) as TokenAnswer | null;
		const userId = a?.user?.id;
		if (typeof a?.access_token !== 'string' || typeof a.refresh_token !== 'string' || typeof a.expires_in !== 'number' || typeof userId !== 'string') throw new AuthError('bad_answer', res.status);
		return {
			userId,
			email: typeof a.user?.email === 'string' ? a.user.email : null,
			tokens: { accessToken: a.access_token, refreshToken: a.refresh_token, expiresAt: now() + a.expires_in * 1000 },
		};
	};

	// The session a sign-in opened, taken on unless it is someone else's: the
	// library on this device belongs to the first account that synced it.
	const adopt = async (method: string, res: HttpResponse): Promise<AuthAccount> => {
		const next = tokensOf(res);
		if (account && account.userId !== next.userId && (deps.holdsLibrary?.() ?? true)) {
			slog.warn('signed in as another account than this library’s', { method });
			await post('logout?scope=local', {}, next.tokens.accessToken).catch(() => {});
			throw new AuthError('other_account');
		}
		set(next);
		slog.info('signed in', { method, userId: next.userId });
		return next;
	};

	const signIn = async (method: string, path: string, body: unknown): Promise<AuthAccount> => {
		let res: HttpResponse;
		try {
			res = await post(path, body);
		} catch (err) {
			if (err instanceof AuthError) slog.warn('sign-in failed', { method, reason: err.code, status: err.status });
			throw err;
		}
		return adopt(method, res);
	};

	const refresh = (): Promise<string> => {
		refreshing ??= (async () => {
			const held = account?.tokens;
			if (!account || !held) throw new AuthError('session_not_found');
			try {
				const next = tokensOf(await post('token?grant_type=refresh_token', { refresh_token: held.refreshToken }));
				// A sign-in or a sign-out landed meanwhile: that one stands.
				if (account?.tokens !== held) return account?.tokens?.accessToken ?? next.tokens.accessToken;
				set({ ...account, email: next.email ?? account.email, tokens: next.tokens });
				slog.debug('token refreshed', {});
				return next.tokens.accessToken;
			} catch (err) {
				if (err instanceof AuthError) {
					slog.warn('token refresh failed', { reason: err.code, status: err.status });
					if (SESSION_OVER.has(err.code) && account?.tokens === held) {
						slog.warn('session ended by the auth server', { userId: account.userId });
						set({ ...account, tokens: null });
					}
				}
				throw err;
			}
		})().finally(() => { refreshing = null; });
		return refreshing;
	};

	const logout = async (): Promise<void> => {
		const t = account?.tokens;
		if (!t) return;
		try {
			await post('logout?scope=local', {}, t.accessToken);
		} catch (err) {
			slog.warn('ending the session at the server failed', { reason: err instanceof AuthError ? err.code : 'unknown' });
		}
	};

	const accessToken = async (opts?: { refresh?: boolean }): Promise<string | null> => {
		const t = account?.tokens;
		if (!t) return null;
		const left = t.expiresAt - now();
		if (!opts?.refresh && left > REFRESH_AHEAD_MS) return t.accessToken;
		try {
			return await refresh();
		} catch (err) {
			// Due soon but not expired, and the refresh only could not be made:
			// the token in hand still works.
			if (!opts?.refresh && left > 0 && account?.tokens === t) return t.accessToken;
			if (!account?.tokens) return null;
			throw err;
		}
	};

	return {
		account: () => account,
		signInPassword: (email, password) => signIn('password', 'token?grant_type=password', { email: email.trim(), password }),
		async requestCode(email) {
			try {
				await post('otp', { email: email.trim(), create_user: false });
				slog.info('sign-in code requested', {});
			} catch (err) {
				if (err instanceof AuthError) slog.warn('sign-in code request failed', { reason: err.code, status: err.status });
				throw err;
			}
		},
		verifyCode: (email, code) => signIn('code', 'verify', { type: 'email', email: email.trim(), token: code.trim() }),
		async setPassword(password) {
			const token = await accessToken();
			if (!token) throw new AuthError('session_not_found');
			try {
				await send('PUT', 'user', { password }, token);
				slog.info('password set', {});
			} catch (err) {
				if (err instanceof AuthError) slog.warn('setting the password failed', { reason: err.code, status: err.status });
				throw err;
			}
		},
		accessToken,
		async endSession() {
			await logout();
			if (account) set({ ...account, tokens: null });
		},
		async signOut() {
			await logout();
			if (account) slog.info('signed out', { userId: account.userId });
			set(null);
		},
	};
}
