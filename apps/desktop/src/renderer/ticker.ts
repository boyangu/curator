// Shared per-frame ticker — ONE requestAnimationFrame loop for every
// continuously-animating consumer (VU meter EMA, big-waveform playhead).
// Before this, each component ran its own private rAF loop; with two or
// three alive at once the browser pays the scheduling + callback overhead
// per loop, and "pause all animation when the window hides" has no single
// place to live. Subscribers run in registration order inside one frame
// callback; a subscriber that throws is logged and skipped for that frame
// without taking the others down. The loop self-stops when the last
// subscriber unsubscribes, so an idle app (nothing playing, no waveform
// mounted) schedules no frames at all.

import { log } from './data/log.js';

// Per-frame path: a persistently-throwing subscriber would emit 60 records/s,
// so this stays debug (DevTools-only) rather than flooding the session file.
const slog = log.for('ticker');

type FrameFn = (now: DOMHighResTimeStamp) => void;

const subscribers = new Set<FrameFn>();
let rafHandle: number | null = null;

function loop(now: DOMHighResTimeStamp): void {
	for (const fn of subscribers) {
		try {
			fn(now);
		} catch (err) {
			slog.debug('frame subscriber threw', { err });
		}
	}
	rafHandle = subscribers.size > 0 ? requestAnimationFrame(loop) : null;
}

// Subscribe to the shared frame loop. Returns an unsubscribe fn — callers
// MUST invoke it on unmount (Solid: wrap in onCleanup) or the loop keeps
// running their dead callback forever.
export function onFrame(fn: FrameFn): () => void {
	subscribers.add(fn);
	if (rafHandle == null) rafHandle = requestAnimationFrame(loop);
	return () => {
		subscribers.delete(fn);
		if (subscribers.size === 0 && rafHandle != null) {
			cancelAnimationFrame(rafHandle);
			rafHandle = null;
		}
	};
}
