// The cloud sync client's fallback poll cadence. Realtime wake-ups, focus,
// network regain and local writes all trigger a cycle on their own; this
// poll only catches what Realtime missed, so it can relax once nobody is at
// the app: every `activeSec` while in use, every `idleSec` after
// `idleAfterSec` without use. Whether the app is "in use" is the host's call
// (desktop main watches window focus and OS idle time); core only applies it.
//
// Per-device, never synced: a laptop on battery and an always-on studio box
// want different cadences. The key is deliberately NOT in the protocol's
// ACCOUNT_SETTING_KEYS allow-list, so it never rides an op.

import type Database from 'better-sqlite3';

type Raw = Database.Database;

export type SyncPollPolicy = { activeSec: number; idleSec: number; idleAfterSec: number };

export const SYNC_POLL_KEY = 'sync.poll';

export const DEFAULT_SYNC_POLL_POLICY: Readonly<SyncPollPolicy> = Object.freeze({ activeSec: 60, idleSec: 600, idleAfterSec: 600 });

// Floors keep a typo from hammering the server (or the main loop); ceilings
// keep the fallback meaningful when Realtime is down for hours.
export const SYNC_POLL_LIMITS: Readonly<Record<keyof SyncPollPolicy, readonly [min: number, max: number]>> = Object.freeze({
	activeSec: [15, 600] as const,
	idleSec: [60, 3600] as const,
	idleAfterSec: [60, 7200] as const,
});

// What the settings panel reads: the effective policy plus the defaults and
// limits, so the renderer never hard-codes them.
export type SyncPollSettings = {
	policy: SyncPollPolicy;
	defaults: SyncPollPolicy;
	limits: Record<keyof SyncPollPolicy, readonly [number, number]>;
	// False until the user saved a value (the defaults apply).
	stored: boolean;
};

function clampField(key: keyof SyncPollPolicy, v: unknown): number {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	if (!Number.isFinite(n)) return DEFAULT_SYNC_POLL_POLICY[key];
	const [min, max] = SYNC_POLL_LIMITS[key];
	return Math.min(max, Math.max(min, Math.round(n)));
}

// Missing or garbage fields take the default; every field is clamped; and
// the idle cadence is never faster than the active one (that would make
// "idle" the busier state).
export function normalizePollPolicy(p: Partial<Record<keyof SyncPollPolicy, unknown>> | null | undefined): SyncPollPolicy {
	const src = p ?? {};
	const activeSec = clampField('activeSec', src.activeSec);
	const idleSec = Math.max(activeSec, clampField('idleSec', src.idleSec));
	const idleAfterSec = clampField('idleAfterSec', src.idleAfterSec);
	return { activeSec, idleSec, idleAfterSec };
}

export function samePollPolicy(a: SyncPollPolicy, b: SyncPollPolicy): boolean {
	return a.activeSec === b.activeSec && a.idleSec === b.idleSec && a.idleAfterSec === b.idleAfterSec;
}

function readStored(raw: Raw): Partial<SyncPollPolicy> | null {
	const row = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(SYNC_POLL_KEY) as { value: string } | undefined;
	if (!row) return null;
	try {
		const v = JSON.parse(row.value) as unknown;
		return v && typeof v === 'object' ? (v as Partial<SyncPollPolicy>) : null;
	} catch {
		return null;
	}
}

export function readPollSettings(raw: Raw): SyncPollSettings {
	const stored = readStored(raw);
	return {
		policy: normalizePollPolicy(stored),
		defaults: { ...DEFAULT_SYNC_POLL_POLICY },
		limits: { ...SYNC_POLL_LIMITS },
		stored: stored !== null,
	};
}

export function readPollPolicy(raw: Raw): SyncPollPolicy {
	return normalizePollPolicy(readStored(raw));
}

// A patch over the current policy, normalised before it is stored; null
// forgets the stored value (back to the defaults). Raw SQL, like the
// client's own `sync.client` state: this key never emits an op, so it does
// not go through the mutator layer's setSetting.
export function writePollPolicy(raw: Raw, patch: Partial<SyncPollPolicy> | null): SyncPollSettings {
	if (patch === null) {
		raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(SYNC_POLL_KEY);
	} else {
		const merged: Partial<Record<keyof SyncPollPolicy, unknown>> = { ...readPollPolicy(raw) };
		for (const k of Object.keys(SYNC_POLL_LIMITS) as Array<keyof SyncPollPolicy>) {
			if (patch[k] !== undefined) merged[k] = patch[k];
		}
		const next = normalizePollPolicy(merged);
		raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
			.run(SYNC_POLL_KEY, JSON.stringify(next), Date.now());
	}
	return readPollSettings(raw);
}
