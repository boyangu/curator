// BackupProgressDialog — live status for a backup or restore run. Opens on
// "Back up now" / "Restore", stays up for the run: phase, counts, bytes,
// then a summary. The run itself lives in core's backup worker; this is a
// pure consumer of the backup:event stream (fed by main.ts).
//
// Hiding is not cancelling (same stance as WavConvertDialog): Esc /
// backdrop / "Run in background" only close the dialog; Stop is the only
// cancel. A staged restore ends with a "Restart Curator" button — the
// swap happens at the next boot before any DB opens.

import { createSignal, For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import type { BackupEvent, BackupPhase, BackupRunResult } from '@curator/core';
import { registerModalOpenSignal } from '../modalGate.js';
import { formatBytes } from '../ui/format.js';

interface RunState {
	runId: string | null;
	op: 'backup' | 'restore';
	phase: BackupPhase | null;
	done: number;
	total: number;
	bytesDone: number;
	bytesTotal: number;
	current: string | null;
	result: BackupRunResult | null;
	error: string | null;
	stopping: boolean;
}

export interface BackupProgressDialogProps {
	onStop(runId: string): void;
	onRelaunch(): void;
}

export interface BackupProgressDialogHandle {
	destroy(): void;
	isOpen: Accessor<boolean>;
	// Show immediately on click (before core's 'started' arrives).
	begin(op: 'backup' | 'restore'): void;
	handleEvent(evt: BackupEvent): void;
	reopen(): boolean;
	isRunActive(): boolean;
}

const PHASE_LABEL: Record<BackupPhase, string> = {
	collect: 'Collecting files', snapshot: 'Copying databases', hash: 'Checking for changes', upload: 'Uploading', manifest: 'Writing snapshot',
	retention: 'Rotating old snapshots', gc: 'Cleaning up unreferenced files', download: 'Downloading', verify: 'Verifying', write: 'Writing files', apply: 'Applying',
};

export function mountBackupProgressDialog(host: HTMLElement, props: BackupProgressDialogProps): BackupProgressDialogHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [run, setRun] = createSignal<RunState | null>(null);

	const finished = (): boolean => { const r = run(); return !!r && (r.result != null || r.error != null); };
	const hide = (): void => { setIsOpen(false); if (finished()) setRun(null); };
	const patch = (p: Partial<RunState>): void => { const r = run(); if (r) setRun({ ...r, ...p }); };
	const fresh = (op: 'backup' | 'restore', runId: string | null): RunState => ({ runId, op, phase: null, done: 0, total: 0, bytesDone: 0, bytesTotal: 0, current: null, result: null, error: null, stopping: false });

	const begin = (op: 'backup' | 'restore'): void => { setRun(fresh(op, null)); setIsOpen(true); };

	const handleEvent = (evt: BackupEvent): void => {
		if (evt.kind === 'status') return;
		const r = run();
		if (!r || (r.runId != null && r.runId !== evt.runId)) {
			// A run started elsewhere (scheduler, or after a reload): adopt it
			// silently so "Show progress" has something to show.
			if (evt.kind !== 'started') return;
			setRun(fresh(evt.op, evt.runId));
			return;
		}
		if (evt.kind === 'started') patch({ runId: evt.runId, op: evt.op });
		else if (evt.kind === 'progress') patch({ phase: evt.phase, done: evt.done, total: evt.total, bytesDone: evt.bytesDone, bytesTotal: evt.bytesTotal, current: evt.current });
		else if (evt.kind === 'completed') patch({ result: evt.result, current: null });
		else if (evt.kind === 'failed') patch({ error: evt.message, current: null });
		if ((evt.kind === 'completed' || evt.kind === 'failed') && !isOpen()) setRun(null);
	};

	const reopen = (): boolean => { if (!run()) return false; setIsOpen(true); return true; };
	const isRunActive = (): boolean => !!run() && !finished();
	const stop = (): void => { const r = run(); if (!r?.runId || r.stopping) return; patch({ stopping: true }); props.onStop(r.runId); };

	const onKeyDown = (e: KeyboardEvent): void => {
		if (!isOpen() || e.key !== 'Escape') return;
		e.preventDefault(); e.stopPropagation();
		hide();
	};
	document.addEventListener('keydown', onKeyDown, true);

	const pct = (): number => {
		const r = run();
		if (!r) return 0;
		if (r.bytesTotal > 0) return Math.min(100, Math.round((r.bytesDone / r.bytesTotal) * 100));
		return r.total > 0 ? Math.min(100, Math.round((r.done / r.total) * 100)) : 0;
	};
	const title = (): string => {
		const r = run();
		if (!r) return '';
		const noun = r.op === 'backup' ? 'Backup' : 'Restore';
		if (r.error) return `${noun} failed`;
		if (r.result) return r.result.cancelled ? `${noun} stopped` : r.result.unchanged ? 'Nothing to back up' : r.result.relaunchRequired ? 'Restore ready — restart to apply' : `${noun} complete`;
		return r.stopping ? 'Stopping…' : r.op === 'backup' ? 'Backing up' : 'Restoring';
	};
	const summary = (res: BackupRunResult, op: 'backup' | 'restore'): string => {
		if (op === 'backup') {
			if (res.unchanged) return 'Everything is already backed up.';
			return [`${res.files} files in the snapshot`, res.newObjects ? `${res.newObjects} new (${formatBytes(res.newBytes)} uploaded)` : 'nothing new to upload', `${Math.round(res.durationMs / 1000)} s`].join(' · ');
		}
		return [res.files ? `${res.files} files` : '', res.written != null ? `${res.written} written` : '', res.skipped ? `${res.skipped} already identical` : '', `${Math.round(res.durationMs / 1000)} s`].filter(Boolean).join(' · ');
	};

	const dispose = render(() => (
		<Show when={isOpen() && run()}>
			{(r) => (
				<div class="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) hide(); }}>
					<div class="modal wav-convert backup-progress" role="dialog" aria-modal="true" aria-labelledby="backup-progress-title">
						<header class="modal__head">
							<h3 id="backup-progress-title">{title()}</h3>
							<button class="modal__close" type="button" aria-label="Hide" onClick={(e) => { e.preventDefault(); hide(); }}>×</button>
						</header>
						<div class="modal__body">
							<Show when={!r().result && !r().error}>
								<div class="sync-rb__progress">
									<div class="sync-rb__bar"><div class="sync-rb__bar-fill" style={{ width: `${pct()}%` }} /></div>
									<div class="sync-rb__progress-text">{r().bytesTotal > 0 ? `${formatBytes(r().bytesDone)} / ${formatBytes(r().bytesTotal)}` : r().total > 0 ? `${r().done} / ${r().total}` : r().runId ? 'Starting…' : 'Preparing…'}</div>
								</div>
								<div class="wav-convert__current">{r().phase ? PHASE_LABEL[r().phase!] : 'Starting…'}{r().current ? ` — ${r().current}` : ''}</div>
							</Show>
							<Show when={r().result}>
								{(res) => (
									<>
										<p class="wav-convert__summary">{summary(res(), r().op)}</p>
										<Show when={res().relaunchRequired}>
											<div class="wav-convert__next">
												<div class="wav-convert__next-head">Restart to finish</div>
												The restored files are staged. On the next launch Curator swaps them in before opening the library; the files being replaced are kept in a pre-restore folder in Curator's app data.
											</div>
										</Show>
										<Show when={res().warnings.length > 0}>
											<div class="sync-rb__error-block wav-convert__failures">
												<div class="sync-rb__error-head">{`${res().warnings.length} note${res().warnings.length === 1 ? '' : 's'}`}</div>
												<ul class="sync-rb__error-list"><For each={res().warnings}>{(w) => <li>{w}</li>}</For></ul>
											</div>
										</Show>
									</>
								)}
							</Show>
							<Show when={r().error}>
								<p class="wav-convert__error">{r().error}</p>
							</Show>
						</div>
						<footer class="modal__foot">
							<Show when={!r().result && !r().error} fallback={
								<>
									<button type="button" class="btn-secondary" onClick={(e) => { e.preventDefault(); hide(); }}>Close</button>
									<Show when={r().result?.relaunchRequired}>
										<button type="button" class="btn-primary" onClick={(e) => { e.preventDefault(); props.onRelaunch(); }}>Restart Curator</button>
									</Show>
								</>
							}>
								<button type="button" class="btn-secondary" disabled={!r().runId || r().stopping} onClick={(e) => { e.preventDefault(); stop(); }}>{r().stopping ? 'Stopping…' : 'Stop'}</button>
								<button type="button" class="btn-primary" onClick={(e) => { e.preventDefault(); hide(); }}>Run in background</button>
							</Show>
						</footer>
					</div>
				</div>
			)}
		</Show>
	), host);

	return {
		destroy: () => { document.removeEventListener('keydown', onKeyDown, true); dispose(); },
		isOpen,
		begin,
		handleEvent,
		reopen,
		isRunActive,
	};
}
