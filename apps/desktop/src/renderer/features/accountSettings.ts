// Settings → Account: the Curator account (cloud) and library sync.
//
// Signed out: email + password, or "email me a code" (one-time code /
// magic link). Signed in: the email, the sync status line, Sync now, shared
// analysis (reuse toggle, holdings, the "upload existing analysis" button),
// the account's devices, sign out. The session and every token live in main;
// this panel only ever sees status (account:status, cloud-sync:status,
// catalogue:status).
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

type AccountStatus = Awaited<ReturnType<typeof accountApi.status>>;
type AccountDevice = Awaited<ReturnType<typeof accountApi.devices>>[number];

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

function fmtWhen(ms: number | null): string {
	if (!ms) return 'never';
	const ago = Date.now() - ms;
	if (ago < 60_000) return 'just now';
	if (ago < 3_600_000) return `${Math.round(ago / 60_000)} min ago`;
	return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// One line that says where sync stands, most urgent first.
function syncLine(a: AccountStatus, s: CloudSyncStatusReport | null): { text: string; tone: 'ok' | 'warn' | 'error' } {
	if (!a.syncAvailable || !s?.enabled) return { text: 'Library sync is not configured in this build (CURATOR_CLOUD_API_URL) — your account is ready for when it is.', tone: 'warn' };
	if (s.needsUpdate) return { text: 'Update Curator to keep syncing. Your changes are kept and will sync after the update.', tone: 'error' };
	if (s.initialPush) return { text: `Uploading your library… ${s.initialPush.done.toLocaleString()} of about ${s.initialPush.estimate.toLocaleString()} changes`, tone: 'ok' };
	if (s.bootstrap) return { text: `Downloading your library… ${s.bootstrap.done.toLocaleString()} of ${s.bootstrap.total.toLocaleString()}`, tone: 'ok' };
	if (s.lastError) return { text: `${s.lastError}${s.pending > 0 ? ` · ${s.pending.toLocaleString()} changes waiting` : ''}`, tone: 'error' };
	if (s.running) return { text: 'Syncing…', tone: 'ok' };
	const last = Math.max(s.lastPushAt ?? 0, s.lastPullAt ?? 0) || null;
	if (s.pending > 0) return { text: `${s.pending.toLocaleString()} changes waiting to sync · last synced ${fmtWhen(last)}`, tone: 'ok' };
	return { text: `Up to date · last synced ${fmtWhen(last)}`, tone: 'ok' };
}

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

function renderSignedIn(host: HTMLElement, a: AccountStatus, s: CloudSyncStatusReport | null): void {
	const line = syncLine(a, s);
	const canSync = canSyncNow(a, s);
	const deviceRows = devices === null
		? `<div class="settings-toggle__hint">${a.syncAvailable ? 'Loading devices…' : 'Devices appear here once sync is on.'}</div>`
		: devices.length === 0
			? `<div class="settings-toggle__hint">No devices registered yet — this one registers on its first sync.</div>`
			: devices.map((d) => `
				<div class="settings-rekordbox__path-row backup__row">
					<span class="settings-ui__field-label">${escapeHtml(d.name)}${d.current ? ' (this computer)' : ''}</span>
					<span class="settings-toggle__hint">${escapeHtml(d.platform)} · added ${escapeHtml(fmtWhen(d.registeredAt))}${d.lastSeenAt ? ` · last seen ${escapeHtml(fmtWhen(d.lastSeenAt))}` : ''}${d.revokedAt ? ' · removed' : ''}</span>
				</div>`).join('');
	host.innerHTML = `
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Curator account</div>
			<div class="settings-rekordbox__path-row backup__row">
				<span class="settings-ui__field-label">Signed in as</span>
				<span>${escapeHtml(a.email ?? 'unknown')}</span>
				<button class="btn-secondary" data-ac-signout ${busy ? 'disabled' : ''}>Sign out</button>
			</div>
			${a.persistent ? '' : `<div class="backup__banner backup__banner--warn">This system cannot store credentials securely, so you will be asked to sign in again after a restart.</div>`}
		</div>
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Library sync</div>
			<div class="settings-rekordbox__path-row backup__row">
				<span class="${line.tone === 'ok' ? 'settings-toggle__hint' : `backup__banner backup__banner--${line.tone}`}" data-ac-sync-line>${escapeHtml(line.text)}</span>
				<button class="btn-primary" data-ac-sync-now ${canSync ? '' : 'disabled'}>Sync now</button>
			</div>
			${s && s.rejected > 0 ? `<div class="settings-toggle__hint">${s.rejected.toLocaleString()} ${s.rejected === 1 ? 'change was' : 'changes were'} refused by the server and will not be retried; see the log for details.</div>` : ''}
		</div>
		${renderCatalogueSection(catalogue)}
		${a.syncAvailable && s?.enabled ? renderPollSection(s) : ''}
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Devices</div>
			${deviceRows}
		</div>`;

	const q = <T extends Element>(sel: string): T | null => host.querySelector<T>(sel);
	wirePollSection(host);
	wireCatalogueSection(host);
	q<HTMLButtonElement>('[data-ac-sync-now]')?.addEventListener('click', () => {
		void cloudSyncApi.syncNow().then((st) => { sync = st; render(host); }).catch((err) => {
			showToast('Sync failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' });
		});
	});
	q<HTMLButtonElement>('[data-ac-signout]')?.addEventListener('click', () => {
		busy = true;
		render(host);
		void accountApi.signOut()
			.then(() => { devices = null; showToast('Signed out', { sub: 'Your library stays on this computer.' }); })
			.catch((err) => showToast('Sign-out failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error' }))
			.finally(() => { busy = false; void refresh(host); });
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

const canSyncNow = (a: AccountStatus, s: CloudSyncStatusReport | null): boolean =>
	a.syncAvailable && !!s?.enabled && !s.running && !s.initialPush && !s.bootstrap;

// A status tick while the user is typing in this panel: refresh the live
// lines only, leaving the inputs (and the caret) alone.
function patchSignedIn(host: HTMLElement, a: AccountStatus, s: CloudSyncStatusReport | null): void {
	const line = syncLine(a, s);
	const el = host.querySelector<HTMLElement>('[data-ac-sync-line]');
	if (el) {
		el.textContent = line.text;
		el.className = line.tone === 'ok' ? 'settings-toggle__hint' : `backup__banner backup__banner--${line.tone}`;
	}
	host.querySelector<HTMLButtonElement>('[data-ac-sync-now]')?.toggleAttribute('disabled', !canSyncNow(a, s));
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
		if (a.signedIn && a.syncAvailable) {
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
	formError = null;
	// Shared analysis ticks patch their own lines in place (they arrive
	// during a hydrate or an upload, often while the user is in this panel).
	unsubscribeCatalogue = catalogueApi.onStatus((c) => {
		if (!host.isConnected) { unsubscribeCatalogue?.(); unsubscribeCatalogue = null; return; }
		const hadSection = !!catalogue;
		catalogue = c;
		if (!account?.signedIn) return;
		if (!hadSection || !host.querySelector('[data-ac-cat-line]')) {
			const typing = document.activeElement instanceof HTMLInputElement && host.contains(document.activeElement);
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
			const typing = document.activeElement instanceof HTMLInputElement && host.contains(document.activeElement);
			if (typing) patchSignedIn(host, account, s);
			else render(host);
		}
	});
	void refresh(host);
}
