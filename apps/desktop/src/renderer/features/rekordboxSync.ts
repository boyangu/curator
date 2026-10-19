// Sync-to-Rekordbox feature — the write-side modal orchestration: open +
// rb-running poll, the sync / resolve-conflicts pipeline (progress labels,
// toasts, verify-failed surface), the restore-backup flow, and the persisted
// checkbox flags. Extracted verbatim from main.ts (F3.4). The
// SyncToRekordboxModalHandle is mounted in boot() (main.ts owns the modal
// lifecycle and wires onSubmit/onResolve/onClose/onRestore/loadFlags/
// saveFlags back to this module's exports); it reaches this module's state
// only through those exports and hands the handle in via
// initRekordboxSyncFeature — this module never imports main.ts. IPC goes
// through the data/api.ts rekordboxApi/syncApi facades, never the raw
// preload bridge (boundary-checked at build time).

import { DEFAULT_SYNC_FLAGS, type SyncToRekordboxModalHandle, type SyncFlags, type SyncTarget } from '../layouts/SyncToRekordboxModal.jsx';
import { rekordboxApi, syncApi } from '../data/api.js';
import { log } from '../data/log.js';
import { showToast } from '../ui/toast.js';
import { loadRekordboxSettings } from './settings.js';

export interface RekordboxSyncFeatureDeps {
	// The modal handle lives in main.ts — boot() owns mountSyncToRekordboxModal;
	// null until that mount lands, so the open path guards.
	getModal(): SyncToRekordboxModalHandle | null;
}

let deps: RekordboxSyncFeatureDeps;

export function initRekordboxSyncFeature(d: RekordboxSyncFeatureDeps): void {
	deps = d;
}

// Subscription handle for the rb export event stream — torn down + replaced
// every time a sync starts so a prior run's listener can't repaint a fresh
// modal session with stale events.
let syncToRekordboxExportUnsub: (() => void) | null = null;

// Tear down the export-event subscription. Wired to the modal's onClose in
// boot() so a cancel before submit can't leave a hanging listener; the sync
// pipeline below also calls it once an outcome lands.
export function teardownSyncToRekordboxExportSub(): void {
	syncToRekordboxExportUnsub?.();
	syncToRekordboxExportUnsub = null;
}

// ─── Sync-to-Rekordbox flow ─────────────────────────────────────────────────
// Drives the modal through its three states: idle → in-flight → either
// completed (toast + close) or verify-failed (Restore-or-Leave).
//
// `running` is polled while the modal is open so closing rekordbox unlocks the
// Sync button live. Tear down on close so the poll doesn't leak.

export async function openSyncToRekordboxModal(target: SyncTarget): Promise<void> {
	const syncToRekordboxModal = deps.getModal();
	if (!syncToRekordboxModal) {
		log.for('sync-to-rb').warn('modal not mounted');
		return;
	}
	// Pull initial running state from the read-side detect. The exporter
	// also rejects when rb is open (pyrekordbox raises during commit), but
	// the front-line gate stops the user from getting that far.
	let detected: { dbPath: string | null; running: boolean } = { dbPath: null, running: false };
	try { detected = await rekordboxApi.detect(); }
	catch (err) { log.for('sync-to-rb').warn('detect failed', undefined, err); }

	// Orphaned rb tracks whose local file is gone — surfaced in the modal for
	// one-click cleanup that propagates the delete to rekordbox on this sync.
	let missingFiles: Awaited<ReturnType<typeof rekordboxApi.missingFiles>> = [];
	try { missingFiles = await rekordboxApi.missingFiles(); }
	catch (err) { log.for('sync-to-rb').warn('missing-files probe failed', undefined, err); }

	syncToRekordboxModal.open(target, detected.running, missingFiles);

	// Poll detect every 2s so the user closing rekordbox unblocks the Sync
	// button without a re-open. Cleared on close.
	const pollHandle = window.setInterval(async () => {
		if (!syncToRekordboxModal?.isOpen()) {
			window.clearInterval(pollHandle);
			return;
		}
		try {
			const next = await rekordboxApi.detect();
			syncToRekordboxModal?.setRunning(next.running);
		} catch { /* keep last value on transient failure */ }
	}, 2000);

	// Stash so the close path tears it down. Idle-state's onClose fires via
	// the modal's own Cancel handler; we hook that by subscribing to the
	// next setInterval guard above (it auto-clears on !isOpen).
	void pollHandle;
}

