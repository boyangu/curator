// What the desktop is doing to a feed item right now (core
// FeedItemActivity, pushed on 'feed:activity'): the lazy Spotify match of a
// card without a Spotify id, or its DJ-metadata enrichment — background
// drain and on-view alike. The Discover card reads it to show "Loading from
// Spotify…" / "Enriching BPM, key, genre and label…" instead of an empty line.

import { createSignal } from 'solid-js';
import type { FeedItemActivity } from '@curator/core';

const [busy, setBusy] = createSignal<ReadonlyMap<string, NonNullable<FeedItemActivity['activity']>>>(new Map());
let connected = false;

export const ACTIVITY_TEXT: Record<NonNullable<FeedItemActivity['activity']>, string> = {
	spotify: 'Loading from Spotify…',
	enrich: 'Enriching BPM, key, genre and label…',
};

export const feedActivity = {
	// The activity on one item, or null.
	of(itemId: string): NonNullable<FeedItemActivity['activity']> | null {
		return busy().get(itemId) ?? null;
	},
	// Called once at boot. `?.`: a renderer hot-reloaded under a main process
	// that predates the channel stays quiet instead of failing boot.
	connect(): void {
		if (connected) return;
		connected = true;
		window.api.onFeedActivity?.((a) => {
			const next = new Map(busy());
			if (a.activity) next.set(a.itemId, a.activity);
			else next.delete(a.itemId);
			setBusy(next);
		});
	},
};
