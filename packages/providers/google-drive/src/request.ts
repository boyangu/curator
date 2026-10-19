// Drive REST request layer: bearer auth, one-shot token refresh on 401, and
// exponential backoff for the transient failures Google documents (403 rate
// limits, 429, 5xx) plus transport errors. Every body is a Buffer or string
// so a retry can resend it verbatim — streaming bodies never go through here
// (the resumable chunk loop in client.ts owns its own retry, since a failed
// chunk must be re-probed, not blindly re-sent).

import { setTimeout as delay } from 'node:timers/promises';
import { DriveApiError } from './errors.js';

export interface DriveLog {
	info(msg: string, data?: Record<string, unknown>): void;
	warn(msg: string, data?: Record<string, unknown>): void;
}

export interface RequestDeps {
	accessToken(): Promise<string>;
	fetch: typeof fetch;
	sleep(ms: number): Promise<void>;
	now(): number;
	random(): number;
	log: DriveLog;
}

export interface RequestOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: Uint8Array | string;
	signal?: AbortSignal;
	// Statuses handed back to the caller instead of becoming errors (2xx and
	// 3xx always are): 404 on delete, 404/410 on a session probe, 416 on a
	// ranged download.
	accept?: readonly number[];
}

export const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 32_000;
// Retry-After is honored, but a pathological value (Google has been seen
// returning hours) would otherwise stall a run silently; past this the engine
// is better off failing the run as retryable and trying again next schedule.
const MAX_RETRY_AFTER_MS = 10 * 60_000;

// 403 reasons that mean "slow down", as opposed to the permanent ones
// (storageQuotaExceeded, insufficientPermissions, appNotAuthorizedToFile…).
const RATE_LIMIT_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'dailyLimitExceeded', 'sharingRateLimitExceeded']);

export const noopLog: DriveLog = { info() {}, warn() {} };

export function defaultSleep(ms: number): Promise<void> {
	return delay(ms);
}

export function isAbortError(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

export function abortError(): Error {
	return new DOMException('The operation was aborted', 'AbortError');
}

export function describeError(err: unknown): string {
	if (err instanceof Error) {
		const cause = (err as { cause?: unknown }).cause;
		const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
		return code ? `${err.message} (${String(code)})` : err.message;
	}
	return String(err);
}

// `attempt` is the 1-based number of the attempt that just failed:
// 1 s, 2 s, 4 s … 32 s, ±25 % jitter so parallel uploads don't re-sync.
export function backoffDelay(attempt: number, random: () => number): number {
	const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
	return Math.round(base * (0.75 + random() * 0.5));
}

export function parseRetryAfter(value: string | null, now: number): number | null {
	if (!value) return null;
	const secs = Number(value);
	if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
	const at = Date.parse(value);
	return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function isRetryableStatus(status: number, reason: string | null): boolean {
	if (status === 429 || status === 408 || status >= 500) return true;
	return status === 403 && reason !== null && RATE_LIMIT_REASONS.has(reason);
}

// Sleep that a cancel interrupts — a backup cancel must not wait out a 32 s
// backoff (or a long Retry-After) before the engine sees it.
export async function sleepAbortable(deps: Pick<RequestDeps, 'sleep'>, ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) return deps.sleep(ms);
	if (signal.aborted) throw abortError();
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener('abort', onAbort);
			reject(abortError());
		};
		signal.addEventListener('abort', onAbort, { once: true });
		deps.sleep(ms).then(
			() => { signal.removeEventListener('abort', onAbort); resolve(); },
			(err: unknown) => { signal.removeEventListener('abort', onAbort); reject(err as Error); },
		);
	});
}

// Backoff before attempt `attempt + 1`, or throw a retryable DriveApiError
// once the budget is spent. Shared by the request loop and the chunk loop.
export async function backoffOrThrow(
	deps: RequestDeps,
	attempt: number,
	retryAfterMs: number | null,
	signal: AbortSignal | undefined,
	ctx: { what: string; status: number; reason: string | null; message: string },
): Promise<void> {
	if (attempt >= MAX_ATTEMPTS) {
		throw new DriveApiError(`${ctx.what}: giving up after ${attempt} attempts — ${ctx.message}`, { status: ctx.status, reason: ctx.reason, retryable: true });
	}
	let ms = backoffDelay(attempt, deps.random);
	if (retryAfterMs !== null) {
		if (retryAfterMs > MAX_RETRY_AFTER_MS) {
			deps.log.warn('Retry-After exceeds the cap — capping', { what: ctx.what, retryAfterMs, capMs: MAX_RETRY_AFTER_MS });
		}
		ms = Math.max(ms, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
	}
	deps.log.info('transient Drive failure — backing off', { what: ctx.what, attempt, status: ctx.status, reason: ctx.reason, delayMs: ms, message: ctx.message });
	await sleepAbortable(deps, ms, signal);
}

export async function readError(res: Response): Promise<{ reason: string | null; message: string }> {
	const text = await res.text().catch(() => '');
	try {
		const json = JSON.parse(text) as { error?: { errors?: Array<{ reason?: string }>; message?: string } | string };
		if (typeof json.error === 'object' && json.error !== null) {
			const reason = json.error.errors?.[0]?.reason ?? null;
			return { reason, message: `${res.status} ${json.error.message ?? text.slice(0, 300)}` };
		}
		if (typeof json.error === 'string') return { reason: json.error, message: `${res.status} ${json.error}` };
	} catch {
		// Not JSON (HTML error page from a proxy) — fall through to the raw text.
	}
	return { reason: null, message: `${res.status} ${res.statusText || ''} ${text.slice(0, 300)}`.trim() };
}

export async function driveRequest(deps: RequestDeps, url: string, opts: RequestOptions = {}): Promise<Response> {
	const accept = opts.accept ?? [];
	let token = await deps.accessToken();
	let reauthed = false;
	let attempt = 0;
	for (;;) {
		attempt++;
		if (opts.signal?.aborted) throw abortError();
		let res: Response;
		try {
			res = await deps.fetch(url, {
				method: opts.method ?? 'GET',
				headers: { ...opts.headers, Authorization: `Bearer ${token}` },
				// Uint8Array is a valid body at run time; TS 5.9's Buffer typing
				// (ArrayBufferLike) doesn't satisfy the DOM lib's BufferSource.
				body: opts.body as RequestInit['body'],
				signal: opts.signal,
			});
		} catch (err) {
			if (isAbortError(err) || opts.signal?.aborted) throw abortError();
			// undici reports every transport failure (DNS, ECONNRESET, TLS, a
			// laptop waking up) as TypeError('fetch failed') — all worth a retry.
			await backoffOrThrow(deps, attempt, null, opts.signal, { what: `${opts.method ?? 'GET'} ${url}`, status: 0, reason: null, message: `network error: ${describeError(err)}` });
			continue;
		}
		if (res.ok || (res.status >= 300 && res.status < 400) || accept.includes(res.status)) return res;
		const { reason, message } = await readError(res);
		if (res.status === 401 && !reauthed) {
			// The provider refreshes behind accessToken(); a second 401 means
			// the refresh token itself is dead, which surfaces as a hard error.
			reauthed = true;
			token = await deps.accessToken();
			continue;
		}
		if (!isRetryableStatus(res.status, reason)) {
			throw new DriveApiError(`${opts.method ?? 'GET'} ${url}: ${message}`, { status: res.status, reason, retryable: false });
		}
		await backoffOrThrow(deps, attempt, parseRetryAfter(res.headers.get('retry-after'), deps.now()), opts.signal, { what: `${opts.method ?? 'GET'} ${url}`, status: res.status, reason, message });
	}
}
