// The device-local mirror of the account's catalogue (`catalogue_entry`,
// schema.ts) and the catalogue's device-local app_setting keys. Raw SQL on
// the better-sqlite3 handle, like the sync client's state: every call here is
// a few indexed statements, and the callers batch them into one transaction.

import type Database from 'better-sqlite3';
import { compareVersions, parseVersionString, type CatalogueInventoryEntry } from '@curator/protocol';
import type { CatalogueLocalState } from '@curator/shared/schema';
import { CATALOGUE_KBPS_LIMITS, DEFAULT_CATALOGUE_SETTINGS, type CatalogueBackfillState, type CatalogueSettings } from './types.js';
import { keyId, type UnitKey } from './local.js';
import { stmt } from './stmt.js';

type Raw = Database.Database;

// ── app_setting keys (device-local, never synced: not account setting keys) ─

export const CATALOGUE_SETTINGS_KEY = 'catalogue.settings';
export const CATALOGUE_INVENTORY_REV_KEY = 'catalogue.inventory_rev';
// The user id the mirror and the inventory cursor belong to. A different
// account signing in empties both: what one account holds says nothing
// about another's.
export const CATALOGUE_ACCOUNT_KEY = 'catalogue.account';

function readSetting(raw: Raw, key: string): unknown {
	const row = stmt(raw, `SELECT value FROM app_setting WHERE key = ?`).get(key) as { value: string } | undefined;
	if (!row) return undefined;
	try { return JSON.parse(row.value) as unknown; } catch { return undefined; }
}

function writeSetting(raw: Raw, key: string, value: unknown): void {
	stmt(raw, `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(key, JSON.stringify(value), Date.now());
}

const BACKFILL_STATES: readonly CatalogueBackfillState[] = ['off', 'running', 'paused', 'done'];

export function clampKbps(n: number): number {
	const [lo, hi] = CATALOGUE_KBPS_LIMITS;
	return Math.min(hi, Math.max(lo, Math.round(n)));
}

export function readCatalogueSettings(raw: Raw): CatalogueSettings {
	const v = readSetting(raw, CATALOGUE_SETTINGS_KEY);
	const s = (v && typeof v === 'object' ? v : {}) as Partial<CatalogueSettings>;
	return {
		enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_CATALOGUE_SETTINGS.enabled,
		vectors: typeof s.vectors === 'boolean' ? s.vectors : DEFAULT_CATALOGUE_SETTINGS.vectors,
		backfill: BACKFILL_STATES.includes(s.backfill as CatalogueBackfillState) ? s.backfill as CatalogueBackfillState : DEFAULT_CATALOGUE_SETTINGS.backfill,
		maxKBps: typeof s.maxKBps === 'number' && Number.isFinite(s.maxKBps) ? clampKbps(s.maxKBps) : DEFAULT_CATALOGUE_SETTINGS.maxKBps,
	};
}

export function writeCatalogueSettings(raw: Raw, s: CatalogueSettings): void {
	writeSetting(raw, CATALOGUE_SETTINGS_KEY, s);
}

export function readInventoryRev(raw: Raw): number {
	const v = readSetting(raw, CATALOGUE_INVENTORY_REV_KEY);
	return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

export function writeInventoryRev(raw: Raw, rev: number): void {
	writeSetting(raw, CATALOGUE_INVENTORY_REV_KEY, rev);
}

export function readMirrorAccount(raw: Raw): string | null {
	const v = readSetting(raw, CATALOGUE_ACCOUNT_KEY);
	return v && typeof v === 'object' && typeof (v as { userId?: unknown }).userId === 'string' ? (v as { userId: string }).userId : null;
}

// Binds the mirror to `userId`, emptying it (and rewinding the inventory
// cursor) when it belonged to someone else. True when it was reset.
export function bindMirrorAccount(raw: Raw, userId: string): boolean {
	const current = readMirrorAccount(raw);
	if (current === userId) return false;
	raw.transaction(() => {
		raw.prepare(`DELETE FROM catalogue_entry`).run();
		writeInventoryRev(raw, 0);
		writeSetting(raw, CATALOGUE_ACCOUNT_KEY, { userId });
	})();
	return current !== null;
}

// ── entries ─────────────────────────────────────────────────────────────────

export type MirrorEntry = {
	audioHash: string;
	unit: string;
	variant: string;
	version: number[];
	remoteRev: number;
	bytes: number;
	state: CatalogueLocalState;
};

type EntryRow = { audio_hash: string; unit: string; variant: string; version_key: string; remote_rev: number; bytes: number; local_state: CatalogueLocalState };

const toEntry = (r: EntryRow): MirrorEntry => ({
	audioHash: r.audio_hash,
	unit: r.unit,
	variant: r.variant,
	version: parseVersionString(r.version_key) ?? [0],
	remoteRev: r.remote_rev,
	bytes: r.bytes,
	state: r.local_state,
});

const versionKey = (v: readonly number[]): string => v.join('.');

// hash → keyId → entry.
export function readEntries(raw: Raw, hashes: readonly string[]): Map<string, Map<string, MirrorEntry>> {
	const out = new Map<string, Map<string, MirrorEntry>>();
	for (let i = 0; i < hashes.length; i += 500) {
		const chunk = hashes.slice(i, i + 500);
		const rows = raw.prepare(`SELECT audio_hash, unit, variant, version_key, remote_rev, bytes, local_state FROM catalogue_entry
			WHERE audio_hash IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as EntryRow[];
		for (const r of rows) {
			const e = toEntry(r);
			let m = out.get(e.audioHash);
			if (!m) out.set(e.audioHash, (m = new Map()));
			m.set(keyId({ unit: e.unit as UnitKey['unit'], variant: e.variant }), e);
		}
	}
	return out;
}

