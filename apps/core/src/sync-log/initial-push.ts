// The initial push (design D10, "The existing library"): ops for every
// library row the op log has not recorded yet, stamped with the row's own
// timestamps (added_at, created_at, cues_edited_at, updated_at, deleted_at)
// so anything the user does afterwards — recorded with a current clock —
// wins over them on every device.
//
// Rows that already have a record (a mutator emitted for them, or a previous
// run of this got that far) are skipped, so it is resumable and safe to run
// again. Device-local rows yield nothing (see rows.ts). Ops go into the
// outbox in chunks of `chunk` per transaction, so the writer lock is never
// held for the whole library; when every chunk is in, the initial-push
// marker lets applyOps run (apply.ts INITIAL_PUSH_KEY).
//
// Two drivers over one op generator: `initialPush` runs it to completion
// synchronously (tests, replay-check, the headless CLI), and
// `initialPushAsync` yields to the event loop between chunks — the desktop
// runs core in Electron's main process, and B measured 18 s for the 127k ops
// of the real library, which would freeze every window if run in one go.
// The generator is lazy, so each chunk's "already recorded?" probes see the
// chunks emitted before it (and any mutator write made in between: a user
// edit during the push records its container's create first, and the push
// then skips it).
//
// Past artist renames/merges ARE reconstructed, from the artist table's
// alias rows and curated spellings (artist_alias rules), and so are the
// rekordbox analysis units (set-rb-analysis, from the rb slot; a grid too
// large for an op stays device-local, see rows.ts), and so is every row's
// recording: its create and the claims its columns hold (recordingOps). Not
// reconstructed: past recording merges (the soft-deleted losers carry no
// record of which row won). Unfinalised
// curator plays go out as they stand; the launch sweep
// (plays.ts finalizeInterruptedPlays) re-appends them finalised.

import type Database from 'better-sqlite3';
import { cueEntityId, isAccountSettingKey, trackTagEntityId, type JsonValue } from '@curator/protocol';
import { INITIAL_PUSH_KEY, markRecordsComplete } from './apply.js';
import { emitOps, type EmitOp } from './outbox.js';
import {
	claimOp, cueUpsertOp, folderCreateOp, overrideOp, parseOverrides, pinnedCreateOp, playlistCreateOps, ratingOp, rbUnitOp, rbUnitValue, recordingResolver, stateOp, tagCreateOp,
	OVERRIDE_KEYS, OVERRIDE_FIELD_OF, RB_UNITS, type CueRow, type RecordingClaim,
} from './rows.js';
import type { RbSlotRow } from '../rekordbox/rb-slot.js';
import { eventAppendOp, sessionAppendOp } from '../library/mutators.js';

type Raw = Database.Database;

export type InitialPushResult = { ops: number; byEntity: Record<string, number>; ms: number };

export type InitialPushProgress = {
	// Ops written to the outbox so far, and an upper bound of the total (the
	// source row counts; rows that are device-local or already recorded
	// yield nothing, so `done` may finish below it).
	done: number;
	estimate: number;
};

export type InitialPushAsyncResult = InitialPushResult & {
	chunks: number;
	// Longest synchronous slice between two yields: the worst main-loop
	// stall the push caused.
	maxSliceMs: number;
};

const stamp = (op: EmitOp, at: number | null | undefined): EmitOp => ({ ...op, client_ts: Math.max(0, Math.round(at ?? 0)) });

// Whether the records already hold a row (or one field / the create of it).
function recordProbe(raw: Raw): (map: string, key: string, field?: string) => boolean {
	const record = raw.prepare(`SELECT value FROM sync_state WHERE map = ? AND key = ?`);
	return (map, key, field) => {
		const row = record.get(map, key) as { value: string } | undefined;
		if (!row) return false;
		if (!field) return true;
		const v = JSON.parse(row.value) as Record<string, unknown>;
		if (field === 'created' || field === 'added') return v[field] != null;
		return (v['fields'] as Record<string, unknown> | undefined)?.[field] !== undefined;
	};
}

