// SyncToRekordboxModal — explicit "push to Rekordbox" flow from a per-track
// or per-playlist context menu.
//
// Five visible states, all in one modal so the user never bounces between
// dialogs:
//   idle           — checkbox form. Sync button gated on rb-not-running.
//   in-flight      — progress line; Sync + Cancel hidden, modal can't dismiss
//                    via backdrop until the run finishes.
//   conflicts      — the pipeline's pull phase found both-sides-changed
//                    divergences; per-row Curator-vs-Rekordbox picks, then
//                    "Continue sync" resumes the push. Dismissable —
//                    conflicts are persisted DB rows and re-surface on the
//                    next sync, so cancelling here loses nothing.
//   holds          — the push completed but the exporter's safety guards
//                    held some playlist removals/order changes (mass-removal
//                    breaker or unlinked members). A toast is too fleeting
//                    for a decision surface — this view lists the held
//                    playlists and offers "Push removals anyway" for the
//                    waivable mass-removal holds. Dismissable — holds
//                    re-detect on every push until resolved.
//   verify-failed  — restore-or-leave choice after a corrupted commit. The
//                    backup path that was taken pre-sync is shown so the user
//                    knows what they'd be reverting to.
//
// Per the locked v1 PRD scope: Metadata + Cues are user-checkable. Beatgrid +
// phrases + Waveform render as visible-disabled-with-tooltip so the user knows
// they're coming. Playlist scope is implicit when targetKind === 'playlist'
// (always pushed; the four checkboxes only gate the per-member scopes).

import { createSignal, Show, For } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { render } from 'solid-js/web';
import type { RekordboxRemovalHold, RekordboxVerifyFailure, RekordboxMissingFile } from '@curator/core';
import type { SyncConflict, SyncConflictChoice } from '@curator/shared';
import { SyncConflictList } from './SyncConflictList.jsx';
import { registerModalOpenSignal } from '../modalGate.js';
import { createProgressTracker, SYNC_TO_REKORDBOX_PLAN } from '../features/rekordboxSyncProgress.js';

export interface SyncFlags {
	// Bundles Title/Artist/Album/Label + Tags (DjmdSongMyTag). Spec
	// section 5.a — one checkbox, two underlying scopes.
	syncMetadata: boolean;
	// DjmdCue rows for hot + memory cues. Today this is functionally
	// re-pushing what we read from rb (no Curator-side cue editor yet);
	// once the editor lands, becomes a real bidirectional surface.
	syncCues: boolean;
	// Push the playlist row(s) + ordered membership. Effective only when
	// the target implies a playlist scope ('playlist' / 'folder' / 'updates');
	// the modal disables the checkbox for the 'tracks' target since there's
	// no playlist context to push. Previously hard-coded by the dispatch
	// in main.ts (derived from target.kind); exposing it gives the user
	// the "update metadata only, leave playlist rows alone" lever.
	syncPlaylist: boolean;
	// Both ANLZ-touching scopes — visible-disabled in v1, kept in the
	// shape for forward-compat so v2 doesn't need to ship a new key.
	syncBeatgridPhrases: boolean;
	syncWaveform: boolean;
}

export const DEFAULT_SYNC_FLAGS: SyncFlags = {
	syncMetadata: true,
	syncCues: true,
	syncPlaylist: true,
	syncBeatgridPhrases: false,
	syncWaveform: false,
};

// Wire shape for the target — same kind/ids tuple used by the IPC call so
// the modal can echo it back without the host needing parallel state.
//   kind='tracks'   — one or many curator track ids (single-row context menu
//                     passes length 1; multi-select passes the whole selection).
//   kind='playlist' — exactly one curator playlist id at ids[0].
//   kind='folder'   — exactly one curator playlist_folder id at ids[0].
//                     Resolved recursively to descendant rb playlists by the
//                     exporter; the modal just echoes the folder display name.
//   kind='updates'  — incremental sweep from the Rekordbox source-tab
//                     right-click. The exporter ignores `ids` and resolves
//                     to every rb-linked track whose Curator row has
//                     changed since the last sync, plus every non-smart
//                     non-hidden rb playlist.
export interface SyncTarget {
	kind: 'tracks' | 'playlist' | 'folder' | 'updates';
	ids: string[];
	displayName: string;
	// What this sync will CREATE in rekordbox (Convert-to-WAV playlists,
	// "Add to Rekordbox" selections) — resolved by the host before open,
	// shown in the idle view.
	createNotice?: string | null;
	// 'tracks' only: create the selected tracks rekordbox doesn't have yet
	// (the "Add to Rekordbox" command). Plain "Sync to Rekordbox…" stays
	// update-only.
	createMissing?: boolean;
}

