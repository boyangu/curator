// Album summaries for the track list's album group headers. Tracks carry
// only `albumId`; the header needs the release's title, artists, date,
// label, genres and cover, fetched by id in batches and cached here.
// ensure() coalesces every request made in one tick into one IPC round
// (chunked at 500), and `rev` ticks when answers land so the list can
// repaint just its header rows.

import { createSignal } from 'solid-js';
import type { AlbumSummary } from '@curator/shared';
import { albumsApi } from './api.js';
import { log } from './log.js';

const alog = log.for('albums');

// id → summary; null = asked and the core knows no such album.
const cache = new Map<string, AlbumSummary | null>();
const inFlight = new Set<string>();
let queued = new Set<string>();
let scheduled = false;
const [rev, setRev] = createSignal(0);

async function flush(): Promise<void> {
	scheduled = false;
	const ids = [...queued];
	queued = new Set();
	for (const id of ids) inFlight.add(id);
	try {
		for (let i = 0; i < ids.length; i += 500) {
			const chunk = ids.slice(i, i + 500);
			const got = await albumsApi.byIds(chunk);
			const byId = new Map(got.map((a) => [a.id, a]));
			for (const id of chunk) cache.set(id, byId.get(id) ?? null);
			setRev((n) => n + 1);
		}
	} catch (err) {
		alog.warn('album summaries fetch failed', undefined, err);
	} finally {
		for (const id of ids) inFlight.delete(id);
	}
}

export const albums = {
	rev,
	// undefined = not loaded yet (call ensure), null = unknown album.
	get(id: string): AlbumSummary | null | undefined {
		return cache.get(id);
	},
	ensure(ids: Iterable<string>): void {
		for (const id of ids) {
			if (!id || cache.has(id) || inFlight.has(id)) continue;
			queued.add(id);
		}
		if (queued.size === 0 || scheduled) return;
		scheduled = true;
		queueMicrotask(() => { void flush(); });
	},
	// After a write that can change releases (sync, edit, merge): forget the
	// cached summaries so the next ensure() refetches them.
	invalidate(ids?: Iterable<string>): void {
		if (!ids) cache.clear();
		else for (const id of ids) cache.delete(id);
	},
};