// Rekordbox analysis units, at the link's last import (else the slot row's
// own stamp). Ids first and each slot read on its own: the grids are blobs,
// and the whole library's at once is tens of MB. Also the body of the
// one-time backfill for libraries whose initial push predates the units.
function* rbAnalysisOps(raw: Raw): Generator<EmitOp> {
	const has = recordProbe(raw);
	const rec = recordingResolver(raw);
	const slotOf = raw.prepare(`SELECT rb_beatgrid, rb_downbeats, rb_key_camelot, rb_segments_json FROM track_analysis WHERE track_id = ?`);
	for (const r of raw.prepare(`SELECT ta.track_id AS id, COALESCE(rl.last_synced_at, ta.analyzed_at) AS at FROM track_analysis ta
		JOIN track t ON t.id = ta.track_id LEFT JOIN rekordbox_link rl ON rl.track_id = ta.track_id
		WHERE t.derived_from_track_id IS NULL AND t.remote_only = 0 AND (ta.rb_beatgrid IS NOT NULL OR ta.rb_key_camelot IS NOT NULL OR ta.rb_segments_json IS NOT NULL)
		ORDER BY ta.track_id`).all() as Array<{ id: string; at: number | null }>) {
		const recording = rec(r.id);
		if (!recording) continue;
		const slot = slotOf.get(r.id) as RbSlotRow | undefined;
		for (const unit of RB_UNITS) {
			if (has('libraryTracks', recording, `rb.${unit}`)) continue;
			const value = rbUnitValue(slot ?? null, unit);
			if (value === null) continue;
			const op = rbUnitOp(recording, unit, value);
			if (op) yield stamp(op, r.at);
		}
	}
}

// Library rows as recordings: a `library_track` create per row (stamped with
// when it joined the library) and the claims its columns hold — the file's
// audio hash and Chromaprint (source_link, local), the streaming ids
// (spotify/tidal/beatport source_link rows) and the ISRC. Without them a
// library from before the op log gives the identity resolver (identity.ts)
// nothing to match another desktop's copy of the same file against, and the
// catalogue nothing to file analysis under. Deleted rows are included: their
// audio-hash claim is how a delete made here keeps another desktop's scanner
// from minting a fresh row for the same file (scanner.ts deletedOwnerOf);
// the resolver itself never merges a deleted recording. Rows whose recording
// is already a merge loser are skipped: their claims live on the winner.
//
// Rows are read in pages (keyset on rowid) with their links in one IN (...)
// read per page, so no slice of the chunked driver pays for the whole
// library; the Chromaprint (kilobytes, thousands of files) is read by link
// id only for the claim it becomes. Also the body of the one-time backfill
// for libraries pushed before claims were.
type RecTrackRow = { rowid: number; id: string; isrc: string | null; added_at: number | null; created_at: number | null };
type RecLinkRow = { id: string; track_id: string; source: string; source_track_id: string; audio_hash: string | null; fetched_at: number | null };

