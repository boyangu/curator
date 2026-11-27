// Every store call a device makes for the catalogue goes through its store's
// lane: paced (never closer than the store's gap, whoever asks — two runs at
// once included), timed out, counted (the report states what the work cost,
// per store), and stopped while the store rests — after a rate limit, a
// block, our route to it being down, or failures in a row. A resting store is
// in the device's profile too, so the cloud hands it nothing meanwhile.
//
// A failure is either the store's — reported, and the cloud rests the job a
// day — or the device's own (offline, signed out, the host's own gate on a
// store), which is nobody else's business: rested here, never reported, so a
// phone losing signal does not quiet a page for every other device.

import { TrackerRateLimitedError, type FetchLike } from '@curator/catalog-readers';
import type { CatalogWorkStore } from '@curator/protocol';

// The gap between two calls to one store. Beatport and Traxsource are read as
// a browser reads them and block a visitor that asks too fast; Bandcamp's
// mobile API likewise. Spotify's pace is the host's (the desktop's gate the
// player and the feed share; the phone's one client).
export const STORE_GAP_MS: Record<CatalogWorkStore, number> = { spotify: 0, deezer: 250, beatport: 1500, bandcamp: 1000, traxsource: 1500 };

// A call that has not answered by then is given up (the old desktop reader's
// READ_TIMEOUT_MS): one hung call must not hold the visit and what it found.
export const CALL_TIMEOUT_MS = 20_000;

// How long a store rests when it said no without saying for how long.
const BLOCK_REST_MS = 5 * 60_000;
const DOWN_REST_MS = 2 * 60_000;
// The device's own trouble (offline, not signed in): looked at again soon.
const DEVICE_REST_MS = 60_000;
// Failures nothing explains, in a row, before the store rests; and for how long.
const FAILURES_IN_A_ROW = 2;
const FAILING_REST_MS = 10 * 60_000;

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

// The host's word on a failure the engine cannot read: `mine` — the device's
// own (the host's gate refused, no network, signed out), never reported;
// otherwise the store's. `restMs`: how long the store rests. Null: no opinion.
export type FailureVerdict = { mine: boolean; restMs: number };
export type ClassifyFailure = (store: CatalogWorkStore, e: unknown) => FailureVerdict | null;

// What a failed call comes to: whether it goes in the report, and the rate
// limit it states (the cloud remembers none of those).
export type Failure = { report: boolean; rateLimitedSec: number | null };

// The work was called off: never a store's failure.
export class WorkAbortedError extends Error {
	override readonly name = 'AbortError';
	constructor() {
		super('aborted');
	}
}

export class WorkTimeoutError extends Error {
	override readonly name = 'WorkTimeoutError';
}

// Not signed in to the store, or no route to it: the device's own.
export class WorkDeviceNotReadyError extends Error {
	override readonly name = 'WorkDeviceNotReadyError';
}

// A sleep that wakes early when the work is called off. Hermes has no
// AbortSignal.timeout; a timer and the signal's own event do.
export const defaultSleep: Sleep = (ms, signal) =>
	new Promise((resolve) => {
		if (ms <= 0 || signal?.aborted) return resolve();
		const timer = setTimeout(done, ms);
		signal?.addEventListener?.('abort', done, { once: true });
		function done(): void {
			clearTimeout(timer);
			signal?.removeEventListener?.('abort', done);
			resolve();
		}
	});

// fetch's own word for "no network": a TypeError ("fetch failed" in Node,
// "Failed to fetch" in a browser, "Network request failed" on React Native
// and the phone's shim). A TypeError from a reader's own parsing is not one.
const offline = (e: unknown): boolean => e instanceof TypeError && /fetch|network/i.test(e.message);

export class Lanes {
	// The earliest the next call to a store may start: taken before the wait,
	// so callers at the same moment queue instead of all firing at once.
	private readonly next = new Map<CatalogWorkStore, number>();
	private readonly restingUntil = new Map<CatalogWorkStore, number>();
	private readonly failing = new Map<CatalogWorkStore, number>();
	private calls: Partial<Record<CatalogWorkStore, number>> = {};

	constructor(
		private readonly now: () => number,
		private readonly sleep: Sleep,
		private readonly gaps: Record<CatalogWorkStore, number>,
		private readonly opts: { timeoutMs?: number; classify?: ClassifyFailure } = {},
	) {}

