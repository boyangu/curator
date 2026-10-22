// Settings → Account, the parts that decide what the panel says and offers:
// the sync line, each device row, which actions are available, and the
// confirm dialogs' wording. Pure (types-only imports), so it is tested
// without a DOM; accountSettings.ts renders it.

import type { CloudSyncStatusReport } from '@curator/core';
import type { accountApi } from '../data/api.js';

export type AccountStatus = Awaited<ReturnType<typeof accountApi.status>>;
export type AccountDevice = Awaited<ReturnType<typeof accountApi.devices>>[number];

export type Tone = 'ok' | 'warn' | 'error';

// "12s ago" / "6m ago" / "3h ago" / "2d ago": the compact form the status
// lines tick every second, so it must not jump between wordings.
export function fmtAgo(ms: number | null, now = Date.now()): string {
	if (!ms) return 'never';
	const s = Math.max(0, Math.floor((now - ms) / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

export function fmtWhen(ms: number | null, now = Date.now()): string {
	if (!ms) return 'never';
	const ago = now - ms;
	if (ago < 60_000) return 'just now';
	if (ago < 3_600_000) return `${Math.round(ago / 60_000)} min ago`;
	return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const REVOKED_LINE = 'This computer was removed from your Curator account, so nothing is uploaded or downloaded any more. Your library and any changes not uploaded yet stay on this computer. Sign out to stop using the account here; signing in again later adds this computer back as a new device.';

// One line that says where sync stands, most urgent first.
export function syncLine(a: AccountStatus, s: CloudSyncStatusReport | null, now = Date.now()): { text: string; tone: Tone } {
	if (!a.syncAvailable || !s?.enabled) return { text: 'Library sync is not configured in this build (CURATOR_CLOUD_API_URL) — your account is ready for when it is.', tone: 'warn' };
	if (s.revoked) return { text: REVOKED_LINE, tone: 'error' };
	if (s.needsUpdate) return { text: 'Update Curator to keep syncing. Your changes are kept and will sync after the update.', tone: 'error' };
	if (s.initialPush) return { text: `Uploading your library… ${s.initialPush.done.toLocaleString()} of about ${s.initialPush.estimate.toLocaleString()} changes`, tone: 'ok' };
	if (s.bootstrap) return { text: `Downloading your library… ${s.bootstrap.done.toLocaleString()} of ${s.bootstrap.total.toLocaleString()}`, tone: 'ok' };
	// A backlog going up as one server batch: staged first, then published
	// at once (other devices see none of it until the commit is done).
	if (s.batch?.phase === 'uploading') return { text: `Uploading your library (batch)… ${s.batch.done.toLocaleString()} of ${s.batch.total.toLocaleString()} changes`, tone: 'ok' };
	if (s.batch?.phase === 'committing') return { text: `Publishing your library upload… ${s.batch.done.toLocaleString()} of ${s.batch.total.toLocaleString()} changes`, tone: 'ok' };
	if (s.lastError) return { text: `${s.lastError}${s.pending > 0 ? ` · ${s.pending.toLocaleString()} changes waiting` : ''}`, tone: 'error' };
	// "Syncing…" only while changes actually move; a routine check (every
	// minute or on focus) moves nothing and must not flip the label.
	if (s.transferring) return { text: 'Syncing…', tone: 'ok' };
	const checked = s.lastCheckedAt ?? (Math.max(s.lastPushAt ?? 0, s.lastPullAt ?? 0) || null);
	if (s.pending > 0) return { text: `${s.pending.toLocaleString()} changes waiting to sync · last checked ${fmtAgo(checked, now)}`, tone: 'ok' };
	return { text: `Up to date · last checked ${fmtAgo(checked, now)}`, tone: 'ok' };
}

// What the signed-in panel offers. A revoked computer is refused by the
// server for everything, its device list included, so it gets the sign-out
// and nothing that would only fail.
export function accountActions(a: AccountStatus, s: CloudSyncStatusReport | null): {
	syncNow: boolean;
	revoked: boolean;
	manageDevices: boolean;
	unlink: boolean;
} {
	const sync = a.syncAvailable && !!s?.enabled;
	const revoked = sync && !!s?.revoked;
	return {
		syncNow: sync && !revoked && !s!.running && !s!.initialPush && !s!.bootstrap,
		revoked,
		manageDevices: sync && !revoked,
		unlink: sync && !revoked,
	};
}

const PLATFORM: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux', ios: 'iPhone / iPad', android: 'Android' };

export type DeviceRow = {
	deviceId: string;
	name: string;
	// "Windows · last seen 5 min ago" / "· removed 3 Oct 2026"
	detail: string;
	current: boolean;
	revoked: boolean;
	// Only another, still active device: this computer is unlinked instead.
	canRevoke: boolean;
};

export function deviceRows(devices: readonly AccountDevice[], now = Date.now()): DeviceRow[] {
	// This computer first, then active ones, removed ones last.
	const rank = (d: AccountDevice): number => (d.current ? 0 : d.revokedAt === null ? 1 : 2);
	return [...devices]
		.sort((x, y) => rank(x) - rank(y) || (y.lastSeenAt ?? y.registeredAt) - (x.lastSeenAt ?? x.registeredAt))
		.map((d) => {
			const parts = [PLATFORM[d.platform] ?? d.platform];
			parts.push(d.lastSeenAt ? `last seen ${fmtWhen(d.lastSeenAt, now)}` : `added ${fmtWhen(d.registeredAt, now)}`);
			if (d.revokedAt !== null) parts.push(`removed ${fmtWhen(d.revokedAt, now)}`);
			return {
				deviceId: d.deviceId,
				name: d.name,
				detail: parts.join(' · '),
				current: d.current,
				revoked: d.revokedAt !== null,
				canRevoke: !d.current && d.revokedAt === null,
			};
		});
}

export type ConfirmText = { title: string; message: string; note?: string; confirmLabel: string; danger?: boolean };

export function revokeConfirm(name: string): ConfirmText {
	return {
		title: `Remove “${name}” from your account?`,
		message: 'It stops syncing at once: it can no longer upload, download or reuse shared analysis. Nothing is deleted on that computer; its library stays there. This is final for that device: to sync it again, it has to sign out and sign in again as a new device.',
		note: 'If the computer was lost or stolen, also use “Sign out all other sessions” so its sign-in ends for good.',
		confirmLabel: 'Remove device',
		danger: true,
	};
}

export const SIGN_OUT_OTHERS_CONFIRM: ConfirmText = {
	title: 'Sign out all other sessions?',
	message: 'Every other sign-in of this account ends, on all your computers and phones, within the hour. This computer stays signed in. Your other computers keep their libraries and pick up syncing once you sign in on them again.',
	confirmLabel: 'Sign out others',
	danger: true,
};

export const UNLINK_CONFIRM: ConfirmText = {
	title: 'Unlink this library from your account?',
	message: 'This computer stops syncing, signs out and is removed from your account’s devices. Nothing here is deleted: your library and any changes not uploaded yet stay on this computer.',
	note: 'Sign in again with the same account and this library rejoins as a new device and uploads what it hadn’t yet. It can’t sync with a different account: its sync history belongs to this one.',
	confirmLabel: 'Unlink',
	danger: true,
};

// ── The account's union library (core AccountLibraryInfo) ───────────────

// "N tracks in your account aren't on this device"; null when there are
// none (the line is hidden).
export function remoteOnlyLine(n: number): string | null {
	if (n <= 0) return null;
	return n === 1
		? '1 track in your account isn’t on this device. It shows in your library, marked, but can’t be played or analysed here.'
		: `${n.toLocaleString()} tracks in your account aren’t on this device. They show in your library, marked, but can’t be played or analysed here.`;
}

export const MASTER_HINT = 'The master device’s track details (title, artists, album, label) win on your other devices for every track it holds; the others only fill in tracks it doesn’t have.';

export const MASTER_UNAVAILABLE = 'Your sync server doesn’t share track details yet, so there is no master device to choose. Update the server, then sync.';

export type MasterChoice = { deviceId: string; label: string; selected: boolean };

// The selector's options: the account's active devices, this computer
// first. A master that is no longer among them (removed, or a device this
// list hasn't seen) still shows, so the selector never silently claims a
// different one; no master yet shows a placeholder.
export function masterChoices(devices: readonly AccountDevice[], masterDeviceId: string | null): MasterChoice[] {
	const active = deviceRows(devices).filter((d) => !d.revoked);
	const out: MasterChoice[] = active.map((d) => ({
		deviceId: d.deviceId,
		label: d.current ? `${d.name} (this computer)` : d.name,
		selected: d.deviceId === masterDeviceId,
	}));
	if (masterDeviceId === null) {
		out.unshift({ deviceId: '', label: 'Not chosen yet', selected: true });
	} else if (!out.some((c) => c.selected)) {
		const gone = devices.find((d) => d.deviceId === masterDeviceId);
		out.unshift({ deviceId: masterDeviceId, label: gone ? `${gone.name} (removed)` : 'A device not in this list', selected: true });
	}
	return out;
}

// Under the devices list: why removing a device is not the whole job.
export const DEVICES_HINT = 'Removing a device stops its syncing at once. Its sign-in stays valid until it expires, so for a lost or stolen computer also sign out all other sessions; your own other computers then just sign in again.';
