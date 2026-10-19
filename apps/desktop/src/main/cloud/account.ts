// Curator account session (planning/tech/cloud.md "Authentication"): the
// Supabase Auth client lives in the MAIN process only. The renderer never
// sees a token; it asks for status over IPC and gets an email back.
//
// Custody follows backup/google-auth.ts: the persisted session (access +
// refresh token, as Supabase's storage adapter writes it) is safeStorage-
// encrypted in userData/cloud-auth.json — never in curator.db, which is
// backed up and restored and must not carry a usable credential. Supabase
// refreshes the access token on its own timer (autoRefreshToken; in Node it
// always runs) and writes the rotated session back through the adapter.
//
// Sign-in: email + password, or an emailed one-time code / magic link
// (signInWithOtp + verifyOtp type 'email'). No OAuth providers yet.
//
// Wake-ups for the sync client: the private Realtime channel `user:<uid>`
// (the server's push trigger broadcasts `wake` there; the channel policy on
// realtime.messages admits only the owner, hence `private: true` and the
// setAuth before subscribing), window focus, network regain, and sign-in.
//
// Logging (area `cloud-account`): sign-in outcomes with the method and
// Supabase's error code, sign-out, refresh failures, and the Realtime
// channel's lifecycle. A user id is fine to log; the email, the password,
// the one-time code and any token never are.

import { app, net, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type AuthError, type RealtimeChannel, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { CloudSession, WakeReason } from '@curator/core';
import { mainLog } from '../log.js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../cloud-config.js';

const alog = mainLog.for('cloud-account');

// How often to probe for a regained network. Electron's main process has no
// online/offline event; net.isOnline() is a cheap local check.
const NETWORK_POLL_MS = 10_000;

type SignInMethod = 'password' | 'otp_request' | 'otp_verify';

// Supabase's machine-readable code (`invalid_credentials`, `otp_expired`,
// `over_request_rate_limit`) and status, never its message, which can echo
// the address that was typed.
function authFailure(error: AuthError): { reason: string; status: number | null } {
	const code = (error as { code?: unknown }).code;
	return { reason: typeof code === 'string' && code ? code : error.name, status: error.status ?? null };
}

// The refresh call autoRefreshToken makes on its own timer. supabase-js
// emits no event when it fails (only SIGNED_OUT once the refresh token is
// refused for good), so the fetch it uses is watched for this one path.
function isRefreshCall(input: string | URL | Request): boolean {
	try {
		const u = new URL(input instanceof Request ? input.url : String(input));
		return u.pathname.endsWith('/auth/v1/token') && u.searchParams.get('grant_type') === 'refresh_token';
	} catch {
		return false;
	}
}

async function observedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const refresh = isRefreshCall(input);
	let res: Response;
	try {
		res = await net.fetch(input instanceof Request ? input : String(input), init);
	} catch (err) {
		if (refresh) {
			const m = err instanceof Error ? /\bnet::ERR_[A-Z_]+\b/.exec(err.message) : null;
			alog.warn('token refresh failed', { reason: 'network', net: m ? m[0] : null });
		}
		throw err;
	}
	if (refresh && !res.ok) {
		// The error body is `{ code | error_code, msg }`; only the code is read.
		let reason: string | null = null;
		try {
			const body = (await res.clone().json()) as { code?: unknown; error_code?: unknown; error?: unknown };
			const c = body.error_code ?? body.code ?? body.error;
			reason = typeof c === 'string' && /^[a-z_]{1,64}$/.test(c) ? c : null;
		} catch { /* not JSON */ }
		alog.warn('token refresh failed', { status: res.status, reason });
	}
	return res;
}

export type AccountState = {
	signedIn: boolean;
	email: string | null;
	userId: string | null;
	// False when OS credential encryption is unavailable: sign-in still works
	// for the session but cannot be remembered across launches.
	persistent: boolean;
};

// Supabase's storage adapter over one safeStorage-encrypted JSON file. Sync
// reads and writes: the file is tiny (one session) and Supabase calls these
// a handful of times an hour.
class EncryptedSessionStore {
	private cache: Record<string, string> | null = null;
	constructor(private readonly path: string) {}

