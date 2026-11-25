// One lookup at a time, for callers that share a store's enricher.
//
// Beatport and Traxsource are read as a browser would read them, and both
// block a visitor that asks too fast. The feed's drain paces itself, and so
// does an entity page filling in its rows (entity/work.ts) — but each paces
// only its own calls, so the two running together would ask twice as often.
// An enricher put in a lane starts its lookups one after another, never
// closer than `minGapMs`, whoever asks; the callers' own pacing still
// applies on top.

import type { Enricher, EnricherOutput, EnrichmentTarget } from '@curator/sync-core/enrich/contract';

export function inLane(enricher: Enricher, minGapMs: number): Enricher {
	let tail: Promise<unknown> = Promise.resolve();
	let lastStart = 0;
	return {
		id: enricher.id,
		produces: enricher.produces,
		applicableTo: (target) => enricher.applicableTo(target),
		...(enricher.blockedUntil ? { blockedUntil: () => enricher.blockedUntil!() } : {}),
		...(enricher.blockedReason ? { blockedReason: () => enricher.blockedReason!() } : {}),
		enrich(target: EnrichmentTarget, signal?: AbortSignal): Promise<EnricherOutput | null> {
			const run = tail.then(async () => {
				if (signal?.aborted) return null;
				const wait = lastStart + minGapMs - Date.now();
				if (wait > 0) await new Promise((r) => setTimeout(r, wait));
				// The store may have blocked us while this lookup waited its turn.
				if (signal?.aborted || !enricher.applicableTo(target)) return null;
				lastStart = Date.now();
				return enricher.enrich(target, signal);
			});
			// A failed lookup must not stall the ones behind it.
			tail = run.catch(() => undefined);
			return run;
		},
	};
}
