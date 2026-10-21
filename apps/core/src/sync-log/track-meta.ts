// Base track metadata on the op log (cloud plan: streaming identity §3,
// protocol v3 `library_track.set-meta`). Until v3 the log carried who rated,
// tagged and listed a recording but never what it IS — title, credits,
// album — so a device without its own row for a recording could show
// nothing of it (the 2026-10-20 incident's empty second desktop). Each
// device now states its own rows' meta; every other device materialises a
// remote row from it (remote-rows.ts), the master device's meta winning
// (protocol state.ts resolveTrackMeta).
//
// Emission is a drain, not a call in each writer: SQLite triggers mark a row
// dirty whenever a meta column or its sources change (migrate.ts; the
// rekordbox importer, for one, rewrites columns without bumping updated_at),
// and the sync client drains the marks in chunks — but only once the server
// advertises 'track_meta' (a v2 server refuses the kind, and a refused op is
// never retried). `track_meta_seen` is the per-row baseline: a dirty row
// whose meta digests the same as last time emits nothing.
//
// What a row states (ZTrackMeta): its catalogue columns as its source
// spelled them — the SOURCE credits (artists_base, before any artist alias
// rule; every device maps them through the converged rules itself), no
// override (overrides are their own LWW fields and win on read everywhere),
// an http(s) cover only. One row per recording speaks: the device's primary
// own row (live first, then oldest), so two local copies of one file never
// flip the device's cell back and forth. A merge loser's row is silent: its
// op would be redirected onto the survivor and overwrite the survivor's
// meta. Remote rows (their meta came from here) and derived WAV copies
// (device-local) never emit.

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
	MASTER_DEVICE_SETTING,
	MAX_OP_PAYLOAD_BYTES,
	masterDeviceOf,
	opPayloadBytes,
	type Cell,
	type JsonValue,
	type NewOp,
	type SyncFeature,
	type TrackMeta,
	type TrackMetaSource,
} from '@curator/protocol';
import type { TrackArtist } from '@curator/shared/schema';
import { artistsBaseOf } from '../library/artists.js';
import { log } from '../log.js';
import { INITIAL_PUSH_KEY } from './apply.js';
import { emitOps } from './outbox.js';

type Raw = Database.Database;

const tlog = log.for('track-meta');

export const TRACK_META_FEATURE: SyncFeature = 'track_meta';

// One-time: every own row is queued once the server first reads v3 (a
// library whose rows predate the triggers). Also the "launch sweep"
// fallback: a new key name re-queues every row, and the digest baseline
// keeps that to the rows whose meta really differs. v2 (2026-10-21): the
// cover now falls back to the Spotify payload's album art (trackMetaOf), so
// the ~23k rows that only ever showed a cover through that fallback state
// it once.
export const TRACK_META_BACKFILL_KEY = 'sync.backfill.track_meta_v2_at';

export function serverReadsTrackMeta(features: readonly SyncFeature[] | null | undefined): boolean {
	return !!features?.includes(TRACK_META_FEATURE);
}

// ── the payload ─────────────────────────────────────────────────────────────

export type MetaRow = {
	id: string;
	recording_id: string | null;
	title: string | null;
	artists: string | null;
	artists_base: string | null;
	album_title: string | null;
	duration: number | null;
	isrc: string | null;
	release_date: string | null;
	label: string | null;
	genre: string | null;
	cover_url: string | null;
	track_number: number | null;
	disc_number: number | null;
};

const META_COLUMNS = `id, recording_id, title, artists, artists_base, album_title, duration, isrc, release_date, label, genre, cover_url, track_number, disc_number`;

// A file's tags are the user's own; a provider's listing is the next best.
export function metaSourceOf(sources: ReadonlySet<string>): TrackMetaSource {
	if (sources.has('local')) return 'local';
	if (sources.has('spotify')) return 'spotify';
	if (sources.has('tidal')) return 'tidal';
	return 'other';
}

const str = (v: string | null | undefined): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const count = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

