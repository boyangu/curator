// SyncFromRekordboxModal — explicit "pull from Rekordbox" flow from a per-track,
// per-playlist, or per-folder context menu. The pull-direction mirror of
// SyncToRekordboxModal: re-read the selection from master.db and merge it into
// Curator (last-modified-wins), pausing on both-sides-changed conflicts.
//
// Three visible states (no verify-failed — a pull never writes to master.db):
//   idle       — checkbox form (data classes to pull). Sync button gated on
//                rb-not-running, same as the push modal (pyrekordbox can read a
//                live db but a concurrent write session is the real hazard; we
//                keep the gate symmetric so the two flows behave identically).
//   in-flight  — progress line off the shared import event stream.
//   conflicts  — the merge found both-sides-changed rows; per-row
//                Curator-vs-Rekordbox picks, then "Apply" writes the chosen side
//                into Curator (no push). Dismissable — conflicts are persisted
//                rows and re-surface on the next pull.
//
// Scope semantics differ from the push modal: every checkbox here maps to a
// readable rb data class, so none are "coming soon". Tags are intentionally
// absent — the per-tag membership model can't be scoped to a track subset
// without stripping the tag from untargeted tracks (see service.syncFromRekordbox).

import { createSignal, Show } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { render } from 'solid-js/web';
import type { SyncConflict, SyncConflictChoice } from '@curator/shared';
import { SyncConflictList } from './SyncConflictList.jsx';
import { registerModalOpenSignal } from '../modalGate.js';
import { createProgressTracker, SYNC_FROM_REKORDBOX_PLAN } from '../features/rekordboxSyncProgress.js';

// The data classes a scoped pull can read. Maps onto RekordboxFlags at the wire
// boundary (syncMyTags is always false — see the module header).
export interface PullFlags {
	// DjmdContent field merge: Title/Artist/Album/Label/Genre/BPM/Key/Rating/
	// Comment/Color/playCount/lastPlayedAt. → RekordboxFlags.syncTracks.
	syncMetadata: boolean;
	// Hot + memory cues, beatgrid, and PSSI phrases (one ANLZ load).
	// → RekordboxFlags.syncCuesGridsPhrases.
	syncCuesGridsPhrases: boolean;
	// rb_*.cpk waveform bands. → RekordboxFlags.syncWaveformPeaks.
	syncWaveform: boolean;
	// Playlist row(s) + ordered membership. Effective only for playlist/folder
	// targets; disabled for a bare track selection (no playlist context).
	// → RekordboxFlags.syncPlaylists.
	syncPlaylists: boolean;
}

export const DEFAULT_PULL_FLAGS: PullFlags = {
	syncMetadata: true,
	syncCuesGridsPhrases: true,
	syncWaveform: true,
	syncPlaylists: true,
};

// Wire shape for the target — kind/ids tuple echoed to the IPC call.
//   kind='tracks'   — one or many curator track ids.
//   kind='playlist' — exactly one curator rb-playlist id at ids[0].
//   kind='folder'   — exactly one curator rb-folder id at ids[0]; the service
//                     expands it to every descendant playlist.
export interface PullTarget {
	kind: 'tracks' | 'playlist' | 'folder';
	ids: string[];
	displayName: string;
}

export interface SyncFromRekordboxModalProps {
	// Fires when the user clicks Sync (idle → in-flight). The caller runs the
	// IPC call and drives the modal via setProgress/setConflicts/close.
	onSubmit(target: PullTarget, flags: PullFlags): void;
	// Cancel / backdrop / ESC — only in idle + conflicts (in-flight blocks).
	onClose(): void;
	// "Apply" from the conflicts view — every conflict has a decision. The
	// caller fires resolve-pull-conflicts; the modal closes on completion.
	onResolve(target: PullTarget, flags: PullFlags, resolutions: Array<{ conflictId: string; choice: SyncConflictChoice }>): void;
	loadFlags(): PullFlags;
	saveFlags(flags: PullFlags): void;
}

interface ModalState {
	kind: 'idle' | 'in-flight' | 'conflicts';
	phase?: string;
	done?: number;
	total?: number;
	// Overall percent across the whole pull; never moves backwards.
	pct?: number;
	conflicts?: SyncConflict[];
}

export interface SyncFromRekordboxModalHandle {
	destroy(): void;
	isOpen: Accessor<boolean>;
	open(target: PullTarget, isRekordboxRunning: boolean): void;
	close(): void;
	setRunning(isRekordboxRunning: boolean): void;
	setProgress(phase: string, done: number, total: number): void;
	setConflicts(conflicts: SyncConflict[]): void;
}