	// The store's fetch, through its lane.
	fetchFor(store: CatalogWorkStore, base: FetchLike): FetchLike {
		return async (url, init) => {
			const signal = init?.signal ?? undefined;
			const at = Math.max(this.now(), this.next.get(store) ?? -Infinity);
			this.next.set(store, at + this.gaps[store]);
			const wait = at - this.now();
			if (wait > 0) await this.sleep(wait, signal);
			if (signal?.aborted) throw new WorkAbortedError();
			this.calls[store] = (this.calls[store] ?? 0) + 1;
			const res = await this.timed(base, url, init);
			if (res.ok) this.failing.delete(store);
			return res;
		};
	}

	// The call, given up after the timeout. Where the runtime has an
	// AbortController the call itself is cut (the phone's shim brings one);
	// the timer stays armed past the headers, so a body that never ends is cut
	// too — aborting a finished call does nothing.
	private timed(base: FetchLike, url: string, init: RequestInit | undefined): Promise<Response> {
		const ms = this.opts.timeoutMs ?? CALL_TIMEOUT_MS;
		if (!(ms > 0)) return base(url, init);
		const Ctl = (globalThis as { AbortController?: typeof AbortController }).AbortController;
		const ctl = Ctl ? new Ctl() : null;
		const outer = init?.signal ?? undefined;
		const cut = (): void => ctl?.abort();
		if (outer?.aborted) cut();
		else outer?.addEventListener?.('abort', cut, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				cut();
				outer?.removeEventListener?.('abort', cut);
				reject(new WorkTimeoutError(`no answer in ${Math.round(ms / 1000)} s`));
			}, ms);
			(timer as { unref?: () => void }).unref?.();
		});
		timeout.catch(() => {});
		return Promise.race([base(url, ctl ? { ...init, signal: ctl.signal } : init), timeout]);
	}

	resting(store: CatalogWorkStore): boolean {
		return (this.restingUntil.get(store) ?? 0) > this.now();
	}

	// The stores resting now, until when: the profile's `resting`.
	restingList(): { store: CatalogWorkStore; until: number }[] {
		const now = this.now();
		return [...this.restingUntil].filter(([, until]) => until > now).map(([store, until]) => ({ store, until: Math.round(until) }));
	}

	rest(store: CatalogWorkStore, untilMs: number): void {
		this.restingUntil.set(store, Math.max(untilMs, this.restingUntil.get(store) ?? 0));
	}

	// A call made outside the lane's fetch (a host's own reader), counted.
	count(store: CatalogWorkStore): void {
		this.calls[store] = (this.calls[store] ?? 0) + 1;
	}

	// What the calls since the last take cost, per store: one report's `calls`.
	takeCalls(): Partial<Record<CatalogWorkStore, number>> {
		const out = this.calls;
		this.calls = {};
		return out;
	}

	// What a failed call says about its store: rested for as long as it asked,
	// a block for a while, our route's outage briefly; the device's own
	// trouble rested and kept to itself; anything else the store's, resting
	// it once it fails again.
	failed(store: CatalogWorkStore, e: unknown, blockedUntil?: number | null): Failure {
		const now = this.now();
		if (e instanceof TrackerRateLimitedError) {
			this.rest(store, now + e.retryAfterSec * 1000);
			return { report: true, rateLimitedSec: e.retryAfterSec };
		}
		// The provider packages' block and outage errors (@curator/matcher), by
		// name: the clients keep their own cooldown, the lane follows it.
		const name = e instanceof Error ? e.name : '';
		if (name === 'ProviderBlockedError') {
			const until = blockedUntil && blockedUntil > now ? blockedUntil : now + BLOCK_REST_MS;
			this.rest(store, until);
			return { report: true, rateLimitedSec: Math.max(1, Math.ceil((until - now) / 1000)) };
		}
		if (name === 'ProviderUnavailableError') {
			this.rest(store, now + DOWN_REST_MS);
			return { report: true, rateLimitedSec: DOWN_REST_MS / 1000 };
		}
		const verdict = this.opts.classify?.(store, e) ?? (e instanceof WorkDeviceNotReadyError || offline(e) ? { mine: true, restMs: DEVICE_REST_MS } : null);
		if (verdict) {
			if (verdict.restMs > 0) this.rest(store, now + verdict.restMs);
			return { report: !verdict.mine, rateLimitedSec: null };
		}
		const inARow = (this.failing.get(store) ?? 0) + 1;
		this.failing.set(store, inARow);
		if (inARow >= FAILURES_IN_A_ROW) this.rest(store, now + FAILING_REST_MS);
		return { report: true, rateLimitedSec: null };
	}
}
