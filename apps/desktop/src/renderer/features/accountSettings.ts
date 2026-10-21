// Settings → Account: the Curator account (cloud) and library sync.
//
// Signed out: email + password, or "email me a code" (one-time code /
// magic link). Signed in: the email, the sync status line, Sync now, the
// library across devices (how many tracks aren't on this device, the master
// device whose track details win elsewhere), shared analysis (reuse toggle, holdings, the "upload existing analysis" button),
// the account's devices (remove one, sign out every other session), unlink
// this library, sign out. Revoked (another computer removed this one): the
// banner and Sign out only, since the server refuses everything else. The
// session and every token live in main; this panel only ever sees status
// (account:status, cloud-sync:status, catalogue:status). What it says and
// offers is decided in accountModel.ts.
//
// Thin view, the backupSettings pattern: render from the two statuses,
// write through accountApi / cloudSyncApi, re-render on cloud-sync:status
// while the host is in the DOM. While signed out a status tick does NOT
// re-render (it would wipe a half-typed password); only a sign-in does.
// Signed in, a tick while one of this panel's inputs has focus only patches
// the live lines in place, for the same reason (the check-cadence inputs).

import type { CatalogueStatus, CloudSyncStatusReport, SyncPollPolicy, SyncPollSettings } from '@curator/core';
import { accountApi, catalogueApi, cloudSyncApi } from '../data/api.js';
import { log } from '../data/log.js';
import { escapeHtml } from '../ui/format.js';
import { showToast } from '../ui/toast.js';
import {
	accountActions, deviceRows, DEVICES_HINT, fmtWhen, MASTER_HINT, MASTER_UNAVAILABLE, masterChoices, remoteOnlyLine, revokeConfirm,
	SIGN_OUT_OTHERS_CONFIRM, syncLine, UNLINK_CONFIRM,
	type AccountDevice, type AccountStatus, type ConfirmText,
} from './accountModel.js';
import { accountLibraryInfo, onAccountLibraryInfo, refreshAccountLibraryInfo, setAccountLibraryInfo } from './accountLibrary.js';

// The confirm dialog is injected from main.ts (the backupSettings pattern),
// so this module never imports layouts.
export interface AccountSettingsDeps {
	confirm(opts: ConfirmText): Promise<boolean>;
}

let deps: AccountSettingsDeps | null = null;

export function initAccountSettingsFeature(d: AccountSettingsDeps): void {
	deps = d;
}

const alog = log.for('account-settings');

let unsubscribe: (() => void) | null = null;
let unsubscribeCatalogue: (() => void) | null = null;
let account: AccountStatus | null = null;
let sync: CloudSyncStatusReport | null = null;
let catalogue: CatalogueStatus | null = null;
let devices: AccountDevice[] | null = null;
// Defaults + limits for the check-cadence inputs (the policy in force rides
// every status as `poll`).
let pollSettings: SyncPollSettings | null = null;
// Signed-out form state that survives a re-render.
let draftEmail = '';
let codeSentTo: string | null = null;
let busy = false;
let formError: string | null = null;
let unsubscribeLibrary: (() => void) | null = null;
// The master selector's own state: a change in flight, and its refusal
// (sync off, server too old) shown under it rather than as a toast.
let masterBusy = false;
let masterError: string | null = null;


// The fallback check cadence, shown in the units people think in: seconds
// while in use, minutes when idle.
const POLL_FIELDS: ReadonlyArray<{ key: keyof SyncPollPolicy; label: string; scale: number; suffix: string }> = [
	{ key: 'activeSec', label: 'While in use', scale: 1, suffix: 'seconds between checks' },
	{ key: 'idleSec', label: 'When idle', scale: 60, suffix: 'minutes between checks' },
	{ key: 'idleAfterSec', label: 'Idle after', scale: 60, suffix: 'minutes in the background or without keyboard/mouse input' },
];

const fmtMin = (sec: number): string => `${sec % 60 === 0 ? sec / 60 : Math.round(sec / 6) / 10} min`;

function pollLine(s: CloudSyncStatusReport): string {
	const p = s.poll.policy;
	return `Checking every ${p.activeSec} s · every ${fmtMin(p.idleSec)} after ${fmtMin(p.idleAfterSec)} idle · ${s.poll.active ? 'in use now' : 'idle now'}`;
}

function pollFieldValue(p: SyncPollPolicy, f: (typeof POLL_FIELDS)[number]): number {
	return Math.round((p[f.key] / f.scale) * 10) / 10;
}