// One function drives both pipeline entries: the initial sync (pull →
// conflicts? → push) and the resume-after-conflicts call (`resolutions`
// present → 'sync:resolve-conflicts'). Both share the export event stream
// for progress/completion and the same toast/verify-failed surfaces.
export function startSyncToRekordbox(
	target: SyncTarget,
	flags: SyncFlags,
	resolutions?: Array<{ conflictId: string; choice: 'ours' | 'theirs' }>,
): void {
	const syncToRekordboxModal = deps.getModal();
	if (!syncToRekordboxModal) return;
	// Flip to in-flight immediately — the first wire event (pull progress
	// on the initial run, push 'started' on the resume) can lag by a
	// second while the sidecar opens the db.
	syncToRekordboxModal.setProgress(resolutions ? 'resolve' : 'pull:open', 0, 1);

	// Subscribe to progress + completion events. Replace any prior listener
	// so a previous run can't repaint THIS modal session.
	syncToRekordboxExportUnsub?.();
	// `outcomeHandled` dedupes the success/fail surface — the exporter
	// emits 'failed' AND throws (so the IPC promise also rejects). Both
	// signals can arrive on the renderer; we only show one toast.
	let outcomeHandled = false;
	syncToRekordboxExportUnsub = rekordboxApi.onExportEvent((evt) => {
		if (evt.kind === 'started') {
			syncToRekordboxModal?.setProgress('resolve', 0, 1);
		} else if (evt.kind === 'progress') {
			syncToRekordboxModal?.setProgress(evt.phase, evt.done, evt.total);
		} else if (evt.kind === 'completed') {
			outcomeHandled = true;
			const r = evt.result;
			if (r.verifyOk) {
				syncToRekordboxModal?.close();
				const tracksTouched = r.tracksWritten + r.cuesWritten + r.tagsWritten + r.playlistsWritten + r.contentDeleted;
				// Three distinct messages so the user can tell apart:
				//   1. Nothing was linked to rb at all (most confusing case
				//      without explicit copy — looks like sync silently did
				//      nothing).
				//   2. Linked but no field changes (genuine no-op — Curator
				//      and rb were already in sync).
				//   3. Real writes landed.
				let title: string;
				let sub: string | undefined;
				if (r.tracksConsidered > 0 && r.tracksConsidered === r.tracksSkippedNotLinked && r.contentDeleted === 0) {
					if (target.kind === 'tracks') {
						title = target.ids.length === 1
							? "Track isn't in Rekordbox"
							: 'None of the selected tracks are in Rekordbox';
					} else {
						title = target.kind === 'folder'
								? 'No tracks under this folder are linked to Rekordbox'
								: 'No tracks in this playlist are linked to Rekordbox';
					}
					sub = 'Run a read sync first to link them.';
				} else if (tracksTouched === 0) {
					title = 'No changes to push';
					const parts: string[] = [];
					if (r.tracksSkippedNotLinked > 0) parts.push(`${r.tracksSkippedNotLinked} skipped (not in Rekordbox)`);
					if (r.tracksUnlinked > 0) parts.push(`${r.tracksUnlinked} stale link${r.tracksUnlinked === 1 ? '' : 's'} removed`);
					if (r.playlistsRemoved > 0) parts.push(`${r.playlistsRemoved} stale playlist${r.playlistsRemoved === 1 ? '' : 's'} removed`);
					sub = parts.length > 0 ? parts.join(' · ') : undefined;
				} else {
					title = 'Synced to Rekordbox';
					const subParts: string[] = [];
					if ((target.kind === 'folder' || target.kind === 'updates') && r.playlistsWritten > 0) {
						subParts.push(`${r.playlistsWritten} playlist${r.playlistsWritten === 1 ? '' : 's'}`);
					}
					if (r.tracksSkippedNotLinked > 0) {
						subParts.push(`${r.tracksSkippedNotLinked} skipped (not in Rekordbox)`);
					}
					// Stale curator-side rows that we pruned because the rb side
					// was gone — surface so the user knows their library got
					// trimmed by the sync (and isn't surprised next time they
					// run a Read sync and see fewer rows).
					if (r.tracksUnlinked > 0) subParts.push(`${r.tracksUnlinked} stale link${r.tracksUnlinked === 1 ? '' : 's'} removed`);
					if (r.playlistsRemoved > 0) subParts.push(`${r.playlistsRemoved} stale playlist${r.playlistsRemoved === 1 ? '' : 's'} removed`);
					if (r.contentDeleted > 0) subParts.push(`${r.contentDeleted} removed from Rekordbox`);
					sub = subParts.length > 0 ? subParts.join(' · ') : undefined;
				}
				showToast(title, { sub, kind: 'success' });
				// Safety-guard holds get their own toast — a hold means the
				// sync REFUSED to delete/reorder something (unlinked members
				// or a mass removal) and the user should look before it can
				// ever propagate. Folding it into the success sub would bury
				// exactly the signal the guard exists to raise.
				if (r.removalsHeld.length > 0) {
					const total = r.removalsHeld.reduce((n, h) => n + h.heldRemovals, 0);
					const reasons = new Set(r.removalsHeld.map((h) => h.reason));
					showToast(
						`Held ${total > 0 ? `${total} removal${total === 1 ? '' : 's'}` : 'order changes'} in ${r.removalsHeld.length} playlist${r.removalsHeld.length === 1 ? '' : 's'}`,
						{
							sub: reasons.has('unlinked-members')
								? 'Some members lost their Rekordbox link — run a read sync; nothing was deleted.'
								: 'Unusually large removal — check the playlist, then re-run the sync.',
							kind: 'info',
						},
					);
				}
				// Per-op write failures get their own toast too — same
				// don't-bury-the-signal reasoning as the holds above. These ops
				// were skipped (savepoint rolled back) while the rest of the
				// sync landed; their baselines didn't advance, so a re-sync
				// retries them once the cause is fixed.
				if (r.writeFailures.length > 0) {
					const names = r.writeFailures.slice(0, 3)
						.map((f) => f.targetLabel ?? f.target).join(', ');
					showToast(
						`${r.writeFailures.length} item${r.writeFailures.length === 1 ? '' : 's'} failed to sync`,
						{
							sub: `${names}${r.writeFailures.length > 3 ? ', …' : ''} — see log for details`,
							kind: 'error',
							durationMs: 6000,
						},
					);
					log.for('sync-to-rb').warn('partial push failure', { failures: r.writeFailures });
				}
			} else {
				// Verify failed — keep the modal open in the failure view so the
				// user can choose Restore or Leave. Failures + backupPath come
				// from the verify result.
				syncToRekordboxModal?.setVerifyFailed({
					pragmaError: r.verifyPragmaError,
					failures: r.verifyFailures,
					backupPath: r.backupPath,
				});
			}
		} else if (evt.kind === 'failed') {
			// Sidecar error / mid-flow throw. The modal's progress view stays
			// up but the user has no actionable choice — show a toast and
			// close the modal so they don't get stuck.
			outcomeHandled = true;
			syncToRekordboxModal?.close();
			showToast('Sync to Rekordbox failed', {
				sub: evt.message,
				kind: 'error',
			});
		}
	});

	// Fire the IPC. Errors bubble through onSidecarEvent's 'failed' event
	// above; we don't need to .catch() here — but we do clean up the
	// subscription once we know one way or the other.
	const settings = loadRekordboxSettings();
	const wireArgs = {
		targetKind: target.kind,
		targetIds: target.ids,
		flags: {
			syncMetadata: flags.syncMetadata,
			syncCues: flags.syncCues,
			// Read-side ExportFlags type splits Metadata into syncMetadata +
			// syncTags (the writer dispatches separately). The modal bundles
			// them under one checkbox; bind both flags to the same boolean.
			syncTags: flags.syncMetadata,
			// User-controlled via the "Playlists" checkbox in the modal.
			// Effective only when target.kind is one of playlist/folder/
			// updates — the exporter's playlist pass is gated on the same
			// kinds so even if a user somehow set the flag on a 'tracks'
			// target (the modal disables the checkbox there) nothing
			// happens. Default true preserves the previous behavior for
			// playlist/folder/updates targets.
			syncPlaylist: flags.syncPlaylist,
			syncBeatgridPhrases: flags.syncBeatgridPhrases,
			syncWaveform: flags.syncWaveform,
		},
		key: settings.key ?? undefined,
		dbPathOverride: settings.dbPathOverride ?? undefined,
	};
	const call = resolutions
		? syncApi.resolveConflicts({ provider: 'rekordbox', resolutions, ...wireArgs })
			.then(() => { /* completion surfaced via the export 'completed' event */ })
		: rekordboxApi.sync(wireArgs).then((outcome) => {
			if (outcome.status === 'conflicts') {
				// Clean pause — nothing was pushed, conflicts are persisted
				// rows. The modal collects decisions and re-enters via
				// onResolve; the event subscription is torn down below and
				// re-created on the resume call.
				outcomeHandled = true;
				syncToRekordboxModal?.setConflicts(outcome.conflicts);
			}
		});
	call.catch((err) => {
		// IPC-level error (e.g. rb-import-in-flight from the service guard,
		// or the exporter throwing before the 'started' event fires).
		// Gated on `outcomeHandled` because the 'failed' event handler
		// above already shows a toast — without this guard the user would
		// see two error toasts for one sync.
		log.for('sync-to-rb').error('IPC rejected', err);
		if (!outcomeHandled) {
			outcomeHandled = true;
			syncToRekordboxModal?.close();
			showToast('Sync to Rekordbox failed', {
				sub: err instanceof Error ? err.message : String(err),
				kind: 'error',
			});
		}
	}).finally(() => {
		syncToRekordboxExportUnsub?.();
		syncToRekordboxExportUnsub = null;
	});
}

