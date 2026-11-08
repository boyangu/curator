// The user's tracking choices: which sources are read for their follows,
// per kind (the Discover toolbar's Refresh menu). Unchecked means nobody
// reads it — not this desktop, not the cloud: the worker sends the checked
// trackers with every ask (catalog.workerDue `trackers`) and the master
// leases a cursor only when some follower wants it. Default: everything on.
//
// Per-device, never synced (the key is not in ACCOUNT_SETTING_KEYS): the
// device holding the user's week is the one whose choices count, so two
// desktops of one user say the same thing or the holder's wins.

import type Database from 'better-sqlite3';
import { CATALOG_TRACKERS, trackerKey, type CatalogProvider, type CatalogTracker, type CatalogTrackingKind } from '@curator/protocol';

type Raw = Database.Database;

export const READ_SOURCES_KEY = 'catalog.read_sources';

// What the renderer shows: the matrix resolved, so it needs no constant of
// its own (it imports neither the protocol nor the readers).
export type CatalogReadSources = {
	kind: CatalogTrackingKind;
	sources: { provider: CatalogProvider; checked: boolean; cloudOnly: boolean }[];
}[];
export type CatalogReadSourcesPatch = Partial<Record<CatalogTracker, boolean>>;

function readStored(raw: Raw): Record<string, boolean> {
	const row = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(READ_SOURCES_KEY) as { value: string } | undefined;
	if (!row) return {};
	try {
		const v = JSON.parse(row.value) as unknown;
		return v && typeof v === 'object' ? (v as Record<string, boolean>) : {};
	} catch {
		return {};
	}
}

// Unknown keys are ignored, missing ones are on.
const resolve = (stored: Record<string, boolean>): CatalogReadSources => {
	const out: CatalogReadSources = [];
	for (const t of CATALOG_TRACKERS) {
		let row = out.find((r) => r.kind === t.kind);
		if (!row) out.push((row = { kind: t.kind, sources: [] }));
		row.sources.push({ provider: t.provider, checked: stored[trackerKey(t.kind, t.provider)] !== false, cloudOnly: t.cloudOnly });
	}
	return out;
};

export function readReadSources(raw: Raw): CatalogReadSources {
	return resolve(readStored(raw));
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
		const next = { ...readStored(raw) };
		for (const [k, v] of Object.entries(patch)) if (known.has(k) && typeof v === 'boolean') next[k] = v;
		raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
			.run(READ_SOURCES_KEY, JSON.stringify(next), Date.now());
	}
	return readReadSources(raw);
}