function renderPollSection(s: CloudSyncStatusReport): string {
	const lim = pollSettings?.limits;
	const fields = POLL_FIELDS.map((f) => {
		const [min, max] = lim?.[f.key] ?? [1, 7200];
		return `
			<label class="settings-ui__field"><span class="settings-ui__field-label">${f.label}</span>
				<input type="number" class="settings-ui__number" data-ac-poll="${f.key}" min="${Math.ceil(min / f.scale)}" max="${Math.floor(max / f.scale)}" step="1" value="${pollFieldValue(s.poll.policy, f)}" />
				<span class="settings-ui__field-suffix">${f.suffix}</span>
			</label>`;
	}).join('');
	return `
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Background checks</div>
			<div class="settings-toggle__hint">Changes from your other computers normally arrive within seconds. These checks catch anything that notification missed, and slow down while you are away. This computer only.</div>
			<div class="settings-toggle__hint" data-ac-poll-status>${escapeHtml(pollLine(s))}</div>
			${fields}
			<div class="settings-rekordbox__path-row backup__row">
				<span class="settings-ui__field-label"></span>
				<button class="btn-secondary" data-ac-poll-reset ${pollSettings && !pollSettings.stored ? 'disabled' : ''}>Reset to defaults</button>
			</div>
		</div>`;
}

// Writes the policy in force into the inputs (after a save: the stored
// value may have been clamped).
function syncPollInputs(host: HTMLElement, p: SyncPollPolicy): void {
	for (const f of POLL_FIELDS) {
		const el = host.querySelector<HTMLInputElement>(`[data-ac-poll="${f.key}"]`);
		if (el) el.value = String(pollFieldValue(p, f));
	}
}

