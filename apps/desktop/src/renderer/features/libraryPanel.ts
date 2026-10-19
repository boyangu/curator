// Library-folders panel feature — the watched-folder list painted into the
// Settings modal's Library tab, plus the add/analyze/remove/prune wiring and
// the auto-analyze toggles that render alongside it. The folders' files show
// on the Rekordbox tab; this panel is their only management surface.
// Scan-progress state (state.libraryScanByFolder) and the library
// scan-progress event listener stay in main.ts — the panel reads the Map
// through deps. Folder data lives in data/library.ts; IPC goes through the
// data/api.ts facades, never the raw preload bridge (boundary-checked at
// build time). This module never imports main.ts.

import type { ScanProgress } from '@curator/core';
import { dialogApi, libraryApi, wavApi } from '../data/api.js';
import { library } from '../data/library.js';
import { fmtRelative, escapeHtml } from '../ui/format.js';
import { showToast } from '../ui/toast.js';
import { mountAutoAnalyzeSettings } from './analysisFlagsForm.jsx';
import { log } from '../data/log.js';

export interface LibraryPanelDeps {
	// Per-folder live scan totals — owned by main.ts (its scan-progress
	// listener writes the Map); the panel reads stage/totals for the folder
	// rows and drops a folder's entry on remove.
	getLibraryScanByFolder(): Map<string, ScanProgress>;
	// Full data refresh after add/prune/remove — re-fetches source counts
	// (the Rekordbox tab's onboarding gate) and repaints the tracks view.
	refreshAll(): Promise<void>;
	// Per-row "Analyze…" — opens the Analyze modal over every local file under
	// the folder (the `libraryFolderId` filter's one caller).
	analyzeFolder(folderId: string, name: string): void;
}

let deps: LibraryPanelDeps;

export function initLibraryPanelFeature(d: LibraryPanelDeps): void {
	deps = d;
}

// ─── Local library folders ────────────────────────────────────────────────

// Last path segment as the folder's short name (Analyze modal title).
function folderTail(p: string): string {
	const seg = p.replace(/[\\/]+$/, '').split(/[\\/]/);
	return seg[seg.length - 1] || p;
}

// Folder rows. Pure render from library state; the panel repaints just these
// on live scan progress (the surrounding shell + the Solid auto-analyze form
// stay put).
function renderFolderRows(): string {
	const folders = library.libraryFolders();
	return folders.map((f) => {
		const live = deps.getLibraryScanByFolder().get(f.id);
		const totals = live?.totals;
		const stateLabel = live?.stage === 'starting' ? 'STARTING'
			: live?.stage === 'ingesting' ? 'SCANNING'
			: f.scanState.toUpperCase();
		const counts = totals
			? `scanned ${totals.scanned} · matched ${totals.matched} · new ${totals.created}`
				+ (totals.skipped ? ` · skipped ${totals.skipped}` : '')
				+ (totals.failed ? ` · failed ${totals.failed}` : '')
			: f.lastScannedAt
				? `last scanned ${fmtRelative(new Date(f.lastScannedAt))}`
				: 'never scanned';
		const err = f.scanState === 'error' && f.scanError
			? `<div class="lib-folder__err">${escapeHtml(f.scanError)}</div>`
			: '';
		return `
			<div class="lib-folder" data-folder-id="${f.id}">
				<div class="lib-folder__main">
					<div class="lib-folder__path">${escapeHtml(f.path)}</div>
					<div class="lib-folder__meta"><span class="lib-folder__state" data-state="${live?.stage ?? f.scanState}">${stateLabel}</span> · ${counts}</div>
					${err}
				</div>
				<div class="lib-folder__actions">
					<button class="lib-folder__btn" data-action="analyze-library-folder" data-folder-id="${f.id}" title="Analyze every local file under this folder">Analyze…</button>
					<button class="lib-folder__btn" data-action="remove-library-folder" data-folder-id="${f.id}" title="Stop watching this folder">Remove</button>
				</div>
			</div>
		`;
	}).join('');
}

