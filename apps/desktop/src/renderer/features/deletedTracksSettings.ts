// Settings → Deleted Tracks: the one surface that lists soft-deleted tracks on
// purpose. Everywhere else a deleted track is gone; here it can be restored,
// or deleted permanently (tags and cues dropped, the row kept as the evidence
// that stops Spotify/Tidal sync, the scanner and Discover bringing it back —
// core's purgeDeletedTracks).
//
// Thin view over tracks:list-deleted, painted on tab activation. The list is
// a few hundred rows at most in practice and only filtered client-side, so
// a plain table (tbody repaint on filter) is enough — no virtualization.
// Dialogs and the library refresh are injected from main.ts so this module
// never imports layouts or main.ts.

import type { DeletedTrack } from '@curator/core';
import { tracksApi } from '../data/api.js';
import { log } from '../data/log.js';
import { escapeHtml } from '../ui/format.js';
import { showToast } from '../ui/toast.js';

export interface DeletedTracksSettingsDeps {
	confirm(opts: { title: string; message: string; note?: string; confirmLabel: string; danger?: boolean }): Promise<boolean>;
	// Re-render the visible track list + counts after a restore (restored
	// tracks reappear in their views and tag/source counts move).
	refreshLibrary(): Promise<void>;
}

let deps: DeletedTracksSettingsDeps | null = null;
let rows: DeletedTrack[] | null = null;
let query = '';
const selected = new Set<string>();
let busy = false;

const dlog = log.for('deleted-tracks');

export function initDeletedTracksSettingsFeature(d: DeletedTracksSettingsDeps): void {
	deps = d;
}

const CAUSE_LABEL: Record<DeletedTrack['cause'], string> = {
	deleted: 'Deleted',
	merged: 'Merged',
	'wav-copy': 'WAV copy',
};
const CAUSE_HINT: Record<DeletedTrack['cause'], string> = {
	deleted: 'Deleted from the library',
	merged: 'Merged into another track — its tags, playlists and cues moved to the survivor; restoring makes a duplicate',
	'wav-copy': 'A Convert-to-WAV copy; its file went to the trash',
};

function plural(n: number, w: string): string {
	return `${n} ${w}${n === 1 ? '' : 's'}`;
}