export function mountSyncFromRekordboxModal(
	host: HTMLElement,
	props: SyncFromRekordboxModalProps,
): SyncFromRekordboxModalHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [target, setTarget] = createSignal<PullTarget | null>(null);
	const [running, setRunning] = createSignal(false);
	const [state, setState] = createSignal<ModalState>({ kind: 'idle' });
	const [flags, setFlags] = createSignal<PullFlags>(props.loadFlags());
	const [choices, setChoices] = createSignal<Record<string, SyncConflictChoice>>({});

	const progress = createProgressTracker(SYNC_FROM_REKORDBOX_PLAN);

	const open = (tgt: PullTarget, isRekordboxRunning: boolean): void => {
		progress.reset();
		setTarget(tgt);
		setRunning(isRekordboxRunning);
		setFlags(props.loadFlags());
		setState({ kind: 'idle' });
		setIsOpen(true);
	};

	const close = (): void => {
		if (!isOpen()) return;
		setIsOpen(false);
		setState({ kind: 'idle' });
		props.onClose();
	};

	// in-flight blocks ESC + backdrop; idle + conflicts allow dismiss.
	const canDismiss = (): boolean => state().kind !== 'in-flight';

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key !== 'Escape' || !isOpen() || !canDismiss()) return;
		e.preventDefault();
		close();
	};
	document.addEventListener('keydown', onKeyDown);

	const toggleFlag = (key: keyof PullFlags, next: boolean): void => {
		const nextFlags = { ...flags(), [key]: next };
		setFlags(nextFlags);
		props.saveFlags(nextFlags);
	};

	const handleSync = (): void => {
		const tgt = target();
		if (!tgt) return;
		props.onSubmit(tgt, flags());
	};

	const renderIdle = (): JSX.Element => {
		const tgt = target();
		let subhead = '';
		if (tgt) {
			if (tgt.kind === 'playlist') subhead = `Playlist: ${tgt.displayName}`;
			else if (tgt.kind === 'folder') subhead = `Folder: ${tgt.displayName}`;
			else if (tgt.ids.length === 1) subhead = `Track: ${tgt.displayName}`;
			else subhead = tgt.displayName; // host formatted "N tracks"
		}
		return (
			<>
				<div class="sync-rb__sub">{subhead}</div>
				<div class="sync-rb__group">
					<label class="settings-toggle">
						<input
							type="checkbox"
							checked={flags().syncMetadata}
							onChange={(e) => toggleFlag('syncMetadata', e.currentTarget.checked)}
						/>
						<span class="settings-toggle__label">Metadata</span>
						<span class="settings-toggle__hint">Title, Artist, Album, Label, Genre, BPM, Key, Rating, Comment</span>
					</label>
					<label class="settings-toggle">
						<input
							type="checkbox"
							checked={flags().syncCuesGridsPhrases}
							onChange={(e) => toggleFlag('syncCuesGridsPhrases', e.currentTarget.checked)}
						/>
						<span class="settings-toggle__label">Cues, beatgrid &amp; phrases</span>
						<span class="settings-toggle__hint">Hot + memory cues, beatgrid, phrase analysis</span>
					</label>
					<label class="settings-toggle">
						<input
							type="checkbox"
							checked={flags().syncWaveform}
							onChange={(e) => toggleFlag('syncWaveform', e.currentTarget.checked)}
						/>
						<span class="settings-toggle__label">Waveform</span>
						<span class="settings-toggle__hint">Rekordbox waveform peaks</span>
					</label>
					{/* Playlists — effective only for playlist/folder targets; a bare
					    track selection has no playlist context, so it's disabled
					    (still visible so persisted state shows across contexts). */}
					{(() => {
						const isTracks = tgt?.kind === 'tracks';
						const hint = tgt?.kind === 'folder'
							? 'Every descendant playlist (names + track order)'
							: tgt?.kind === 'playlist'
								? 'This playlist (name + track order)'
								: 'Not applicable — no playlist context for a track selection';
						return (
							<label class="settings-toggle" classList={{ 'settings-toggle--disabled': isTracks }}>
								<input
									type="checkbox"
									checked={flags().syncPlaylists}
									disabled={isTracks}
									onChange={(e) => toggleFlag('syncPlaylists', e.currentTarget.checked)}
								/>
								<span class="settings-toggle__label">Playlists</span>
								<span class="settings-toggle__hint">{hint}</span>
							</label>
						);
					})()}
				</div>
				<Show when={running()}>
					<div class="sync-rb__warning">
						Rekordbox is open — close it to sync.
					</div>
				</Show>
				<footer class="modal__foot">
					<button type="button" class="btn-secondary" onClick={close}>Cancel</button>
					<button
						type="button"
						class="btn-primary"
						onClick={handleSync}
						disabled={running()}
					>Sync</button>
				</footer>
			</>
		);
	};

	// Reader-side phase names → user-readable labels.
	const PHASE_LABEL: Record<string, string> = {
		open: 'Opening Rekordbox',
		tracks: 'Reading tracks',
		cues: 'Reading cues',
		waveforms: 'Reading waveforms',
		grids: 'Reading beatgrids',
		playlists: 'Reading playlists',
		mytags: 'Reading tags',
		'cue-merge': 'Merging cues',
	};
	const phaseLabel = (phase: string): string => PHASE_LABEL[phase] ?? phase;

	// Bindings MUST read state() inline (Solid tracks signal reads in the JSX).
	const inFlightLabel = (): string => {
		const s = state();
		const phase = (s.kind === 'in-flight' ? s.phase : null) ?? 'starting';
		return `${phaseLabel(phase)}…`;
	};
	const inFlightDone = (): number => state().done ?? 0;
	const inFlightTotal = (): number => state().total ?? 0;
	// Overall progress across every step of the pull, not the current
	// sub-step's own done/total (see features/rekordboxSyncProgress.ts).
	const inFlightPct = (): number => state().pct ?? 0;

	const renderInFlight = (): JSX.Element => (
		<>
			<div class="sync-rb__sub">{inFlightLabel()}</div>
			<div class="sync-rb__progress">
				<div class="sync-rb__bar">
					<div class="sync-rb__bar-fill" style={{ width: `${inFlightPct()}%` }} />
				</div>
				<div class="sync-rb__progress-text">
					{inFlightTotal() > 0 ? `${inFlightDone()} / ${inFlightTotal()}` : ''}
				</div>
			</div>
		</>
	);

	const conflictList = (): SyncConflict[] => {
		const s = state();
		return s.kind === 'conflicts' ? s.conflicts ?? [] : [];
	};
	const allPicked = (): boolean => {
		const picks = choices();
		return conflictList().every((c) => picks[c.id] != null);
	};
	const pickAll = (choice: SyncConflictChoice): void => {
		const next: Record<string, SyncConflictChoice> = {};
		for (const c of conflictList()) next[c.id] = choice;
		setChoices(next);
	};
	const handleResolve = (): void => {
		const tgt = target();
		if (!tgt || !allPicked()) return;
		const picks = choices();
		const resolutions = conflictList().map((c) => ({ conflictId: c.id, choice: picks[c.id]! }));
		props.onResolve(tgt, flags(), resolutions);
	};

	const renderConflicts = (): JSX.Element => (
		<>
			<div class="sync-rb__sub">
				{`${conflictList().length} conflict${conflictList().length === 1 ? '' : 's'} — both apps changed these since the last sync`}
			</div>
			<div class="sync-conflicts__bulk">
				<button type="button" class="btn-secondary" onClick={() => pickAll('ours')}>Keep all Curator</button>
				<button type="button" class="btn-secondary" onClick={() => pickAll('theirs')}>Take all Rekordbox</button>
			</div>
			<SyncConflictList
				conflicts={conflictList()}
				providerLabel="Rekordbox"
				choices={choices}
				onPick={(id, choice) => setChoices((prev) => ({ ...prev, [id]: choice }))}
			/>
			<div class="sync-rb__warning sync-rb__warning--info">
				Cancelling keeps your conflicts — they'll re-surface on the next sync. Nothing is applied until you decide.
			</div>
			<footer class="modal__foot">
				<button type="button" class="btn-secondary" onClick={close}>Cancel</button>
				<button
					type="button"
					class="btn-primary"
					onClick={handleResolve}
					disabled={!allPicked()}
				>Apply</button>
			</footer>
		</>
	);

	const dispose = render(() => (
		<Show when={isOpen()}>
			<div
				class="modal-overlay"
				onMouseDown={(e) => {
					if (e.target !== e.currentTarget) return;
					if (!canDismiss()) return;
					close();
				}}
			>
				<div class="modal modal--sync-rb" role="dialog" aria-modal="true" aria-labelledby="sync-from-rb-title">
					<header class="modal__head">
						<h3 id="sync-from-rb-title">Sync from Rekordbox</h3>
						<Show when={canDismiss()}>
							<button
								class="modal__close"
								type="button"
								aria-label="Close"
								onClick={(e) => { e.preventDefault(); close(); }}
							>×</button>
						</Show>
					</header>
					<div class="modal__body">
						<Show when={state().kind === 'idle'}>{renderIdle()}</Show>
						<Show when={state().kind === 'in-flight'}>{renderInFlight()}</Show>
						<Show when={state().kind === 'conflicts'}>{renderConflicts()}</Show>
					</div>
				</div>
			</div>
		</Show>
	), host);

	return {
		destroy: () => {
			document.removeEventListener('keydown', onKeyDown);
			dispose();
		},
		isOpen,
		open,
		close,
		setRunning,
		setProgress: (phase, done, total) => {
			setState({ kind: 'in-flight', phase, done, total, pct: progress.update(phase, done, total) });
		},
		setConflicts: (conflicts) => {
			setChoices({});
			setState({ kind: 'conflicts', conflicts });
		},
	};
}