// Inner HTML for the modal's folder-list region (#lib-folders-list): the rows
// or an empty-state line. This is the only part repainted on scan progress.
function renderFolderListInner(): string {
	const folders = library.libraryFolders();
	if (folders.length === 0) {
		return '<div class="lib-folders__empty">No folders watched yet. Add one to start ingesting local files.</div>';
	}
	return `<div class="lib-folders">${renderFolderRows()}</div>`;
}

// Static shell of the panel. The auto-analyze block is NOT rendered here —
// it's a Solid component mounted into #auto-analyze-host once (see
// renderLibraryFoldersModalIfOpen), so it survives folder-list repaints
// without remount churn or losing in-progress edits.
function renderLibraryFoldersModalShellHtml(): string {
	return `
		<div id="auto-analyze-host" class="lib-settings-host"></div>
		<div class="lib-folders__actions">
			<button class="btn-primary" data-action="add-library-folder">Add Folder…</button>
		</div>
		<div id="lib-folders-list">${renderFolderListInner()}</div>
		<div class="lib-maintenance">
			<div class="lib-maintenance__row">
				<span class="lib-maintenance__text" id="lib-prune-text">Scan watched folders for tracks whose files have been deleted on disk.</span>
				<button class="btn-secondary" id="lib-prune-btn" data-action="prune-deleted-files" type="button">Remove deleted files</button>
			</div>
			<div class="lib-maintenance__hint">
				Drops the local reference for each file that no longer exists. Tracks themselves stay in your library — re-adding the file later re-matches into the same track. Files that vanish are normally kept as re-bind hints for 30 days and re-bind automatically by audio hash when they reappear elsewhere; this removes those hints now, along with files removed while Curator wasn't running.
			</div>
		</div>
		<div class="lib-maintenance">
			<div class="lib-maintenance__row">
				<span class="lib-maintenance__text" id="lib-dupes-text">Checking for duplicate audio…</span>
			</div>
			<div class="lib-maintenance__hint">
				Files whose audio is byte-identical, tags aside. Each copy is its own track; resolve one by merging or deleting it.
			</div>
		</div>
		<div class="lib-maintenance">
			<div class="lib-maintenance__row">
				<span class="lib-maintenance__text">WAV output folder</span>
			</div>
			<div class="settings-rekordbox__path-row lib-wav__row">
				<input class="settings-rekordbox__path-input" id="wav-output-dir" value="" placeholder="Loading…" spellcheck="false" />
				<button class="btn-secondary" id="wav-output-browse" type="button">Browse…</button>
			</div>
			<div class="lib-maintenance__hint">
				Where a playlist's <em>Convert to WAV…</em> writes its lossless WAV copies (for decks that can't play FLAC). The folder is added to your watched folders on first use.
			</div>
		</div>
	`;
}

