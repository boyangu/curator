// BackupRestoreDialog — choose what to bring back from a snapshot. Loads the
// preview (per-set contents, origin machine, rekordbox state), lets the user
// pick data sets and where audio files go, then hands a BackupRestoreRequest
// to the caller, who confirms (danger) and starts the run.
//
// Curator data sets are applied at the next launch; rekordbox sets need
// rekordbox closed; audio files restore in place or under a new root.

import { createSignal, For, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { render } from 'solid-js/web';
import type { BackupRestorePreview, BackupRestoreRequest, BackupSetId, BackupSnapshotSummary } from '@curator/core';
import { BACKUP_SET_IDS, BACKUP_SET_LABELS } from '@curator/shared';
import { backupApi, dialogApi } from '../data/api.js';
import { registerModalOpenSignal } from '../modalGate.js';
import { formatBytes } from '../ui/format.js';

export interface BackupRestoreDialogProps {
	onSubmit(req: BackupRestoreRequest, preview: BackupRestorePreview): void;
}

export interface BackupRestoreDialogHandle {
	destroy(): void;
	isOpen: Accessor<boolean>;
	open(snapshot: BackupSnapshotSummary): void;
	close(): void;
}

const CURATOR_SETS: readonly BackupSetId[] = ['core', 'peaks', 'embeddings', 'covers'];
const RB_SETS: readonly BackupSetId[] = ['rekordboxDb', 'rekordboxAnalysis'];

export function mountBackupRestoreDialog(host: HTMLElement, props: BackupRestoreDialogProps): BackupRestoreDialogHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [snapshot, setSnapshot] = createSignal<BackupSnapshotSummary | null>(null);
	const [preview, setPreview] = createSignal<BackupRestorePreview | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [chosen, setChosen] = createSignal<Set<BackupSetId>>(new Set());
	const [tracksMode, setTracksMode] = createSignal<'original' | 'root'>('original');
	const [tracksRoot, setTracksRoot] = createSignal<string>('');

	const open = (sn: BackupSnapshotSummary): void => {
		setSnapshot(sn);
		setPreview(null);
		setError(null);
		setIsOpen(true);
		backupApi.restorePreview(sn.id).then((p) => {
			if (!isOpen()) return;
			setPreview(p);
			// Default: everything the snapshot has except audio files (large,
			// and usually still on disk).
			setChosen(new Set(BACKUP_SET_IDS.filter((s) => p.sets[s].present && s !== 'tracks')));
			setTracksMode(p.sameMachine ? 'original' : 'root');
			setTracksRoot('');
		}).catch((err) => setError(err instanceof Error ? err.message : String(err)));
	};
	const close = (): void => { setIsOpen(false); };

	const onKeyDown = (e: KeyboardEvent): void => {
		if (!isOpen() || e.key !== 'Escape') return;
		e.preventDefault(); e.stopPropagation();
		close();
	};
	document.addEventListener('keydown', onKeyDown, true);

	const toggle = (id: BackupSetId, on: boolean): void => {
		const next = new Set(chosen());
		if (on) next.add(id); else next.delete(id);
		setChosen(next);
	};
	const needsRelaunch = (): boolean => [...chosen()].some((s) => CURATOR_SETS.includes(s));
	const touchesRekordbox = (): boolean => [...chosen()].some((s) => RB_SETS.includes(s));
	const canSubmit = (): boolean => {
		const p = preview();
		if (!p || chosen().size === 0) return false;
		if (touchesRekordbox() && p.rekordboxRunning !== false) return false;
		if (chosen().has('tracks') && tracksMode() === 'root' && !tracksRoot()) return false;
		return true;
	};
	const submit = (): void => {
		const p = preview();
		if (!p || !canSubmit()) return;
		const req: BackupRestoreRequest = {
			snapshotId: p.snapshotId,
			sets: BACKUP_SET_IDS.filter((s) => chosen().has(s)),
			...(chosen().has('tracks') ? { tracks: tracksMode() === 'root' ? { mode: 'root' as const, root: tracksRoot() } : { mode: 'original' as const } } : {}),
		};
		close();
		props.onSubmit(req, p);
	};

	const dispose = render(() => (
		<Show when={isOpen() && snapshot()}>
			{(sn) => (
				<div class="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
					<div class="modal wav-convert backup-restore" role="dialog" aria-modal="true" aria-labelledby="backup-restore-title">
						<header class="modal__head">
							<h3 id="backup-restore-title">Restore from backup</h3>
							<button class="modal__close" type="button" aria-label="Close" onClick={(e) => { e.preventDefault(); close(); }}>×</button>
						</header>
						<div class="modal__body">
							<div class="wav-convert__sub">{`Snapshot from ${new Date(sn().createdAt).toLocaleString()}${sn().hostname ? ` on ${sn().hostname}` : ''}${sn().label ? ` · ${sn().label}` : ''}`}</div>
							<Show when={error()}><p class="wav-convert__error">{error()}</p></Show>
							<Show when={!preview() && !error()}><div class="wav-convert__current">Reading the snapshot…</div></Show>
							<Show when={preview()}>
								{(p) => (
									<>
										<Show when={!p().sameMachine}>
											<div class="backup__banner">This snapshot was made on another machine. Spotify/Tidal will need reconnecting after a library restore.</div>
										</Show>
										<div class="backup-restore__sets">
											<For each={BACKUP_SET_IDS}>{(id) => (
												<Show when={p().sets[id].present}>
													<label class="settings-toggle">
														<input type="checkbox" checked={chosen().has(id)} onChange={(e) => toggle(id, e.currentTarget.checked)} />
														<span class="settings-toggle__label">{BACKUP_SET_LABELS[id].label}</span>
														<span class="settings-toggle__hint">{`${p().sets[id].files} files · ${formatBytes(p().sets[id].bytes)}`}</span>
													</label>
												</Show>
											)}</For>
										</div>
										<Show when={chosen().has('tracks')}>
											<div class="backup-restore__tracks">
												<label class="settings-radio"><input type="radio" name="bk-tracks" checked={tracksMode() === 'original'} onChange={() => setTracksMode('original')} /><span class="settings-radio__label">{`Original locations${p().tracksRoot ? ` (${p().tracksRoot})` : ''}`}</span></label>
												<label class="settings-radio"><input type="radio" name="bk-tracks" checked={tracksMode() === 'root'} onChange={() => setTracksMode('root')} /><span class="settings-radio__label">A different folder — the library's paths are updated to match</span></label>
												<Show when={tracksMode() === 'root'}>
													<div class="settings-rekordbox__path-row backup__row">
														<span class="settings-ui__field-label">Folder</span>
														<input type="text" value={tracksRoot()} placeholder="Choose a folder…" readOnly />
														<button type="button" class="btn-secondary" onClick={async (e) => { e.preventDefault(); const picked = await dialogApi.pickFolder(); if (picked) setTracksRoot(picked); }}>Browse…</button>
													</div>
												</Show>
											</div>
										</Show>
										<Show when={touchesRekordbox()}>
											<div class="backup__banner" classList={{ 'backup__banner--error': p().rekordboxRunning !== false }}>
												{p().rekordboxRunning === null
													? 'Restoring rekordbox data needs the rekordbox sidecar (it verifies rekordbox is closed) — unavailable in this build.'
													: p().rekordboxRunning
														? 'Rekordbox is running — close it to restore its data.'
														: 'Rekordbox is closed. A copy of its current database is taken before anything is overwritten.'}
											</div>
										</Show>
										<Show when={needsRelaunch()}>
											<div class="settings-toggle__hint">Library data is staged first and swapped in at the next launch; the current files are kept in a pre-restore folder.</div>
										</Show>
									</>
								)}
							</Show>
						</div>
						<footer class="modal__foot">
							<button type="button" class="btn-secondary" onClick={(e) => { e.preventDefault(); close(); }}>Cancel</button>
							<button type="button" class="btn-primary" disabled={!canSubmit()} onClick={(e) => { e.preventDefault(); submit(); }}>Restore…</button>
						</footer>
					</div>
				</div>
			)}
		</Show>
	), host);

	return {
		destroy: () => { document.removeEventListener('keydown', onKeyDown, true); dispose(); },
		isOpen,
		open,
		close,
	};
}