function fmtDate(ms: number): string {
	return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function visibleRows(): DeletedTrack[] {
	if (!rows) return [];
	const q = query.trim().toLowerCase();
	if (!q) return rows;
	return rows.filter((r) => r.title.toLowerCase().includes(q) || (r.artist ?? '').toLowerCase().includes(q));
}

function keepsCell(r: DeletedTrack): string {
	const parts: string[] = [];
	if (r.sources.length > 0) parts.push(r.sources.map(escapeHtml).join(', '));
	if (r.tags > 0) parts.push(plural(r.tags, 'tag'));
	if (r.playlists > 0) parts.push(plural(r.playlists, 'playlist'));
	return parts.length > 0 ? parts.join(' · ') : '—';
}

function renderBody(): string {
	const vis = visibleRows();
	if (vis.length === 0) {
		return `<tr><td colspan="5" class="deleted-tracks__empty">${rows && rows.length > 0 ? 'No deleted tracks match.' : 'No deleted tracks.'}</td></tr>`;
	}
	return vis.map((r) => `
		<tr data-dt-row="${escapeHtml(r.trackId)}" class="${selected.has(r.trackId) ? 'is-selected' : ''}">
			<td class="deleted-tracks__check"><input type="checkbox" data-dt-check="${escapeHtml(r.trackId)}" ${selected.has(r.trackId) ? 'checked' : ''} /></td>
			<td class="deleted-tracks__title">
				<div class="deleted-tracks__name">${escapeHtml(r.title)}</div>
				<div class="deleted-tracks__artist">${escapeHtml(r.artist ?? '—')}</div>
			</td>
			<td class="deleted-tracks__when">${escapeHtml(fmtDate(r.deletedAt))}</td>
			<td class="deleted-tracks__cause" title="${escapeHtml(CAUSE_HINT[r.cause])}">${CAUSE_LABEL[r.cause]}</td>
			<td class="deleted-tracks__keeps">${keepsCell(r)}</td>
		</tr>`).join('');
}

function toolbarState(host: HTMLElement): void {
	const vis = visibleRows();
	const n = selected.size;
	const all = host.querySelector<HTMLInputElement>('[data-dt-all]');
	if (all) {
		const visSel = vis.filter((r) => selected.has(r.trackId)).length;
		all.checked = vis.length > 0 && visSel === vis.length;
		all.indeterminate = visSel > 0 && visSel < vis.length;
	}
	const restore = host.querySelector<HTMLButtonElement>('[data-dt-restore]');
	const purge = host.querySelector<HTMLButtonElement>('[data-dt-purge]');
	if (restore) { restore.disabled = busy || n === 0; restore.textContent = n > 0 ? `Restore ${n}` : 'Restore'; }
	if (purge) { purge.disabled = busy || n === 0; purge.textContent = n > 0 ? `Delete ${n} permanently` : 'Delete permanently'; }
	const count = host.querySelector<HTMLElement>('[data-dt-count]');
	if (count) {
		const total = rows?.length ?? 0;
		count.textContent = rows == null ? 'Loading…'
			: vis.length === total ? plural(total, 'deleted track')
			: `${vis.length} of ${plural(total, 'deleted track')}`;
	}
}

function paintBody(host: HTMLElement): void {
	const body = host.querySelector<HTMLElement>('[data-dt-body]');
	if (body) body.innerHTML = renderBody();
	toolbarState(host);
}

function renderShell(host: HTMLElement): void {
	host.innerHTML = `
		<div class="deleted-tracks">
			<div class="lib-maintenance__hint">
				Deleted tracks are hidden everywhere in Curator. <strong>Restore</strong> brings a track back with its tags, cues, rating and history (not its playlists or trashed files).
				<strong>Delete permanently</strong> removes its tags and cues and takes it off this list for good; Curator keeps a bare record of it so Spotify, Tidal, a rescan or Discover don't bring it back.
			</div>
			<div class="deleted-tracks__toolbar">
				<input type="search" class="deleted-tracks__filter" data-dt-filter placeholder="Filter by title or artist" value="${escapeHtml(query)}" spellcheck="false" />
				<span class="deleted-tracks__count" data-dt-count></span>
				<span class="deleted-tracks__spacer"></span>
				<button class="btn-secondary" type="button" data-dt-restore disabled>Restore</button>
				<button class="btn-danger" type="button" data-dt-purge disabled>Delete permanently</button>
			</div>
			<div class="deleted-tracks__scroll">
				<table class="backup-snaps deleted-tracks__table">
					<thead><tr>
						<th class="deleted-tracks__check"><input type="checkbox" data-dt-all title="Select all shown" /></th>
						<th>Track</th><th>Deleted</th><th>Why</th><th>Still holds</th>
					</tr></thead>
					<tbody data-dt-body></tbody>
				</table>
			</div>
		</div>`;
	paintBody(host);
	wire(host);
}

function wire(host: HTMLElement): void {
	const filter = host.querySelector<HTMLInputElement>('[data-dt-filter]');
	filter?.addEventListener('input', () => { query = filter.value; paintBody(host); });

	host.querySelector<HTMLInputElement>('[data-dt-all]')?.addEventListener('change', (e) => {
		const on = (e.currentTarget as HTMLInputElement).checked;
		for (const r of visibleRows()) on ? selected.add(r.trackId) : selected.delete(r.trackId);
		paintBody(host);
	});

	// Row click toggles too (the checkbox is a small target in a long list).
	host.querySelector<HTMLElement>('[data-dt-body]')?.addEventListener('click', (e) => {
		const tr = (e.target as HTMLElement).closest<HTMLElement>('[data-dt-row]');
		const id = tr?.dataset.dtRow;
		if (!tr || !id) return;
		if (selected.has(id)) selected.delete(id); else selected.add(id);
		tr.classList.toggle('is-selected', selected.has(id));
		const cb = tr.querySelector<HTMLInputElement>('[data-dt-check]');
		if (cb) cb.checked = selected.has(id);
		toolbarState(host);
	});

	host.querySelector<HTMLButtonElement>('[data-dt-restore]')?.addEventListener('click', () => { void act(host, 'restore'); });
	host.querySelector<HTMLButtonElement>('[data-dt-purge]')?.addEventListener('click', () => { void act(host, 'purge'); });
}

async function act(host: HTMLElement, kind: 'restore' | 'purge'): Promise<void> {
	// Only what's still on the list (a filter change never drops a selection,
	// but the list may have been reloaded since).
	const live = new Set((rows ?? []).map((r) => r.trackId));
	const ids = [...selected].filter((id) => live.has(id));
	if (ids.length === 0 || busy) return;
	if (kind === 'purge') {
		const ok = await deps?.confirm({
			title: `Delete ${plural(ids.length, 'track')} permanently?`,
			message: 'Their tags and cues are removed and they leave this list. This can\'t be undone.',
			note: 'Curator keeps a bare record of each so Spotify, Tidal, a rescan or Discover don\'t bring them back.',
			confirmLabel: 'Delete permanently',
			danger: true,
		});
		if (!ok) return;
	}
	busy = true;
	toolbarState(host);
	try {
		if (kind === 'restore') {
			const { restored } = await tracksApi.undelete(ids);
			showToast(restored.length > 0 ? `Restored ${plural(restored.length, 'track')}` : 'Nothing to restore', { kind: restored.length > 0 ? 'success' : 'info' });
			await deps?.refreshLibrary();
		} else {
			const { purged } = await tracksApi.purgeDeleted(ids);
			showToast(`Deleted ${plural(purged.length, 'track')} permanently`, { kind: 'success' });
		}
		for (const id of ids) selected.delete(id);
	} catch (err) {
		dlog.error(`${kind} failed`, err);
		showToast(kind === 'restore' ? 'Restore failed' : 'Delete failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 6000 });
	} finally {
		busy = false;
	}
	await load(host);
}

async function load(host: HTMLElement): Promise<void> {
	try {
		rows = await tracksApi.listDeleted();
	} catch (err) {
		dlog.error('list failed', err);
		rows = [];
		showToast('Could not load deleted tracks', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 6000 });
	}
	// Drop selections whose rows are gone (restored / purged elsewhere).
	const live = new Set(rows.map((r) => r.trackId));
	for (const id of [...selected]) if (!live.has(id)) selected.delete(id);
	if (host.isConnected) paintBody(host);
}

export function mountDeletedTracksSettings(host: HTMLElement): void {
	rows = null;
	renderShell(host);
	void load(host);
}