// One inventory slice. A newer version replaces what the mirror held and is
// 'remote' again (to be looked at); the same version only refreshes its rev
// and size, keeping what this device already did with it; an older one (the
// second version the server keeps) changes nothing.
export function applyInventory(raw: Raw, entries: readonly CatalogueInventoryEntry[]): number {
	const get = stmt(raw, `SELECT version_key FROM catalogue_entry WHERE audio_hash = ? AND unit = ? AND variant = ?`);
	const insert = stmt(raw, `INSERT INTO catalogue_entry (audio_hash, unit, variant, version_key, remote_rev, bytes, local_state, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, 'remote', ?)
		ON CONFLICT(audio_hash, unit, variant) DO UPDATE SET version_key = excluded.version_key, remote_rev = excluded.remote_rev,
			bytes = excluded.bytes, local_state = 'remote', updated_at = excluded.updated_at`);
	const touch = stmt(raw, `UPDATE catalogue_entry SET remote_rev = ?, bytes = ?, updated_at = ? WHERE audio_hash = ? AND unit = ? AND variant = ?`);
	let changed = 0;
	const now = Date.now();
	for (const e of entries) {
		const cur = get.get(e.audioHash, e.unit, e.variant) as { version_key: string } | undefined;
		const curVersion = cur ? parseVersionString(cur.version_key) : null;
		const cmp = curVersion ? compareVersions(e.version, curVersion) : 1;
		if (cmp > 0) {
			insert.run(e.audioHash, e.unit, e.variant, versionKey(e.version), e.rev, e.bytes, now);
			changed++;
		} else if (cmp === 0) {
			touch.run(e.rev, e.bytes, now, e.audioHash, e.unit, e.variant);
		}
	}
	return changed;
}

export function setEntry(raw: Raw, e: { audioHash: string; unit: string; variant: string; version: readonly number[]; state: CatalogueLocalState; remoteRev?: number; bytes?: number }): void {
	stmt(raw, `INSERT INTO catalogue_entry (audio_hash, unit, variant, version_key, remote_rev, bytes, local_state, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(audio_hash, unit, variant) DO UPDATE SET version_key = excluded.version_key,
			remote_rev = CASE WHEN excluded.remote_rev > 0 THEN excluded.remote_rev ELSE catalogue_entry.remote_rev END,
			bytes = CASE WHEN excluded.bytes > 0 THEN excluded.bytes ELSE catalogue_entry.bytes END,
			local_state = excluded.local_state, updated_at = excluded.updated_at`)
		.run(e.audioHash, e.unit, e.variant, versionKey(e.version), e.remoteRev ?? 0, e.bytes ?? 0, e.state, Date.now());
}