function* recordingOps(raw: Raw): Generator<EmitOp> {
	const has = recordProbe(raw);
	const rec = recordingResolver(raw);
	const aliased = new Set(raw.prepare(`SELECT loser FROM recording_alias`).pluck().all() as string[]);
	// Never a remote row (remote-rows.ts): its recording and claims are
	// another device's, already on the log; an ISRC claim from its meta
	// would be this device vouching for a track it does not hold.
	const page = raw.prepare(`SELECT rowid, id, isrc, added_at, created_at FROM track WHERE derived_from_track_id IS NULL AND remote_only = 0 AND rowid > ? ORDER BY rowid LIMIT 400`);
	for (let after = 0; ;) {
		const tracks = page.all(after) as RecTrackRow[];
		if (tracks.length === 0) return;
		after = tracks[tracks.length - 1]!.rowid;
		const links = new Map<string, RecLinkRow[]>();
		for (const l of raw.prepare(`SELECT id, track_id, source, source_track_id, audio_hash, fetched_at
			FROM source_link WHERE track_id IN (${tracks.map(() => '?').join(',')}) AND source IN ('local', 'spotify', 'tidal', 'beatport')
			ORDER BY track_id, source, id`).all(...tracks.map((t) => t.id)) as RecLinkRow[]) {
			let list = links.get(l.track_id);
			if (!list) links.set(l.track_id, (list = []));
			list.push(l);
		}
		for (const t of tracks) {
			const recording = rec(t.id);
			if (!recording || aliased.has(recording)) continue;
			const joined = t.added_at ?? t.created_at;
			if (!has('libraryTracks', recording, 'created')) {
				yield stamp({ entity: 'library_track', entity_id: recording, kind: 'create', payload: joined != null ? { added_at: Math.max(0, Math.round(joined)) } : {} }, joined);
			}
			const seen = new Set<string>();
			const claim = (c: RecordingClaim, at: number | null | undefined): EmitOp | null => {
				const key = `${recording}:${c.kind}:${c.value}`;
				if (seen.has(key) || has('claims', key)) return null;
				seen.add(key);
				const op = claimOp(recording, c);
				return op ? stamp(op, at) : null;
			};
			const own = links.get(t.id) ?? [];
			// A tag ISRC is weaker evidence than a provider's (the scanner's 0.8
			// vs the streaming upserts' 0.9); which one filled the column is not
			// recorded, so a row with a streaming link counts as the provider's.
			const streamed = own.some((l) => l.source !== 'local');
			for (const l of own) {
				let op: EmitOp | null = null;
				if (l.source !== 'local') {
					if (l.source_track_id) op = claim({ kind: l.source as 'spotify' | 'tidal' | 'beatport', value: l.source_track_id }, l.fetched_at);
					if (op) yield op;
					continue;
				}
				if (l.audio_hash) { op = claim({ kind: 'audio_hash', value: l.audio_hash }, l.fetched_at); if (op) yield op; }
				// Fingerprint claims are NOT replayed here (decided 2026-10-20): the
				// resolver merges on exact audio hashes only, and the prints would
				// add ~19 MB to the push and 40-60 MB to sync_state on the live
				// library for evidence nothing reads yet. New analyses still emit
				// theirs (analyzer/persist.ts addClaims); when a fuzzy evidence tier
				// lands, a backfill of its own replays the existing prints.
			}
			if (t.isrc) { const op = claim({ kind: 'isrc', value: t.isrc, confidence: streamed ? 0.9 : 0.8 }, t.created_at); if (op) yield op; }
		}
	}
}

function estimateRecordingOps(raw: Raw): number {
	const n = (sql: string): number => (raw.prepare(sql).get() as { n: number }).n;
	return n(`SELECT count(*) AS n FROM track WHERE derived_from_track_id IS NULL`)
		+ n(`SELECT count(*) AS n FROM track WHERE derived_from_track_id IS NULL AND isrc IS NOT NULL`)
		+ n(`SELECT count(*) AS n FROM source_link WHERE source = 'local' AND audio_hash IS NOT NULL`)
		+ n(`SELECT count(*) AS n FROM source_link WHERE source IN ('spotify', 'tidal', 'beatport')`);
}

