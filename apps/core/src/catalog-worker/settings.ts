// The user's tracking choices: which sources are read for their follows,
// per kind (the Discover toolbar's Refresh menu). Unchecked means nobody
// reads it — not this desktop, not the cloud: the worker sends the checked
// trackers with every ask (catalog.workerDue `trackers`) and the master
// leases a cursor only when some follower wants it. Default: everything on.
//
// And how often each kind is read (Settings → Discover; protocol
// CatalogReadCadence): once a week in the Friday window by default, daily, or
// as often as the source allows. Sent the same way (catalog.workerDue
// `cadence`); the master times the cursors by it.
//
// Per-device, never synced (the keys are not in ACCOUNT_SETTING_KEYS): the
// device holding the user's week is the one whose choices count, so two
// desktops of one user say the same thing or the holder's wins.

import type Database from 'better-sqlite3';
import { CATALOG_TRACKERS, cloudConfigOr, trackerKey, type CatalogProvider, type CatalogReadCadence, type CatalogTracker, type CatalogTrackingKind, type CloudConfigEnvelope } from '@curator/protocol';

type Raw = Database.Database;

export const READ_SOURCES_KEY = 'catalog.read_sources';
// The cloud's scheduling values as it last told this desktop (protocol
// cloud-config.ts), kept across restarts.
export const CLOUD_CONFIG_KEY = 'cloud.config';

export type { CatalogReadCadence };

// What the renderer shows: the matrix resolved, so it needs no constant of
// its own (it imports neither the protocol nor the readers).
export type CatalogReadSources = {
	kind: CatalogTrackingKind;
	cadence: CatalogReadCadence;
	sources: { provider: CatalogProvider; checked: boolean; cloudOnly: boolean }[];
}[];
export type CatalogReadSourcesPatch = Partial<Record<CatalogTracker, boolean>>;

function readStored<T>(raw: Raw, key: string): Record<string, T> {
	const row = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(key) as { value: string } | undefined;
	if (!row) return {};
	try {
		const v = JSON.parse(row.value) as unknown;
		return v && typeof v === 'object' ? (v as Record<string, T>) : {};
	} catch {
		return {};
	}
}

function writeStored(raw: Raw, key: string, value: object): void {
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(key, JSON.stringify(value), Date.now());
}

// The cloud's config this desktop holds: the defaults until the cloud said.
export function readCloudConfig(raw: Raw): CloudConfigEnvelope {
	const row = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(CLOUD_CONFIG_KEY) as { value: string } | undefined;
	try {
		return cloudConfigOr(row ? JSON.parse(row.value) : null);
	} catch {
		return cloudConfigOr(null);
	}
}

export function writeCloudConfig(raw: Raw, config: CloudConfigEnvelope): void {
	writeStored(raw, CLOUD_CONFIG_KEY, cloudConfigOr(config));
}

// How often each kind of follow is read: the cloud's, one for everyone.
export function readCadence(raw: Raw): Record<CatalogTrackingKind, CatalogReadCadence> {
	return readCloudConfig(raw).values.readCadence;
}

// Unknown keys are ignored, missing ones are on.
const resolve = (stored: Record<string, boolean>, cadence: Record<CatalogTrackingKind, CatalogReadCadence>): CatalogReadSources => {
	const out: CatalogReadSources = [];
	for (const t of CATALOG_TRACKERS) {
		let row = out.find((r) => r.kind === t.kind);
		if (!row) out.push((row = { kind: t.kind, cadence: cadence[t.kind], sources: [] }));
		row.sources.push({ provider: t.provider, checked: stored[trackerKey(t.kind, t.provider)] !== false, cloudOnly: t.cloudOnly });
	}
	return out;
};

export function readReadSources(raw: Raw): CatalogReadSources {
	return resolve(readStored<boolean>(raw, READ_SOURCES_KEY), readCadence(raw));
}

// The checked trackers, as the worker offers them.
export function checkedTrackers(raw: Raw): CatalogTracker[] {
	return readReadSources(raw).flatMap((r) => r.sources.filter((s) => s.checked).map((s) => trackerKey(r.kind, s.provider)));
}

// A patch over the current choices; null forgets them (everything on).
// Raw SQL like sync-log/poll-policy.ts: a device key, never an op.
export function writeReadSources(raw: Raw, patch: CatalogReadSourcesPatch | null): CatalogReadSources {
	if (patch === null) {
		raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(READ_SOURCES_KEY);
	} else {
		const known = new Set<string>(CATALOG_TRACKERS.map((t) => trackerKey(t.kind, t.provider)));
		const next = { ...readStored<boolean>(raw, READ_SOURCES_KEY) };
		for (const [k, v] of Object.entries(patch)) if (known.has(k) && typeof v === 'boolean') next[k] = v;
		writeStored(raw, READ_SOURCES_KEY, next);
	}
	return readReadSources(raw);
}