// Mark a known entry, at the version it holds, without touching anything
// else (the hydrator's verdict on what the server named).
export function markEntry(raw: Raw, audioHash: string, unit: string, variant: string, version: readonly number[], state: CatalogueLocalState): void {
	stmt(raw, `UPDATE catalogue_entry SET local_state = ?, updated_at = ? WHERE audio_hash = ? AND unit = ? AND variant = ? AND version_key = ?`)
		.run(state, Date.now(), audioHash, unit, variant, versionKey(version));
}

// Hashes with something still to look at under the given keys, joined to a
// live local file or to a live row without one whose recording claims the
// hash (local.ts readFilelessTracksByHash: a remote or streaming-only row
// takes the account's analysis through its recording's audio-hash claim):
// an entry nobody here can use waits for one to appear. `exclude` keeps one
// pass from picking the same hashes again. `cursor` (the pass's position in
// remote_rev order) makes each call read only entries after the last one it
// took: the earlier form re-scanned the pass's every hash through a NOT IN
// list that grew to thousands of bound values, and cost 157 ms a call by the
// end of a fresh device's hydrate (2026-10-21).
export function pendingHydrateHashes(raw: Raw, keys: readonly UnitKey[], limit: number, exclude: ReadonlySet<string>, cursor: { rev: number } = { rev: -1 }): string[] {
	if (keys.length === 0) return [];
	const keyClause = keys.map(() => `(ce.unit = ? AND ce.variant = ?)`).join(' OR ');
	const params: unknown[] = keys.flatMap((k) => [k.unit, k.variant]);
	// A hash holds a handful of entries (one per unit), so this many rows
	// usually name `limit` hashes; a short page reads on.
	const page = limit * 8;
	const out: string[] = [];
	const taken = new Set<string>();
	for (;;) {
		const rows = raw.prepare(`SELECT ce.audio_hash AS h, ce.remote_rev AS r FROM catalogue_entry ce
			WHERE ce.local_state = 'remote' AND ce.remote_rev > ? AND (${keyClause})
				AND (EXISTS (SELECT 1 FROM source_link sl JOIN track t ON t.id = sl.track_id
						WHERE sl.audio_hash = ce.audio_hash AND sl.source = 'local' AND sl.missing_at IS NULL AND t.deleted_at IS NULL)
					OR EXISTS (SELECT 1 FROM sync_state c JOIN track t ON t.recording_id = c.recording_id
						WHERE c.map = 'claims' AND c.parent_id = 'audio_hash:' || ce.audio_hash AND t.deleted_at IS NULL AND t.derived_from_track_id IS NULL
							AND NOT EXISTS (SELECT 1 FROM source_link s2 WHERE s2.track_id = t.id AND s2.source = 'local' AND s2.missing_at IS NULL)))
			ORDER BY ce.remote_rev
			LIMIT ?`).all(cursor.rev, ...params, page) as Array<{ h: string; r: number }>;
		for (const row of rows) {
			if (exclude.has(row.h) || taken.has(row.h)) { cursor.rev = row.r; continue; }
			if (out.length >= limit) return out;
			out.push(row.h);
			taken.add(row.h);
			cursor.rev = row.r;
		}
		if (rows.length < page || out.length >= limit) return out;
	}
}

export type MirrorCounts = { items: number; bytes: number; reused: number; uploaded: number };

export function mirrorCounts(raw: Raw): MirrorCounts {
	const r = stmt(raw, `SELECT
		coalesce(sum(CASE WHEN local_state != 'rejected' THEN 1 ELSE 0 END), 0) AS items,
		coalesce(sum(CASE WHEN local_state != 'rejected' THEN bytes ELSE 0 END), 0) AS bytes,
		coalesce(sum(CASE WHEN local_state = 'hydrated' THEN 1 ELSE 0 END), 0) AS reused,
		coalesce(sum(CASE WHEN local_state = 'uploaded' THEN 1 ELSE 0 END), 0) AS uploaded
		FROM catalogue_entry`).get() as MirrorCounts;
	return r;
}