export async function restoreRekordboxBackup(backupPath: string): Promise<void> {
	const settings = loadRekordboxSettings();
	try {
		await rekordboxApi.restoreBackup(backupPath, settings.dbPathOverride ?? undefined);
		showToast('Restored previous Rekordbox database', { kind: 'success' });
	} catch (err) {
		showToast('Restore failed', {
			sub: err instanceof Error ? err.message : String(err),
			kind: 'error',
		});
	}
}

// ─── Sync-to-Rekordbox modal — persisted checkbox state ─────────────────────
// Separate storage key from RekordboxSettings (which holds the READ-side
// flags). The write-side modal's flags are user-chosen per-sync but should
// stick across opens — defaults match the locked v1 PRD (Metadata + Cues on,
// Beatgrid+phrases + Waveform off+disabled).
const SYNC_TO_RB_FLAGS_KEY = 'curator.sync-to-rekordbox-flags.v1';

export function loadSyncToRekordboxFlags(): SyncFlags {
	try {
		const raw = localStorage.getItem(SYNC_TO_RB_FLAGS_KEY);
		if (!raw) return { ...DEFAULT_SYNC_FLAGS };
		const parsed = JSON.parse(raw) as Partial<SyncFlags>;
		return { ...DEFAULT_SYNC_FLAGS, ...parsed };
	} catch {
		return { ...DEFAULT_SYNC_FLAGS };
	}
}

export function saveSyncToRekordboxFlags(s: SyncFlags): void {
	try { localStorage.setItem(SYNC_TO_RB_FLAGS_KEY, JSON.stringify(s)); }
	catch (err) { log.for('sync-to-rb-flags').warn('persist failed', undefined, err); }
}