// Every op the initial push would emit, in library order, each stamped with
// its row's own time.
function* initialPushOps(raw: Raw): Generator<EmitOp> {
	// Rows are read with .all(), not .iterate(): better-sqlite3 refuses a
	// write on a connection with an open iterator, and the chunks flush
	// mid-scan.
	const has = recordProbe(raw);
	const tomb = raw.prepare(`SELECT 1 FROM tombstone WHERE entity = ? AND entity_id = ?`);
	const tombstoned = (entity: string, id: string): boolean => tomb.get(entity, id) !== undefined;
	const rec = recordingResolver(raw);

	// Containers.
	for (const r of raw.prepare(`SELECT id, created_at FROM tag ORDER BY created_at, id`).all() as Array<{ id: string; created_at: number }>) {
		if (has('tags', r.id, 'created') || tombstoned('tag', r.id)) continue;
		const op = tagCreateOp(raw, r.id);
		if (op) yield stamp(op, r.created_at);
	}
	for (const r of raw.prepare(`SELECT id, created_at FROM playlist_folder ORDER BY created_at, id`).all() as Array<{ id: string; created_at: number }>) {
		if (has('playlistFolders', r.id, 'created') || tombstoned('playlist_folder', r.id)) continue;
		const op = folderCreateOp(raw, r.id);
		if (op) yield stamp(op, r.created_at);
	}
	const playlists = raw.prepare(`SELECT id, created_at FROM playlist WHERE is_smart = 0 AND derived_from_playlist_id IS NULL ORDER BY created_at, id`).all() as Array<{ id: string; created_at: number }>;
	const playlistCreated = new Map<string, number>();
	for (const r of playlists) {
		playlistCreated.set(r.id, r.created_at);
		if (has('playlists', r.id, 'created') || tombstoned('playlist', r.id)) continue;
		for (const op of playlistCreateOps(raw, r.id)) yield stamp(op, r.created_at);
	}
	for (const r of raw.prepare(`SELECT id, created_at FROM pinned_search ORDER BY created_at, id`).all() as Array<{ id: string; created_at: number }>) {
		if (has('pinnedSearches', r.id, 'created') || tombstoned('pinned_search', r.id)) continue;
		const op = pinnedCreateOp(raw, r.id);
		if (op) yield stamp(op, r.created_at);
	}

	// Membership, in playlist order so the outbox reads like the library.
	// Rows on a remote track came from the records (they are on the log).
	for (const r of raw.prepare(`SELECT id, playlist_id, track_id, order_key, added_at FROM playlist_track
		WHERE track_id NOT IN (SELECT id FROM track WHERE remote_only = 1) ORDER BY playlist_id, order_key, id`).all() as Array<{ id: string; playlist_id: string; track_id: string; order_key: string; added_at: number | null }>) {
		const created = playlistCreated.get(r.playlist_id);
		if (created === undefined) continue; // device-local playlist
		if (has('playlistTracks', r.id, 'added') || tombstoned('playlist_track', r.id)) continue;
		const recording = rec(r.track_id);
		if (!recording) continue;
		yield stamp({ entity: 'playlist_track', entity_id: r.id, kind: 'add', payload: { playlist_id: r.playlist_id, recording_id: recording, order_key: r.order_key } }, r.added_at ?? created);
	}

	// Tag assignments.
	for (const r of raw.prepare(`SELECT track_id, tag_id, added_at FROM track_tag WHERE track_id NOT IN (SELECT id FROM track WHERE remote_only = 1) ORDER BY track_id, tag_id`).all() as Array<{ track_id: string; tag_id: string; added_at: number }>) {
		const recording = rec(r.track_id);
		if (!recording) continue;
		const key = trackTagEntityId(recording, r.tag_id);
		if (has('trackTags', key) || tombstoned('track_tag', key)) continue;
		yield stamp({ entity: 'track_tag', entity_id: key, kind: 'add', payload: {} }, r.added_at);
	}

	// Cues, at the track's cue-edit stamp (or the cue's own creation).
	for (const r of raw.prepare(`SELECT c.track_id, c.slot, c.kind, c.position_sec, c.length_sec, c.color, c.name, c.created_at, t.cues_edited_at
		FROM cue c JOIN track t ON t.id = c.track_id WHERE c.slot >= 0 AND t.remote_only = 0 ORDER BY c.track_id, c.kind, c.slot`).all() as Array<CueRow & { track_id: string; created_at: number; cues_edited_at: number | null }>) {
		const recording = rec(r.track_id);
		if (!recording) continue;
		const key = cueEntityId(recording, r.slot, r.kind);
		if (has('cues', key) || tombstoned('cue', key)) continue;
		yield stamp(cueUpsertOp(recording, r), r.cues_edited_at ?? r.created_at);
	}

	// Recordings: each row's create and claims, before the state that
	// addresses them.
	yield* recordingOps(raw);

	// Track state: rating, curation stage (only away from the default a new
	// row gets everywhere), overrides, soft deletes. Not for a merge loser's
	// row: its recording is an alias, so its soft delete (the merge's own
	// bookkeeping, never a delete op: merge-tracks.ts) would be redirected
	// to the survivor and delete it — a merge made before the first sign-in
	// leaves exactly such a row behind.
	const aliasedLosers = new Set(raw.prepare(`SELECT loser FROM recording_alias`).pluck().all() as string[]);
	for (const r of raw.prepare(`SELECT id, rating, state, state_changed_at, overrides, deleted_at, updated_at FROM track
		WHERE derived_from_track_id IS NULL AND remote_only = 0 AND (rating IS NOT NULL OR state != 'unsorted' OR overrides IS NOT NULL OR deleted_at IS NOT NULL)`).all() as Array<{ id: string; rating: number | null; state: string; state_changed_at: number | null; overrides: string | null; deleted_at: number | null; updated_at: number }>) {
		const recording = rec(r.id);
		if (!recording || aliasedLosers.has(recording)) continue;
		if (r.rating != null && !has('libraryTracks', recording, 'rating')) yield stamp(ratingOp(recording, r.rating), r.updated_at);
		if (r.state !== 'unsorted' && !has('libraryTracks', recording, 'state')) {
			const op = stateOp(recording, r.state);
			if (op) yield stamp(op, r.state_changed_at ?? r.updated_at);
		}
		const ov = parseOverrides(r.overrides);
		for (const k of OVERRIDE_KEYS) {
			if (ov[k] === undefined || ov[k] === null) continue;
			if (has('libraryTracks', recording, `override.${OVERRIDE_FIELD_OF[k]}`)) continue;
			yield stamp(overrideOp(recording, k, ov[k]), r.updated_at);
		}
		if (r.deleted_at != null && !has('libraryTracks', recording, 'deleted_at')) {
			yield stamp({ entity: 'library_track', entity_id: recording, kind: 'delete', payload: {} }, r.deleted_at);
		}
	}

	yield* rbAnalysisOps(raw);

	// Play history.
	for (const r of raw.prepare(`SELECT id, started_at FROM play_session ORDER BY started_at, id`).all() as Array<{ id: string; started_at: number }>) {
		if (has('playSessions', r.id, 'created')) continue;
		const op = sessionAppendOp(raw, r.id);
		if (op) yield stamp(op, r.started_at);
	}
	for (const r of raw.prepare(`SELECT e.id, COALESCE(e.played_at, s.started_at) AS at FROM play_event e JOIN play_session s ON s.id = e.session_id ORDER BY at, e.id`).all() as Array<{ id: string; at: number }>) {
		if (has('playEvents', r.id)) continue;
		const op = eventAppendOp(raw, r.id, rec);
		if (op) yield stamp(op, r.at);
	}

	// Artist renames and merges made before the op log: each alias row is a
	// rule to its live artist's spelling, each curated spelling a spelling
	// rule, so another device's canonical credits follow them too.
	const artistRows = raw.prepare(`SELECT id, name, name_ascii, merged_into, name_curated_at, updated_at FROM artist`).all() as Array<{ id: string; name: string; name_ascii: string; merged_into: string | null; name_curated_at: number | null; updated_at: number }>;
	const artistById = new Map(artistRows.map((a) => [a.id, a]));
	const liveArtist = (a: (typeof artistRows)[number]): (typeof artistRows)[number] => {
		let cur = a;
		for (let hops = 0; cur.merged_into && hops < 8; hops++) {
			const next = artistById.get(cur.merged_into);
			if (!next) break;
			cur = next;
		}
		return cur;
	};
	for (const a of artistRows) {
		if (!a.name_ascii || has('artistAliases', a.name_ascii)) continue;
		const live = a.merged_into ? liveArtist(a) : null;
		if (live && live.id !== a.id && live.name_ascii && live.name_ascii !== a.name_ascii) {
			yield stamp({ entity: 'artist_alias', entity_id: a.name_ascii, kind: 'set', payload: { from: a.name, to: live.name, to_key: live.name_ascii } }, a.updated_at);
		} else if (!a.merged_into && a.name_curated_at != null) {
			yield stamp({ entity: 'artist_alias', entity_id: a.name_ascii, kind: 'set', payload: { from: a.name, to: a.name, to_key: a.name_ascii } }, a.name_curated_at);
		}
	}

	// Account settings.
	for (const r of raw.prepare(`SELECT key, value, updated_at FROM app_setting`).all() as Array<{ key: string; value: string; updated_at: number }>) {
		if (!isAccountSettingKey(r.key) || has('settings', r.key)) continue;
		yield stamp({ entity: 'setting', entity_id: r.key, kind: 'set', payload: { value: JSON.parse(r.value) as JsonValue } }, r.updated_at);
	}
}