function wireLibraryFoldersPanel(container: HTMLElement): void {
	const addBtn = container.querySelector<HTMLButtonElement>('[data-action="add-library-folder"]');
	addBtn?.addEventListener('click', async () => {
		try {
			const path = await dialogApi.pickFolder();
			if (!path) return;
			await libraryApi.addFolder(path);
			await refreshLibraryFolders();
			repaintLibraryFolderSurfaces();
		} catch (err) {
			showToast('Could not add folder', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 6000 });
		}
	});
	// The auto-analyze settings (master toggle + flags) are rendered by the
	// shared Solid component mounted in renderLibraryFoldersModalIfOpen — it
	// owns its own persistence + push-to-core, so there's nothing to wire here.
	const pruneBtn = container.querySelector<HTMLButtonElement>('[data-action="prune-deleted-files"]');
	const pruneText = container.querySelector<HTMLSpanElement>('#lib-prune-text');
	pruneBtn?.addEventListener('click', async () => {
		const baseText = 'Scan watched folders for tracks whose files have been deleted on disk.';
		pruneBtn.disabled = true;
		if (pruneText) pruneText.textContent = 'Scanning…';
		try {
			const preview = await libraryApi.pruneDeletedFiles({ dryRun: true });
			if (preview.missing === 0) {
				showToast('No deleted files found', { sub: `Scanned ${preview.scanned} local file${preview.scanned === 1 ? '' : 's'}`, kind: 'info' });
				if (pruneText) pruneText.textContent = baseText;
				return;
			}
			if (!window.confirm(`Remove ${preview.missing} dead local file reference${preview.missing === 1 ? '' : 's'}?\n\nThe tracks themselves stay in your library — only the local file pointer is dropped. Re-adding the file later re-matches into the same track.`)) {
				if (pruneText) pruneText.textContent = baseText;
				return;
			}
			if (pruneText) pruneText.textContent = 'Removing…';
			const res = await libraryApi.pruneDeletedFiles({ dryRun: false });
			showToast(`Removed ${res.removed} local reference${res.removed === 1 ? '' : 's'}`, {
				sub: `Scanned ${res.scanned} · ${res.missing - res.removed > 0 ? `${res.missing - res.removed} skipped` : 'all dropped'}`,
				kind: 'success',
			});
			// Sidebar source-count badges read the per-source totals; refresh
			// so the local count drops to reflect the now-orphan tracks. If
			// the user's currently viewing local-folder tracks, repaint too
			// since some rows may have lost their local source indicator.
			await deps.refreshAll();
		} catch (err) {
			showToast('Prune failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
		} finally {
			pruneBtn.disabled = false;
			if (pruneText && pruneText.textContent !== baseText) pruneText.textContent = baseText;
		}
	});
	wireFolderRowButtons(container);
	wireWavOutputDir(container);
	loadDuplicateAudioSummary(container);
}

// One line, loaded on open: how many present files carry byte-identical
// audio. A list to act on is a later step; the count is what tells the user
// whether there is anything to act on.
function loadDuplicateAudioSummary(container: HTMLElement): void {
	const el = container.querySelector<HTMLElement>('#lib-dupes-text');
	if (!el) return;
	libraryApi.duplicateAudioGroups().then((groups) => {
		const files = groups.reduce((n, g) => n + g.tracks.length, 0);
		el.textContent = groups.length === 0
			? 'No duplicate audio files.'
			: `${files} duplicate audio file${files === 1 ? '' : 's'} in ${groups.length} group${groups.length === 1 ? '' : 's'}.`;
	}).catch((err) => {
		log.for('library').warn('duplicate audio summary failed', err);
		el.textContent = 'Duplicate audio check unavailable.';
	});
}

// Convert-to-WAV output folder — core-owned (app_setting), so the value is
// the same for the dev and packaged renderers. Persist on blur / Browse.
function wireWavOutputDir(container: HTMLElement): void {
	const input = container.querySelector<HTMLInputElement>('#wav-output-dir');
	const browse = container.querySelector<HTMLButtonElement>('#wav-output-browse');
	if (!input) return;
	let current = '';
	const show = (dir: string): void => { current = dir; input.value = dir; input.placeholder = ''; };
	wavApi.getSettings().then((s) => show(s.outputDir)).catch((err) => log.for('wav').warn('could not load WAV settings', err));
	const save = async (dir: string): Promise<void> => {
		if (!dir || dir === current) { input.value = current; return; }
		try {
			const s = await wavApi.setSettings({ outputDir: dir });
			show(s.outputDir);
			showToast('WAV output folder saved', { sub: s.outputDir, kind: 'success', durationMs: 2500 });
		} catch (err) {
			input.value = current;
			showToast('Could not set WAV output folder', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 6000 });
		}
	};
	input.addEventListener('blur', () => { void save(input.value.trim()); });
	input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
	browse?.addEventListener('click', async () => {
		const picked = await dialogApi.pickFolder();
		if (picked) await save(picked);
	});
}

