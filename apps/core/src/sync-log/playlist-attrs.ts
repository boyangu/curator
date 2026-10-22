// Playlist and folder details on the op log (protocol v4 `playlist.set-attrs`
// / `playlist_folder.set-attrs`; the 2026-10-21 zero-loss audit, items 10
// and 16): the hybrid-Tidal toggle (the one user setting), the sidebar
// position (a rekordbox playlist's or folder's Seq), the provider mark ('P',
// '♡', 'R'), what the provider says about it (description, owner, cover,
// public, collaborative, followers) and is_hidden. Until v4 none of it
// travelled: 10 hybrid flags and 130 positions were lost on a second device,
// every mark read NULL, and a phone (no provider read-sync) could never
// show a description.
//
// Emission is a drain like track-meta's: triggers mark a playlist dirty on
// any change of those columns (migrate.ts playlist_attrs_dirty_*; the
// rekordbox importer, both streaming read-syncs, tidal-hybrid's toggle and
// the create phase all write them), and the drain states, per field, what
// differs from the BASELINE — `playlist_attrs_seen`, the values last stated
// or projected here. Device-local playlists (rekordbox smart playlists,
// derived "[WAV]" ones) never emit.
//
// The baseline also guards the other direction. The projection writes a
// pulled field only where the column still equals the baseline: a column
// that differs holds a local change the drain has not stated yet (it runs
// before the pull in a cycle, but a write can land in between), and the
// drain will state it with a later clock — overwriting it with the older
// pulled value would lose it.

import type Database from 'better-sqlite3';
import { PLAYLIST_ATTR_FIELDS, PLAYLIST_FOLDER_ATTR_FIELDS, type LwwRecord, type NewOp } from '@curator/protocol';
import { canonicalSpotifyCover } from '../sync/spotify-cover.js';
import { emitOps, type BatchLabel } from './outbox.js';
import { playlistLeftToOthers, sourceRole, type SourceRole } from './role.js';

type Raw = Database.Database;

export const PLAYLIST_ATTRS_BACKFILL_KEY = 'sync.backfill.playlist_attrs_v4_at';

type Entity = 'playlist' | 'playlist_folder';
type Values = Record<string, unknown>;

const FIELDS: Record<Entity, readonly string[]> = { playlist: PLAYLIST_ATTR_FIELDS, playlist_folder: PLAYLIST_FOLDER_ATTR_FIELDS };
const BOOLEAN = new Set(['hybrid_tidal', 'is_public', 'is_collaborative', 'is_hidden']);
// The user's choices, which any device states. The rest is what a provider
// or rekordbox says about the playlist: a secondary leaves that to the
// device that brought the playlist, or the master once it describes it
// (role.ts).
const USER_FIELDS = new Set(['hybrid_tidal', 'position', 'is_hidden']);
// Not null on the table: a projected null for them would fail the write.
const NOT_NULL: Record<string, unknown> = { hybrid_tidal: false, position: 0, is_hidden: false };

