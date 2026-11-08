// The master's own Spotify calls, paced and ban-aware.
//
// Spotify's rate limit and its quota ban are per client id, and the master's
// app credentials share the desktop's client id (local.ts: Spotify allows one
// app per developer). So every read the master makes — the tracker sweep, the
// recording resolver, the store linker, the label profiler, the catalogue-
// playlist hunt — goes through this one fetch:
//   • a minimum gap between calls, so the master's share of the window stays
//     small beside the desktop worker's (whose own gate is @curator/spotify);
//   • a pause the moment a 429 is seen, for the Retry-After Spotify named, and
//     the pauses the tracker sweep already keeps in the cursors (a device's
//     included — same client id, same ban), read every PAUSE_TTL_MS;
//   • while paused, no call goes out: the readers' own rate-limit error is
//     thrown instead, which every pass already treats as "park this provider".
// Before this, each minute-pass made a real probe per step against a wall
// Spotify had said would stand for hours.

import { TrackerRateLimitedError, type FetchLike } from '@curator/catalog-readers';
import type { Queryable } from '../db/db.js';
import { providerPauses } from './tracking.js';

const PAUSE_TTL_MS = 30_000;

export type SpotifyPaceDeps = {
	// Read lazily: both entry points open the database after the readers.
	db?: () => Queryable | null;
	// Calls are at least this far apart (default 2 s: 30/min).
	minGapMs?: number;
	fetchFn?: FetchLike;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
};

export type SpotifyPace = {
	fetch: FetchLike;
	// The pause in force (epoch ms), or 0.
	pausedUntil(): number;
};

export function createSpotifyPace(deps: SpotifyPaceDeps = {}): SpotifyPace {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const fetchFn = deps.fetchFn ?? ((u, i) => fetch(u, i));
	const minGapMs = deps.minGapMs ?? 2_000;
	let memoryUntil = 0;
	let dbUntil = 0;
	let dbReadAt = -Infinity;
	let chain: Promise<void> = Promise.resolve();
	let lastStartAt = -Infinity;

	const refreshDbPause = async (): Promise<void> => {
		const db = deps.db?.();
		if (!db || now() - dbReadAt < PAUSE_TTL_MS) return;
		dbReadAt = now();
		try {
			const p = (await providerPauses(db)).find((x) => x.provider === 'spotify');
			dbUntil = p?.until ?? 0;
		} catch {
			// The pause the cursors hold is advisory here; the next call re-reads.
		}
	};
	const pausedUntil = (): number => Math.max(memoryUntil, dbUntil) > now() ? Math.max(memoryUntil, dbUntil) : 0;

	const paced: FetchLike = async (url, init) => {
		await refreshDbPause();
		const until = pausedUntil();
		if (until) throw new TrackerRateLimitedError(Math.max(1, Math.ceil((until - now()) / 1000)));
		// Starts are spaced through one chain so concurrent callers take
		// distinct slots; the request itself runs outside it.
		const slot = chain.then(async () => {
			const wait = lastStartAt + minGapMs - now();
			if (wait > 0) await sleep(wait);
			lastStartAt = now();
		});
		chain = slot.catch(() => {});
		await slot;
		const res = await fetchFn(url, init);
		if (res.status === 429) {
			const retryAfterSec = Number(res.headers.get('retry-after') ?? '60') || 60;
			memoryUntil = Math.max(memoryUntil, now() + retryAfterSec * 1000);
		}
		return res;
	};
	return { fetch: paced, pausedUntil };
}