// Per-row Analyze… / Remove handlers. Split out so a folder-list-only repaint
// (live scan progress) can re-bind the buttons it just re-rendered without
// re-running the add/prune wiring on the static shell.
function wireFolderRowButtons(container: HTMLElement): void {
	container.querySelectorAll<HTMLButtonElement>('[data-action="analyze-library-folder"]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const id = btn.dataset.folderId;
			const folder = id ? library.libraryFolders().find((f) => f.id === id) : undefined;
			if (!id || !folder) return;
			deps.analyzeFolder(id, folderTail(folder.path));
		});
	});
	container.querySelectorAll<HTMLButtonElement>('[data-action="remove-library-folder"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const id = btn.dataset.folderId;
			if (!id) return;
			try {
				await libraryApi.removeFolder(id);
				deps.getLibraryScanByFolder().delete(id);
				// Removing the last folder can drop the local source count to 0,
				// which flips the Rekordbox tab back to onboarding when no
				// rekordbox library is read either. refreshAll re-evaluates that
				// with fresh counts + repaints tracks; then repaint the panel so
				// it stays in sync while open.
				await deps.refreshAll();
				repaintLibraryFolderSurfaces();
			} catch (err) {
				showToast('Could not remove folder', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 6000 });
			}
		});
	});
}

export async function refreshLibraryFolders(): Promise<void> {
	try {
		library.setLibraryFolders(await libraryApi.listFolders());
	} catch (err) {
		log.for('library').error('list-folders failed', err);
	}
}

// Repaint the panel if it's showing (the scan-progress listener and the
// add/remove flows call this without knowing whether Settings is open).
export function repaintLibraryFolderSurfaces(): void {
	renderLibraryFoldersModalIfOpen();
}

// Solid dispose handle for the auto-analyze form mounted in the modal. Held at
// module scope so we can tear the previous root down before mounting a fresh
// one (the Settings modal destroys its DOM on close, so each open builds a new
// host).
let autoAnalyzeDisposer: (() => void) | null = null;

export function renderLibraryFoldersModalIfOpen(): void {
	const overlay = document.getElementById('settings-overlay');
	const panel = document.querySelector<HTMLElement>('.settings-panel[data-settings-panel="library"]');
	const body = document.getElementById('lib-folders-body');
	if (!overlay || !panel || !body) return;
	// Only repaint when the modal is open AND the library tab is the
	// active panel — otherwise the user is on Connections and we'd be
	// painting into a hidden DOM tree (which causes minor jank on tab
	// switch). The render happens on tab activation anyway.
	if (overlay.hidden || panel.hidden) return;

	// First paint of this open: build the static shell, mount the shared Solid
	// auto-analyze form once, and wire the static buttons. Subsequent calls
	// (live scan progress) only repaint the folder-list region so the form
	// keeps its state and the user's in-progress edits/focus survive.
	const host = body.querySelector<HTMLElement>('#auto-analyze-host');
	if (!host) {
		// Stale root from a previous open (the modal's DOM was torn down on
		// close) — dispose before re-mounting into the fresh host.
		autoAnalyzeDisposer?.();
		autoAnalyzeDisposer = null;
		body.innerHTML = renderLibraryFoldersModalShellHtml();
		const freshHost = body.querySelector<HTMLElement>('#auto-analyze-host');
		if (freshHost) autoAnalyzeDisposer = mountAutoAnalyzeSettings(freshHost);
		wireLibraryFoldersPanel(body);
		return;
	}
	const list = body.querySelector<HTMLElement>('#lib-folders-list');
	if (list) {
		list.innerHTML = renderFolderListInner();
		wireFolderRowButtons(list);
	}
}

let libPanelRepaintTimer: number | null = null;
export function scheduleLibraryPanelRepaint(): void {
	if (libPanelRepaintTimer != null) return;
	libPanelRepaintTimer = window.setTimeout(() => {
		libPanelRepaintTimer = null;
		repaintLibraryFolderSurfaces();
	}, 500);
}