	private load(): Record<string, string> {
		if (this.cache) return this.cache;
		this.cache = {};
		if (!existsSync(this.path)) return this.cache;
		try {
			const enc = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>;
			for (const [k, v] of Object.entries(enc)) {
				try {
					this.cache[k] = safeStorage.decryptString(Buffer.from(v, 'base64'));
				} catch {
					// Another OS account / machine: inert here by design.
					alog.warn('stored cloud session failed to decrypt — sign in again', { key: k });
				}
			}
		} catch (err) {
			alog.warn('unreadable cloud-auth.json — treating as signed out', undefined, err);
		}
		return this.cache;
	}

	private save(): void {
		if (!safeStorage.isEncryptionAvailable()) return; // memory only
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(this.load())) out[k] = safeStorage.encryptString(v).toString('base64');
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, JSON.stringify(out), 'utf8');
		renameSync(tmp, this.path);
	}

	getItem = (key: string): string | null => this.load()[key] ?? null;
	setItem = (key: string, value: string): void => { this.load()[key] = value; this.save(); };
	removeItem = (key: string): void => { delete this.load()[key]; this.save(); };
}

export class CloudAccount {
	private readonly supabase: SupabaseClient;
	private session: Session | null = null;
	private channel: RealtimeChannel | null = null;
	private channelUser: string | null = null;
	private readonly changeListeners = new Set<(s: AccountState) => void>();
	private readonly wakeListeners = new Set<(reason: WakeReason) => void>();
	private ready: Promise<void>;
	private signingOut = false;