export function httpCover(url: string | null | undefined): string | null {
	return typeof url === 'string' && url.length <= 2048 && /^https?:\/\//i.test(url) ? url : null;
}

// Null when the row cannot ride an op (a credit list past the payload cap).
// `payloadCover`: the row's Spotify payload art (`album.images[0]`, the
// 640 px one), for a row whose cover_url was never filled — the same
// fallback the track list shows (service.ts getTrackCoverUrl), which every
// other device could not, having no payload (23,396 rows of the main
// library, 2026-10-21 audit item 5). A Tidal payload carries no image (its
// album is `{ id, title }`).
export function trackMetaOf(row: MetaRow, sources: ReadonlySet<string>, payloadCover: string | null = null): TrackMeta | null {
	const base = artistsBaseOf({ artists: (row.artists ?? '[]') as never, artists_base: row.artists_base });
	const artists: TrackArtist[] = base
		.filter((a) => a && typeof a.name === 'string' && a.name.length > 0)
		.map((a) => (a.role === 'main' || a.role === 'featured' || a.role === 'remixer' ? { name: a.name, role: a.role } : { name: a.name }));
	const meta: TrackMeta = {
		source: metaSourceOf(sources),
		title: row.title ?? '',
		artists,
		album_title: str(row.album_title),
		duration_sec: count(row.duration),
		isrc: str(row.isrc),
		release_date: str(row.release_date),
		label: str(row.label),
		genre: str(row.genre),
		cover_url: httpCover(row.cover_url) ?? httpCover(payloadCover),
		track_number: count(row.track_number),
		disc_number: count(row.disc_number),
	};
	return opPayloadBytes({ payload: meta }) > MAX_OP_PAYLOAD_BYTES ? null : meta;
}

function digestOf(recordingId: string, meta: TrackMeta): string {
	return createHash('sha1').update(recordingId).update('\u0000').update(JSON.stringify(meta)).digest('hex');
}

// ── the drain ───────────────────────────────────────────────────────────────

export type TrackMetaDrain = { rows: number; emitted: number; done: boolean };

const CHUNK = 100;

export function trackMetaDirtyCount(raw: Raw): number {
	return raw.prepare(`SELECT count(*) FROM track_meta_dirty`).pluck().get() as number;
}

