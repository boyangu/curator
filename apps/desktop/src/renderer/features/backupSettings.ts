// Settings → Backup: where/what/how-often to back up, the run in progress,
// and the snapshot history with pin / restore / delete.
//
// Core owns every value (app_setting) and the run state, so this panel is a
// thin view: render from backup:status + backup:list-snapshots, write
// through backupApi, re-render on the coalesced status events while the
// host is still in the DOM (the mirSettings pattern). Dialogs (restore,
// confirm) are injected from main.ts so this module never imports layouts.

import type { BackupSetId, BackupSnapshotSummary, BackupStatus, BackupTargetStat } from '@curator/core';
import { BACKUP_SET_IDS, BACKUP_SET_LABELS } from '@curator/shared';
import { backupApi, dialogApi } from '../data/api.js';
import { log } from '../data/log.js';
import { escapeHtml, formatBytes } from '../ui/format.js';
import { showToast } from '../ui/toast.js';

export interface BackupSettingsDeps {
	confirm(opts: { title: string; message: string; note?: string; confirmLabel: string; danger?: boolean }): Promise<boolean>;
	openRestore(snapshot: BackupSnapshotSummary): void;
	reopenProgress(): boolean;
}

let deps: BackupSettingsDeps | null = null;
let unsubscribe: (() => void) | null = null;
let snapshotsCache: BackupSnapshotSummary[] | null = null;
let statCache: BackupTargetStat | null = null;
// Snapshot whose pin label is being typed (Electron has no window.prompt).
let pinEditingId: string | null = null;

export function initBackupSettingsFeature(d: BackupSettingsDeps): void {
	deps = d;
}

const blog = log.for('backup-settings');

const INTERVALS: Array<{ h: number; label: string }> = [
	{ h: 6, label: 'Every 6 hours' }, { h: 12, label: 'Every 12 hours' }, { h: 24, label: 'Daily' }, { h: 72, label: 'Every 3 days' }, { h: 168, label: 'Weekly' },
];