function wirePollSection(host: HTMLElement): void {
	const apply = (res: SyncPollSettings): void => {
		pollSettings = res;
		if (sync) sync = { ...sync, poll: { ...sync.poll, policy: res.policy } };
		syncPollInputs(host, res.policy);
		const line = host.querySelector<HTMLElement>('[data-ac-poll-status]');
		if (line && sync) line.textContent = pollLine(sync);
		host.querySelector<HTMLButtonElement>('[data-ac-poll-reset]')?.toggleAttribute('disabled', !res.stored);
	};
	const save = (patch: Partial<SyncPollPolicy> | null): void => {
		void cloudSyncApi.setPollPolicy(patch).then(apply).catch((err) => {
			showToast('Could not save the check interval', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
			if (sync) syncPollInputs(host, sync.poll.policy);
		});
	};
	// 'change', not 'input': commit on Enter / blur / the spinner, never
	// half-way through typing "120".
	host.querySelectorAll<HTMLInputElement>('[data-ac-poll]').forEach((el) => el.addEventListener('change', () => {
		const f = POLL_FIELDS.find((x) => x.key === el.dataset.acPoll);
		const n = Number(el.value);
		if (!f || el.value.trim() === '' || !Number.isFinite(n)) { if (sync) syncPollInputs(host, sync.poll.policy); return; }
		save({ [f.key]: Math.round(n * f.scale) });
	}));
	host.querySelector<HTMLButtonElement>('[data-ac-poll-reset]')?.addEventListener('click', () => save(null));
}

// ── Shared analysis ─────────────────────────────────────────────────────

function fmtBytes(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
	if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
	return `${n} B`;
}

// One line on where shared analysis stands, most urgent first.
function catalogueLine(c: CatalogueStatus): { text: string; tone: 'ok' | 'warn' | 'error' } {
	if (!c.settings.enabled) return { text: 'Off on this computer — it analyses everything itself and shares nothing.', tone: 'ok' };
	if (!c.signedIn) return { text: 'Sign in to reuse analysis from your other computers.', tone: 'ok' };
	if (c.serverOffers === false) return { text: 'Your sync server does not offer shared analysis yet.', tone: 'warn' };
	if (c.serverOffers === null) return { text: 'Waiting for the first sync to learn what the server offers…', tone: 'ok' };
	if (c.lastError) return { text: c.lastError, tone: 'error' };
	if (c.activity === 'inventory') return { text: 'Checking what your other computers analysed…', tone: 'ok' };
	if (c.activity === 'hydrating') return { text: 'Taking analysis from your other computers…', tone: 'ok' };
	if (c.activity === 'uploading') return { text: 'Uploading analysis…', tone: 'ok' };
	if (c.entitled === false) return { text: 'Reusing analysis works; uploading needs your account to be enabled for shared analysis.', tone: 'warn' };
	const last = Math.max(c.lastHydrateAt ?? 0, c.lastUploadAt ?? 0) || null;
	return { text: last ? `Up to date · last change ${fmtWhen(last)}` : 'Up to date', tone: 'ok' };
}

function catalogueFacts(c: CatalogueStatus): { account: string; device: string; backfill: string | null } {
	const quota = c.usage ? ` · ${fmtBytes(c.usage.usedBytes)} of ${fmtBytes(c.usage.quotaBytes)} used` : '';
	const account = `${c.account.items.toLocaleString()} analysis items (${fmtBytes(c.account.bytes)})${quota}`;
	const pending = c.device.pending
		? `${c.device.pending.items.toLocaleString()} not shared yet${c.device.pending.items > 0 ? ` (≈ ${fmtBytes(c.device.pending.bytes)})` : ''}`
		: 'counting what is not shared yet…';
	const device = `${c.device.reused.toLocaleString()} reused from other computers · ${c.device.uploaded.toLocaleString()} uploaded · ${pending}`;
	const b = c.backfill;
	const backfill = b.state === 'running'
		? `Uploading existing analysis… ${b.uploadedItems.toLocaleString()} items (${fmtBytes(b.uploadedBytes)}) so far${b.waitingFor ? ` · waiting for ${b.waitingFor} to finish` : ''}`
		: b.state === 'paused'
			? `Paused after ${b.uploadedItems.toLocaleString()} items (${fmtBytes(b.uploadedBytes)}).`
			: b.state === 'done'
				? 'Existing analysis uploaded.'
				: null;
	return { account, device, backfill };
}

function catalogueButton(c: CatalogueStatus): { label: string; action: 'start' | 'pause' | 'resume'; disabled: boolean } {
	const off = !c.settings.enabled || !c.signedIn || c.serverOffers !== true || c.entitled === false;
	if (c.backfill.state === 'running') return { label: 'Pause upload', action: 'pause', disabled: false };
	if (c.backfill.state === 'paused') return { label: 'Resume upload', action: 'resume', disabled: off };
	const n = c.device.pending;
	const size = n && n.items > 0 ? ` (≈ ${fmtBytes(n.bytes)})` : '';
	return { label: `Upload existing analysis${size}`, action: 'start', disabled: off || (!!n && n.items === 0) };
}

function renderCatalogueSection(c: CatalogueStatus | null): string {
	if (!c) return '';
	if (!c.available) {
		return `
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Shared analysis</div>
			<div class="settings-toggle__hint">Not available in this build (it needs the sync server).</div>
		</div>`;
	}
	const line = catalogueLine(c);
	const facts = catalogueFacts(c);
	const btn = catalogueButton(c);
	return `
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Shared analysis</div>
			<label class="settings-toggle">
				<input type="checkbox" data-ac-cat-enabled ${c.settings.enabled ? 'checked' : ''} />
				<span class="settings-toggle__label">Reuse analysis from my other computers</span>
				<span class="settings-toggle__hint">Beatgrid, key, structure, advanced scores, fingerprints and the overview waveform one of your computers computed are taken instead of computed again, by audio — tags may differ. What this computer analyses is shared the same way. This computer only.</span>
			</label>
			<div class="settings-rekordbox__path-row backup__row">
				<span class="${line.tone === 'ok' ? 'settings-toggle__hint' : `backup__banner backup__banner--${line.tone}`}" data-ac-cat-line>${escapeHtml(line.text)}</span>
			</div>
			<div class="settings-toggle__hint">Your account: <span data-ac-cat-account>${escapeHtml(facts.account)}</span></div>
			<div class="settings-toggle__hint">This computer: <span data-ac-cat-device>${escapeHtml(facts.device)}</span></div>
			<div class="settings-rekordbox__path-row backup__row">
				<span class="settings-ui__field-label"></span>
				<button class="btn-secondary" data-ac-cat-backfill="${btn.action}" ${btn.disabled ? 'disabled' : ''}>${escapeHtml(btn.label)}</button>
				<span class="settings-toggle__hint" data-ac-cat-backfill-line>${escapeHtml(facts.backfill ?? 'Only from this button; it waits while analysis runs.')}</span>
			</div>
			<label class="settings-ui__field"><span class="settings-ui__field-label">Upload speed</span>
				<input type="number" class="settings-ui__number" data-ac-cat-kbps min="0.1" max="100" step="0.5" value="${Math.round((c.settings.maxKBps / 1024) * 10) / 10}" />
				<span class="settings-ui__field-suffix">MB/s at most for waveform uploads</span>
			</label>
			<div class="settings-toggle__hint">Full-resolution waveforms and AI vectors are not shared yet; they arrive in a later stage. This computer still computes them itself.</div>
		</div>`;
}

function wireCatalogueSection(host: HTMLElement): void {
	const apply = (st: CatalogueStatus): void => { catalogue = st; patchCatalogue(host); };
	host.querySelector<HTMLInputElement>('[data-ac-cat-enabled]')?.addEventListener('change', (e) => {
		const enabled = (e.target as HTMLInputElement).checked;
		void catalogueApi.setSettings({ enabled }).then(apply).catch((err) => {
			showToast('Could not change shared analysis', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
			(e.target as HTMLInputElement).checked = !enabled;
		});
	});
	host.querySelector<HTMLButtonElement>('[data-ac-cat-backfill]')?.addEventListener('click', (e) => {
		const action = (e.currentTarget as HTMLButtonElement).dataset.acCatBackfill as 'start' | 'pause' | 'resume';
		void catalogueApi.backfill(action).then(apply).catch((err) => {
			showToast('Could not change the upload', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
		});
	});
	// 'change', not 'input': commit on Enter / blur / the spinner.
	host.querySelector<HTMLInputElement>('[data-ac-cat-kbps]')?.addEventListener('change', (e) => {
		const el = e.target as HTMLInputElement;
		const mb = Number(el.value);
		if (el.value.trim() === '' || !Number.isFinite(mb) || mb <= 0) { patchCatalogue(host, true); return; }
		void catalogueApi.setSettings({ maxKBps: Math.round(mb * 1024) }).then((st) => { catalogue = st; patchCatalogue(host, true); }).catch((err) => {
			showToast('Could not save the upload speed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
		});
	});
}

// A status tick: the live lines and the button only, never the inputs the
// user may be in (`inputs` = also write the stored values back, after a save).
function patchCatalogue(host: HTMLElement, inputs = false): void {
	const c = catalogue;
	if (!c || !c.available) return;
	const line = catalogueLine(c);
	const el = host.querySelector<HTMLElement>('[data-ac-cat-line]');
	if (el) {
		el.textContent = line.text;
		el.className = line.tone === 'ok' ? 'settings-toggle__hint' : `backup__banner backup__banner--${line.tone}`;
	}
	const facts = catalogueFacts(c);
	const set = (sel: string, text: string): void => { const n = host.querySelector<HTMLElement>(sel); if (n) n.textContent = text; };
	set('[data-ac-cat-account]', facts.account);
	set('[data-ac-cat-device]', facts.device);
	set('[data-ac-cat-backfill-line]', facts.backfill ?? 'Only from this button; it waits while analysis runs.');
	const btn = catalogueButton(c);
	const b = host.querySelector<HTMLButtonElement>('[data-ac-cat-backfill]');
	if (b) {
		b.textContent = btn.label;
		b.dataset.acCatBackfill = btn.action;
		b.toggleAttribute('disabled', btn.disabled);
	}
	const toggle = host.querySelector<HTMLInputElement>('[data-ac-cat-enabled]');
	if (toggle && document.activeElement !== toggle) toggle.checked = c.settings.enabled;
	if (inputs) {
		const kbps = host.querySelector<HTMLInputElement>('[data-ac-cat-kbps]');
		if (kbps) kbps.value = String(Math.round((c.settings.maxKBps / 1024) * 10) / 10);
	}
}

// ── Library across devices (remote rows + master device) ───────────────
// Painted into its own [data-ac-library-host] so an info change (a pull
// materialised rows, the master moved) repaints just this section; the
// info itself lives in accountLibrary.ts, shared with the toolbar chip.

function renderLibrarySection(): string {
	const info = accountLibraryInfo();
	if (!info) return `<div class="settings-ui__section"><div class="settings-ui__section-label">Library across devices</div><div class="settings-toggle__hint">Loading…</div></div>`;
	const remote = remoteOnlyLine(info.remoteOnlyCount);
	const choices = devices ? masterChoices(devices, info.masterDeviceId) : null;
	const disabled = !info.metaSyncAvailable || !choices || masterBusy || busy;
	const options = choices
		? choices.map((c) => `<option value="${escapeHtml(c.deviceId)}" ${c.selected ? 'selected' : ''}${c.deviceId === '' ? ' disabled' : ''}>${escapeHtml(c.label)}</option>`).join('')
		: '<option>Loading devices…</option>';
	return `
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Library across devices</div>
			${remote ? `<div class="settings-toggle__hint" data-ac-remote-line>${escapeHtml(remote)}</div>` : ''}
			<label class="settings-ui__field"><span class="settings-ui__field-label">Master device</span>
				<select class="settings-ui__select" data-ac-master ${disabled ? 'disabled' : ''}>${options}</select>
				${masterBusy ? '<span class="settings-ui__field-suffix">Saving…</span>' : ''}
			</label>
			<div class="settings-toggle__hint">${escapeHtml(info.metaSyncAvailable ? MASTER_HINT : MASTER_UNAVAILABLE)}</div>
			${masterError ? `<div class="backup__banner backup__banner--error">${escapeHtml(masterError)}</div>` : ''}
		</div>`;
}

function wireLibrarySection(host: HTMLElement): void {
	const sel = host.querySelector<HTMLSelectElement>('[data-ac-master]');
	sel?.addEventListener('change', () => {
		const id = sel.value;
		if (!id || id === (accountLibraryInfo()?.masterDeviceId ?? null)) return;
		masterBusy = true;
		masterError = null;
		paintLibrary(host, true);
		void accountApi.setMasterDevice(id)
			.then((next) => {
				setAccountLibraryInfo(next);
				showToast('Master device changed', { sub: 'Your other devices take its track details on their next sync.', kind: 'success' });
			})
			.catch((err) => { masterError = errText(err); alog.warn('set master failed', { err: masterError }); })
			.finally(() => { masterBusy = false; paintLibrary(host, true); });
	});
}

// `force`: repaint even while the selector has focus (after its own change).
// Otherwise a focused selector keeps its open dropdown; only the count line
// updates under it.
function paintLibrary(host: HTMLElement, force = false): void {
	const slot = host.querySelector<HTMLElement>('[data-ac-library-host]');
	if (!slot) return;
	const sel = slot.querySelector<HTMLSelectElement>('[data-ac-master]');
	if (!force && sel && document.activeElement === sel) {
		const line = slot.querySelector<HTMLElement>('[data-ac-remote-line]');
		const text = remoteOnlyLine(accountLibraryInfo()?.remoteOnlyCount ?? 0);
		if (line && text) line.textContent = text;
		return;
	}
	slot.innerHTML = renderLibrarySection();
	wireLibrarySection(host);
}

function renderSignedOut(host: HTMLElement, a: AccountStatus): void {
	const err = formError ? `<div class="backup__banner backup__banner--error">${escapeHtml(formError)}</div>` : '';
	const codeStep = codeSentTo
		? `
			<div class="settings-toggle__hint">We emailed a sign-in code to ${escapeHtml(codeSentTo)}. Enter it below, or open the link in that email.</div>
			<div class="settings-rekordbox__path-row backup__row">
				<span class="settings-ui__field-label">Code</span>
				<input type="text" data-ac-code inputmode="numeric" autocomplete="one-time-code" maxlength="10" spellcheck="false" placeholder="123456" />
				<button class="btn-primary" data-ac-verify ${busy ? 'disabled' : ''}>Sign in</button>
				<button class="btn-secondary" data-ac-code-cancel ${busy ? 'disabled' : ''}>Back</button>
			</div>`
		: `
			<div class="settings-rekordbox__path-row backup__row">
				<span class="settings-ui__field-label">Email</span>
				<input type="email" data-ac-email value="${escapeHtml(draftEmail)}" autocomplete="username" spellcheck="false" placeholder="you@example.com" />
			</div>
			<div class="settings-rekordbox__path-row backup__row">
				<span class="settings-ui__field-label">Password</span>
				<input type="password" data-ac-password autocomplete="current-password" />
				<button class="btn-primary" data-ac-signin ${busy ? 'disabled' : ''}>Sign in</button>
			</div>
			<div class="settings-rekordbox__path-row backup__row">
				<span class="settings-ui__field-label"></span>
				<button class="btn-secondary" data-ac-send-code ${busy ? 'disabled' : ''}>Email me a code instead</button>
				<span class="settings-toggle__hint">No password needed; a new email address gets an account.</span>
			</div>`;
	host.innerHTML = `
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Curator account</div>
			<div class="settings-toggle__hint">Sign in to sync your tags, playlists, cues and ratings between your computers. Audio files stay on each machine.</div>
			${a.persistent ? '' : `<div class="backup__banner backup__banner--warn">This system cannot store credentials securely, so you will be asked to sign in again after a restart.</div>`}
			${err}
			${codeStep}
		</div>`;

	const q = <T extends Element>(sel: string): T | null => host.querySelector<T>(sel);
	const email = (): string => (q<HTMLInputElement>('[data-ac-email]')?.value ?? draftEmail).trim();
	q<HTMLInputElement>('[data-ac-email]')?.addEventListener('input', (e) => { draftEmail = (e.target as HTMLInputElement).value; });

	const run = async (what: () => Promise<unknown>, after?: () => void): Promise<void> => {
		busy = true;
		formError = null;
		render(host);
		try {
			await what();
			after?.();
		} catch (err) {
			formError = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
			alog.warn('account action failed', { err: formError });
		} finally {
			busy = false;
			await refresh(host);
		}
	};

	const signIn = (): void => {
		const pw = q<HTMLInputElement>('[data-ac-password]')?.value ?? '';
		const e = email();
		if (!e || !pw) { formError = 'Enter your email and password.'; render(host); return; }
		draftEmail = e;
		void run(() => accountApi.signInPassword(e, pw), () => showToast('Signed in', { kind: 'success' }));
	};
	q<HTMLButtonElement>('[data-ac-signin]')?.addEventListener('click', signIn);
	q<HTMLInputElement>('[data-ac-password]')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); signIn(); } });

	q<HTMLButtonElement>('[data-ac-send-code]')?.addEventListener('click', () => {
		const e = email();
		if (!e) { formError = 'Enter your email first.'; render(host); return; }
		draftEmail = e;
		void run(() => accountApi.requestCode(e), () => { codeSentTo = e; });
	});
	const verify = (): void => {
		const code = q<HTMLInputElement>('[data-ac-code]')?.value.trim() ?? '';
		if (!code || !codeSentTo) return;
		const to = codeSentTo;
		void run(() => accountApi.verifyCode(to, code), () => { codeSentTo = null; showToast('Signed in', { kind: 'success' }); });
	};
	q<HTMLButtonElement>('[data-ac-verify]')?.addEventListener('click', verify);
	q<HTMLInputElement>('[data-ac-code]')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); verify(); } });
	q<HTMLButtonElement>('[data-ac-code-cancel]')?.addEventListener('click', () => { codeSentTo = null; formError = null; render(host); });
	(q<HTMLInputElement>('[data-ac-code]') ?? (draftEmail ? q<HTMLInputElement>('[data-ac-password]') : q<HTMLInputElement>('[data-ac-email]')))?.focus();
}

