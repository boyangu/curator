// Visible-tracks cache — the id→Track table behind the main tracklist,
// context menus, edit modal prefill, and the now-playing card. Fifth F2
// slice, ownership-first cut like data/library.ts: legacy Map shape with
// one reactive tick, because the virtualized tracklist's row pool and the
// page-order array (mainTracksUnfiltered in main.ts) hold structural
// contracts that the F4 TanStack rewrite renegotiates. Every write bumps
// the tick, so reactive readers (NowPlayingCard via rev()) repaint
// without the manual setTracksCacheRev chains.

import { createSignal } from 'solid-js';
import type { Track } from '@curator/shared';

const [tick, setTick] = createSignal(0);
const bump = (): void => { setTick((n) => n + 1); };

let byId = new Map<string, Track>();

export const tracksData = {
	// ── Reads (reactive via the tick) ──────────────────────────────────
	get(id: string): Track | undefined {
		tick();
		return byId.get(id);
	},
	all(): Track[] {
		tick();
		return Array.from(byId.values());
	},
	// Monotonic revision — drop-in for the old tracksCacheRev signal.
	rev(): number {
		return tick();
	},

	// ── Writes (every one bumps) ───────────────────────────────────────
	setAll(list: readonly Track[]): void {
		byId = new Map(list.map((t) => [t.id, t]));
		bump();
	},
	upsert(t: Track): void {
		byId.set(t.id, t);
		bump();
	},
	upsertMany(list: readonly Track[]): void {
		for (const t of list) byId.set(t.id, t);
		bump();
	},
	removeMany(ids: Iterable<string>): void {
		for (const id of ids) byId.delete(id);
		bump();
	},
};