function fmtDate(ms: number | null): string {
	if (!ms) return 'never';
	return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtSnapshotId(id: string): string {
	// 20261014T173000.123Z-ab12 → the createdAt is what the user reads.
	return id;
}

function phaseLabel(s: NonNullable<BackupStatus['running']>): string {
	const pct = s.bytesTotal > 0 ? ` · ${Math.min(100, Math.round((s.bytesDone / s.bytesTotal) * 100))}%` : s.total > 0 ? ` · ${s.done}/${s.total}` : '';
	const names: Record<string, string> = {
		collect: 'Collecting files', snapshot: 'Copying databases', hash: 'Checking for changes', upload: 'Uploading', manifest: 'Writing snapshot',
		retention: 'Rotating old snapshots', gc: 'Cleaning up', download: 'Downloading', verify: 'Verifying', write: 'Writing files', apply: 'Applying',
	};
	return `${s.stopping ? 'Stopping… ' : ''}${names[s.phase] ?? s.phase}${pct}${s.current ? ` — ${s.current}` : ''}`;
}

function lastRunLine(s: BackupStatus): string {
	const r = s.lastRun;
	if (!r) return 'No backup yet.';
	const what = r.op === 'restore' ? 'Last restore' : 'Last backup';
	const outcome = r.status === 'done' ? (r.op === 'backup' ? `${formatBytes(r.newBytes)} uploaded` : 'done')
		: r.status === 'unchanged' ? 'nothing changed'
		: r.status === 'cancelled' ? 'stopped'
		: r.status === 'failed' ? `failed — ${r.message ?? 'see log'}`
		: 'interrupted';
	return `${what}: ${fmtDate(r.at)} (${outcome})`;
}

function render(host: HTMLElement, s: BackupStatus): void {
	const st = s.settings;
	const t = st.target;
	const folderPath = t?.kind === 'folder' ? t.path : '';
	const driveName = t?.kind === 'googledrive' ? t.folderName : 'Curator Backups';
	const kind: 'folder' | 'googledrive' = t?.kind ?? (s.google.connected ? 'googledrive' : 'folder');
	const running = s.running;

	const banners: string[] = [];
	if (!s.available) banners.push(`<div class="backup__banner backup__banner--warn">Backup is not available in this build.</div>`);
	if (s.pendingRestore) banners.push(`<div class="backup__banner backup__banner--warn">A restore is staged (snapshot ${escapeHtml(s.pendingRestore.snapshotId)}). <button class="btn-primary" data-bk-relaunch>Restart Curator to apply it</button></div>`);
	if (s.restoreApplied) {
		banners.push(s.restoreApplied.error
			? `<div class="backup__banner backup__banner--error">The last restore stopped part-way: ${escapeHtml(s.restoreApplied.error)}. The previous files are kept in ${escapeHtml(s.restoreApplied.preRestoreDir)}.</div>`
			: `<div class="backup__banner">Restored from snapshot ${escapeHtml(s.restoreApplied.snapshotId)} at the last launch. The previous files are kept in <code>${escapeHtml(s.restoreApplied.preRestoreDir)}</code> — delete that folder once you are happy.</div>`);
	}
	if (s.needsReconnect) banners.push(`<div class="backup__banner backup__banner--error">Google Drive access expired — reconnect below. (A consent screen left in "Testing" expires tokens after 7 days.)</div>`);

	const quota = statCache && statCache.quotaBytes != null && statCache.usedBytes != null
		? `${formatBytes(statCache.usedBytes)} of ${formatBytes(statCache.quotaBytes)} used${statCache.account ? ` · ${escapeHtml(statCache.account)}` : ''}`
		: statCache?.freeBytes != null ? `${formatBytes(statCache.freeBytes)} free` : '';

	const setRows = BACKUP_SET_IDS.map((id) => {
		const l = BACKUP_SET_LABELS[id];
		return `<label class="settings-toggle">
			<input type="checkbox" data-bk-set value="${id}" ${st.sets[id] ? 'checked' : ''} ${id === 'core' ? 'disabled' : ''} />
			<span class="settings-toggle__label">${escapeHtml(l.label)}</span>
			<span class="settings-toggle__hint">${escapeHtml(l.hint)}</span>
		</label>`;
	}).join('');

	const snaps = snapshotsCache;
	const snapRows = snaps == null
		? `<div class="settings-toggle__hint">Loading snapshots…</div>`
		: snaps.length === 0
			? `<div class="settings-toggle__hint">No snapshots on this target yet.</div>`
			: `<table class="backup-snaps"><thead><tr><th>When</th><th>Contents</th><th>Size</th><th>Label</th><th></th></tr></thead><tbody>${snaps.map((sn) => `
				<tr data-bk-snap="${escapeHtml(sn.id)}" title="${escapeHtml(fmtSnapshotId(sn.id))}${sn.hostname ? ` · from ${escapeHtml(sn.hostname)}` : ''}">
					<td>${escapeHtml(fmtDate(sn.createdAt))}</td>
					<td class="backup-snaps__sets">${sn.sets.map((x) => escapeHtml(BACKUP_SET_LABELS[x as BackupSetId]?.label ?? x)).join(', ')}</td>
					<td>${formatBytes(sn.bytes)}<span class="settings-toggle__hint"> · ${sn.files} files</span></td>
					<td>${sn.pinned ? `<span class="backup-snaps__pin" title="Pinned — never rotated out">📌 ${escapeHtml(sn.label ?? '')}</span>` : pinEditingId === sn.id ? `<input type="text" class="backup-snaps__label-input" data-bk-pin-input="${escapeHtml(sn.id)}" placeholder="Why keep it?" maxlength="60" />` : ''}</td>
					<td class="backup-snaps__actions">
						<button class="btn-secondary btn-small" data-bk-pin="${escapeHtml(sn.id)}">${sn.pinned ? 'Unpin' : pinEditingId === sn.id ? 'Save' : 'Pin…'}</button>
						<button class="btn-secondary btn-small" data-bk-restore="${escapeHtml(sn.id)}" ${running ? 'disabled' : ''}>Restore…</button>
						<button class="btn-secondary btn-small" data-bk-delete="${escapeHtml(sn.id)}" ${running || sn.pinned ? 'disabled' : ''} title="${sn.pinned ? 'Unpin first' : ''}">Delete</button>
					</td>
				</tr>`).join('')}</tbody></table>`;

	host.innerHTML = `
		${banners.join('')}
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Backup</div>
			<div class="backup__status">
				<div>${escapeHtml(lastRunLine(s))}</div>
				<div class="settings-toggle__hint">${running ? escapeHtml(phaseLabel(running)) : st.enabled && s.nextDueAt ? `Next: ${escapeHtml(fmtDate(s.nextDueAt))}${s.waitingFor ? ` · waiting for ${escapeHtml(s.waitingFor)} to finish` : ''}` : 'Automatic backup is off.'}</div>
			</div>
			<div class="backup__actions">
				${running
					? `<button class="btn-secondary" data-bk-stop ${running.stopping ? 'disabled' : ''}>${running.stopping ? 'Stopping…' : 'Stop'}</button><button class="btn-secondary" data-bk-progress>Show progress</button>`
					: `<button class="btn-primary" data-bk-run ${!s.available || !t || !!s.pendingRestore ? 'disabled' : ''}>Back up now</button>`}
			</div>
			<label class="settings-toggle">
				<input type="checkbox" data-bk-enabled ${st.enabled ? 'checked' : ''} ${!s.available || !t ? 'disabled' : ''} />
				<span class="settings-toggle__label">Back up automatically</span>
				<span class="settings-toggle__hint">Runs when the last backup is older than the interval and nothing heavy (sync, analysis, conversion) is running — also shortly after launch when overdue. Only what changed is uploaded.</span>
			</label>
			<label class="settings-ui__field"><span class="settings-ui__field-label">Interval</span>
				<select class="settings-ui__select" data-bk-interval>${INTERVALS.map((i) => `<option value="${i.h}" ${i.h === st.intervalHours ? 'selected' : ''}>${i.label}</option>`).join('')}${INTERVALS.some((i) => i.h === st.intervalHours) ? '' : `<option value="${st.intervalHours}" selected>Every ${st.intervalHours} h</option>`}</select>
			</label>
			<label class="settings-ui__field"><span class="settings-ui__field-label">Keep</span>
				<input type="number" class="settings-ui__number" data-bk-keep min="1" max="100" value="${st.keep}" />
				<span class="settings-ui__field-suffix">most recent snapshots (pinned ones are always kept)</span>
			</label>
		</div>
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Where</div>
			<label class="settings-radio"><input type="radio" name="bk-kind" data-bk-kind value="folder" ${kind === 'folder' ? 'checked' : ''} /><span class="settings-radio__label">A folder (external drive, NAS, or a folder your cloud client syncs)</span></label>
			<div class="settings-rekordbox__path-row backup__row" ${kind === 'folder' ? '' : 'hidden'}>
				<span class="settings-ui__field-label">Folder</span>
				<input type="text" data-bk-folder value="${escapeHtml(folderPath)}" placeholder="Choose a folder…" spellcheck="false" />
				<button class="btn-secondary" data-bk-browse>Browse…</button>
			</div>
			<label class="settings-radio"><input type="radio" name="bk-kind" data-bk-kind value="googledrive" ${kind === 'googledrive' ? 'checked' : ''} /><span class="settings-radio__label">Google Drive</span></label>
			<div class="backup__drive" ${kind === 'googledrive' ? '' : 'hidden'}>
				${s.google.configured || s.google.connected ? '' : `<div class="backup__banner backup__banner--warn">Google Drive backup is not configured in this build (CURATOR_GOOGLE_CLIENT_ID and CURATOR_GOOGLE_CLIENT_SECRET). A folder target still works.</div>`}
				<div class="settings-rekordbox__path-row backup__row">
					<span class="settings-ui__field-label">Account</span>
					<span>${s.google.connected ? `Connected${s.google.email ? ` as ${escapeHtml(s.google.email)}` : ''}` : s.google.configured ? 'Not connected' : 'Not configured'}</span>
					${s.google.connected ? `<button class="btn-secondary" data-bk-gdisconnect>Disconnect</button>` : `<button class="btn-primary" data-bk-gconnect ${s.google.configured ? '' : 'disabled'}>Connect Google Drive</button>`}
				</div>
				<div class="settings-rekordbox__path-row backup__row">
					<span class="settings-ui__field-label">Drive folder</span>
					<input type="text" data-bk-drivename value="${escapeHtml(driveName)}" spellcheck="false" />
					<span class="settings-toggle__hint">Created under My Drive. Only files Curator created are visible to it.</span>
				</div>
			</div>
			${quota ? `<div class="settings-toggle__hint backup__quota">${quota}</div>` : ''}
		</div>
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">What</div>
			${setRows}
		</div>
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Snapshots <button class="btn-secondary btn-small" data-bk-refresh ${!t ? 'disabled' : ''}>Refresh</button></div>
			${snapRows}
		</div>`;

	const write = (patch: Parameters<typeof backupApi.setSettings>[0]): void => {
		backupApi.setSettings(patch).then(() => refresh(host)).catch((e) => {
			showToast('Could not save backup settings', { sub: e instanceof Error ? e.message : String(e), kind: 'error' });
			void refresh(host);
		});
	};
	const q = <T extends Element>(sel: string): T | null => host.querySelector<T>(sel);

	q<HTMLInputElement>('[data-bk-enabled]')?.addEventListener('change', (e) => write({ enabled: (e.target as HTMLInputElement).checked }));
	q<HTMLSelectElement>('[data-bk-interval]')?.addEventListener('change', (e) => write({ intervalHours: Number((e.target as HTMLSelectElement).value) }));
	q<HTMLInputElement>('[data-bk-keep]')?.addEventListener('change', (e) => write({ keep: Number((e.target as HTMLInputElement).value) }));
	host.querySelectorAll<HTMLInputElement>('[data-bk-set]').forEach((el) => el.addEventListener('change', () => {
		write({ sets: { ...st.sets, [el.value as BackupSetId]: el.checked } });
	}));
	host.querySelectorAll<HTMLInputElement>('[data-bk-kind]').forEach((el) => el.addEventListener('change', () => {
		const isFolder = el.value === 'folder';
		host.querySelector<HTMLElement>('[data-bk-folder]')!.closest('.backup__row')!.toggleAttribute('hidden', !isFolder);
		host.querySelector<HTMLElement>('.backup__drive')!.toggleAttribute('hidden', isFolder);
		if (!isFolder && s.google.connected) write({ target: { kind: 'googledrive', folderName: q<HTMLInputElement>('[data-bk-drivename]')?.value || 'Curator Backups' } });
		if (isFolder && folderPath) write({ target: { kind: 'folder', path: folderPath } });
	}));
	const folderInput = q<HTMLInputElement>('[data-bk-folder]');
	const saveFolder = (path: string): void => { if (path.trim() && path !== folderPath) write({ target: { kind: 'folder', path } }); };
	folderInput?.addEventListener('change', () => saveFolder(folderInput.value));
	q<HTMLButtonElement>('[data-bk-browse]')?.addEventListener('click', async () => {
		const picked = await dialogApi.pickFolder();
		if (picked) saveFolder(picked);
	});
	const driveName$ = q<HTMLInputElement>('[data-bk-drivename]');
	driveName$?.addEventListener('change', () => { if (s.google.connected) write({ target: { kind: 'googledrive', folderName: driveName$.value } }); });
	q<HTMLButtonElement>('[data-bk-gconnect]')?.addEventListener('click', async (e) => {
		const btn = e.currentTarget as HTMLButtonElement;
		btn.disabled = true; btn.textContent = 'Waiting for Google…';
		try {
			await backupApi.googleConnect(driveName$?.value);
			showToast('Google Drive connected', { kind: 'success' });
		} catch (err) {
			showToast('Google Drive connection failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 9000 });
		}
		await refresh(host, { stat: true });
	});
	q<HTMLButtonElement>('[data-bk-gdisconnect]')?.addEventListener('click', async () => {
		if (!deps || !(await deps.confirm({ title: 'Disconnect Google Drive?', message: 'Backups already on Drive stay there; automatic backup turns off until a location is chosen again.', confirmLabel: 'Disconnect' }))) return;
		await backupApi.googleDisconnect().catch((err) => showToast('Disconnect failed', { sub: String(err), kind: 'error' }));
		await refresh(host, { stat: true });
	});
	q<HTMLButtonElement>('[data-bk-run]')?.addEventListener('click', async (e) => {
		(e.currentTarget as HTMLButtonElement).disabled = true;
		try { await backupApi.run(); }
		catch (err) { showToast('Backup could not start', { sub: err instanceof Error ? err.message : String(err), kind: 'error' }); await refresh(host); }
	});
	q<HTMLButtonElement>('[data-bk-stop]')?.addEventListener('click', () => { if (running) void backupApi.cancel(running.runId); });
	q<HTMLButtonElement>('[data-bk-progress]')?.addEventListener('click', () => { deps?.reopenProgress(); });
	q<HTMLButtonElement>('[data-bk-relaunch]')?.addEventListener('click', () => { void backupApi.relaunch(); });
	q<HTMLButtonElement>('[data-bk-refresh]')?.addEventListener('click', () => { void refresh(host, { snapshots: true, stat: true }); });
	const savePin = async (id: string, label: string | null): Promise<void> => {
		pinEditingId = null;
		try { await backupApi.pin(id, label); }
		catch (err) { showToast('Could not update pin', { sub: String(err), kind: 'error' }); }
		await refresh(host, { snapshots: true });
	};
	host.querySelectorAll<HTMLButtonElement>('[data-bk-pin]').forEach((btn) => btn.addEventListener('click', () => {
		const id = btn.dataset['bkPin']!;
		const sn = snapshotsCache?.find((x) => x.id === id);
		if (!sn) return;
		if (sn.pinned) { void savePin(id, null); return; }
		const input = host.querySelector<HTMLInputElement>(`[data-bk-pin-input="${CSS.escape(id)}"]`);
		if (!input) { pinEditingId = id; render(host, s); host.querySelector<HTMLInputElement>(`[data-bk-pin-input="${CSS.escape(id)}"]`)?.focus(); return; }
		void savePin(id, input.value.trim() || 'pinned');
	}));
	host.querySelectorAll<HTMLInputElement>('[data-bk-pin-input]').forEach((input) => input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); void savePin(input.dataset['bkPinInput']!, input.value.trim() || 'pinned'); }
		else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pinEditingId = null; render(host, s); }
	}));
	host.querySelectorAll<HTMLButtonElement>('[data-bk-restore]').forEach((btn) => btn.addEventListener('click', () => {
		const sn = snapshotsCache?.find((x) => x.id === btn.dataset['bkRestore']);
		if (sn && deps) deps.openRestore(sn);
	}));
	host.querySelectorAll<HTMLButtonElement>('[data-bk-delete]').forEach((btn) => btn.addEventListener('click', async () => {
		const id = btn.dataset['bkDelete']!;
		const sn = snapshotsCache?.find((x) => x.id === id);
		if (!sn || !deps) return;
		const ok = await deps.confirm({ title: 'Delete this snapshot?', message: `${fmtDate(sn.createdAt)} · ${formatBytes(sn.bytes)}. Files only this snapshot references are removed from the backup location on the next run.`, confirmLabel: 'Delete', danger: true });
		if (!ok) return;
		try { await backupApi.deleteSnapshot(id); showToast('Snapshot deleted', { kind: 'success' }); }
		catch (err) { showToast('Delete failed', { sub: String(err), kind: 'error' }); }
		await refresh(host, { snapshots: true });
	}));
}