// Upper bound of the op count, for a progress bar: one COUNT per source.
export function estimateInitialPush(raw: Raw): number {
	const n = (sql: string): number => (raw.prepare(sql).get() as { n: number }).n;
	return n(`SELECT count(*) AS n FROM tag`)
		+ n(`SELECT count(*) AS n FROM playlist_folder`)
		+ n(`SELECT count(*) AS n FROM playlist WHERE is_smart = 0 AND derived_from_playlist_id IS NULL`)
		+ n(`SELECT count(*) AS n FROM pinned_search`)
		+ n(`SELECT count(*) AS n FROM playlist_track`)
		+ n(`SELECT count(*) AS n FROM track_tag`)
		+ n(`SELECT count(*) AS n FROM cue WHERE slot >= 0`)
		+ n(`SELECT count(*) AS n FROM track WHERE derived_from_track_id IS NULL AND (rating IS NOT NULL OR state != 'unsorted' OR overrides IS NOT NULL OR deleted_at IS NOT NULL)`)
		+ n(`SELECT count(*) AS n FROM artist WHERE merged_into IS NOT NULL OR name_curated_at IS NOT NULL`)
		+ n(`SELECT COALESCE(sum((rb_beatgrid IS NOT NULL) + (rb_key_camelot IS NOT NULL) + (rb_segments_json IS NOT NULL)), 0) AS n FROM track_analysis`)
		+ n(`SELECT count(*) AS n FROM play_session`)
		+ n(`SELECT count(*) AS n FROM play_event`)
		+ estimateRecordingOps(raw);
}