function renderDevicesSection(a: AccountStatus, s: CloudSyncStatusReport | null): string {
	const acts = accountActions(a, s);
	if (!acts.manageDevices) {
		return acts.revoked ? '' : `
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Devices</div>
			<div class="settings-toggle__hint">Devices appear here once sync is on.</div>
		</div>`;
	}
	const rows = devices === null
		? `<div class="settings-toggle__hint">Loading devices…</div>`
		: devices.length === 0
			? `<div class="settings-toggle__hint">No devices registered yet — this one registers on its first sync.</div>`
			: deviceRows(devices).map((d) => `
				<div class="settings-rekordbox__path-row backup__row">
					<span class="settings-ui__field-label">${escapeHtml(d.name)}${d.current ? ' <strong>(this computer)</strong>' : ''}</span>
					<span class="${d.revoked ? 'backup__banner backup__banner--warn' : 'settings-toggle__hint'}">${escapeHtml(d.detail)}${d.revoked ? ' · no longer syncs' : ''}</span>
					${d.canRevoke ? `<button class="btn-secondary" data-ac-revoke="${escapeHtml(d.deviceId)}" ${busy ? 'disabled' : ''}>Remove…</button>` : ''}
				</div>`).join('');
	return `
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Devices</div>
			${rows}
			<div class="settings-toggle__hint">${escapeHtml(DEVICES_HINT)}</div>
			<div class="settings-rekordbox__path-row backup__row">
				<span class="settings-ui__field-label"></span>
				<button class="btn-secondary" data-ac-signout-others ${busy ? 'disabled' : ''}>Sign out all other sessions…</button>
			</div>
		</div>
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">This computer</div>
			<div class="settings-toggle__hint">Stop syncing this library with your account. Nothing on this computer is deleted.</div>
			<div class="settings-rekordbox__path-row backup__row">
				<span class="settings-ui__field-label"></span>
				<button class="btn-secondary" data-ac-unlink ${busy ? 'disabled' : ''}>Unlink this library from my account…</button>
			</div>
		</div>`;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));