export interface SyncToRekordboxModalProps {
	// Submit handler. Fires when the user clicks Sync. The caller runs
	// the actual IPC call; the modal then transitions to in-flight via
	// setProgress() and eventually setVerifyFailed() or close() based on
	// the result. `removeMissingFileIds` carries the orphaned-track ids the
	// user chose to clean up (empty unless the missing-file section was shown
	// and left checked) — the host deletes those first, then runs the sync so
	// their content_delete ops ride the same push.
	onSubmit(target: SyncTarget, flags: SyncFlags, removeMissingFileIds: string[]): void;
	// Cancel / backdrop / ESC. Only fires when in `idle` — the in-flight
	// and verify-failed states have their own button.
	onClose(): void;
	// Restore button from the verify-failed view. The caller does the
	// IPC + post-restore cleanup; the modal closes after the promise
	// settles either way.
	onRestore(backupPath: string): Promise<void>;
	// "Continue sync" from the conflicts view — every conflict has a
	// decision. The caller fires 'sync:resolve-conflicts' with the echoed
	// target + flags; the modal transitions back to in-flight via
	// setProgress() as push events arrive.
	onResolve(target: SyncTarget, flags: SyncFlags, resolutions: Array<{ conflictId: string; choice: SyncConflictChoice }>): void;
	// "Push removals anyway" from the holds view — re-runs the push with the
	// mass-removal breaker waived for exactly these rb playlist ids
	// (unlinked-members holds are not waivable and stay held). The caller
	// re-enters the pipeline; the modal transitions back to in-flight via
	// setProgress().
	onPushAnyway(target: SyncTarget, flags: SyncFlags, rbPlaylistIds: string[]): void;
	// Load/save persisted flag state. Keeps the modal stateless w.r.t.
	// storage so the host file can decide where to persist.
	loadFlags(): SyncFlags;
	saveFlags(flags: SyncFlags): void;
}

interface ModalState {
	kind: 'idle' | 'in-flight' | 'conflicts' | 'holds' | 'verify-failed';
	// idle/in-flight: progress strip data
	phase?: string;
	done?: number;
	total?: number;
	// Overall percent across the whole sync; never moves backwards.
	pct?: number;
	// conflicts: open both-sides-changed rows from the pull phase
	conflicts?: SyncConflict[];
	// holds: safety-guard holds from an otherwise-successful push, plus the
	// success summary the host would have toasted (shown inline instead so
	// the user still sees what DID land).
	holds?: RekordboxRemovalHold[];
	holdsSummary?: { title: string; sub?: string };
	// verify-failed: failure data
	pragmaError?: string | null;
	failures?: RekordboxVerifyFailure[];
	backupPath?: string;
}

export interface SyncToRekordboxModalHandle {
	destroy(): void;
	isOpen: Accessor<boolean>;
	// Open in the `idle` state. `isRekordboxRunning` gates the Sync button —
	// caller polls detect periodically and pushes updates via setRunning().
	// `missingFiles` are orphaned rb tracks whose local file is gone; when
	// non-empty the idle view shows a checked-by-default cleanup section.
	open(target: SyncTarget, isRekordboxRunning: boolean, missingFiles: RekordboxMissingFile[]): void;
	close(): void;
	// Update the rb-running gate without reopening (e.g. user closed rb
	// while the modal was open).
	setRunning(isRekordboxRunning: boolean): void;
	// Switch to in-flight + update the progress strip.
	setProgress(phase: string, done: number, total: number): void;
	// Switch to the conflict-resolution view (pull found divergences).
	setConflicts(conflicts: SyncConflict[]): void;
	// Switch to the held-changes view (push completed, guards held removals).
	setHolds(args: { holds: RekordboxRemovalHold[]; summary: { title: string; sub?: string } }): void;
	// Switch to verify-failed view.
	setVerifyFailed(args: { pragmaError: string | null; failures: RekordboxVerifyFailure[]; backupPath: string }): void;
}

