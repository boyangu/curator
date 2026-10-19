// WavConvertDialog — live status for a Convert to WAV run. Opens the moment
// the user confirms and stays up for the whole run: overall progress, the
// track being converted, failures as they happen, then a summary with a way
// into the "[WAV]" playlist. The run itself lives in core; this is a pure
// consumer of the wav:convert-event stream (fed by main.ts).
//
// Hiding is not cancelling: Esc / backdrop / "Run in background" only close
// the dialog — the inline indicator keeps showing progress, and reopening
// "Convert to WAV…" on any playlist while the run is active brings it back.
// Stop is the only cancel.

import { createSignal, For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import type { WavConvertEvent, WavConvertResult } from '@curator/core';
import { registerModalOpenSignal } from '../modalGate.js';

interface RunState {
	runId: string | null;            // null until 'started' lands
	playlistId: string;
	sourceName: string;
	total: number;
	done: number;
	currentTitle: string | null;
	failures: Array<{ title: string; message: string }>;
	result: WavConvertResult | null;
	error: string | null;            // run-level failure
	stopping: boolean;
}

export interface WavConvertDialogProps {
	onStop(runId: string): void;
	onOpenPlaylist(playlistId: string): void;
	// Hand the "[WAV]" playlist to the Sync to Rekordbox flow.
	onImportToRekordbox(playlistId: string): void;
}

export interface WavConvertDialogHandle {
	destroy(): void;
	isOpen: Accessor<boolean>;
	// Show immediately on confirm (before core's 'started' arrives).
	begin(playlistId: string, sourceName: string): void;
	handleEvent(evt: WavConvertEvent): void;
	// Re-show a run in progress (or its unacknowledged summary). False when
	// there is nothing to show.
	reopen(): boolean;
	isRunActive(): boolean;
}

export function mountWavConvertDialog(host: HTMLElement, props: WavConvertDialogProps): WavConvertDialogHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [run, setRun] = createSignal<RunState | null>(null);

	const finished = (): boolean => { const r = run(); return !!r && (r.result != null || r.error != null); };
	const hide = (): void => { setIsOpen(false); if (finished()) setRun(null); };
	const patch = (p: Partial<RunState>): void => { const r = run(); if (r) setRun({ ...r, ...p }); };

	const begin = (playlistId: string, sourceName: string): void => {
		setRun({ runId: null, playlistId, sourceName, total: 0, done: 0, currentTitle: null, failures: [], result: null, error: null, stopping: false });
		setIsOpen(true);
	};

	const handleEvent = (evt: WavConvertEvent): void => {
		let r = run();
		// A run started elsewhere (or after a reload) — adopt it without
		// popping a dialog the user didn't ask for.
		if (!r || (r.runId != null && r.runId !== evt.runId) || r.playlistId !== evt.playlistId) {
			if (evt.kind !== 'started') return;
			setRun({ runId: evt.runId, playlistId: evt.playlistId, sourceName: '', total: evt.total, done: 0, currentTitle: null, failures: [], result: null, error: null, stopping: false });
			return;
		}
		if (evt.kind === 'started') patch({ runId: evt.runId, total: evt.total });
		else if (evt.kind === 'progress') patch({ done: evt.done, total: evt.total, currentTitle: evt.currentTitle });
		else if (evt.kind === 'trackFailed') { r = run()!; patch({ failures: [...r.failures, { title: evt.title, message: evt.message }] }); }
		else if (evt.kind === 'completed') patch({ result: evt.result, done: run()!.total, currentTitle: null });
		else if (evt.kind === 'failed') patch({ error: evt.message, currentTitle: null });
		// A backgrounded run that finished has nothing left to show once the
		// caller's toast takes over.
		if ((evt.kind === 'completed' || evt.kind === 'failed') && !isOpen()) setRun(null);
	};

	const reopen = (): boolean => { if (!run()) return false; setIsOpen(true); return true; };
	const isRunActive = (): boolean => !!run() && !finished();

	const stop = (): void => {
		const r = run();
		if (!r?.runId || r.stopping) return;
		patch({ stopping: true });
		props.onStop(r.runId);
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (!isOpen() || e.key !== 'Escape') return;
		e.preventDefault(); e.stopPropagation();
		hide();
	};
	document.addEventListener('keydown', onKeyDown, true);

	const pct = (): number => { const r = run(); return r && r.total > 0 ? Math.min(100, Math.round((r.done / r.total) * 100)) : 0; };
	const title = (): string => {
		const r = run();
		if (!r) return '';
		if (r.error) return 'Conversion failed';
		if (r.result) return r.result.cancelled ? 'Conversion stopped' : r.result.failed > 0 ? 'Converted, with errors' : 'Converted to WAV';
		return r.stopping ? 'Stopping…' : 'Converting to WAV';
	};
	const summary = (res: WavConvertResult): string => [
		res.converted ? `${res.converted} converted` : '',
		res.reused ? `${res.reused} already converted` : '',
		res.kept ? `${res.kept} kept as-is` : '',
		res.skipped ? `${res.skipped} skipped (no local file)` : '',
		res.failed ? `${res.failed} failed` : '',
	].filter(Boolean).join(' · ') || 'Nothing to do';

	const dispose = render(() => (
		<Show when={isOpen() && run()}>
			{(r) => (
				<div class="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) hide(); }}>
					<div class="modal wav-convert" role="dialog" aria-modal="true" aria-labelledby="wav-convert-title">
						<header class="modal__head">
							<h3 id="wav-convert-title">{title()}</h3>
							<button class="modal__close" type="button" aria-label="Hide" onClick={(e) => { e.preventDefault(); hide(); }}>×</button>
						</header>
						<div class="modal__body">
							<Show when={r().sourceName}>
								<div class="wav-convert__sub">{`Playlist: ${r().sourceName}`}</div>
							</Show>
							<Show when={!r().result && !r().error}>
								<div class="sync-rb__progress">
									<div class="sync-rb__bar"><div class="sync-rb__bar-fill" style={{ width: `${pct()}%` }} /></div>
									<div class="sync-rb__progress-text">{r().runId ? `${Math.floor(r().done)} / ${r().total}` : 'Starting…'}</div>
								</div>
								<div class="wav-convert__current">{r().currentTitle ?? (r().runId ? 'Preparing…' : 'Reading the playlist…')}</div>
							</Show>
							<Show when={r().result}>
								{(res) => (
									<>
										<p class="wav-convert__summary">{summary(res())}</p>
										<div class="wav-convert__dir">{res().outputDir}</div>
										<Show when={res().playlistId && !res().cancelled}>
											<div class="wav-convert__next">
												<div class="wav-convert__next-head">Next: add them to Rekordbox</div>
												{res().playlistId.startsWith('rb_')
													? 'This playlist is already in Rekordbox. Syncing adds the new WAV tracks to it, with their originals\' beatgrid, waveform, phrases and cues.'
													: 'Importing creates these WAVs as new tracks in Rekordbox, copying each original\'s beatgrid, waveform and phrases so nothing needs re-analysing, then pushes cues, tags and ratings and creates the playlist.'}
												{' Rekordbox must be closed. A backup of its database is taken first.'}
											</div>
										</Show>
									</>
								)}
							</Show>
							<Show when={r().error}>
								<p class="wav-convert__error">{r().error}</p>
							</Show>
							<Show when={r().failures.length > 0}>
								<div class="sync-rb__error-block wav-convert__failures">
									<div class="sync-rb__error-head">{`${r().failures.length} failed`}</div>
									<ul class="sync-rb__error-list">
										<For each={r().failures}>{(f) => <li><strong>{f.title}</strong> — <code>{f.message}</code></li>}</For>
									</ul>
								</div>
							</Show>
						</div>
						<footer class="modal__foot">
							<Show when={!r().result && !r().error} fallback={
								<>
									<button type="button" class="btn-secondary" onClick={(e) => { e.preventDefault(); hide(); }}>Close</button>
									<Show when={r().result?.playlistId}>
										<button type="button" class="btn-secondary" onClick={(e) => {
											e.preventDefault();
											const id = r().result!.playlistId;
											hide();
											props.onOpenPlaylist(id);
										}}>Open playlist</button>
									</Show>
									<Show when={r().result?.playlistId && !r().result?.cancelled}>
										<button type="button" class="btn-primary" onClick={(e) => {
											e.preventDefault();
											const id = r().result!.playlistId;
											hide();
											props.onImportToRekordbox(id);
										}}>{r().result!.playlistId.startsWith('rb_') ? 'Sync to Rekordbox…' : 'Import to Rekordbox…'}</button>
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