// One confirmed account action: the panel is busy while it runs, and a
// failure is a toast, never a half-rendered panel.
async function confirmed(host: HTMLElement, text: Parameters<AccountSettingsDeps['confirm']>[0], run: () => Promise<void>, failTitle: string, after: () => void = () => render(host)): Promise<void> {
	if (!deps || !(await deps.confirm(text))) return;
	busy = true;
	render(host);
	try {
		await run();
	} catch (err) {
		showToast(failTitle, { sub: errText(err), kind: 'error' });
	} finally {
		busy = false;
		after();
	}
}

function renderSignedIn(host: HTMLElement, a: AccountStatus, s: CloudSyncStatusReport | null): void {
	const line = syncLine(a, s);
	const acts = accountActions(a, s);
	host.innerHTML = `
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Curator account</div>
			<div class="settings-rekordbox__path-row backup__row">
				<span class="settings-ui__field-label">Signed in as</span>
				<span>${escapeHtml(a.email ?? 'unknown')}</span>
				<button class="${acts.revoked ? 'btn-primary' : 'btn-secondary'}" data-ac-signout ${busy ? 'disabled' : ''}>Sign out</button>
			</div>
			${a.persistent ? '' : `<div class="backup__banner backup__banner--warn">This system cannot store credentials securely, so you will be asked to sign in again after a restart.</div>`}
		</div>
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Library sync</div>
			<div class="settings-rekordbox__path-row backup__row">
				<span class="${line.tone === 'ok' ? 'settings-toggle__hint' : `backup__banner backup__banner--${line.tone}`}" data-ac-sync-line>${escapeHtml(line.text)}</span>
				${acts.revoked ? '' : `<button class="btn-primary" data-ac-sync-now ${acts.syncNow ? '' : 'disabled'}>Sync now</button>`}
			</div>
			${s && s.rejected > 0 ? `<div class="settings-toggle__hint">${s.rejected.toLocaleString()} ${s.rejected === 1 ? 'change was' : 'changes were'} refused by the server and will not be retried; see the log for details.</div>` : ''}
			${acts.revoked && s && s.pending > 0 ? `<div class="settings-toggle__hint">${s.pending.toLocaleString()} ${s.pending === 1 ? 'change is' : 'changes are'} kept on this computer and will upload if it is signed in again.</div>` : ''}
		</div>
		${acts.manageDevices ? `<div data-ac-library-host>${renderLibrarySection()}</div>` : ''}
		${acts.revoked ? '' : renderCatalogueSection(catalogue)}
		${a.syncAvailable && s?.enabled && !acts.revoked ? renderPollSection(s) : ''}
		${renderDevicesSection(a, s)}`;

	const q = <T extends Element>(sel: string): T | null => host.querySelector<T>(sel);
	wirePollSection(host);
	wireCatalogueSection(host);
	wireLibrarySection(host);
	q<HTMLButtonElement>('[data-ac-sync-now]')?.addEventListener('click', () => {
		void cloudSyncApi.syncNow().then((st) => { sync = st; render(host); }).catch((err) => {
			showToast('Sync failed', { sub: errText(err), kind: 'error' });
		});
	});
	// Revoked, main unlinks instead of a plain sign-out (a fresh device id),
	// so signing in again later is not refused all over again.
	q<HTMLButtonElement>('[data-ac-signout]')?.addEventListener('click', () => {
		busy = true;
		render(host);
		void accountApi.signOut()
			.then(() => { devices = null; showToast('Signed out', { sub: 'Your library stays on this computer.' }); })
			.catch((err) => showToast('Sign-out failed', { sub: errText(err), kind: 'error' }))
			.finally(() => { busy = false; void refresh(host); });
	});
	host.querySelectorAll<HTMLButtonElement>('[data-ac-revoke]').forEach((btn) => btn.addEventListener('click', () => {
		const id = btn.dataset.acRevoke!;
		const name = devices?.find((d) => d.deviceId === id)?.name ?? 'this device';
		void confirmed(host, revokeConfirm(name), async () => {
			devices = await accountApi.revokeDevice(id);
			showToast(`Removed ${name}`, { sub: 'It no longer syncs. If it was lost or stolen, also sign out all other sessions.', kind: 'success' });
		}, 'Could not remove the device');
	}));
	q<HTMLButtonElement>('[data-ac-signout-others]')?.addEventListener('click', () => {
		void confirmed(host, SIGN_OUT_OTHERS_CONFIRM, async () => {
			await accountApi.signOutOthers();
			showToast('Signed out all other sessions', { sub: 'This computer stays signed in.', kind: 'success' });
		}, 'Could not sign out other sessions');
	});
	q<HTMLButtonElement>('[data-ac-unlink]')?.addEventListener('click', () => {
		void confirmed(host, UNLINK_CONFIRM, async () => {
			const r = await cloudSyncApi.unlink();
			devices = null;
			showToast('Library unlinked', {
				sub: r.outcome && !r.outcome.revokedOnServer
					? 'Signed out. This computer could not be removed from the account’s devices just now; remove it from another computer.'
					: 'Signed out. Your library stays on this computer.',
			});
		}, 'Could not unlink', () => { void refresh(host); });
	});
}