export function mountSyncToRekordboxModal(
	host: HTMLElement,
	props: SyncToRekordboxModalProps,
): SyncToRekordboxModalHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [target, setTarget] = createSignal<SyncTarget | null>(null);
	const [running, setRunning] = createSignal(false);
	const [state, setState] = createSignal<ModalState>({ kind: 'idle' });
	const [flags, setFlags] = createSignal<SyncFlags>(props.loadFlags());
	// conflictId → user's pick. Reset whenever a fresh conflict set arrives.
	const [choices, setChoices] = createSignal<Record<string, SyncConflictChoice>>({});
	// Orphaned rb tracks (missing local file) surfaced for cleanup, plus the
	// user's opt (checked by default when any exist — the whole point is to
	// clear them, but they can uncheck to sync without deleting).
	const [missingFiles, setMissingFiles] = createSignal<RekordboxMissingFile[]>([]);
	const [removeMissing, setRemoveMissing] = createSignal(true);

	const progress = createProgressTracker(SYNC_TO_REKORDBOX_PLAN);

	const open = (tgt: SyncTarget, isRekordboxRunning: boolean, missing: RekordboxMissingFile[]): void => {
		progress.reset();
		setTarget(tgt);
		setRunning(isRekordboxRunning);
		// Reload flags every open — picks up changes the user made in
		// another modal session, plus migrations bumped by other code.
		setFlags(props.loadFlags());
		setMissingFiles(missing);
		setRemoveMissing(missing.length > 0);
		setState({ kind: 'idle' });
		setIsOpen(true);
	};

	const close = (): void => {
		if (!isOpen()) return;
		setIsOpen(false);
		setState({ kind: 'idle' });
		props.onClose();
	};

	// Track-when-can-dismiss: in-flight blocks ESC + backdrop. Verify-
	// failed allows close — the user gets "Leave as is" semantics either
	// way (the restore path is the affirmative choice).
	const canDismiss = (): boolean => state().kind !== 'in-flight';

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key !== 'Escape' || !isOpen() || !canDismiss()) return;
		e.preventDefault();
		close();
	};
	document.addEventListener('keydown', onKeyDown);

	const toggleFlag = (key: keyof SyncFlags, next: boolean): void => {
		const nextFlags = { ...flags(), [key]: next };
		setFlags(nextFlags);
		props.saveFlags(nextFlags);
	};

	const handleSync = (): void => {
		const tgt = target();
		if (!tgt) return;
		const removeIds = removeMissing() ? missingFiles().map((m) => m.trackId) : [];
		props.onSubmit(tgt, flags(), removeIds);
	};

	const handleRestore = async (): Promise<void> => {
		const s = state();
		if (s.kind !== 'verify-failed' || !s.backupPath) return;
		try {
			await props.onRestore(s.backupPath);
		} finally {
			close();
		}
	};

	const renderIdle = (): JSX.Element => {
		const tgt = target();
		// Subhead naming:
		//   tracks/1   → "Track: <title>"
		//   tracks/N>1 → "<N> tracks"
		//   playlist   → "Playlist: <name>"
		//   folder     → "Folder: <name>"
		//   updates    → "Updates since last sync" (host echoes the same string
		//                in displayName for consistency)
		let subhead = '';
		if (tgt) {
			if (tgt.kind === 'playlist') {
				subhead = `Playlist: ${tgt.displayName}`;
			} else if (tgt.kind === 'folder') {
				subhead = `Folder: ${tgt.displayName}`;
			} else if (tgt.kind === 'updates') {
				subhead = tgt.displayName;
			} else if (tgt.ids.length === 1) {
				subhead = `Track: ${tgt.displayName}`;
			} else {
				subhead = tgt.displayName; // host already formatted "N tracks"
			}
		}
		return (
			<>
				<div class="sync-rb__sub">{subhead}</div>
				<Show when={tgt?.createNotice}>
					<div class="sync-rb__warning sync-rb__warning--info">{tgt!.createNotice}</div>
				</Show>
				<div class="sync-rb__group">
					<label class="settings-toggle">
						<input
							type="checkbox"
							checked={flags().syncMetadata}
							onChange={(e) => toggleFlag('syncMetadata', e.currentTarget.checked)}
						/>
						<span class="settings-toggle__label">Metadata</span>
						<span class="settings-toggle__hint">Title, Artist, Album, Label, Genre, Tags (+ MyTag comment block)</span>
					</label>
					<label class="settings-toggle settings-toggle--disabled" title="Coming soon — v1 ships master.db scopes only.">
						<input
							type="checkbox"
							checked={flags().syncBeatgridPhrases}
							disabled
						/>
						<span class="settings-toggle__label">Beatgrid + phrases</span>
						<span class="settings-toggle__hint">Coming soon</span>
					</label>
					<label class="settings-toggle">
						<input
							type="checkbox"
							checked={flags().syncCues}
							onChange={(e) => toggleFlag('syncCues', e.currentTarget.checked)}
						/>
						<span class="settings-toggle__label">Cues</span>
						<span class="settings-toggle__hint">Hot + memory cues</span>
					</label>
					{/* Playlists toggle. Effective only when the target implies a
					    playlist scope; the 'tracks' kind has no playlist context
					    so the checkbox is disabled (still visible so the user
					    sees its persisted state when they switch contexts). The
					    label hint adapts to the kind so the user understands
					    what gets pushed: a single playlist row, every descendant
					    under a folder, or every rb playlist for an updates sweep. */}
					{(() => {
						const isTracks = tgt?.kind === 'tracks';
						const hint = tgt?.kind === 'folder'
							? 'Every non-smart playlist under this folder (names + track order)'
							: tgt?.kind === 'updates'
								? 'Every non-smart rb playlist (writer no-ops unchanged ones)'
								: tgt?.kind === 'playlist'
									? 'This playlist (name + track order)'
									: 'Not applicable — no playlist context for direct track sync';
						return (
							<label class="settings-toggle" classList={{ 'settings-toggle--disabled': isTracks }}>
								<input
									type="checkbox"
									checked={flags().syncPlaylist}
									disabled={isTracks}
									onChange={(e) => toggleFlag('syncPlaylist', e.currentTarget.checked)}
								/>
								<span class="settings-toggle__label">Playlists</span>
								<span class="settings-toggle__hint">{hint}</span>
							</label>
						);
					})()}
					<label class="settings-toggle settings-toggle--disabled" title="Coming soon — v1 ships master.db scopes only.">
						<input
							type="checkbox"
							checked={flags().syncWaveform}
							disabled
						/>
						<span class="settings-toggle__label">Waveform</span>
						<span class="settings-toggle__hint">Coming soon</span>
					</label>
				</div>
				<Show when={missingFiles().length > 0}>
					{(() => {
						const n = missingFiles().length;
						const shown = missingFiles().slice(0, MISSING_SHOWN);
						const more = n - shown.length;
						return (
							<div class="sync-rb__error-block">
								<label class="settings-toggle">
									<input
										type="checkbox"
										checked={removeMissing()}
										onChange={(e) => setRemoveMissing(e.currentTarget.checked)}
									/>
									<span class="settings-toggle__label">
										{`Remove ${n} track${n === 1 ? '' : 's'} with missing files`}
									</span>
									<span class="settings-toggle__hint">
										In Rekordbox but the local file is gone — delete from Rekordbox on this sync
									</span>
								</label>
								<ul class="sync-rb__error-list">
									<For each={shown}>
										{(m) => <li>{m.artist ? `${m.artist} — ${m.title}` : m.title}</li>}
									</For>
									<Show when={more > 0}>
										<li class="sync-rb__error-more">{`…and ${more} more`}</li>
									</Show>
								</ul>
							</div>
						);
					})()}
				</Show>
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

	// Friendlier phase labels — the wire names (resolve/backup/write/verify)
	// are coder-ish; map to user-readable strings. Pull-phase events arrive
	// prefixed 'pull:<reader phase>' from the pipeline's re-emit.
	const PHASE_LABEL: Record<string, string> = {
		resolve: 'Resolving tracks',
		backup: 'Backing up master.db',
		write: 'Writing to Rekordbox',
		commit: 'Saving rekordbox library',
		verify: 'Verifying',
		'cue-merge': 'Merging changes',
		'create:backup': 'Backing up master.db',
		'create:write': 'Creating tracks in Rekordbox',
		'create:verify': 'Verifying new tracks',
	};
	const phaseLabel = (phase: string): string => {
		if (phase.startsWith('pull:')) return 'Pulling from Rekordbox';
		return PHASE_LABEL[phase] ?? phase;
	};

	// Critical: the bindings below MUST read state() inline (plain getters,
	// called from the JSX) — Solid only tracks signal reads inside the JSX,
	// not values captured into local variables. Earlier this function
	// pre-computed `phase`/`done`/`total` and the JSX never updated past the
	// first 'started' event because Show's enclosing condition stayed truthy.
	const inFlightLabel = (): string => {
		const s = state();
		const phase = (s.kind === 'in-flight' ? s.phase : null) ?? 'starting';
		return `${phaseLabel(phase)}…`;
	};
	const inFlightDone = (): number => state().done ?? 0;
	const inFlightTotal = (): number => state().total ?? 0;
	// Overall progress across every step of the sync, not the current
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
				Cancelling keeps your conflicts — they'll re-surface on the next sync. Nothing is pushed until you decide.
			</div>
			<footer class="modal__foot">
				<button type="button" class="btn-secondary" onClick={close}>Cancel</button>
				<button
					type="button"
					class="btn-primary"
					onClick={handleResolve}
					disabled={!allPicked()}
				>Continue sync</button>
			</footer>
		</>
	);

	// ── Held-changes view ──
	// The push itself succeeded; these are the guard refusals. Split by
	// reason because the remedies differ: mass-removal is user-waivable
	// ("Push removals anyway" re-runs with allowMassRemovalFor), while
	// unlinked-members can only be fixed by a read sync repairing the links.
	const holdsList = (): RekordboxRemovalHold[] => {
		const s = state();
		return s.kind === 'holds' ? s.holds ?? [] : [];
	};
	const massHolds = (): RekordboxRemovalHold[] => holdsList().filter((h) => h.reason === 'mass-removal');
	const unlinkedHolds = (): RekordboxRemovalHold[] => holdsList().filter((h) => h.reason === 'unlinked-members');
	const handlePushAnyway = (): void => {
		const tgt = target();
		if (!tgt) return;
		props.onPushAnyway(tgt, flags(), massHolds().map((h) => h.rbPlaylistId));
	};
	// A hold with zero computed removals is an order-change hold (Curator
	// reordered while members were unlinked) — name it as such.
	const holdLabel = (h: RekordboxRemovalHold): string =>
		h.heldRemovals > 0
			? `${h.playlistName} — ${h.heldRemovals} removal${h.heldRemovals === 1 ? '' : 's'} held`
			: `${h.playlistName} — order change held`;
	// Softer phrasing for the unlinked group — these aren't refusals the
	// user must act on, they're changes queued behind a download.
	const waitingLabel = (h: RekordboxRemovalHold): string =>
		h.heldRemovals > 0
			? `${h.playlistName} — ${h.heldRemovals} removal${h.heldRemovals === 1 ? '' : 's'} waiting`
			: `${h.playlistName} — track order waiting`;
	const unlinkedTrackLine = (t: RekordboxRemovalHold['unlinkedTracks'][number]): string =>
		t.artist ? `${t.artist} — ${t.title}` : t.title;
	const UNLINKED_SHOWN = 6;
	const MISSING_SHOWN = 6;

	const renderHolds = (): JSX.Element => {
		const s = state();
		const summary = s.kind === 'holds' ? s.holdsSummary : undefined;
		return (
			<>
				<div class="sync-rb__sub">
					{summary?.title ?? 'Synced to Rekordbox'}
					{summary?.sub ? ` · ${summary.sub}` : ''}
				</div>
				<Show when={massHolds().length > 0}>
					<div class="sync-rb__error-block">
						<div class="sync-rb__error-head">Held — unusually large removal</div>
						<ul class="sync-rb__error-list">
							<For each={massHolds()}>
								{(h) => <li>{holdLabel(h)}</li>}
							</For>
						</ul>
						<div class="sync-rb__hold-hint">
							Nothing was deleted. Removing this many tracks in one push is likelier
							corruption than curation, so it waits for you — if you meant it, push
							the removals below.
						</div>
					</div>
				</Show>
				<Show when={unlinkedHolds().length > 0}>
					<div class="sync-rb__error-block">
						<div class="sync-rb__error-head">Waiting for tracks to reach Rekordbox</div>
						<For each={unlinkedHolds()}>
							{(h) => (
								<div class="sync-rb__hold-group">
									<div class="sync-rb__hold-playlist">{waitingLabel(h)}</div>
									<ul class="sync-rb__error-list">
										<For each={h.unlinkedTracks.slice(0, UNLINKED_SHOWN)}>
											{(t) => (
												<li>
													{unlinkedTrackLine(t)}
													<span class="sync-rb__hold-badge">
														{t.hasFile ? 'downloaded — not in Rekordbox yet' : 'not downloaded yet'}
													</span>
												</li>
											)}
										</For>
										<Show when={h.unlinkedTracks.length > UNLINKED_SHOWN}>
											<li class="sync-rb__error-more">{`…and ${h.unlinkedTracks.length - UNLINKED_SHOWN} more`}</li>
										</Show>
									</ul>
								</div>
							)}
						</For>
						<div class="sync-rb__hold-hint">
							Nothing was deleted and nothing is lost. These playlists contain tracks
							that aren't in Rekordbox yet, so their removals and reorders are on
							hold. Once the tracks above are downloaded and added to Rekordbox as
							files (a read sync links them up), the held changes will go through on
							your next sync.
						</div>
					</div>
				</Show>
				<div class="sync-rb__warning sync-rb__warning--info">
					Held changes re-surface on every sync until they can go through — closing this loses nothing.
				</div>
				<footer class="modal__foot">
					<button type="button" class="btn-secondary" onClick={close}>Close</button>
					<Show when={massHolds().length > 0}>
						<button
							type="button"
							class="btn-primary"
							onClick={handlePushAnyway}
						>Push removals anyway</button>
					</Show>
				</footer>
			</>
		);
	};

	const renderVerifyFailed = (): JSX.Element => {
		const s = state();
		const failures = s.failures ?? [];
		const pragmaError = s.pragmaError;
		const shown = failures.slice(0, 6);
		const more = Math.max(0, failures.length - shown.length);
		return (
			<>
				<div class="sync-rb__sub sync-rb__sub--error">Sync verification failed</div>
				<Show when={pragmaError}>
					<div class="sync-rb__error-block">
						<div class="sync-rb__error-head">Database integrity check:</div>
						<div class="sync-rb__error-body">{pragmaError}</div>
					</div>
				</Show>
				<Show when={failures.length > 0}>
					<div class="sync-rb__error-block">
						<div class="sync-rb__error-head">{`${failures.length} row${failures.length === 1 ? '' : 's'} failed verification:`}</div>
						<ul class="sync-rb__error-list">
							<For each={shown}>
								{(f) => <li><code>{f.kind}</code> {f.target_label ?? f.target ?? '?'} — {f.error}</li>}
							</For>
							<Show when={more > 0}>
								<li class="sync-rb__error-more">{`…and ${more} more`}</li>
							</Show>
						</ul>
					</div>
				</Show>
				<div class="sync-rb__warning">
					Restoring reverts EVERY write from this sync — including ones that verified successfully.
				</div>
				<footer class="modal__foot">
					<button type="button" class="btn-secondary" onClick={close}>Leave as is</button>
					<button
						type="button"
						class="btn-primary"
						onClick={() => { void handleRestore(); }}
					>Restore previous version</button>
				</footer>
			</>
		);
	};

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
				<div class="modal modal--sync-rb" role="dialog" aria-modal="true" aria-labelledby="sync-rb-title">
					<header class="modal__head">
						<h3 id="sync-rb-title">Sync to Rekordbox</h3>
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
						<Show when={state().kind === 'holds'}>{renderHolds()}</Show>
						<Show when={state().kind === 'verify-failed'}>{renderVerifyFailed()}</Show>
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
		setHolds: (args) => {
			setState({ kind: 'holds', holds: args.holds, holdsSummary: args.summary });
		},
		setVerifyFailed: (args) => {
			setState({
				kind: 'verify-failed',
				pragmaError: args.pragmaError,
				failures: args.failures,
				backupPath: args.backupPath,
			});
		},
	};
}
