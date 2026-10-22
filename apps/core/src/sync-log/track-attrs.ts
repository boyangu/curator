// Track attributes on the op log (protocol v4 `library_track.set-attrs` and
// `set-cues-edited`; the 2026-10-21 zero-loss audit, items 2, 11, 14 and 15).
// The drain below also states the track's curation — comment and colour,
// last-write-wins across devices, not master-wins (track-curation.ts): the
// same dirty marks cover them.
// set-meta carried what a recording IS (title, credits, album); everything
// else a row knows stayed device-local, so a second device showed no BPM on
// 5,622 tracks, no key on 2,141, no comment on 4,557, no rekordbox play
// count, explicit flag or colour, grouped albums differently (no provider
// album ids) and linked no artist to Spotify (no provider artist ids).
//
// Same machinery as track-meta.ts: SQLite triggers mark a row dirty
// (migrate.ts track_attrs_dirty_*), the sync client drains the marks in
// time-sized chunks once the server reads v4, `track_attrs_seen` is the
// per-row digest baseline, a one-time backfill queues every own row. Each
// device states its own primary row per recording (live first, then oldest);
// merge losers, remote rows and derived WAV copies stay silent. The view
// picks a device's cell by the master rule (protocol state.ts
// resolveTrackAttrs — the master's, else best source, then latest), the same
// device set-meta's view picks.
//
// RECEIVING. Unlike set-meta (which never touches an own row), the winning
// attributes are written onto every row of the recording — remote rows and
// this device's own — wherever the row holds no value from its own source.
// A value written that way is ADOPTED: track.attrs_adopted records it
// ({ field: { v, from } }), so the row never states it back as its own (the
// drain states an adopted field as null), it follows the winner when that
// changes (and clears when the winner drops it), and a local writer that
// later puts its own value there takes the field back (the column no longer
// equals the adopted value). Per field:
//   bpm, key_camelot   a row's own tempo/key (its rekordbox import, a
//                      Beatport/Traxsource match, a Tidal listing) stands; an
//                      empty one takes the account's. The catalogue hydrate's
//                      analyzer fill (catalogue/layer.ts) is recorded as
//                      adopted `from: 'catalogue'`: the account's value
//                      replaces it, and it stays when the account has none.
//                      Overrides are separate fields and still win on read.
//   explicit, mbid, copyright
//                      take-if-empty, the same rule (source data).
//   play_count         rekordbox's own counter of THAT machine's plays. An
//                      own row linked to a local rekordbox keeps its counter
//                      (0 included); any other row shows the winner's. The
//                      exporter never writes play_count, so an adopted count
//                      never reaches a rekordbox.
//   provider_refs      the listings' release and artist ids. A row with its
//                      own Spotify/Tidal payload keeps reading those; any
//                      other row reads the winner's (track_provider_ref),
//                      which the album seam and the artist links use like a
//                      payload (library/albums.ts, remote-rows.ts derive).
//   artist_names       the master's display spelling of each credited
//                      artist wins for an uncurated artist (artist_spelling;
//                      the artist seam mints new artists with it).
//   cues_edited_at     account-wide, the latest stamp (set-cues-edited):
//                      every row takes max(own, account), so a cue clear
//                      made anywhere reaches this device's rekordbox export.

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
	MAX_OP_PAYLOAD_BYTES,
	opPayloadBytes,
	resolveTrackAttrs,
	CUES_EDITED_CELL,
	type LwwRecord,
	type NewOp,
	type ProviderRef,
	type TrackAttrs,
} from '@curator/protocol';
import { artistKey } from '@curator/shared';
import { log } from '../log.js';
import { INITIAL_PUSH_KEY } from './apply.js';
import { emitOps, type BatchLabel, type EmitOp } from './outbox.js';
import { metaSourceOf } from './track-meta.js';
import { curationCells, curationOps } from './track-curation.js';
import { leftToOthers, sourceRole, type SourceRole } from './role.js';

type Raw = Database.Database;

const alog = log.for('track-attrs');

// One-time: every own row is queued once the server first reads v4.
export const TRACK_ATTRS_BACKFILL_KEY = 'sync.backfill.track_attrs_v4_at';

// ── adoption bookkeeping ────────────────────────────────────────────────────

