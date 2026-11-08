// Feed refresh status store — what the feed scheduler is fetching right now
// (core FeedRefreshStatus), as main pushes it on 'feed:refresh-status', and
// beside it what this desktop's catalogue worker is reading (core
// CatalogWorkerStatus, pushed on 'catalog:worker-event'): a Refresh's check
// is answered in seconds and read over the following minutes, and that
// reading shows where the pass does. One store, two readers: the Discover
// view (toolbar + progress toast) and the TopFrame's Discover tab pulse.
// Covers background passes too, which no click in the renderer knows about.

import { createSignal } from 'solid-js';
import type { CatalogWorkerStatus, FeedRefreshStatus } from '@curator/core';

const [status, setStatus] = createSignal<FeedRefreshStatus>({ pass: null, waiting: 0 });
const [worker, setWorker] = createSignal<CatalogWorkerStatus | null>(null);
let connected = false;

export const feedRefresh = {
	status,
	worker,
	// Called once at boot. The event streams only carry changes from here on,
	// so one read each covers a renderer that mounts (or reloads) mid-pass —
	// unless an event beat it, which is newer. `?.`: a renderer hot-reloaded
	// under a main process that predates a channel stays idle instead of
	// failing boot.
	connect(): void {
		if (connected) return;
		connected = true;
		let pushed = false;
		window.api.onFeedRefreshStatus?.((s) => {
			pushed = true;
			setStatus(s);
		});
		void window.api['feed:refresh-status']?.()
			.then((s) => { if (!pushed) setStatus(s); })
			.catch(() => {});
		let workerPushed = false;
		window.api.onCatalogWorkerStatus?.((s) => {
			workerPushed = true;
			setWorker(s);
		});
		void window.api['catalog:worker-status']?.()
			.then((s) => { if (!workerPushed) setWorker(s); })
			.catch(() => {});
	},
};