	constructor() {
		this.supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
			auth: {
				storage: new EncryptedSessionStore(join(app.getPath('userData'), 'cloud-auth.json')),
				persistSession: true,
				autoRefreshToken: true,
				detectSessionInUrl: false,
			},
			// Chromium's network stack: system proxy and certificate store, the
			// same reason the Beatport client uses it.
			global: { fetch: observedFetch },
		});
		this.supabase.auth.onAuthStateChange((event, session) => {
			const before = this.session?.user.id ?? null;
			this.session = session;
			if (event === 'TOKEN_REFRESHED') alog.debug('token refreshed', { userId: session?.user.id ?? null });
			// Ours are logged in signOut(); this one is Supabase ending the
			// session (refresh token refused or revoked elsewhere).
			if (event === 'SIGNED_OUT' && before && !this.signingOut) alog.warn('session ended by the auth server', { userId: before });
			if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION') void this.syncRealtime();
			if (event === 'SIGNED_OUT') void this.dropRealtime();
			if ((session?.user.id ?? null) !== before) {
				this.emitChange();
				if (session) this.wake('session');
			}
		});
		this.ready = this.supabase.auth.getSession().then(({ data }) => {
			this.session = data.session;
			void this.syncRealtime();
		}, (err: unknown) => { alog.warn('restoring the cloud session failed', undefined, err); });
	}

	whenReady(): Promise<void> { return this.ready; }

	state(): AccountState {
		const u = this.session?.user;
		return { signedIn: !!u, email: u?.email ?? null, userId: u?.id ?? null, persistent: safeStorage.isEncryptionAvailable() };
	}

	// What the sync client reads on every cycle.
	cloudSession(): CloudSession | null {
		const u = this.session?.user;
		return u ? { userId: u.id, email: u.email ?? null } : null;
	}

	// A valid access token (Supabase refreshes it when due), or null.
	async accessToken(): Promise<string | null> {
		const { data } = await this.supabase.auth.getSession();
		return data.session?.access_token ?? null;
	}

	async signInWithPassword(email: string, password: string): Promise<AccountState> {
		const { data, error } = await this.supabase.auth.signInWithPassword({ email: email.trim(), password });
		if (error) {
			alog.warn('sign-in failed', { method: 'password' satisfies SignInMethod, ...authFailure(error) });
			throw new Error(friendlyAuthError(error.message));
		}
		alog.info('signed in', { method: 'password' satisfies SignInMethod, userId: data.user?.id ?? null });
		return this.state();
	}

	// Sends the one-time code (and magic link) to `email`. New addresses get
	// an account — the project requires email confirmation, which the code
	// itself is.
	async requestOtp(email: string): Promise<{ sent: true }> {
		const { error } = await this.supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } });
		if (error) {
			alog.warn('sign-in failed', { method: 'otp_request' satisfies SignInMethod, ...authFailure(error) });
			throw new Error(friendlyAuthError(error.message));
		}
		alog.info('sign-in code sent', { method: 'otp_request' satisfies SignInMethod });
		return { sent: true };
	}

	async verifyOtp(email: string, code: string): Promise<AccountState> {
		const { data, error } = await this.supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
		if (error) {
			alog.warn('sign-in failed', { method: 'otp_verify' satisfies SignInMethod, ...authFailure(error) });
			throw new Error(friendlyAuthError(error.message));
		}
		alog.info('signed in', { method: 'otp_verify' satisfies SignInMethod, userId: data.user?.id ?? null });
		return this.state();
	}

	// This install only: 'local' scope keeps the user's other devices signed
	// in (the default 'global' would sign every device out).
	async signOut(): Promise<AccountState> {
		const userId = this.session?.user.id ?? null;
		await this.dropRealtime();
		this.signingOut = true;
		try {
			const { error } = await this.supabase.auth.signOut({ scope: 'local' });
			if (error) alog.warn('sign-out reported an error (local session cleared anyway)', authFailure(error));
		} finally {
			this.signingOut = false;
		}
		alog.info('signed out', { userId });
		this.session = null;
		this.emitChange();
		return this.state();
	}

	onChange(cb: (s: AccountState) => void): () => void {
		this.changeListeners.add(cb);
		return () => { this.changeListeners.delete(cb); };
	}

	// The sync client's wake source (CoreServiceOptions.cloud.subscribeWakeups).
	subscribeWakeups(onWake: (reason?: WakeReason) => void): () => void {
		this.wakeListeners.add(onWake);
		const onFocus = (): void => this.wake('focus');
		app.on('browser-window-focus', onFocus);
		let online = net.isOnline();
		const poll = setInterval(() => {
			const now = net.isOnline();
			if (now && !online) this.wake('network');
			online = now;
		}, NETWORK_POLL_MS);
		poll.unref?.();
		return () => {
			this.wakeListeners.delete(onWake);
			app.off('browser-window-focus', onFocus);
			clearInterval(poll);
		};
	}

	async close(): Promise<void> {
		await this.dropRealtime();
		await this.supabase.auth.stopAutoRefresh().catch(() => { /* best-effort */ });
	}

	private wake(reason: WakeReason): void {
		for (const cb of this.wakeListeners) {
			try { cb(reason); } catch (err) { alog.warn('wake listener threw', undefined, err); }
		}
	}

	private emitChange(): void {
		const s = this.state();
		for (const cb of this.changeListeners) {
			try { cb(s); } catch (err) { alog.warn('account listener threw', undefined, err); }
		}
	}

	// (Re)join `user:<uid>` with the current token. Called on every token
	// refresh so the socket's auth never lapses.
	private async syncRealtime(): Promise<void> {
		const s = this.session;
		if (!s) return;
		try {
			await this.supabase.realtime.setAuth(s.access_token);
			if (this.channel && this.channelUser === s.user.id) return;
			await this.dropRealtime();
			this.channelUser = s.user.id;
			this.channel = this.supabase
				.channel(`user:${s.user.id}`, { config: { private: true } })
				.on('broadcast', { event: 'wake' }, () => this.wake('realtime'))
				.subscribe((status, err) => {
					const userId = s.user.id;
					if (status === 'SUBSCRIBED') alog.info('realtime wake channel joined', { userId });
					else if (status === 'CLOSED') alog.info('realtime wake channel closed', { userId });
					else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') alog.warn('realtime wake channel unavailable — falling back to focus/60 s pulls', { status, userId }, err);
				});
		} catch (err) {
			alog.warn('realtime setup failed — falling back to focus/60 s pulls', undefined, err);
		}
	}

	private async dropRealtime(): Promise<void> {
		const ch = this.channel;
		const userId = this.channelUser;
		this.channel = null;
		this.channelUser = null;
		if (ch) {
			alog.debug('leaving realtime wake channel', { userId });
			await this.supabase.removeChannel(ch).catch(() => { /* already closed */ });
		}
	}
}

// Supabase's messages are developer-facing; the panel shows these.
function friendlyAuthError(message: string): string {
	const m = message.toLowerCase();
	if (m.includes('invalid login credentials')) return 'Wrong email or password.';
	if (m.includes('email not confirmed')) return 'Confirm your email first — or sign in with a code instead.';
	if (m.includes('token has expired') || (m.includes('otp') && m.includes('invalid'))) return 'That code is wrong or has expired. Request a new one.';
	if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts — wait a minute and try again.';
	return message;
}