async function refresh(host: HTMLElement, opts: { snapshots?: boolean; stat?: boolean } = {}): Promise<void> {
	try {
		const s = await backupApi.status();
		if (!host.isConnected) return;
		if (opts.snapshots || (snapshotsCache == null && s.settings.target)) {
			snapshotsCache = null;
			render(host, s);
			snapshotsCache = s.settings.target ? await backupApi.listSnapshots({ refresh: !!opts.snapshots }).catch((err) => { blog.warn('list snapshots failed', { err: String(err) }); return [] as BackupSnapshotSummary[]; }) : [];
		}
		if (opts.stat || (statCache == null && s.settings.target)) {
			statCache = s.settings.target ? await backupApi.targetStat().catch(() => null) : null;
		}
		if (host.isConnected) render(host, s);
	} catch (err) {
		blog.warn('status failed', { err: String(err) });
		host.innerHTML = '<div class="settings-toggle__hint">Backup status unavailable.</div>';
	}
}

export function mountBackupSettings(host: HTMLElement): void {
	unsubscribe?.();
	snapshotsCache = null;
	statCache = null;
	unsubscribe = backupApi.onEvent((e) => {
		if (!host.isConnected) { unsubscribe?.(); unsubscribe = null; return; }
		if (e.kind === 'status') render(host, e.status);
		// A finished run changes the snapshot list.
		if (e.kind === 'completed' && e.op === 'backup' && !e.result.unchanged) void refresh(host, { snapshots: true, stat: true });
	});
	void refresh(host);
}
