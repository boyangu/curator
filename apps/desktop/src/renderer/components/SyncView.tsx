// SyncView — reactive replacement for renderSyncView in main.ts.
//
// Owns the entire content of the `.sync-view` host: the head bar
// (title, status sub-line, Sync Now button) and the row list.
//
// Visibility stays external — main.ts/setActiveView() toggles `hidden`
// on the host element. The component only paints content.
//
// Row data is pre-projected by main.ts into a flat snapshot that
// includes the joined playlist timestamps (remoteUpdatedAt /
// lastSyncedAt / trackCount fallback). That keeps SyncView free of
// any cross-store lookups and lets us bump the rows signal whenever
// either syncRows OR the playlists cache changes.

import { For } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';

export type SyncRowState = 'pending' | 'syncing' | 'synced' | 'skipped' | 'error';

export interface SyncRowSnapshot {
	playlistId: string | null;
	name: string;
	source: string;
	mark: string | null;
	state: SyncRowState;
	trackCount?: number;
	tracksDone?: number;
	// Joined from playlistsById at snapshot time. The row would otherwise
	// have to reach across stores to find them, which a multi-instance
	// component can't safely do.
	remoteUpdatedAt: string | number | Date | null;
	lastSyncedAt: string | number | Date | null;
	playlistTrackCount: number | null;
}

export interface SyncViewProps {
	rows: Accessor<SyncRowSnapshot[]>;
	running: Accessor<boolean>;
	onSyncNow: () => void;
}

export interface SyncViewHandle {
	destroy(): void;
}

// Inlined here so the component is self-contained. Identical to
// main.ts:fmtRelative — kept duplicated until a third caller appears.
function fmtRelative(d: Date | string | number | null): string {
	if (!d) return '—';
	const ms = Date.now() - new Date(d).getTime();
	if (ms < 0) return 'just now';
	const s = Math.floor(ms / 1000);
	if (s < 60) return s < 5 ? 'just now' : `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const days = Math.floor(h / 24);
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.floor(days / 365)}y ago`;
}

function subText(rows: SyncRowSnapshot[], running: boolean): string {
	const total = rows.length;
	if (!total) return 'No active sync.';
	const counts = rows.reduce<Record<string, number>>((acc, r) => {
		acc[r.state] = (acc[r.state] ?? 0) + 1;
		return acc;
	}, {});
	const done = counts.synced ?? 0;
	const skipped = counts.skipped ?? 0;
	const errored = counts.error ?? 0;
	const parts: string[] = [`${done + skipped}/${total} processed`];
	if (skipped) parts.push(`${skipped} unchanged`);
	if (errored) parts.push(`${errored} errors`);
	return running ? parts.join(' · ') : `${parts.join(' · ')}. Sync complete.`;
}

function countText(r: SyncRowSnapshot): string {
	if (r.tracksDone != null) return String(r.tracksDone);
	if (r.trackCount != null) return String(r.trackCount);
	if (r.playlistTrackCount != null) return String(r.playlistTrackCount);
	return '—';
}

export function SyncView(props: SyncViewProps) {
	return (
		<>
			<div class="sync-view__head">
				<div class="sync-view__head-left">
					<div class="sync-view__title">Library sync</div>
					<div class="sync-view__sub" id="sync-view-sub">{subText(props.rows(), props.running())}</div>
				</div>
				<button
					id="sync-now-btn"
					class="btn-primary"
					type="button"
					disabled={props.running()}
					onClick={() => props.onSyncNow()}
				>
					Sync Now
				</button>
			</div>
			<div class="sync-list" id="sync-list">
				<div class="sync-list-head">
					<span></span>
					<span></span>
					<span>Playlist</span>
					<span>Source</span>
					<span class="count">Tracks</span>
					<span class="date">Remote Updated</span>
					<span class="date">Last Synced</span>
					<span>State</span>
				</div>
				<For each={props.rows()}>
					{(r) => (
						<div class="sync-row" data-state={r.state}>
							<span class="dot"></span>
							<span class="mark">{r.mark ?? ''}</span>
							<span class="name">{r.name}</span>
							<span class="source">{r.source}</span>
							<span class="count">{countText(r)}</span>
							<span class="date">{fmtRelative(r.remoteUpdatedAt)}</span>
							<span class="date">{fmtRelative(r.lastSyncedAt)}</span>
							<span class="state-label">{r.state === 'skipped' ? 'UNCHANGED' : r.state}</span>
						</div>
					)}
				</For>
			</div>
		</>
	);
}

export function mountSyncView(host: HTMLElement, props: SyncViewProps): SyncViewHandle {
	const dispose = render(() => <SyncView {...props} />, host);
	return { destroy: dispose };
}
