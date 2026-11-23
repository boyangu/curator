// Beatport through FlareSolverr (or Byparr — same /v1 API).
//
// Cloudflare holds a managed challenge in front of beatport.com for weeks at
// a time (2026-07, 2026-11), and nothing in-process gets past it: a warmed
// cf_clearance cookie still 403s from net.fetch, because Cloudflare checks the
// whole client, not the cookie. FlareSolverr runs a real browser that solves
// the challenge and loads the page itself, so we never reuse its cookies from
// a different client — we ask it for each page and take the HTML it rendered.
//
// It's a FetchLike, so the Beatport client's parsing and block detection run
// unchanged: a page the browser couldn't clear comes back as a challenged 403,
// which trips the client's cooldown exactly like a direct block. Only the
// hosts given are routed; everything else (Traxsource, which is not
// challenged) goes straight to the fallback fetch.
//
// When the service isn't reachable a request throws ProviderUnavailableError
// with what failed (refused / timed out / bad reply) plus what the desktop's
// supervisor knows (starting, stopped, Docker down) — never a silent direct
// fetch that would come back challenged and read as "Beatport blocked us".
// The desktop wires it unless CURATOR_DISABLE_FLARESOLVERR=1.

import { ProviderUnavailableError } from '@curator/matcher';
import { log } from '@curator/sync-core/log';

const flog = log.for('flaresolverr');

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FlareSolverrOptions {
	// e.g. http://localhost:8191
	baseUrl: string;
	// For hosts that aren't routed.
	fallback: FetchLike;
	// Hostnames routed through the browser (and their subdomains).
	hosts?: readonly string[];
	// Per page, including a challenge solve.
	maxTimeoutMs?: number;
	// Injected for tests; plain fetch for the localhost API otherwise.
	apiFetch?: FetchLike;
	// The supervisor's account of the service ("starting since 4s", "Docker
	// in WSL not running: …"), appended to the unavailable reason.
	describe?: () => string | null;
	// Told when a request found the service down, so it can (re)start it.
	onDown?: () => void;
	// Settles once a start the supervisor has under way is done (or has taken
	// too long). Awaited before each request: the feed drain's first lookup
	// lands within a second of launch, while the container is still coming up,
	// and a refusal then pauses Beatport for minutes and parks the whole batch.
	ready?: () => Promise<void>;
}

// What went wrong talking to the service, in words: refused, timed out, …
function failure(err: unknown, timeoutMs: number): string {
	if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return `no answer within ${Math.round(timeoutMs / 1000)}s`;
	const cause = err instanceof Error ? (err as Error & { cause?: { code?: string; message?: string } }).cause : undefined;
	// Electron's fetch sets the code but can leave the message empty.
	if (cause?.code === 'ECONNREFUSED') return `connection refused${cause.message ? ` (${cause.message})` : ''} — nothing is listening`;
	if (cause?.code) return `${cause.code}${cause.message ? ` (${cause.message})` : ''}`;
	return err instanceof Error ? err.message : String(err);
}

interface Solution {
	url: string;
	status: number;
	headers?: Record<string, string>;
	response: string;
}

interface V1Reply {
	status: 'ok' | 'error' | 'warning';
	message?: string;
	solution?: Solution;
}

const SESSION = 'curator-beatport';
// The browser stays open across lookups (its clearance with it); a session
// older than this is replaced, so one wedged browser can't stall lookups for good.
const SESSION_TTL_MINUTES = 60;

export function flareSolverrFetch(opts: FlareSolverrOptions): FetchLike {
	const api = `${opts.baseUrl.replace(/\/+$/, '')}/v1`;
	const apiFetch = opts.apiFetch ?? ((u, i) => fetch(u, i));
	const hosts = opts.hosts ?? ['beatport.com'];
	const maxTimeout = opts.maxTimeoutMs ?? 60_000;
	const callTimeout = maxTimeout + 15_000;
	let session: Promise<boolean> | null = null;
	let warnedDown = false;

	const call = async (body: Record<string, unknown>): Promise<V1Reply> => {
		const res = await apiFetch(api, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(callTimeout),
		});
		const text = await res.text();
		try {
			return JSON.parse(text) as V1Reply;
		} catch {
			// FlareSolverr answers errors as JSON too; anything else isn't it.
			throw new Error(`unreadable reply (HTTP ${res.status}: ${text.slice(0, 120)})`);
		}
	};

	// One browser session for every lookup, created on first use. A failure to
	// create one isn't fatal: request.get without a session still works, just
	// with a fresh browser (and challenge) per page.
	const ensureSession = (): Promise<boolean> => {
		session ??= call({ cmd: 'sessions.create', session: SESSION })
			.then((r) => r.status === 'ok' || /already exists/i.test(r.message ?? ''))
			.catch(() => { session = null; return false; });
		return session;
	};

	const routed = (url: string): boolean => {
		try {
			const h = new URL(url).hostname;
			return hosts.some((x) => h === x || h.endsWith(`.${x}`));
		} catch {
			return false;
		}
	};

	return async (url, init) => {
		if (!routed(url) || (init?.method && init.method.toUpperCase() !== 'GET')) return opts.fallback(url, init);
		let reply: V1Reply;
		try {
			await opts.ready?.();
			const withSession = await ensureSession();
			reply = await call({
				cmd: 'request.get',
				url,
				maxTimeout,
				...(withSession ? { session: SESSION, session_ttl_minutes: SESSION_TTL_MINUTES } : {}),
			});
			if (reply.status === 'error' && /session/i.test(reply.message ?? '') && withSession) {
				// The service restarted under us and forgot the session.
				session = null;
				reply = await call({ cmd: 'request.get', url, maxTimeout });
			}
			warnedDown = false;
		} catch (err) {
			session = null;
			const host = opts.describe?.();
			const reason = `FlareSolverr at ${opts.baseUrl}: ${failure(err, callTimeout)}${host ? `; ${host}` : ''}`;
			if (!warnedDown) flog.warn('service unreachable', { api, reason });
			warnedDown = true;
			try { opts.onDown?.(); } catch { /* best-effort */ }
			throw new ProviderUnavailableError('beatport', reason);
		}
		const s = reply.solution;
		if (reply.status === 'error' || !s) {
			// The browser couldn't clear the challenge in time: report it the way
			// Cloudflare would, so the client's block handling backs off.
			flog.warn('challenge not solved', { url, message: reply.message });
			return new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
		}
		// FlareSolverr v3 usually reports no response headers, and its status is
		// the navigation's. A page still showing the interstitial is caught by
		// the client's body sniff on a challenge status.
		const status = s.status >= 200 && s.status <= 599 && ![204, 205, 304].includes(s.status) ? s.status : 200;
		const challenged = /<title>\s*Just a moment/i.test(s.response);
		return new Response(s.response, {
			status: challenged ? 403 : status,
			headers: { 'content-type': 'text/html; charset=utf-8', ...(challenged ? { 'cf-mitigated': 'challenge' } : {}) },
		});
	};
}