const http = (v: unknown): string | null => (typeof v === 'string' && v.length <= 2048 && /^https?:\/\//i.test(v) ? v : null);

// A column in its wire form (ops.ts ZPlaylistSetAttrs), or undefined when the
// stored value cannot ride (it is then simply not stated).
function wire(field: string, v: unknown): unknown {
	if (BOOLEAN.has(field)) return v === null || v === undefined ? (field in NOT_NULL ? false : null) : !!v;
	switch (field) {
		case 'position': return typeof v === 'number' && Number.isInteger(v) ? v : 0;
		case 'followers': return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
		case 'cover_url': return v == null ? null : http(canonicalSpotifyCover(v as string)) ?? undefined;
		case 'mark': return typeof v === 'string' && v.length > 0 && v.length <= 8 ? v : null;
		case 'description': return typeof v === 'string' ? v.slice(0, 4096) : null;
		case 'owner_name': return typeof v === 'string' ? v.slice(0, 512) : null;
		case 'owner_id': return typeof v === 'string' ? v.slice(0, 256) : null;
		default: return v ?? null;
	}
}

// The values a fresh row holds: what "never stated" reads as, so a new
// playlist emits only what it really carries.
function defaults(entity: Entity): Values {
	const out: Values = {};
	for (const f of FIELDS[entity]) out[f] = wire(f, null);
	return out;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function readValues(raw: Raw, entity: Entity, id: string): Values | null {
	const cols = FIELDS[entity].join(', ');
	const extra = entity === 'playlist' ? ', is_smart, derived_from_playlist_id' : '';
	const row = raw.prepare(`SELECT ${cols}${extra} FROM ${entity} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
	if (!row) return null;
	if (entity === 'playlist' && (row['is_smart'] || row['derived_from_playlist_id'])) return null;
	const out: Values = {};
	for (const f of FIELDS[entity]) out[f] = wire(f, row[f]);
	return out;
}

function readSeen(raw: Raw, entity: Entity, id: string): Values {
	const json = raw.prepare(`SELECT attrs FROM playlist_attrs_seen WHERE entity = ? AND id = ?`).pluck().get(entity, id) as string | undefined;
	if (!json) return defaults(entity);
	try { return { ...defaults(entity), ...(JSON.parse(json) as Values) }; } catch { return defaults(entity); }
}

function writeSeen(raw: Raw, entity: Entity, id: string, v: Values): void {
	raw.prepare(`INSERT INTO playlist_attrs_seen (entity, id, attrs) VALUES (?, ?, ?) ON CONFLICT(entity, id) DO UPDATE SET attrs = excluded.attrs`).run(entity, id, JSON.stringify(v));
}

// ── the drain ───────────────────────────────────────────────────────────────

export function playlistAttrsDirtyCount(raw: Raw): number {
	return raw.prepare(`SELECT count(*) FROM playlist_attrs_dirty`).pluck().get() as number;
}

// One chunk in one transaction. Callers check the server reads v4.
// A provider field a secondary leaves to the master keeps its baseline, so
// it stays in the diff and a promotion to master states it.
export function drainPlaylistAttrs(raw: Raw, opts: { max?: number; batchLabel?: BatchLabel; role?: SourceRole } = {}): { rows: number; emitted: number; done: boolean } {
	const max = Math.max(1, opts.max ?? 200);
	return raw.transaction(() => {
		const role = opts.role ?? sourceRole(raw);
		if (role.speaks === 'none') return { rows: 0, emitted: 0, done: true };
		const rows = raw.prepare(`SELECT entity, id FROM playlist_attrs_dirty LIMIT ?`).all(max) as Array<{ entity: Entity; id: string }>;
		const ops: NewOp[] = [];
		for (const r of rows) {
			const now = readValues(raw, r.entity, r.id);
			if (now) {
				const seen = readSeen(raw, r.entity, r.id);
				const provider = FIELDS[r.entity].filter((f) => !USER_FIELDS.has(f));
				const userOnly = role.speaks === 'own' && provider.length > 0
					&& playlistLeftToOthers(raw, r.entity === 'playlist' ? 'playlists' : 'playlistFolders', r.id, role, provider);
				const diff: Values = {};
				for (const f of FIELDS[r.entity]) if (now[f] !== undefined && !same(now[f], seen[f]) && (!userOnly || USER_FIELDS.has(f))) diff[f] = now[f];
				if (Object.keys(diff).length > 0) {
					ops.push({ entity: r.entity, entity_id: r.id, kind: 'set-attrs', payload: diff } as NewOp);
					writeSeen(raw, r.entity, r.id, { ...seen, ...diff });
				}
			}
			raw.prepare(`DELETE FROM playlist_attrs_dirty WHERE entity = ? AND id = ?`).run(r.entity, r.id);
		}
		if (ops.length > 0) emitOps(raw, ops, { batchLabel: opts.batchLabel });
		return { rows: rows.length, emitted: ops.length, done: rows.length < max };
	})();
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function drainPlaylistAttrsAsync(raw: Raw, opts: { batchLabel?: BatchLabel; role?: SourceRole } = {}): Promise<{ rows: number; emitted: number; maxSliceMs: number }> {
	const out = { rows: 0, emitted: 0, maxSliceMs: 0 };
	for (;;) {
		const t0 = performance.now();
		const r = drainPlaylistAttrs(raw, { batchLabel: opts.batchLabel, role: opts.role });
		out.maxSliceMs = Math.max(out.maxSliceMs, performance.now() - t0);
		out.rows += r.rows;
		out.emitted += r.emitted;
		if (r.done) break;
		await yieldToLoop();
	}
	return out;
}

export function playlistAttrsBackfillPending(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(PLAYLIST_ATTRS_BACKFILL_KEY) === undefined;
}

// Every playlist and folder once (a few hundred rows: one transaction).
export function queuePlaylistAttrsBackfill(raw: Raw): number {
	return raw.transaction(() => {
		const a = raw.prepare(`INSERT OR IGNORE INTO playlist_attrs_dirty (entity, id) SELECT 'playlist', id FROM playlist WHERE is_smart = 0 AND derived_from_playlist_id IS NULL`).run().changes;
		const b = raw.prepare(`INSERT OR IGNORE INTO playlist_attrs_dirty (entity, id) SELECT 'playlist_folder', id FROM playlist_folder`).run().changes;
		raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
			.run(PLAYLIST_ATTRS_BACKFILL_KEY, JSON.stringify(Date.now()), Date.now());
		return a + b;
	})();
}

// ── the projection ──────────────────────────────────────────────────────────

// The record's set-attrs fields onto the local row, field by field, where the
// column still holds the baseline (see the top). Inside the caller's
// transaction, after the row was upserted. Returns whether anything changed.
export function projectPlaylistAttrs(raw: Raw, entity: Entity, id: string, rec: LwwRecord): boolean {
	const fields = FIELDS[entity].filter((f) => rec.fields[f] !== undefined);
	if (fields.length === 0) return false;
	const now = readValues(raw, entity, id);
	if (!now) return false;
	const seen = readSeen(raw, entity, id);
	const set: Values = {};
	const nextSeen: Values = { ...seen };
	for (const f of fields) {
		const v = rec.fields[f]!.value;
		if (!same(now[f], seen[f])) continue; // a local change not stated yet
		nextSeen[f] = v;
		if (!same(now[f], v)) set[f] = v;
	}
	writeSeen(raw, entity, id, nextSeen);
	const cols = Object.keys(set);
	if (cols.length === 0) return false;
	const col = (f: string): unknown => {
		const v = set[f] ?? NOT_NULL[f] ?? null;
		return BOOLEAN.has(f) ? (v === null ? null : v ? 1 : 0) : v;
	};
	raw.prepare(`UPDATE ${entity} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => col(c) as never), id);
	return true;
}
