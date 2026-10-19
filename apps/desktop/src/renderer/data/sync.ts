// Spotify-sync session store — rows, running/retry flags, and the
// current-playlist pointer that the source-tab tooltip renders. Second
// F2 vertical slice; same shape as data/downloads.ts.
//
// The wireSyncProgressEvents handler in main.ts (moving to data/events.ts
// with the playlists slice) writes through the helpers below; SyncView,
// the source-tab tooltip effect, and the Settings connections panel read
// reactively. No more refreshSyncSignals() call chains.

import { createStore, produce, reconcile } from 'solid-js/store';

export interface SyncRow {
	playlistId: string | null;
	name: string;
	source: string;
	mark: string | null;
	state: 'pending' | 'syncing' | 'synced' | 'skipped' | 'error';
	trackCount?: number;
	tracksDone?: number;
}

export interface SyncCurrentPointer {
	name: string;
	index: number;
	total: number;
}

const [store, setStore] = createStore<{
	rows: Record<string, SyncRow>;
	running: boolean;
	retrying: boolean;
	stopRequested: boolean;
	currentSpotify: SyncCurrentPointer | null;
}>({ rows: {}, running: false, retrying: false, stopRequested: false, currentSpotify: null });

export const syncState = {
	// ── Reads ──────────────────────────────────────────────────────────
	rows(): SyncRow[] {
		return Object.values(store.rows);
	},
	entries(): [string, SyncRow][] {
		return Object.entries(store.rows);
	},
	getRow(key: string): SyncRow | undefined {
		return store.rows[key];
	},
	rowCount(): number {
		return Object.keys(store.rows).length;
	},
	running: () => store.running,
	retrying: () => store.retrying,
	stopRequested: () => store.stopRequested,
	currentSpotify: () => store.currentSpotify,

	// ── Writes ─────────────────────────────────────────────────────────
	setRunning(v: boolean): void { setStore('running', v); },
	setRetrying(v: boolean): void { setStore('retrying', v); },
	setStopRequested(v: boolean): void { setStore('stopRequested', v); },
	setCurrentSpotify(p: SyncCurrentPointer | null): void { setStore('currentSpotify', p); },
	upsertRow(key: string, row: SyncRow): void { setStore('rows', key, row); },
	clearRows(): void { setStore('rows', reconcile({})); },
	// Bulk in-place transition (e.g. every 'syncing' row → 'synced').
	patchRows(fn: (row: SyncRow, key: string) => void): void {
		setStore('rows', produce((rows) => {
			for (const [k, r] of Object.entries(rows)) fn(r, k);
		}));
	},
};