// No Supabase project in this build: no sign-in form to fail on (the
// backupSettings "not available" banner pattern).
function renderNotConfigured(host: HTMLElement): void {
	host.innerHTML = `
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Curator account</div>
			<div class="backup__banner backup__banner--warn">Curator accounts and cloud sync are not configured in this build.</div>
			<div class="settings-toggle__hint">Sign-in needs CURATOR_SUPABASE_URL and CURATOR_SUPABASE_PUBLISHABLE_KEY, and library sync needs CURATOR_CLOUD_API_URL, set when the app is built. See .env.example. Everything else works locally.</div>
		</div>`;
}

// A status tick while the user is typing in this panel: refresh the live
// lines only, leaving the inputs (and the caret) alone.
function patchSignedIn(host: HTMLElement, a: AccountStatus, s: CloudSyncStatusReport | null): void {
	const line = syncLine(a, s);
	const el = host.querySelector<HTMLElement>('[data-ac-sync-line]');
	if (el) {
		el.textContent = line.text;
		el.className = line.tone === 'ok' ? 'settings-toggle__hint' : `backup__banner backup__banner--${line.tone}`;
	}
	host.querySelector<HTMLButtonElement>('[data-ac-sync-now]')?.toggleAttribute('disabled', !accountActions(a, s).syncNow);
	const poll = host.querySelector<HTMLElement>('[data-ac-poll-status]');
	if (poll && s) poll.textContent = pollLine(s);
	patchCatalogue(host);
}

