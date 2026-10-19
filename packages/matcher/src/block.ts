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

// Per-instance backoff. A provider client trips it on the first detected
// challenge; while active, the enricher's applicableTo() returns false so a
// batch skips the blocked provider entirely (no network, no per-track error
// spam) and its fallback carries the load. The window is a wall-clock TTL, so a
// long-lived client (the feed enrichment queue) self-recovers on the next drain
// after it elapses. `now` is injectable for tests.
export class Cooldown {
	private until = 0;
	constructor(
		private readonly ms: number,
		private readonly now: () => number = () => Date.now(),
	) {}
	get active(): boolean {
		return this.now() < this.until;
	}
	trip(): void {
		this.until = this.now() + this.ms;
	}
}
