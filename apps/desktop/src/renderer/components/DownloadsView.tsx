// DownloadsView — reactive replacement for renderDownloadsView +
// the dl-toolbar wiring that used to live in main.ts.
//
// Owns the entire content of the `.dl-view` host:
//   • Toolbar (status text + Open Folder / Verify / Clear* buttons)
//   • Row list (driven by For + the `jobs` accessor)
//
// Visibility is still controlled externally — main.ts/setActiveView()
// toggles `hidden` on the host element. That keeps the host-class-on-
// the-outside pattern that the rest of the layouts use; the component
// just paints content.

import { For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import type { DownloadJob, QueueSummary } from '@curator/core';

// Error-kind → friendly label. Mirrors backend DownloadErrorKind. Kept
// inside the component because the only consumer of the mapping is the
// state column rendered here.
const ERROR_KIND_LABEL: Record<string, string> = {
	not_available:       'Not available',
	auth_required:       'Reconnect Tidal',
	download_failed:     'Download failed',
	verification_failed: 'Verification failed',
	unsupported_format:  'Format unsupported',
	download_duplicate:  'Download duplicate',
	other:               'Error',
};

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function summaryText(s: QueueSummary): string {
	if (s.total === 0) return 'No downloads yet.';
	const tail: string[] = [];
	if (s.downloading) tail.push(` · ${s.downloading} downloading`);
	if (s.pending) tail.push(` · ${s.pending} pending`);
	if (s.skipped) tail.push(` · ${s.skipped} skipped`);
	if (s.error) tail.push(` · ${s.error} errors`);
	return `${s.done} of ${s.total} done${tail.join('')} — ${s.overallPct}%`;
}

function stateLabel(j: DownloadJob): string {
	if (j.state === 'downloading') return 'DOWNLOADING';
	if (j.state === 'pending') return 'PENDING';
	if (j.state === 'done') return 'DONE';
	if (j.state === 'skipped') return 'SKIPPED (exists)';
	return ERROR_KIND_LABEL[j.errorKind ?? 'other'] ?? 'ERROR';
}

// Size column carries the numeric progress signal. While downloading,
// running bytes-so-far + a percent suffix; once done or skipped, the
// final file size.
function sizeText(j: DownloadJob): string {
	if (j.state === 'downloading') {
		return (j.bytes ?? 0) > 0 ? `${formatBytes(j.bytes!)} · ${j.pct}%` : `${j.pct}%`;
	}
	if ((j.state === 'done' || j.state === 'skipped') && (j.bytes ?? 0) > 0) {
		return formatBytes(j.bytes!);
	}
	return '';
}

export interface DownloadsViewProps {
	jobs: Accessor<DownloadJob[]>;        // already sorted (enqueuedAt asc)
	summary: Accessor<QueueSummary>;
	onRetry: (trackId: string) => void;
	onRowContextMenu: (evt: MouseEvent, trackId: string) => void;
	onClearCompleted: () => void;
	onClearAll: () => void;
	onOpenFolder: () => void;
	onVerify: () => void;
}

export interface DownloadsViewHandle {
	destroy(): void;
}

export function DownloadsView(props: DownloadsViewProps) {
	return (
		<>
			<div class="dl-toolbar">
				<div class="dl-toolbar__status" id="dl-toolbar-status">{summaryText(props.summary())}</div>
				<div class="dl-toolbar__actions">
					<button class="btn-secondary" id="dl-open-folder-btn" type="button" title="Open downloads folder in the OS file manager" onClick={() => props.onOpenFolder()}>Open Folder</button>
					<button class="btn-secondary" id="dl-verify-btn" type="button" title="Check each file exists, size matches, FLAC magic intact" onClick={() => props.onVerify()}>Verify</button>
					<button class="btn-secondary" id="dl-clear-btn" type="button" title="Remove completed jobs from the list" onClick={() => props.onClearCompleted()}>Clear Completed</button>
					<button class="btn-secondary" id="dl-clear-all-btn" type="button" title="Remove every job from the list (in-flight downloads are kept)" onClick={() => props.onClearAll()}>Clear All</button>
				</div>
			</div>
			<div class="dl-list" id="dl-list">
				<For each={props.jobs()}>
					{(j) => {
						const display = j.artistName ? `${j.artistName} - ${j.trackTitle}` : j.trackTitle;
						return (
							<div
								class="dl-row"
								data-state={j.state}
								data-errorkind={j.errorKind ?? ''}
								data-id={j.trackId}
								onContextMenu={(evt) => { evt.preventDefault(); props.onRowContextMenu(evt, j.trackId); }}
							>
								<span class="dot"></span>
								<span class="name">
									{display}
									<Show when={j.state === 'error' && j.error}>
										<span class="err">{j.error && j.error.length > 140 ? j.error.slice(0, 140) + '…' : j.error}</span>
									</Show>
								</span>
								<span class="state-label">{stateLabel(j)}</span>
								<span class="pct">{sizeText(j)}</span>
								<span class="action-cell">
									<Show
										when={j.state === 'error'}
										fallback={<span></span>}
									>
										<button class="action" onClick={() => props.onRetry(j.trackId)}>Retry</button>
									</Show>
								</span>
							</div>
						);
					}}
				</For>
			</div>
		</>
	);
}

export function mountDownloadsView(host: HTMLElement, props: DownloadsViewProps): DownloadsViewHandle {
	const dispose = render(() => <DownloadsView {...props} />, host);
	return { destroy: dispose };
}