function render(host: HTMLElement): void {
	if (!host.isConnected || !account) return;
	if (!account.configured) renderNotConfigured(host);
	else if (account.signedIn) renderSignedIn(host, account, sync);
	else renderSignedOut(host, account);
}

async function refresh(host: HTMLElement): Promise<void> {
	try {
		const [a, s, ps, cs] = await Promise.all([
			accountApi.status(),
			cloudSyncApi.status(),
			cloudSyncApi.pollSettings().catch((err) => { alog.warn('poll settings failed', { err: String(err) }); return pollSettings; }),
			catalogueApi.status().catch((err) => { alog.warn('catalogue status failed', { err: String(err) }); return catalogue; }),
		]);
		account = a;
		sync = s;
		pollSettings = ps;
		catalogue = cs;
		render(host);
		// A revoked computer is refused the list (and everything else).
		if (a.signedIn && accountActions(a, s).manageDevices) {
			// Fresh count + master each time the panel opens (the listener
			// below repaints the section when it lands).
			void refreshAccountLibraryInfo();
			devices = await accountApi.devices().catch((err) => { alog.warn('devices failed', { err: String(err) }); return devices ?? []; });
			render(host);
		}
	} catch (err) {
		alog.warn('status failed', { err: String(err) });
		host.innerHTML = '<div class="settings-toggle__hint">Account status unavailable.</div>';
	}
}