export const SCALAR_FIELDS = ['bpm', 'key_camelot', 'explicit', 'mbid', 'copyright', 'play_count'] as const;
export type ScalarField = (typeof SCALAR_FIELDS)[number];
type Adopted = Partial<Record<ScalarField, { v: unknown; from: 'account' | 'catalogue' }>>;

export function parseAdopted(json: string | null | undefined): Adopted {
	if (!json) return {};
	try {
		const v = JSON.parse(json) as unknown;
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Adopted) : {};
	} catch {
		return {};
	}
}

const adoptedJson = (a: Adopted): string | null => (Object.keys(a).length > 0 ? JSON.stringify(a) : null);

// A column value in the field's wire form (explicit is stored 0/1; a
// play_count of 0 is "no plays", stated as nothing).
function wireValue(field: ScalarField, v: unknown): unknown {
	if (v === null || v === undefined) return null;
	switch (field) {
		case 'explicit': return v === 1 || v === true ? true : v === 0 || v === false ? false : null;
		case 'play_count': return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
		case 'bpm': return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1000 ? v : null;
		case 'key_camelot': return typeof v === 'string' && v.length > 0 && v.length <= 8 ? v : null;
		case 'mbid': return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null;
		case 'copyright': return typeof v === 'string' && v.length > 0 ? v.slice(0, 1024) : null;
	}
}