// One chunk of dirty rows, in one transaction: their set-meta ops (outbox +
// records, emitOps), the baseline, and the marks cleared. Callers check the
// server feature first.
export function drainTrackMeta(raw: Raw, opts: { max?: number } = {}): TrackMetaDrain {
	const max = Math.max(1, opts.max ?? CHUNK);
	return raw.transaction((): TrackMetaDrain => {
		const ids = raw.prepare(`SELECT track_id FROM track_meta_dirty LIMIT ?`).pluck().all(max) as string[];
		if (ids.length === 0) return { rows: 0, emitted: 0, done: true };
		const marks = ids.map(() => '?').join(',');
		const recs = [...new Set(raw.prepare(`SELECT recording_id FROM track WHERE id IN (${marks}) AND recording_id IS NOT NULL`).pluck().all(...ids) as string[])];
		// Everything below in a few IN (...) reads per chunk, not per row.
		const recMarks = recs.map(() => '?').join(',');
		const aliased = new Set(recs.length > 0 ? raw.prepare(`SELECT loser FROM recording_alias WHERE loser IN (${recMarks})`).pluck().all(...recs) as string[] : []);
		// The speaking row of each recording (live own first, then oldest).
		// `+derived_from_track_id`: see remote-rows.ts (the IN-list plan).
		const primary = new Map<string, MetaRow>();
		if (recs.length > 0) {
			for (const r of raw.prepare(`SELECT ${META_COLUMNS} FROM track WHERE recording_id IN (${recMarks}) AND remote_only = 0 AND +derived_from_track_id IS NULL
				ORDER BY recording_id, deleted_at IS NOT NULL, created_at, id`).all(...recs) as MetaRow[]) {
				if (!primary.has(r.recording_id!)) primary.set(r.recording_id!, r);
			}
		}
		const rowIds = [...primary.values()].map((r) => r.id);
		const rowMarks = rowIds.map(() => '?').join(',');
		const sources = new Map<string, Set<string>>();
		const seenDigest = new Map<string, string>();
		const payloadCovers = new Map<string, string>();
		if (rowIds.length > 0) {
			// Only for rows with no http cover of their own: json_extract on a few
			// hundred payloads, not a parse of each. json_valid guards one
			// malformed payload from failing the chunk. Of a row's several
			// Spotify links (a merged track), the one getTrackCoverUrl shows:
			// the first through the (track_id, source) index, lowest rowid.
			for (const c of raw.prepare(`SELECT s.track_id, json_extract(s.payload, '$.album.images[0].url') AS url FROM source_link s JOIN track t ON t.id = s.track_id
				WHERE s.track_id IN (${rowMarks}) AND s.source = 'spotify' AND (t.cover_url IS NULL OR t.cover_url NOT LIKE 'http%') AND s.payload IS NOT NULL AND json_valid(s.payload)
				ORDER BY s.rowid`).all(...rowIds) as Array<{ track_id: string; url: unknown }>) {
				if (typeof c.url === 'string' && !payloadCovers.has(c.track_id)) payloadCovers.set(c.track_id, c.url);
			}
			for (const s of raw.prepare(`SELECT track_id, source FROM source_link WHERE track_id IN (${rowMarks})`).all(...rowIds) as Array<{ track_id: string; source: string }>) {
				let set = sources.get(s.track_id);
				if (!set) sources.set(s.track_id, (set = new Set()));
				set.add(s.source);
			}
			for (const s of raw.prepare(`SELECT track_id, recording_id, digest FROM track_meta_seen WHERE track_id IN (${rowMarks})`).all(...rowIds) as Array<{ track_id: string; recording_id: string; digest: string }>) {
				seenDigest.set(`${s.track_id}\u0000${s.recording_id}`, s.digest);
			}
		}
		const putSeen = raw.prepare(`INSERT INTO track_meta_seen (track_id, recording_id, digest, seen_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(track_id) DO UPDATE SET recording_id = excluded.recording_id, digest = excluded.digest, seen_at = excluded.seen_at`);
		const now = Date.now();
		const ops: NewOp[] = [];
		const seen: Array<[string, string, string]> = [];
		let tooLarge = 0;
		for (const rec of recs) {
			if (aliased.has(rec)) continue;
			const row = primary.get(rec);
			if (!row) continue;
			const meta = trackMetaOf(row, sources.get(row.id) ?? new Set(), payloadCovers.get(row.id) ?? null);
			if (!meta) { tooLarge++; continue; }
			const digest = digestOf(rec, meta);
			if (seenDigest.get(`${row.id}\u0000${rec}`) === digest) continue;
			ops.push({ entity: 'library_track', entity_id: rec, kind: 'set-meta', payload: meta });
			seen.push([row.id, rec, digest]);
		}
		if (ops.length > 0) emitOps(raw, ops);
		for (const [id, rec, digest] of seen) putSeen.run(id, rec, digest, now);
		raw.prepare(`DELETE FROM track_meta_dirty WHERE track_id IN (${marks})`).run(...ids);
		if (tooLarge > 0) tlog.warn('rows whose meta is too large for an op stay device-local', { count: tooLarge });
		return { rows: ids.length, emitted: ops.length, done: ids.length < max };
	})();
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// The yielding driver, a yield between chunks. Sized by time: a row whose
// digest is unchanged costs a few reads, one that emits costs an op (~2.5 ms
// on the real library — the v2 backfill's 100-row chunks of 23k covers
// measured 264 ms, 2026-10-21), so the next chunk aims at META_SLICE_MS from
// the last one's cost. `chunk` pins a fixed size (tests).
const META_SLICE_MS = 40;
export async function drainTrackMetaAsync(raw: Raw, opts: { chunk?: number; signal?: { aborted: boolean } } = {}): Promise<{ rows: number; emitted: number; chunks: number; maxSliceMs: number }> {
	const out = { rows: 0, emitted: 0, chunks: 0, maxSliceMs: 0 };
	const fixed = opts.chunk !== undefined;
	let size = Math.max(1, opts.chunk ?? 20);
	for (;;) {
		if (opts.signal?.aborted) break;
		const t0 = performance.now();
		const r = drainTrackMeta(raw, { max: size });
		const ms = performance.now() - t0;
		out.maxSliceMs = Math.max(out.maxSliceMs, ms);
		if (!fixed && r.rows > 0) size = Math.max(5, Math.min(CHUNK * 5, Math.ceil(size * 1.5), Math.round(r.rows * META_SLICE_MS / Math.max(ms, 1))));
		if (r.rows === 0) break;
		out.chunks++;
		out.rows += r.rows;
		out.emitted += r.emitted;
		if (r.done) break;
		await yieldToLoop();
	}
	return out;
}

// ── the one-time backfill ───────────────────────────────────────────────────

export function trackMetaBackfillPending(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(INITIAL_PUSH_KEY) !== undefined
		&& raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(TRACK_META_BACKFILL_KEY) === undefined;
}

// Queues every own catalogue row (pages by rowid, a yield between), then
// sets the key. The drain does the rest; the baseline is empty for rows
// never stated, so each emits once.
export async function queueTrackMetaBackfillAsync(raw: Raw, opts: { page?: number } = {}): Promise<number> {
	const page = Math.max(1, opts.page ?? 5_000);
	const ids = raw.prepare(`SELECT rowid, id FROM track WHERE rowid > ? AND remote_only = 0 AND derived_from_track_id IS NULL ORDER BY rowid LIMIT ?`);
	const put = raw.prepare(`INSERT OR IGNORE INTO track_meta_dirty (track_id) VALUES (?)`);
	let queued = 0;
	for (let after = 0; ;) {
		const rows = ids.all(after, page) as Array<{ rowid: number; id: string }>;
		if (rows.length === 0) break;
		raw.transaction(() => { for (const r of rows) put.run(r.id); })();
		queued += rows.length;
		after = rows[rows.length - 1]!.rowid;
		await yieldToLoop();
	}
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(TRACK_META_BACKFILL_KEY, JSON.stringify(Date.now()), Date.now());
	return queued;
}

// ── the master device ───────────────────────────────────────────────────────

// The master as the records hold it (the same cell every device's view and
// the server's read), or null when none was ever stated.
export function masterDevice(raw: Raw): string | null {
	const json = raw.prepare(`SELECT value FROM sync_state WHERE map = 'settings' AND key = ?`).pluck().get(MASTER_DEVICE_SETTING) as string | undefined;
	if (!json) return null;
	try {
		return masterDeviceOf(new Map([[MASTER_DEVICE_SETTING, JSON.parse(json) as Cell]]));
	} catch {
		return null;
	}
}

// States `deviceId` as the master: an ordinary account setting op, so it
// reaches every device and the server and wins by LWW like any setting.
// The app_setting mirror is written with it, as every account setting's is
// (mutators.ts setSetting): the projection writes it on the other devices,
// and emitOps never projects.
export function setMasterDevice(raw: Raw, deviceId: string): void {
	raw.transaction(() => {
		raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
			.run(MASTER_DEVICE_SETTING, JSON.stringify(deviceId), Date.now());
		emitOps(raw, [{ entity: 'setting', entity_id: MASTER_DEVICE_SETTING, kind: 'set', payload: { value: deviceId as JsonValue } }]);
	})();
}

// Which device states the default master when the account has none: the
// earliest-registered device still on the account (registration order is
// the server's, so every device reads the same answer) — the desktop that
// first linked the library. Only that device emits; the rest wait for its
// op. Ties (same ms) break by device id.
export function defaultMasterDevice(devices: ReadonlyArray<{ deviceId: string; registeredAt: number; revokedAt: number | null }>): string | null {
	const active = devices.filter((d) => d.revokedAt === null).sort((a, b) => a.registeredAt - b.registeredAt || (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
	return active[0]?.deviceId ?? null;
}