export function mountAccountSettings(host: HTMLElement): void {
	unsubscribe?.();
	unsubscribeCatalogue?.();
	unsubscribeLibrary?.();
	formError = null;
	masterError = null;
	unsubscribeLibrary = onAccountLibraryInfo(() => {
		if (!host.isConnected) { unsubscribeLibrary?.(); unsubscribeLibrary = null; return; }
		paintLibrary(host);
	});
	// Shared analysis ticks patch their own lines in place (they arrive
	// during a hydrate or an upload, often while the user is in this panel).
	unsubscribeCatalogue = catalogueApi.onStatus((c) => {
		if (!host.isConnected) { unsubscribeCatalogue?.(); unsubscribeCatalogue = null; return; }
		const hadSection = !!catalogue;
		catalogue = c;
		if (!account?.signedIn) return;
		if (!hadSection || !host.querySelector('[data-ac-cat-line]')) {
			// A focused selector counts too: a re-render would close its dropdown.
			const typing = (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement) && host.contains(document.activeElement);
			if (!typing) render(host);
			return;
		}
		patchCatalogue(host);
	});
	unsubscribe = cloudSyncApi.onStatus((s) => {
		if (!host.isConnected) { unsubscribe?.(); unsubscribe = null; return; }
		const wasSignedIn = account?.signedIn ?? false;
		sync = s;
		// A sign-in / sign-out arrives as a status change: refetch the account
		// then. Otherwise only the signed-in view repaints (see header).
		if (s.signedIn !== wasSignedIn) void refresh(host);
		else if (wasSignedIn && account) {
			// A focused selector counts too: a re-render would close its dropdown.
			const typing = (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement) && host.contains(document.activeElement);
			if (typing) patchSignedIn(host, account, s);
			else render(host);
		}
	});
	void refresh(host);
}
