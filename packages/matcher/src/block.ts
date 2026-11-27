// Cloudflare / WAF block detection, shared by every scraping provider. Beatport
// and Traxsource both sit behind Cloudflare. When it escalates from merely
// 403-ing non-browser TLS to serving an interactive "Just a moment…" managed
// challenge, the scrape gets a challenge page instead of results. Left
// undetected, that reads as a clean "no match" — so the batch keeps hammering a
// wall, and a real WAF outage is indistinguishable from "track isn't in the
// catalog". Detecting it lets a provider:
//   (a) throw a typed error the enrich runner records as `errored` (retry
//       later) rather than swallowing it as a null patch, and
//   (b) trip a short cooldown so the rest of a batch skips the blocked provider
//       and its fallback carries the load until the window elapses.

// Thrown by a provider client when a lookup can't proceed because the source is
// behind a Cloudflare challenge (or the client is in its post-block cooldown).
// The enrich runner catches it like any enricher failure — the point is the
// TYPE: callers (the Edit-Track modal, diagnostics) can tell "blocked by the
// WAF, retry later" apart from "genuinely not found".
export class ProviderBlockedError extends Error {
	constructor(
		readonly provider: string,
		readonly status: number,
		readonly reason: string,
	) {
		super(`${provider} blocked by Cloudflare (${reason}${status ? `, HTTP ${status}` : ''})`);
		this.name = 'ProviderBlockedError';
	}
}

// Thrown when the path to a source is down on OUR side — the FlareSolverr
// browser that carries Beatport isn't running or isn't answering. Not a block:
// the source never saw us. The reason says what failed and how (refused,
// timed out, starting, Docker down…), so "Beatport is blocked" and "our
// helper is off" can't be confused in the log.
export class ProviderUnavailableError extends Error {
	constructor(
		readonly provider: string,
		readonly reason: string,
	) {
		super(`${provider} unavailable — ${reason}`);
		this.name = 'ProviderUnavailableError';
	}
}

// Thrown when a call to the source failed — no network, a timeout, a 5xx —
// with no block behind it. Not "not found": a lookup that answered nothing
// because its call failed would be remembered as a miss and never asked
// again (the feed's runner records a throw as `errored`, asked later).
export class ProviderFailedError extends Error {
	constructor(
		readonly provider: string,
		readonly status: number,
		readonly reason: string,
	) {
		super(`${provider} lookup failed (${reason}${status ? `, HTTP ${status}` : ''})`);
		this.name = 'ProviderFailedError';
	}
}

export interface HeaderReader {
	get(name: string): string | null;
}

// Returns a short reason string when a response looks like a Cloudflare
// interactive challenge, else null. Two signals:
//   - `cf-mitigated: challenge` — the edge tags challenged responses with this
//     header; authoritative and cheap (no body read needed).
//   - the "Just a moment…" / Turnstile interstitial body — only sniffed on the
//     statuses Cloudflare actually uses for challenges (403/429/503), because a
//     legitimate 200 results page can contain the word "challenge" in a track
//     title. Pass `body: null` to do the header-only (pre-body) check.
export function cloudflareChallengeReason(
	status: number,
	headers: HeaderReader,
	body: string | null,
): string | null {
	const mitigated = headers.get('cf-mitigated');
	if (mitigated && /challenge/i.test(mitigated)) return `cf-mitigated:${mitigated}`;
	if ((status === 403 || status === 429 || status === 503) && body) {
		if (/just a moment|__cf_chl|cf-chl-|challenge-platform|turnstile|attention required/i.test(body)) {
			return 'interstitial';
		}
	}
	return null;
}

// The wait a `Retry-After` header asks for (delta-seconds or an HTTP date), in
// ms, or null when absent/unparseable. Cloudflare's managed challenge sends
// none — it lifts when its fingerprinting changes its mind, not on a clock —
// but a rate-limit 429 on the same path does, and it's the one honest answer
// to "when may we ask again".
export function retryAfterMs(headers: HeaderReader, now: number = Date.now()): number | null {
	const v = headers.get('retry-after')?.trim();
	if (!v) return null;
	if (/^\d+$/.test(v)) return Number(v) * 1000;
	const at = Date.parse(v);
	return Number.isFinite(at) && at > now ? at - now : null;
}

// Per-instance backoff. A provider client trips it on each detected challenge;
// while active, the enricher's applicableTo() returns false so a batch skips
// the blocked provider entirely (no network, no per-track error spam) and its
// fallback carries the load, and `releaseAt` tells callers when to come back.
//
// A managed challenge carries no expiry and has held for weeks (2026-07,
// 2026-11), so a fixed window would probe the wall every few minutes forever:
// each consecutive block doubles the window from `ms` up to `maxMs`, and a
// response that gets through (`clear()`) resets it. A Retry-After, when the
// source sends one, replaces the guess. `now` is injectable for tests.
export class Cooldown {
	private until = 0;
	private strikes = 0;
	constructor(
		private readonly ms: number,
		private readonly now: () => number = () => Date.now(),
		private readonly maxMs: number = ms,
	) {}
	get active(): boolean {
		return this.now() < this.until;
	}
	// When the current window ends, or null when not cooling down.
	get releaseAt(): number | null {
		return this.active ? this.until : null;
	}
	// Returns the window length chosen, for the caller's log line.
	trip(retryAfter?: number | null): number {
		const window = retryAfter != null && retryAfter > 0
			? retryAfter
			: Math.min(this.maxMs, this.ms * 2 ** this.strikes);
		this.strikes++;
		this.until = this.now() + window;
		return window;
	}
	// A short pause that isn't a block (our helper is down): no strike, so the
	// next real block still starts the backoff from the bottom.
	hold(ms: number): void {
		this.until = Math.max(this.until, this.now() + ms);
	}
	clear(): void {
		this.strikes = 0;
		this.until = 0;
	}
}
