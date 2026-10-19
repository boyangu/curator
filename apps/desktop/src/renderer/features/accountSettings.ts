// Settings → Account: the Curator account (cloud) and library sync.
//
// Signed out: email + password, or "email me a code" (one-time code /
// magic link). Signed in: the email, the sync status line, Sync now, the
// account's devices, sign out. The session and every token live in main;
// this panel only ever sees status (account:status, cloud-sync:status).
//
// Thin view, the backupSettings pattern: render from the two statuses,
// write through accountApi / cloudSyncApi, re-render on cloud-sync:status
// while the host is in the DOM. While signed out a status tick does NOT
// re-render (it would wipe a half-typed password); only a sign-in does.

import type { CloudSyncStatusReport } from '@curator/core';
import { accountApi, cloudSyncApi } from '../data/api.js';
import { log } from '../data/log.js';
import { escapeHtml } from '../ui/format.js';
import { showToast } from '../ui/toast.js';

type AccountStatus = Awaited<ReturnType<typeof accountApi.status>>;
type AccountDevice = Awaited<ReturnType<typeof accountApi.devices>>[number];

const alog = log.for('account-settings');

let unsubscribe: (() => void) | null = null;
let account: AccountStatus | null = null;
let sync: CloudSyncStatusReport | null = null;
let devices: AccountDevice[] | null = null;
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
	const canSync = a.syncAvailable && !!s?.enabled && !s.running && !s.initialPush && !s.bootstrap;
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
		<div class="settings-ui__section">
			<div class="settings-ui__section-label">Devices</div>
			${deviceRows}
		</div>`;

	const q = <T extends Element>(sel: string): T | null => host.querySelector<T>(sel);
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

function render(host: HTMLElement): void {
	if (!host.isConnected || !account) return;
	if (!account.configured) renderNotConfigured(host);
	else if (account.signedIn) renderSignedIn(host, account, sync);
	else renderSignedOut(host, account);
}

async function refresh(host: HTMLElement): Promise<void> {
	try {
		const [a, s] = await Promise.all([accountApi.status(), cloudSyncApi.status()]);
		account = a;
		sync = s;
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
	formError = null;
	unsubscribe = cloudSyncApi.onStatus((s) => {
		if (!host.isConnected) { unsubscribe?.(); unsubscribe = null; return; }
		const wasSignedIn = account?.signedIn ?? false;
		sync = s;
		// A sign-in / sign-out arrives as a status change: refetch the account
		// then. Otherwise only the signed-in view repaints (see header).
		if (s.signedIn !== wasSignedIn) void refresh(host);
		else if (wasSignedIn) render(host);
	});
	void refresh(host);
}