// The column value a wire value is written as.
function columnValue(field: ScalarField, v: unknown): unknown {
	if (field === 'explicit') return v === null ? null : v ? 1 : 0;
	if (field === 'play_count') return v === null ? 0 : v;
	return v;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Mark a catalogue analyzer fill (catalogue/layer.ts fillTrackMirrors) as
// adopted, so the account's own value replaces it and the row never states
// it as its own. Inside the caller's transaction, after its fill.
export function markCatalogueFill(raw: Raw, trackId: string, field: 'bpm' | 'key_camelot', value: unknown): void {
	const row = raw.prepare(`SELECT attrs_adopted FROM track WHERE id = ?`).get(trackId) as { attrs_adopted: string | null } | undefined;
	if (!row) return;
	const a = parseAdopted(row.attrs_adopted);
	a[field] = { v: value, from: 'catalogue' };
	raw.prepare(`UPDATE track SET attrs_adopted = ? WHERE id = ?`).run(adoptedJson(a), trackId);
}

// ── the payload ─────────────────────────────────────────────────────────────

export type AttrsRow = {
	id: string;
	recording_id: string;
	bpm: number | null;
	key_camelot: string | null;
	comment: string | null;
	color_label: string | null;
	explicit: number | null;
	mbid: string | null;
	copyright: string | null;
	play_count: number;
	cues_edited_at: number | null;
	updated_at: number;
	artists: string | null;
	overrides: string | null;
	attrs_adopted: string | null;
};

const ATTRS_COLUMNS = `id, recording_id, bpm, key_camelot, comment, color_label, explicit, mbid, copyright, play_count, cues_edited_at, updated_at, artists, overrides, attrs_adopted`;

type LinkRow = { track_id: string; source: string; payload: string | null };

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null);
const httpUrl = (v: unknown): string | null => (typeof v === 'string' && v.length <= 2048 && /^https?:\/\//i.test(v) ? v : null);
const count = (v: unknown): number | null => {
	const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
	return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
};

// One Spotify / Tidal payload compacted to what another device needs of it:
// the release (id and what the provider says about it) and the artists' ids.
// Null when the payload names neither.
export function providerRefOf(source: string, payload: string | null): ProviderRef | null {
	if ((source !== 'spotify' && source !== 'tidal') || !payload) return null;
	let p: Record<string, unknown>;
	try {
		const v = JSON.parse(payload) as unknown;
		if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
		p = v as Record<string, unknown>;
	} catch {
		return null;
	}
	const al = p['album'] && typeof p['album'] === 'object' ? (p['album'] as Record<string, unknown>) : null;
	const albumId = al ? (typeof al['id'] === 'number' ? String(al['id']) : str(al['id'], 128)) : null;
	const images = al && Array.isArray(al['images']) ? (al['images'] as Array<Record<string, unknown>>) : [];
	const album = al && albumId
		? {
			id: albumId,
			name: str(al['name'] ?? al['title'], 1024),
			artists: (Array.isArray(al['artists']) ? (al['artists'] as Array<Record<string, unknown>>) : []).map((a) => str(a?.['name'], 512)).filter((n): n is string => n !== null).slice(0, 32),
			release_date: str(al['release_date'], 32),
			cover_url: httpUrl(images[0]?.['url']),
			album_type: str(al['album_type'], 32),
			total_tracks: count(al['total_tracks']),
		}
		: null;
	const artists = (Array.isArray(p['artists']) ? (p['artists'] as Array<Record<string, unknown>>) : [])
		.map((a) => ({ name: str(a?.['name'], 512), id: typeof a?.['id'] === 'number' ? String(a['id']) : str(a?.['id'], 128) }))
		.filter((a): a is { name: string; id: string } => a.name !== null && a.id !== null)
		.slice(0, 32);
	if (!album && artists.length === 0) return null;
	return { source, album, artists, track_number: count(p['track_number']), disc_number: count(p['disc_number']) };
}

// A ref back into the payload shape the album seam and artist links read
// (track_provider_ref.payload): a Spotify-like track object.
export function refPayload(ref: ProviderRef): string {
	const a = ref.album;
	return JSON.stringify({
		album: a ? { id: a.id, name: a.name, artists: a.artists.map((name) => ({ name })), release_date: a.release_date, images: a.cover_url ? [{ url: a.cover_url }] : [], album_type: a.album_type, total_tracks: a.total_tracks } : null,
		artists: ref.artists.map((x) => ({ name: x.name, id: x.id })),
		track_number: ref.track_number,
		disc_number: ref.disc_number,
	});
}

function keySourceOf(key: string | null, rbKey: string | null, sources: ReadonlySet<string>): TrackAttrs['key_source'] {
	if (!key) return null;
	if (rbKey && rbKey === key) return 'rekordbox';
	if (sources.has('beatport')) return 'beatport';
	if (sources.has('traxsource')) return 'traxsource';
	if (sources.has('tidal')) return 'tidal';
	return 'other';
}

function creditNames(row: Pick<AttrsRow, 'artists' | 'overrides'>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (list: unknown): void => {
		if (!Array.isArray(list)) return;
		for (const a of list as Array<{ name?: unknown }>) {
			const n = typeof a?.name === 'string' ? a.name.trim() : '';
			const k = n ? artistKey(n) : '';
			if (!k || seen.has(k)) continue;
			seen.add(k);
			out.push(n);
		}
	};
	try { push(JSON.parse(row.artists ?? '[]')); } catch { /* malformed credits state none */ }
	try { push((JSON.parse(row.overrides ?? 'null') as { artists?: unknown } | null)?.artists); } catch { /* idem */ }
	return out;
}

export type AttrsContext = {
	sources: ReadonlySet<string>;
	links: readonly LinkRow[];
	rbKey: string | null;
	// This device's artist display name per credit key (artist table).
	artistName: (key: string) => string | null;
};

// What a row states: its own values, adopted ones as null. Null when the row
// cannot ride an op (shrunk first: refs dropped from the end).
export function trackAttrsOf(row: AttrsRow, ctx: AttrsContext): TrackAttrs | null {
	const adopted = parseAdopted(row.attrs_adopted);
	const own = (field: ScalarField): unknown => {
		const v = wireValue(field, (row as unknown as Record<string, unknown>)[field]);
		const a = adopted[field];
		return a && same(wireValue(field, a.v), v) ? null : v;
	};
	const refs: ProviderRef[] = [];
	const seenRef = new Set<string>();
	for (const l of ctx.links) {
		const r = providerRefOf(l.source, l.payload);
		if (!r) continue;
		const k = JSON.stringify(r);
		if (seenRef.has(k)) continue;
		seenRef.add(k);
		refs.push(r);
		if (refs.length >= 8) break;
	}
	const names = creditNames(row).map((n) => ctx.artistName(artistKey(n)) ?? n).slice(0, 32);
	const key = own('key_camelot') as string | null;
	const attrs: TrackAttrs = {
		source: metaSourceOf(ctx.sources),
		bpm: own('bpm') as number | null,
		key_camelot: key,
		key_source: keySourceOf(key, ctx.rbKey, ctx.sources),
		explicit: own('explicit') as boolean | null,
		mbid: own('mbid') as string | null,
		copyright: own('copyright') as string | null,
		play_count: own('play_count') as number | null,
		provider_refs: refs,
		artist_names: names,
	};
	while (opPayloadBytes({ payload: attrs }) > MAX_OP_PAYLOAD_BYTES && attrs.provider_refs.length > 0) attrs.provider_refs.pop();
	return opPayloadBytes({ payload: attrs }) > MAX_OP_PAYLOAD_BYTES ? null : attrs;
}

function digestOf(recordingId: string, attrs: TrackAttrs): string {
	return createHash('sha1').update(recordingId).update('\u0000').update(JSON.stringify(attrs)).digest('hex');
}

// ── the drain ───────────────────────────────────────────────────────────────

const CHUNK = 100;
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(',');

export function trackAttrsDirtyCount(raw: Raw): number {
	return raw.prepare(`SELECT count(*) FROM track_attrs_dirty`).pluck().get() as number;
}

export type TrackAttrsDrain = { rows: number; emitted: number; done: boolean };

// One chunk of dirty rows, in one transaction: their set-attrs ops (and a
// set-cues-edited where this device holds a later cue edit than the
// account), the baseline, the marks cleared. Callers check the server
// feature first (features.ts).
// `batchLabel`: as drainTrackMeta's (track-meta.ts).
// On a secondary (role.ts) only the set-attrs of a recording it did not
// bring, or the master describes, is skipped (no baseline, so a promotion states it); its
// curation and cue-edit stamp are the user's and go as everywhere.
export function drainTrackAttrs(raw: Raw, opts: { max?: number; batchLabel?: BatchLabel; role?: SourceRole } = {}): TrackAttrsDrain {
	const max = Math.max(1, opts.max ?? CHUNK);
	return raw.transaction((): TrackAttrsDrain => {
		const role = opts.role ?? sourceRole(raw);
		if (role.speaks === 'none') return { rows: 0, emitted: 0, done: true };
		const ids = raw.prepare(`SELECT track_id FROM track_attrs_dirty LIMIT ?`).pluck().all(max) as string[];
		if (ids.length === 0) return { rows: 0, emitted: 0, done: true };
		const recs = [...new Set(raw.prepare(`SELECT recording_id FROM track WHERE id IN (${marks(ids.length)}) AND recording_id IS NOT NULL`).pluck().all(...ids) as string[])];
		const ops: EmitOp[] = [];
		const seen: Array<[string, string, string]> = [];
		let tooLarge = 0;
		if (recs.length > 0) {
			const aliased = new Set(raw.prepare(`SELECT loser FROM recording_alias WHERE loser IN (${marks(recs.length)})`).pluck().all(...recs) as string[]);
			const others = role.speaks === 'own' ? leftToOthers(raw, role, recs) : new Set<string>();
			const rowsOf = new Map<string, AttrsRow[]>();
			for (const r of raw.prepare(`SELECT ${ATTRS_COLUMNS} FROM track WHERE recording_id IN (${marks(recs.length)}) AND remote_only = 0 AND +derived_from_track_id IS NULL
				ORDER BY recording_id, deleted_at IS NOT NULL, created_at, id`).all(...recs) as AttrsRow[]) {
				let l = rowsOf.get(r.recording_id);
				if (!l) rowsOf.set(r.recording_id, (l = []));
				l.push(r);
			}
			const primary = [...rowsOf.values()].map((l) => l[0]!);
			const rowIds = primary.map((r) => r.id);
			const links = new Map<string, LinkRow[]>();
			const sources = new Map<string, Set<string>>();
			const rbKey = new Map<string, string | null>();
			const seenDigest = new Map<string, string>();
			if (rowIds.length > 0) {
				// The listings in the order the album seam reads them (Spotify
				// first, newest first), so the refs a device states lead with the
				// one it groups by.
				for (const l of raw.prepare(`SELECT track_id, source, CASE WHEN source IN ('spotify', 'tidal') AND json_valid(payload) THEN payload END AS payload
					FROM source_link WHERE track_id IN (${marks(rowIds.length)}) ORDER BY track_id, CASE source WHEN 'spotify' THEN 0 ELSE 1 END, fetched_at DESC, id`).all(...rowIds) as LinkRow[]) {
					let list = links.get(l.track_id);
					if (!list) links.set(l.track_id, (list = []));
					list.push(l);
					let s = sources.get(l.track_id);
					if (!s) sources.set(l.track_id, (s = new Set()));
					s.add(l.source);
				}
				for (const a of raw.prepare(`SELECT track_id, rb_key_camelot FROM track_analysis WHERE track_id IN (${marks(rowIds.length)})`).all(...rowIds) as Array<{ track_id: string; rb_key_camelot: string | null }>) rbKey.set(a.track_id, a.rb_key_camelot);
				for (const s of raw.prepare(`SELECT track_id, recording_id, digest FROM track_attrs_seen WHERE track_id IN (${marks(rowIds.length)})`).all(...rowIds) as Array<{ track_id: string; recording_id: string; digest: string }>) {
					seenDigest.set(`${s.track_id}\u0000${s.recording_id}`, s.digest);
				}
			}
			const artistByKey = raw.prepare(`SELECT name FROM artist WHERE name_ascii = ? AND merged_into IS NULL`).pluck();
			const nameCache = new Map<string, string | null>();
			const artistName = (k: string): string | null => {
				if (!nameCache.has(k)) nameCache.set(k, (artistByKey.get(k) as string | undefined) ?? null);
				return nameCache.get(k)!;
			};
			const cuesCell = new Map<string, number>();
			const curation = new Map<string, ReturnType<typeof curationCells>>();
			for (const r of raw.prepare(`SELECT key, json_extract(value, '$.fields.${CUES_EDITED_CELL}.value') AS at,
					json_extract(value, '$.fields."curation.comment"') AS cm, json_extract(value, '$.fields."curation.color_label"') AS cl
				FROM sync_state WHERE map = 'libraryTracks' AND key IN (${marks(recs.length)})`).all(...recs) as Array<{ key: string; at: number | null; cm: string | null; cl: string | null }>) {
				if (typeof r.at === 'number') cuesCell.set(r.key, r.at);
				const cells: ReturnType<typeof curationCells> = {};
				if (r.cm) cells.comment = JSON.parse(r.cm);
				if (r.cl) cells.color_label = JSON.parse(r.cl);
				curation.set(r.key, cells);
			}
			for (const rec of recs) {
				if (aliased.has(rec)) continue;
				const rows = rowsOf.get(rec);
				if (!rows) continue;
				const row = rows[0]!;
				if (!others.has(rec)) {
					const attrs = trackAttrsOf(row, { sources: sources.get(row.id) ?? new Set(), links: links.get(row.id) ?? [], rbKey: rbKey.get(row.id) ?? null, artistName });
					if (!attrs) tooLarge++;
					else {
						const digest = digestOf(rec, attrs);
						if (seenDigest.get(`${row.id}\u0000${rec}`) !== digest) {
							ops.push({ entity: 'library_track', entity_id: rec, kind: 'set-attrs', payload: attrs });
							seen.push([row.id, rec, digest]);
						}
					}
				}
				// The row's curation (comment free text, colour): LWW, fresh
				// clock for a change since last stated (track-curation.ts).
				ops.push(...curationOps(raw, rec, row, curation.get(rec) ?? {}));
				// Any own row's later cue edit (a merge keeps the max on the
				// survivor; a second own copy may hold its own).
				const ownCues = Math.max(0, ...rows.map((r) => r.cues_edited_at ?? 0));
				if (ownCues > 0 && ownCues > (cuesCell.get(rec) ?? 0)) {
					ops.push({ entity: 'library_track', entity_id: rec, kind: 'set-cues-edited', payload: { at: Math.round(ownCues) } });
				}
			}
		}
		if (ops.length > 0) emitOps(raw, ops, { batchLabel: opts.batchLabel });
		const putSeen = raw.prepare(`INSERT INTO track_attrs_seen (track_id, recording_id, digest, seen_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(track_id) DO UPDATE SET recording_id = excluded.recording_id, digest = excluded.digest, seen_at = excluded.seen_at`);
		const now = Date.now();
		for (const [id, rec, digest] of seen) putSeen.run(id, rec, digest, now);
		raw.prepare(`DELETE FROM track_attrs_dirty WHERE track_id IN (${marks(ids.length)})`).run(...ids);
		if (tooLarge > 0) alog.warn('rows whose attributes are too large for an op stay device-local', { count: tooLarge });
		return { rows: ids.length, emitted: ops.length, done: ids.length < max };
	})();
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const SLICE_MS = 40;
// As track-meta.ts's floor.
const MIN_CHUNK = 20;
export async function drainTrackAttrsAsync(raw: Raw, opts: { chunk?: number; signal?: { aborted: boolean }; batchLabel?: BatchLabel; role?: SourceRole } = {}): Promise<{ rows: number; emitted: number; chunks: number; maxSliceMs: number }> {
	const out = { rows: 0, emitted: 0, chunks: 0, maxSliceMs: 0 };
	const fixed = opts.chunk !== undefined;
	let size = Math.max(1, opts.chunk ?? 20);
	for (;;) {
		if (opts.signal?.aborted) break;
		const t0 = performance.now();
		const r = drainTrackAttrs(raw, { max: size, batchLabel: opts.batchLabel, role: opts.role });
		const ms = performance.now() - t0;
		out.maxSliceMs = Math.max(out.maxSliceMs, ms);
		if (!fixed && r.rows > 0) size = Math.max(MIN_CHUNK, Math.min(CHUNK * 5, Math.ceil(size * 1.5), Math.round(r.rows * SLICE_MS / Math.max(ms, 1))));
		if (r.rows === 0) break;
		out.chunks++;
		out.rows += r.rows;
		out.emitted += r.emitted;
		if (r.done) break;
		await yieldToLoop();
	}
	return out;
}

export function trackAttrsBackfillPending(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(INITIAL_PUSH_KEY) !== undefined
		&& raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(TRACK_ATTRS_BACKFILL_KEY) === undefined;
}

export async function queueTrackAttrsBackfillAsync(raw: Raw, opts: { page?: number } = {}): Promise<number> {
	const page = Math.max(1, opts.page ?? 5_000);
	const ids = raw.prepare(`SELECT rowid, id FROM track WHERE rowid > ? AND remote_only = 0 AND derived_from_track_id IS NULL ORDER BY rowid LIMIT ?`);
	const put = raw.prepare(`INSERT OR IGNORE INTO track_attrs_dirty (track_id) VALUES (?)`);
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
		.run(TRACK_ATTRS_BACKFILL_KEY, JSON.stringify(Date.now()), Date.now());
	return queued;
}

// ── the projection ──────────────────────────────────────────────────────────

type ProjectRow = AttrsRow & { remote_only: number; rb_linked: number; own_refs: number };

type ProjectStmts = {
	rows: Database.Statement<[string], ProjectRow>;
	refs: Database.Statement<[string], { ord: number; source: string; payload: string }>;
	delRefs: Database.Statement<[string]>;
	putRef: Database.Statement<[string, number, string, string]>;
	derive: Database.Statement<[string]>;
	spelling: Database.Statement<[string, string]>;
	rename: Database.Statement<[string, string, string]>;
};
const PSTMTS = new WeakMap<Raw, ProjectStmts>();
function pstmts(raw: Raw): ProjectStmts {
	let s = PSTMTS.get(raw);
	if (!s) {
		s = {
			rows: raw.prepare(`SELECT ${ATTRS_COLUMNS}, remote_only,
					EXISTS (SELECT 1 FROM rekordbox_link rl WHERE rl.track_id = track.id) AS rb_linked,
					EXISTS (SELECT 1 FROM source_link sl WHERE sl.track_id = track.id AND sl.source IN ('spotify', 'tidal') AND sl.payload IS NOT NULL) AS own_refs
				FROM track WHERE recording_id = ? AND +derived_from_track_id IS NULL`),
			refs: raw.prepare(`SELECT ord, source, payload FROM track_provider_ref WHERE track_id = ? ORDER BY ord`),
			delRefs: raw.prepare(`DELETE FROM track_provider_ref WHERE track_id = ?`),
			putRef: raw.prepare(`INSERT INTO track_provider_ref (track_id, ord, source, payload) VALUES (?, ?, ?, ?)`),
			derive: raw.prepare(`INSERT OR IGNORE INTO track_derive_pending (track_id) VALUES (?)`),
			spelling: raw.prepare(`INSERT INTO artist_spelling (name_ascii, name) VALUES (?, ?) ON CONFLICT(name_ascii) DO UPDATE SET name = excluded.name`),
			rename: raw.prepare(`UPDATE artist SET name = ?, updated_at = (unixepoch() * 1000) WHERE name_ascii = ? AND name_curated_at IS NULL AND merged_into IS NULL AND name != ?`),
		};
		PSTMTS.set(raw, s);
	}
	return s;
}

// The empty value of a column: what "no value from its own source" reads as.
// A play count of 0 on a row with a local rekordbox is that rekordbox's
// counter, not an empty field.
function isEmpty(field: ScalarField, row: ProjectRow): boolean {
	const v = (row as unknown as Record<string, unknown>)[field];
	if (field === 'play_count') return !row.rb_linked && (v === null || v === 0);
	return v === null || v === undefined || v === '';
}

// One recording's winning attributes (and the account cue-edit stamp) onto
// every catalogue row of it, by the per-field rules at the top of this file.
// `master` is the account's master device. Returns the rows written.
export function projectTrackAttrs(raw: Raw, recordingId: string, rec: LwwRecord, master: string | null): string[] {
	const s = pstmts(raw);
	const won = resolveTrackAttrs(rec, master);
	const cuesCell = rec.fields[CUES_EDITED_CELL]?.value;
	const cuesAt = typeof cuesCell === 'number' ? cuesCell : null;
	if (!won && cuesAt === null) return [];
	const touched: string[] = [];
	for (const row of s.rows.all(recordingId)) {
		const adopted = parseAdopted(row.attrs_adopted);
		const set: Record<string, unknown> = {};
		for (const field of SCALAR_FIELDS) {
			const cur = (row as unknown as Record<string, unknown>)[field];
			// A local writer replaced an adopted value: the field is the row's.
			if (adopted[field] && !same(columnValue(field, adopted[field]!.v), cur)) delete adopted[field];
			const held = adopted[field];
			// A remote row has no source of its own: whatever it holds came from
			// a projection (the rb key unit) or a fill, and the winner replaces
			// it. An own row takes the winner only into an empty or adopted
			// field.
			if (row.remote_only !== 1 && held === undefined && !isEmpty(field, row)) continue;
			const w = won ? wireValue(field, (won.attrs as unknown as Record<string, unknown>)[field]) : null;
			if (w !== null) {
				const col = columnValue(field, w);
				if (!same(cur, col)) set[field] = col;
				adopted[field] = { v: col, from: 'account' };
			} else if (held?.from === 'account') {
				// The winner dropped it: back to empty. A catalogue fill stays.
				const col = columnValue(field, null);
				if (!same(cur, col)) set[field] = col;
				delete adopted[field];
			}
		}
		if (cuesAt !== null && (row.cues_edited_at ?? 0) < cuesAt) set['cues_edited_at'] = cuesAt;
		const nextAdopted = adoptedJson(adopted);
		if (nextAdopted !== row.attrs_adopted) set['attrs_adopted'] = nextAdopted;
		const cols = Object.keys(set);
		if (cols.length > 0) {
			raw.prepare(`UPDATE track SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c] as never), row.id);
			touched.push(row.id);
		}
		// Release and artist ids: a row reads its own listings when it has
		// any, the winner's otherwise.
		const want = row.own_refs || !won ? [] : won.attrs.provider_refs.map((r) => ({ source: r.source, payload: refPayload(r) }));
		const have = s.refs.all(row.id);
		if (have.length !== want.length || have.some((h, i) => h.source !== want[i]!.source || h.payload !== want[i]!.payload)) {
			s.delRefs.run(row.id);
			want.forEach((w, i) => s.putRef.run(row.id, i, w.source, w.payload));
			s.derive.run(row.id);
			if (!touched.includes(row.id)) touched.push(row.id);
		}
	}
	// The master's spelling of each credited artist, for artists nobody
	// renamed (a rename is an artist_alias rule and wins anyway). Only the
	// master's cell speaks for spellings (resolveTrackAttrs), so two other
	// devices never flip one.
	if (won) {
		for (const name of won.attrs.artist_names) {
			const key = artistKey(name);
			if (!key) continue;
			s.spelling.run(key, name);
			s.rename.run(name, key, name);
		}
	}
	return touched;
}