function emitChunk(raw: Raw, batch: EmitOp[], byEntity: Record<string, number>): void {
	raw.transaction(() => { emitOps(raw, batch, { noPrerequisites: true }); })();
	for (const op of batch) byEntity[op.entity] = (byEntity[op.entity] ?? 0) + 1;
}

export function initialPush(raw: Raw, opts: { chunk?: number } = {}): InitialPushResult {
	const started = Date.now();
	const chunk = opts.chunk ?? 500;
	const byEntity: Record<string, number> = {};
	let total = 0;
	let pending: EmitOp[] = [];
	for (const op of initialPushOps(raw)) {
		pending.push(op);
		total++;
		if (pending.length >= chunk) { emitChunk(raw, pending, byEntity); pending = []; }
	}
	if (pending.length > 0) emitChunk(raw, pending, byEntity);
	markRecordsComplete(raw);
	markRbBackfilled(raw);
	markClaimsBackfilled(raw);
	return { ops: total, byEntity, ms: Date.now() - started };
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// The chunked, event-loop-friendly driver. Chunks are capped at 2,000 ops
// (the plan's ceiling); the default 500 keeps each slice to tens of ms on the
// real library. A slice is generation (row probes) plus one chunk's emit
// transaction; `setImmediate` between slices lets queued IPC, timers and
// paints run. `signal` stops between chunks — what is in stays in (the push
// is resumable), and the marker is only written by a run that finished.
export async function initialPushAsync(
	raw: Raw,
	opts: { chunk?: number; onProgress?: (p: InitialPushProgress) => void; signal?: { aborted: boolean } } = {},
): Promise<InitialPushAsyncResult> {
	return driveAsync(raw, initialPushOps(raw), estimateInitialPush(raw), () => { markRecordsComplete(raw); markRbBackfilled(raw); markClaimsBackfilled(raw); }, opts);
}

async function driveAsync(
	raw: Raw,
	gen: Generator<EmitOp>,
	estimate: number,
	onDone: () => void,
	opts: { chunk?: number; onProgress?: (p: InitialPushProgress) => void; signal?: { aborted: boolean } },
): Promise<InitialPushAsyncResult> {
	const started = Date.now();
	const chunk = Math.max(1, Math.min(2_000, opts.chunk ?? 500));
	const byEntity: Record<string, number> = {};
	let total = 0;
	let chunks = 0;
	let maxSliceMs = 0;
	for (;;) {
		if (opts.signal?.aborted) {
			gen.return(undefined);
			return { ops: total, byEntity, ms: Date.now() - started, chunks, maxSliceMs };
		}
		const sliceStart = performance.now();
		const batch: EmitOp[] = [];
		let done = false;
		while (batch.length < chunk) {
			const next = gen.next();
			if (next.done) { done = true; break; }
			batch.push(next.value);
		}
		if (batch.length > 0) {
			emitChunk(raw, batch, byEntity);
			total += batch.length;
			chunks++;
		}
		if (done) onDone();
		maxSliceMs = Math.max(maxSliceMs, performance.now() - sliceStart);
		opts.onProgress?.({ done: total, estimate: Math.max(estimate, total) });
		if (done) break;
		await yieldToLoop();
	}
	return { ops: total, byEntity, ms: Date.now() - started, chunks, maxSliceMs };
}

// ── backfill: rekordbox analysis units ─────────────────────────────────────
// A library whose initial push ran before set-rb-analysis was emitted
// (2026-10-20) has rb grids, keys and phrases no op ever stated, and nothing
// else would state them: the importer emits only on change, and the waveform
// pass skips tracks whose peaks are fresh. So once, after the initial push,
// the rb section of it runs on its own — same generator, same "already
// recorded" skips, same chunked driver. An initial push that included the
// units marks it done.

export const RB_BACKFILL_KEY = 'sync.backfill.rb_analysis_at';

function markRbBackfilled(raw: Raw): void {
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`)
		.run(RB_BACKFILL_KEY, JSON.stringify(Date.now()), Date.now());
}

export function rbBackfillPending(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(INITIAL_PUSH_KEY) !== undefined
		&& raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(RB_BACKFILL_KEY) === undefined;
}

export function rbBackfillAsync(
	raw: Raw,
	opts: { chunk?: number; onProgress?: (p: InitialPushProgress) => void; signal?: { aborted: boolean } } = {},
): Promise<InitialPushAsyncResult> {
	const estimate = (raw.prepare(`SELECT COALESCE(sum((rb_beatgrid IS NOT NULL) + (rb_key_camelot IS NOT NULL) + (rb_segments_json IS NOT NULL)), 0) AS n FROM track_analysis`).get() as { n: number }).n;
	return driveAsync(raw, rbAnalysisOps(raw), estimate, () => markRbBackfilled(raw), opts);
}

// ── backfill: recordings (creates + claims) ────────────────────────────────
// A library whose initial push ran before recordingOps existed (2026-10-20)
// stated its tags, playlists and ratings but never which recordings its rows
// are or what identifies them, and nothing would state it later: the
// scanner and the streaming upserts claim only new rows. So once, after the
// initial push, that section runs on its own, like the rekordbox backfill
// above. Its claims are what lets the identity resolver merge this
// library's copy of a file with another desktop's.

export const CLAIMS_BACKFILL_KEY = 'sync.backfill.recording_claims_at';

function markClaimsBackfilled(raw: Raw): void {
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`)
		.run(CLAIMS_BACKFILL_KEY, JSON.stringify(Date.now()), Date.now());
}

export function claimsBackfillPending(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(INITIAL_PUSH_KEY) !== undefined
		&& raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(CLAIMS_BACKFILL_KEY) === undefined;
}

export function claimsBackfillAsync(
	raw: Raw,
	opts: { chunk?: number; onProgress?: (p: InitialPushProgress) => void; signal?: { aborted: boolean } } = {},
): Promise<InitialPushAsyncResult> {
	return driveAsync(raw, recordingOps(raw), estimateRecordingOps(raw), () => markClaimsBackfilled(raw), opts);
}
